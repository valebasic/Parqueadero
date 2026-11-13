// Portal del cliente: renovar o pagar la mensualidad en línea (Wompi o simulado).
//
// Reglas (las mismas de la caja, ver monthly.service.js):
//   - La renovación se permite desde 1 día antes del vencimiento; antes de eso es "pago adelantado":
//     el siguiente período queda en cola y arranca solo en su fecha de inicio.
//   - Una mensualidad vencida se paga siempre (sin límite de mora) y continúa desde su fecha de fin.
//   - Solo pagos únicos por el valor mensual pactado. Quincenales, importadas sin confirmar y con
//     adelanto ya pagado se atienden en el parqueadero.
//   - El pago queda como ELECTRÓNICO, sin empleado (paid_by NULL), con el consecutivo FM normal.
const crypto = require('crypto');
const { query, withTransaction } = require('../db/pool');
const env = require('../config/env');
const HttpError = require('../middlewares/httpError');
const { addMonths, diffDays } = require('../lib/dates');
const wompi = require('./wompi.service');
const { recordAudit } = require('./audit.service');
const { nextReceiptNumber } = require('./receipts.service');
const { rollQueuedPeriods } = require('./monthly.service');
const { publish } = require('../realtime/bus');
const { sendMonthlyPaymentReceipt } = require('./notification.service');

const today = async (client) => (await client.query('SELECT CURRENT_DATE::text AS d')).rows[0].d;

/**
 * ¿Se puede pagar esta mensualidad en línea hoy? Devuelve { mode, period } o { reason }.
 * `p` es la fila de monthly_plans; `t` la fecha de hoy (AAAA-MM-DD).
 */
function planPayOptions(p, t) {
  if (p.is_biweekly || p.payment_status === 'PARTIAL') return { reason: 'Su mensualidad es quincenal: pague en el parqueadero.' };
  if (p.payment_status === 'PENDING_CONFIRMATION') return { reason: 'Su mensualidad está por confirmar: acérquese al parqueadero.' };
  if (p.next_period_start) return { reason: `Ya pagó por adelantado hasta el ${p.next_period_end}.` };
  const renewal = { start: p.end_date, end: addMonths(p.end_date, 1) };
  const renewalAllowed = diffDays(t, p.end_date) <= 1;
  if (p.payment_status === 'PENDING') {
    return { mode: 'FIRST', period: renewalAllowed ? renewal : { start: p.start_date, end: p.end_date } };
  }
  return { mode: renewalAllowed ? 'RENEW' : 'PREPAY', period: renewal };
}

const newReference = (planId) => `NXM-${planId}-${crypto.randomBytes(9).toString('base64url')}`;

async function loadPlan(client, planId, { lock = false } = {}) {
  const { rows } = await client.query(
    `SELECT * FROM monthly_plans WHERE id = $1 AND is_active AND deleted_at IS NULL ${lock ? 'FOR UPDATE' : ''}`,
    [planId],
  );
  if (!rows[0]) throw new HttpError(404, 'No encontramos su mensualidad.', { code: 'NOT_FOUND' });
  return rows[0];
}

// Opciones de pago para mostrar en la vista del portal
async function payInfo(planId) {
  if (!wompi.paymentsEnabled()) {
    return { canPay: false, reason: 'El pago en línea todavía no está disponible. Acérquese al parqueadero para renovar.' };
  }
  const client = { query: (t, p) => query(t, p) };
  await rollQueuedPeriods(client);
  const p = await loadPlan(client, planId);
  const opt = planPayOptions(p, await today(client));
  return opt.mode
    ? { canPay: true, mode: opt.mode, amount: Number(p.amount), periodStart: opt.period.start, periodEnd: opt.period.end }
    : { canPay: false, reason: opt.reason };
}

// Inicia el pago: el valor lo fija el servidor (el valor mensual pactado)
async function createPlanPayment(planId, { backPath = '/portal?tab=mensualidad' } = {}) {
  if (!wompi.paymentsEnabled()) {
    throw new HttpError(409, 'El pago en línea todavía no está disponible. Acérquese al parqueadero.', { code: 'PAYMENTS_DISABLED' });
  }
  const client = { query: (t, p) => query(t, p) };
  await rollQueuedPeriods(client);
  const p = await loadPlan(client, planId);
  const opt = planPayOptions(p, await today(client));
  if (!opt.mode) throw new HttpError(409, opt.reason, { code: 'NOT_PAYABLE_ONLINE' });
  const amount = Number(p.amount);
  if (!(amount > 0)) throw new HttpError(409, 'No hay un valor por pagar. Acérquese al parqueadero.', { code: 'NOTHING_TO_PAY' });

  const cfg = wompi.config();
  const reference = newReference(p.id);
  await query(
    `INSERT INTO portal_plan_payments (site_id, monthly_plan_id, reference, amount, mode, provider)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [p.site_id, p.id, reference, amount, opt.mode, cfg.mode],
  );
  if (cfg.mode === 'wompi') {
    const back = `${env.portalUrl.replace(/\/+$/, '')}${backPath}${backPath.includes('?') ? '&' : '?'}ref=${encodeURIComponent(reference)}`;
    const { url } = wompi.buildCheckout({ reference, amountCop: amount, redirectUrl: back });
    return { reference, mode: 'wompi', amount, checkoutUrl: url };
  }
  return { reference, mode: 'mock', amount, checkoutUrl: null };
}

// Registra el pago en la mensualidad (dentro de la transacción del pago aprobado)
async function applyToPlan(client, pay) {
  await rollQueuedPeriods(client);
  const p = await loadPlan(client, pay.monthly_plan_id, { lock: true });
  const opt = planPayOptions(p, await today(client));
  // Si mientras tanto cambió (p. ej. pagaron en caja), el dinero ya entró: queda para revisión manual
  if (!opt.mode) throw new HttpError(409, opt.reason, { code: 'NOT_PAYABLE_ONLINE' });
  const period = opt.period;
  const { rows: site } = await client.query('SELECT monthly_receipt_prefix FROM sites WHERE id = $1', [p.site_id]);
  const prefix = site[0].monthly_receipt_prefix;
  const number = await nextReceiptNumber(client, p.site_id, prefix);
  const amount = Number(pay.amount);
  const { rows: mp } = await client.query(
    `INSERT INTO monthly_payments (site_id, monthly_plan_id, receipt_prefix, receipt_number, period_start, period_end,
                                   base_amount, discount_amount, amount, payment_method, cash_amount, electronic_amount,
                                   is_advance, paid_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 0, $7, 'ELECTRONIC', 0, $7, $8, NULL) RETURNING id`,
    [p.site_id, p.id, prefix, number, period.start, period.end, amount, opt.mode === 'PREPAY'],
  );
  if (opt.mode === 'PREPAY') {
    await client.query('UPDATE monthly_plans SET next_period_start = $2, next_period_end = $3 WHERE id = $1', [p.id, period.start, period.end]);
  } else {
    await client.query(
      `UPDATE monthly_plans
          SET start_date = $2, end_date = $3, payment_status = 'PAID', is_active = true,
              installment_period_start = NULL, installment_period_end = NULL, installment_paid = 0, installment_due_date = NULL
        WHERE id = $1`,
      [p.id, period.start, period.end],
    );
  }
  await recordAudit({
    action: 'MONTHLY_PAYMENT_PORTAL', siteId: p.site_id, entityType: 'monthly_plan', entityId: p.id,
    details: { receipt: `${prefix}${number}`, charged: amount, period, mode: opt.mode, reference: pay.reference },
  }, client);
  return mp[0].id;
}

/**
 * Aplica el resultado de una transacción a un pago de mensualidad. Idempotente y con validación
 * del monto, igual que los pagos por horas.
 */
async function applyPlanTransaction({ reference, providerTxId, status, amountInCents }, req = null) {
  const newStatus = wompi.mapStatus(status);
  let result;
  await withTransaction(async (client) => {
    const { rows } = await client.query('SELECT * FROM portal_plan_payments WHERE reference = $1 FOR UPDATE', [reference]);
    const pay = rows[0];
    if (!pay) throw new HttpError(404, 'Pago no encontrado', { code: 'NOT_FOUND' });
    if (amountInCents != null && Number(amountInCents) !== Number(pay.amount) * 100) {
      await recordAudit({ req, action: 'PORTAL_PAYMENT_AMOUNT_MISMATCH', siteId: pay.site_id, entityType: 'portal_plan_payment', entityId: pay.id,
        details: { expected: Number(pay.amount) * 100, received: Number(amountInCents) } }, client);
      throw new HttpError(409, 'El monto del pago no coincide', { code: 'AMOUNT_MISMATCH' });
    }
    if (pay.status === 'APPROVED' || pay.status === newStatus) {
      result = pay;
      return;
    }
    const { rows: upd } = await client.query(
      `UPDATE portal_plan_payments
          SET status = $2, provider_tx_id = COALESCE($3, provider_tx_id),
              paid_at = CASE WHEN $2 = 'APPROVED' THEN now() ELSE paid_at END
        WHERE id = $1 RETURNING *`,
      [pay.id, newStatus, providerTxId ?? null],
    );
    result = upd[0];
    await recordAudit({ req, action: `PORTAL_PLAN_PAYMENT_${newStatus}`, siteId: pay.site_id, entityType: 'portal_plan_payment', entityId: pay.id,
      details: { reference, amount: Number(pay.amount), provider: pay.provider } }, client);
  });

  if (result.status === 'APPROVED' && !result.monthly_payment_id && !result.apply_error) {
    // El pago ya está aprobado (dinero recibido). Aplicarlo es una segunda transacción: si falla,
    // queda anotado para revisión y NO se pierde el pago.
    try {
      await withTransaction(async (client) => {
        const mpId = await applyToPlan(client, result);
        const { rows } = await client.query('UPDATE portal_plan_payments SET monthly_payment_id = $2 WHERE id = $1 RETURNING *', [result.id, mpId]);
        result = rows[0];
      });
      publish(result.site_id, 'monthly:changed', { monthlyPlanId: result.monthly_plan_id });
      sendMonthlyPaymentReceipt(result.id).catch(() => {});
    } catch (err) {
      const { rows } = await query('UPDATE portal_plan_payments SET apply_error = $2 WHERE id = $1 RETURNING *', [result.id, String(err.message).slice(0, 300)]);
      result = rows[0];
      await recordAudit({ req, action: 'PORTAL_PLAN_PAYMENT_UNAPPLIED', siteId: result.site_id, entityType: 'portal_plan_payment', entityId: result.id,
        details: { reference, error: err.message } }).catch(() => {});
    }
  }
  return result;
}

async function paymentDto(pay) {
  let receipt = null;
  let newEnd = null;
  if (pay.monthly_payment_id) {
    const { rows } = await query(
      'SELECT receipt_prefix, receipt_number, period_end::text AS period_end, is_advance FROM monthly_payments WHERE id = $1',
      [pay.monthly_payment_id],
    );
    if (rows[0]) {
      receipt = `${rows[0].receipt_prefix}${rows[0].receipt_number}`;
      newEnd = rows[0].period_end;
    }
  }
  return {
    reference: pay.reference,
    kind: 'MONTHLY',
    status: pay.status,
    amount: Number(pay.amount),
    paidAt: pay.paid_at,
    receipt,
    validUntil: newEnd,
    // Cobrado pero sin poder aplicarse: el parqueadero lo revisa (no se le pide pagar otra vez)
    needsReview: pay.status === 'APPROVED' && Boolean(pay.apply_error),
  };
}

async function getPlanPayment(reference, txId, req) {
  const { rows } = await query('SELECT * FROM portal_plan_payments WHERE reference = $1', [String(reference)]);
  let pay = rows[0];
  if (!pay) throw new HttpError(404, 'Pago no encontrado', { code: 'NOT_FOUND' });
  if (pay.status === 'PENDING' && pay.provider === 'wompi' && txId) {
    const tx = await wompi.fetchTransaction(txId).catch(() => null);
    if (tx && tx.reference === pay.reference) {
      pay = await applyPlanTransaction({ reference: pay.reference, providerTxId: tx.id, status: tx.status, amountInCents: tx.amount_in_cents }, req);
    }
  }
  return paymentDto(pay);
}

// Solo en modo simulado
async function simulatePlanPayment(reference, outcome, planId, req) {
  if (wompi.config().mode !== 'mock' || env.isProduction) throw new HttpError(404, 'No disponible', { code: 'NOT_FOUND' });
  const { rows } = await query('SELECT monthly_plan_id FROM portal_plan_payments WHERE reference = $1', [String(reference)]);
  // Solo el titular verificado de esa mensualidad puede simular su pago
  if (!rows[0] || Number(rows[0].monthly_plan_id) !== Number(planId)) throw new HttpError(404, 'Pago no encontrado', { code: 'NOT_FOUND' });
  const pay = await applyPlanTransaction({
    reference: String(reference), providerTxId: `mock-${crypto.randomBytes(6).toString('hex')}`,
    status: outcome === 'DECLINED' ? 'DECLINED' : 'APPROVED',
  }, req);
  return paymentDto(pay);
}

// Lo mínimo que ve quien abre el enlace de pago del correo/SMS: lo necesario para pagar, nada más
async function payLinkView(planId) {
  const { rows } = await query(
    `SELECT mp.plate, mp.end_date::text AS end_date, (mp.end_date - CURRENT_DATE) AS days_left, s.name AS site_name, s.phone
       FROM monthly_plans mp JOIN sites s ON s.id = mp.site_id
      WHERE mp.id = $1 AND mp.is_active AND mp.deleted_at IS NULL`,
    [planId],
  );
  const p = rows[0];
  if (!p) throw new HttpError(404, 'No encontramos su mensualidad.', { code: 'NOT_FOUND' });
  return {
    business: { name: p.site_name, phone: p.phone },
    plate: p.plate,
    endDate: p.end_date,
    daysLeft: Number(p.days_left),
    payOnline: await payInfo(planId),
    paymentMode: wompi.config().mode,
  };
}

module.exports = { planPayOptions, payInfo, payLinkView, createPlanPayment, applyPlanTransaction, getPlanPayment, simulatePlanPayment };
