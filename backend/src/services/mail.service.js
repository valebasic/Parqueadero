// Envío de correo (SMTP con nodemailer). Funciona con Gmail (gratis, con "contraseña de aplicación"),
// Resend, Brevo, etc.: cualquier servicio con SMTP.
//
// Variables (.env):
//   SMTP_HOST, SMTP_PORT (465 = SSL, 587 = STARTTLS), SMTP_USER, SMTP_PASS, MAIL_FROM
//   Gmail: SMTP_HOST=smtp.gmail.com  SMTP_PORT=465  SMTP_USER=su@gmail.com  SMTP_PASS=<contraseña de aplicación>
//
// Sin SMTP configurado:
//   - desarrollo: modo SIMULADO, el correo se imprime en la consola del servidor (no se envía).
//   - producción: no se envía y se registra como FAILED.
const nodemailer = require('nodemailer');
const env = require('../config/env');

let transport = null;
let forcedTransport = null; // para pruebas

function settings() {
  const host = process.env.SMTP_HOST || '';
  const user = process.env.SMTP_USER || '';
  const pass = process.env.SMTP_PASS || '';
  const port = Number.parseInt(process.env.SMTP_PORT, 10) || 465;
  return {
    configured: Boolean(host && user && pass),
    host,
    port,
    user,
    pass,
    from: process.env.MAIL_FROM || (user ? `Nexo.app <${user}>` : 'Nexo.app <no-responder@nexo.app>'),
  };
}

function getTransport() {
  if (forcedTransport) return forcedTransport;
  const s = settings();
  if (!s.configured) return null;
  if (!transport) {
    transport = nodemailer.createTransport({
      host: s.host,
      port: s.port,
      secure: s.port === 465,
      auth: { user: s.user, pass: s.pass },
    });
  }
  return transport;
}

// "maria@gmail.com" -> "m***@gmail.com" (para la bitácora y los mensajes en pantalla)
function maskEmail(email) {
  const [user = '', domain = ''] = String(email).split('@');
  return `${user.slice(0, 1)}***@${domain}`;
}

/**
 * @returns {Promise<{status: 'SENT'|'SIMULATED'|'FAILED', error?: string}>}
 * Nunca lanza: un correo que falla no debe romper el pago ni la salida.
 */
async function sendMail({ to, subject, text, html }) {
  const s = settings();
  const t = getTransport();
  if (!t) {
    if (env.isProduction) return { status: 'FAILED', error: 'Correo no configurado (SMTP_*)' };
    if (!env.isTest) {
      console.log(`\n[correo simulado] Para: ${to}\nAsunto: ${subject}\n${text}\n`);
    }
    return { status: 'SIMULATED' };
  }
  try {
    await t.sendMail({ from: s.from, to, subject, text, html });
    return { status: 'SENT' };
  } catch (err) {
    return { status: 'FAILED', error: String(err.message || err).slice(0, 300) };
  }
}

function setTransportForTests(t) {
  forcedTransport = t;
}

module.exports = { sendMail, maskEmail, settings, setTransportForTests };
