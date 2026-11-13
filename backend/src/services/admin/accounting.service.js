// Contabilidad consolidada (RF29): por sede y consolidado, en un rango de fechas.
//   Estado de resultados:
//     Ingresos = parqueadero (ventas cobradas, por día de cobro) + mensualidades (pagos) + otros
//                ingresos (Transacciones → ingreso)
//     Egresos  = Transacciones → egreso, por categoría
//     Utilidad = ingresos − egresos
//   Los movimientos de base (Base +/−, retiros) no son ingreso ni egreso: solo se muestran en el flujo.
//   Flujo de caja diario: entradas en efectivo y electrónico, egresos y neto por día.
//   Diferencias de arqueo: cajas cerradas en el rango con faltante o sobrante.
const ExcelJS = require('exceljs');
const { query } = require('../../db/pool');
const { EXPENSE_CATEGORIES } = require('../movements.service');
const { sitesInScope, parseRange } = require('./scope');

const MONEY_FMT = '"$" #,##0';

function eachDay(from, to) {
  const out = [];
  for (let d = new Date(`${from}T00:00:00Z`); d <= new Date(`${to}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1)) {
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

function emptyStatement() {
  return {
    income: { parking: 0, monthly: 0, other: 0, total: 0 },
    expenses: { byCategory: Object.fromEntries(Object.keys(EXPENSE_CATEGORIES).map((k) => [k, 0])), total: 0 },
    profit: 0,
    margin: null,
  };
}

function emptyFlowDay(date) {
  return {
    date,
    parkingCash: 0,
    parkingElectronic: 0,
    monthlyCash: 0,
    monthlyElectronic: 0,
    otherIncome: 0,
    expenses: 0,
    baseIn: 0,
    baseOut: 0,
    income: 0,
    net: 0,
    cashNet: 0,
  };
}

function finish(st) {
  st.income.total = st.income.parking + st.income.monthly + st.income.other;
  st.expenses.total = Object.values(st.expenses.byCategory).reduce((a, b) => a + b, 0);
  st.profit = st.income.total - st.expenses.total;
  st.margin = st.income.total ? Math.round((st.profit / st.income.total) * 1000) / 10 : null;
  return st;
}

function finishDay(d) {
  d.income = d.parkingCash + d.parkingElectronic + d.monthlyCash + d.monthlyElectronic + d.otherIncome;
  d.net = d.income - d.expenses;
  d.cashNet = d.parkingCash + d.monthlyCash + d.otherIncome - d.expenses;
  return d;
}

async function accounting(req, filters = {}) {
  const range = parseRange(filters);
  const sites = await sitesInScope(req, filters.siteId);
  const ids = sites.map((s) => s.id);
  const params = [ids, range.from, range.to];
  const inRange = (col) => `${col} >= $2::date AND ${col} < $3::date + 1`;

  const [parking, monthlyPay, movements, diffs] = await Promise.all([
    query(
      `SELECT site_id, (paid_at::date)::text AS day, sum(cash_amount) AS cash, sum(electronic_amount) AS electronic
         FROM entries WHERE site_id = ANY($1) AND status = 'PAID' AND ${inRange('paid_at')} GROUP BY 1, 2`,
      params,
    ),
    query(
      `SELECT site_id, (paid_at::date)::text AS day, sum(cash_amount) AS cash, sum(electronic_amount) AS electronic
         FROM monthly_payments WHERE site_id = ANY($1) AND ${inRange('paid_at')} GROUP BY 1, 2`,
      params,
    ),
    query(
      `SELECT cr.site_id, (m.created_at::date)::text AS day, m.type, COALESCE(m.category, 'OTHER') AS category, sum(m.amount) AS total
         FROM cash_movements m JOIN cash_registers cr ON cr.id = m.cash_register_id
        WHERE cr.site_id = ANY($1) AND m.deleted_at IS NULL AND ${inRange('m.created_at')}
        GROUP BY 1, 2, 3, 4`,
      params,
    ),
    query(
      `SELECT cr.id, cr.site_id, s.name AS site_name, z.name AS zone, u.full_name AS user_name, cr.closed_at,
              COALESCE((cr.summary->>'expectedInDrawer')::int, cr.expected_cash) AS expected, cr.physical_cash AS counted, cr.difference
         FROM cash_registers cr
         JOIN shifts sh ON sh.id = cr.shift_id JOIN zones z ON z.id = sh.zone_id
         JOIN users u ON u.id = sh.user_id JOIN sites s ON s.id = cr.site_id
        WHERE cr.site_id = ANY($1) AND cr.closed_at IS NOT NULL AND ${inRange('cr.closed_at')} AND cr.difference <> 0
        ORDER BY cr.closed_at`,
      params,
    ),
  ]);

  const days = eachDay(range.from, range.to);
  const consolidated = { statement: emptyStatement(), flow: new Map(days.map((d) => [d, emptyFlowDay(d)])) };
  const bySite = sites.map((s) => ({ site: { id: s.id, code: s.code, name: s.name }, statement: emptyStatement(), flow: new Map(days.map((d) => [d, emptyFlowDay(d)])) }));
  const find = (id) => bySite.find((b) => b.site.id === id);
  const both = (siteId, fn) => {
    fn(find(siteId));
    fn(consolidated);
  };

  for (const r of parking.rows) {
    both(r.site_id, (b) => {
      b.statement.income.parking += Number(r.cash) + Number(r.electronic);
      const d = b.flow.get(r.day);
      d.parkingCash += Number(r.cash);
      d.parkingElectronic += Number(r.electronic);
    });
  }
  for (const r of monthlyPay.rows) {
    both(r.site_id, (b) => {
      b.statement.income.monthly += Number(r.cash) + Number(r.electronic);
      const d = b.flow.get(r.day);
      d.monthlyCash += Number(r.cash);
      d.monthlyElectronic += Number(r.electronic);
    });
  }
  for (const r of movements.rows) {
    const amount = Number(r.total);
    both(r.site_id, (b) => {
      const d = b.flow.get(r.day);
      if (r.type === 'INCOME') {
        b.statement.income.other += amount;
        d.otherIncome += amount;
      } else if (r.type === 'EXPENSE') {
        b.statement.expenses.byCategory[r.category] += amount;
        d.expenses += amount;
      } else if (r.type === 'BASE_IN') d.baseIn += amount;
      else d.baseOut += amount;
    });
  }

  const differences = diffs.rows.map((r) => ({
    cashRegisterId: r.id,
    site: { id: r.site_id, name: r.site_name },
    zone: r.zone,
    user: r.user_name,
    closedAt: r.closed_at,
    expected: r.expected,
    counted: r.counted,
    difference: r.difference,
  }));
  const diffTotals = (list) => ({
    count: list.length,
    shortage: list.filter((d) => d.difference < 0).reduce((s, d) => s - d.difference, 0),
    surplus: list.filter((d) => d.difference > 0).reduce((s, d) => s + d.difference, 0),
    net: list.reduce((s, d) => s + d.difference, 0),
  });

  const categoryLabels = EXPENSE_CATEGORIES;
  const out = (b, list) => ({
    statement: finish(b.statement),
    cashFlow: [...b.flow.values()].map(finishDay),
    differences: { totals: diffTotals(list), items: list },
  });
  return {
    range,
    categoryLabels,
    sites: bySite.map((b) => ({ site: b.site, ...out(b, differences.filter((d) => d.site.id === b.site.id)) })),
    consolidated: out(consolidated, differences),
  };
}

// ---------------------------------------------------------------------------
// Excel
// ---------------------------------------------------------------------------

async function accountingXlsx(req, filters) {
  const data = await accounting(req, filters);
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Nexo.app';
  wb.created = new Date();
  const title = `Del ${data.range.from.split('-').reverse().join('/')} al ${data.range.to.split('-').reverse().join('/')}`;
  const blocks = [...data.sites.map((s) => ({ name: s.site.name, ...s })), { name: 'Consolidado', ...data.consolidated }];

  // Estado de resultados: una columna por sede + consolidado
  const er = wb.addWorksheet('Estado de resultados');
  er.columns = [{ width: 34 }, ...blocks.map(() => ({ width: 18 }))];
  er.addRow(['Estado de resultados']).font = { bold: true, size: 14 };
  er.addRow([title]);
  er.addRow([]);
  er.addRow(['', ...blocks.map((b) => b.name)]).font = { bold: true };
  const line = (label, get, bold = false) => {
    const row = er.addRow([label, ...blocks.map(get)]);
    row.eachCell((c, i) => {
      if (i > 1) c.numFmt = MONEY_FMT;
    });
    if (bold) row.font = { bold: true };
  };
  line('Parqueadero', (b) => b.statement.income.parking);
  line('Mensualidades', (b) => b.statement.income.monthly);
  line('Otros ingresos', (b) => b.statement.income.other);
  line('Total ingresos', (b) => b.statement.income.total, true);
  for (const [k, label] of Object.entries(data.categoryLabels)) line(`Egresos · ${label}`, (b) => b.statement.expenses.byCategory[k]);
  line('Total egresos', (b) => b.statement.expenses.total, true);
  line('Utilidad', (b) => b.statement.profit, true);

  // Flujo de caja diario (consolidado y por sede)
  for (const b of blocks) {
    const ws = wb.addWorksheet(`Flujo ${b.name}`.slice(0, 31));
    ws.columns = [12, 16, 16, 16, 16, 16, 16, 16, 16, 16].map((width) => ({ width }));
    ws.addRow([`Flujo de caja · ${b.name}`]).font = { bold: true, size: 13 };
    ws.addRow([title]);
    ws.addRow(['Fecha', 'Parq. efectivo', 'Parq. electrónico', 'Mens. efectivo', 'Mens. electrónico', 'Otros ingresos', 'Egresos', 'Neto', 'Neto efectivo', 'Base −']).font = { bold: true };
    for (const d of b.cashFlow) {
      const row = ws.addRow([d.date.split('-').reverse().join('/'), d.parkingCash, d.parkingElectronic, d.monthlyCash, d.monthlyElectronic, d.otherIncome, d.expenses, d.net, d.cashNet, d.baseOut]);
      row.eachCell((c, i) => {
        if (i > 1) c.numFmt = MONEY_FMT;
      });
    }
  }

  // Diferencias de arqueo
  const df = wb.addWorksheet('Diferencias de arqueo');
  df.columns = [{ width: 22 }, { width: 18 }, { width: 24 }, { width: 20 }, { width: 16 }, { width: 16 }, { width: 16 }];
  df.addRow(['Sede', 'Zona', 'Responsable', 'Cierre', 'Esperado', 'Contado', 'Diferencia']).font = { bold: true };
  for (const d of data.consolidated.differences.items) {
    const row = df.addRow([d.site.name, d.zone, d.user, new Date(d.closedAt).toLocaleString('es-CO', { timeZone: 'America/Bogota' }), d.expected, d.counted, d.difference]);
    [5, 6, 7].forEach((i) => {
      row.getCell(i).numFmt = MONEY_FMT;
    });
  }
  const t = data.consolidated.differences.totals;
  df.addRow([]);
  df.addRow(['Faltantes', '', '', '', '', '', -t.shortage]).getCell(7).numFmt = MONEY_FMT;
  df.addRow(['Sobrantes', '', '', '', '', '', t.surplus]).getCell(7).numFmt = MONEY_FMT;

  return wb.xlsx.writeBuffer();
}

module.exports = { accounting, accountingXlsx };
