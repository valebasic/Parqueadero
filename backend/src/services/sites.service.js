// Sedes y zonas (RF26, RF27).
//   - Sedes: el AG las crea y edita (dirección, municipio, horario, capacidad por tipo de vehículo,
//     responsable AS). Nunca se borran: se activan o desactivan.
//   - Zonas: el AG y el AS de la sede (capacidad y tipos de vehículo admitidos). Tampoco se borran.
//   - No se desactiva una sede ni una zona con un turno abierto.
const { query, withTransaction } = require('../db/pool');
const HttpError = require('../middlewares/httpError');
const { assertSiteAccess } = require('../middlewares/authorize');
const { recordAudit } = require('./audit.service');
const { publish } = require('../realtime/bus');

const VEHICLE_TYPES = ['CAR', 'MOTORCYCLE', 'BICYCLE'];
const CAPACITY_COLUMNS = { CAR: 'capacity_car', MOTORCYCLE: 'capacity_motorcycle', BICYCLE: 'capacity_bicycle' };

const SITE_SELECT = `
  SELECT s.*, mu.full_name AS manager_name, mu.username AS manager_username,
         COALESCE(
           json_agg(
             json_build_object(
               'id', z.id, 'name', z.name, 'description', z.description,
               'capacity', z.capacity, 'isActive', z.is_active, 'vehicleTypes', z.vehicle_types
             ) ORDER BY z.name
           ) FILTER (WHERE z.id IS NOT NULL),
           '[]'
         ) AS zones
    FROM sites s
    LEFT JOIN users mu ON mu.id = s.manager_user_id
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
    businessHours: r.business_hours,
    capacity: r.capacity,
    capacityByType: { CAR: r.capacity_car, MOTORCYCLE: r.capacity_motorcycle, BICYCLE: r.capacity_bicycle },
    manager: r.manager_user_id ? { id: r.manager_user_id, fullName: r.manager_name, username: r.manager_username } : null,
    receiptPrefix: r.receipt_prefix,
    monthlyReceiptPrefix: r.monthly_receipt_prefix,
    isActive: r.is_active,
    zones: r.zones,
  };
}

// Sedes con sus zonas que el usuario puede ver: el AG todas; AS y OP solo las asignadas.
// Por defecto solo las activas; `includeInactive` (pantalla de Sedes) también las desactivadas.
async function listSitesWithZones(user, { includeInactive = false } = {}) {
  const allSites = user.role === 'AG';
  const { rows } = await query(
    `${SITE_SELECT}
      WHERE ($1 OR s.id = ANY($2::int[])) AND ($3 OR s.is_active)
      GROUP BY s.id, mu.id
      ORDER BY s.name`,
    [allSites, user.siteIds, includeInactive],
  );
  return rows.map(toDto);
}

// Una sede (el acceso por sede lo valida antes requireSiteParam)
async function getSiteWithZones(siteId) {
  const { rows } = await query(`${SITE_SELECT} WHERE s.id = $1 GROUP BY s.id, mu.id`, [siteId]);
  if (!rows[0]) throw new HttpError(404, 'Sede no encontrada', { code: 'NOT_FOUND' });
  return toDto(rows[0]);
}

// ---------------------------------------------------------------------------
// Validación
// ---------------------------------------------------------------------------

function invalid(details, message = 'Revise los datos de la sede') {
  return new HttpError(400, message, { code: 'VALIDATION_ERROR', details });
}

const text = (v, max = 200) => {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
};

function parseCapacity(v, field, details) {
  if (v === null || v === '' || v === undefined) return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 100000) {
    details[field] = 'Debe ser un número entero mayor o igual a 0';
    return undefined;
  }
  return n;
}

function validateSite(body, { creating }) {
  const out = {};
  const details = {};
  if (creating || body.code !== undefined) {
    const code = String(body.code ?? '').trim().toUpperCase();
    if (!/^[A-Z0-9_]{2,20}$/.test(code)) details.code = 'Código de 2 a 20 letras, números o _ (p. ej. NORTE)';
    out.code = code;
  }
  if (creating || body.name !== undefined) {
    out.name = text(body.name, 120);
    if (!out.name) details.name = 'Escriba el nombre de la sede';
  }
  for (const [key, col, max] of [
    ['legalId', 'legal_id', 40],
    ['phone', 'phone', 60],
    ['address', 'address', 200],
    ['city', 'city', 80],
    ['businessHours', 'business_hours', 500],
  ]) {
    if (body[key] !== undefined) out[col] = text(body[key], max);
  }
  if (body.capacityByType !== undefined) {
    const caps = body.capacityByType ?? {};
    for (const type of VEHICLE_TYPES) {
      const v = parseCapacity(caps[type], `capacityByType.${type}`, details);
      if (v !== undefined) out[CAPACITY_COLUMNS[type]] = v;
    }
  }
  for (const [key, col] of [['receiptPrefix', 'receipt_prefix'], ['monthlyReceiptPrefix', 'monthly_receipt_prefix']]) {
    if (body[key] !== undefined) {
      const p = String(body[key] ?? '').trim().toUpperCase();
      if (!/^[A-Z]{1,5}$/.test(p)) details[key] = 'De 1 a 5 letras';
      out[col] = p;
    }
  }
  if (body.managerUserId !== undefined) {
    if (body.managerUserId === null || body.managerUserId === '') out.manager_user_id = null;
    else {
      const id = Number.parseInt(body.managerUserId, 10);
      if (!Number.isInteger(id)) details.managerUserId = 'Responsable inválido';
      out.manager_user_id = id;
    }
  }
  if (body.isActive !== undefined) {
    if (typeof body.isActive !== 'boolean') details.isActive = 'Debe ser verdadero o falso';
    out.is_active = body.isActive;
  }
  if (Object.keys(details).length) throw invalid(details);
  return out;
}

function validateZone(body, { creating }) {
  const out = {};
  const details = {};
  if (creating || body.name !== undefined) {
    out.name = text(body.name, 60);
    if (!out.name) details.name = 'Escriba el nombre de la zona';
  }
  if (body.description !== undefined) out.description = text(body.description, 200);
  if (body.capacity !== undefined) {
    const v = parseCapacity(body.capacity, 'capacity', details);
    if (v !== undefined) out.capacity = v;
  }
  if (creating || body.vehicleTypes !== undefined) {
    const types = Array.isArray(body.vehicleTypes) ? [...new Set(body.vehicleTypes)] : creating && body.vehicleTypes == null ? VEHICLE_TYPES : null;
    if (!types || !types.length || types.some((t) => !VEHICLE_TYPES.includes(t))) {
      details.vehicleTypes = 'Elija al menos un tipo de vehículo';
    } else out.vehicle_types = types;
  }
  if (body.isActive !== undefined) {
    if (typeof body.isActive !== 'boolean') details.isActive = 'Debe ser verdadero o falso';
    out.is_active = body.isActive;
  }
  if (Object.keys(details).length) throw invalid(details, 'Revise los datos de la zona');
  return out;
}

// Capacidad total = suma de las capacidades por tipo (si se indicó alguna)
function totalCapacity(row) {
  const parts = Object.values(CAPACITY_COLUMNS).map((c) => row[c]);
  if (parts.every((v) => v == null)) return row.capacity ?? null;
  return parts.reduce((s, v) => s + (v ?? 0), 0);
}

// El responsable debe ser un AS activo; queda asignado a la sede
async function assignManager(client, siteId, managerId) {
  if (managerId == null) return;
  const { rows } = await client.query('SELECT role, is_active FROM users WHERE id = $1', [managerId]);
  if (!rows[0] || rows[0].role !== 'AS' || !rows[0].is_active) {
    throw invalid({ managerUserId: 'El responsable debe ser un administrador de sede (AS) activo' });
  }
  await client.query('INSERT INTO user_sites (user_id, site_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [managerId, siteId]);
}

async function openShiftsIn(client, where, id) {
  const { rows } = await client.query(`SELECT count(*) AS n FROM shifts WHERE ${where} = $1 AND closed_at IS NULL`, [id]);
  return rows[0].n;
}

function uniqueError(err, field, message) {
  if (err.code === '23505') return new HttpError(409, message, { code: 'DUPLICATE', details: { [field]: message } });
  return err;
}

// ---------------------------------------------------------------------------
// Sedes (AG)
// ---------------------------------------------------------------------------

async function createSite(req, body) {
  const data = validateSite(body ?? {}, { creating: true });
  const copyFrom = body?.copyRatesFromSiteId ? Number.parseInt(body.copyRatesFromSiteId, 10) : null;
  const siteId = await withTransaction(async (client) => {
    const row = { ...data, capacity: totalCapacity(data) };
    const cols = Object.keys(row);
    let id;
    try {
      const { rows } = await client.query(
        `INSERT INTO sites (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
        cols.map((c) => row[c]),
      );
      id = rows[0].id;
    } catch (err) {
      throw uniqueError(err, 'code', `Ya existe una sede con el código ${data.code}`);
    }
    await assignManager(client, id, data.manager_user_id);
    // Zona inicial
    await client.query("INSERT INTO zones (site_id, name, description) VALUES ($1, 'Principal', 'Zona inicial')", [id]);
    // Tarifas: copia de las vigentes y futuras de otra sede (opcional)
    if (copyFrom) {
      await client.query(
        `INSERT INTO rates (site_id, vehicle_type, fraction_amount, hour_amount, full_12h_amount, monthly_amount,
                            pricing_mode, valid_from, valid_to, created_by)
         SELECT $1, vehicle_type, fraction_amount, hour_amount, full_12h_amount, monthly_amount, pricing_mode,
                GREATEST(valid_from, now()), valid_to, $3
           FROM rates WHERE site_id = $2 AND (valid_to IS NULL OR valid_to > now())`,
        [id, copyFrom, req.user.id],
      );
    }
    await recordAudit(
      { req, userId: req.user.id, siteId: id, action: 'SITE_CREATED', entityType: 'site', entityId: id, details: { ...data, copyRatesFromSiteId: copyFrom } },
      client,
    );
    return id;
  });
  return getSiteWithZones(siteId);
}

async function updateSite(req, rawId, body) {
  const siteId = Number.parseInt(rawId, 10);
  const data = validateSite(body ?? {}, { creating: false });
  if (!Object.keys(data).length) throw invalid({}, 'No hay cambios');
  await withTransaction(async (client) => {
    const { rows } = await client.query('SELECT * FROM sites WHERE id = $1 FOR UPDATE', [siteId]);
    const before = rows[0];
    if (!before) throw new HttpError(404, 'Sede no encontrada', { code: 'NOT_FOUND' });
    if (data.is_active === false && before.is_active && (await openShiftsIn(client, 'site_id', siteId)) > 0) {
      throw new HttpError(409, 'La sede tiene turnos abiertos: ciérrelos antes de desactivarla', { code: 'SITE_HAS_OPEN_SHIFTS' });
    }
    const next = { ...before, ...data };
    const row = { ...data };
    if (Object.values(CAPACITY_COLUMNS).some((c) => c in data)) row.capacity = totalCapacity(next);
    const cols = Object.keys(row);
    try {
      await client.query(
        `UPDATE sites SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')} WHERE id = $1`,
        [siteId, ...cols.map((c) => row[c])],
      );
    } catch (err) {
      throw uniqueError(err, 'code', `Ya existe una sede con el código ${data.code}`);
    }
    if ('manager_user_id' in data) await assignManager(client, siteId, data.manager_user_id);
    const changed = Object.fromEntries(cols.filter((c) => before[c] !== row[c]).map((c) => [c, { from: before[c], to: row[c] }]));
    await recordAudit(
      {
        req,
        userId: req.user.id,
        siteId,
        action: data.is_active === false && before.is_active ? 'SITE_DEACTIVATED' : data.is_active === true && !before.is_active ? 'SITE_ACTIVATED' : 'SITE_UPDATED',
        entityType: 'site',
        entityId: siteId,
        details: changed,
      },
      client,
    );
  });
  publish(siteId, 'site:changed', { siteId });
  return getSiteWithZones(siteId);
}

// ---------------------------------------------------------------------------
// Zonas (AG y AS de la sede)
// ---------------------------------------------------------------------------

async function createZone(req, rawSiteId, body) {
  const siteId = Number.parseInt(rawSiteId, 10);
  await assertSiteAccess(req, siteId);
  const data = validateZone(body ?? {}, { creating: true });
  const zoneId = await withTransaction(async (client) => {
    const cols = Object.keys(data);
    let id;
    try {
      const { rows } = await client.query(
        `INSERT INTO zones (site_id, ${cols.join(', ')}) VALUES ($1, ${cols.map((_, i) => `$${i + 2}`).join(', ')}) RETURNING id`,
        [siteId, ...cols.map((c) => data[c])],
      );
      id = rows[0].id;
    } catch (err) {
      if (err.code === '23503') throw new HttpError(404, 'Sede no encontrada', { code: 'NOT_FOUND' });
      throw uniqueError(err, 'name', `Ya existe una zona llamada ${data.name} en la sede`);
    }
    await recordAudit({ req, userId: req.user.id, siteId, action: 'ZONE_CREATED', entityType: 'zone', entityId: id, details: data }, client);
    return id;
  });
  publish(siteId, 'site:changed', { siteId, zoneId });
  return (await getSiteWithZones(siteId)).zones.find((z) => z.id === zoneId);
}

async function updateZone(req, rawSiteId, rawZoneId, body) {
  const siteId = Number.parseInt(rawSiteId, 10);
  const zoneId = Number.parseInt(rawZoneId, 10);
  await assertSiteAccess(req, siteId);
  const data = validateZone(body ?? {}, { creating: false });
  if (!Object.keys(data).length) throw invalid({}, 'No hay cambios');
  await withTransaction(async (client) => {
    const { rows } = await client.query('SELECT * FROM zones WHERE id = $1 AND site_id = $2 FOR UPDATE', [zoneId, siteId]);
    const before = rows[0];
    if (!before) throw new HttpError(404, 'Zona no encontrada', { code: 'NOT_FOUND' });
    if (data.is_active === false && before.is_active && (await openShiftsIn(client, 'zone_id', zoneId)) > 0) {
      throw new HttpError(409, 'La zona tiene un turno abierto: ciérrelo antes de desactivarla', { code: 'ZONE_HAS_OPEN_SHIFT' });
    }
    const cols = Object.keys(data);
    try {
      await client.query(`UPDATE zones SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')} WHERE id = $1`, [
        zoneId,
        ...cols.map((c) => data[c]),
      ]);
    } catch (err) {
      throw uniqueError(err, 'name', `Ya existe una zona llamada ${data.name} en la sede`);
    }
    await recordAudit(
      {
        req,
        userId: req.user.id,
        siteId,
        action: data.is_active === false ? 'ZONE_DEACTIVATED' : data.is_active === true && !before.is_active ? 'ZONE_ACTIVATED' : 'ZONE_UPDATED',
        entityType: 'zone',
        entityId: zoneId,
        details: data,
      },
      client,
    );
  });
  publish(siteId, 'site:changed', { siteId, zoneId });
  return (await getSiteWithZones(siteId)).zones.find((z) => z.id === zoneId);
}

module.exports = { listSitesWithZones, getSiteWithZones, createSite, updateSite, createZone, updateZone, VEHICLE_TYPES };
