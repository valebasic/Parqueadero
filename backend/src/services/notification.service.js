// Notificaciones por correo (V4):
//   - Comprobante de pago del portal (si el cliente dejó su correo).
//   - Avisos de mensualidad: por vencer (6, 3 y 1 días) y vencida (al día siguiente).
// Cada aviso se envía UNA sola vez (notification_log.dedupe_key) y un fallo nunca afecta la operación.
const { query } = require('../db/pool');
const env = require('../config/env');
const { sendMail, maskEmail } = require('./mail.service');
const { sendSms, maskPhone, isMobile, settings: smsSettings } = require('./sms.service');
const { createPayLink } = require('./payLink.service');
const { paymentsEnabled } = require('./wompi.service');
const HttpError = require('../middlewares/httpError');
const { assertSiteAccess } = require('../middlewares/authorize');
const { recordAudit } = require('./audit.service');

const esc = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const cop = (n) => `$ ${Number(n).toLocaleString('es-CO')}`;
const fmtDate = (d) => new Date(d).toLocaleDateString('es-CO', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'America/Bogota' });
const fmtTime = (d) => new Date(d).toLocaleTimeString('es-CO', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'America/Bogota' });

// Plantilla simple y legible en cualquier correo; el texto plano va siempre
function layout(title, lines, footer) {
  const html = `<div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;border:1px solid #e3e8ee;border-radius:12px;overflow:hidden">
<div style="background:#0b2748;color:#fff;padding:16px 20px;font-size:20px;font-weight:700">Nexo<span style="color:#ff6b00">.app</span></div>
<div style="padding:20px"><h2 style="margin:0 0 12px;color:#0b2748;font-size:18px">${esc(title)}</h2>
${lines.map((l) => `<p style="margin:6px 0;color:#1c2430">${l.html ?? esc(l)}</p>`).join('')}
<p style="margin-top:20px;color:#6b7686;font-size:12px">${esc(footer)}</p></div></div>`;
  const text = [title, '', ...lines.map((l) => l.text ?? l), '', footer].join('\n');
  return { html, text };
}

// Enlace personal que lleva directo a pagar (sin placa ni código): se crea uno por aviso
// Si el pago en línea no está disponible no se crea enlace (null) y el aviso manda al parqueadero
const renewUrl = async (planId) =>
  paymentsEnabled() ? `${env.portalUrl.replace(/\/+$/, '')}/pagar/${await createPayLink(planId)}` : null;
// "2026-11-15" -> "15 nov"
const fmtShort = (isoDate) =>
  new Date(`${isoDate}T12:00:00-05:00`)
    .toLocaleDateString('es-CO', { day: 'numeric', month: 'short', timeZone: 'America/Bogota' })
    .replace('.', '');

const FOOTER = 'Este mensaje es automático, no lo responda. Usamos su correo solo para este aviso.';

/**
 * Envía una sola vez por `dedupeKey`. Devuelve false si ya se había enviado antes.
 * Un envío que FALLÓ se reintenta (pasados 30 minutos, para no pisar un envío en curso).
 */
async function sendOnce({ kind, channel = 'EMAIL', siteId, entityType, entityId, to, dedupeKey, subject, text, html }) {
  const isSms = channel === 'SMS';
  const ins = await query(
    `INSERT INTO notification_log (kind, channel, site_id, entity_type, entity_id, recipient, dedupe_key, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'FAILED')
     ON CONFLICT (dedupe_key) DO UPDATE SET error = NULL, created_at = now(), recipient = EXCLUDED.recipient
       WHERE notification_log.status = 'FAILED' AND notification_log.created_at < now() - interval '30 minutes'
     RETURNING id`,
    [kind, channel, siteId ?? null, entityType ?? null, entityId == null ? null : String(entityId),
      isSms ? maskPhone(to) : maskEmail(to), dedupeKey],
  );
  if (!ins.rows[0]) return false;
  let r;
  if (isSms) {
    // Tope diario de SMS (cuestan dinero): pasado el límite se registra el fallo y no se envía
    const { rows } = await query(
      `SELECT count(*)::int AS n FROM notification_log
        WHERE channel = 'SMS' AND status = 'SENT' AND created_at >= date_trunc('day', now())`,
    );
    r = rows[0].n >= smsSettings().dailyLimit
      ? { status: 'FAILED', error: 'Se alcanzó el límite diario de SMS' }
      : await sendSms({ to, body: text });
  } else {
    r = await sendMail({ to, subject, text, html });
  }
  await query('UPDATE notification_log SET status = $2, error = $3 WHERE id = $1', [ins.rows[0].id, r.status, r.error ?? null]);
  return r.status !== 'FAILED';
}

// ---------------------------------------------------------------------------
// Comprobante de pago del portal
// ---------------------------------------------------------------------------
async function sendPaymentReceipt(paymentId) {
  try {
    const { rows } = await query(
      `SELECT pp.id, pp.amount, pp.paid_at, pp.notify_email, pp.site_id,
              e.plate, e.receipt_prefix, e.receipt_number, e.entry_at, s.name AS site_name,
              s.address, s.phone, pp.paid_at + make_interval(mins => $2) AS until
         FROM portal_payments pp
         JOIN entries e ON e.id = pp.entry_id
         JOIN sites s ON s.id = pp.site_id
        WHERE pp.id = $1 AND pp.status = 'APPROVED' AND pp.notify_email IS NOT NULL`,
      [paymentId, Number.parseInt(process.env.PORTAL_EXIT_WINDOW_MIN, 10) || 10],
    );
    const p = rows[0];
    if (!p) return false;
    const recibo = `${p.receipt_prefix}${p.receipt_number}`;
    const { html, text } = layout(
      'Comprobante de pago',
      [
        { html: `Recibimos su pago de <strong>${esc(cop(p.amount))}</strong> en <strong>${esc(p.site_name)}</strong>.`, text: `Recibimos su pago de ${cop(p.amount)} en ${p.site_name}.` },
        `Placa: ${p.plate}`,
        `Recibo: ${recibo}`,
        `Entrada: ${fmtDate(p.entry_at)}, ${fmtTime(p.entry_at)}`,
        `Pagado: ${fmtDate(p.paid_at)}, ${fmtTime(p.paid_at)}`,
        { html: `Puede retirar su vehículo <strong>sin cobro adicional hasta las ${esc(fmtTime(p.until))}</strong>`, text: `Puede retirar su vehículo sin cobro adicional hasta las ${fmtTime(p.until)}` },
        [p.address, p.phone && `Tel. ${p.phone}`].filter(Boolean).join(' · '),
      ],
      FOOTER,
    );
    return await sendOnce({
      kind: 'PAYMENT_RECEIPT', siteId: p.site_id, entityType: 'portal_payment', entityId: p.id, to: p.notify_email,
      dedupeKey: `PAYMENT_RECEIPT:${p.id}`, subject: `Comprobante de pago ${recibo} · ${p.site_name}`, text, html,
    });
  } catch (err) {
    console.error('No se pudo enviar el comprobante:', err.message);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Comprobante de pago de mensualidad hecho en el portal (al correo registrado en la mensualidad)
// ---------------------------------------------------------------------------
async function sendMonthlyPaymentReceipt(planPaymentId) {
  try {
    const { rows } = await query(
      `SELECT pp.id, pp.amount, pp.paid_at, pp.site_id, mp.plate, mp.client_name, mp.email, mp.id AS plan_id,
              m.receipt_prefix, m.receipt_number, m.period_start::text AS period_start, m.period_end::text AS period_end,
              m.is_advance, s.name AS site_name, s.address, s.phone
         FROM portal_plan_payments pp
         JOIN monthly_plans mp ON mp.id = pp.monthly_plan_id
         JOIN monthly_payments m ON m.id = pp.monthly_payment_id
         JOIN sites s ON s.id = pp.site_id
        WHERE pp.id = $1 AND pp.status = 'APPROVED'`,
      [planPaymentId],
    );
    const p = rows[0];
    if (!p || !p.email) return false;
    const recibo = `${p.receipt_prefix}${p.receipt_number}`;
    const desde = fmtDate(`${p.period_start}T12:00:00-05:00`);
    const hasta = fmtDate(`${p.period_end}T12:00:00-05:00`);
    const { html, text } = layout(
      'Pago de mensualidad recibido',
      [
        { html: `Hola <strong>${esc(p.client_name)}</strong>,`, text: `Hola ${p.client_name},` },
        { html: `Recibimos su pago de <strong>${esc(cop(p.amount))}</strong> por la mensualidad del vehículo <strong>${esc(p.plate)}</strong> en <strong>${esc(p.site_name)}</strong>.`, text: `Recibimos su pago de ${cop(p.amount)} por la mensualidad del vehículo ${p.plate} en ${p.site_name}.` },
        `Recibo: ${recibo}`,
        { html: `Período cubierto: <strong>${esc(desde)}</strong> al <strong>${esc(hasta)}</strong>${p.is_advance ? ' (pago adelantado: empieza cuando termine el período actual)' : ''}.`, text: `Período cubierto: ${desde} al ${hasta}${p.is_advance ? ' (pago adelantado: empieza cuando termine el período actual)' : ''}.` },
        [p.address, p.phone && `Tel. ${p.phone}`].filter(Boolean).join(' · '),
      ].filter((l) => l !== ''),
      FOOTER,
    );
    return await sendOnce({
      kind: 'MONTHLY_PAYMENT_RECEIPT', siteId: p.site_id, entityType: 'portal_plan_payment', entityId: p.id, to: p.email,
      dedupeKey: `MONTHLY_PAYMENT_RECEIPT:${p.id}`, subject: `Comprobante de mensualidad ${recibo} · ${p.plate}`, text, html,
    });
  } catch (err) {
    console.error('No se pudo enviar el comprobante de mensualidad:', err.message);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Código de verificación del portal (mensualidad)
// ---------------------------------------------------------------------------
async function sendPortalCode({ codeId, planId, email, phone, channel = 'EMAIL', name, code, ttlMin }) {
  try {
    if (channel === 'SMS') {
      return await sendOnce({
        kind: 'PORTAL_CODE', channel: 'SMS', entityType: 'monthly_plan', entityId: planId, to: phone,
        dedupeKey: `PORTAL_CODE_SMS:${codeId}`,
        text: `Nexo.app: su código es ${code}. Vence en ${ttlMin} minutos. Si no lo pidió, ignore este mensaje.`,
      });
    }
    const { html, text } = layout(
      'Su código de verificación',
      [
        `Hola ${name},`,
        { html: `Su código es: <strong style="font-size:26px;letter-spacing:4px">${esc(code)}</strong>`, text: `Su código es: ${code}` },
        `Vence en ${ttlMin} minutos y sirve una sola vez.`,
        'Si usted no lo pidió, ignore este mensaje: nadie puede ver sus datos sin el código.',
      ],
      FOOTER,
    );
    return await sendOnce({
      kind: 'PORTAL_CODE', entityType: 'monthly_plan', entityId: planId, to: email,
      dedupeKey: `PORTAL_CODE:${codeId}`, subject: 'Su código de verificación · Nexo.app', text, html,
    });
  } catch (err) {
    console.error('No se pudo enviar el código:', err.message);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Avisos de mensualidad
// ---------------------------------------------------------------------------
const DUE_DAYS = [6, 3, 1];
// Avisos de vencida: se intentan hasta 3 días después del vencimiento (por si el servidor estuvo apagado)
const OVERDUE_CATCHUP_DAYS = 3;

// Aviso que corresponde con `daysLeft` días por vencer: el menor de DUE_DAYS que sea >= daysLeft.
// Así, si el día exacto (6, 3 o 1) el servidor estaba dormido, el aviso sale en la siguiente revisión.
function dueThreshold(daysLeft) {
  if (daysLeft < 1) return null;
  return [...DUE_DAYS].sort((a, b) => a - b).find((d) => d >= daysLeft) ?? null;
}

// ¿Ya se envió (o se está enviando) este aviso? Los FAILED de hace más de 30 min se reintentan.
async function alreadyLogged(keys) {
  const { rows } = await query(
    `SELECT dedupe_key FROM notification_log
      WHERE dedupe_key = ANY($1::text[])
        AND (status <> 'FAILED' OR created_at >= now() - interval '30 minutes')`,
    [keys],
  );
  return new Set(rows.map((r) => r.dedupe_key));
}

/**
 * Arma el aviso de mensualidad (correo y SMS) para cualquier cantidad de días: por vencer (6, 3, 1,
 * hoy…) o vencida. `m` trae client_name, plate, site_name, address, phone y end_text (AAAA-MM-DD).
 */
function buildReminder(m, daysLeft, link) {
  const overdue = daysLeft < 0;
  const vence = fmtDate(`${m.end_text}T12:00:00-05:00`);
  const corta = fmtShort(m.end_text);
  const dias = daysLeft === 0 ? 'hoy' : `en ${daysLeft} ${daysLeft === 1 ? 'día' : 'días'}`;
  const titulo = overdue ? 'Su mensualidad está vencida' : daysLeft === 0 ? 'Su mensualidad vence hoy' : `Su mensualidad vence ${dias}`;
  const { html, text } = layout(
    titulo,
    [
      { html: `Hola <strong>${esc(m.client_name)}</strong>,`, text: `Hola ${m.client_name},` },
      overdue
        ? {
            html: `La mensualidad de su vehículo con placa <strong>${esc(m.plate)}</strong> en <strong>${esc(m.site_name)}</strong> venció el <strong>${esc(vence)}</strong>.`,
            text: `La mensualidad de su vehículo con placa ${m.plate} en ${m.site_name} venció el ${vence}.`,
          }
        : {
            html: `Le recordamos que la mensualidad de su vehículo con placa <strong>${esc(m.plate)}</strong> en <strong>${esc(m.site_name)}</strong> vence el <strong>${esc(vence)}</strong> (${dias}).`,
            text: `Le recordamos que la mensualidad de su vehículo con placa ${m.plate} en ${m.site_name} vence el ${vence} (${dias}).`,
          },
      overdue ? 'Renuévela para volver a usar su puesto:' : 'Para seguir usando su puesto sin interrupciones, renuévela antes de esa fecha:',
      link ? `• Acérquese al parqueadero${m.address ? ` (${m.address})` : ''}, o` : `• Acérquese al parqueadero${m.address ? ` (${m.address})` : ''}.`,
      link
        ? {
            html: `• Pague en línea con Wompi: <a href="${esc(link)}" style="display:inline-block;background:#ff6b00;color:#fff;text-decoration:none;font-weight:700;padding:10px 16px;border-radius:8px">Renovar mi mensualidad</a>`,
            text: `• Pague en línea con Wompi: ${link}`,
          }
        : '',
      m.phone ? `¿Dudas? Llámenos al ${m.phone}.` : '',
    ].filter((l) => l !== ''),
    FOOTER,
  );
  return {
    overdue,
    subject: overdue ? `Mensualidad vencida · ${m.plate}` : daysLeft === 0 ? `Su mensualidad vence hoy · ${m.plate}` : `Su mensualidad vence ${dias} · ${m.plate}`,
    html,
    text,
    sms: overdue
      ? `Nexo.app: ${m.client_name}, la mensualidad de ${m.plate} venció el ${corta}. Renueve ${link ? `aquí: ${link}` : 'en el parqueadero.'}`
      : `Nexo.app: ${m.client_name}, la mensualidad de ${m.plate} vence el ${corta} (${dias}). Renueve ${link ? `aquí: ${link}` : 'en el parqueadero.'}`,
  };
}

/**
 * Envía los avisos del día. Solo a titulares con correo Y autorización de datos (Ley 1581), y no si
 * ya renovaron (otra mensualidad de la misma placa que termina después).
 * @returns {Promise<{due: number, overdue: number}>}
 */
async function runMonthlyReminders() {
  const { rows } = await query(
    `SELECT mp.id, mp.site_id, mp.plate, mp.client_name, mp.email, mp.phones, mp.end_date::text AS end_text, mp.amount, s.name AS site_name, s.phone, s.address,
            (mp.end_date - CURRENT_DATE) AS days_left
       FROM monthly_plans mp
       JOIN sites s ON s.id = mp.site_id
      WHERE mp.is_active AND mp.data_consent AND mp.deleted_at IS NULL
        AND (mp.email IS NOT NULL OR array_to_string(mp.phones, ',') ~ '(^|,)3[0-9]{9}(,|$)')
        AND (mp.end_date - CURRENT_DATE) BETWEEN -$2::int AND $1::int
        AND (mp.end_date - CURRENT_DATE) <> 0
        AND NOT EXISTS (
          SELECT 1 FROM monthly_plans n
           WHERE n.plate = mp.plate AND n.site_id = mp.site_id AND n.is_active AND n.end_date > mp.end_date
        )`,
    [Math.max(...DUE_DAYS), OVERDUE_CATCHUP_DAYS],
  );
  const counts = { due: 0, overdue: 0 };
  for (const m of rows) {
    const daysLeft = Number(m.days_left);
    const overdue = daysLeft < 0;
    const threshold = overdue ? null : dueThreshold(daysLeft);
    if (!overdue && threshold === null) continue;
    const kind = overdue ? 'MONTHLY_OVERDUE' : 'MONTHLY_DUE';
    const key = `${overdue ? 'MONTHLY_OVERDUE' : `MONTHLY_DUE_${threshold}`}:${m.id}:${m.end_text}`;
    const mobile = (m.phones ?? []).find(isMobile);
    // Antes de crear el enlace de pago: si ya se avisó por todos los canales, no hay nada que hacer
    const done = await alreadyLogged([key, `SMS:${key}`]);
    if ((!m.email || done.has(key)) && (!mobile || done.has(`SMS:${key}`))) continue;
    const link = await renewUrl(m.id);
    const msg = buildReminder(m, daysLeft, link);
    if (m.email) {
      const sent = await sendOnce({
        kind, siteId: m.site_id, entityType: 'monthly_plan', entityId: m.id, to: m.email, dedupeKey: key,
        subject: msg.subject, text: msg.text, html: msg.html,
      });
      if (sent) counts[overdue ? 'overdue' : 'due'] += 1;
    }
    // SMS corto al primer celular registrado (los fijos no reciben SMS)
    if (mobile) {
      const sentSms = await sendOnce({
        kind, channel: 'SMS', siteId: m.site_id, entityType: 'monthly_plan', entityId: m.id, to: mobile,
        dedupeKey: `SMS:${key}`, text: msg.sms,
      });
      if (sentSms) counts.sms = (counts.sms ?? 0) + 1;
    }
  }
  return counts;
}

/**
 * Aviso de mensualidad enviado A MANO por un administrador (botón del panel principal), aparte de los
 * avisos automáticos. Va por correo al titular (con autorización de datos). Máximo uno cada 10 minutos
 * por mensualidad para no llenar la bandeja del cliente.
 */
async function sendMonthlyReminderNow(planId, req) {
  const { rows } = await query(
    `SELECT mp.id, mp.site_id, mp.plate, mp.client_name, mp.email, mp.data_consent, mp.end_date::text AS end_text,
            (mp.end_date - CURRENT_DATE) AS days_left, s.name AS site_name, s.phone, s.address
       FROM monthly_plans mp JOIN sites s ON s.id = mp.site_id
      WHERE mp.id = $1 AND mp.is_active AND mp.deleted_at IS NULL`,
    [planId],
  );
  const m = rows[0];
  if (!m) throw new HttpError(404, 'Mensualidad no encontrada', { code: 'NOT_FOUND' });
  await assertSiteAccess(req, m.site_id);
  if (!m.email) throw new HttpError(409, 'Esta mensualidad no tiene correo registrado.', { code: 'NO_EMAIL' });
  if (!m.data_consent) {
    throw new HttpError(409, 'El titular no ha autorizado el tratamiento de sus datos: no se le puede enviar el aviso.', { code: 'NO_CONSENT' });
  }
  const recent = await query(
    `SELECT 1 FROM notification_log WHERE kind = 'MONTHLY_MANUAL' AND entity_type = 'monthly_plan' AND entity_id = $1
        AND created_at > now() - interval '10 minutes' LIMIT 1`,
    [String(m.id)],
  );
  if (recent.rows[0]) {
    throw new HttpError(429, 'Ya se le envió un aviso hace pocos minutos. Espere un momento antes de enviar otro.', { code: 'RECENTLY_SENT' });
  }
  const msg = buildReminder(m, Number(m.days_left), await renewUrl(m.id));
  const ok = await sendOnce({
    kind: 'MONTHLY_MANUAL', siteId: m.site_id, entityType: 'monthly_plan', entityId: m.id, to: m.email,
    dedupeKey: `MONTHLY_MANUAL:${m.id}:${Date.now()}`, subject: msg.subject, text: msg.text, html: msg.html,
  });
  await recordAudit({
    req, userId: req.user.id, siteId: m.site_id, action: 'MONTHLY_REMINDER_MANUAL', entityType: 'monthly_plan', entityId: m.id,
    details: { sent: ok, to: maskEmail(m.email) },
  });
  if (!ok) throw new HttpError(502, 'No se pudo enviar el correo. Revise la configuración del correo e intente de nuevo.', { code: 'MAIL_FAILED' });
  return { sent: true, to: maskEmail(m.email) };
}

// Hora actual (0-23) en la zona de la app (America/Bogota), sin importar la zona del servidor
// (Render y la mayoría de servidores están en UTC).
function localHour(now = new Date()) {
  const h = new Intl.DateTimeFormat('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone: env.timezone }).format(now);
  return Number(h) % 24;
}

/**
 * Revisa los avisos al arrancar (a los 30 s) y luego cada hora, pero solo envía dentro del horario
 * NOTIFY_HOUR (por defecto 8) a NOTIFY_UNTIL_HOUR (por defecto 21), hora de Colombia.
 * Pensado para servidores que se duermen (Render gratis): cada vez que despierta, se pone al día.
 * Cada aviso sale una sola vez (notification_log). Devuelve una función para detenerla.
 */
function scheduleMonthlyReminders(logger = console) {
  const num = (v, d) => (v === undefined || v === '' ? d : Number(v));
  const from = num(process.env.NOTIFY_HOUR, 8);
  const until = num(process.env.NOTIFY_UNTIL_HOUR, 21);
  if (![from, until].every((h) => Number.isInteger(h) && h >= 0 && h <= 24) || from >= until) return () => {};
  let running = false;
  const tick = async () => {
    const h = localHour();
    if (running || h < from || h >= until) return;
    running = true;
    try {
      const r = await runMonthlyReminders();
      if (r.due || r.overdue || r.sms) {
        logger.log(`Avisos de mensualidad: ${r.due} por vencer, ${r.overdue} vencidas por correo, ${r.sms ?? 0} SMS`);
      }
    } catch (err) {
      logger.error(`Avisos de mensualidad fallaron: ${err.message}`);
    } finally {
      running = false;
    }
  };
  const startup = setTimeout(tick, 30 * 1000);
  const hourly = setInterval(tick, 60 * 60 * 1000);
  startup.unref?.();
  hourly.unref?.();
  return () => {
    clearTimeout(startup);
    clearInterval(hourly);
  };
}

module.exports = {
  sendMonthlyReminderNow, sendPaymentReceipt, sendMonthlyPaymentReceipt, sendPortalCode, runMonthlyReminders,
  scheduleMonthlyReminders, sendOnce, dueThreshold, localHour,
};
