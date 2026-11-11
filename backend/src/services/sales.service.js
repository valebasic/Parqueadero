// Ventas (RF19): salidas cobradas. Listado con filtros, cambio de forma de pago con motivo y
// reimpresión del recibo (ambas acciones quedan en auditoría).
const { query, withTransaction } = require('../db/pool');
const HttpError = require('../middlewares/httpError');
const { assertSiteAccess, canAccessSite } = require('../middlewares/authorize');
const { normalizePlate, VEHICLE_LABELS } = require('../lib/plates');
const { splitPayment, requireReason, PAYMENT_LABELS } = require('../lib/payments');
const { recordAudit } = require('./audit.service');
const { buildReceipt } = require('./receipts.service');

const PAGE_SIZE = 10; // como en la v1.0
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function toSaleDto(r) {
  return {
    id: r.id,
    receipt: `${r.receipt_prefix}${r.receipt_number}`,
    plate: r.plate,
    vehicleType: r.vehicle_type,
    vehicleLabel: VEHICLE_LABELS[r.vehicle_type],
    entryAt: r.entry_at,
    exitAt: r.exit_at,
    paidAt: r.paid_at,
    calculatedAmount: r.calculated_amount,
    discountAmount: r.discount_amount,
    discountReason: r.discount_reason,
    chargedAmount: r.charged_amount,
    paymentMethod: r.payment_method,
    paymentLabel: PAYMENT_LABELS[r.payment_method],
    cashAmount: r.cash_amount,
    electronicAmount: r.electronic_amount,
    cashRegisterId: r.cash_register_id,
    registerOpen: r.register_open,
    exitBy: r.exit_by_name,
  };
}

/**
 * filtros: siteId (obligatorio), from/to (AAAA-MM-DD, por fecha de salida en hora de Colombia),
 * q (placa o recibo, con o sin prefijo), method (CASH|ELECTRONIC|MIXED), page (desde 1).
 */
async function listSales(req, filters) {
  const siteId = Number.parseInt(filters.siteId, 10);
  if (!Number.isInteger(siteId)) throw new HttpError(400, 'Indique la sede', { code: 'VALIDATION_ERROR' });
  await assertSiteAccess(req, siteId);

  const from = DATE_RE.test(filters.from ?? '') ? filters.from : null;
  const to = DATE_RE.test(filters.to ?? '') ? filters.to : null;
  const method = ['CASH', 'ELECTRONIC', 'MIXED'].includes(filters.method) ? filters.method : null;
  const q = normalizePlate(filters.q ?? '');
  const receiptDigits = /^[A-Z]{0,5}(\d+)$/.exec(q)?.[1] ?? null;
  const page = Math.max(1, Number.parseInt(filters.page, 10) || 1);

  const where = `
    e.site_id = $1 AND e.status = 'PAID'
    AND ($2::date IS NULL OR e.exit_at >= $2::date)
    AND ($3::date IS NULL OR e.exit_at < $3::date + 1)
    AND ($4::text IS NULL OR e.payment_method = $4)
    AND ($5::text = '' OR e.plate LIKE '%' || $5 || '%' OR e.receipt_number::text = $6)`;
  const params = [siteId, from, to, method, q, receiptDigits];

  const [list, totals] = await Promise.all([
    query(
      `SELECT e.*, u.full_name AS exit_by_name, (cr.closed_at IS NULL) AS register_open
         FROM entries e
         LEFT JOIN users u ON u.id = e.exit_by
         LEFT JOIN cash_registers cr ON cr.id = e.cash_register_id
        WHERE ${where}
        ORDER BY e.exit_at DESC, e.id DESC
        LIMIT ${PAGE_SIZE} OFFSET $7`,
      [...params, (page - 1) * PAGE_SIZE],
    ),
    query(
      `SELECT count(*) AS count, COALESCE(sum(charged_amount), 0) AS total,
              COALESCE(sum(cash_amount), 0) AS cash, COALESCE(sum(electronic_amount), 0) AS electronic,
              COALESCE(sum(discount_amount), 0) AS discounts
         FROM entries e WHERE ${where}`,
      params,
    ),
  ]);
  const t = totals.rows[0];
  return {
    items: list.rows.map(toSaleDto),
    page,
    pageSize: PAGE_SIZE,
    count: t.count,
    totals: { charged: t.total, cash: t.cash, electronic: t.electronic, discounts: t.discounts },
  };
}

/**
 * Cambia la forma de pago de una venta (motivo obligatorio). paymentMethod puede ser 'PENDING':
 * la venta sale de Ventas y Caja y queda en Pendientes (como el lápiz de Ventas en la v1.0).
 * AS/AG: cualquier venta de sus sedes. OP: solo ventas de su caja abierta.
 */
async function changePaymentMethod(req, rawId, body) {
  const id = Number.parseInt(rawId, 10);
  const reason = requireReason(body?.reason, 'Escriba el motivo del cambio de forma de pago');
  const method = body?.paymentMethod;

  await withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT e.*, cr.closed_at AS register_closed_at, sh.user_id AS register_owner
         FROM entries e
         LEFT JOIN cash_registers cr ON cr.id = e.cash_register_id
         LEFT JOIN shifts sh ON sh.id = cr.shift_id
        WHERE e.id = $1
        FOR UPDATE OF e`,
      [id],
    );
    const sale = rows[0];
    if (!sale) throw new HttpError(404, 'Venta no encontrada', { code: 'NOT_FOUND' });
    await assertSiteAccess(req, sale.site_id);
    if (sale.status !== 'PAID') throw new HttpError(409, 'Solo se puede cambiar una venta cobrada', { code: 'NOT_A_SALE' });

    const isAdmin = ['AS', 'AG'].includes(req.user.role) && canAccessSite(req.user, sale.site_id);
    const ownOpenRegister = sale.register_closed_at === null && sale.register_owner === req.user.id;
    if (!isAdmin && !ownOpenRegister) {
      throw new HttpError(403, 'Solo puede cambiar ventas de su caja abierta. Pida el cambio a un administrador.', {
        code: 'FORBIDDEN_SALE',
      });
    }

    const before = {
      paymentMethod: sale.payment_method,
      cashAmount: sale.cash_amount,
      electronicAmount: sale.electronic_amount,
    };
    let after;

    if (method === 'PENDING') {
      await client.query(
        `UPDATE entries
            SET status = 'PENDING_CHARGE', payment_method = NULL, cash_amount = 0, electronic_amount = 0,
                cash_register_id = NULL, paid_at = NULL
          WHERE id = $1`,
        [id],
      );
      await client.query(
        `INSERT INTO pending_charges (site_id, entry_id, monthly_plan_id, plate, amount, reason, created_by)
         VALUES ($1, $2, $3, $4, $5, 'MANUAL', $6)
         ON CONFLICT (entry_id) DO UPDATE
           SET amount = EXCLUDED.amount, reason = 'MANUAL', created_by = EXCLUDED.created_by, created_at = now(),
               confirmed_at = NULL, confirmed_by = NULL, cash_register_id = NULL`,
        [sale.site_id, id, sale.monthly_plan_id, sale.plate, sale.charged_amount, req.user.id],
      );
      after = { paymentMethod: 'PENDING' };
    } else {
      const split = splitPayment(method, sale.charged_amount, body?.cashAmount);
      if (method === sale.payment_method && split.cash === sale.cash_amount) {
        throw new HttpError(400, 'No hay cambios: la forma de pago es la misma', { code: 'VALIDATION_ERROR' });
      }
      await client.query(
        'UPDATE entries SET payment_method = $2, cash_amount = $3, electronic_amount = $4 WHERE id = $1',
        [id, method, split.cash, split.electronic],
      );
      after = { paymentMethod: method, cashAmount: split.cash, electronicAmount: split.electronic };
    }

    await recordAudit(
      {
        req,
        userId: req.user.id,
        siteId: sale.site_id,
        action: 'SALE_PAYMENT_CHANGED',
        entityType: 'entry',
        entityId: id,
        details: {
          receipt: `${sale.receipt_prefix}${sale.receipt_number}`,
          before,
          after,
          reason,
          registerClosed: sale.register_closed_at !== null,
        },
      },
      client,
    );
  });

  const { rows } = await query(
    `SELECT e.*, u.full_name AS exit_by_name, (cr.closed_at IS NULL) AS register_open
       FROM entries e LEFT JOIN users u ON u.id = e.exit_by LEFT JOIN cash_registers cr ON cr.id = e.cash_register_id
      WHERE e.id = $1`,
    [id],
  );
  return rows[0].status === 'PAID' ? toSaleDto(rows[0]) : { id, status: rows[0].status };
}

// Reimpresión desde Ventas: devuelve el recibo y deja constancia en auditoría
async function reprintReceipt(req, rawId) {
  const id = Number.parseInt(rawId, 10);
  const { rows } = await query('SELECT id, site_id, status, receipt_prefix, receipt_number FROM entries WHERE id = $1', [id]);
  const entry = rows[0];
  if (!entry) throw new HttpError(404, 'Venta no encontrada', { code: 'NOT_FOUND' });
  await assertSiteAccess(req, entry.site_id);
  const receipt = await buildReceipt({ query: (t, p) => query(t, p) }, id);
  await recordAudit({
    req,
    userId: req.user.id,
    siteId: entry.site_id,
    action: 'RECEIPT_REPRINTED',
    entityType: 'entry',
    entityId: id,
    details: { receipt: receipt.receipt },
  });
  return receipt;
}

module.exports = { listSales, changePaymentMethod, reprintReceipt, PAGE_SIZE };
