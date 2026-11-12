// Mensualidades (RF13-RF16), con las reglas vigentes del README de la v1.0:
//   - Registrar no cobra: queda "Pendiente de pago". Una placa no tiene dos mensualidades vigentes.
//   - Pago único o quincenal (2 abonos). El saldo del 2.º abono se calcula sobre lo realmente cobrado.
//   - Sin límite de mora: una vencida se paga siempre y el período continúa desde la fecha de fin
//     anterior. La renovación se permite desde 1 día antes del vencimiento.
//   - Pago por adelantado "en cola": si falta más de 1 día, se paga el siguiente período; el actual
//     sigue vigente y el nuevo arranca solo en su fecha de inicio.
//   - Importación CSV: entran "Pendiente de confirmar pago" y un administrador las confirma una a una.
//   - Los pagos de mensualidad NO pasan por caja; tienen su propio consecutivo (FM).
const { query, withTransaction } = require('../db/pool');
const HttpError = require('../middlewares/httpError');
const { assertSiteAccess } = require('../middlewares/authorize');
const { normalizePlate, detectVehicleType, plateError, VEHICLE_LABELS } = require('../lib/plates');
const { splitPayment, resolveCharge, PAYMENT_LABELS, MAX_MONEY } = require('../lib/payments');
const { isDate, addDays, addMonths, diffDays, minDate, parseFlexibleDate, parseFlexibleTime } = require('../lib/dates');
const { recordAudit } = require('./audit.service');
const { nextReceiptNumber, portalUrlFor } = require('./receipts.service');

const PAGE_SIZE = 10;
const INSTALLMENT_DAYS = 15;
const NAME_RE = /^[A-Za-zÁÉÍÓÚÜÑáéíóúüñ][A-Za-zÁÉÍÓÚÜÑáéíóúüñ .'-]*$/;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const PHONE_RE = /^(\d{7}|\d{10})$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

const STATUS_LABELS = {
  ACTIVE: 'Activo',
  RENEWAL_ALLOWED: 'Renovación permitida',
  DUE_TODAY: 'Vence hoy',
  OVERDUE: 'En mora',
  PENDING_PAYMENT: 'Pendiente de pago',
  PENDING_CONFIRMATION: 'Pendiente de confirmar pago',
  INSTALLMENT: 'Quincenal (abonado)',
  INSTALLMENT_OVERDUE: 'Quincenal (abono pendiente)',
  PREPAID: 'Siguiente período pagado',
};

// ---------------------------------------------------------------------------
// Estado
// ---------------------------------------------------------------------------

async function today(client) {
  const { rows } = await (client ?? { query }).query('SELECT CURRENT_DATE::text AS d');
  return rows[0].d;
}

// Fecha hasta la que el cliente está al día (con un abono quincenal abierto, el plazo del 2.º abono)
function effectiveEnd(p) {
  return p.payment_status === 'PARTIAL' && p.installment_due_date ? p.installment_due_date : p.end_date;
}

/**
 * Estado de una mensualidad en la fecha `t` (AAAA-MM-DD).
 * code: ver STATUS_LABELS · moraDays · daysToEnd · canPay · canPrepay
 */
function statusOf(p, t) {
  const end = effectiveEnd(p);
  const daysToEnd = diffDays(t, end);
  const moraDays = Math.max(0, -daysToEnd);
  let code;
  if (p.payment_status === 'PENDING_CONFIRMATION') code = 'PENDING_CONFIRMATION';
  else if (p.next_period_start) code = 'PREPAID';
  else if (p.payment_status === 'PARTIAL') code = moraDays > 0 ? 'INSTALLMENT_OVERDUE' : 'INSTALLMENT';
  else if (p.payment_status === 'PENDING') code = 'PENDING_PAYMENT';
  else if (daysToEnd < 0) code = 'OVERDUE';
  else if (daysToEnd === 0) code = 'DUE_TODAY';
  else if (daysToEnd === 1) code = 'RENEWAL_ALLOWED';
  else code = 'ACTIVE';

  const label = code === 'OVERDUE' || (code === 'PENDING_PAYMENT' && moraDays > 0)
    ? `${STATUS_LABELS[code]} (${moraDays} d)`
    : STATUS_LABELS[code];

  return {
    code,
    label,
    moraDays,
    daysToEnd,
    // Pagar: pendiente, abono abierto, o pagada desde 1 día antes del vencimiento (sin límite de mora)
    canPay:
      code !== 'PENDING_CONFIRMATION' && code !== 'PREPAID' &&
      (p.payment_status !== 'PAID' || diffDays(t, p.end_date) <= 1),
    // Adelantar: pagada, sin abono ni adelanto, y falta más de 1 día para el vencimiento
    canPrepay: p.payment_status === 'PAID' && !p.next_period_start && diffDays(t, p.end_date) > 1,
  };
}

function toDto(p, t) {
  return {
    id: p.id,
    siteId: p.site_id,
    plate: p.plate,
    vehicleType: p.vehicle_type,
    vehicleLabel: VEHICLE_LABELS[p.vehicle_type],
    clientName: p.client_name,
    phones: p.phones,
    email: p.email,
    spaceLabel: p.space_label,
    startDate: p.start_date,
    endDate: p.end_date,
    amount: p.amount,
    schedule: p.schedule,
    nightStart: p.night_start?.slice(0, 5) ?? null,
    nightEnd: p.night_end?.slice(0, 5) ?? null,
    isBiweekly: p.is_biweekly,
    paymentStatus: p.payment_status,
    installment: p.installment_period_start
      ? {
          periodStart: p.installment_period_start,
          periodEnd: p.installment_period_end,
          paid: p.installment_paid,
          balance: Math.max(0, p.amount - p.installment_paid),
          dueDate: p.installment_due_date,
        }
      : null,
    nextPeriod: p.next_period_start ? { start: p.next_period_start, end: p.next_period_end } : null,
    origin: p.origin,
    dataConsent: p.data_consent,
    notes: p.notes,
    createdAt: p.created_at,
    status: statusOf(p, t),
  };
}

// Corre a período vigente los adelantos cuya fecha de inicio ya llegó (syncExpired de la v1.0)
async function rollQueuedPeriods(client, siteId) {
  await client.query(
    `UPDATE monthly_plans
        SET start_date = next_period_start, end_date = next_period_end,
            next_period_start = NULL, next_period_end = NULL
      WHERE next_period_start IS NOT NULL AND next_period_start <= CURRENT_DATE
        AND ($1::int IS NULL OR site_id = $1)`,
    [siteId ?? null],
  );
}

// ---------------------------------------------------------------------------
// Validación
// ---------------------------------------------------------------------------

function invalid(field, message) {
  return new HttpError(400, message, { code: 'VALIDATION_ERROR', details: { [field]: message } });
}

/** Valida y normaliza los datos de una mensualidad. `partial` = edición (solo los campos enviados). */
function validatePlan(body, { partial = false, requirePhone = true } = {}) {
  const out = {};
  const has = (k) => !partial || body[k] !== undefined;

  if (has('plate')) {
    const plate = normalizePlate(body.plate);
    const error = plateError(plate);
    if (error) throw invalid('plate', error);
    out.plate = plate;
    out.vehicleType = body.vehicleType ?? detectVehicleType(plate);
    if (!['CAR', 'MOTORCYCLE', 'BICYCLE'].includes(out.vehicleType)) throw invalid('vehicleType', 'Tipo de vehículo inválido');
  }
  if (has('clientName')) {
    const name = String(body.clientName ?? '').trim().replace(/\s+/g, ' ');
    if (name.length < 2 || name.length > 60 || !NAME_RE.test(name)) {
      throw invalid('clientName', 'El nombre del titular solo puede tener letras y espacios (2 a 60)');
    }
    out.clientName = name;
  }
  if (has('phones')) {
    const phones = (Array.isArray(body.phones) ? body.phones : String(body.phones ?? '').split(','))
      .map((p) => String(p).replace(/\D/g, ''))
      .filter(Boolean);
    if (!phones.length && requirePhone) throw invalid('phones', 'Ingrese al menos un número telefónico');
    const bad = phones.find((p) => !PHONE_RE.test(p));
    if (bad) throw invalid('phones', `El teléfono ${bad} debe tener 7 dígitos (fijo) o 10 (celular)`);
    out.phones = [...new Set(phones)];
  }
  if (has('email')) {
    const email = String(body.email ?? '').trim().toLowerCase();
    if (email && !EMAIL_RE.test(email)) throw invalid('email', 'Correo electrónico inválido');
    out.email = email || null;
  }
  if (has('spaceLabel')) {
    const space = String(body.spaceLabel ?? '').trim();
    if (space.length > 20) throw invalid('spaceLabel', 'El espacio no puede superar 20 caracteres');
    out.spaceLabel = space || null;
  }
  if (has('schedule')) {
    const schedule = body.schedule ?? 'DAY';
    if (!['DAY', 'NIGHT'].includes(schedule)) throw invalid('schedule', 'Modalidad inválida (día o noche)');
    out.schedule = schedule;
    if (schedule === 'NIGHT') {
      const s = parseFlexibleTime(body.nightStart);
      const e = parseFlexibleTime(body.nightEnd);
      if (!s || !e || !TIME_RE.test(s) || !TIME_RE.test(e)) {
        throw invalid('nightStart', 'La modalidad noche requiere la hora límite de entrada y de salida (HH:MM)');
      }
      out.nightStart = s;
      out.nightEnd = e;
    } else {
      out.nightStart = null;
      out.nightEnd = null;
    }
  }
  if (has('amount') && body.amount !== undefined) {
    if (!Number.isInteger(body.amount) || body.amount <= 0 || body.amount > MAX_MONEY) {
      throw invalid('amount', 'El valor mensual debe ser un entero mayor que $ 0');
    }
    out.amount = body.amount;
  }
  for (const key of ['startDate', 'endDate']) {
    if (body[key] !== undefined) {
      if (!isDate(body[key])) throw invalid(key, 'Fecha inválida (AAAA-MM-DD)');
      out[key] = body[key];
    }
  }
  if (body.isBiweekly !== undefined) out.isBiweekly = Boolean(body.isBiweekly);
  if (body.notes !== undefined) out.notes = String(body.notes ?? '').trim().slice(0, 300) || null;
  return out;
}

// Bloqueo por (sede, placa) dentro de la transacción: evita registrar dos a la vez la misma placa
async function lockPlate(client, siteId, plate) {
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`monthly:${siteId}:${plate}`]);
}

/**
 * "Sin dos vigentes por placa": otra mensualidad viva de la misma placa en la sede cuya cobertura
 * (incluido el adelanto y los 3 días de gracia) llega hasta el inicio de la nueva.
 */
async function assertNoOtherActive(client, { siteId, plate, startDate, exceptId = null }) {
  const { rows } = await client.query(
    `SELECT id, client_name, end_date, payment_status
       FROM monthly_plans
      WHERE site_id = $1 AND plate = $2 AND deleted_at IS NULL AND is_active
        AND ($4::bigint IS NULL OR id <> $4)
        AND GREATEST(end_date, COALESCE(next_period_end, end_date)) + 3 >= $3::date
      LIMIT 1`,
    [siteId, plate, startDate, exceptId],
  );
  if (rows[0]) {
    throw new HttpError(
      409,
      `La placa ${plate} ya tiene una mensualidad vigente (${rows[0].client_name}, vence ${rows[0].end_date}). Renuévela en lugar de crear otra.`,
      { code: 'MONTHLY_DUPLICATE', details: { monthlyPlanId: rows[0].id } },
    );
  }
}

async function defaultMonthlyAmount(client, siteId, vehicleType) {
  const { rows } = await client.query(
    `SELECT monthly_amount FROM rates
      WHERE site_id = $1 AND vehicle_type = $2 AND valid_from <= now() AND (valid_to IS NULL OR valid_to > now())`,
    [siteId, vehicleType],
  );
  return rows[0]?.monthly_amount ?? 0;
}

async function loadPlan(client, req, id, { lock = false } = {}) {
  const planId = Number.parseInt(id, 10);
  if (!Number.isInteger(planId)) throw new HttpError(400, 'Mensualidad inválida', { code: 'VALIDATION_ERROR' });
  const { rows } = await client.query(
    `SELECT * FROM monthly_plans WHERE id = $1 AND deleted_at IS NULL ${lock ? 'FOR UPDATE' : ''}`,
    [planId],
  );
  if (!rows[0]) throw new HttpError(404, 'Mensualidad no encontrada', { code: 'NOT_FOUND' });
  await assertSiteAccess(req, rows[0].site_id);
  return rows[0];
}

// ---------------------------------------------------------------------------
// Consultas
// ---------------------------------------------------------------------------

async function listPlans(req, filters) {
  const siteId = Number.parseInt(filters.siteId, 10);
  if (!Number.isInteger(siteId)) throw new HttpError(400, 'Indique la sede', { code: 'VALIDATION_ERROR' });
  await assertSiteAccess(req, siteId);
  await rollQueuedPeriods({ query }, siteId);
  const t = await today();

  const q = String(filters.q ?? '').trim();
  const { rows } = await query(
    `SELECT * FROM monthly_plans
      WHERE site_id = $1 AND deleted_at IS NULL
        AND ($2 = '' OR plate LIKE '%' || $3 || '%' OR client_name ILIKE '%' || $2 || '%'
             OR array_to_string(phones, ',') LIKE '%' || $2 || '%')
      ORDER BY end_date, id`,
    [siteId, q, normalizePlate(q)],
  );
  let items = rows.map((p) => toDto(p, t));
  // Filtro por estado como en la v1.0 (vigentes, por vencer, vencidas, pendientes)
  const group = filters.status;
  if (group === 'overdue') items = items.filter((m) => m.status.moraDays > 0 && m.status.code !== 'PENDING_CONFIRMATION');
  else if (group === 'soon') items = items.filter((m) => m.status.daysToEnd >= 0 && m.status.daysToEnd <= 6 && m.status.code !== 'PREPAID');
  else if (group === 'pending') items = items.filter((m) => ['PENDING_PAYMENT', 'INSTALLMENT', 'INSTALLMENT_OVERDUE', 'PENDING_CONFIRMATION'].includes(m.status.code));
  else if (group === 'active') items = items.filter((m) => m.status.moraDays === 0 && m.paymentStatus === 'PAID');

  const page = Math.max(1, Number.parseInt(filters.page, 10) || 1);
  return {
    items: items.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
    page,
    pageSize: PAGE_SIZE,
    count: items.length,
    today: t,
  };
}

async function getPlan(req, id) {
  await rollQueuedPeriods({ query });
  const p = await loadPlan({ query }, req, id);
  const { rows: payments } = await query(
    `SELECT mp.*, u.full_name AS paid_by_name FROM monthly_payments mp LEFT JOIN users u ON u.id = mp.paid_by
      WHERE monthly_plan_id = $1 ORDER BY paid_at DESC`,
    [p.id],
  );
  return { ...toDto(p, await today()), payments: payments.map(toPaymentDto) };
}

function toPaymentDto(r) {
  return {
    id: r.id,
    monthlyPlanId: r.monthly_plan_id,
    receipt: `${r.receipt_prefix}${r.receipt_number}`,
    periodStart: r.period_start,
    periodEnd: r.period_end,
    baseAmount: r.base_amount,
    discountAmount: r.discount_amount,
    amount: r.amount,
    paymentMethod: r.payment_method,
    paymentLabel: PAYMENT_LABELS[r.payment_method],
    cashAmount: r.cash_amount,
    electronicAmount: r.electronic_amount,
    installmentNumber: r.installment_number,
    isAdvance: r.is_advance,
    paidAt: r.paid_at,
    paidBy: r.paid_by_name ?? null,
    plate: r.plate,
    clientName: r.client_name,
  };
}

// ---------------------------------------------------------------------------
// Crear, editar, eliminar
// ---------------------------------------------------------------------------

async function createPlan(req, body) {
  const siteId = Number.parseInt(body?.siteId, 10);
  if (!Number.isInteger(siteId)) throw new HttpError(400, 'Indique la sede', { code: 'VALIDATION_ERROR' });
  await assertSiteAccess(req, siteId);
  const data = validatePlan(body ?? {});
  if (body?.dataConsent !== true) {
    throw invalid('dataConsent', 'Debe contar con la autorización del titular para el tratamiento de sus datos');
  }

  const id = await withTransaction(async (client) => {
    const startDate = data.startDate ?? (await today(client));
    const endDate = data.endDate ?? addMonths(startDate, 1);
    if (endDate <= startDate) throw invalid('endDate', 'La fecha de fin debe ser posterior al inicio');
    const amount = data.amount ?? (await defaultMonthlyAmount(client, siteId, data.vehicleType));
    if (!amount) throw invalid('amount', 'Indique el valor mensual (no hay tarifa de mensualidad para este vehículo)');

    await lockPlate(client, siteId, data.plate);
    await assertNoOtherActive(client, { siteId, plate: data.plate, startDate });

    const { rows } = await client.query(
      `INSERT INTO monthly_plans (site_id, plate, vehicle_type, client_name, phones, email, space_label,
                                  start_date, end_date, amount, schedule, night_start, night_end, is_biweekly,
                                  data_consent, data_consent_at, notes, origin, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, true, now(), $15, 'MANUAL', $16)
       RETURNING id`,
      [siteId, data.plate, data.vehicleType, data.clientName, data.phones, data.email ?? null, data.spaceLabel ?? null,
        startDate, endDate, amount, data.schedule, data.nightStart, data.nightEnd, data.isBiweekly ?? false,
        data.notes ?? null, req.user.id],
    );
    await recordAudit(
      { req, userId: req.user.id, siteId, action: 'MONTHLY_CREATED', entityType: 'monthly_plan', entityId: rows[0].id, details: { plate: data.plate } },
      client,
    );
    return rows[0].id;
  });
  return getPlan(req, id);
}

async function updatePlan(req, id, body) {
  const data = validatePlan(body ?? {}, { partial: true });
  await withTransaction(async (client) => {
    const p = await loadPlan(client, req, id, { lock: true });
    const plate = data.plate ?? p.plate;
    const startDate = data.startDate ?? p.start_date;
    const endDate = data.endDate ?? p.end_date;
    if (endDate <= startDate) throw invalid('endDate', 'La fecha de fin debe ser posterior al inicio');
    if (data.isBiweekly === false && p.payment_status === 'PARTIAL') {
      throw new HttpError(409, 'Tiene un abono quincenal abierto: complete el pago antes de cambiar a pago único', { code: 'INSTALLMENT_OPEN' });
    }
    if (plate !== p.plate || startDate !== p.start_date) {
      await lockPlate(client, p.site_id, plate);
      await assertNoOtherActive(client, { siteId: p.site_id, plate, startDate, exceptId: p.id });
    }
    const next = {
      plate,
      vehicle_type: data.vehicleType ?? p.vehicle_type,
      client_name: data.clientName ?? p.client_name,
      phones: data.phones ?? p.phones,
      email: data.email !== undefined ? data.email : p.email,
      space_label: data.spaceLabel !== undefined ? data.spaceLabel : p.space_label,
      start_date: startDate,
      end_date: endDate,
      amount: data.amount ?? p.amount,
      schedule: data.schedule ?? p.schedule,
      night_start: data.schedule ? data.nightStart : p.night_start,
      night_end: data.schedule ? data.nightEnd : p.night_end,
      is_biweekly: data.isBiweekly ?? p.is_biweekly,
      notes: data.notes !== undefined ? data.notes : p.notes,
    };
    await client.query(
      `UPDATE monthly_plans SET plate = $2, vehicle_type = $3, client_name = $4, phones = $5, email = $6,
              space_label = $7, start_date = $8, end_date = $9, amount = $10, schedule = $11, night_start = $12,
              night_end = $13, is_biweekly = $14, notes = $15
        WHERE id = $1`,
      [p.id, ...Object.values(next)],
    );
    const changes = Object.fromEntries(
      Object.entries(next)
        .filter(([k, v]) => JSON.stringify(v) !== JSON.stringify(p[k]))
        .map(([k, v]) => [k, { from: p[k], to: v }]),
    );
    await recordAudit(
      { req, userId: req.user.id, siteId: p.site_id, action: 'MONTHLY_UPDATED', entityType: 'monthly_plan', entityId: p.id, details: { changes } },
      client,
    );
  });
  return getPlan(req, id);
}

async function deletePlan(req, id) {
  await withTransaction(async (client) => {
    const p = await loadPlan(client, req, id, { lock: true });
    await client.query('UPDATE monthly_plans SET deleted_at = now(), deleted_by = $2, is_active = false WHERE id = $1', [
      p.id,
      req.user.id,
    ]);
    await recordAudit(
      { req, userId: req.user.id, siteId: p.site_id, action: 'MONTHLY_DELETED', entityType: 'monthly_plan', entityId: p.id, details: { plate: p.plate, client: p.client_name } },
      client,
    );
  });
}

// Mensualidad importada: el administrador confirma que ya estaba pagada (sin pasar por caja)
async function confirmImported(req, id) {
  await withTransaction(async (client) => {
    const p = await loadPlan(client, req, id, { lock: true });
    if (p.payment_status !== 'PENDING_CONFIRMATION') {
      throw new HttpError(409, 'Esta mensualidad no está pendiente de confirmar', { code: 'NOT_PENDING_CONFIRMATION' });
    }
    await client.query("UPDATE monthly_plans SET payment_status = 'PAID', is_active = true WHERE id = $1", [p.id]);
    await recordAudit(
      { req, userId: req.user.id, siteId: p.site_id, action: 'MONTHLY_IMPORT_CONFIRMED', entityType: 'monthly_plan', entityId: p.id, details: { plate: p.plate } },
      client,
    );
  });
  return getPlan(req, id);
}

// ---------------------------------------------------------------------------
// Pagos
// ---------------------------------------------------------------------------

/**
 * Registra un pago (o abono quincenal) de la mensualidad.
 * body: { paymentMethod, cashAmount?, chargedAmount?, discountReason?, installmentAmount? }
 *   installmentAmount: en quincenal, cuánto se abona (por defecto la mitad, o el saldo en el 2.º)
 */
async function payPlan(req, id, body) {
  const result = await withTransaction(async (client) => {
    await rollQueuedPeriods(client);
    const p = await loadPlan(client, req, id, { lock: true });
    const t = await today(client);

    if (p.payment_status === 'PENDING_CONFIRMATION') {
      throw new HttpError(409, 'Esta mensualidad fue importada: confirme su pago antes de registrar otro', { code: 'NOT_CONFIRMED' });
    }
    if (p.next_period_start) {
      throw new HttpError(409, `Ya tiene pagado por adelantado el siguiente período (vence ${p.next_period_end})`, { code: 'ALREADY_PREPAID' });
    }

    // Período que cubre este pago
    const renewal = { start: p.end_date, end: addMonths(p.end_date, 1) };
    const renewalAllowed = diffDays(t, p.end_date) <= 1; // desde 1 día antes del vencimiento, sin límite de mora
    let period;
    if (p.payment_status === 'PARTIAL') period = { start: p.installment_period_start, end: p.installment_period_end };
    else if (p.payment_status === 'PENDING') period = renewalAllowed ? renewal : { start: p.start_date, end: p.end_date };
    else if (renewalAllowed) period = renewal;
    else {
      throw new HttpError(409, 'La renovación se puede hacer desde un día antes del vencimiento. Para pagar antes use "Pago adelantado".', {
        code: 'RENEWAL_NOT_YET',
      });
    }

    const full = p.amount;
    const alreadyPaid = p.payment_status === 'PARTIAL' ? p.installment_paid : 0;
    const remaining = full - alreadyPaid;
    let toCharge = full;
    if (p.is_biweekly) {
      toCharge = body?.installmentAmount ?? (alreadyPaid ? remaining : Math.round(full / 2));
      if (!Number.isInteger(toCharge) || toCharge <= 0 || toCharge > remaining) {
        throw new HttpError(400, `El abono debe ser mayor que $ 0 y no superar el saldo (${remaining})`, { code: 'VALIDATION_ERROR' });
      }
    }
    const charge = resolveCharge(toCharge, body?.chargedAmount, body?.discountReason);
    const split = splitPayment(body?.paymentMethod, charge.charged, body?.cashAmount);

    // Quincenal: el saldo se calcula sobre lo realmente cobrado. Pago único: cubre el período entero.
    const totalPaid = p.is_biweekly ? alreadyPaid + charge.charged : full;
    const isFinal = totalPaid >= full;

    const { rows: site } = await client.query('SELECT monthly_receipt_prefix FROM sites WHERE id = $1', [p.site_id]);
    const prefix = site[0].monthly_receipt_prefix;
    const number = await nextReceiptNumber(client, p.site_id, prefix);
    const { rows: pay } = await client.query(
      `INSERT INTO monthly_payments (site_id, monthly_plan_id, receipt_prefix, receipt_number, period_start, period_end,
                                     base_amount, discount_amount, amount, payment_method, cash_amount, electronic_amount,
                                     installment_number, paid_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING id`,
      [p.site_id, p.id, prefix, number, period.start, period.end, toCharge, charge.discount, charge.charged,
        body.paymentMethod, split.cash, split.electronic, p.is_biweekly ? (alreadyPaid ? 2 : 1) : null, req.user.id],
    );

    if (isFinal) {
      await client.query(
        `UPDATE monthly_plans
            SET start_date = $2, end_date = $3, payment_status = 'PAID', is_active = true,
                installment_period_start = NULL, installment_period_end = NULL, installment_paid = 0,
                installment_due_date = NULL
          WHERE id = $1`,
        [p.id, period.start, period.end],
      );
    } else {
      await client.query(
        `UPDATE monthly_plans
            SET payment_status = 'PARTIAL', is_active = true, installment_period_start = $2, installment_period_end = $3,
                installment_paid = $4, installment_due_date = $5
          WHERE id = $1`,
        [p.id, period.start, period.end, totalPaid, minDate(addDays(period.start, INSTALLMENT_DAYS), period.end)],
      );
    }
    await recordAudit(
      {
        req,
        userId: req.user.id,
        siteId: p.site_id,
        action: 'MONTHLY_PAYMENT',
        entityType: 'monthly_plan',
        entityId: p.id,
        details: { receipt: `${prefix}${number}`, charged: charge.charged, discount: charge.discount, period, final: isFinal },
      },
      client,
    );
    return { paymentId: pay[0].id, isFinal, balance: Math.max(0, full - totalPaid) };
  });

  return { ...result, plan: await getPlan(req, id), receipt: await buildMonthlyReceipt(req, result.paymentId) };
}

// Pago por adelantado ("en cola"): el período actual sigue; el siguiente arranca solo en su fecha
async function prepayPlan(req, id, body) {
  const result = await withTransaction(async (client) => {
    await rollQueuedPeriods(client);
    const p = await loadPlan(client, req, id, { lock: true });
    const t = await today(client);
    if (!statusOf(p, t).canPrepay) {
      throw new HttpError(409, 'El pago adelantado se permite con la mensualidad al día, sin adelantos ni abonos, y faltando más de 1 día para el vencimiento', {
        code: 'PREPAY_NOT_ALLOWED',
      });
    }
    const period = { start: p.end_date, end: addMonths(p.end_date, 1) };
    const charge = resolveCharge(p.amount, body?.chargedAmount, body?.discountReason);
    const split = splitPayment(body?.paymentMethod, charge.charged, body?.cashAmount);
    const { rows: site } = await client.query('SELECT monthly_receipt_prefix FROM sites WHERE id = $1', [p.site_id]);
    const prefix = site[0].monthly_receipt_prefix;
    const number = await nextReceiptNumber(client, p.site_id, prefix);
    const { rows: pay } = await client.query(
      `INSERT INTO monthly_payments (site_id, monthly_plan_id, receipt_prefix, receipt_number, period_start, period_end,
                                     base_amount, discount_amount, amount, payment_method, cash_amount, electronic_amount,
                                     is_advance, paid_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, true, $13) RETURNING id`,
      [p.site_id, p.id, prefix, number, period.start, period.end, p.amount, charge.discount, charge.charged,
        body.paymentMethod, split.cash, split.electronic, req.user.id],
    );
    await client.query('UPDATE monthly_plans SET next_period_start = $2, next_period_end = $3 WHERE id = $1', [
      p.id,
      period.start,
      period.end,
    ]);
    await recordAudit(
      { req, userId: req.user.id, siteId: p.site_id, action: 'MONTHLY_PREPAYMENT', entityType: 'monthly_plan', entityId: p.id, details: { receipt: `${prefix}${number}`, period } },
      client,
    );
    return { paymentId: pay[0].id };
  });
  return { plan: await getPlan(req, id), receipt: await buildMonthlyReceipt(req, result.paymentId) };
}

// Recibo de un pago de mensualidad (consecutivo FM)
async function buildMonthlyReceipt(req, paymentId) {
  const { rows } = await query(
    `SELECT mp.*, p.plate, p.client_name, p.vehicle_type, p.phones, p.is_biweekly, p.amount AS plan_amount,
            p.installment_paid, p.payment_status, s.code AS site_code, s.name AS site_name, s.legal_id, s.address,
            s.phone, s.city, s.business_hours, s.receipt_config, u.full_name AS paid_by_name
       FROM monthly_payments mp
       JOIN monthly_plans p ON p.id = mp.monthly_plan_id
       JOIN sites s ON s.id = mp.site_id
       LEFT JOIN users u ON u.id = mp.paid_by
      WHERE mp.id = $1`,
    [paymentId],
  );
  const r = rows[0];
  if (!r) throw new HttpError(404, 'Pago no encontrado', { code: 'NOT_FOUND' });
  await assertSiteAccess(req, r.site_id);
  const receipt = `${r.receipt_prefix}${r.receipt_number}`;
  return {
    type: 'MONTHLY',
    siteId: r.site_id,
    business: { name: r.site_name, legalId: r.legal_id, address: r.address, phone: r.phone, city: r.city, hours: r.business_hours },
    config: r.receipt_config ?? {},
    receipt,
    plate: r.plate,
    vehicleLabel: VEHICLE_LABELS[r.vehicle_type],
    clientName: r.client_name,
    periodStart: r.period_start,
    periodEnd: r.period_end,
    baseAmount: r.base_amount,
    discountAmount: r.discount_amount,
    chargedAmount: r.amount,
    paymentMethod: r.payment_method,
    paymentLabel: PAYMENT_LABELS[r.payment_method],
    cashAmount: r.cash_amount,
    electronicAmount: r.electronic_amount,
    installmentNumber: r.installment_number,
    balance: r.is_biweekly && r.payment_status === 'PARTIAL' ? Math.max(0, r.plan_amount - r.installment_paid) : 0,
    isAdvance: r.is_advance,
    paidAt: r.paid_at,
    operator: r.paid_by_name,
    qrUrl: portalUrlFor(r.site_code, receipt),
  };
}

// ---------------------------------------------------------------------------
// Importación CSV
// ---------------------------------------------------------------------------

const CSV_HEADERS = ['placa', 'nombre', 'telefono', 'correo', 'vehiculo', 'valor', 'inicio', 'vence', 'horario', 'hora_entrada', 'hora_salida', 'espacio'];

function csvTemplate() {
  return [
    CSV_HEADERS.join(','),
    'ABC123,Ana Pérez,3001234567,ana@correo.com,carro,130000,2026-11-01,2026-12-01,dia,,,A-12',
    'JHB02C,Luis Gómez,3109876543,,moto,80000,01/11/2026,01/12/2026,noche,19:00,07:00,',
  ].join('\r\n');
}

// Parser CSV sencillo: separador coma o punto y coma, comillas dobles, BOM de Excel
function parseCsv(text) {
  const clean = String(text ?? '').replace(/^﻿/, '');
  const firstLine = clean.split(/\r?\n/, 1)[0] ?? '';
  const sep = (firstLine.match(/;/g) || []).length > (firstLine.match(/,/g) || []).length ? ';' : ',';
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < clean.length; i += 1) {
    const c = clean[i];
    if (inQuotes) {
      if (c === '"' && clean[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (c === '"') inQuotes = false;
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === sep) {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && clean[i + 1] === '\n') i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((v) => v.trim() !== ''));
}

const VEHICLE_WORDS = { carro: 'CAR', auto: 'CAR', moto: 'MOTORCYCLE', motocicleta: 'MOTORCYCLE', cicla: 'BICYCLE', bicicleta: 'BICYCLE' };

/**
 * Importa mensualidades desde CSV. Se cargan las filas válidas (quedan "Pendiente de confirmar pago")
 * y se informa cada fila con error y su motivo.
 */
async function importCsv(req, body) {
  const siteId = Number.parseInt(body?.siteId, 10);
  if (!Number.isInteger(siteId)) throw new HttpError(400, 'Indique la sede', { code: 'VALIDATION_ERROR' });
  await assertSiteAccess(req, siteId);
  const rows = parseCsv(body?.csv);
  if (rows.length < 2) throw new HttpError(400, 'El archivo no tiene filas para importar', { code: 'VALIDATION_ERROR' });

  const header = rows[0].map((h) => h.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, '_'));
  const col = (name) => header.indexOf(name === 'telefono' && !header.includes('telefono') ? 'documento' : name);
  const missing = ['placa', 'nombre', 'valor', 'inicio', 'vence'].filter((h) => col(h) < 0);
  if (missing.length) {
    throw new HttpError(400, `Faltan columnas en el archivo: ${missing.join(', ')}. Descargue la plantilla.`, { code: 'VALIDATION_ERROR' });
  }

  const errors = [];
  const valid = [];
  const seen = new Set();
  rows.slice(1).forEach((r, i) => {
    const line = i + 2;
    const get = (name) => (col(name) >= 0 ? String(r[col(name)] ?? '').trim() : '');
    try {
      const vehicleWord = get('vehiculo').toLowerCase();
      const data = validatePlan({
        plate: get('placa'),
        vehicleType: VEHICLE_WORDS[vehicleWord] ?? undefined,
        clientName: get('nombre'),
        phones: get('telefono') || get('documento'),
        email: get('correo'),
        spaceLabel: get('espacio'),
        schedule: /^noche|night$/i.test(get('horario')) ? 'NIGHT' : 'DAY',
        nightStart: get('hora_entrada'),
        nightEnd: get('hora_salida'),
        amount: Number(get('valor').replace(/[$.\s]/g, '')),
      }, { requirePhone: false });
      if (vehicleWord && !VEHICLE_WORDS[vehicleWord]) throw new Error(`vehículo "${get('vehiculo')}" no reconocido (carro, moto o cicla)`);
      const startDate = parseFlexibleDate(get('inicio'));
      const endDate = parseFlexibleDate(get('vence'));
      if (!startDate || !endDate) throw new Error('fechas inválidas (use AAAA-MM-DD o DD/MM/AAAA)');
      if (endDate <= startDate) throw new Error('la fecha de vencimiento debe ser posterior al inicio');
      if (seen.has(data.plate)) throw new Error(`la placa ${data.plate} está repetida en el archivo`);
      seen.add(data.plate);
      valid.push({ line, ...data, startDate, endDate });
    } catch (err) {
      errors.push({ line, plate: get('placa').toUpperCase(), reason: err.details ? Object.values(err.details)[0] : err.message });
    }
  });

  let imported = 0;
  await withTransaction(async (client) => {
    for (const row of valid) {
      await lockPlate(client, siteId, row.plate);
      try {
        await assertNoOtherActive(client, { siteId, plate: row.plate, startDate: row.startDate });
      } catch (err) {
        errors.push({ line: row.line, plate: row.plate, reason: err.message });
        continue;
      }
      await client.query(
        `INSERT INTO monthly_plans (site_id, plate, vehicle_type, client_name, phones, email, space_label, start_date,
                                    end_date, amount, schedule, night_start, night_end, payment_status, is_active,
                                    origin, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'PENDING_CONFIRMATION', true, 'CSV_IMPORT', $14)`,
        [siteId, row.plate, row.vehicleType, row.clientName, row.phones, row.email, row.spaceLabel, row.startDate,
          row.endDate, row.amount, row.schedule, row.nightStart, row.nightEnd, req.user.id],
      );
      imported += 1;
    }
    await recordAudit(
      { req, userId: req.user.id, siteId, action: 'MONTHLY_IMPORTED', entityType: 'monthly_plan', details: { imported, errors: errors.length } },
      client,
    );
  });
  errors.sort((a, b) => a.line - b.line);
  return { imported, errors, total: rows.length - 1 };
}

// ---------------------------------------------------------------------------
// Reporte y alertas
// ---------------------------------------------------------------------------

async function report(req, filters) {
  const siteId = Number.parseInt(filters.siteId, 10);
  if (!Number.isInteger(siteId)) throw new HttpError(400, 'Indique la sede', { code: 'VALIDATION_ERROR' });
  await assertSiteAccess(req, siteId);
  const from = isDate(filters.from) ? filters.from : null;
  const to = isDate(filters.to) ? filters.to : null;
  const method = ['CASH', 'ELECTRONIC', 'MIXED'].includes(filters.method) ? filters.method : null;

  const { rows: payments } = await query(
    `SELECT mp.*, p.plate, p.client_name, u.full_name AS paid_by_name
       FROM monthly_payments mp JOIN monthly_plans p ON p.id = mp.monthly_plan_id
       LEFT JOIN users u ON u.id = mp.paid_by
      WHERE mp.site_id = $1 AND ($2::date IS NULL OR mp.paid_at >= $2::date) AND ($3::date IS NULL OR mp.paid_at < $3::date + 1)
        AND ($4::text IS NULL OR mp.payment_method = $4)
      ORDER BY mp.paid_at DESC`,
    [siteId, from, to, method],
  );
  const totals = payments.reduce(
    (acc, r) => ({
      count: acc.count + 1,
      amount: acc.amount + r.amount,
      cash: acc.cash + r.cash_amount,
      electronic: acc.electronic + r.electronic_amount,
      discounts: acc.discounts + r.discount_amount,
    }),
    { count: 0, amount: 0, cash: 0, electronic: 0, discounts: 0 },
  );

  // Cartera: al día / por vencer / pendiente / en mora, con saldo por cobrar
  await rollQueuedPeriods({ query }, siteId);
  const t = await today();
  const { rows: plans } = await query('SELECT * FROM monthly_plans WHERE site_id = $1 AND deleted_at IS NULL', [siteId]);
  const portfolio = { upToDate: 0, dueSoon: 0, pending: 0, overdue: 0, balance: 0 };
  for (const p of plans) {
    const s = statusOf(p, t);
    if (s.code === 'PENDING_CONFIRMATION') continue;
    if (p.payment_status === 'PENDING') {
      portfolio.pending += 1;
      portfolio.balance += p.amount;
    } else if (p.payment_status === 'PARTIAL') {
      portfolio.pending += 1;
      portfolio.balance += Math.max(0, p.amount - p.installment_paid);
    } else if (s.moraDays > 0) {
      portfolio.overdue += 1;
      portfolio.balance += p.amount;
    } else if (s.daysToEnd <= 3 && s.code !== 'PREPAID') portfolio.dueSoon += 1;
    else portfolio.upToDate += 1;
  }

  return { payments: payments.map(toPaymentDto), totals, portfolio, today: t };
}

/**
 * Alertas del Inicio: rojo (en mora o vence hoy), amarillo (1 a 3 días), verde (4 a 6 días).
 * No se listan las pendientes de confirmar ni las que ya pagaron el siguiente período; un registro
 * vencido no cuenta si la placa tiene otra mensualidad al día o por confirmar; con varios vencidos de
 * una placa sale el más reciente.
 */
async function alerts(siteId) {
  await rollQueuedPeriods({ query }, siteId);
  const t = await today();
  const { rows } = await query('SELECT * FROM monthly_plans WHERE site_id = $1 AND deleted_at IS NULL AND is_active', [siteId]);
  const covered = new Set(
    rows
      .filter((p) => p.payment_status === 'PENDING_CONFIRMATION' || diffDays(t, effectiveEnd(p)) >= 0 || p.next_period_start)
      .map((p) => p.plate),
  );
  const byPlate = new Map();
  for (const p of rows) {
    if (p.payment_status === 'PENDING_CONFIRMATION' || p.next_period_start) continue;
    const s = statusOf(p, t);
    if (s.daysToEnd > 6) continue;
    if (s.daysToEnd < 0 && covered.has(p.plate)) continue;
    const prev = byPlate.get(p.plate);
    if (!prev || prev.end_date < p.end_date) byPlate.set(p.plate, p);
  }
  return [...byPlate.values()]
    .map((p) => {
      const s = statusOf(p, t);
      return {
        id: p.id,
        plate: p.plate,
        clientName: p.client_name,
        phones: p.phones,
        endDate: effectiveEnd(p),
        daysToEnd: s.daysToEnd,
        moraDays: s.moraDays,
        label: s.daysToEnd < 0 ? `Mora (${s.moraDays} d)` : s.daysToEnd === 0 ? 'Vence hoy' : `Vence en ${s.daysToEnd} d`,
        color: s.daysToEnd <= 0 ? 'red' : s.daysToEnd <= 3 ? 'yellow' : 'green',
      };
    })
    .sort((a, b) => a.daysToEnd - b.daysToEnd);
}

module.exports = {
  listPlans,
  getPlan,
  createPlan,
  updatePlan,
  deletePlan,
  confirmImported,
  payPlan,
  prepayPlan,
  buildMonthlyReceipt,
  importCsv,
  csvTemplate,
  report,
  alerts,
  statusOf,
  rollQueuedPeriods,
  parseCsv,
};
