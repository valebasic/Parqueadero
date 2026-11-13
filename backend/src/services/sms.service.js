// Envío de SMS. Proveedor: Twilio (API REST, sin librerías). Se puede cambiar por otro proveedor
// reemplazando solo `sendViaTwilio`: el resto del sistema usa únicamente `sendSms`.
//
// Variables (.env): SMS_PROVIDER=twilio, TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM
//   (TWILIO_FROM = número de Twilio en formato +1555..., o el SID de un Messaging Service "MG...").
// Con la cuenta de PRUEBA de Twilio solo se puede enviar a números verificados en su consola.
//
// Sin SMS configurado:
//   - desarrollo: modo SIMULADO, el mensaje se imprime en la consola del servidor (no se envía).
//   - producción: no se envía y se registra como FAILED.
// SMS_DAILY_LIMIT (por defecto 200) frena el gasto: pasado el tope del día no se envía más.
const env = require('../config/env');

let forcedSender = null; // para pruebas

function settings() {
  const sid = process.env.TWILIO_ACCOUNT_SID || '';
  const token = process.env.TWILIO_AUTH_TOKEN || '';
  const from = process.env.TWILIO_FROM || '';
  return {
    configured: process.env.SMS_PROVIDER === 'twilio' && Boolean(sid && token && from),
    sid,
    token,
    from,
    dailyLimit: Number.parseInt(process.env.SMS_DAILY_LIMIT, 10) || 200,
  };
}

// Celular colombiano (10 dígitos que empiezan por 3) → "+573001234567". Los fijos no reciben SMS.
function toE164(phone) {
  const digits = String(phone ?? '').replace(/\D/g, '');
  return /^3\d{9}$/.test(digits) ? `+57${digits}` : null;
}

const isMobile = (phone) => toE164(phone) !== null;

// "3001234567" → "300***4567"
function maskPhone(phone) {
  const d = String(phone ?? '').replace(/\D/g, '').replace(/^57(?=3\d{9}$)/, '');
  return d.length >= 7 ? `${d.slice(0, 3)}***${d.slice(-4)}` : '***';
}

async function sendViaTwilio({ to, body }) {
  const s = settings();
  const params = new URLSearchParams({ To: to, Body: body });
  params.set(s.from.startsWith('MG') ? 'MessagingServiceSid' : 'From', s.from);
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(s.sid)}/Messages.json`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${s.sid}:${s.token}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params,
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Twilio ${res.status}: ${err.message || 'error'}`.slice(0, 300));
  }
}

/**
 * @param {{to: string, body: string}} msg  `to` en cualquier formato colombiano (10 dígitos o +57…)
 * @returns {Promise<{status: 'SENT'|'SIMULATED'|'FAILED', error?: string}>}  Nunca lanza.
 */
async function sendSms({ to, body }) {
  const e164 = String(to).startsWith('+') ? to : toE164(to);
  if (!e164) return { status: 'FAILED', error: 'Número no es un celular colombiano' };
  const text = String(body).slice(0, 320);
  if (forcedSender) {
    try {
      await forcedSender({ to: e164, body: text });
      return { status: 'SENT' };
    } catch (err) {
      return { status: 'FAILED', error: String(err.message || err).slice(0, 300) };
    }
  }
  if (!settings().configured) {
    if (env.isProduction) return { status: 'FAILED', error: 'SMS no configurado (TWILIO_*)' };
    if (!env.isTest) console.log(`\n[SMS simulado] Para: ${e164}\n${text}\n`);
    return { status: 'SIMULATED' };
  }
  try {
    await sendViaTwilio({ to: e164, body: text });
    return { status: 'SENT' };
  } catch (err) {
    return { status: 'FAILED', error: String(err.message || err).slice(0, 300) };
  }
}

function setSenderForTests(fn) {
  forcedSender = fn;
}

module.exports = { sendSms, toE164, isMobile, maskPhone, settings, setSenderForTests };
