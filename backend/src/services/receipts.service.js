// Recibos (RF11): consecutivo sin repetidos y datos para el recibo térmico de 50 mm.
const env = require('../config/env');
const HttpError = require('../middlewares/httpError');
const { VEHICLE_LABELS } = require('../lib/plates');
const { PAYMENT_LABELS } = require('../lib/payments');

/**
 * Siguiente número de recibo para (sede, prefijo). El UPDATE bloquea la fila del contador hasta
 * el fin de la transacción: dos operadores nunca obtienen el mismo número, y si la transacción
 * se revierte el número no se consume.
 */
async function nextReceiptNumber(client, siteId, prefix) {
  await client.query(
    'INSERT INTO receipt_counters (site_id, prefix) VALUES ($1, $2) ON CONFLICT DO NOTHING',
    [siteId, prefix],
  );
  const { rows } = await client.query(
    `UPDATE receipt_counters SET last_number = last_number + 1
      WHERE site_id = $1 AND prefix = $2 RETURNING last_number`,
    [siteId, prefix],
  );
  return rows[0].last_number;
}

// Enlace del QR: el portal del cliente mostrará el recibo (RF57). Por ahora la URL es de ejemplo.
function portalUrlFor(siteCode, receipt) {
  const base = (env.portalUrl || 'https://portal.ejemplo.com').replace(/\/+$/, '');
  return `${base}/recibo?sede=${encodeURIComponent(siteCode)}&recibo=${encodeURIComponent(receipt)}`;
}

/**
 * Datos del recibo de una entrada (si sigue abierta) o de la salida (si ya salió).
 * La presentación (50 mm, @media print) la hace el frontend.
 */
async function buildReceipt(client, entryId) {
  const { rows } = await client.query(
    `SELECT e.*, s.code AS site_code, s.name AS site_name, s.legal_id, s.address, s.phone, s.city, s.business_hours, s.receipt_config,
            z.name AS zone_name, ue.full_name AS entry_by_name, ux.full_name AS exit_by_name,
            mp.client_name AS monthly_client,
            extract(epoch FROM (COALESCE(e.exit_at, now()) - e.entry_at))::bigint / 60 AS minutes
       FROM entries e
       JOIN sites s ON s.id = e.site_id
       LEFT JOIN zones z ON z.id = e.zone_id
       LEFT JOIN users ue ON ue.id = e.entry_by
       LEFT JOIN users ux ON ux.id = e.exit_by
       LEFT JOIN monthly_plans mp ON mp.id = e.monthly_plan_id
      WHERE e.id = $1`,
    [entryId],
  );
  const e = rows[0];
  if (!e) throw new HttpError(404, 'Entrada no encontrada', { code: 'NOT_FOUND' });
  const receipt = `${e.receipt_prefix}${e.receipt_number}`;
  const isExit = e.status !== 'OPEN';
  return {
    type: isExit ? 'EXIT' : 'ENTRY',
    entryId: e.id,
    siteId: e.site_id,
    business: { name: e.site_name, legalId: e.legal_id, address: e.address, phone: e.phone, city: e.city, hours: e.business_hours },
    // Campos visibles, etiquetas y mensajes de Configuración → Recibos
    config: e.receipt_config ?? {},
    zone: e.zone_name,
    receipt,
    plate: e.plate,
    vehicleType: e.vehicle_type,
    vehicleLabel: VEHICLE_LABELS[e.vehicle_type],
    status: e.status,
    entryAt: e.entry_at,
    exitAt: e.exit_at,
    minutes: isExit ? Number(e.billed_minutes ?? e.minutes) : null,
    calculatedAmount: e.calculated_amount,
    discountAmount: e.discount_amount,
    discountReason: e.discount_reason,
    chargedAmount: e.charged_amount,
    paymentMethod: e.payment_method,
    paymentLabel: e.status === 'PENDING_CHARGE' ? 'Pendiente' : PAYMENT_LABELS[e.payment_method] || null,
    cashAmount: e.cash_amount,
    electronicAmount: e.electronic_amount,
    monthlyClient: e.monthly_client,
    operator: isExit ? e.exit_by_name : e.entry_by_name,
    qrUrl: portalUrlFor(e.site_code, receipt),
  };
}

module.exports = { nextReceiptNumber, buildReceipt, portalUrlFor };
