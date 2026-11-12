// Puestos (RF50, RF51): asignación al registrar una entrada, bloqueo/liberación con motivo, mover un
// vehículo de puesto y reserva de un puesto para un titular de mensualidad. Todo queda en auditoría.
//
// Reglas de asignación (si la zona del turno tiene plano publicado; si no, la entrada sigue sin puesto):
//   - Tipo: carro → puesto de carro (o de movilidad reducida si el operador lo elige); moto → moto;
//     cicla → cicla. La sugerencia nunca propone uno de movilidad reducida.
//   - Uso: "solo mensualidad" únicamente para placas con mensualidad; "por hora" y "mixto" para todos.
//   - Un puesto reservado para un titular solo lo ocupa ese titular (y se le sugiere primero).
//   - Bloqueado o ya ocupado → no se asigna. Dos entradas nunca quedan en el mismo puesto (índice
//     único parcial + bloqueo de fila; la sugerencia salta los puestos que otra caja está tomando).
//   - Sugerencia: primero los que NO piden llaves, del más cercano a la entrada al más lejano; los que
//     piden llaves (islas que bloquean puestos de pared) solo cuando no quedan otros del tipo.
//   - Puesto que pide llaves: la entrada guarda si se recibieron (keys_received) y quién las recibió.
const { query, withTransaction } = require('../db/pool');
const HttpError = require('../middlewares/httpError');
const { assertSiteAccess, canAccessSite } = require('../middlewares/authorize');
const { normalizePlate, detectVehicleType, plateError, VEHICLE_LABELS } = require('../lib/plates');
const { recordAudit } = require('./audit.service');
const { publish } = require('../realtime/bus');

const { SPACE_TYPE_FOR_VEHICLE: SUGGESTED_TYPES } = require('../lib/maplayout');

const SPACE_LABELS = { CAR: 'carro', MOTORCYCLE: 'moto', BICYCLE: 'cicla', MOTORCYCLE_BICYCLE: 'moto y cicla', REDUCED_MOBILITY: 'movilidad reducida' };
// Tipos de puesto que puede ocupar cada vehículo (movilidad reducida: un carro, si el operador lo elige)
const ALLOWED_TYPES = {
  CAR: ['CAR', 'REDUCED_MOBILITY'],
  MOTORCYCLE: ['MOTORCYCLE', 'MOTORCYCLE_BICYCLE'],
  BICYCLE: ['BICYCLE', 'MOTORCYCLE_BICYCLE'],
};

const OCCUPIED = "EXISTS (SELECT 1 FROM entries e WHERE e.space_id = ps.id AND e.status = 'OPEN')";

// Mensualidades vivas de la placa en la sede (para reservas y puestos "solo mensualidad")
async function monthlyPlanIds(client, siteId, plate) {
  const { rows } = await client.query(
    `SELECT id FROM monthly_plans
      WHERE site_id = $1 AND plate = $2 AND deleted_at IS NULL AND is_active
        AND GREATEST(end_date, COALESCE(next_period_end, end_date)) + 3 >= CURRENT_DATE`,
    [siteId, plate],
  );
  return rows.map((r) => Number(r.id));
}

function spaceError(code, space, extra = '') {
  const messages = {
    SPACE_INACTIVE: `El puesto ${space.code} ya no está en el plano publicado`,
    SPACE_BLOCKED: `El puesto ${space.code} está bloqueado${space.blocked_reason ? `: ${space.blocked_reason}` : ''}`,
    SPACE_TYPE_MISMATCH: `El puesto ${space.code} es de ${SPACE_LABELS[space.space_type]}${extra}`,
    SPACE_RESERVED: `El puesto ${space.code} está reservado para un titular de mensualidad`,
    SPACE_MONTHLY_ONLY: `El puesto ${space.code} es solo para mensualidades`,
    SPACE_TAKEN: `El puesto ${space.code} ya está ocupado`,
    SPACE_OTHER_ZONE: `El puesto ${space.code} no es de la zona del turno`,
  };
  return new HttpError(409, messages[code], { code, details: { spaceId: Number(space.id), spaceCode: space.code } });
}

/**
 * ¿El vehículo puede ocupar este puesto? Devuelve el código de error o null.
 * `space` trae además `occupied` (boolean).
 */
function whyNotAssignable(space, { vehicleType, planIds = [], ignoreEntryId = null }) {
  if (!space.is_active) return 'SPACE_INACTIVE';
  if (space.blocked_at) return 'SPACE_BLOCKED';
  if (!(ALLOWED_TYPES[vehicleType] ?? []).includes(space.space_type)) return 'SPACE_TYPE_MISMATCH';
  if (space.reserved_plan_id && !planIds.includes(Number(space.reserved_plan_id))) return 'SPACE_RESERVED';
  if (space.usage === 'MONTHLY' && !planIds.length) return 'SPACE_MONTHLY_ONLY';
  if (space.occupied && Number(space.occupied_by) !== Number(ignoreEntryId)) return 'SPACE_TAKEN';
  return null;
}

async function lockSpace(client, spaceId) {
  const { rows } = await client.query(
    `SELECT ps.*, (SELECT e.id FROM entries e WHERE e.space_id = ps.id AND e.status = 'OPEN' LIMIT 1) AS occupied_by
       FROM parking_spaces ps WHERE ps.id = $1 FOR UPDATE OF ps`,
    [spaceId],
  );
  const s = rows[0];
  if (s) s.occupied = s.occupied_by != null;
  return s ?? null;
}

async function zoneHasMap(client, zoneId) {
  const { rows } = await client.query('SELECT 1 FROM parking_spaces WHERE zone_id = $1 AND is_active LIMIT 1', [zoneId]);
  return rows.length > 0;
}

/**
 * Mejor puesto libre para el vehículo en la zona (o null). Con `lock`, bloquea la fila y salta las
 * que otra transacción está tomando (SKIP LOCKED): dos entradas simultáneas reciben puestos distintos.
 */
async function bestSpace(client, zoneId, { vehicleType, planIds, lock = false }) {
  const { rows } = await client.query(
    `SELECT ps.id, ps.code, ps.space_type, ps.usage, ps.entrance_distance, ps.reserved_plan_id, ps.requires_keys
       FROM parking_spaces ps
      WHERE ps.zone_id = $1 AND ps.is_active AND ps.blocked_at IS NULL
        AND (
          (ps.reserved_plan_id IS NOT NULL AND ps.reserved_plan_id = ANY($3::bigint[]))
          OR (ps.reserved_plan_id IS NULL AND ps.space_type = ANY($2::text[])
              AND (ps.usage <> 'MONTHLY' OR cardinality($3::bigint[]) > 0))
        )
        AND NOT ${OCCUPIED}
      ORDER BY (ps.reserved_plan_id IS NOT NULL) DESC, ps.requires_keys, ps.entrance_distance NULLS LAST, length(ps.code), ps.code
      LIMIT 1
      ${lock ? 'FOR UPDATE OF ps SKIP LOCKED' : ''}`,
    [zoneId, SUGGESTED_TYPES[vehicleType] ?? [], planIds],
  );
  return rows[0] ?? null;
}

/**
 * Puesto para una entrada nueva, dentro de su transacción. Devuelve { id, code, requiresKeys } o null.
 *   requestedSpaceId: el que eligió el operador (se valida y si no sirve → 409, salvo `lenient`)
 *   sin elegir: el sugerido. Sin plano en la zona → null (la entrada sigue sin puesto).
 */
async function assignForEntry(client, { siteId, zoneId, plate, vehicleType, requestedSpaceId = null, lenient = false }) {
  if (!zoneId || !(await zoneHasMap(client, zoneId))) return null;
  const planIds = await monthlyPlanIds(client, siteId, plate);
  if (requestedSpaceId) {
    const space = await lockSpace(client, requestedSpaceId);
    if (!space || space.site_id !== siteId) {
      if (!lenient) throw new HttpError(404, 'Puesto no encontrado', { code: 'NOT_FOUND' });
    } else if (space.zone_id !== zoneId) {
      if (!lenient) throw spaceError('SPACE_OTHER_ZONE', space);
    } else {
      const why = whyNotAssignable(space, { vehicleType, planIds });
      if (!why) return { id: Number(space.id), code: space.code, requiresKeys: space.requires_keys };
      if (!lenient) throw spaceError(why, space, ` y el vehículo es ${VEHICLE_LABELS[vehicleType].toLowerCase()}`);
    }
  }
  const best = await bestSpace(client, zoneId, { vehicleType, planIds, lock: true });
  return best ? { id: Number(best.id), code: best.code, requiresKeys: best.requires_keys } : null;
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

// Zona en la que opera la persona: la de su turno abierto en la sede, o la indicada (AS/AG)
async function zoneFor(req, siteId, rawZoneId) {
  if (rawZoneId) {
    const { rows } = await query('SELECT id FROM zones WHERE id = $1 AND site_id = $2', [Number(rawZoneId), siteId]);
    if (!rows[0]) throw new HttpError(404, 'Zona no encontrada', { code: 'NOT_FOUND' });
    return rows[0].id;
  }
  const { rows } = await query('SELECT zone_id FROM shifts WHERE user_id = $1 AND site_id = $2 AND closed_at IS NULL', [req.user.id, siteId]);
  return rows[0]?.zone_id ?? null;
}

// Puesto sugerido para una placa (lo muestra la pantalla de Entradas antes de registrar)
async function suggest(req, filters) {
  const siteId = Number.parseInt(filters.siteId, 10);
  if (!Number.isInteger(siteId)) throw new HttpError(400, 'Indique la sede', { code: 'VALIDATION_ERROR' });
  await assertSiteAccess(req, siteId);
  const plate = normalizePlate(filters.plate);
  const err = plateError(plate);
  if (err) throw new HttpError(400, err, { code: 'INVALID_PLATE' });
  const zoneId = await zoneFor(req, siteId, filters.zoneId);
  if (!zoneId) return { hasMap: false, suggested: null };
  const client = { query: (t, p) => query(t, p) };
  if (!(await zoneHasMap(client, zoneId))) return { hasMap: false, suggested: null };
  const vehicleType = filters.vehicleType ?? detectVehicleType(plate);
  const planIds = await monthlyPlanIds(client, siteId, plate);
  const best = await bestSpace(client, zoneId, { vehicleType, planIds });
  return {
    hasMap: true,
    zoneId,
    vehicleType,
    suggested: best
      ? { id: Number(best.id), code: best.code, reserved: best.reserved_plan_id != null, requiresKeys: best.requires_keys, entranceDistance: best.entrance_distance }
      : null,
  };
}

async function loadSpaceForChange(client, req, rawId) {
  const id = Number.parseInt(rawId, 10);
  if (!Number.isInteger(id)) throw new HttpError(404, 'Puesto no encontrado', { code: 'NOT_FOUND' });
  const space = await lockSpace(client, id);
  if (!space) throw new HttpError(404, 'Puesto no encontrado', { code: 'NOT_FOUND' });
  await assertSiteAccess(req, space.site_id);
  return space;
}

function parseReason(body, min = 3) {
  const reason = typeof body?.reason === 'string' ? body.reason.trim().slice(0, 200) : '';
  if (reason.length < min) throw new HttpError(400, 'Escriba el motivo', { code: 'REASON_REQUIRED' });
  return reason;
}

async function blockSpace(req, rawId, body) {
  const reason = parseReason(body);
  const space = await withTransaction(async (client) => {
    const s = await loadSpaceForChange(client, req, rawId);
    if (!s.is_active) throw spaceError('SPACE_INACTIVE', s);
    if (s.blocked_at) throw new HttpError(409, `El puesto ${s.code} ya está bloqueado`, { code: 'ALREADY_BLOCKED' });
    if (s.occupied) throw new HttpError(409, `El puesto ${s.code} está ocupado: mueva el vehículo antes de bloquearlo`, { code: 'SPACE_TAKEN' });
    await client.query('UPDATE parking_spaces SET blocked_at = now(), blocked_by = $2, blocked_reason = $3 WHERE id = $1', [s.id, req.user.id, reason]);
    await recordAudit({ req, userId: req.user.id, siteId: s.site_id, action: 'SPACE_BLOCKED', entityType: 'parking_space', entityId: s.id, details: { code: s.code, reason } }, client);
    return s;
  });
  publish(space.site_id, 'space:changed', { spaceId: Number(space.id), zoneId: space.zone_id, action: 'blocked' });
  return { id: Number(space.id), code: space.code, blocked: true, reason };
}

async function unblockSpace(req, rawId, body) {
  const reason = parseReason(body);
  const space = await withTransaction(async (client) => {
    const s = await loadSpaceForChange(client, req, rawId);
    if (!s.blocked_at) throw new HttpError(409, `El puesto ${s.code} no está bloqueado`, { code: 'NOT_BLOCKED' });
    await client.query('UPDATE parking_spaces SET blocked_at = NULL, blocked_by = NULL, blocked_reason = NULL WHERE id = $1', [s.id]);
    await recordAudit(
      { req, userId: req.user.id, siteId: s.site_id, action: 'SPACE_UNBLOCKED', entityType: 'parking_space', entityId: s.id, details: { code: s.code, reason, previousReason: s.blocked_reason } },
      client,
    );
    return s;
  });
  publish(space.site_id, 'space:changed', { spaceId: Number(space.id), zoneId: space.zone_id, action: 'unblocked' });
  return { id: Number(space.id), code: space.code, blocked: false };
}

// Reserva un puesto para el titular de una mensualidad de la misma sede (o la quita con null)
async function reserveSpace(req, rawId, body) {
  const planId = body?.monthlyPlanId == null || body.monthlyPlanId === '' ? null : Number.parseInt(body.monthlyPlanId, 10);
  const result = await withTransaction(async (client) => {
    const s = await loadSpaceForChange(client, req, rawId);
    if (planId) {
      const { rows } = await client.query(
        'SELECT id, site_id, plate, vehicle_type FROM monthly_plans WHERE id = $1 AND deleted_at IS NULL',
        [planId],
      );
      const p = rows[0];
      if (!p || p.site_id !== s.site_id) throw new HttpError(400, 'La mensualidad no es de esta sede', { code: 'VALIDATION_ERROR' });
      if (!(ALLOWED_TYPES[p.vehicle_type] ?? []).includes(s.space_type)) {
        throw spaceError('SPACE_TYPE_MISMATCH', s, ` y la mensualidad es de ${VEHICLE_LABELS[p.vehicle_type].toLowerCase()}`);
      }
      if (s.usage === 'HOURLY') throw new HttpError(409, `El puesto ${s.code} es solo por hora`, { code: 'SPACE_HOURLY_ONLY' });
      const { rows: other } = await client.query('SELECT code FROM parking_spaces WHERE reserved_plan_id = $1 AND id <> $2', [planId, s.id]);
      if (other[0]) throw new HttpError(409, `Esa mensualidad ya tiene reservado el puesto ${other[0].code}`, { code: 'PLAN_ALREADY_RESERVED' });
      if (s.occupied) {
        const { rows: occ } = await client.query('SELECT plate FROM entries WHERE id = $1', [s.occupied_by]);
        if (occ[0]?.plate !== p.plate) throw new HttpError(409, `El puesto ${s.code} está ocupado por otro vehículo`, { code: 'SPACE_TAKEN' });
      }
    }
    await client.query('UPDATE parking_spaces SET reserved_plan_id = $2 WHERE id = $1', [s.id, planId]);
    await recordAudit(
      { req, userId: req.user.id, siteId: s.site_id, action: planId ? 'SPACE_RESERVED' : 'SPACE_RESERVATION_REMOVED', entityType: 'parking_space', entityId: s.id, details: { code: s.code, monthlyPlanId: planId, previous: s.reserved_plan_id } },
      client,
    );
    return s;
  });
  publish(result.site_id, 'space:changed', { spaceId: Number(result.id), zoneId: result.zone_id, action: 'reservation' });
  return { id: Number(result.id), code: result.code, reservedPlanId: planId };
}

// Mover un vehículo (entrada abierta) a otro puesto de su zona
async function moveEntry(req, rawEntryId, body) {
  const entryId = Number.parseInt(rawEntryId, 10);
  const spaceId = Number.parseInt(body?.spaceId, 10);
  if (!Number.isInteger(spaceId)) throw new HttpError(400, 'Elija el puesto de destino', { code: 'VALIDATION_ERROR' });
  const reason = parseReason(body);
  const out = await withTransaction(async (client) => {
    const { rows } = await client.query('SELECT * FROM entries WHERE id = $1 FOR UPDATE', [entryId]);
    const e = rows[0];
    if (!e) throw new HttpError(404, 'Entrada no encontrada', { code: 'NOT_FOUND' });
    await assertSiteAccess(req, e.site_id);
    if (e.status !== 'OPEN') throw new HttpError(409, 'El vehículo ya salió', { code: 'ENTRY_NOT_OPEN' });
    const target = await lockSpace(client, spaceId);
    if (!target || target.site_id !== e.site_id) throw new HttpError(404, 'Puesto no encontrado', { code: 'NOT_FOUND' });
    if (Number(target.id) === Number(e.space_id)) throw new HttpError(400, 'El vehículo ya está en ese puesto', { code: 'VALIDATION_ERROR' });
    const planIds = await monthlyPlanIds(client, e.site_id, e.plate);
    const why = whyNotAssignable(target, { vehicleType: e.vehicle_type, planIds });
    if (why) throw spaceError(why, target, ` y el vehículo es ${VEHICLE_LABELS[e.vehicle_type].toLowerCase()}`);
    const { rows: prev } = e.space_id ? await client.query('SELECT code FROM parking_spaces WHERE id = $1', [e.space_id]) : { rows: [] };
    const keys = keysFields(target.requires_keys, body?.keysReceived, req.user.id, e);
    try {
      await client.query(
        'UPDATE entries SET space_id = $2, keys_received = $3, keys_received_by = $4, keys_received_at = $5 WHERE id = $1',
        [entryId, target.id, keys.received, keys.by, keys.at],
      );
    } catch (err) {
      if (err.constraint === 'entries_one_open_per_space') throw spaceError('SPACE_TAKEN', target);
      throw err;
    }
    await recordAudit(
      {
        req,
        userId: req.user.id,
        siteId: e.site_id,
        action: 'ENTRY_SPACE_MOVED',
        entityType: 'entry',
        entityId: entryId,
        details: { plate: e.plate, from: prev[0]?.code ?? null, to: target.code, reason },
      },
      client,
    );
    return { siteId: e.site_id, zoneId: target.zone_id, plate: e.plate, from: prev[0]?.code ?? null, to: target.code, requiresKeys: target.requires_keys, keysReceived: keys.received };
  });
  publish(out.siteId, 'space:changed', { entryId, zoneId: out.zoneId, action: 'moved', to: out.to });
  return { entryId, plate: out.plate, from: out.from, to: out.to, requiresKeys: out.requiresKeys, keysReceived: out.keysReceived };
}

/**
 * Campos de llaves de una entrada según el puesto: si no pide llaves → NULL (salvo que ya las tuviera
 * recibidas); si pide, si se recibieron (true/false) y quién.
 */
function keysFields(requiresKeys, keysReceived, userId, previous = null) {
  if (!requiresKeys) {
    if (previous?.keys_received) return { received: true, by: previous.keys_received_by, at: previous.keys_received_at };
    return { received: null, by: null, at: null };
  }
  if (keysReceived === true) return { received: true, by: userId, at: new Date() };
  if (previous?.keys_received && keysReceived !== false) return { received: true, by: previous.keys_received_by, at: previous.keys_received_at };
  return { received: false, by: null, at: null };
}

// Registrar (o corregir) si se recibieron las llaves de un vehículo
async function recordKeys(req, rawEntryId, body) {
  const entryId = Number.parseInt(rawEntryId, 10);
  if (typeof body?.received !== 'boolean') throw new HttpError(400, 'Indique si se recibieron las llaves', { code: 'VALIDATION_ERROR' });
  const out = await withTransaction(async (client) => {
    const { rows } = await client.query(
      'SELECT e.*, ps.requires_keys, ps.code AS space_code FROM entries e LEFT JOIN parking_spaces ps ON ps.id = e.space_id WHERE e.id = $1 FOR UPDATE OF e',
      [entryId],
    );
    const e = rows[0];
    if (!e) throw new HttpError(404, 'Entrada no encontrada', { code: 'NOT_FOUND' });
    await assertSiteAccess(req, e.site_id);
    if (e.status !== 'OPEN') throw new HttpError(409, 'El vehículo ya salió', { code: 'ENTRY_NOT_OPEN' });
    if (!e.requires_keys) throw new HttpError(409, 'El puesto de este vehículo no pide llaves', { code: 'KEYS_NOT_REQUIRED' });
    const keys = keysFields(true, body.received, req.user.id);
    await client.query('UPDATE entries SET keys_received = $2, keys_received_by = $3, keys_received_at = $4 WHERE id = $1', [entryId, keys.received, keys.by, keys.at]);
    await recordAudit(
      { req, userId: req.user.id, siteId: e.site_id, action: 'ENTRY_KEYS_RECORDED', entityType: 'entry', entityId: entryId, details: { plate: e.plate, space: e.space_code, received: body.received } },
      client,
    );
    return { siteId: e.site_id, zoneId: e.zone_id, plate: e.plate };
  });
  publish(out.siteId, 'space:changed', { entryId, zoneId: out.zoneId, action: 'keys' });
  return { entryId, plate: out.plate, keysReceived: body.received };
}

module.exports = {
  keysFields,
  recordKeys,
  assignForEntry,
  suggest,
  blockSpace,
  unblockSpace,
  reserveSpace,
  moveEntry,
  whyNotAssignable,
  ALLOWED_TYPES,
  SPACE_LABELS,
  canAccessSite,
};
