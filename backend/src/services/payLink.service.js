// Enlaces de pago personales para los avisos de mensualidad (ver migración portal_pay_links).
// Token corto (22 caracteres, 128 bits aleatorios) para que quepa en un SMS. Solo se guarda su hash.
const crypto = require('crypto');
const { query } = require('../db/pool');

const TTL_DAYS = () => Number.parseInt(process.env.PAY_LINK_DAYS, 10) || 30;
const hash = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

/** Crea un enlace nuevo para la mensualidad y devuelve el token en claro (única vez que se ve). */
async function createPayLink(planId) {
  const token = crypto.randomBytes(16).toString('base64url');
  await query('DELETE FROM portal_pay_links WHERE expires_at < now() - interval \'7 days\''); // limpieza
  await query(
    `INSERT INTO portal_pay_links (monthly_plan_id, token_hash, expires_at)
     VALUES ($1, $2, now() + make_interval(days => $3))`,
    [planId, hash(token), TTL_DAYS()],
  );
  return token;
}

/** Id de la mensualidad a la que pertenece un token vigente, o null. */
async function resolvePayLink(token) {
  if (!/^[A-Za-z0-9_-]{22}$/.test(String(token ?? ''))) return null;
  const { rows } = await query(
    'SELECT monthly_plan_id FROM portal_pay_links WHERE token_hash = $1 AND expires_at > now()',
    [hash(token)],
  );
  return rows[0] ? Number(rows[0].monthly_plan_id) : null;
}

module.exports = { createPayLink, resolvePayLink };
