// Exportación de Reportes (RF22) a Excel (.xlsx, con exceljs) y PDF (pdfkit).
const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');
const { query } = require('../db/pool');
const reports = require('./reports.service');

const MONEY_FMT = '"$" #,##0';
const GRAN_LABEL = { hour: 'Hora', day: 'Día', week: 'Semana', month: 'Mes' };

const pad = (n) => String(n).padStart(2, '0');
// Fechas en hora de Colombia (UTC−5, sin horario de verano)
function bogota(d) {
  const t = new Date(new Date(d).getTime() - 5 * 3600 * 1000);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate(), h: t.getUTCHours(), mi: t.getUTCMinutes() };
}
const fmtDate = (d) => {
  const b = bogota(d);
  return `${pad(b.d)}/${pad(b.m)}/${b.y}`;
};
const fmtTime = (d) => {
  const b = bogota(d);
  const h12 = b.h % 12 || 12;
  return `${h12}:${pad(b.mi)} ${b.h < 12 ? 'a. m.' : 'p. m.'}`;
};
const cop = (n) => `$ ${String(Math.round(n || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, '.')}`;

function bucketLabel(bucket, unit) {
  if (unit === 'hour') return `${fmtTime(bucket)}`;
  if (unit === 'month') {
    const b = bogota(bucket);
    return `${pad(b.m)}/${b.y}`;
  }
  return fmtDate(bucket);
}

async function collect(req, filters) {
  const [summary, closures, site] = await Promise.all([
    reports.summary(req, filters),
    reports.closures(req, filters),
    query('SELECT name FROM sites WHERE id = $1', [Number(filters.siteId)]),
  ]);
  return { summary, closures, siteName: site.rows[0]?.name ?? '' };
}

async function toXlsx(req, filters) {
  const { summary, closures, siteName } = await collect(req, filters);
  const k = summary.kpis;
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Nexo.app';
  wb.created = new Date();

  const resumen = wb.addWorksheet('Resumen');
  resumen.columns = [{ width: 32 }, { width: 18 }];
  resumen.addRow([`Reporte ${siteName}`]).font = { bold: true, size: 14 };
  resumen.addRow([`Del ${summary.range.from.split('-').reverse().join('/')} al ${summary.range.to.split('-').reverse().join('/')}`]);
  resumen.addRow([]);
  const kpiRows = [
    ['Vehículos (entradas)', k.vehicles, false],
    ['Salidas', k.exits, false],
    ['Ventas de parqueadero', k.sales, true],
    ['Ingresos manuales', k.incomes, true],
    ['Ingresos totales', k.income, true],
    ['Egresos', k.expenses, true],
    ['Ganancia neta', k.net, true],
    ['Efectivo (ventas)', k.cash, true],
    ['Electrónico (ventas)', k.electronic, true],
    ['Descuentos', k.discounts, true],
    ['Pendientes sin cobrar', k.pendingOpen, true],
  ];
  for (const [label, value, money] of kpiRows) {
    const row = resumen.addRow([label, value]);
    if (money) row.getCell(2).numFmt = MONEY_FMT;
  }

  const serie = wb.addWorksheet('Por período');
  serie.columns = [
    { header: GRAN_LABEL[summary.granularity], key: 'label', width: 16 },
    { header: 'Ingresos', key: 'income', width: 16, style: { numFmt: MONEY_FMT } },
    { header: 'Ventas', key: 'sales', width: 16, style: { numFmt: MONEY_FMT } },
    { header: 'Egresos', key: 'expenses', width: 16, style: { numFmt: MONEY_FMT } },
    { header: 'Entradas', key: 'entries', width: 12 },
    { header: 'Salidas', key: 'exits', width: 12 },
  ];
  serie.getRow(1).font = { bold: true };
  for (const s of summary.series) serie.addRow({ ...s, label: bucketLabel(s.bucket, summary.granularity) });

  const cierres = wb.addWorksheet('Cierres de caja');
  cierres.columns = [
    { header: 'Zona', key: 'zone', width: 14 },
    { header: 'Operador', key: 'user', width: 22 },
    { header: 'Apertura', key: 'opened', width: 20 },
    { header: 'Cierre', key: 'closed', width: 20 },
    { header: 'Tipo', key: 'type', width: 12 },
    { header: 'Ventas', key: 'totalSales', width: 14, style: { numFmt: MONEY_FMT } },
    { header: 'Debía haber', key: 'expectedInDrawer', width: 14, style: { numFmt: MONEY_FMT } },
    { header: 'Contado', key: 'counted', width: 14, style: { numFmt: MONEY_FMT } },
    { header: 'Diferencia', key: 'difference', width: 14, style: { numFmt: MONEY_FMT } },
  ];
  cierres.getRow(1).font = { bold: true };
  for (const c of closures) {
    cierres.addRow({
      ...c,
      opened: `${fmtDate(c.openedAt)} ${fmtTime(c.openedAt)}`,
      closed: `${fmtDate(c.closedAt)} ${fmtTime(c.closedAt)}`,
      type: c.closeType === 'HANDOVER' ? 'Entrega' : 'Cierre',
    });
  }
  return wb.xlsx.writeBuffer();
}

function toPdf(req, filters) {
  return collect(req, filters).then(
    ({ summary, closures, siteName }) =>
      new Promise((resolve, reject) => {
        const doc = new PDFDocument({ size: 'LETTER', margin: 40 });
        const chunks = [];
        doc.on('data', (c) => chunks.push(c));
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);
        const k = summary.kpis;
        const navy = '#0b2748';

        doc.fillColor(navy).fontSize(18).text(`Reporte · ${siteName}`);
        doc.fillColor('#555').fontSize(10).text(
          `Del ${summary.range.from.split('-').reverse().join('/')} al ${summary.range.to.split('-').reverse().join('/')} · generado ${fmtDate(new Date())} ${fmtTime(new Date())}`,
        );
        doc.moveDown();

        // KPIs en dos columnas
        const kpis = [
          ['Vehículos', String(k.vehicles)], ['Ingresos', cop(k.income)], ['Egresos', cop(k.expenses)],
          ['Ganancia neta', cop(k.net)], ['Efectivo', cop(k.cash)], ['Electrónico', cop(k.electronic)],
          ['Descuentos', cop(k.discounts)], ['Pendientes', cop(k.pendingOpen)],
        ];
        const startY = doc.y;
        kpis.forEach(([label, value], i) => {
          const x = 40 + (i % 4) * 133;
          const y = startY + Math.floor(i / 4) * 42;
          doc.roundedRect(x, y, 125, 36, 4).strokeColor('#e3e8ee').stroke();
          doc.fillColor('#6b7686').fontSize(8).text(label.toUpperCase(), x + 8, y + 6);
          doc.fillColor(navy).fontSize(12).text(value, x + 8, y + 18);
        });
        doc.y = startY + 92;

        // Barras de ingresos por período (una serie; la tabla de abajo trae los valores)
        const max = Math.max(1, ...summary.series.map((s) => s.income));
        const chartX = 40;
        const chartY = doc.y + 10;
        const chartW = 532;
        const chartH = 110;
        doc.fillColor(navy).fontSize(11).text(`Ingresos por ${GRAN_LABEL[summary.granularity].toLowerCase()}`, chartX, doc.y);
        const n = summary.series.length || 1;
        const barW = Math.max(1, chartW / n - 2);
        summary.series.forEach((s, i) => {
          const h = (s.income / max) * chartH;
          doc.rect(chartX + i * (chartW / n), chartY + 14 + chartH - h, barW, h).fill('#2a78d6');
        });
        doc.moveTo(chartX, chartY + 14 + chartH).lineTo(chartX + chartW, chartY + 14 + chartH).strokeColor('#d0d7e0').stroke();
        doc.y = chartY + chartH + 30;

        const table = (title, headers, widths, rows) => {
          doc.fillColor(navy).fontSize(11).text(title, 40, doc.y);
          doc.moveDown(0.3);
          const drawRow = (cells, bold) => {
            if (doc.y > 720) doc.addPage();
            const y = doc.y;
            let x = 40;
            cells.forEach((c, i) => {
              doc.fillColor(bold ? '#6b7686' : '#1c2430').fontSize(bold ? 8 : 9).text(String(c), x, y, { width: widths[i] - 4, align: i === 0 ? 'left' : 'right' });
              x += widths[i];
            });
            doc.y = y + 14;
          };
          drawRow(headers, true);
          rows.forEach((r) => drawRow(r, false));
          doc.moveDown();
        };

        table(
          'Detalle por período',
          [GRAN_LABEL[summary.granularity], 'Ingresos', 'Egresos', 'Entradas', 'Salidas'],
          [140, 110, 110, 86, 86],
          summary.series.filter((s) => s.income || s.expenses || s.entries || s.exits)
            .map((s) => [bucketLabel(s.bucket, summary.granularity), cop(s.income), cop(s.expenses), s.entries, s.exits]),
        );
        table(
          'Cierres de caja',
          ['Zona · operador', 'Cierre', 'Ventas', 'Debía haber', 'Contado', 'Diferencia'],
          [150, 100, 70, 72, 70, 70],
          closures.map((c) => [`${c.zone} · ${c.user}`, `${fmtDate(c.closedAt)} ${fmtTime(c.closedAt)}`, cop(c.totalSales), cop(c.expectedInDrawer), cop(c.counted), cop(c.difference)]),
        );
        doc.end();
      }),
  );
}

module.exports = { toXlsx, toPdf };
