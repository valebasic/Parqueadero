const { query } = require('../db/pool');

// Sedes con sus zonas, ordenadas por nombre.
async function listSitesWithZones() {
  const { rows } = await query(`
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
      LEFT JOIN zones z ON z.site_id = s.id
     GROUP BY s.id
     ORDER BY s.name`);

  return rows.map((r) => ({
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
  }));
}

module.exports = { listSitesWithZones };
