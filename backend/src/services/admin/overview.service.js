// Tablero multisede en tiempo real (RF28): por sede y consolidado.
//   Vehículos dentro (por tipo) y ocupación %, entradas/salidas del día, ventas del día por forma de
//   pago, cobros pendientes, mensualidades por vencer y estado de conexión de cada sede:
//     ONLINE   = alguien con turno abierto en la sede tiene la app conectada ahora
//     OFFLINE  = hay turnos abiertos pero nadie conectado (probablemente operando sin conexión)
//     NO_SHIFT = no hay turnos abiertos
//   más la última sincronización de operaciones sin conexión y la última actividad vista.
// El frontend lo recarga con los eventos de tiempo real de cada sede (y cada minuto).
const { query } = require('../../db/pool');
const monthly = require('../monthly.service');
const presence = require('../../realtime/presence');
const { sitesInScope } = require('./scope');

const TYPES = ['CAR', 'MOTORCYCLE', 'BICYCLE'];
const pct = (n, cap) => (cap ? Math.round((n / cap) * 1000) / 10 : null);

function emptyBlock() {
  return {
    inside: { total: 0, byType: { CAR: 0, MOTORCYCLE: 0, BICYCLE: 0 } },
    capacity: { total: 0, byType: { CAR: 0, MOTORCYCLE: 0, BICYCLE: 0 } },
    today: { entries: 0, exits: 0 },
    sales: { total: 0, count: 0, cash: 0, electronic: 0, byMethod: { CASH: { count: 0, total: 0 }, ELECTRONIC: { count: 0, total: 0 }, MIXED: { count: 0, total: 0 } } },
    pending: { count: 0, total: 0 },
    monthly: { expiring: 0, overdue: 0 },
  };
}

async function overview(req, filters = {}) {
  const sites = await sitesInScope(req, filters.siteId);
  const ids = sites.map((s) => s.id);
  if (!ids.length) return { sites: [], consolidated: { ...emptyBlock(), occupancy: null }, generatedAt: new Date() };

  const [inside, today, sales, pending, shifts, sync, activity] = await Promise.all([
    query(
      "SELECT site_id, vehicle_type, count(*) AS n FROM entries WHERE site_id = ANY($1) AND status = 'OPEN' GROUP BY 1, 2",
      [ids],
    ),
    query(
      `SELECT site_id, count(*) FILTER (WHERE entry_at >= CURRENT_DATE) AS entries,
              count(*) FILTER (WHERE exit_at >= CURRENT_DATE AND status <> 'CANCELLED') AS exits
         FROM entries WHERE site_id = ANY($1) AND (entry_at >= CURRENT_DATE OR exit_at >= CURRENT_DATE) GROUP BY 1`,
      [ids],
    ),
    query(
      `SELECT site_id, payment_method, count(*) AS n, sum(charged_amount) AS total,
              sum(cash_amount) AS cash, sum(electronic_amount) AS electronic
         FROM entries WHERE site_id = ANY($1) AND status = 'PAID' AND paid_at >= CURRENT_DATE GROUP BY 1, 2`,
      [ids],
    ),
    query(
      'SELECT site_id, count(*) AS n, sum(amount) AS total FROM pending_charges WHERE site_id = ANY($1) AND confirmed_at IS NULL GROUP BY 1',
      [ids],
    ),
    query(
      `SELECT sh.id, sh.site_id, sh.user_id, sh.opened_at, z.name AS zone, u.full_name
         FROM shifts sh JOIN zones z ON z.id = sh.zone_id JOIN users u ON u.id = sh.user_id
        WHERE sh.site_id = ANY($1) AND sh.closed_at IS NULL ORDER BY z.name`,
      [ids],
    ),
    query('SELECT site_id, max(received_at) AS last_sync FROM offline_operations WHERE site_id = ANY($1) GROUP BY 1', [ids]),
    query(
      `SELECT sh.site_id, max(us.last_activity_at) AS last_activity
         FROM shifts sh JOIN user_sessions us ON us.user_id = sh.user_id
        WHERE sh.site_id = ANY($1) AND sh.closed_at IS NULL GROUP BY 1`,
      [ids],
    ),
  ]);

  const consolidated = emptyBlock();
  const result = [];
  for (const site of sites) {
    const b = emptyBlock();
    for (const r of inside.rows.filter((x) => x.site_id === site.id)) {
      b.inside.byType[r.vehicle_type] = r.n;
      b.inside.total += r.n;
    }
    b.capacity.byType = { CAR: site.capacity_car ?? 0, MOTORCYCLE: site.capacity_motorcycle ?? 0, BICYCLE: site.capacity_bicycle ?? 0 };
    b.capacity.total = site.capacity ?? 0;
    const t = today.rows.find((x) => x.site_id === site.id);
    if (t) b.today = { entries: t.entries, exits: t.exits };
    for (const r of sales.rows.filter((x) => x.site_id === site.id)) {
      b.sales.byMethod[r.payment_method] = { count: r.n, total: Number(r.total) };
      b.sales.total += Number(r.total);
      b.sales.count += r.n;
      b.sales.cash += Number(r.cash);
      b.sales.electronic += Number(r.electronic);
    }
    const p = pending.rows.find((x) => x.site_id === site.id);
    if (p) b.pending = { count: p.n, total: Number(p.total) };
    const alerts = await monthly.alerts(site.id);
    b.monthly = { expiring: alerts.filter((a) => a.daysToEnd >= 0).length, overdue: alerts.filter((a) => a.daysToEnd < 0).length };

    // Estado de conexión
    const open = shifts.rows.filter((x) => x.site_id === site.id).map((s) => ({
      id: s.id,
      zone: s.zone,
      user: s.full_name,
      userId: s.user_id,
      openedAt: s.opened_at,
      online: presence.isConnected(s.user_id),
    }));
    const seen = [
      activity.rows.find((x) => x.site_id === site.id)?.last_activity,
      ...open.map((s) => presence.lastSeenAt(s.userId)),
    ].filter(Boolean).map((d) => new Date(d));
    const connection = {
      status: !open.length ? 'NO_SHIFT' : open.some((s) => s.online) ? 'ONLINE' : 'OFFLINE',
      lastSync: sync.rows.find((x) => x.site_id === site.id)?.last_sync ?? null,
      lastSeen: seen.length ? new Date(Math.max(...seen.map((d) => d.getTime()))) : null,
    };

    result.push({
      site: { id: site.id, code: site.code, name: site.name },
      ...b,
      occupancy: {
        total: pct(b.inside.total, b.capacity.total),
        byType: Object.fromEntries(TYPES.map((k) => [k, pct(b.inside.byType[k], b.capacity.byType[k])])),
      },
      openShifts: open,
      connection,
    });

    // Consolidado
    consolidated.inside.total += b.inside.total;
    consolidated.capacity.total += b.capacity.total;
    for (const k of TYPES) {
      consolidated.inside.byType[k] += b.inside.byType[k];
      consolidated.capacity.byType[k] += b.capacity.byType[k];
    }
    consolidated.today.entries += b.today.entries;
    consolidated.today.exits += b.today.exits;
    for (const k of ['total', 'count', 'cash', 'electronic']) consolidated.sales[k] += b.sales[k];
    for (const m of Object.keys(b.sales.byMethod)) {
      consolidated.sales.byMethod[m].count += b.sales.byMethod[m].count;
      consolidated.sales.byMethod[m].total += b.sales.byMethod[m].total;
    }
    consolidated.pending.count += b.pending.count;
    consolidated.pending.total += b.pending.total;
    consolidated.monthly.expiring += b.monthly.expiring;
    consolidated.monthly.overdue += b.monthly.overdue;
  }

  return {
    sites: result,
    consolidated: {
      ...consolidated,
      occupancy: {
        total: pct(consolidated.inside.total, consolidated.capacity.total),
        byType: Object.fromEntries(TYPES.map((k) => [k, pct(consolidated.inside.byType[k], consolidated.capacity.byType[k])])),
      },
      connection: {
        online: result.filter((s) => s.connection.status === 'ONLINE').length,
        offline: result.filter((s) => s.connection.status === 'OFFLINE').length,
        noShift: result.filter((s) => s.connection.status === 'NO_SHIFT').length,
      },
    },
    generatedAt: new Date(),
  };
}

module.exports = { overview };
