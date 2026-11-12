// Horarios programados (RF30): a quién le toca cada zona de cada sede, por día de la semana.
//   - La asignación de personas a sedes sigue en Usuarios (user_sites); aquí se programa la zona y
//     el horario (1 = lunes ... 7 = domingo). Un horario que termina antes de empezar cruza la
//     medianoche (19:00 → 07:00).
//   - Lo gestionan el AG y el AS de la sede. La persona debe estar activa y asignada a la sede.
//   - Una persona no puede tener dos horarios que se crucen el mismo día.
//   - No se borran: se desactivan (queda el historial y la auditoría).
const { query, withTransaction } = require('../../db/pool');
const HttpError = require('../../middlewares/httpError');
const { assertSiteAccess } = require('../../middlewares/authorize');
const { recordAudit } = require('../audit.service');
const { publish } = require('../../realtime/bus');

const WEEKDAYS = { 1: 'Lunes', 2: 'Martes', 3: 'Miércoles', 4: 'Jueves', 5: 'Viernes', 6: 'Sábado', 7: 'Domingo' };
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

const SELECT = `
  SELECT ss.*, u.full_name, u.username, u.role, z.name AS zone_name, s.name AS site_name,
         to_char(ss.start_time, 'HH24:MI') AS start_hm, to_char(ss.end_time, 'HH24:MI') AS end_hm
    FROM staff_schedules ss
    JOIN users u ON u.id = ss.user_id
    JOIN zones z ON z.id = ss.zone_id
    JOIN sites s ON s.id = ss.site_id`;

function toDto(r) {
  return {
    id: r.id,
    siteId: r.site_id,
    site: r.site_name,
    zone: { id: r.zone_id, name: r.zone_name },
    user: { id: r.user_id, fullName: r.full_name, username: r.username, role: r.role },
    weekday: r.weekday,
    weekdayLabel: WEEKDAYS[r.weekday],
    startTime: r.start_hm,
    endTime: r.end_hm,
    overnight: r.end_hm <= r.start_hm,
    isActive: r.is_active,
    notes: r.notes,
  };
}

const toMin = (hm) => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5));

// Minutos de la semana [inicio, fin) que ocupa un horario (los nocturnos pasan al día siguiente)
function weekIntervals({ weekday, startTime, endTime }) {
  const start = (weekday - 1) * 1440 + toMin(startTime);
  let end = (weekday - 1) * 1440 + toMin(endTime);
  if (end <= start) end += 1440;
  const week = 7 * 1440;
  // Domingo noche → lunes: se parte en dos tramos para comparar dentro de la semana
  return end > week ? [[start, week], [0, end - week]] : [[start, end]];
}

function overlaps(a, b) {
  return weekIntervals(a).some(([s1, e1]) => weekIntervals(b).some(([s2, e2]) => s1 < e2 && s2 < e1));
}

function validate(body, { partial = false } = {}) {
  const out = {};
  const details = {};
  const req = (k) => !partial || body[k] !== undefined;
  if (req('userId')) {
    out.userId = Number.parseInt(body.userId, 10);
    if (!Number.isInteger(out.userId)) details.userId = 'Elija la persona';
  }
  if (req('zoneId')) {
    out.zoneId = Number.parseInt(body.zoneId, 10);
    if (!Number.isInteger(out.zoneId)) details.zoneId = 'Elija la zona';
  }
  if (req('weekday')) {
    out.weekday = Number(body.weekday);
    if (!WEEKDAYS[out.weekday]) details.weekday = 'Día inválido (1 = lunes ... 7 = domingo)';
  }
  for (const k of ['startTime', 'endTime']) {
    if (req(k)) {
      out[k] = String(body[k] ?? '').slice(0, 5);
      if (!TIME_RE.test(out[k])) details[k] = 'Hora inválida (HH:MM)';
    }
  }
  if (out.startTime && out.endTime && out.startTime === out.endTime) details.endTime = 'La hora final debe ser distinta de la inicial';
  if (body.isActive !== undefined) {
    if (typeof body.isActive !== 'boolean') details.isActive = 'Debe ser verdadero o falso';
    out.isActive = body.isActive;
  }
  if (body.notes !== undefined) out.notes = String(body.notes ?? '').trim().slice(0, 200) || null;
  if (Object.keys(details).length) throw new HttpError(400, 'Revise el horario', { code: 'VALIDATION_ERROR', details });
  return out;
}

async function assertPersonAndZone(client, siteId, userId, zoneId) {
  const { rows: u } = await client.query(
    `SELECT u.role, u.is_active, EXISTS (SELECT 1 FROM user_sites WHERE user_id = u.id AND site_id = $2) AS assigned
       FROM users u WHERE u.id = $1`,
    [userId, siteId],
  );
  if (!u[0] || !u[0].is_active) throw new HttpError(400, 'La persona no existe o está desactivada', { code: 'VALIDATION_ERROR', details: { userId: 'Persona inválida' } });
  if (u[0].role !== 'AG' && !u[0].assigned) {
    throw new HttpError(409, 'La persona no está asignada a esta sede. Asígnela en Usuarios primero.', { code: 'USER_NOT_IN_SITE' });
  }
  const { rows: z } = await client.query('SELECT is_active FROM zones WHERE id = $1 AND site_id = $2', [zoneId, siteId]);
  if (!z[0]) throw new HttpError(400, 'La zona no es de esta sede', { code: 'VALIDATION_ERROR', details: { zoneId: 'Zona inválida' } });
  if (!z[0].is_active) throw new HttpError(409, 'La zona está desactivada', { code: 'ZONE_INACTIVE' });
}

async function assertNoOverlap(client, candidate, exceptId = null) {
  const { rows } = await client.query(
    `${SELECT} WHERE ss.user_id = $1 AND ss.is_active AND ($2::bigint IS NULL OR ss.id <> $2)`,
    [candidate.userId, exceptId],
  );
  const clash = rows.map(toDto).find((s) => overlaps(candidate, s));
  if (clash) {
    throw new HttpError(
      409,
      `Se cruza con otro horario de ${clash.user.fullName}: ${clash.weekdayLabel} ${clash.startTime}–${clash.endTime} (${clash.site} · ${clash.zone.name})`,
      { code: 'SCHEDULE_OVERLAP', details: { scheduleId: clash.id } },
    );
  }
}

async function listSchedules(req, filters) {
  const siteId = Number.parseInt(filters.siteId, 10);
  if (!Number.isInteger(siteId)) throw new HttpError(400, 'Indique la sede', { code: 'VALIDATION_ERROR' });
  await assertSiteAccess(req, siteId);
  const { rows } = await query(
    `${SELECT} WHERE ss.site_id = $1 AND ($2 OR ss.is_active) ORDER BY ss.weekday, ss.start_time, z.name`,
    [siteId, filters.includeInactive === '1'],
  );
  return rows.map(toDto);
}

async function createSchedule(req, body) {
  const siteId = Number.parseInt(body?.siteId, 10);
  if (!Number.isInteger(siteId)) throw new HttpError(400, 'Indique la sede', { code: 'VALIDATION_ERROR' });
  await assertSiteAccess(req, siteId);
  const data = validate(body ?? {});
  const id = await withTransaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`schedule-user-${data.userId}`]);
    await assertPersonAndZone(client, siteId, data.userId, data.zoneId);
    await assertNoOverlap(client, data);
    const { rows } = await client.query(
      `INSERT INTO staff_schedules (user_id, site_id, zone_id, weekday, start_time, end_time, notes, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [data.userId, siteId, data.zoneId, data.weekday, data.startTime, data.endTime, data.notes ?? null, req.user.id],
    );
    await recordAudit({ req, userId: req.user.id, siteId, action: 'SCHEDULE_CREATED', entityType: 'staff_schedule', entityId: rows[0].id, details: data }, client);
    return rows[0].id;
  });
  publish(siteId, 'schedule:changed', { scheduleId: id });
  const { rows } = await query(`${SELECT} WHERE ss.id = $1`, [id]);
  return toDto(rows[0]);
}

async function updateSchedule(req, rawId, body) {
  const id = Number.parseInt(rawId, 10);
  const data = validate(body ?? {}, { partial: true });
  const siteId = await withTransaction(async (client) => {
    const { rows } = await client.query(`${SELECT} WHERE ss.id = $1 FOR UPDATE OF ss`, [id]);
    if (!rows[0]) throw new HttpError(404, 'Horario no encontrado', { code: 'NOT_FOUND' });
    const current = toDto(rows[0]);
    await assertSiteAccess(req, current.siteId);
    const next = {
      userId: data.userId ?? current.user.id,
      zoneId: data.zoneId ?? current.zone.id,
      weekday: data.weekday ?? current.weekday,
      startTime: data.startTime ?? current.startTime,
      endTime: data.endTime ?? current.endTime,
      isActive: data.isActive ?? current.isActive,
      notes: data.notes !== undefined ? data.notes : current.notes,
    };
    if (next.startTime === next.endTime) throw new HttpError(400, 'La hora final debe ser distinta de la inicial', { code: 'VALIDATION_ERROR' });
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`schedule-user-${next.userId}`]);
    if (next.isActive) {
      await assertPersonAndZone(client, current.siteId, next.userId, next.zoneId);
      await assertNoOverlap(client, next, id);
    }
    await client.query(
      `UPDATE staff_schedules SET user_id = $2, zone_id = $3, weekday = $4, start_time = $5, end_time = $6, is_active = $7, notes = $8
        WHERE id = $1`,
      [id, next.userId, next.zoneId, next.weekday, next.startTime, next.endTime, next.isActive, next.notes],
    );
    await recordAudit(
      {
        req,
        userId: req.user.id,
        siteId: current.siteId,
        action: next.isActive ? 'SCHEDULE_UPDATED' : 'SCHEDULE_DEACTIVATED',
        entityType: 'staff_schedule',
        entityId: id,
        details: { before: current, after: next },
      },
      client,
    );
    return current.siteId;
  });
  publish(siteId, 'schedule:changed', { scheduleId: id });
  const { rows } = await query(`${SELECT} WHERE ss.id = $1`, [id]);
  return toDto(rows[0]);
}

/**
 * Horarios activos que cubren el instante `at` en la sede (o en todas las indicadas).
 * Usa la hora de Colombia. Sirve para "quién debería estar" y la alerta de zona sin turno.
 */
async function schedulesActiveAt(siteIds, at = new Date()) {
  const local = new Date(at.getTime() - 5 * 3600 * 1000);
  const weekday = ((local.getUTCDay() + 6) % 7) + 1; // 1 = lunes
  const minute = local.getUTCHours() * 60 + local.getUTCMinutes();
  const { rows } = await query(`${SELECT} WHERE ss.site_id = ANY($1) AND ss.is_active AND z.is_active`, [siteIds]);
  const nowWeek = (weekday - 1) * 1440 + minute;
  return rows
    .map(toDto)
    .map((s) => {
      const hit = weekIntervals(s).find(([a, b]) => nowWeek >= a && nowWeek < b);
      return hit ? { ...s, minutesSinceStart: nowWeek - hit[0] + (hit[0] === 0 && s.overnight && s.weekday === 7 ? 1440 - toMin(s.startTime) : 0) } : null;
    })
    .filter(Boolean);
}

module.exports = { listSchedules, createSchedule, updateSchedule, schedulesActiveAt, overlaps, weekIntervals, WEEKDAYS };
