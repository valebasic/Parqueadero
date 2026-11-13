// Resumen de una caja (una por turno).
//
//   Base del día      = base inicial + Base+ − Base−             (no suma al esperado; regla de la v1.0)
//   Efectivo esperado = efectivo de ventas + ingresos − egresos  (fórmula del README de la v1.0)
//   Debe haber en el cajón = base del día + efectivo esperado    (contra esto se compara el arqueo)
//
// Ventas = salidas cobradas (entries PAID) registradas en esta caja, incluidos los cargos pendientes
// que se confirmaron aquí. Los pagos de mensualidad no pasan por caja.

async function registerSummary(client, cashRegisterId) {
  const { rows } = await client.query(
    `SELECT cr.id, cr.initial_cash, cr.opened_at, cr.closed_at,
            COALESCE(s.cash, 0)        AS cash_sales,
            COALESCE(s.electronic, 0)  AS electronic_sales,
            COALESCE(s.total, 0)       AS total_sales,
            COALESCE(s.discounts, 0)   AS discounts,
            COALESCE(s.count, 0)       AS sales_count,
            COALESCE(m.income, 0)      AS incomes,
            COALESCE(m.expense, 0)     AS expenses,
            COALESCE(m.base_in, 0)     AS base_in,
            COALESCE(m.base_out, 0)    AS base_out
       FROM cash_registers cr
       LEFT JOIN LATERAL (
         SELECT sum(cash_amount) AS cash, sum(electronic_amount) AS electronic, sum(charged_amount) AS total,
                sum(discount_amount) AS discounts, count(*) AS count
           FROM entries WHERE cash_register_id = cr.id AND status = 'PAID'
       ) s ON true
       LEFT JOIN LATERAL (
         SELECT sum(amount) FILTER (WHERE type = 'INCOME')   AS income,
                sum(amount) FILTER (WHERE type = 'EXPENSE')  AS expense,
                sum(amount) FILTER (WHERE type = 'BASE_IN')  AS base_in,
                sum(amount) FILTER (WHERE type = 'BASE_OUT') AS base_out
           FROM cash_movements WHERE cash_register_id = cr.id AND deleted_at IS NULL
       ) m ON true
      WHERE cr.id = $1`,
    [cashRegisterId],
  );
  const r = rows[0];
  if (!r) return null;
  const n = (v) => Number(v) || 0;
  const baseFinal = n(r.initial_cash) + n(r.base_in) - n(r.base_out);
  const expectedCash = n(r.cash_sales) + n(r.incomes) - n(r.expenses);
  return {
    cashRegisterId: r.id,
    openedAt: r.opened_at,
    closedAt: r.closed_at,
    initialCash: n(r.initial_cash),
    baseIn: n(r.base_in),
    baseOut: n(r.base_out),
    baseFinal,
    cashSales: n(r.cash_sales),
    electronicSales: n(r.electronic_sales),
    totalSales: n(r.total_sales),
    discounts: n(r.discounts),
    salesCount: n(r.sales_count),
    incomes: n(r.incomes),
    expenses: n(r.expenses),
    expectedCash,
    expectedInDrawer: baseFinal + expectedCash,
  };
}

module.exports = { registerSummary };
