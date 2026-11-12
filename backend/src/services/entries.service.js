// Entradas y salidas (RF07-RF10).
//   - Placa validada como en la v1.0; el tipo de vehículo se deduce de la placa (o del último uso).
//   - Sin dos entradas abiertas por placa (índice único parcial en la base).
//   - Mensualidad vigente (hasta 3 días después del vencimiento) bloquea la entrada; una mensualidad
//     nocturna fuera de su franja deja entrar, y al salir el cobro queda como cargo pendiente.
//   - Entrar y salir exige turno abierto; la salida cobra en la caja de ese turno.
const { query, withTransaction } = require('../db/pool');
const HttpError = require('../middlewares/httpError');
const { assertSiteAccess } = require('../middlewares/authorize');
const { normalizePlate, detectVehicleType, plateError, VEHICLE_LABELS } = require('../lib/plates');
const { splitPayment, resolveCharge } = require('../lib/payments');
const { calculateFare } = require('./tariff.service');
const { requireOpenShift } = require('./shifts.service');
const { nextReceiptNumber, buildReceipt } = require('./receipts.service');
const { publish } = require('../realtime/bus');

const VEHICLE_TYPES = ['CAR', 'MOTORCYCLE', 'BICYCLE'];
const MONTHLY_GRACE_DAYS = 3;

function parseSiteId(value) {
  const id = Number.parseInt(value, 10);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'Indique la sede', { code: 'VALIDATION_ERROR' });
  return id;
}

function parseEntryId(value) {
  const id = Number.parseInt(value, 10);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'Entrada inválida', { code: 'VALIDATION_ERROR' });
  return id;
}

function toDto(e) {
  return {
    id: e.id,
    siteId: e.site_id,
    zoneId: e.zone_id,
    plate: e.plate,
    vehicleType: e.vehicle_type,
    vehicleLabel: VEHICLE_LABELS[e.vehicle_type],
    receipt: `${e.receipt_prefix}${e.receipt_number}`,
    receiptNumber: e.receipt_number,
    status: e.status,
    entryAt: e.entry_at,
    exitAt: e.exit_at,
    monthlyPlanId: e.monthly_plan_id,
    calculatedAmount: e.calculated_amount,
    discountAmount: e.discount_amount,
    discountReason: e.discount_reason,
    chargedAmount: e.charged_amount,
    paymentMethod: e.payment_method,
    cashAmount: e.cash_amount,
    electronicAmount: e.electronic_amount,
  };
}

// ---------------------------------------------------------------------------
// Mensualidades y tarifas
// ---------------------------------------------------------------------------

/**
 * Mensualidad vigente de la placa en la sede (la de fecha de fin más reciente), con la evaluación
 * de la franja nocturna en la hora actual de Colombia (la sesión de PostgreSQL usa APP_TIMEZONE).
 * Vigente = activa, ya empezó y hoy <= fin (o plazo del 2.º abono quincenal) + 3 días de gracia.
 * Franja nocturna [inicio, fin): a la hora de fin en punto ya está fuera; cruza la medianoche.
 */
// `at`: momento a evaluar (por defecto ahora). Las operaciones sin conexión se evalúan a su hora real.
async function findActiveMonthly(client, siteId, plate, at = null) {
  const { rows } = await client.query(
    `SELECT id, client_name, schedule, night_start, night_end, end_date, payment_status,
            CASE
              WHEN schedule = 'DAY' THEN true
              WHEN night_start < night_end THEN COALESCE($4::timestamptz, now())::time >= night_start AND COALESCE($4::timestamptz, now())::time < night_end
              WHEN night_start > night_end THEN COALESCE($4::timestamptz, now())::time >= night_start OR COALESCE($4::timestamptz, now())::time < night_end
              ELSE true
            END AS inside_window
       FROM monthly_plans
      WHERE site_id = $1 AND plate = $2 AND is_active AND deleted_at IS NULL
        AND payment_status <> 'PENDING_CONFIRMATION'
        AND start_date <= COALESCE($4::timestamptz, now())::date
        AND COALESCE($4::timestamptz, now())::date <= GREATEST(
              COALESCE(CASE WHEN payment_status = 'PARTIAL' THEN installment_due_date END, end_date),
              COALESCE(next_period_end, end_date)
            ) + $3::int
      ORDER BY end_date DESC, updated_at DESC
      LIMIT 1`,
    [siteId, plate, MONTHLY_GRACE_DAYS, at],
  );
  const m = rows[0];
  if (!m) return null;
  const blocks = m.schedule === 'DAY' || m.inside_window;
  return {
    id: m.id,
    clientName: m.client_name,
    schedule: m.schedule,
    nightStart: m.night_start?.slice(0, 5) ?? null,
    nightEnd: m.night_end?.slice(0, 5) ?? null,
    endDate: m.end_date,
    paymentStatus: m.payment_status,
    blocksEntry: blocks,
  };
}

function monthlyBlockedError(plate, monthly) {
  const detail =
    monthly.schedule === 'NIGHT'
      ? `mensualidad nocturna (${monthly.nightStart} a ${monthly.nightEnd}) y está dentro de su horario`
      : 'mensualidad vigente';
  return new HttpError(409, `La placa ${plate} tiene ${detail} (${monthly.clientName}). No se registra como entrada normal.`, {
    code: 'MONTHLY_ACTIVE',
    details: { monthly },
  });
}

async function findRate(client, siteId, vehicleType, at) {
  const { rows } = await client.query(
    `SELECT id, fraction_amount, hour_amount, full_12h_amount, pricing_mode
       FROM rates
      WHERE site_id = $1 AND vehicle_type = $2 AND valid_from <= $3 AND (valid_to IS NULL OR valid_to > $3)`,
    [siteId, vehicleType, at],
  );
  const r = rows[0];
  if (!r) {
    throw new HttpError(409, `No hay tarifa vigente para ${VEHICLE_LABELS[vehicleType]} en esta sede`, {
      code: 'NO_RATE',
    });
  }
  return {
    id: r.id,
    fractionAmount: r.fraction_amount,
    hourAmount: r.hour_amount,
    full12hAmount: r.full_12h_amount,
    pricingMode: r.pricing_mode,
  };
}

// ---------------------------------------------------------------------------
// Consultas
// ---------------------------------------------------------------------------

// Lo que la pantalla necesita saber al escribir una placa
async function lookupPlate(req, rawSiteId, rawPlate) {
  const siteId = parseSiteId(rawSiteId);
  await assertSiteAccess(req, siteId);
  const plate = normalizePlate(rawPlate);
  const error = plateError(plate);
  if (error) return { plate, valid: false, error };

  const client = { query: (t, p) => query(t, p) };
  const [open, last, monthly] = await Promise.all([
    query("SELECT * FROM entries WHERE plate = $1 AND status = 'OPEN' ORDER BY entry_at DESC LIMIT 1", [plate]),
    query('SELECT vehicle_type FROM entries WHERE plate = $1 ORDER BY entry_at DESC LIMIT 1', [plate]),
    findActiveMonthly(client, siteId, plate),
  ]);
  const openEntry = open.rows[0];
  const detected = detectVehicleType(plate);
  // Ciclas siempre como cicla; para carros y motos se respeta el tipo usado la última vez
  const vehicleType = detected === 'BICYCLE' ? detected : last.rows[0]?.vehicle_type ?? detected;
  return {
    plate,
    valid: true,
    vehicleType,
    openEntry: openEntry ? { ...toDto(openEntry), inThisSite: openEntry.site_id === siteId } : null,
    monthly,
  };
}

// Vehículos adentro de la sede (lista de la pantalla Entradas)
async function listOpenEntries(req, rawSiteId) {
  const siteId = parseSiteId(rawSiteId);
  await assertSiteAccess(req, siteId);
  const { rows } = await query(
    `SELECT * FROM entries WHERE site_id = $1 AND status = 'OPEN' ORDER BY entry_at DESC`,
    [siteId],
  );
  return rows.map(toDto);
}

async function loadEntryForUser(req, entryId) {
  const { rows } = await query('SELECT * FROM entries WHERE id = $1', [entryId]);
  if (!rows[0]) throw new HttpError(404, 'Entrada no encontrada', { code: 'NOT_FOUND' });
  await assertSiteAccess(req, rows[0].site_id);
  return rows[0];
}

// Cuánto se cobraría si sale ahora
async function quoteExit(req, rawEntryId) {
  const entry = await loadEntryForUser(req, parseEntryId(rawEntryId));
  if (entry.status !== 'OPEN') {
    throw new HttpError(409, 'Esta entrada ya tiene salida registrada', { code: 'ENTRY_NOT_OPEN' });
  }
  const client = { query: (t, p) => query(t, p) };
  const { rows } = await query('SELECT now() AS now');
  const rate = await findRate(client, entry.site_id, entry.vehicle_type, rows[0].now);
  const fare = calculateFare({ entryAt: entry.entry_at, exitAt: rows[0].now, rate });
  return {
    entry: toDto(entry),
    at: rows[0].now,
    rate,
    ...fare,
    // Mensualidad nocturna fuera de franja: el cobro irá a Pendientes
    goesToPending: entry.monthly_plan_id != null,
  };
}

// ---------------------------------------------------------------------------
// Registrar entrada
// ---------------------------------------------------------------------------

async function createEntry(req, body) {
  const siteId = parseSiteId(body?.siteId);
  await assertSiteAccess(req, siteId);
  const plate = normalizePlate(body?.plate);
  const error = plateError(plate);
  if (error) throw new HttpError(400, error, { code: 'INVALID_PLATE' });

  const detected = detectVehicleType(plate);
  const vehicleType = body?.vehicleType ?? detected;
  if (!VEHICLE_TYPES.includes(vehicleType)) {
    throw new HttpError(400, 'Tipo de vehículo inválido', { code: 'VALIDATION_ERROR' });
  }
  // Las placas genéricas de cicla solo sirven para ciclas, y una cicla solo usa esas placas
  if ((detected === 'BICYCLE') !== (vehicleType === 'BICYCLE')) {
    throw new HttpError(400, 'Para ciclas use la placa CICLA (o sus alias) y el servicio Cicla', {
      code: 'VALIDATION_ERROR',
    });
  }

  const entryId = await withTransaction(async (client) => {
    const shift = await requireOpenShift(client, req.user, siteId, { lock: true });

    // Como en la v1.0, "ya está adentro" se avisa antes que la mensualidad. (El índice único
    // parcial lo vuelve a garantizar abajo aunque dos operadores registren la misma placa a la vez.)
    const { rowCount: inside } = await client.query(
      `SELECT 1 FROM entries
        WHERE plate = $1 AND status = 'OPEN' AND (vehicle_type <> 'BICYCLE' OR site_id = $2)`,
      [plate, siteId],
    );
    if (inside) throw await alreadyInsideError(plate, siteId);

    const monthly = await findActiveMonthly(client, siteId, plate);
    if (monthly?.blocksEntry) throw monthlyBlockedError(plate, monthly);

    const { rows: site } = await client.query('SELECT receipt_prefix FROM sites WHERE id = $1', [siteId]);
    const prefix = site[0].receipt_prefix;
    const number = await nextReceiptNumber(client, siteId, prefix);

    try {
      const { rows } = await client.query(
        `INSERT INTO entries (site_id, zone_id, plate, vehicle_type, receipt_prefix, receipt_number,
                              entry_by, entry_shift_id, monthly_plan_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
        [siteId, shift.zoneId, plate, vehicleType, prefix, number, req.user.id, shift.shiftId,
          monthly && !monthly.blocksEntry ? monthly.id : null],
      );
      return rows[0].id;
    } catch (err) {
      if (err.constraint === 'entries_one_open_per_plate' || err.constraint === 'entries_one_open_bicycle_per_site') {
        throw await alreadyInsideError(plate, siteId);
      }
      throw err;
    }
  });

  const receipt = await buildReceipt({ query: (t, p) => query(t, p) }, entryId);
  publish(siteId, 'entry:created', {
    entryId,
    plate: receipt.plate,
    vehicleType: receipt.vehicleType,
    receipt: receipt.receipt,
    zone: receipt.zone,
    entryAt: receipt.entryAt,
  });
  return receipt;
}

async function alreadyInsideError(plate, siteId) {
  const { rows } = await query(
    `SELECT e.receipt_prefix, e.receipt_number, e.entry_at, s.name AS site_name, e.site_id
       FROM entries e JOIN sites s ON s.id = e.site_id
      WHERE e.plate = $1 AND e.status = 'OPEN' ORDER BY e.entry_at DESC LIMIT 1`,
    [plate],
  );
  const open = rows[0];
  const where = open && open.site_id !== siteId ? ` en ${open.site_name}` : '';
  return new HttpError(409, `La placa ${plate} ya está adentro${where} (recibo ${open ? open.receipt_prefix + open.receipt_number : '—'}). Dele salida primero.`, {
    code: 'ENTRY_ALREADY_OPEN',
    details: open ? { receipt: `${open.receipt_prefix}${open.receipt_number}`, entryAt: open.entry_at } : undefined,
  });
}

// ---------------------------------------------------------------------------
// Registrar salida
// ---------------------------------------------------------------------------

/**
 * body: { paymentMethod: 'CASH'|'ELECTRONIC'|'MIXED'|'PENDING', cashAmount?, chargedAmount?, discountReason? }
 *   - chargedAmount menor que lo calculado = descuento (motivo obligatorio).
 *   - 'PENDING' (o mensualidad nocturna fuera de franja) registra la salida sin cobrar: el cobro
 *     queda en Pendientes.
 */
async function registerExit(req, rawEntryId, body) {
  const entryId = parseEntryId(rawEntryId);
  const method = body?.paymentMethod;

  await withTransaction(async (client) => {
    // Bloquea la entrada: si dos operadores dan salida a la vez, el segundo espera y ve que ya salió
    const { rows } = await client.query('SELECT * FROM entries WHERE id = $1 FOR UPDATE', [entryId]);
    const entry = rows[0];
    if (!entry) throw new HttpError(404, 'Entrada no encontrada', { code: 'NOT_FOUND' });
    await assertSiteAccess(req, entry.site_id);
    if (entry.status !== 'OPEN') {
      throw new HttpError(409, `La salida de ${entry.plate} ya fue registrada (recibo ${entry.receipt_prefix}${entry.receipt_number})`, {
        code: 'ENTRY_NOT_OPEN',
      });
    }

    const shift = await requireOpenShift(client, req.user, entry.site_id, { lock: true });
    const { rows: nowRows } = await client.query('SELECT now() AS now');
    const exitAt = nowRows[0].now;
    const rate = await findRate(client, entry.site_id, entry.vehicle_type, exitAt);
    const fare = calculateFare({ entryAt: entry.entry_at, exitAt, rate });
    const charge = resolveCharge(fare.total, body?.chargedAmount, body?.discountReason);

    const goesToPending = method === 'PENDING' || entry.monthly_plan_id != null;
    if (goesToPending) {
      await client.query(
        `UPDATE entries
            SET status = 'PENDING_CHARGE', exit_at = $2, exit_by = $3, exit_shift_id = $4, rate_id = $5,
                billed_minutes = $6, calculated_amount = $7, discount_amount = $8, discount_reason = $9,
                charged_amount = $10
          WHERE id = $1`,
        [entryId, exitAt, req.user.id, shift.shiftId, rate.id, fare.minutes, fare.total, charge.discount,
          charge.reason, charge.charged],
      );
      await client.query(
        `INSERT INTO pending_charges (site_id, entry_id, monthly_plan_id, plate, amount, reason, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [entry.site_id, entryId, entry.monthly_plan_id, entry.plate, charge.charged,
          entry.monthly_plan_id ? 'OUT_OF_SCHEDULE' : 'MANUAL', req.user.id],
      );
      return;
    }

    const split = splitPayment(method, charge.charged, body?.cashAmount);
    await client.query(
      `UPDATE entries
          SET status = 'PAID', exit_at = $2, exit_by = $3, exit_shift_id = $4, rate_id = $5,
              billed_minutes = $6, calculated_amount = $7, discount_amount = $8, discount_reason = $9,
              charged_amount = $10, payment_method = $11, cash_amount = $12, electronic_amount = $13,
              cash_register_id = $14, paid_at = $2
        WHERE id = $1`,
      [entryId, exitAt, req.user.id, shift.shiftId, rate.id, fare.minutes, fare.total, charge.discount,
        charge.reason, charge.charged, method, split.cash, split.electronic, shift.cashRegisterId],
    );
  });

  const receipt = await buildReceipt({ query: (t, p) => query(t, p) }, entryId);
  publish(receipt.siteId, 'entry:exited', {
    entryId,
    plate: receipt.plate,
    status: receipt.status,
    chargedAmount: receipt.chargedAmount,
    paymentMethod: receipt.paymentMethod,
  });
  if (receipt.status === 'PENDING_CHARGE') publish(receipt.siteId, 'pending:changed', { entryId });
  else publish(receipt.siteId, 'sales:changed', { entryId });
  return receipt;
}

// Recibo (para imprimir justo después de registrar; la reimpresión desde Ventas se audita aparte)
async function getReceipt(req, rawEntryId) {
  const entry = await loadEntryForUser(req, parseEntryId(rawEntryId));
  return buildReceipt({ query: (t, p) => query(t, p) }, entry.id);
}

module.exports = {
  lookupPlate,
  listOpenEntries,
  quoteExit,
  createEntry,
  registerExit,
  getReceipt,
  findActiveMonthly,
  toDto,
};
