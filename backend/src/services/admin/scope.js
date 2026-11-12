// Alcance de los reportes del panel multisede: qué sedes ve el usuario.
//   AG: todas las sedes activas · AS: solo sus sedes (activas).
// Si se pide una sede concreta (?siteId=) se valida el acceso (403 auditado si no es suya).
const { query } = require('../../db/pool');
const HttpError = require('../../middlewares/httpError');
const { assertSiteAccess } = require('../../middlewares/authorize');
const { isDate } = require('../../lib/dates');

async function sitesInScope(req, rawSiteId) {
  if (rawSiteId !== undefined && rawSiteId !== null && rawSiteId !== '' && rawSiteId !== 'all') {
    const siteId = Number.parseInt(rawSiteId, 10);
    if (!Number.isInteger(siteId) || siteId <= 0) throw new HttpError(400, 'Sede inválida', { code: 'VALIDATION_ERROR' });
    await assertSiteAccess(req, siteId);
    const { rows } = await query('SELECT id, code, name, capacity, capacity_car, capacity_motorcycle, capacity_bicycle, is_active FROM sites WHERE id = $1', [siteId]);
    if (!rows[0]) throw new HttpError(404, 'Sede no encontrada', { code: 'NOT_FOUND' });
    return rows;
  }
  const { rows } = await query(
    `SELECT id, code, name, capacity, capacity_car, capacity_motorcycle, capacity_bicycle, is_active
       FROM sites WHERE is_active AND ($1 OR id = ANY($2::int[])) ORDER BY name`,
    [req.user.role === 'AG', req.user.siteIds],
  );
  return rows;
}

// Rango de fechas obligatorio (AAAA-MM-DD); si vienen al revés se intercambian. Máximo ~1 año.
function parseRange(filters, { maxDays = 400 } = {}) {
  const from = isDate(filters.from) ? filters.from : null;
  const to = isDate(filters.to) ? filters.to : null;
  if (!from || !to) throw new HttpError(400, 'Indique el rango de fechas (desde y hasta)', { code: 'VALIDATION_ERROR' });
  const range = from <= to ? { from, to } : { from: to, to: from };
  const days = (Date.parse(range.to) - Date.parse(range.from)) / 86400000 + 1;
  if (days > maxDays) throw new HttpError(400, `El rango no puede pasar de ${maxDays} días`, { code: 'VALIDATION_ERROR' });
  return range;
}

module.exports = { sitesInScope, parseRange };
