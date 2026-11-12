// Sincronización de operaciones hechas sin conexión (RF60, RF62).
//
//   - Cada operación trae su UUID (generado en el dispositivo): repetirla devuelve el resultado ya
//     guardado y no duplica nada (idempotencia). Si dos envíos llegan a la vez, la clave primaria de
//     offline_operations deja pasar solo uno.
//   - Se aplican en el orden recibido, cada una en su propia transacción.
//   - El consecutivo FA definitivo se asigna al sincronizar (en orden, sin huecos); el provisional
//     (FA-P-<dispositivo>-0001) queda guardado en la entrada como referencia.
//   - La tarifa se recalcula en el servidor; si difiere de la que cobró el dispositivo, se audita la
//     diferencia y NO se cambia lo cobrado.
//   - Lo que no se puede aplicar queda como CONFLICTO (nunca se descarta en silencio) para que un
//     AS/AG lo resuelva a mano desde la bandeja de conflictos.
const { query, withTransaction } = require('../db/pool');
const HttpError = require('../middlewares/httpError');
const { canAccessSite } = require('../middlewares/authorize');
const { normalizePlate, detectVehicleType, plateError } = require('../lib/plates');
const { splitPayment } = require('../lib/payments');
const { calculateFare } = require('./tariff.service');
const { nextReceiptNumber } = require('./receipts.service');
const { recordAudit } = require('./audit.service');
const { publish } = require('../realtime/bus');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEVICE_RE = /^[A-Z0-9]{4,12}$/;
const MAX_BATCH = 100;
const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;
// Reloj del dispositivo: más de 10 min de diferencia con el servidor, o una operación con hora
// futura (más de 1 min, por latencia), se marca como advertencia. No bloquea nada.
const CLOCK_SKEW_LIMIT_SECONDS = 10 * 60;
const CLOCK_FUTURE_TOLERANCE_MS = 60 * 1000;
const CLOCK_MESSAGES = {
  SKEW: 'La hora del dispositivo difería más de 10 minutos de la del servidor',
  FUTURE: 'La operación tenía una hora futura respecto a la recepción en el servidor',
};

const CONFLICT_MESSAGES = {
  PLATE_OPEN_ELSEWHERE: 'La placa ya tenía una entrada abierta en otra sede',
  PLATE_ALREADY_INSIDE: 'La placa ya tenía una entrada abierta en esta sede (registrada por otro operador)',
  MONTHLY_ACTIVE: 'La placa tiene una mensualidad vigente: no correspondía una entrada normal',
  ALREADY_EXITED: 'La salida de esta entrada ya se había registrado',
  ENTRY_IN_CONFLICT: 'La entrada de esta salida quedó en conflicto o no se sincronizó',
  REGISTER_CLOSED: 'La caja del turno ya estaba cerrada al sincronizar el cobro',
  SHIFT_INVALID: 'El turno indicado no es del usuario en esta sede',
  INVALID: 'Los datos de la operación no son válidos',
};

class Conflict extends Error {
  constructor(code, detail = {}) {
    super(CONFLICT_MESSAGES[code] ?? code);
    this.code = code;
    this.detail = detail;
  }
}

function toResult(row) {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    entryId: row.entry_id ?? null,
    receipt: row.result_receipt ?? row.payload?.result?.receipt ?? null,
    provisionalReceipt: row.provisional_receipt,
    clockWarning: row.clock_warning ?? null,
    conflict: row.conflict_code
      ? { code: row.conflict_code, message: CONFLICT_MESSAGES[row.conflict_code] ?? row.conflict_code, detail: row.conflict_detail }
      : null,
  };
}

// ---------------------------------------------------------------------------
// Validación del lote
// ---------------------------------------------------------------------------

function parseBatch(body) {
  const deviceId = String(body?.deviceId ?? '').toUpperCase();
  if (!DEVICE_RE.test(deviceId)) throw new HttpError(400, 'Dispositivo inválido', { code: 'VALIDATION_ERROR' });
  const ops = Array.isArray(body?.operations) ? body.operations : [];
  if (!ops.length) throw new HttpError(400, 'No hay operaciones para sincronizar', { code: 'VALIDATION_ERROR' });
  if (ops.length > MAX_BATCH) throw new HttpError(400, `Máximo ${MAX_BATCH} operaciones por envío`, { code: 'VALIDATION_ERROR' });
  for (const op of ops) {
    if (!UUID_RE.test(String(op?.id))) throw new HttpError(400, 'Cada operación necesita un UUID válido', { code: 'VALIDATION_ERROR' });
    if (!['ENTRY', 'EXIT'].includes(op.kind)) throw new HttpError(400, `Tipo de operación inválido: ${op.kind}`, { code: 'VALIDATION_ERROR' });
    if (!Number.isInteger(op.seq) || op.seq <= 0) throw new HttpError(400, 'Cada operación necesita su número de orden', { code: 'VALIDATION_ERROR' });
    if (Number.isNaN(new Date(op.clientTs).getTime())) throw new HttpError(400, 'Hora del dispositivo inválida', { code: 'VALIDATION_ERROR' });
  }
  // Hora del dispositivo al enviar (opcional: los clientes anteriores no la mandan)
  let deviceTime = null;
  if (body.deviceTime != null) {
    deviceTime = new Date(body.deviceTime);
    if (Number.isNaN(deviceTime.getTime())) throw new HttpError(400, 'Hora del dispositivo inválida', { code: 'VALIDATION_ERROR' });
  }
  return { deviceId, ops, deviceTime };
}

/**
 * Compara el reloj del dispositivo con la hora de recepción en el servidor.
 * Devuelve { receivedAt, deviceTime, offsetSeconds, warning } para una operación.
 */
function clockCheck(clock, clientTs) {
  if (!clock?.receivedAt) return { receivedAt: null, deviceTime: null, offsetSeconds: null, warning: null };
  const { receivedAt, deviceTime } = clock;
  const offsetSeconds = deviceTime ? Math.round((deviceTime.getTime() - receivedAt.getTime()) / 1000) : null;
  let warning = null;
  if (offsetSeconds !== null && Math.abs(offsetSeconds) > CLOCK_SKEW_LIMIT_SECONDS) warning = 'SKEW';
  else if (new Date(clientTs).getTime() > receivedAt.getTime() + CLOCK_FUTURE_TOLERANCE_MS) warning = 'FUTURE';
  return { receivedAt, deviceTime, offsetSeconds, warning };
}

// La hora del dispositivo se respeta salvo que esté en el futuro (reloj adelantado)
function clampTs(clientTs, now) {
  const t = new Date(clientTs);
  return t.getTime() > now.getTime() + FUTURE_TOLERANCE_MS ? now : t;
}

async function loadShift(client, user, siteId, shiftId) {
  const { rows } = await client.query(
    `SELECT sh.id, sh.site_id, sh.user_id, sh.opened_at, cr.id AS cash_register_id, (cr.closed_at IS NOT NULL) AS register_closed
       FROM shifts sh JOIN cash_registers cr ON cr.shift_id = sh.id
      WHERE sh.id = $1`,
    [shiftId],
  );
  const shift = rows[0];
  if (!shift || shift.user_id !== user.id || shift.site_id !== siteId) throw new Conflict('SHIFT_INVALID', { shiftId });
  return shift;
}

// ---------------------------------------------------------------------------
// Entrada
// ---------------------------------------------------------------------------

async function applyEntry(client, user, op, deviceId, { force = false } = {}) {
  const d = op.data ?? {};
  const siteId = Number(d.siteId);
  if (!canAccessSite(user, siteId)) throw new Conflict('INVALID', { reason: 'Sede sin acceso' });
  const plate = normalizePlate(d.plate);
  const err = plateError(plate);
  if (err) throw new Conflict('INVALID', { reason: err });
  const detected = detectVehicleType(plate);
  const vehicleType = d.vehicleType ?? detected;
  if ((detected === 'BICYCLE') !== (vehicleType === 'BICYCLE')) throw new Conflict('INVALID', { reason: 'Tipo de vehículo no corresponde a la placa' });

  const shift = await loadShift(client, user, siteId, d.shiftId);
  const { rows: nowRows } = await client.query('SELECT now() AS now');
  const entryAt = clampTs(op.clientTs, nowRows[0].now);

  // Misma placa adentro (en otra sede, o en esta registrada en línea mientras no había internet)
  const { rows: open } = await client.query(
    `SELECT e.id, e.site_id, s.name AS site_name, e.receipt_prefix || e.receipt_number AS receipt, e.entry_at
       FROM entries e JOIN sites s ON s.id = e.site_id
      WHERE e.plate = $1 AND e.status = 'OPEN' AND (e.vehicle_type <> 'BICYCLE' OR e.site_id = $2)`,
    [plate, siteId],
  );
  if (open.length && !force) {
    const other = open[0];
    throw new Conflict(other.site_id === siteId ? 'PLATE_ALREADY_INSIDE' : 'PLATE_OPEN_ELSEWHERE', {
      plate,
      openEntryId: other.id,
      site: other.site_name,
      receipt: other.receipt,
      entryAt: other.entry_at,
    });
  }
  if (open.length && force) {
    // Resolución manual: se anula la otra entrada abierta (queda auditado por quien resuelve)
    await client.query(
      `UPDATE entries SET status = 'CANCELLED', exit_at = now(), notes = $2 WHERE id = ANY($1::bigint[])`,
      [open.map((o) => o.id), `Anulada al resolver el conflicto de la operación sin conexión ${op.id}`],
    );
  }

  const { findActiveMonthly } = require('./entries.service');
  const monthly = await findActiveMonthly(client, siteId, plate, entryAt);
  if (monthly?.blocksEntry && !force) {
    throw new Conflict('MONTHLY_ACTIVE', { plate, monthlyPlanId: monthly.id, clientName: monthly.clientName, schedule: monthly.schedule });
  }

  const { rows: site } = await client.query('SELECT receipt_prefix FROM sites WHERE id = $1', [siteId]);
  const prefix = site[0].receipt_prefix;
  const number = await nextReceiptNumber(client, siteId, prefix);
  const { rows } = await client.query(
    `INSERT INTO entries (site_id, zone_id, plate, vehicle_type, receipt_prefix, receipt_number, entry_at,
                          entry_by, entry_shift_id, monthly_plan_id, origin, provisional_receipt)
     SELECT $1, sh.zone_id, $2, $3, $4, $5, $6, $7, sh.id, $8, 'OFFLINE', $9 FROM shifts sh WHERE sh.id = $10
     RETURNING id`,
    [siteId, plate, vehicleType, prefix, number, entryAt, user.id,
      monthly && !monthly.blocksEntry ? monthly.id : null, op.provisionalReceipt ?? null, shift.id],
  );
  return { siteId, entryId: rows[0].id, receipt: `${prefix}${number}`, event: { type: 'entry:created', payload: { entryId: rows[0].id, plate, receipt: `${prefix}${number}`, offline: true } } };
}

// ---------------------------------------------------------------------------
// Salida
// ---------------------------------------------------------------------------

async function applyExit(client, user, op, deviceId, { force = false, shiftId: overrideShiftId = null } = {}) {
  const d = op.data ?? {};
  const siteId = Number(d.siteId);
  if (!canAccessSite(user, siteId)) throw new Conflict('INVALID', { reason: 'Sede sin acceso' });

  // La entrada puede ser de la base (entryId) o haberse creado también sin conexión (entryOpId)
  let entryId = d.entryId ? Number(d.entryId) : null;
  if (!entryId && d.entryOpId) {
    const { rows } = await client.query('SELECT entry_id, status FROM offline_operations WHERE id = $1', [d.entryOpId]);
    if (!rows[0]?.entry_id) throw new Conflict('ENTRY_IN_CONFLICT', { entryOpId: d.entryOpId, entryStatus: rows[0]?.status ?? 'NOT_RECEIVED' });
    entryId = Number(rows[0].entry_id);
  }
  if (!entryId) throw new Conflict('INVALID', { reason: 'La salida no indica su entrada' });

  const { rows: er } = await client.query('SELECT * FROM entries WHERE id = $1 FOR UPDATE', [entryId]);
  const entry = er[0];
  if (!entry || entry.site_id !== siteId) throw new Conflict('INVALID', { reason: 'La entrada no existe en esta sede', entryId });
  if (entry.status !== 'OPEN') {
    throw new Conflict('ALREADY_EXITED', {
      entryId,
      plate: entry.plate,
      receipt: `${entry.receipt_prefix}${entry.receipt_number}`,
      existingExitAt: entry.exit_at,
      existingStatus: entry.status,
      existingCharged: entry.charged_amount,
      offlineCharged: d.chargedAmount,
      offlinePaymentMethod: d.paymentMethod,
    });
  }

  const shift = await loadShift(client, user, siteId, d.shiftId);
  const { rows: nowRows } = await client.query('SELECT now() AS now');
  let exitAt = clampTs(op.clientTs, nowRows[0].now);
  if (exitAt < entry.entry_at) exitAt = entry.entry_at; // reloj atrasado: nunca antes de la entrada

  const { rows: rr } = await client.query(
    `SELECT id, fraction_amount, hour_amount, full_12h_amount, pricing_mode FROM rates
      WHERE site_id = $1 AND vehicle_type = $2 AND valid_from <= $3 AND (valid_to IS NULL OR valid_to > $3)`,
    [siteId, entry.vehicle_type, exitAt],
  );
  const rate = rr[0];
  const fare = calculateFare({
    entryAt: entry.entry_at,
    exitAt,
    rate: rate
      ? { fractionAmount: rate.fraction_amount, hourAmount: rate.hour_amount, full12hAmount: rate.full_12h_amount, pricingMode: rate.pricing_mode }
      : { fractionAmount: 0, hourAmount: 0, full12hAmount: 0, pricingMode: 'normal' },
  });

  // Lo que cobró el dispositivo manda (ya se cobró); el servidor solo registra la diferencia
  const localCalculated = Number.isInteger(d.calculatedAmount) ? d.calculatedAmount : fare.total;
  const charged = Number.isInteger(d.chargedAmount) ? d.chargedAmount : localCalculated;
  if (charged < 0 || charged > localCalculated) throw new Conflict('INVALID', { reason: 'Valor cobrado inválido' });
  const discount = localCalculated - charged;
  const reason = typeof d.discountReason === 'string' ? d.discountReason.trim() : '';
  if (discount > 0 && reason.length < 3) throw new Conflict('INVALID', { reason: 'Descuento sin motivo' });

  const tariffDifference = fare.total !== localCalculated ? { local: localCalculated, server: fare.total, difference: fare.total - localCalculated } : null;

  const goesToPending = d.paymentMethod === 'PENDING' || entry.monthly_plan_id != null;
  if (goesToPending) {
    await client.query(
      `UPDATE entries SET status = 'PENDING_CHARGE', exit_at = $2, exit_by = $3, exit_shift_id = $4, rate_id = $5,
              billed_minutes = $6, calculated_amount = $7, discount_amount = $8, discount_reason = $9, charged_amount = $10
        WHERE id = $1`,
      [entryId, exitAt, user.id, shift.id, rate?.id ?? null, fare.minutes, localCalculated, discount, discount ? reason : null, charged],
    );
    await client.query(
      `INSERT INTO pending_charges (site_id, entry_id, monthly_plan_id, plate, amount, reason, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [siteId, entryId, entry.monthly_plan_id, entry.plate, charged, entry.monthly_plan_id ? 'OUT_OF_SCHEDULE' : 'MANUAL', user.id],
    );
  } else {
    // El cobro va a la caja del turno en que se hizo; si ya cerró, lo decide un administrador
    let registerId = shift.cash_register_id;
    if (shift.register_closed) {
      if (!force || !overrideShiftId) throw new Conflict('REGISTER_CLOSED', { shiftId: shift.id, plate: entry.plate, charged, paymentMethod: d.paymentMethod });
      const { rows: target } = await client.query(
        `SELECT cr.id FROM shifts sh JOIN cash_registers cr ON cr.shift_id = sh.id
          WHERE sh.id = $1 AND sh.site_id = $2 AND sh.closed_at IS NULL AND cr.closed_at IS NULL`,
        [overrideShiftId, siteId],
      );
      if (!target[0]) throw new HttpError(409, 'El turno elegido no tiene la caja abierta', { code: 'NO_OPEN_SHIFT' });
      registerId = target[0].id;
    }
    let split;
    try {
      split = splitPayment(d.paymentMethod, charged, d.cashAmount);
    } catch (e) {
      throw new Conflict('INVALID', { reason: e.message });
    }
    await client.query(
      `UPDATE entries SET status = 'PAID', exit_at = $2, exit_by = $3, exit_shift_id = $4, rate_id = $5,
              billed_minutes = $6, calculated_amount = $7, discount_amount = $8, discount_reason = $9, charged_amount = $10,
              payment_method = $11, cash_amount = $12, electronic_amount = $13, cash_register_id = $14, paid_at = $2
        WHERE id = $1`,
      [entryId, exitAt, user.id, shift.id, rate?.id ?? null, fare.minutes, localCalculated, discount, discount ? reason : null,
        charged, d.paymentMethod, split.cash, split.electronic, registerId],
    );
  }

  return {
    siteId,
    entryId,
    receipt: `${entry.receipt_prefix}${entry.receipt_number}`,
    tariffDifference,
    event: { type: 'entry:exited', payload: { entryId, plate: entry.plate, status: goesToPending ? 'PENDING_CHARGE' : 'PAID', offline: true } },
  };
}

// ---------------------------------------------------------------------------
// Procesamiento
// ---------------------------------------------------------------------------

/**
 * Aplica (o vuelve a aplicar, al resolver un conflicto) una operación.
 * Devuelve el resultado; los conflictos se guardan y se devuelven como status 'CONFLICT'.
 */
async function processOperation(user, op, deviceId, req, options = {}) {
  const { rows: existing } = await query('SELECT o.*, NULL AS result_receipt FROM offline_operations o WHERE id = $1', [op.id]);
  if (existing[0] && !options.resolving) {
    return { ...toResult(await withReceipt(existing[0])), duplicate: true };
  }
  const siteId = Number(op.data?.siteId);
  // Sin una sede válida no hay dónde guardar el conflicto: se rechaza el lote (el dispositivo la corrige)
  if (!Number.isInteger(siteId) || !canAccessSite(user, siteId)) {
    throw new HttpError(403, 'La operación es de una sede a la que el usuario no tiene acceso', { code: 'FORBIDDEN_SITE' });
  }

  const clock = options.resolving ? {} : clockCheck(options.clock, op.clientTs);
  try {
    const outcome = await withTransaction(async (client) => {
      await client.query('SAVEPOINT op');
      let applied = null;
      let conflict = null;
      try {
        applied = op.kind === 'ENTRY'
          ? await applyEntry(client, user, op, deviceId, options)
          : await applyExit(client, user, op, deviceId, options);
      } catch (err) {
        if (!(err instanceof Conflict)) {
          // Choque con el índice único (otro operador registró la misma placa justo ahora)
          if (err.constraint === 'entries_one_open_per_plate' || err.constraint === 'entries_one_open_bicycle_per_site') {
            conflict = new Conflict('PLATE_ALREADY_INSIDE', { plate: op.data?.plate });
          } else throw err;
        } else conflict = err;
        await client.query('ROLLBACK TO SAVEPOINT op');
      }

      const payload = { ...op.data, clientTs: op.clientTs };
      if (options.resolving) {
        if (conflict) throw new HttpError(409, `No se pudo aplicar: ${conflict.message}`, { code: conflict.code, details: conflict.detail });
        // Solo si sigue en conflicto: dos administradores no pueden resolver la misma operación
        const upd = await client.query(
          `UPDATE offline_operations
              SET status = 'RESOLVED_APPLIED', entry_id = COALESCE($2, entry_id), resolved_at = now(),
                  resolved_by = $3, resolution_note = $4
            WHERE id = $1 AND status = 'CONFLICT'`,
          [op.id, applied?.entryId ?? null, options.resolvedBy ?? user.id, options.note],
        );
        if (upd.rowCount === 0) {
          throw new HttpError(409, 'Este conflicto ya fue resuelto', { code: 'ALREADY_RESOLVED' });
        }
      } else {
        await client.query(
          `INSERT INTO offline_operations (id, site_id, user_id, device_id, seq, kind, client_ts, provisional_receipt,
                                           payload, status, entry_id, conflict_code, conflict_detail,
                                           received_at, device_time, clock_offset_seconds, clock_warning)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, COALESCE($14, now()), $15, $16, $17)`,
          [op.id, siteId, user.id, deviceId, op.seq, op.kind, op.clientTs, op.provisionalReceipt ?? null,
            payload, conflict ? 'CONFLICT' : 'APPLIED', applied?.entryId ?? null, conflict?.code ?? null, conflict ? conflict.detail : null,
            clock.receivedAt, clock.deviceTime, clock.offsetSeconds, clock.warning],
        );
        if (clock.warning) {
          await recordAudit(
            {
              req,
              userId: user.id,
              siteId,
              action: 'OFFLINE_CLOCK_SKEW',
              entityType: 'offline_operation',
              entityId: op.id,
              details: {
                warning: clock.warning,
                deviceId,
                clientTs: op.clientTs,
                deviceTime: clock.deviceTime,
                receivedAt: clock.receivedAt,
                offsetSeconds: clock.offsetSeconds,
                entryId: applied?.entryId ?? null,
              },
            },
            client,
          );
        }
      }

      if (applied?.tariffDifference) {
        await recordAudit(
          {
            req,
            userId: user.id,
            siteId,
            action: 'OFFLINE_TARIFF_DIFFERENCE',
            entityType: 'entry',
            entityId: applied.entryId,
            details: { operationId: op.id, ...applied.tariffDifference },
          },
          client,
        );
      }
      if (conflict) {
        await recordAudit(
          { req, userId: user.id, siteId, action: 'OFFLINE_CONFLICT', entityType: 'offline_operation', entityId: op.id, details: { code: conflict.code, ...conflict.detail } },
          client,
        );
      }
      return { applied, conflict };
    });

    if (outcome.applied?.event) publish(outcome.applied.siteId, outcome.applied.event.type, outcome.applied.event.payload);
    if (outcome.conflict) publish(siteId, 'sync:conflict', { operationId: op.id, code: outcome.conflict.code });
    const { rows } = await query('SELECT * FROM offline_operations WHERE id = $1', [op.id]);
    return { ...toResult(await withReceipt(rows[0])), tariffDifference: outcome.applied?.tariffDifference ?? null };
  } catch (err) {
    // Dos envíos simultáneos del mismo UUID: el segundo devuelve lo que guardó el primero
    if (err.code === '23505' && err.constraint === 'offline_operations_pkey') {
      const { rows } = await query('SELECT * FROM offline_operations WHERE id = $1', [op.id]);
      return { ...toResult(await withReceipt(rows[0])), duplicate: true };
    }
    throw err;
  }
}

// Agrega el recibo definitivo (de la entrada) al resultado
async function withReceipt(row) {
  if (!row.entry_id) return row;
  const { rows } = await query('SELECT receipt_prefix || receipt_number AS r FROM entries WHERE id = $1', [row.entry_id]);
  return { ...row, result_receipt: rows[0]?.r ?? null };
}

async function syncBatch(req, body) {
  const { deviceId, ops, deviceTime } = parseBatch(body);
  // Hora de recepción (reloj de la base, el mismo de received_at) para todo el lote
  const { rows: nowRows } = await query('SELECT now() AS now');
  const clock = { receivedAt: nowRows[0].now, deviceTime };
  const results = [];
  for (const op of ops) {
    results.push(await processOperation(req.user, op, deviceId, req, { clock }));
  }
  return {
    results,
    applied: results.filter((r) => r.status === 'APPLIED').length,
    conflicts: results.filter((r) => r.status === 'CONFLICT').length,
    clockWarnings: results.filter((r) => r.clockWarning).length,
  };
}

// ---------------------------------------------------------------------------
// Copia local para trabajar sin conexión
// ---------------------------------------------------------------------------

async function snapshot(req, rawSiteId) {
  const siteId = Number.parseInt(rawSiteId, 10);
  if (!canAccessSite(req.user, siteId)) throw new HttpError(403, 'No tiene acceso a esta sede', { code: 'FORBIDDEN_SITE' });
  const [site, rates, monthly, open, now] = await Promise.all([
    query(
      `SELECT id, code, name, legal_id, address, phone, city, business_hours, receipt_prefix, receipt_config, capacity
         FROM sites WHERE id = $1`,
      [siteId],
    ),
    query(
      `SELECT id, vehicle_type, fraction_amount, hour_amount, full_12h_amount, pricing_mode, valid_from, valid_to
         FROM rates WHERE site_id = $1 AND (valid_to IS NULL OR valid_to > now()) ORDER BY valid_from`,
      [siteId],
    ),
    query(
      `SELECT plate, client_name, schedule, night_start, night_end, start_date::text,
              (GREATEST(COALESCE(CASE WHEN payment_status = 'PARTIAL' THEN installment_due_date END, end_date),
                        COALESCE(next_period_end, end_date)) + 3)::text AS covered_until
         FROM monthly_plans
        WHERE site_id = $1 AND is_active AND deleted_at IS NULL AND payment_status <> 'PENDING_CONFIRMATION'
          AND GREATEST(end_date, COALESCE(next_period_end, end_date)) + 3 >= CURRENT_DATE`,
      [siteId],
    ),
    query(
      `SELECT id, plate, vehicle_type, receipt_prefix || receipt_number AS receipt, entry_at, monthly_plan_id, zone_id
         FROM entries WHERE site_id = $1 AND status = 'OPEN' ORDER BY entry_at DESC`,
      [siteId],
    ),
    query('SELECT now() AS now'),
  ]);
  const s = site.rows[0];
  return {
    serverTime: now.rows[0].now,
    site: {
      id: s.id,
      code: s.code,
      name: s.name,
      receiptPrefix: s.receipt_prefix,
      capacity: s.capacity,
      business: { name: s.name, legalId: s.legal_id, address: s.address, phone: s.phone, city: s.city, hours: s.business_hours },
      config: s.receipt_config ?? {},
    },
    rates: rates.rows.map((r) => ({
      id: r.id,
      vehicleType: r.vehicle_type,
      fractionAmount: r.fraction_amount,
      hourAmount: r.hour_amount,
      full12hAmount: r.full_12h_amount,
      pricingMode: r.pricing_mode,
      validFrom: r.valid_from,
      validTo: r.valid_to,
    })),
    monthly: monthly.rows.map((m) => ({
      plate: m.plate,
      clientName: m.client_name,
      schedule: m.schedule,
      nightStart: m.night_start?.slice(0, 5) ?? null,
      nightEnd: m.night_end?.slice(0, 5) ?? null,
      startDate: m.start_date,
      coveredUntil: m.covered_until,
    })),
    openEntries: open.rows.map((e) => ({
      id: e.id,
      plate: e.plate,
      vehicleType: e.vehicle_type,
      receipt: e.receipt,
      entryAt: e.entry_at,
      monthlyPlanId: e.monthly_plan_id,
    })),
  };
}

module.exports = {
  syncBatch,
  processOperation,
  snapshot,
  clockCheck,
  CONFLICT_MESSAGES,
  CLOCK_MESSAGES,
  CLOCK_SKEW_LIMIT_SECONDS,
  Conflict,
  toResult,
  withReceipt,
};
