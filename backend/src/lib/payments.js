// Reglas de cobro compartidas por salidas, cargos pendientes y cambios de forma de pago.
const HttpError = require('../middlewares/httpError');

const PAYMENT_METHODS = ['CASH', 'ELECTRONIC', 'MIXED'];
const MAX_MONEY = 10000000; // mismo tope que FPValidate.MAX_MONEY de la v1.0
const MIN_REASON_LENGTH = 3;

function isMoney(value) {
  return Number.isInteger(value) && value >= 0 && value <= MAX_MONEY;
}

/**
 * Reparte el valor cobrado entre efectivo y electrónico según la forma de pago.
 *   CASH → todo en efectivo · ELECTRONIC → todo electrónico
 *   MIXED → `cashAmount` en efectivo (mayor que 0 y menor que el total) y el resto electrónico
 */
function splitPayment(method, charged, cashAmount) {
  if (!PAYMENT_METHODS.includes(method)) {
    throw new HttpError(400, 'Seleccione la forma de pago: efectivo, electrónico o ambos', { code: 'VALIDATION_ERROR' });
  }
  if (method === 'CASH') return { cash: charged, electronic: 0 };
  if (method === 'ELECTRONIC') return { cash: 0, electronic: charged };
  if (!Number.isInteger(cashAmount) || cashAmount <= 0 || cashAmount >= charged) {
    throw new HttpError(
      400,
      'En "Ambos" indique un valor en efectivo mayor que $ 0 y menor que el total; el resto se toma como electrónico',
      { code: 'VALIDATION_ERROR' },
    );
  }
  return { cash: cashAmount, electronic: charged - cashAmount };
}

/**
 * Valor cobrado y descuento. Si no se envía `chargedAmount`, se cobra lo calculado.
 * Un valor menor es un descuento y exige motivo (RF10). Nunca se cobra más de lo calculado.
 */
function resolveCharge(calculated, chargedAmount, discountReason) {
  if (chargedAmount === undefined || chargedAmount === null || chargedAmount === '') {
    return { charged: calculated, discount: 0, reason: null };
  }
  if (!isMoney(chargedAmount)) {
    throw new HttpError(400, 'El valor a cobrar debe ser un número entero, sin decimales', { code: 'VALIDATION_ERROR' });
  }
  if (chargedAmount > calculated) {
    throw new HttpError(400, 'El valor a cobrar no puede ser mayor que la tarifa calculada', { code: 'VALIDATION_ERROR' });
  }
  const discount = calculated - chargedAmount;
  const reason = typeof discountReason === 'string' ? discountReason.trim().replace(/\s+/g, ' ') : '';
  if (discount > 0 && reason.length < MIN_REASON_LENGTH) {
    throw new HttpError(400, 'Escriba el motivo del descuento', { code: 'DISCOUNT_REASON_REQUIRED' });
  }
  return { charged: chargedAmount, discount, reason: discount > 0 ? reason.slice(0, 200) : null };
}

function requireReason(reason, message = 'Escriba el motivo del cambio') {
  const clean = typeof reason === 'string' ? reason.trim().replace(/\s+/g, ' ') : '';
  if (clean.length < MIN_REASON_LENGTH) throw new HttpError(400, message, { code: 'REASON_REQUIRED' });
  return clean.slice(0, 200);
}

const PAYMENT_LABELS = { CASH: 'Efectivo', ELECTRONIC: 'Electrónico', MIXED: 'Efectivo + Electrónico' };

module.exports = { PAYMENT_METHODS, PAYMENT_LABELS, MAX_MONEY, splitPayment, resolveCharge, requireReason, isMoney };
