const { query } = require('../db/pool');
const HttpError = require('../middlewares/httpError');

const SITE_SELECT = `
  SELECT s.id, s.code, s.name, s.legal_id, s.phone, s.address, s.city, s.capacity,
         s.receipt_prefix, s.monthly_receipt_prefix, s.is_active,
         COALESCE(
           json_agg(
             json_build_object(
               'id', z.id, 'name', z.name, 'description', z.description,
               'capacity', z.capacity, 'isActive', z.is_active
             ) ORDER BY z.name
           ) FILTER (WHERE z.id IS NOT NULL),
           '[]'
         ) AS zones
    FROM sites s
    LEFT JOIN zones z ON z.site_id = s.id`;

function toDto(r) {
  return {
    id: r.id,
    code: r.code,
    name: r.name,
    legalId: r.legal_id,
    phone: r.phone,
    address: r.address,
    city: r.city,
    capacity: r.capacity,
    receiptPrefix: r.receipt_prefix,
    monthlyReceiptPrefix: r.monthly_receipt_prefix,
    isActive: r.is_active,
    zones: r.zones,
  };
}

// Sedes con sus zonas que el usuario puede ver: el AG todas; AS y OP solo las asignadas.
async function listSitesWithZones(user) {
  const allSites = user.role === 'AG';
  const { rows } = await query(
    `${SITE_SELECT}
      WHERE $1 OR s.id = ANY($2::int[])
      GROUP BY s.id
      ORDER BY s.name`,
    [allSites, user.siteIds],
  );
  return rows.map(toDto);
}

// Una sede (el acceso por sede lo valida antes requireSiteParam)
async function getSiteWithZones(siteId) {
  const { rows } = await query(`${SITE_SELECT} WHERE s.id = $1 GROUP BY s.id`, [siteId]);
  if (!rows[0]) throw new HttpError(404, 'Sede no encontrada', { code: 'NOT_FOUND' });
  return toDto(rows[0]);
}

module.exports = { listSitesWithZones, getSiteWithZones };
