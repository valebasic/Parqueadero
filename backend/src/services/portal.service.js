// Portal del cliente (V4, RF53-RF59).
//   Pantalla 1 "Mi vehículo": el QR del tiquete (sede + recibo) basta para ver la estancia.
//   Pantalla 2 "Pago": el cliente paga con Wompi antes de salir; se confirma solo con la firma de
//   Wompi o consultando a Wompi directamente.
//
// PRIVACIDAD: este servicio devuelve SOLO lo que el cliente puede ver. Nunca expone nombres de
// empleados, ni de clientes con mensualidad, ni ids internos. El valor sale de la misma tarifa y de
// la misma función de cobro que usa la caja (nunca se recalcula distinto en el portal).
const crypto = require('crypto');
const { query, withTransaction } = require('../db/pool');
const env = require('../config/env');
const HttpError = require('../middlewares/httpError');
const { VEHICLE_LABELS } = require('../lib/plates');
const { calculateFare } = require('./tariff.service');
const { findRate } = require('./entries.service');
const { findCredit, withinWindow } = require('./portalCredit.service');
const wompi = require('./wompi.service');
const { recordAudit } = require('./audit.service');
const { publish } = require('../realtime/bus');
const { sendPaymentReceipt } = require('./notification.service');
const monthlyPay = require('./portalMonthly.service');

// Las referencias de pagos de mensualidad empiezan por NXM-; las de estancias por NX-
const isPlanRef = (reference) => String(reference).startsWith('NXM-');

const NOT_FOUND = () => new HttpError(404, 'No encontramos ese recibo. Revise el código QR de su tiquete.', { code: 'NOT_FOUND' });

// "FA12" -> { prefix: 'FA', number: 12 }
function parseReceipt(raw) {
  const m = /^([A-Za-z]{1,5})(\d{1,9})$/.exec(String(raw ?? '').trim());
  if (!m) return null;
  return { prefix: m[1].toUpperCase(), number: Number.parseInt(m[2], 10) };
}

async function findEntry(rawSite, rawReceipt) {
  const site = String(rawSite ?? '').trim().toUpperCase();
  const receipt = parseReceipt(rawReceipt);
  if (!site || !receipt) throw NOT_FOUND();
  const { rows } = await query(
    `SELECT e.id, e.site_id, e.plate, e.vehicle_type, e.status, e.entry_at, e.exit_at,
            e.billed_minutes, e.charged_amount, e.receipt_prefix, e.receipt_number, e.monthly_plan_id,
            s.code AS site_code, s.name AS site_name, s.address, s.phone, s.city, s.business_hours,
            z.name AS zone_name, ps.code AS space_code, now() AS now
       FROM entries e
       JOIN sites s ON s.id = e.site_id
       LEFT JOIN zones z ON z.id = e.zone_id
       LEFT JOIN parking_spaces ps ON ps.id = e.space_id
      WHERE upper(s.code) = $1 AND e.receipt_prefix = $2 AND e.receipt_number = $3`,
    [site, receipt.prefix, receipt.number],
  );
  if (!rows[0]) throw NOT_FOUND();
  return rows[0];
}

async function fareNow(e) {
  const client = { query: (t, p) => query(t, p) };
  const rate = await findRate(client, e.site_id, e.vehicle_type, e.now);
  return calculateFare({ entryAt: e.entry_at, exitAt: e.now, rate });
}

// ---------------------------------------------------------------------------
// Pantalla 1: estancia
// ---------------------------------------------------------------------------

async function getStay(rawSite, rawReceipt) {
  const e = await findEntry(rawSite, rawReceipt);
  const open = e.status === 'OPEN';
  const out = {
    receipt: `${e.receipt_prefix}${e.receipt_number}`,
    business: { name: e.site_name, address: e.address, phone: e.phone, city: e.city, hours: e.business_hours },
    plate: e.plate,
    vehicleType: e.vehicle_type,
    vehicleLabel: VEHICLE_LABELS[e.vehicle_type],
    zone: e.zone_name,
    space: e.space_code ?? null,
    entryAt: e.entry_at,
    // 'INSIDE' = sigue en el parqueadero; 'EXITED' = ya salió; 'PENDING' = salió con cobro pendiente
    state: open ? 'INSIDE' : e.status === 'PENDING_CHARGE' ? 'PENDING' : 'EXITED',
    serverTime: e.now,
    canPay: false,
    payment: null,
    paymentMode: wompi.config().mode,
    paymentsEnabled: wompi.paymentsEnabled(),
  };

  if (open) {
    const credit = await findCredit({ query: (t, p) => query(t, p) }, e.id);
    if (e.monthly_plan_id != null) {
      // Mensualidad: no se cobra por tiempo. El detalle va en la consulta con código (pantalla 3).
      out.monthly = true;
      out.minutes = Math.max(0, Math.floor((new Date(e.now) - new Date(e.entry_at)) / 60000));
      out.amount = null;
    } else {
      const fare = await fareNow(e);
      out.minutes = fare.minutes;
      out.amount = Number(fare.total);
      out.canPay = !credit && out.amount > 0 && wompi.paymentsEnabled();
    }
    if (credit) {
      out.payment = {
        status: 'APPROVED',
        amount: credit.amount,
        paidAt: credit.paidAt,
        exitUntil: credit.windowEndsAt,
        withinWindow: withinWindow(credit, e.now),
      };
    }
  } else {
    out.exitAt = e.exit_at;
    out.minutes = e.billed_minutes != null ? Number(e.billed_minutes) : null;
    out.amount = e.charged_amount != null ? Number(e.charged_amount) : null;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Pantalla 2: pago
// ---------------------------------------------------------------------------

function newReference(entryId) {
  // NX-<entrada>-<aleatorio>: única e impredecible (también sirve para consultar el estado)
  return `NX-${entryId}-${crypto.randomBytes(9).toString('base64url')}`;
}

// Inicia un pago: el valor lo calcula el servidor, nunca el navegador
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

async function createPayment(rawSite, rawReceipt, rawEmail) {
  // Correo opcional: solo para enviar el comprobante (no se usa para nada más)
  const email = String(rawEmail ?? '').trim().toLowerCase();
  if (email && (email.length > 120 || !EMAIL_RE.test(email))) {
    throw new HttpError(400, 'El correo no es válido. Revíselo o déjelo en blanco.', { code: 'VALIDATION_ERROR' });
  }
  if (!wompi.paymentsEnabled()) {
    throw new HttpError(409, 'El pago en línea todavía no está disponible. Pague en caja al salir.', { code: 'PAYMENTS_DISABLED' });
  }
  const e = await findEntry(rawSite, rawReceipt);
  if (e.status !== 'OPEN') {
    throw new HttpError(409, 'Este vehículo ya salió: no hay nada por pagar en línea.', { code: 'ENTRY_NOT_OPEN' });
  }
  if (e.monthly_plan_id != null) {
    throw new HttpError(409, 'Su vehículo tiene una mensualidad vigente: no hay cobro por tiempo.', { code: 'MONTHLY' });
  }
  const credit = await findCredit({ query: (t, p) => query(t, p) }, e.id);
  if (credit) {
    throw new HttpError(409, 'Ya pagó. Tiene unos minutos para retirar su vehículo sin cobro adicional.', { code: 'ALREADY_PAID' });
  }
  const fare = await fareNow(e);
  const amount = Number(fare.total);
  if (!(amount > 0)) throw new HttpError(409, 'No hay un valor por pagar todavía.', { code: 'NOTHING_TO_PAY' });

  const cfg = wompi.config();
  const reference = newReference(e.id);
  await query(
    `INSERT INTO portal_payments (site_id, entry_id, reference, amount, provider, notify_email)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [e.site_id, e.id, reference, amount, cfg.mode, email || null],
  );

  const base = env.portalUrl.replace(/\/+$/, '');
  const back = `${base}/recibo?sede=${encodeURIComponent(e.site_code)}&recibo=${encodeURIComponent(`${e.receipt_prefix}${e.receipt_number}`)}&ref=${encodeURIComponent(reference)}`;
  if (cfg.mode === 'wompi') {
    const { url } = wompi.buildCheckout({ reference, amountCop: amount, redirectUrl: back });
    return { reference, mode: 'wompi', amount, checkoutUrl: url };
  }
  // Simulado: el propio portal muestra la pantalla de pago de pruebas
  return { reference, mode: 'mock', amount, checkoutUrl: null };
}

/**
 * Aplica el resultado de una transacción a nuestro pago. Idempotente: repetir el mismo evento no
 * cambia nada. Valida que el monto coincida con el que se cobró.
 */
async function applyTransaction({ reference, providerTxId, status, amountInCents }, req = null) {
  const newStatus = wompi.mapStatus(status);
  let result;
  await withTransaction(async (client) => {
    const { rows } = await client.query('SELECT * FROM portal_payments WHERE reference = $1 FOR UPDATE', [reference]);
    const pay = rows[0];
    if (!pay) throw new HttpError(404, 'Pago no encontrado', { code: 'NOT_FOUND' });
    if (amountInCents != null && Number(amountInCents) !== Number(pay.amount) * 100) {
      await recordAudit({ req, action: 'PORTAL_PAYMENT_AMOUNT_MISMATCH', siteId: pay.site_id, entityType: 'portal_payment', entityId: pay.id,
        details: { expected: Number(pay.amount) * 100, received: Number(amountInCents) } }, client);
      throw new HttpError(409, 'El monto del pago no coincide', { code: 'AMOUNT_MISMATCH' });
    }
    // Un pago ya aprobado no se modifica (idempotente)
    if (pay.status === 'APPROVED' || pay.status === newStatus) {
      result = pay;
      return;
    }
    const { rows: upd } = await client.query(
      `UPDATE portal_payments
          SET status = $2, provider_tx_id = COALESCE($3, provider_tx_id),
              paid_at = CASE WHEN $2 = 'APPROVED' THEN now() ELSE paid_at END
        WHERE id = $1 RETURNING *`,
      [pay.id, newStatus, providerTxId ?? null],
    );
    result = upd[0];
    await recordAudit({ req, action: `PORTAL_PAYMENT_${newStatus}`, siteId: pay.site_id, entityType: 'portal_payment', entityId: pay.id,
      details: { reference, amount: Number(pay.amount), provider: pay.provider } }, client);
  });
  if (result.status === 'APPROVED') {
    publish(result.site_id, 'portal:paid', { entryId: result.entry_id });
    // Comprobante por correo (una sola vez; si falla, no afecta el pago)
    sendPaymentReceipt(result.id).catch(() => {});
  }
  return result;
}

// Evento firmado que Wompi envía a nuestro servidor
async function handleWebhook(event, req) {
  if (!wompi.verifyEvent(event)) throw new HttpError(401, 'Firma inválida', { code: 'INVALID_SIGNATURE' });
  if (event.event !== 'transaction.updated') return { ignored: true };
  const tx = event.data?.transaction;
  if (!tx?.reference) return { ignored: true };
  if (isPlanRef(tx.reference)) {
    await monthlyPay.applyPlanTransaction(
      { reference: tx.reference, providerTxId: tx.id, status: tx.status, amountInCents: tx.amount_in_cents }, req,
    );
    return { received: true };
  }
  await applyTransaction(
    { reference: tx.reference, providerTxId: tx.id, status: tx.status, amountInCents: tx.amount_in_cents }, req,
  );
  return { received: true };
}

function paymentDto(p) {
  return {
    reference: p.reference,
    status: p.status,
    amount: Number(p.amount),
    paidAt: p.paid_at,
  };
}

/**
 * Estado de un pago. Si Wompi devolvió al cliente con el id de la transacción, se consulta a Wompi
 * (nunca se confía en lo que diga la URL): sirve cuando el evento aún no llegó, y en desarrollo,
 * donde Wompi no puede avisar a localhost.
 */
async function getPayment(reference, txId, req) {
  if (isPlanRef(reference)) return monthlyPay.getPlanPayment(reference, txId, req);
  const { rows } = await query('SELECT * FROM portal_payments WHERE reference = $1', [String(reference)]);
  let pay = rows[0];
  if (!pay) throw new HttpError(404, 'Pago no encontrado', { code: 'NOT_FOUND' });
  if (pay.status === 'PENDING' && pay.provider === 'wompi' && txId) {
    const tx = await wompi.fetchTransaction(txId).catch(() => null);
    if (tx && tx.reference === pay.reference) {
      pay = await applyTransaction({ reference: pay.reference, providerTxId: tx.id, status: tx.status, amountInCents: tx.amount_in_cents }, req);
    }
  }
  return paymentDto(pay);
}

// Solo en modo simulado: aprueba o rechaza el pago de pruebas
async function simulatePayment(reference, outcome, req) {
  if (wompi.config().mode !== 'mock' || env.isProduction) {
    throw new HttpError(404, 'No disponible', { code: 'NOT_FOUND' });
  }
  const status = outcome === 'DECLINED' ? 'DECLINED' : 'APPROVED';
  const pay = await applyTransaction({ reference: String(reference), providerTxId: `mock-${crypto.randomBytes(6).toString('hex')}`, status }, req);
  return paymentDto(pay);
}

module.exports = { getStay, parseReceipt, createPayment, handleWebhook, getPayment, simulatePayment, applyTransaction };
