// Pendientes (RF12): cobros de salidas que no se cobraron al salir (mensualidad nocturna fuera de
// franja o "Pendiente" a mano). Se listan agrupados por mensualidad o por placa y se confirman en
// grupo: el pago entra a la caja abierta en ese momento y la venta cuenta el día de la confirmación.
const { query, withTransaction } = require('../db/pool');
const HttpError = require('../middlewares/httpError');
const { assertSiteAccess } = require('../middlewares/authorize');
const { VEHICLE_LABELS } = require('../lib/plates');
const { splitPayment, resolveCharge } = require('../lib/payments');
const { recordAudit } = require('./audit.service');
const { requireOpenShift } = require('./shifts.service');
const { publish } = require('../realtime/bus');

async function listPending(req, rawSiteId) {
  const siteId = Number.parseInt(rawSiteId, 10);
  if (!Number.isInteger(siteId)) throw new HttpError(400, 'Indique la sede', { code: 'VALIDATION_ERROR' });
  await assertSiteAccess(req, siteId);

  const { rows } = await query(
    `SELECT pc.id, pc.plate, pc.amount, pc.reason, pc.created_at, pc.monthly_plan_id,
            mp.client_name, e.id AS entry_id, e.vehicle_type, e.entry_at, e.exit_at,
            e.receipt_prefix, e.receipt_number, e.discount_amount, e.discount_reason
       FROM pending_charges pc
       JOIN entries e ON e.id = pc.entry_id
       LEFT JOIN monthly_plans mp ON mp.id = pc.monthly_plan_id
      WHERE pc.site_id = $1 AND pc.confirmed_at IS NULL
      ORDER BY pc.created_at`,
    [siteId],
  );

  // Una fila por mensualidad (o por placa si no tiene), con el total y el detalle de salidas
  const groups = new Map();
  for (const r of rows) {
    const key = r.monthly_plan_id ? `M${r.monthly_plan_id}` : `P${r.plate}`;
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        plate: r.plate,
        vehicleLabel: VEHICLE_LABELS[r.vehicle_type],
        monthlyPlanId: r.monthly_plan_id,
        clientName: r.client_name,
        total: 0,
        lastExitAt: null,
        charges: [],
      });
    }
    const g = groups.get(key);
    g.total += r.amount;
    g.lastExitAt = r.exit_at;
    g.charges.push({
      id: r.id,
      entryId: r.entry_id,
      receipt: `${r.receipt_prefix}${r.receipt_number}`,
      entryAt: r.entry_at,
      exitAt: r.exit_at,
      amount: r.amount,
      reason: r.reason,
      discountAmount: r.discount_amount,
      discountReason: r.discount_reason,
    });
  }
  return [...groups.values()].sort((a, b) => new Date(b.lastExitAt) - new Date(a.lastExitAt));
}

/**
 * Confirma el pago de varios cargos de una misma sede.
 * body: { chargeIds, paymentMethod, cashAmount?, chargedAmount?, discountReason?, shiftId? }
 * El descuento y el efectivo se reparten entre las salidas (de mayor a menor valor) para que cada
 * venta cuadre por sí sola (efectivo + electrónico = valor cobrado).
 */
async function confirmPending(req, body) {
  const ids = Array.isArray(body?.chargeIds) ? [...new Set(body.chargeIds.map(Number))] : [];
  if (!ids.length || !ids.every((id) => Number.isInteger(id) && id > 0)) {
    throw new HttpError(400, 'Seleccione los cobros a confirmar', { code: 'VALIDATION_ERROR' });
  }

  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT pc.id, pc.site_id, pc.entry_id, pc.amount, pc.confirmed_at, e.discount_amount, e.discount_reason
         FROM pending_charges pc JOIN entries e ON e.id = pc.entry_id
        WHERE pc.id = ANY($1::bigint[])
        ORDER BY pc.amount DESC, pc.id
        FOR UPDATE OF pc, e`,
      [ids],
    );
    if (rows.length !== ids.length) throw new HttpError(404, 'Algún cobro no existe', { code: 'NOT_FOUND' });
    const siteIds = new Set(rows.map((r) => r.site_id));
    if (siteIds.size !== 1) throw new HttpError(400, 'Los cobros deben ser de la misma sede', { code: 'VALIDATION_ERROR' });
    const siteId = rows[0].site_id;
    await assertSiteAccess(req, siteId);
    if (rows.some((r) => r.confirmed_at)) {
      throw new HttpError(409, 'Alguno de estos cobros ya fue confirmado', { code: 'PENDING_ALREADY_CONFIRMED' });
    }

    // El dinero entra a la caja del turno indicado (por defecto, el del usuario)
    const shiftId = body.shiftId ? Number.parseInt(body.shiftId, 10) : null;
    const shift = await requireOpenShift(client, req.user, siteId, { shiftId, lock: true });

    const total = rows.reduce((s, r) => s + r.amount, 0);
    const charge = resolveCharge(total, body.chargedAmount, body.discountReason);
    const split = splitPayment(body.paymentMethod, charge.charged, body.cashAmount);

    let discountLeft = charge.discount;
    let cashLeft = split.cash;
    for (const r of rows) {
      const discount = Math.min(r.amount, discountLeft);
      discountLeft -= discount;
      const charged = r.amount - discount;
      const cash = Math.min(charged, cashLeft);
      cashLeft -= cash;
      const electronic = charged - cash;
      let method;
      if (charged === 0) method = body.paymentMethod === 'ELECTRONIC' ? 'ELECTRONIC' : 'CASH';
      else if (electronic === 0) method = 'CASH';
      else if (cash === 0) method = 'ELECTRONIC';
      else method = 'MIXED';

      const reasons = [r.discount_reason, discount > 0 ? charge.reason : null].filter(Boolean);
      await client.query(
        `UPDATE entries
            SET status = 'PAID', charged_amount = $2, discount_amount = discount_amount + $3,
                discount_reason = $4, payment_method = $5, cash_amount = $6, electronic_amount = $7,
                cash_register_id = $8, paid_at = now()
          WHERE id = $1`,
        [r.entry_id, charged, discount, reasons.length ? reasons.join(' · ') : null, method, cash, electronic,
          shift.cashRegisterId],
      );
      await client.query(
        'UPDATE pending_charges SET confirmed_at = now(), confirmed_by = $2, cash_register_id = $3 WHERE id = $1',
        [r.id, req.user.id, shift.cashRegisterId],
      );
    }

    await recordAudit(
      {
        req,
        userId: req.user.id,
        siteId,
        action: 'PENDING_CONFIRMED',
        entityType: 'pending_charge',
        entityId: ids.join(','),
        details: {
          total,
          charged: charge.charged,
          discount: charge.discount,
          discountReason: charge.reason,
          paymentMethod: body.paymentMethod,
          cash: split.cash,
          electronic: split.electronic,
          cashRegisterId: shift.cashRegisterId,
        },
      },
      client,
    );
    return { confirmed: ids.length, total, charged: charge.charged, discount: charge.discount, cashRegisterId: shift.cashRegisterId, siteId };
  }).then((r) => {
    publish(r.siteId, 'pending:changed', { confirmed: r.confirmed });
    publish(r.siteId, 'sales:changed', {});
    return r;
  });
}

module.exports = { listPending, confirmPending };
