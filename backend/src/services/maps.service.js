// Mapa de espacios (RF47-RF49, RF52).
//   Editor (AG y AS de la sede): borrador → publicación con versión; duplicar el plano de otra zona
//   como plantilla. Al publicar, los puestos del plano pasan a parking_spaces (por código): los nuevos
//   se crean, los que siguen se actualizan y los que ya no están se desactivan. No se puede publicar
//   un plano que quite o cambie de tipo un puesto ocupado.
//   Vista en vivo (todos los roles con acceso a la sede): estado de cada puesto y su vehículo.
//   Indicadores (AG/AS): ocupación por zona y tipo, histórico por hora y mapa de calor de uso.
const { query, withTransaction } = require('../db/pool');
const HttpError = require('../middlewares/httpError');
const { assertSiteAccess } = require('../middlewares/authorize');
const { recordAudit } = require('./audit.service');
const { publish } = require('../realtime/bus');
const { validateLayout, entranceDistance } = require('../lib/maplayout');
const { isDate } = require('../lib/dates');
const { sitesInScope } = require('./admin/scope');

async function loadZone(req, rawZoneId) {
  const zoneId = Number.parseInt(rawZoneId, 10);
  if (!Number.isInteger(zoneId)) throw new HttpError(404, 'Zona no encontrada', { code: 'NOT_FOUND' });
  const { rows } = await query('SELECT z.id, z.site_id, z.name, z.is_active, s.name AS site_name FROM zones z JOIN sites s ON s.id = z.site_id WHERE z.id = $1', [zoneId]);
  if (!rows[0]) throw new HttpError(404, 'Zona no encontrada', { code: 'NOT_FOUND' });
  await assertSiteAccess(req, rows[0].site_id);
  return rows[0];
}

function mapDto(m) {
  if (!m) return null;
  return {
    id: Number(m.id),
    version: m.version,
    status: m.status,
    rows: m.rows,
    cols: m.cols,
    elements: m.elements,
    notes: m.notes,
    updatedAt: m.updated_at,
    updatedBy: m.updated_by_name ?? null,
    publishedAt: m.published_at,
    publishedBy: m.published_by_name ?? null,
  };
}

const MAP_SELECT = `
  SELECT m.*, uu.full_name AS updated_by_name, up.full_name AS published_by_name
    FROM zone_maps m
    LEFT JOIN users uu ON uu.id = m.updated_by
    LEFT JOIN users up ON up.id = m.published_by`;

async function zoneMaps(req, rawZoneId) {
  const zone = await loadZone(req, rawZoneId);
  const { rows } = await query(`${MAP_SELECT} WHERE m.zone_id = $1 ORDER BY m.version DESC`, [zone.id]);
  return {
    zone: { id: zone.id, name: zone.name, siteId: zone.site_id, site: zone.site_name },
    published: mapDto(rows.find((m) => m.status === 'PUBLISHED')),
    draft: mapDto(rows.find((m) => m.status === 'DRAFT')),
    versions: rows.map((m) => ({ version: m.version, status: m.status, publishedAt: m.published_at, publishedBy: m.published_by_name, updatedAt: m.updated_at })),
  };
}

function layoutOrThrow(body) {
  const layout = validateLayout(body ?? {});
  if (layout.errors.length) {
    throw new HttpError(400, `El plano tiene ${layout.errors.length} ${layout.errors.length === 1 ? 'problema' : 'problemas'}`, {
      code: 'MAP_INVALID',
      details: { errors: layout.errors },
    });
  }
  return layout;
}

async function nextVersion(client, zoneId) {
  const { rows } = await client.query('SELECT COALESCE(max(version), 0) + 1 AS v FROM zone_maps WHERE zone_id = $1', [zoneId]);
  return rows[0].v;
}

// Guarda (crea o reemplaza) el borrador de la zona
async function saveDraft(req, rawZoneId, body) {
  const zone = await loadZone(req, rawZoneId);
  const layout = layoutOrThrow(body);
  const notes = typeof body?.notes === 'string' ? body.notes.trim().slice(0, 300) || null : null;
  await withTransaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`zone-map-${zone.id}`]);
    const { rows } = await client.query("SELECT id, version FROM zone_maps WHERE zone_id = $1 AND status = 'DRAFT'", [zone.id]);
    let version;
    if (rows[0]) {
      version = rows[0].version;
      await client.query(
        'UPDATE zone_maps SET rows = $2, cols = $3, elements = $4, notes = $5, updated_by = $6, updated_at = now() WHERE id = $1',
        [rows[0].id, layout.rows, layout.cols, JSON.stringify(layout.elements), notes, req.user.id],
      );
    } else {
      version = await nextVersion(client, zone.id);
      await client.query(
        `INSERT INTO zone_maps (site_id, zone_id, version, status, rows, cols, elements, notes, created_by, updated_by)
         VALUES ($1, $2, $3, 'DRAFT', $4, $5, $6, $7, $8, $8)`,
        [zone.site_id, zone.id, version, layout.rows, layout.cols, JSON.stringify(layout.elements), notes, req.user.id],
      );
    }
    await recordAudit(
      { req, userId: req.user.id, siteId: zone.site_id, action: 'MAP_DRAFT_SAVED', entityType: 'zone', entityId: zone.id, details: { version, spaces: layout.elements.filter((e) => e.kind === 'SPACE').length } },
      client,
    );
  });
  return zoneMaps(req, zone.id);
}

async function discardDraft(req, rawZoneId) {
  const zone = await loadZone(req, rawZoneId);
  const { rowCount } = await query("DELETE FROM zone_maps WHERE zone_id = $1 AND status = 'DRAFT'", [zone.id]);
  if (!rowCount) throw new HttpError(404, 'La zona no tiene borrador', { code: 'NOT_FOUND' });
  await recordAudit({ req, userId: req.user.id, siteId: zone.site_id, action: 'MAP_DRAFT_DISCARDED', entityType: 'zone', entityId: zone.id });
  return zoneMaps(req, zone.id);
}

// Duplicar como plantilla: el plano (publicado, o el borrador si no hay) de otra zona pasa a borrador
async function copyFrom(req, rawZoneId, body) {
  const zone = await loadZone(req, rawZoneId);
  const source = await loadZone(req, body?.sourceZoneId);
  if (source.id === zone.id) throw new HttpError(400, 'Elija otra zona como plantilla', { code: 'VALIDATION_ERROR' });
  const { rows } = await query(
    "SELECT rows, cols, elements FROM zone_maps WHERE zone_id = $1 AND status IN ('PUBLISHED', 'DRAFT') ORDER BY (status = 'PUBLISHED') DESC LIMIT 1",
    [source.id],
  );
  if (!rows[0]) throw new HttpError(404, `La zona ${source.name} no tiene plano`, { code: 'NOT_FOUND' });
  const { rows: draft } = await query("SELECT 1 FROM zone_maps WHERE zone_id = $1 AND status = 'DRAFT'", [zone.id]);
  if (draft[0] && body?.replace !== true) {
    throw new HttpError(409, 'La zona ya tiene un borrador; confirme si quiere reemplazarlo', { code: 'DRAFT_EXISTS' });
  }
  return saveDraft(req, zone.id, { rows: rows[0].rows, cols: rows[0].cols, elements: rows[0].elements, notes: `Copia de ${source.site_name} · ${source.name}` });
}

/**
 * Publica el borrador `draft` de la zona dentro de la transacción: pasa los puestos a parking_spaces,
 * archiva la versión anterior y deja auditoría. La usan el editor y el seed (mapa de Facaparking).
 */
async function applyPublication(client, zone, draft, { userId = null, req = null } = {}) {
  {
    const layout = layoutOrThrow({ rows: draft.rows, cols: draft.cols, elements: draft.elements });
    const spaces = layout.elements.filter((e) => e.kind === 'SPACE');

    // Puestos actuales (con su ocupación) para no quitar ni cambiar uno ocupado
    const { rows: current } = await client.query(
      `SELECT ps.*, (SELECT e.plate FROM entries e WHERE e.space_id = ps.id AND e.status = 'OPEN' LIMIT 1) AS plate
         FROM parking_spaces ps WHERE ps.zone_id = $1 FOR UPDATE OF ps`,
      [zone.id],
    );
    const byCode = new Map(current.map((s) => [s.code, s]));
    const problems = [];
    for (const s of current.filter((x) => x.is_active && x.plate)) {
      const next = spaces.find((x) => x.code === s.code);
      if (!next) problems.push(`El puesto ${s.code} está ocupado (${s.plate}) y el plano nuevo lo quita`);
      else if (next.spaceType !== s.space_type) problems.push(`El puesto ${s.code} está ocupado (${s.plate}) y el plano nuevo le cambia el tipo`);
    }
    if (problems.length) {
      throw new HttpError(409, 'No se puede publicar mientras haya vehículos en puestos que cambian', { code: 'SPACE_IN_USE', details: { errors: problems } });
    }

    for (const sp of spaces) {
      const values = [sp.spaceType, sp.usage, sp.covered, sp.row, sp.col, sp.width, sp.height, entranceDistance(sp, layout.elements), draft.version, sp.requiresKeys, sp.facing];
      const existing = byCode.get(sp.code);
      if (existing) {
        await client.query(
          `UPDATE parking_spaces SET space_type = $2, usage = $3, covered = $4, row = $5, col = $6, width = $7, height = $8,
                  entrance_distance = $9, map_version = $10, requires_keys = $11, facing = $12, is_active = true,
                  reserved_plan_id = CASE WHEN $3 = 'HOURLY' THEN NULL ELSE reserved_plan_id END
            WHERE id = $1`,
          [existing.id, ...values],
        );
      } else {
        await client.query(
          `INSERT INTO parking_spaces (site_id, zone_id, code, space_type, usage, covered, row, col, width, height, entrance_distance,
                                       map_version, requires_keys, facing)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
          [zone.site_id, zone.id, sp.code, ...values],
        );
      }
    }
    const removed = current.filter((s) => s.is_active && !spaces.some((x) => x.code === s.code));
    if (removed.length) {
      await client.query(
        `UPDATE parking_spaces SET is_active = false, reserved_plan_id = NULL, blocked_at = NULL, blocked_by = NULL, blocked_reason = NULL
          WHERE id = ANY($1::bigint[])`,
        [removed.map((s) => s.id)],
      );
    }
    await client.query("UPDATE zone_maps SET status = 'ARCHIVED' WHERE zone_id = $1 AND status = 'PUBLISHED'", [zone.id]);
    await client.query("UPDATE zone_maps SET status = 'PUBLISHED', published_at = now(), published_by = $2 WHERE id = $1", [draft.id, userId]);
    await recordAudit(
      {
        req,
        userId,
        siteId: zone.site_id,
        action: 'MAP_PUBLISHED',
        entityType: 'zone',
        entityId: zone.id,
        details: { version: draft.version, spaces: spaces.length, added: spaces.filter((s) => !byCode.has(s.code)).length, removed: removed.map((s) => s.code) },
      },
      client,
    );
    return { version: draft.version };
  }
}

async function publishDraft(req, rawZoneId) {
  const zone = await loadZone(req, rawZoneId);
  const result = await withTransaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`zone-map-${zone.id}`]);
    const { rows } = await client.query("SELECT * FROM zone_maps WHERE zone_id = $1 AND status = 'DRAFT' FOR UPDATE", [zone.id]);
    const draft = rows[0];
    if (!draft) throw new HttpError(404, 'No hay borrador para publicar', { code: 'NOT_FOUND' });
    return applyPublication(client, zone, draft, { userId: req.user.id, req });
  });
  publish(zone.site_id, 'map:published', { zoneId: zone.id, version: result.version });
  return zoneMaps(req, zone.id);
}

// ---------------------------------------------------------------------------
// Vista en vivo (RF48-RF49)
// ---------------------------------------------------------------------------

async function liveZone(req, rawZoneId) {
  const zone = await loadZone(req, rawZoneId);
  const [map, spaces] = await Promise.all([
    query("SELECT * FROM zone_maps WHERE zone_id = $1 AND status = 'PUBLISHED'", [zone.id]),
    query(
      `SELECT ps.*, e.id AS entry_id, e.plate, e.entry_at, e.vehicle_type, e.receipt_prefix || e.receipt_number AS receipt, e.keys_received,
              floor(extract(epoch FROM now() - e.entry_at) / 60)::int AS minutes, now() AS server_now
         FROM parking_spaces ps
         LEFT JOIN entries e ON e.space_id = ps.id AND e.status = 'OPEN'
        WHERE ps.zone_id = $1 AND ps.is_active`,
      [zone.id],
    ),
  ]);
  const m = map.rows[0];
  const base = { zone: { id: zone.id, name: zone.name, siteId: zone.site_id, site: zone.site_name } };
  if (!m) return { ...base, published: false };
  const states = new Map(spaces.rows.map((s) => [s.code, s]));
  const counts = { total: 0, free: 0, occupied: 0, blocked: 0 };
  const elements = m.elements.map((el) => {
    if (el.kind !== 'SPACE') return el;
    const s = states.get(el.code);
    const state = !s ? 'BLOCKED' : s.blocked_at ? 'BLOCKED' : s.entry_id ? 'OCCUPIED' : 'FREE';
    counts.total += 1;
    counts[state.toLowerCase()] += 1;
    return {
      ...el,
      spaceId: s ? Number(s.id) : null,
      state,
      reserved: Boolean(s?.reserved_plan_id),
      blockedReason: s?.blocked_reason ?? null,
      entry: s?.entry_id
        ? { id: Number(s.entry_id), plate: s.plate, vehicleType: s.vehicle_type, receipt: s.receipt, entryAt: s.entry_at, minutes: s.minutes, keysReceived: s.keys_received }
        : null,
    };
  });
  return {
    ...base,
    published: true,
    version: m.version,
    rows: m.rows,
    cols: m.cols,
    elements,
    counts: { ...counts, occupancy: counts.total - counts.blocked ? Math.round((counts.occupied / (counts.total - counts.blocked)) * 1000) / 10 : null },
    serverTime: spaces.rows[0]?.server_now ?? new Date(),
  };
}

// Zonas de una sede con plano publicado (para elegir el mapa)
async function siteMaps(req, rawSiteId) {
  const siteId = Number.parseInt(rawSiteId, 10);
  if (!Number.isInteger(siteId)) throw new HttpError(400, 'Indique la sede', { code: 'VALIDATION_ERROR' });
  await assertSiteAccess(req, siteId);
  const { rows } = await query(
    `SELECT z.id, z.name, z.is_active,
            (SELECT version FROM zone_maps m WHERE m.zone_id = z.id AND m.status = 'PUBLISHED') AS published_version,
            EXISTS (SELECT 1 FROM zone_maps m WHERE m.zone_id = z.id AND m.status = 'DRAFT') AS has_draft
       FROM zones z WHERE z.site_id = $1 ORDER BY z.name`,
    [siteId],
  );
  return rows.map((z) => ({ zoneId: z.id, name: z.name, isActive: z.is_active, publishedVersion: z.published_version, hasDraft: z.has_draft }));
}

// ---------------------------------------------------------------------------
// Indicadores (RF52)
// ---------------------------------------------------------------------------

async function indicators(req, filters = {}) {
  const sites = await sitesInScope(req, filters.siteId);
  const { rows } = await query(
    `SELECT ps.site_id, ps.zone_id, z.name AS zone, s.name AS site, ps.space_type,
            count(*) AS total,
            count(*) FILTER (WHERE ps.blocked_at IS NOT NULL) AS blocked,
            count(*) FILTER (WHERE ps.blocked_at IS NULL AND EXISTS (SELECT 1 FROM entries e WHERE e.space_id = ps.id AND e.status = 'OPEN')) AS occupied,
            count(*) FILTER (WHERE ps.reserved_plan_id IS NOT NULL) AS reserved
       FROM parking_spaces ps JOIN zones z ON z.id = ps.zone_id JOIN sites s ON s.id = ps.site_id
      WHERE ps.site_id = ANY($1) AND ps.is_active
      GROUP BY 1, 2, 3, 4, 5 ORDER BY 4, 3, 5`,
    [sites.map((s) => s.id)],
  );
  const zones = new Map();
  for (const r of rows) {
    if (!zones.has(r.zone_id)) zones.set(r.zone_id, { zoneId: r.zone_id, zone: r.zone, siteId: r.site_id, site: r.site, byType: [], total: 0, occupied: 0, blocked: 0, reserved: 0 });
    const z = zones.get(r.zone_id);
    const available = r.total - r.blocked;
    z.byType.push({ spaceType: r.space_type, total: r.total, occupied: r.occupied, blocked: r.blocked, free: available - r.occupied, occupancy: available ? Math.round((r.occupied / available) * 1000) / 10 : null });
    z.total += r.total;
    z.occupied += r.occupied;
    z.blocked += r.blocked;
    z.reserved += r.reserved;
  }
  return [...zones.values()].map((z) => ({ ...z, free: z.total - z.blocked - z.occupied, occupancy: z.total - z.blocked ? Math.round((z.occupied / (z.total - z.blocked)) * 1000) / 10 : null }));
}

function parseRange(filters) {
  const today = new Date(Date.now() - 5 * 3600000).toISOString().slice(0, 10);
  const from = isDate(filters.from) ? filters.from : today;
  const to = isDate(filters.to) ? filters.to : from;
  if (from > to) throw new HttpError(400, 'La fecha inicial es posterior a la final', { code: 'VALIDATION_ERROR' });
  if ((Date.parse(to) - Date.parse(from)) / 86400000 > 92) throw new HttpError(400, 'El rango no puede pasar de 93 días', { code: 'VALIDATION_ERROR' });
  return { from, to };
}

// Histórico por hora: puestos ocupados en promedio en cada hora del día (promedio del rango)
async function hourlyHistory(req, rawZoneId, filters = {}) {
  const zone = await loadZone(req, rawZoneId);
  const range = parseRange(filters);
  const { rows } = await query(
    `WITH hours AS (
       SELECT h FROM generate_series($2::date::timestamp, ($3::date + 1)::timestamp - interval '1 hour', interval '1 hour') AS h
     )
     -- (GREATEST/LEAST ignoran los NULL: por eso el FILTER para las horas sin vehículos)
     SELECT extract(hour FROM hours.h)::int AS hour,
            COALESCE(sum(extract(epoch FROM LEAST(COALESCE(e.exit_at, now()), (hours.h + interval '1 hour')::timestamptz)
                                         - GREATEST(e.entry_at, hours.h::timestamptz)) / 60)
                       FILTER (WHERE e.id IS NOT NULL), 0) AS minutes
       FROM hours
       LEFT JOIN entries e ON e.space_id IN (SELECT id FROM parking_spaces WHERE zone_id = $1)
            AND e.status <> 'CANCELLED'
            AND e.entry_at < (hours.h + interval '1 hour')::timestamptz AND COALESCE(e.exit_at, now()) > hours.h::timestamptz
      GROUP BY 1 ORDER BY 1`,
    [zone.id, range.from, range.to],
  );
  const { rows: total } = await query('SELECT count(*) AS n FROM parking_spaces WHERE zone_id = $1 AND is_active', [zone.id]);
  const days = (Date.parse(range.to) - Date.parse(range.from)) / 86400000 + 1;
  return {
    zone: { id: zone.id, name: zone.name },
    range,
    spaces: total[0].n,
    hours: rows.map((r) => {
      const avg = Number(r.minutes) / 60 / days;
      return { hour: r.hour, occupiedMinutes: Math.round((Number(r.minutes) / days) * 10) / 10, averageOccupied: Math.round(avg * 10) / 10, occupancy: total[0].n ? Math.round((avg / total[0].n) * 1000) / 10 : null };
    }),
  };
}

// Mapa de calor: uso de cada puesto en el rango (% del tiempo ocupado y número de entradas)
async function heatmap(req, rawZoneId, filters = {}) {
  const live = await liveZone(req, rawZoneId);
  if (!live.published) return { ...live, spaces: [] };
  const range = parseRange(filters);
  const start = new Date(`${range.from}T00:00:00-05:00`);
  const end = new Date(Math.min(Date.now(), new Date(`${range.to}T00:00:00-05:00`).getTime() + 86400000));
  const minutes = Math.max(1, (end - start) / 60000);
  const { rows } = await query(
    `SELECT e.space_id, count(*) AS entries,
            sum(extract(epoch FROM LEAST(COALESCE(e.exit_at, now()), $3::timestamptz) - GREATEST(e.entry_at, $2::timestamptz)) / 60) AS minutes
       FROM entries e
      WHERE e.space_id IN (SELECT id FROM parking_spaces WHERE zone_id = $1) AND e.status <> 'CANCELLED'
        AND e.entry_at < $3::timestamptz AND COALESCE(e.exit_at, now()) > $2::timestamptz
      GROUP BY 1`,
    [live.zone.id, start, end],
  );
  const usage = new Map(rows.map((r) => [Number(r.space_id), r]));
  return {
    zone: live.zone,
    range,
    rows: live.rows,
    cols: live.cols,
    elements: live.elements.map((el) => {
      if (el.kind !== 'SPACE') return el;
      const u = usage.get(el.spaceId);
      return { ...el, entry: null, heat: { entries: u ? Number(u.entries) : 0, utilization: u ? Math.round((Number(u.minutes) / minutes) * 1000) / 10 : 0 } };
    }),
  };
}

module.exports = { applyPublication, zoneMaps, saveDraft, discardDraft, copyFrom, publishDraft, liveZone, siteMaps, indicators, hourlyHistory, heatmap };
