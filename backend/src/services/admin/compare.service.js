// Comparativo entre sedes (RF33), en un rango de fechas:
//   ingresos     parqueadero + mensualidades + otros ingresos
//   ocupación    promedio: minutos-vehículo dentro del rango / (capacidad × minutos del rango)
//   ticket       promedio por venta de parqueadero
//   estancia     promedio (minutos) de los vehículos que salieron en el rango
//   productividad por empleado: ventas de parqueadero por hora trabajada y ingresos por empleado
//                 (empleados = quienes tuvieron turno en la sede en el rango)
const { query } = require('../../db/pool');
const { splitWorkedTime } = require('../../lib/workhours');
const { sitesInScope, parseRange } = require('./scope');

async function compareSites(req, filters = {}) {
  const range = parseRange(filters);
  const sites = await sitesInScope(req, filters.siteId);
  const ids = sites.map((s) => s.id);
  const p = [ids, range.from, range.to];
  const inRange = (col) => `${col} >= $2::date AND ${col} < $3::date + 1`;
  const rangeStart = new Date(`${range.from}T00:00:00-05:00`);
  const rangeEnd = new Date(Math.min(Date.now(), new Date(`${range.to}T00:00:00-05:00`).getTime() + 86400000));
  const rangeMinutes = Math.max(1, (rangeEnd - rangeStart) / 60000);

  const [parking, monthlyPay, other, stay, occ, shifts] = await Promise.all([
    query(`SELECT site_id, count(*) AS n, COALESCE(sum(charged_amount), 0) AS total FROM entries WHERE site_id = ANY($1) AND status = 'PAID' AND ${inRange('paid_at')} GROUP BY 1`, p),
    query(`SELECT site_id, COALESCE(sum(amount), 0) AS total FROM monthly_payments WHERE site_id = ANY($1) AND ${inRange('paid_at')} GROUP BY 1`, p),
    query(
      `SELECT cr.site_id, COALESCE(sum(m.amount), 0) AS total FROM cash_movements m JOIN cash_registers cr ON cr.id = m.cash_register_id
        WHERE cr.site_id = ANY($1) AND m.type = 'INCOME' AND m.deleted_at IS NULL AND ${inRange('m.created_at')} GROUP BY 1`,
      p,
    ),
    query(
      `SELECT site_id, avg(extract(epoch FROM exit_at - entry_at) / 60) AS minutes, count(*) AS n FROM entries
        WHERE site_id = ANY($1) AND status IN ('PAID', 'PENDING_CHARGE') AND ${inRange('exit_at')} GROUP BY 1`,
      p,
    ),
    // Minutos-vehículo dentro del rango (recortados a sus bordes)
    query(
      `SELECT site_id, COALESCE(sum(extract(epoch FROM LEAST(COALESCE(exit_at, now()), $5::timestamptz) - GREATEST(entry_at, $4::timestamptz)) / 60), 0) AS minutes
         FROM entries
        WHERE site_id = ANY($1) AND status <> 'CANCELLED'
          AND entry_at < $5::timestamptz AND COALESCE(exit_at, now()) > $4::timestamptz
          AND $2::date IS NOT NULL AND $3::date IS NOT NULL
        GROUP BY 1`,
      [...p, rangeStart, rangeEnd],
    ),
    query(
      `SELECT site_id, user_id, COALESCE(worked_start, opened_at) AS s, COALESCE(worked_end, closed_at, now()) AS e FROM shifts
        WHERE site_id = ANY($1) AND COALESCE(worked_start, opened_at) < $5::timestamptz
          AND COALESCE(worked_end, closed_at, now()) > $4::timestamptz AND $2::date IS NOT NULL AND $3::date IS NOT NULL`,
      [...p, rangeStart, rangeEnd],
    ),
  ]);

  const get = (res, id, k = 'total') => Number(res.rows.find((r) => r.site_id === id)?.[k] ?? 0);
  const result = sites.map((site) => {
    const parkingTotal = get(parking, site.id);
    const sales = get(parking, site.id, 'n');
    const income = parkingTotal + get(monthlyPay, site.id) + get(other, site.id);
    const siteShifts = shifts.rows.filter((s) => s.site_id === site.id);
    const employees = new Set(siteShifts.map((s) => s.user_id)).size;
    const workedMinutes = siteShifts.reduce(
      (sum, s) => sum + splitWorkedTime(Math.max(new Date(s.s), rangeStart), Math.min(new Date(s.e), rangeEnd)).total,
      0,
    );
    const workedHours = workedMinutes / 60;
    const vehicleMinutes = get(occ, site.id, 'minutes');
    return {
      site: { id: site.id, code: site.code, name: site.name },
      income,
      parking: parkingTotal,
      sales,
      ticketAverage: sales ? Math.round(parkingTotal / sales) : null,
      averageStayMinutes: get(stay, site.id, 'n') ? Math.round(get(stay, site.id, 'minutes')) : null,
      occupancyAverage: site.capacity ? Math.round((vehicleMinutes / (site.capacity * rangeMinutes)) * 1000) / 10 : null,
      employees,
      workedHours: Math.round(workedHours * 10) / 10,
      salesPerHour: workedHours ? Math.round(parkingTotal / workedHours) : null,
      incomePerEmployee: employees ? Math.round(income / employees) : null,
    };
  });
  return { range, sites: result };
}

module.exports = { compareSites };
