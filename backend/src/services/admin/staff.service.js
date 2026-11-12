// Personal y turnos (RF44-RF46).
//   RF44 horas trabajadas por empleado: por turno, día, semana (ISO) o mes, separadas en diurnas,
//        nocturnas y dominicales/festivas (calendario de Colombia, lib/workhours.js).
//   RF45 reporte de turnos con diferencias de arqueo.
//   RF46 ajuste autorizado de turnos: otro administrador (AG o AS de la sede, nunca el mismo
//        empleado) corrige la hora de inicio/fin trabajada, con motivo; las horas reales del turno no
//        se tocan, queda el historial (shift_adjustments) y la auditoría.
// Las horas usan la hora ajustada si existe (worked_start/worked_end) y si no la real.
const ExcelJS = require('exceljs');
const { query, withTransaction } = require('../../db/pool');
const HttpError = require('../../middlewares/httpError');
const { assertSiteAccess } = require('../../middlewares/authorize');
const { recordAudit } = require('../audit.service');
const { publish } = require('../../realtime/bus');
const { splitWorkedTime, isoWeek, holidayName } = require('../../lib/workhours');
const { sitesInScope, parseRange } = require('./scope');

const MONEY_FMT = '"$" #,##0';
const MIN_REASON = 10;
const MAX_SHIFT_HOURS = 36;

const SHIFT_SELECT = `
  SELECT sh.id, sh.site_id, sh.zone_id, sh.user_id, sh.opened_at, sh.closed_at, sh.close_type,
         sh.worked_start, sh.worked_end,
         COALESCE(sh.worked_start, sh.opened_at) AS eff_start,
         COALESCE(sh.worked_end, sh.closed_at) AS eff_end,
         s.name AS site_name, z.name AS zone_name, u.full_name, u.username, u.role,
         cr.id AS cash_register_id, cr.physical_cash, cr.difference, cr.summary,
         COALESCE((cr.summary->>'expectedInDrawer')::int, cr.expected_cash) AS expected,
         (SELECT count(*) FROM shift_adjustments a WHERE a.shift_id = sh.id) AS adjustments
    FROM shifts sh
    JOIN sites s ON s.id = sh.site_id
    JOIN zones z ON z.id = sh.zone_id
    JOIN users u ON u.id = sh.user_id
    JOIN cash_registers cr ON cr.shift_id = sh.id`;

// Turnos (de las sedes del alcance) cuyo tiempo trabajado se cruza con el rango
async function shiftsInRange(req, filters) {
  const range = parseRange(filters);
  const sites = await sitesInScope(req, filters.siteId);
  const userId = filters.userId ? Number.parseInt(filters.userId, 10) : null;
  const { rows } = await query(
    `${SHIFT_SELECT}
      WHERE sh.site_id = ANY($1)
        AND COALESCE(sh.worked_start, sh.opened_at) < $3::date + 1
        AND COALESCE(sh.worked_end, sh.closed_at, now()) > $2::date
        AND ($4::int IS NULL OR sh.user_id = $4)
      ORDER BY COALESCE(sh.worked_start, sh.opened_at)`,
    [sites.map((s) => s.id), range.from, range.to, userId],
  );
  return { range, rows };
}

const CATS = ['total', 'day', 'night', 'holidayDay', 'holidayNight'];
const zero = () => Object.fromEntries(CATS.map((c) => [c, 0]));
const addInto = (acc, m) => CATS.forEach((c) => { acc[c] += m[c]; });
// Minutos → horas con 2 decimales
const hours = (m) => Object.fromEntries(CATS.map((c) => [c, Math.round((m[c] / 60) * 100) / 100]));

function rangeBounds(range) {
  return { start: new Date(`${range.from}T00:00:00-05:00`), end: new Date(`${range.to}T00:00:00-05:00`).getTime() + 86400000 };
}

/**
 * RF44: horas trabajadas. groupBy = shift | day | week | month.
 * Devuelve por empleado: total del rango y el detalle por período, en horas.
 */
async function workedHours(req, filters = {}) {
  const groupBy = ['shift', 'day', 'week', 'month'].includes(filters.groupBy) ? filters.groupBy : 'day';
  const { range, rows } = await shiftsInRange(req, filters);
  const bounds = rangeBounds(range);
  const now = Date.now();
  const byUser = new Map();

  for (const r of rows) {
    // Se recorta al rango pedido; un turno abierto cuenta hasta ahora
    const start = Math.max(new Date(r.eff_start).getTime(), bounds.start.getTime());
    const end = Math.min(r.eff_end ? new Date(r.eff_end).getTime() : now, bounds.end);
    const split = splitWorkedTime(start, end);
    if (!byUser.has(r.user_id)) {
      byUser.set(r.user_id, { user: { id: r.user_id, fullName: r.full_name, username: r.username, role: r.role }, minutes: zero(), periods: new Map(), shifts: 0 });
    }
    const u = byUser.get(r.user_id);
    u.shifts += 1;
    addInto(u.minutes, split);
    if (groupBy === 'shift') {
      u.periods.set(`shift-${r.id}`, {
        key: `shift-${r.id}`,
        label: `${r.site_name} · ${r.zone_name}`,
        shiftId: r.id,
        start: r.eff_start,
        end: r.eff_end,
        open: !r.closed_at,
        adjusted: Boolean(r.worked_start || r.worked_end),
        minutes: { ...zero(), ...Object.fromEntries(CATS.map((c) => [c, split[c]])) },
      });
      continue;
    }
    for (const [date, m] of split.byDate) {
      let key = date;
      let label = date;
      if (groupBy === 'week') {
        const w = isoWeek(date);
        key = w.key;
        label = w.start;
      } else if (groupBy === 'month') {
        key = date.slice(0, 7);
        label = key;
      }
      if (!u.periods.has(key)) {
        u.periods.set(key, { key, label, holiday: groupBy === 'day' ? holidayName(date) : null, minutes: zero() });
      }
      addInto(u.periods.get(key).minutes, m);
    }
  }

  const employees = [...byUser.values()]
    .map((u) => ({
      user: u.user,
      shifts: u.shifts,
      hours: hours(u.minutes),
      periods: [...u.periods.values()]
        .sort((a, b) => (a.start ? new Date(a.start) - new Date(b.start) : String(a.key).localeCompare(String(b.key))))
        .map((p) => ({ ...p, hours: hours(p.minutes), minutes: undefined })),
    }))
    .sort((a, b) => a.user.fullName.localeCompare(b.user.fullName));
  const totals = zero();
  for (const u of byUser.values()) addInto(totals, u.minutes);
  return { range, groupBy, employees, totals: hours(totals) };
}

// ---------------------------------------------------------------------------
// RF45: reporte de turnos con diferencias
// ---------------------------------------------------------------------------

async function shiftReport(req, filters = {}) {
  const { range, rows } = await shiftsInRange(req, filters);
  const { registerSummary } = require('../cash.service');
  const items = [];
  for (const r of rows) {
    const live = r.closed_at ? null : await registerSummary({ query: (t, p) => query(t, p) }, r.cash_register_id);
    const summary = r.summary ?? live ?? {};
    const minutes = splitWorkedTime(r.eff_start, r.eff_end ?? new Date());
    items.push({
      shiftId: r.id,
      site: { id: r.site_id, name: r.site_name },
      zone: { id: r.zone_id, name: r.zone_name },
      user: { id: r.user_id, fullName: r.full_name },
      openedAt: r.opened_at,
      closedAt: r.closed_at,
      workedStart: r.eff_start,
      workedEnd: r.eff_end,
      adjusted: Boolean(r.worked_start || r.worked_end),
      adjustments: r.adjustments,
      closeType: r.close_type,
      open: !r.closed_at,
      workedHours: hours(minutes),
      sales: { count: summary.salesCount ?? 0, total: summary.totalSales ?? 0 },
      expected: r.closed_at ? r.expected : live?.expectedInDrawer ?? null,
      counted: r.physical_cash,
      difference: r.difference,
    });
  }
  const closed = items.filter((i) => !i.open);
  return {
    range,
    items,
    totals: {
      shifts: items.length,
      hours: Math.round(items.reduce((s, i) => s + i.workedHours.total, 0) * 100) / 100,
      sales: items.reduce((s, i) => s + i.sales.total, 0),
      withDifference: closed.filter((i) => i.difference).length,
      shortage: closed.filter((i) => i.difference < 0).reduce((s, i) => s - i.difference, 0),
      surplus: closed.filter((i) => i.difference > 0).reduce((s, i) => s + i.difference, 0),
      adjusted: items.filter((i) => i.adjusted).length,
    },
  };
}

async function shiftReportXlsx(req, filters) {
  const [report, worked] = await Promise.all([shiftReport(req, filters), workedHours(req, { ...filters, groupBy: 'day' })]);
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Nexo.app';
  const fmt = (d) => (d ? new Date(d).toLocaleString('es-CO', { timeZone: 'America/Bogota' }) : '');
  const ws = wb.addWorksheet('Turnos');
  ws.columns = [16, 16, 24, 20, 20, 10, 14, 14, 14, 14, 10].map((width) => ({ width }));
  ws.addRow(['Sede', 'Zona', 'Empleado', 'Inicio trabajado', 'Fin trabajado', 'Horas', 'Ventas', 'Esperado', 'Contado', 'Diferencia', 'Ajustado']).font = { bold: true };
  for (const i of report.items) {
    const row = ws.addRow([i.site.name, i.zone.name, i.user.fullName, fmt(i.workedStart), i.open ? 'Abierto' : fmt(i.workedEnd), i.workedHours.total, i.sales.total, i.expected, i.counted, i.difference, i.adjusted ? 'Sí' : '']);
    [7, 8, 9, 10].forEach((c) => {
      row.getCell(c).numFmt = MONEY_FMT;
    });
  }
  const hs = wb.addWorksheet('Horas por día');
  hs.columns = [24, 12, 10, 10, 10, 12, 12, 20].map((width) => ({ width }));
  hs.addRow(['Empleado', 'Fecha', 'Total', 'Diurnas', 'Nocturnas', 'Dom/fest diurnas', 'Dom/fest nocturnas', 'Festivo']).font = { bold: true };
  for (const e of worked.employees) {
    for (const p of e.periods) {
      hs.addRow([e.user.fullName, p.label.split('-').reverse().join('/'), p.hours.total, p.hours.day, p.hours.night, p.hours.holidayDay, p.hours.holidayNight, p.holiday ?? '']);
    }
    hs.addRow([`Total ${e.user.fullName}`, '', e.hours.total, e.hours.day, e.hours.night, e.hours.holidayDay, e.hours.holidayNight]).font = { bold: true };
  }
  return wb.xlsx.writeBuffer();
}

// ---------------------------------------------------------------------------
// RF46: ajuste autorizado
// ---------------------------------------------------------------------------

function parseTs(v, field) {
  if (v === null) return null;
  const d = new Date(v);
  if (v === undefined || Number.isNaN(d.getTime())) {
    throw new HttpError(400, 'Fecha y hora inválidas', { code: 'VALIDATION_ERROR', details: { [field]: 'Fecha y hora inválidas' } });
  }
  return d;
}

async function adjustShift(req, rawId, body) {
  const shiftId = Number.parseInt(rawId, 10);
  const reason = typeof body?.reason === 'string' ? body.reason.trim() : '';
  if (reason.length < MIN_REASON) {
    throw new HttpError(400, `Escriba el motivo del ajuste (mínimo ${MIN_REASON} caracteres)`, { code: 'REASON_REQUIRED' });
  }
  const result = await withTransaction(async (client) => {
    const { rows } = await client.query(`${SHIFT_SELECT} WHERE sh.id = $1 FOR UPDATE OF sh`, [shiftId]);
    const s = rows[0];
    if (!s) throw new HttpError(404, 'Turno no encontrado', { code: 'NOT_FOUND' });
    await assertSiteAccess(req, s.site_id);
    if (s.user_id === req.user.id) {
      throw new HttpError(403, 'Un ajuste de su propio turno lo debe autorizar otro administrador', { code: 'SELF_ADJUST_FORBIDDEN' });
    }
    const start = body.workedStart !== undefined ? parseTs(body.workedStart, 'workedStart') : new Date(s.eff_start);
    let end = s.eff_end ? new Date(s.eff_end) : null;
    if (body.workedEnd !== undefined) {
      if (!s.closed_at) throw new HttpError(409, 'El turno sigue abierto: solo se puede ajustar la hora de inicio', { code: 'SHIFT_STILL_OPEN' });
      end = parseTs(body.workedEnd, 'workedEnd');
    }
    if (!start) throw new HttpError(400, 'Indique la hora de inicio', { code: 'VALIDATION_ERROR' });
    const now = new Date();
    if (start > now || (end && end > now)) throw new HttpError(400, 'Las horas no pueden estar en el futuro', { code: 'VALIDATION_ERROR' });
    if (end && end <= start) throw new HttpError(400, 'El fin debe ser posterior al inicio', { code: 'VALIDATION_ERROR' });
    if (end && end - start > MAX_SHIFT_HOURS * 3600000) {
      throw new HttpError(400, `Un turno no puede pasar de ${MAX_SHIFT_HOURS} horas`, { code: 'VALIDATION_ERROR' });
    }
    if (+start === +new Date(s.eff_start) && +(end ?? 0) === +(s.eff_end ? new Date(s.eff_end) : 0)) {
      throw new HttpError(400, 'No hay cambios', { code: 'VALIDATION_ERROR' });
    }
    // No puede cruzarse con otro turno del mismo empleado
    const { rows: clash } = await client.query(
      `SELECT sh.id, z.name AS zone FROM shifts sh JOIN zones z ON z.id = sh.zone_id
        WHERE sh.user_id = $1 AND sh.id <> $2
          AND COALESCE(sh.worked_start, sh.opened_at) < COALESCE($4::timestamptz, 'infinity')
          AND COALESCE(sh.worked_end, sh.closed_at, 'infinity') > $3::timestamptz
        LIMIT 1`,
      [s.user_id, shiftId, start, end],
    );
    if (clash[0]) {
      throw new HttpError(409, `El horario ajustado se cruza con otro turno del empleado (#${clash[0].id}, ${clash[0].zone})`, { code: 'SHIFT_OVERLAP' });
    }

    await client.query(
      `INSERT INTO shift_adjustments (shift_id, site_id, previous_start, previous_end, new_start, new_end, reason, authorized_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [shiftId, s.site_id, s.eff_start, s.eff_end, start, end, reason, req.user.id],
    );
    await client.query('UPDATE shifts SET worked_start = $2, worked_end = $3 WHERE id = $1', [
      shiftId,
      +start === +new Date(s.opened_at) ? null : start,
      s.closed_at && end && +end !== +new Date(s.closed_at) ? end : null,
    ]);
    await recordAudit(
      {
        req,
        userId: req.user.id,
        siteId: s.site_id,
        action: 'SHIFT_ADJUSTED',
        entityType: 'shift',
        entityId: shiftId,
        details: { employeeId: s.user_id, reason, before: { start: s.eff_start, end: s.eff_end }, after: { start, end } },
      },
      client,
    );
    return { siteId: s.site_id };
  });
  publish(result.siteId, 'shift:adjusted', { shiftId });
  return { shiftId, adjustments: await listAdjustments(req, shiftId) };
}

async function listAdjustments(req, rawId) {
  const shiftId = Number.parseInt(rawId, 10);
  const { rows: s } = await query('SELECT site_id FROM shifts WHERE id = $1', [shiftId]);
  if (!s[0]) throw new HttpError(404, 'Turno no encontrado', { code: 'NOT_FOUND' });
  await assertSiteAccess(req, s[0].site_id);
  const { rows } = await query(
    `SELECT a.*, u.full_name AS authorized_name FROM shift_adjustments a JOIN users u ON u.id = a.authorized_by
      WHERE a.shift_id = $1 ORDER BY a.created_at DESC`,
    [shiftId],
  );
  return rows.map((a) => ({
    id: a.id,
    previous: { start: a.previous_start, end: a.previous_end },
    next: { start: a.new_start, end: a.new_end },
    reason: a.reason,
    authorizedBy: a.authorized_name,
    at: a.created_at,
  }));
}

module.exports = { workedHours, shiftReport, shiftReportXlsx, adjustShift, listAdjustments };
