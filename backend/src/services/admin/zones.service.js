// Quién está a cargo de cada zona ahora (RF31).
//   Por zona activa: el turno abierto (responsable, desde qué hora, operaciones del turno, efectivo
//   esperado en el cajón y correcciones hechas durante el turno), quién debería estar según el
//   horario programado (RF30) y el historial reciente de diferencias de arqueo.
//   Correcciones = cambios de forma de pago de ventas de la caja y movimientos editados o anulados.
const { query } = require('../../db/pool');
const HttpError = require('../../middlewares/httpError');
const { assertSiteAccess } = require('../../middlewares/authorize');
const { registerSummary } = require('../cash.service');
const { schedulesActiveAt } = require('./schedules.service');
const { sitesInScope } = require('./scope');

const HISTORY_DAYS = 30;

async function correctionsFor(cashRegisterId) {
  const { rows } = await query(
    `SELECT a.action, count(*) AS n FROM audit_log a
      WHERE (a.action = 'SALE_PAYMENT_CHANGED' AND a.entity_id IN (SELECT id::text FROM entries WHERE cash_register_id = $1))
         OR (a.action IN ('CASH_MOVEMENT_UPDATED', 'CASH_MOVEMENT_DELETED')
             AND a.entity_id IN (SELECT id::text FROM cash_movements WHERE cash_register_id = $1))
      GROUP BY a.action`,
    [cashRegisterId],
  );
  const by = Object.fromEntries(rows.map((r) => [r.action, r.n]));
  return {
    total: rows.reduce((s, r) => s + r.n, 0),
    paymentChanges: by.SALE_PAYMENT_CHANGED ?? 0,
    movementEdits: by.CASH_MOVEMENT_UPDATED ?? 0,
    movementDeletes: by.CASH_MOVEMENT_DELETED ?? 0,
  };
}

async function zonesStatus(req, filters = {}) {
  const sites = await sitesInScope(req, filters.siteId);
  const ids = sites.map((s) => s.id);
  if (!ids.length) return [];
  const [zones, open, history, scheduled] = await Promise.all([
    query('SELECT z.id, z.site_id, z.name, z.capacity FROM zones z WHERE z.site_id = ANY($1) AND z.is_active ORDER BY z.site_id, z.name', [ids]),
    query(
      `SELECT sh.id, sh.zone_id, sh.user_id, sh.opened_at, COALESCE(sh.worked_start, sh.opened_at) AS worked_start,
              u.full_name, cr.id AS cash_register_id,
              (SELECT count(*) FROM entries e WHERE e.entry_shift_id = sh.id) AS entries,
              (SELECT count(*) FROM entries e WHERE e.exit_shift_id = sh.id) AS exits,
              (SELECT count(*) FROM cash_movements m WHERE m.cash_register_id = cr.id AND m.deleted_at IS NULL) AS movements
         FROM shifts sh JOIN users u ON u.id = sh.user_id JOIN cash_registers cr ON cr.shift_id = sh.id
        WHERE sh.site_id = ANY($1) AND sh.closed_at IS NULL`,
      [ids],
    ),
    query(
      `SELECT sh.zone_id, count(*) AS shifts,
              count(*) FILTER (WHERE cr.difference <> 0) AS with_difference,
              COALESCE(sum(-cr.difference) FILTER (WHERE cr.difference < 0), 0) AS shortage,
              COALESCE(sum(cr.difference) FILTER (WHERE cr.difference > 0), 0) AS surplus
         FROM shifts sh JOIN cash_registers cr ON cr.shift_id = sh.id
        WHERE sh.site_id = ANY($1) AND sh.closed_at >= now() - make_interval(days => ${HISTORY_DAYS})
        GROUP BY sh.zone_id`,
      [ids],
    ),
    schedulesActiveAt(ids),
  ]);

  const out = [];
  for (const z of zones.rows) {
    const shift = open.rows.find((s) => s.zone_id === z.id);
    let current = null;
    if (shift) {
      const summary = await registerSummary({ query: (t, p) => query(t, p) }, shift.cash_register_id);
      current = {
        shiftId: shift.id,
        user: { id: shift.user_id, fullName: shift.full_name },
        since: shift.worked_start,
        operations: {
          entries: shift.entries,
          exits: shift.exits,
          sales: summary.salesCount,
          salesTotal: summary.totalSales,
          movements: shift.movements,
        },
        expectedInDrawer: summary.expectedInDrawer,
        expectedCash: summary.expectedCash,
        corrections: await correctionsFor(shift.cash_register_id),
      };
    }
    const h = history.rows.find((x) => x.zone_id === z.id);
    const due = scheduled.filter((s) => s.zone.id === z.id);
    out.push({
      zone: { id: z.id, name: z.name, capacity: z.capacity },
      site: sites.find((s) => s.id === z.site_id) ? { id: z.site_id, name: sites.find((s) => s.id === z.site_id).name } : null,
      current,
      scheduledNow: due.map((s) => ({ user: s.user, startTime: s.startTime, endTime: s.endTime })),
      // Le toca a alguien según el horario y la zona no tiene turno
      uncovered: !current && due.length > 0,
      history: {
        days: HISTORY_DAYS,
        shifts: h?.shifts ?? 0,
        withDifference: h?.with_difference ?? 0,
        shortage: Number(h?.shortage ?? 0),
        surplus: Number(h?.surplus ?? 0),
      },
    });
  }
  return out;
}

// Historial de turnos de una zona (diferencias y ajustes)
async function zoneHistory(req, rawZoneId, filters = {}) {
  const zoneId = Number.parseInt(rawZoneId, 10);
  const { rows: z } = await query('SELECT id, site_id, name FROM zones WHERE id = $1', [zoneId]);
  if (!z[0]) throw new HttpError(404, 'Zona no encontrada', { code: 'NOT_FOUND' });
  await assertSiteAccess(req, z[0].site_id);
  const limit = Math.min(100, Math.max(1, Number.parseInt(filters.limit, 10) || 20));
  const { rows } = await query(
    `SELECT sh.id, sh.opened_at, sh.closed_at, sh.close_type, COALESCE(sh.worked_start, sh.opened_at) AS worked_start,
            COALESCE(sh.worked_end, sh.closed_at) AS worked_end, u.full_name, cr.id AS cash_register_id,
            cr.physical_cash, cr.difference, COALESCE((cr.summary->>'expectedInDrawer')::int, cr.expected_cash) AS expected,
            (SELECT count(*) FROM shift_adjustments a WHERE a.shift_id = sh.id) AS adjustments
       FROM shifts sh JOIN users u ON u.id = sh.user_id JOIN cash_registers cr ON cr.shift_id = sh.id
      WHERE sh.zone_id = $1 AND sh.closed_at IS NOT NULL
      ORDER BY sh.closed_at DESC LIMIT ${limit}`,
    [zoneId],
  );
  const items = [];
  for (const r of rows) {
    items.push({
      shiftId: r.id,
      user: r.full_name,
      workedStart: r.worked_start,
      workedEnd: r.worked_end,
      closeType: r.close_type,
      expected: r.expected,
      counted: r.physical_cash,
      difference: r.difference,
      adjustments: r.adjustments,
      corrections: (await correctionsFor(r.cash_register_id)).total,
    });
  }
  return { zone: { id: z[0].id, name: z[0].name }, items };
}

module.exports = { zonesStatus, zoneHistory };
