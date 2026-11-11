// Registro de acciones sensibles en audit_log (solo inserción).
// Nunca guardar contraseñas, hashes ni tokens en `details`.
const { query } = require('../db/pool');

function requestMeta(req) {
  if (!req) return { ipAddress: null, userAgent: null };
  return {
    ipAddress: req.ip || null,
    userAgent: (req.get && req.get('user-agent')) || null,
  };
}

/**
 * @param {object} entry
 * @param {string} entry.action           p. ej. 'LOGIN_FAILED', 'USER_CREATED'
 * @param {number|null} [entry.userId]    quién hizo la acción (null = sistema / usuario desconocido)
 * @param {number|null} [entry.siteId]
 * @param {string} [entry.entityType]     p. ej. 'user'
 * @param {string|number} [entry.entityId]
 * @param {object} [entry.details]
 * @param {import('express').Request} [entry.req]  para tomar IP y navegador
 * @param {import('pg').PoolClient} [client]       si se pasa, se registra dentro de esa transacción
 */
async function recordAudit(entry, client) {
  const { ipAddress, userAgent } = requestMeta(entry.req);
  const run = client ? client.query.bind(client) : query;
  await run(
    `INSERT INTO audit_log (user_id, site_id, action, entity_type, entity_id, ip_address, user_agent, details)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      entry.userId ?? null,
      entry.siteId ?? null,
      entry.action,
      entry.entityType ?? null,
      entry.entityId == null ? null : String(entry.entityId),
      ipAddress,
      userAgent,
      entry.details ?? {},
    ],
  );
}

module.exports = { recordAudit, requestMeta };
