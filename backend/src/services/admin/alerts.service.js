// Alertas configurables del panel (RF32), en tiempo real, con atender / descartar.
//   ZONE_WITHOUT_SHIFT  zona con horario programado ahora y sin turno abierto pasados N minutos
//   OCCUPANCY_HIGH      ocupación de la sede por encima del %
//   CASH_DIFFERENCE     diferencia de arqueo (faltante o sobrante) mayor que el monto, al cerrar o
//                       entregar un turno
//   SITE_OFFLINE        sede con turnos abiertos y nadie conectado durante más de N minutos
// La configuración es por sede (sites.alert_config); lo que no se configure usa DEFAULTS.
// Una alerta no se repite mientras siga abierta; las de ocupación esperan además una hora después de
// atendidas, y las demás son por ocurrencia (la misma zona y horario del día, la misma caja, el mismo
// episodio sin conexión) y no se repiten.
const { query, withTransaction } = require('../../db/pool');
const HttpError = require('../../middlewares/httpError');
const { assertSiteAccess } = require('../../middlewares/authorize');
const { recordAudit } = require('../audit.service');
const { publish } = require('../../realtime/bus');
const presence = require('../../realtime/presence');
const { schedulesActiveAt } = require('./schedules.service');
const { sitesInScope } = require('./scope');

const DEFAULTS = {
  zoneWithoutShift: { enabled: true, graceMinutes: 15 },
  occupancy: { enabled: true, threshold: 90 },
  cashDifference: { enabled: true, threshold: 20000 },
  siteOffline: { enabled: true, minutes: 10 },
};
const OCCUPANCY_COOLDOWN_MIN = 60;

const TYPE_LABELS = {
  ZONE_WITHOUT_SHIFT: 'Zona sin turno',
  OCCUPANCY_HIGH: 'Ocupación alta',
  CASH_DIFFERENCE: 'Diferencia de arqueo',
  SITE_OFFLINE: 'Sede sin conexión',
};

function mergeConfig(stored) {
  const cfg = {};
  for (const [k, def] of Object.entries(DEFAULTS)) cfg[k] = { ...def, ...(stored?.[k] ?? {}) };
  return cfg;
}

async function configFor(siteId) {
  const { rows } = await query('SELECT alert_config FROM sites WHERE id = $1', [siteId]);
  return mergeConfig(rows[0]?.alert_config);
}

// ---------------------------------------------------------------------------
// Configuración
// ---------------------------------------------------------------------------

async function getSettings(req, rawSiteId) {
  const siteId = Number.parseInt(rawSiteId, 10);
  if (!Number.isInteger(siteId)) throw new HttpError(400, 'Indique la sede', { code: 'VALIDATION_ERROR' });
  await assertSiteAccess(req, siteId);
  return { siteId, config: await configFor(siteId), defaults: DEFAULTS };
}

function validateConfig(body) {
  const details = {};
  const out = {};
  const num = (v, min, max, key) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < min || n > max || !Number.isInteger(n)) {
      details[key] = `Debe ser un número entero entre ${min} y ${max}`;
      return undefined;
    }
    return n;
  };
  const limits = {
    zoneWithoutShift: ['graceMinutes', 0, 240],
    occupancy: ['threshold', 1, 100],
    cashDifference: ['threshold', 0, 10000000],
    siteOffline: ['minutes', 1, 1440],
  };
  for (const [k, [field, min, max]] of Object.entries(limits)) {
    const input = body?.[k];
    if (input === undefined) continue;
    out[k] = {};
    if (input.enabled !== undefined) {
      if (typeof input.enabled !== 'boolean') details[`${k}.enabled`] = 'Debe ser verdadero o falso';
      out[k].enabled = input.enabled;
    }
    if (input[field] !== undefined) {
      const v = num(input[field], min, max, `${k}.${field}`);
      if (v !== undefined) out[k][field] = v;
    }
  }
  if (Object.keys(details).length) throw new HttpError(400, 'Revise la configuración de alertas', { code: 'VALIDATION_ERROR', details });
  return out;
}

async function updateSettings(req, rawSiteId, body) {
  const siteId = Number.parseInt(rawSiteId, 10);
  if (!Number.isInteger(siteId)) throw new HttpError(400, 'Indique la sede', { code: 'VALIDATION_ERROR' });
  await assertSiteAccess(req, siteId);
  const changes = validateConfig(body);
  await withTransaction(async (client) => {
    const { rows } = await client.query('SELECT alert_config FROM sites WHERE id = $1 FOR UPDATE', [siteId]);
    const current = rows[0]?.alert_config ?? {};
    const next = { ...current };
    for (const [k, v] of Object.entries(changes)) next[k] = { ...(current[k] ?? {}), ...v };
    await client.query('UPDATE sites SET alert_config = $2 WHERE id = $1', [siteId, next]);
    await recordAudit({ req, userId: req.user.id, siteId, action: 'ALERT_SETTINGS_UPDATED', entityType: 'site', entityId: siteId, details: changes }, client);
  });
  return getSettings(req, siteId);
}

// ---------------------------------------------------------------------------
// Generación
// ---------------------------------------------------------------------------

/**
 * Crea la alerta si no hay una abierta con la misma clave y (si aplica) ya pasó el tiempo de espera.
 * cooldownMinutes = null → la clave no se repite nunca (alerta por ocurrencia).
 * Devuelve la alerta creada o null.
 */
async function raise({ siteId, zoneId = null, type, severity = 'WARNING', message, details = {}, key, cooldownMinutes = null }) {
  const { rows: last } = await query(
    'SELECT status, resolved_at FROM alerts WHERE site_id = $1 AND dedupe_key = $2 ORDER BY created_at DESC LIMIT 1',
    [siteId, key],
  );
  if (last[0]) {
    if (last[0].status === 'OPEN') return null;
    if (cooldownMinutes === null) return null;
    if (Date.now() - new Date(last[0].resolved_at).getTime() < cooldownMinutes * 60000) return null;
  }
  const { rows } = await query(
    `INSERT INTO alerts (site_id, zone_id, type, severity, message, details, dedupe_key)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (site_id, dedupe_key) WHERE status = 'OPEN' DO NOTHING
     RETURNING *`,
    [siteId, zoneId, type, severity, message, details, key],
  );
  if (!rows[0]) return null;
  await recordAudit({ siteId, action: 'ALERT_RAISED', entityType: 'alert', entityId: rows[0].id, details: { type, key, ...details } });
  publish(siteId, 'alert:created', { alertId: rows[0].id, type, message });
  return rows[0];
}

const offlineSince = new Map(); // siteId → Date en que se vio sin conexión por primera vez

// '19:05' → '7:05 p. m.'
function hm12(hm) {
  const [h, m] = hm.split(':').map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'a. m.' : 'p. m.'}`;
}

// Fecha local (Colombia) de un instante
const localDate = (d) => new Date(d.getTime() - 5 * 3600000).toISOString().slice(0, 10);

/** Revisa las alertas por tiempo (zona sin turno, ocupación, sede sin conexión) de unas sedes. */
async function evaluate(siteIds, now = new Date()) {
  if (!siteIds.length) return [];
  const created = [];
  const push = (a) => a && created.push(a);
  const [sites, open, inside, scheduled] = await Promise.all([
    query('SELECT id, name, capacity, alert_config FROM sites WHERE id = ANY($1) AND is_active', [siteIds]),
    query('SELECT sh.site_id, sh.zone_id, sh.user_id FROM shifts sh WHERE sh.site_id = ANY($1) AND sh.closed_at IS NULL', [siteIds]),
    query("SELECT site_id, count(*) AS n FROM entries WHERE site_id = ANY($1) AND status = 'OPEN' GROUP BY 1", [siteIds]),
    schedulesActiveAt(siteIds, now),
  ]);
  for (const site of sites.rows) {
    const cfg = mergeConfig(site.alert_config);
    const siteShifts = open.rows.filter((s) => s.site_id === site.id);

    if (cfg.zoneWithoutShift.enabled) {
      for (const s of scheduled.filter((x) => x.siteId === site.id)) {
        if (s.minutesSinceStart < cfg.zoneWithoutShift.graceMinutes) continue;
        if (siteShifts.some((sh) => sh.zone_id === s.zone.id)) continue;
        const startedAt = new Date(now.getTime() - s.minutesSinceStart * 60000);
        push(await raise({
          siteId: site.id,
          zoneId: s.zone.id,
          type: 'ZONE_WITHOUT_SHIFT',
          severity: 'DANGER',
          message: `${s.zone.name}: sin turno abierto. Le corresponde a ${s.user.fullName} desde las ${hm12(s.startTime)}`,
          details: { scheduleId: s.id, userId: s.user.id, startTime: s.startTime, minutesLate: s.minutesSinceStart },
          key: `ZONE_WITHOUT_SHIFT:${s.zone.id}:${s.id}:${localDate(startedAt)}`,
        }));
      }
    }

    if (cfg.occupancy.enabled && site.capacity) {
      const n = inside.rows.find((r) => r.site_id === site.id)?.n ?? 0;
      const pct = Math.round((n / site.capacity) * 100);
      if (pct > cfg.occupancy.threshold) {
        push(await raise({
          siteId: site.id,
          type: 'OCCUPANCY_HIGH',
          message: `Ocupación del ${pct}% (${n} de ${site.capacity}); el límite configurado es ${cfg.occupancy.threshold}%`,
          details: { inside: n, capacity: site.capacity, occupancy: pct, threshold: cfg.occupancy.threshold },
          key: 'OCCUPANCY_HIGH',
          cooldownMinutes: OCCUPANCY_COOLDOWN_MIN,
        }));
      }
    }

    // Sin conexión: hay turnos abiertos y ninguno de sus responsables está conectado
    const offline = siteShifts.length > 0 && !siteShifts.some((sh) => presence.isConnected(sh.user_id));
    if (!offline) offlineSince.delete(site.id);
    else {
      if (!offlineSince.has(site.id)) offlineSince.set(site.id, now);
      const since = offlineSince.get(site.id);
      const minutes = Math.floor((now - since) / 60000);
      if (cfg.siteOffline.enabled && minutes >= cfg.siteOffline.minutes) {
        push(await raise({
          siteId: site.id,
          type: 'SITE_OFFLINE',
          severity: 'DANGER',
          message: `${site.name}: sin conexión desde hace ${minutes} min (hay turnos abiertos)`,
          details: { since, minutes },
          key: `SITE_OFFLINE:${since.toISOString()}`,
        }));
      }
    }
  }
  return created;
}

/** Al cerrar o entregar un turno: diferencia de arqueo mayor que el monto configurado. */
async function onShiftClosed(siteId, shiftId, difference) {
  if (!difference) return null;
  const cfg = await configFor(siteId);
  if (!cfg.cashDifference.enabled || Math.abs(difference) <= cfg.cashDifference.threshold) return null;
  const { rows } = await query(
    `SELECT sh.zone_id, z.name AS zone, u.full_name FROM shifts sh JOIN zones z ON z.id = sh.zone_id JOIN users u ON u.id = sh.user_id WHERE sh.id = $1`,
    [shiftId],
  );
  const s = rows[0];
  const word = difference < 0 ? 'Faltante' : 'Sobrante';
  const amount = `$ ${Math.abs(difference).toLocaleString('es-CO').replace(/,/g, '.')}`;
  return raise({
    siteId,
    zoneId: s?.zone_id ?? null,
    type: 'CASH_DIFFERENCE',
    severity: difference < 0 ? 'DANGER' : 'WARNING',
    message: `${word} de ${amount} al cerrar el turno de ${s?.full_name ?? '—'} (${s?.zone ?? '—'})`,
    details: { shiftId, difference, threshold: cfg.cashDifference.threshold },
    key: `CASH_DIFFERENCE:${shiftId}`,
  });
}

// ---------------------------------------------------------------------------
// Consulta y atención
// ---------------------------------------------------------------------------

function toDto(r) {
  return {
    id: r.id,
    site: { id: r.site_id, name: r.site_name },
    zone: r.zone_id ? { id: r.zone_id, name: r.zone_name } : null,
    type: r.type,
    typeLabel: TYPE_LABELS[r.type],
    severity: r.severity,
    message: r.message,
    details: r.details,
    status: r.status,
    createdAt: r.created_at,
    resolution: r.resolved_at ? { at: r.resolved_at, by: r.resolved_by_name, note: r.resolution_note } : null,
  };
}

const SELECT = `
  SELECT a.*, s.name AS site_name, z.name AS zone_name, u.full_name AS resolved_by_name
    FROM alerts a JOIN sites s ON s.id = a.site_id
    LEFT JOIN zones z ON z.id = a.zone_id
    LEFT JOIN users u ON u.id = a.resolved_by`;

async function listAlerts(req, filters = {}) {
  const sites = await sitesInScope(req, filters.siteId);
  const closed = filters.status === 'closed';
  const { rows } = await query(
    `${SELECT} WHERE a.site_id = ANY($1) AND ${closed ? "a.status <> 'OPEN'" : "a.status = 'OPEN'"}
      ORDER BY ${closed ? 'a.resolved_at' : 'a.created_at'} DESC LIMIT 100`,
    [sites.map((s) => s.id)],
  );
  return rows.map(toDto);
}

async function resolveAlert(req, rawId, action, body) {
  const id = Number.parseInt(rawId, 10);
  const note = typeof body?.note === 'string' ? body.note.trim().slice(0, 300) : '';
  if (action === 'dismiss' && note.length < 3) {
    throw new HttpError(400, 'Escriba por qué descarta la alerta', { code: 'NOTE_REQUIRED' });
  }
  const status = action === 'attend' ? 'ATTENDED' : 'DISMISSED';
  const siteId = await withTransaction(async (client) => {
    const { rows } = await client.query('SELECT * FROM alerts WHERE id = $1 FOR UPDATE', [id]);
    const a = rows[0];
    if (!a) throw new HttpError(404, 'Alerta no encontrada', { code: 'NOT_FOUND' });
    await assertSiteAccess(req, a.site_id);
    if (a.status !== 'OPEN') throw new HttpError(409, 'La alerta ya fue atendida o descartada', { code: 'ALREADY_RESOLVED' });
    await client.query(
      'UPDATE alerts SET status = $2, resolved_at = now(), resolved_by = $3, resolution_note = $4 WHERE id = $1',
      [id, status, req.user.id, note || null],
    );
    await recordAudit(
      { req, userId: req.user.id, siteId: a.site_id, action: status === 'ATTENDED' ? 'ALERT_ATTENDED' : 'ALERT_DISMISSED', entityType: 'alert', entityId: id, details: { type: a.type, note } },
      client,
    );
    return a.site_id;
  });
  publish(siteId, 'alert:updated', { alertId: id, status });
  const { rows } = await query(`${SELECT} WHERE a.id = $1`, [id]);
  return toDto(rows[0]);
}

// Revisión periódica de todas las sedes activas (la arranca realtime/index.js)
async function evaluateAll(now = new Date()) {
  const { rows } = await query('SELECT id FROM sites WHERE is_active');
  return evaluate(rows.map((r) => r.id), now);
}

// Solo para pruebas
function resetState() {
  offlineSince.clear();
}

module.exports = {
  DEFAULTS,
  getSettings,
  updateSettings,
  evaluate,
  evaluateAll,
  onShiftClosed,
  listAlerts,
  resolveAlert,
  resetState,
};
