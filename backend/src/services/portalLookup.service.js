// Portal del cliente — pantalla 3: consulta por placa (sin QR).
//   (a) "Tengo mi tiquete": placa + número de recibo → lleva a la pantalla 1.
//   (b) "Tengo mensualidad": código de 6 dígitos al correo registrado → vista de su mensualidad.
//
// PRIVACIDAD Y ANTI-ADIVINACIÓN
//   - Nunca se revela si una placa existe o tiene mensualidad: las respuestas son siempre iguales.
//   - Códigos de 6 dígitos guardados solo como HMAC, vencen en 10 minutos, máximo 5 intentos, un solo uso.
//   - La sesión del portal es un token propio (audiencia distinta): no sirve en la API de empleados.
//   - Solo se muestran datos del titular que acaba de verificar su correo.
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { query } = require('../db/pool');
const env = require('../config/env');
const { security } = require('../config/security');
const HttpError = require('../middlewares/httpError');
const { normalizePlate, plateError, VEHICLE_LABELS } = require('../lib/plates');
const { sendPortalCode } = require('./notification.service');
const mail = require('./mail.service');
const sms = require('./sms.service');
const { parseReceipt } = require('./portal.service');
const { payInfo } = require('./portalMonthly.service');
const { config: wompiConfig } = require('./wompi.service');

const CODE_TTL_MIN = 10;
const MAX_ATTEMPTS = 5;
const RESEND_SECONDS = 60;
const MAX_CODES_PER_HOUR = 5;
const SESSION_TTL_SECONDS = 30 * 60;
const AUDIENCE = 'nexo-portal';

const GENERIC_SENT = 'Si la placa tiene una mensualidad con ese medio de contacto registrado, le enviamos un código de 6 dígitos. Vence en 10 minutos.';
const BAD_CODE = () => new HttpError(400, 'El código es incorrecto o ya venció. Pida uno nuevo.', { code: 'INVALID_CODE' });

const hashCode = (planId, code) =>
  crypto.createHmac('sha256', security.jwtSecret).update(`portal-code:${planId}:${code}`).digest('hex');

function badPlate(raw) {
  const plate = normalizePlate(raw);
  const err = plateError(plate);
  if (err) throw new HttpError(400, err, { code: 'INVALID_PLATE' });
  return plate;
}

// ---------------------------------------------------------------------------
// (a) Tiquete: placa + recibo
// ---------------------------------------------------------------------------
async function findByTicket(rawPlate, rawReceipt) {
  const plate = badPlate(rawPlate);
  const receipt = parseReceipt(rawReceipt);
  const notFound = () => new HttpError(404, 'No encontramos un tiquete con esa placa y ese recibo. Revise los datos.', { code: 'NOT_FOUND' });
  if (!receipt) throw notFound();
  const { rows } = await query(
    `SELECT s.code AS site_code, e.receipt_prefix, e.receipt_number
       FROM entries e JOIN sites s ON s.id = e.site_id
      WHERE e.plate = $1 AND e.receipt_prefix = $2 AND e.receipt_number = $3
      ORDER BY e.entry_at DESC LIMIT 1`,
    [plate, receipt.prefix, receipt.number],
  );
  if (!rows[0]) throw notFound();
  return { sede: rows[0].site_code, recibo: `${rows[0].receipt_prefix}${rows[0].receipt_number}` };
}

// ---------------------------------------------------------------------------
// (b) Mensualidad: código por correo
// ---------------------------------------------------------------------------
async function findPlanForPlate(plate) {
  const { rows } = await query(
    `SELECT id, email, phones, client_name FROM monthly_plans
      WHERE plate = $1 AND is_active AND deleted_at IS NULL AND data_consent
        AND (email IS NOT NULL OR array_to_string(phones, ',') ~ '(^|,)3[0-9]{9}(,|$)')
        AND payment_status <> 'PENDING_CONFIRMATION'
      ORDER BY end_date DESC, updated_at DESC LIMIT 1`,
    [plate],
  );
  return rows[0] ?? null;
}

async function requestCode(rawPlate, rawChannel) {
  const channel = String(rawChannel).toUpperCase() === 'SMS' ? 'SMS' : 'EMAIL';
  const plate = badPlate(rawPlate);
  const out = { message: GENERIC_SENT };
  const plan = await findPlanForPlate(plate);
  if (!plan) return out; // misma respuesta: no se revela nada
  const phone = (plan.phones ?? []).find(sms.isMobile);
  // Si ese plan no tiene el medio elegido, se responde igual y no se envía nada
  if (channel === 'SMS' ? !phone : !plan.email) return out;

  const { rows: recent } = await query(
    `SELECT count(*) FILTER (WHERE created_at > now() - interval '1 hour')::int AS last_hour,
            max(created_at) AS last_at
       FROM portal_codes WHERE monthly_plan_id = $1`,
    [plan.id],
  );
  const lastAt = recent[0].last_at ? new Date(recent[0].last_at).getTime() : 0;
  if (recent[0].last_hour >= MAX_CODES_PER_HOUR || Date.now() - lastAt < RESEND_SECONDS * 1000) return out;

  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  const ins = await query(
    `INSERT INTO portal_codes (monthly_plan_id, code_hash, expires_at)
     VALUES ($1, $2, now() + make_interval(mins => $3)) RETURNING id`,
    [plan.id, hashCode(plan.id, code), CODE_TTL_MIN],
  );
  await sendPortalCode({ codeId: ins.rows[0].id, planId: plan.id, email: plan.email, phone, channel, name: plan.client_name, code, ttlMin: CODE_TTL_MIN });

  // SOLO desarrollo sin correo configurado: se muestra el código en pantalla para poder probar.
  const delivery = channel === 'SMS' ? sms.settings() : mail.settings();
  if (!env.isProduction && !env.isTest && !delivery.configured) out.devCode = code;
  return out;
}

function signPortalToken(planId) {
  return jwt.sign({ pid: String(planId) }, security.jwtSecret, {
    algorithm: 'HS256',
    issuer: security.jwtIssuer,
    audience: AUDIENCE,
    expiresIn: SESSION_TTL_SECONDS,
  });
}

function verifyPortalToken(token) {
  const p = jwt.verify(token, security.jwtSecret, { algorithms: ['HS256'], issuer: security.jwtIssuer, audience: AUDIENCE });
  return { planId: Number.parseInt(p.pid, 10) };
}

async function verifyCode(rawPlate, rawCode) {
  const plate = badPlate(rawPlate);
  const code = String(rawCode ?? '').replace(/\D/g, '');
  if (code.length !== 6) throw BAD_CODE();
  const plan = await findPlanForPlate(plate);
  if (!plan) throw BAD_CODE();

  const { rows } = await query(
    `SELECT id, code_hash, attempts FROM portal_codes
      WHERE monthly_plan_id = $1 AND used_at IS NULL AND expires_at > now()
      ORDER BY created_at DESC LIMIT 1`,
    [plan.id],
  );
  const row = rows[0];
  if (!row || row.attempts >= MAX_ATTEMPTS) throw BAD_CODE();

  const a = Buffer.from(hashCode(plan.id, code));
  const b = Buffer.from(row.code_hash);
  if (!(a.length === b.length && crypto.timingSafeEqual(a, b))) {
    await query('UPDATE portal_codes SET attempts = attempts + 1 WHERE id = $1', [row.id]);
    throw BAD_CODE();
  }
  // Un solo uso: se marca antes de entregar la sesión
  const used = await query('UPDATE portal_codes SET used_at = now() WHERE id = $1 AND used_at IS NULL RETURNING id', [row.id]);
  if (!used.rows[0]) throw BAD_CODE();
  return { token: signPortalToken(plan.id), expiresInSeconds: SESSION_TTL_SECONDS };
}

// ---------------------------------------------------------------------------
// Vista de la mensualidad del titular verificado
// ---------------------------------------------------------------------------
async function getMonthlyView(planId) {
  const { rows } = await query(
    `SELECT mp.id, mp.plate, mp.vehicle_type, mp.client_name, mp.email, mp.schedule, mp.night_start, mp.night_end,
            mp.start_date::text AS start_date, mp.end_date::text AS end_date, mp.amount, mp.payment_status,
            mp.is_biweekly, mp.installment_due_date::text AS installment_due_date,
            (mp.end_date - CURRENT_DATE) AS days_left, s.name AS site_name, s.address, s.phone, s.city
       FROM monthly_plans mp JOIN sites s ON s.id = mp.site_id
      WHERE mp.id = $1 AND mp.is_active AND mp.deleted_at IS NULL`,
    [planId],
  );
  const p = rows[0];
  if (!p) throw new HttpError(404, 'No encontramos su mensualidad.', { code: 'NOT_FOUND' });

  const [{ rows: pays }, { rows: inside }] = await Promise.all([
    query(
      `SELECT receipt_prefix, receipt_number, period_start::text AS period_start, period_end::text AS period_end,
              amount, paid_at, installment_number
         FROM monthly_payments WHERE monthly_plan_id = $1 ORDER BY paid_at DESC LIMIT 12`,
      [planId],
    ),
    query(
      `SELECT e.receipt_prefix, e.receipt_number, s.code AS site_code, e.entry_at
         FROM entries e JOIN sites s ON s.id = e.site_id
        WHERE e.plate = $1 AND e.status = 'OPEN' ORDER BY e.entry_at DESC LIMIT 1`,
      [p.plate],
    ),
  ]);

  const daysLeft = Number(p.days_left);
  const status = daysLeft < 0 ? 'EXPIRED' : daysLeft <= 6 ? 'EXPIRING' : 'ACTIVE';
  return {
    business: { name: p.site_name, address: p.address, phone: p.phone, city: p.city },
    plate: p.plate,
    vehicleLabel: VEHICLE_LABELS[p.vehicle_type],
    clientName: p.client_name,
    emailMasked: mail.maskEmail(p.email),
    schedule: p.schedule,
    nightStart: p.night_start?.slice(0, 5) ?? null,
    nightEnd: p.night_end?.slice(0, 5) ?? null,
    startDate: p.start_date,
    endDate: p.end_date,
    daysLeft,
    status, // ACTIVE · EXPIRING (vence en 6 días o menos) · EXPIRED
    monthlyAmount: Number(p.amount),
    paymentStatus: p.payment_status, // PENDING · PARTIAL · PAID
    installmentDueDate: p.is_biweekly ? p.installment_due_date : null,
    payments: pays.map((x) => ({
      receipt: `${x.receipt_prefix}${x.receipt_number}`,
      periodStart: x.period_start,
      periodEnd: x.period_end,
      amount: Number(x.amount),
      paidAt: x.paid_at,
      installment: x.installment_number,
    })),
    payOnline: await payInfo(planId),
    paymentMode: wompiConfig().mode,
    currentStay: inside[0]
      ? { sede: inside[0].site_code, recibo: `${inside[0].receipt_prefix}${inside[0].receipt_number}`, entryAt: inside[0].entry_at }
      : null,
  };
}

module.exports = { findByTicket, requestCode, verifyCode, verifyPortalToken, getMonthlyView };
