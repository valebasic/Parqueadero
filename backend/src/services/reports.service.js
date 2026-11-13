// Inicio (dashboard) y Reportes (RF20-RF22).
//   Ingresos = ventas de parqueadero + ingresos manuales. Una venta cuenta el día en que se COBRÓ
//   (paid_at): un cargo pendiente confirmado cuenta el día de la confirmación (como en la v1.0).
//   El desglose efectivo/electrónico solo incluye ventas de parqueadero.
//   Los pagos de mensualidades no entran aquí: tienen su propio reporte.
const { query } = require('../db/pool');
const HttpError = require('../middlewares/httpError');
const { assertSiteAccess } = require('../middlewares/authorize');
const { isDate, diffDays } = require('../lib/dates');
const { VEHICLE_LABELS } = require('../lib/plates');
const { registerSummary } = require('./cash.service');
const monthly = require('./monthly.service');

function parseSite(value) {
  const id = Number.parseInt(value, 10);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'Indique la sede', { code: 'VALIDATION_ERROR' });
  return id;
}

function parseRange(filters) {
  const from = isDate(filters.from) ? filters.from : null;
  const to = isDate(filters.to) ? filters.to : null;
  if (!from || !to) throw new HttpError(400, 'Indique el rango de fechas (desde y hasta)', { code: 'VALIDATION_ERROR' });
  // Si Desde > Hasta se intercambian solos, como en la v1.0
  return from <= to ? { from, to } : { from: to, to: from };
}

// Agrupación de la gráfica según el rango (v1.0): un día → horas; hasta 92 días → días;
// hasta ~13 meses → semanas; más → meses.
function granularityFor({ from, to }) {
  const days = diffDays(from, to) + 1;
  if (days <= 1) return 'hour';
  if (days <= 92) return 'day';
  if (days <= 400) return 'week';
  return 'month';
}

// ---------------------------------------------------------------------------
// Inicio
// ---------------------------------------------------------------------------

async function dashboard(req, rawSiteId) {
  const siteId = parseSite(rawSiteId);
  await assertSiteAccess(req, siteId);
  const [site, inside, today, sales, shifts, pending, hourly] = await Promise.all([
    query('SELECT id, name, capacity FROM sites WHERE id = $1', [siteId]),
    query(
      `SELECT vehicle_type, count(*) AS n FROM entries WHERE site_id = $1 AND status = 'OPEN' GROUP BY vehicle_type`,
      [siteId],
    ),
    query(
      `SELECT count(*) FILTER (WHERE entry_at >= CURRENT_DATE) AS entries,
              count(*) FILTER (WHERE exit_at >= CURRENT_DATE) AS exits
         FROM entries WHERE site_id = $1 AND (entry_at >= CURRENT_DATE OR exit_at >= CURRENT_DATE)`,
      [siteId],
    ),
    query(
      `SELECT COALESCE(sum(charged_amount), 0) AS total, COALESCE(sum(cash_amount), 0) AS cash,
              COALESCE(sum(electronic_amount), 0) AS electronic, count(*) AS count,
              count(*) FILTER (WHERE payment_method = 'CASH') AS n_cash,
              count(*) FILTER (WHERE payment_method = 'ELECTRONIC') AS n_electronic,
              count(*) FILTER (WHERE payment_method = 'MIXED') AS n_mixed
         FROM entries WHERE site_id = $1 AND status = 'PAID' AND paid_at >= CURRENT_DATE`,
      [siteId],
    ),
    query(
      `SELECT sh.id, z.name AS zone, u.full_name AS user_name, sh.opened_at
         FROM shifts sh JOIN zones z ON z.id = sh.zone_id JOIN users u ON u.id = sh.user_id
        WHERE sh.site_id = $1 AND sh.closed_at IS NULL ORDER BY z.name`,
      [siteId],
    ),
    query(
      `SELECT count(*) AS n, COALESCE(sum(amount), 0) AS total FROM pending_charges WHERE site_id = $1 AND confirmed_at IS NULL`,
      [siteId],
    ),
    query(
      `SELECT extract(hour FROM entry_at)::int AS h, count(*) AS n FROM entries
        WHERE site_id = $1 AND entry_at >= CURRENT_DATE GROUP BY 1 ORDER BY 1`,
      [siteId],
    ),
  ]);
  const byType = Object.fromEntries(inside.rows.map((r) => [r.vehicle_type, r.n]));
  const insideTotal = inside.rows.reduce((s, r) => s + r.n, 0);
  const capacity = site.rows[0]?.capacity ?? null;
  return {
    site: site.rows[0],
    inside: {
      total: insideTotal,
      byType: Object.entries(VEHICLE_LABELS).map(([type, label]) => ({ type, label, count: byType[type] ?? 0 })),
      capacity,
      occupancy: capacity ? Math.round((insideTotal / capacity) * 100) : null,
    },
    today: { entries: today.rows[0].entries, exits: today.rows[0].exits },
    sales: {
      total: sales.rows[0].total,
      cash: sales.rows[0].cash,
      electronic: sales.rows[0].electronic,
      count: sales.rows[0].count,
      byMethod: { CASH: sales.rows[0].n_cash, ELECTRONIC: sales.rows[0].n_electronic, MIXED: sales.rows[0].n_mixed },
    },
    entriesByHour: Array.from({ length: 24 }, (_, h) => ({ hour: h, count: hourly.rows.find((r) => r.h === h)?.n ?? 0 })),
    openShifts: shifts.rows.map((s) => ({ id: s.id, zone: s.zone, user: s.user_name, openedAt: s.opened_at })),
    pending: { count: pending.rows[0].n, total: pending.rows[0].total },
    monthlyAlerts: await monthly.alerts(siteId),
  };
}

// ---------------------------------------------------------------------------
// Reporte por rango
// ---------------------------------------------------------------------------

async function summary(req, filters) {
  const siteId = parseSite(filters.siteId);
  await assertSiteAccess(req, siteId);
  const range = parseRange(filters);
  const unit = granularityFor(range);
  const step = { hour: '1 hour', day: '1 day', week: '1 week', month: '1 month' }[unit];

  const [kpis, series] = await Promise.all([
    query(
      `SELECT
         (SELECT count(*) FROM entries WHERE site_id = $1 AND entry_at >= $2::date AND entry_at < $3::date + 1) AS vehicles,
         (SELECT count(*) FROM entries WHERE site_id = $1 AND exit_at >= $2::date AND exit_at < $3::date + 1) AS exits,
         s.total AS sales, s.cash, s.electronic, s.discounts, s.count AS sales_count,
         m.income AS incomes, m.expense AS expenses,
         (SELECT COALESCE(sum(amount), 0) FROM pending_charges WHERE site_id = $1 AND confirmed_at IS NULL) AS pending
       FROM (SELECT COALESCE(sum(charged_amount), 0) AS total, COALESCE(sum(cash_amount), 0) AS cash,
                    COALESCE(sum(electronic_amount), 0) AS electronic, COALESCE(sum(discount_amount), 0) AS discounts,
                    count(*) AS count
               FROM entries WHERE site_id = $1 AND status = 'PAID' AND paid_at >= $2::date AND paid_at < $3::date + 1) s,
            (SELECT COALESCE(sum(m.amount) FILTER (WHERE m.type = 'INCOME'), 0) AS income,
                    COALESCE(sum(m.amount) FILTER (WHERE m.type = 'EXPENSE'), 0) AS expense
               FROM cash_movements m JOIN cash_registers cr ON cr.id = m.cash_register_id
              WHERE cr.site_id = $1 AND m.deleted_at IS NULL AND m.created_at >= $2::date AND m.created_at < $3::date + 1) m`,
      [siteId, range.from, range.to],
    ),
    query(
      `WITH buckets AS (
         SELECT generate_series(date_trunc($4, $2::date::timestamptz), $3::date::timestamptz + interval '1 day' - interval '1 second', $5::interval) AS b
       ),
       sales AS (
         SELECT date_trunc($4, paid_at) AS b, sum(charged_amount) AS v FROM entries
          WHERE site_id = $1 AND status = 'PAID' AND paid_at >= $2::date AND paid_at < $3::date + 1 GROUP BY 1
       ),
       mov AS (
         SELECT date_trunc($4, m.created_at) AS b,
                sum(m.amount) FILTER (WHERE m.type = 'INCOME') AS income,
                sum(m.amount) FILTER (WHERE m.type = 'EXPENSE') AS expense
           FROM cash_movements m JOIN cash_registers cr ON cr.id = m.cash_register_id
          WHERE cr.site_id = $1 AND m.deleted_at IS NULL AND m.created_at >= $2::date AND m.created_at < $3::date + 1
          GROUP BY 1
       ),
       ins AS (
         SELECT date_trunc($4, entry_at) AS b, count(*) AS n FROM entries
          WHERE site_id = $1 AND entry_at >= $2::date AND entry_at < $3::date + 1 GROUP BY 1
       ),
       outs AS (
         SELECT date_trunc($4, exit_at) AS b, count(*) AS n FROM entries
          WHERE site_id = $1 AND exit_at >= $2::date AND exit_at < $3::date + 1 GROUP BY 1
       )
       SELECT bk.b AS bucket,
              COALESCE(s.v, 0) + COALESCE(m.income, 0) AS income,
              COALESCE(s.v, 0) AS sales,
              COALESCE(m.expense, 0) AS expenses,
              COALESCE(i.n, 0) AS entries,
              COALESCE(o.n, 0) AS exits
         FROM buckets bk
         LEFT JOIN sales s ON s.b = bk.b
         LEFT JOIN mov m ON m.b = bk.b
         LEFT JOIN ins i ON i.b = bk.b
         LEFT JOIN outs o ON o.b = bk.b
        ORDER BY bk.b`,
      [siteId, range.from, range.to, unit, step],
    ),
  ]);

  const k = kpis.rows[0];
  const income = k.sales + k.incomes;
  return {
    range,
    granularity: unit,
    kpis: {
      vehicles: k.vehicles,
      exits: k.exits,
      sales: k.sales,
      salesCount: k.sales_count,
      incomes: k.incomes,
      income,
      expenses: k.expenses,
      net: income - k.expenses,
      cash: k.cash,
      electronic: k.electronic,
      discounts: k.discounts,
      pendingOpen: k.pending,
    },
    series: series.rows.map((r) => ({
      bucket: r.bucket,
      income: r.income,
      sales: r.sales,
      expenses: r.expenses,
      entries: r.entries,
      exits: r.exits,
    })),
  };
}

// Cierres de caja (turnos cerrados) del rango
async function closures(req, filters) {
  const siteId = parseSite(filters.siteId);
  await assertSiteAccess(req, siteId);
  const range = parseRange(filters);
  const { rows } = await query(
    `SELECT cr.id, cr.opened_at, cr.closed_at, cr.initial_cash, cr.physical_cash, cr.expected_cash, cr.difference,
            cr.summary, sh.close_type, z.name AS zone, u.full_name AS user_name, uc.full_name AS closed_by_name
       FROM cash_registers cr
       JOIN shifts sh ON sh.id = cr.shift_id
       JOIN zones z ON z.id = sh.zone_id
       JOIN users u ON u.id = sh.user_id
       LEFT JOIN users uc ON uc.id = cr.closed_by
      WHERE cr.site_id = $1 AND cr.closed_at IS NOT NULL AND cr.closed_at >= $2::date AND cr.closed_at < $3::date + 1
      ORDER BY cr.closed_at DESC`,
    [siteId, range.from, range.to],
  );
  return rows.map((r) => ({
    id: r.id,
    zone: r.zone,
    user: r.user_name,
    closedBy: r.closed_by_name,
    closeType: r.close_type,
    openedAt: r.opened_at,
    closedAt: r.closed_at,
    initialCash: r.initial_cash,
    totalSales: r.summary?.totalSales ?? 0,
    cashSales: r.summary?.cashSales ?? 0,
    electronicSales: r.summary?.electronicSales ?? 0,
    expectedInDrawer: r.summary?.expectedInDrawer ?? null,
    counted: r.physical_cash,
    difference: r.difference,
  }));
}

// Detalle de un cierre: resumen congelado, arqueos, movimientos y ventas
async function closureDetail(req, rawId) {
  const id = Number.parseInt(rawId, 10);
  const { rows } = await query(
    `SELECT cr.*, sh.close_type, z.name AS zone, u.full_name AS user_name
       FROM cash_registers cr JOIN shifts sh ON sh.id = cr.shift_id JOIN zones z ON z.id = sh.zone_id
       JOIN users u ON u.id = sh.user_id WHERE cr.id = $1`,
    [id],
  );
  const cr = rows[0];
  if (!cr) throw new HttpError(404, 'Caja no encontrada', { code: 'NOT_FOUND' });
  await assertSiteAccess(req, cr.site_id);
  const [counts, movements, sales] = await Promise.all([
    query(
      `SELECT c.kind, c.denominations, c.total, c.expected_total, c.difference, c.created_at, c.notes,
              u.full_name AS counted_by, r.full_name AS received_by
         FROM cash_counts c JOIN users u ON u.id = c.counted_by LEFT JOIN users r ON r.id = c.received_by
        WHERE c.cash_register_id = $1 ORDER BY c.created_at`,
      [id],
    ),
    query(
      `SELECT m.type, m.amount, m.concept, m.withdrawal_to, m.created_at, u.full_name AS created_by
         FROM cash_movements m LEFT JOIN users u ON u.id = m.created_by
        WHERE m.cash_register_id = $1 AND m.deleted_at IS NULL ORDER BY m.created_at`,
      [id],
    ),
    query(
      `SELECT receipt_prefix || receipt_number AS receipt, plate, vehicle_type, paid_at, charged_amount, discount_amount,
              payment_method, cash_amount, electronic_amount
         FROM entries WHERE cash_register_id = $1 AND status = 'PAID' ORDER BY paid_at`,
      [id],
    ),
  ]);
  const live = await registerSummary({ query }, id);
  return {
    id: cr.id,
    zone: cr.zone,
    user: cr.user_name,
    closeType: cr.close_type,
    openedAt: cr.opened_at,
    closedAt: cr.closed_at,
    // Un cierre guardado conserva su resumen tal como quedó (no se recalcula)
    summary: cr.summary ?? live,
    counts: counts.rows,
    movements: movements.rows,
    sales: sales.rows,
  };
}

// ---------------------------------------------------------------------------
// Fidelidad de clientes (v1.0 2.6.43-2.6.49): puntaje 0-100 con frecuencia 35 %, duración 25 %,
// regularidad 25 % y recencia 15 %. Siempre sobre todas las entradas de la sede.
// ---------------------------------------------------------------------------

const LOYALTY = {
  weights: { frequency: 0.35, duration: 0.25, regularity: 0.25, recency: 0.15 },
  targetVisits: 8,
  targetHours: 4,
  recencyDays: 30,
  tableLimit: 40,
};
const clamp01 = (x) => Math.max(0, Math.min(1, x));

function loyaltyLevel(visits, score) {
  if (visits <= 1) return { key: 'new', label: 'Nuevo' };
  if (score >= 70) return { key: 'loyal', label: 'Fiel' };
  if (score >= 45) return { key: 'frequent', label: 'Frecuente' };
  return { key: 'occasional', label: 'Ocasional' };
}

function loyaltyScore(c, todayDay) {
  const frequency = clamp01(c.visits / LOYALTY.targetVisits);
  const duration = c.avgHours == null ? 0 : clamp01(c.avgHours / LOYALTY.targetHours);
  let regularity = 0;
  if (c.visits >= 3) {
    const gaps = [];
    for (let i = 1; i < c.days.length; i += 1) gaps.push(c.days[i] - c.days[i - 1]);
    const mean = gaps.reduce((a, g) => a + g, 0) / gaps.length;
    if (mean > 0) {
      const sd = Math.sqrt(gaps.reduce((a, g) => a + (g - mean) ** 2, 0) / gaps.length);
      regularity = clamp01(1 - sd / mean);
    } else regularity = 1;
  }
  const daysSince = Math.max(0, todayDay - c.days[c.days.length - 1]);
  const recency = clamp01(1 - daysSince / LOYALTY.recencyDays);
  const W = LOYALTY.weights;
  const score = Math.round((frequency * W.frequency + duration * W.duration + regularity * W.regularity + recency * W.recency) * 100);
  return { score, frequency, duration, regularity, recency, daysSince };
}

async function loyalty(req, filters) {
  const siteId = parseSite(filters.siteId);
  await assertSiteAccess(req, siteId);
  // Días como números (fecha local de Colombia) para medir separación entre visitas
  const { rows } = await query(
    `SELECT e.plate,
            count(*) AS visits,
            array_agg((e.entry_at::date - DATE '2000-01-01') ORDER BY e.entry_at) AS days,
            avg(extract(epoch FROM e.exit_at - e.entry_at) / 3600) FILTER (WHERE e.exit_at IS NOT NULL) AS avg_hours,
            COALESCE(sum(e.charged_amount) FILTER (WHERE e.status = 'PAID'), 0) AS spent,
            max(e.entry_at) AS last_visit,
            bool_or(mp.id IS NOT NULL) AS has_monthly,
            (CURRENT_DATE - DATE '2000-01-01') AS today_day
       FROM entries e
       LEFT JOIN monthly_plans mp ON mp.site_id = e.site_id AND mp.plate = e.plate AND mp.deleted_at IS NULL
      WHERE e.site_id = $1 AND e.status <> 'CANCELLED'
      GROUP BY e.plate`,
    [siteId],
  );
  const clients = rows.map((r) => {
    const c = { visits: r.visits, days: r.days, avgHours: r.avg_hours == null ? null : Number(r.avg_hours) };
    const s = loyaltyScore(c, r.today_day);
    const gaps = r.days.slice(1).map((d, i) => d - r.days[i]);
    return {
      plate: r.plate,
      visits: r.visits,
      spent: r.spent,
      avgHours: c.avgHours == null ? null : Math.round(c.avgHours * 10) / 10,
      avgDaysBetween: gaps.length ? Math.round((gaps.reduce((a, g) => a + g, 0) / gaps.length) * 10) / 10 : null,
      lastVisit: r.last_visit,
      daysSinceLast: s.daysSince,
      hasMonthly: r.has_monthly,
      score: s.score,
      level: loyaltyLevel(r.visits, s.score),
    };
  });
  const totalClients = clients.length;
  const recurring = clients.filter((c) => c.visits >= 2).length;
  const levels = ['loyal', 'frequent', 'occasional', 'new'].map((key) => ({
    key,
    label: loyaltyLevel(key === 'new' ? 1 : 2, { loyal: 70, frequent: 45, occasional: 0 }[key] ?? 0).label,
    count: clients.filter((c) => c.level.key === key).length,
  }));
  clients.sort((a, b) => b.score - a.score || b.visits - a.visits);
  const level = filters.level;
  const table = level ? clients.filter((c) => c.level.key === level) : clients.slice(0, LOYALTY.tableLimit);
  return {
    totalClients,
    recurring,
    returnRate: totalClients ? Math.round((recurring / totalClients) * 100) : 0,
    visitsPerClient: totalClients ? Math.round((clients.reduce((s, c) => s + c.visits, 0) / totalClients) * 10) / 10 : 0,
    levels,
    clients: table,
  };
}

module.exports = { dashboard, summary, closures, closureDetail, loyalty, granularityFor, loyaltyScore, loyaltyLevel };
