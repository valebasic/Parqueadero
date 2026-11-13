// Integración con Wompi (pasarela de pagos de Colombia). Modo de trabajo según las llaves del .env:
//   - Con WOMPI_PUBLIC_KEY / WOMPI_INTEGRITY_SECRET / WOMPI_EVENTS_SECRET → Wompi real (sandbox si
//     WOMPI_ENV=sandbox, que es el valor por defecto; no mueve dinero real).
//   - Sin llaves → modo SIMULADO ('mock'): el portal muestra una pantalla de pago de pruebas para
//     poder desarrollar y probar todo el flujo sin tener cuenta.
// Las llaves privadas nunca viajan al navegador. Solo la pública y la firma de integridad.
const crypto = require('crypto');

const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

function config() {
  const publicKey = process.env.WOMPI_PUBLIC_KEY || '';
  const integritySecret = process.env.WOMPI_INTEGRITY_SECRET || '';
  const eventsSecret = process.env.WOMPI_EVENTS_SECRET || '';
  const wompiEnv = process.env.WOMPI_ENV === 'production' ? 'production' : 'sandbox';
  const real = Boolean(publicKey && integritySecret && eventsSecret);
  return {
    mode: real ? 'wompi' : 'mock',
    publicKey,
    integritySecret,
    eventsSecret,
    wompiEnv,
    apiBase: wompiEnv === 'production' ? 'https://production.wompi.co/v1' : 'https://sandbox.wompi.co/v1',
  };
}

/** Parámetros del checkout web de Wompi (https://checkout.wompi.co/p/) con la firma de integridad. */
function buildCheckout({ reference, amountCop, redirectUrl }) {
  const cfg = config();
  const amountInCents = amountCop * 100;
  const currency = 'COP';
  const signature = sha256(`${reference}${amountInCents}${currency}${cfg.integritySecret}`);
  const params = new URLSearchParams({
    'public-key': cfg.publicKey,
    currency,
    'amount-in-cents': String(amountInCents),
    reference,
    'signature:integrity': signature,
    'redirect-url': redirectUrl,
  });
  return { url: `https://checkout.wompi.co/p/?${params.toString()}`, amountInCents };
}

/**
 * Verifica la firma de un evento de Wompi: SHA256 de los valores de `signature.properties`
 * (en ese orden) + `timestamp` + secreto de eventos, comparado en tiempo constante.
 */
function verifyEvent(event) {
  const cfg = config();
  try {
    const props = event?.signature?.properties;
    const checksum = String(event?.signature?.checksum ?? '');
    if (!cfg.eventsSecret || !Array.isArray(props) || !props.length || !checksum || event.timestamp == null) return false;
    const values = props.map((path) => String(path.split('.').reduce((obj, key) => obj?.[key], event.data) ?? ''));
    const expected = sha256(`${values.join('')}${event.timestamp}${cfg.eventsSecret}`);
    const a = Buffer.from(expected);
    const b = Buffer.from(checksum.toLowerCase());
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/** Consulta directa a Wompi (sin llave): el estado real de una transacción, nunca el que diga el cliente. */
async function fetchTransaction(transactionId) {
  const cfg = config();
  const res = await fetch(`${cfg.apiBase}/transactions/${encodeURIComponent(transactionId)}`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) return null;
  const body = await res.json();
  return body?.data ?? null;
}

// Estados de Wompi → estados propios
const STATUS_MAP = { APPROVED: 'APPROVED', DECLINED: 'DECLINED', VOIDED: 'VOIDED', ERROR: 'ERROR', PENDING: 'PENDING' };
const mapStatus = (s) => STATUS_MAP[String(s).toUpperCase()] ?? 'PENDING';

module.exports = { config, buildCheckout, verifyEvent, fetchTransaction, mapStatus, sha256 };
