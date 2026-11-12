// Transacciones (RF18): ingresos, egresos y movimientos de base de la caja.
//   INCOME (verde) suma al efectivo esperado · EXPENSE (rojo) resta · BASE_IN/BASE_OUT (naranja)
//   solo cambian la base del día. Registrar exige caja abierta.
//   - Editar solo el mismo día calendario (hora de Colombia) en que se registró.
//   - La base nunca queda negativa; los movimientos de base de una caja cerrada (y los retiros de
//     turno) no se tocan.
//   - El OP registra ingresos y egresos en su caja; cada egreso tiene un tope (sites.op_expense_limit).
//     Los movimientos de base y la edición de movimientos ajenos son de AS/AG.
const { query, withTransaction } = require('../db/pool');
const HttpError = require('../middlewares/httpError');
const { assertSiteAccess, canAccessSite } = require('../middlewares/authorize');
const { MAX_MONEY } = require('../lib/payments');
const { isDate } = require('../lib/dates');
const { recordAudit } = require('./audit.service');
const { requireOpenShift } = require('./shifts.service');
const { registerSummary } = require('./cash.service');
const { publish } = require('../realtime/bus');

const TYPES = ['INCOME', 'EXPENSE', 'BASE_IN', 'BASE_OUT'];
const BASE_TYPES = ['BASE_IN', 'BASE_OUT'];
const TYPE_LABELS = { INCOME: 'Ingreso', EXPENSE: 'Egreso', BASE_IN: 'Base +', BASE_OUT: 'Base −' };
const PAGE_SIZE = 10;

const isAdmin = (user) => user.role === 'AG' || user.role === 'AS';

function validate(body, { partial = false } = {}) {
  const out = {};
  if (!partial || body.type !== undefined) {
    if (!TYPES.includes(body.type)) {
      throw new HttpError(400, 'Elija el tipo: ingreso, egreso, agregar a la base o quitar de la base', { code: 'VALIDATION_ERROR' });
    }
    out.type = body.type;
  }
  if (!partial || body.amount !== undefined) {
    if (!Number.isInteger(body.amount) || body.amount <= 0 || body.amount > MAX_MONEY) {
      throw new HttpError(400, 'El valor debe ser un número entero mayor que $ 0', { code: 'VALIDATION_ERROR' });
    }
    out.amount = body.amount;
  }
  if (body.concept !== undefined) out.concept = String(body.concept ?? '').trim().slice(0, 200) || null;
  return out;
}

function toDto(r, user) {
  const sameDay = r.created_day === r.today;
  const baseLocked = BASE_TYPES.includes(r.type) && r.register_closed;
  const own = r.created_by === user.id && !r.register_closed && r.shift_user_id === user.id;
  const mayTouch = !r.withdrawal_to && !baseLocked && (isAdmin(user) || own);
  return {
    id: r.id,
    type: r.type,
    typeLabel: TYPE_LABELS[r.type],
    amount: r.amount,
    concept: r.concept,
    withdrawalTo: r.withdrawal_to,
    createdAt: r.created_at,
    createdBy: r.created_by_name,
    zone: r.zone_name,
    cashRegisterId: r.cash_register_id,
    registerClosed: r.register_closed,
    canEdit: mayTouch && sameDay,
    canDelete: mayTouch,
  };
}

const MOVEMENT_SELECT = `
  SELECT m.*, u.full_name AS created_by_name, z.name AS zone_name, sh.user_id AS shift_user_id,
         (cr.closed_at IS NOT NULL) AS register_closed, cr.site_id,
         (m.created_at::date)::text AS created_day, CURRENT_DATE::text AS today
    FROM cash_movements m
    JOIN cash_registers cr ON cr.id = m.cash_register_id
    JOIN shifts sh ON sh.id = cr.shift_id
    JOIN zones z ON z.id = sh.zone_id
    LEFT JOIN users u ON u.id = m.created_by`;

async function listMovements(req, filters) {
  const siteId = Number.parseInt(filters.siteId, 10);
  if (!Number.isInteger(siteId)) throw new HttpError(400, 'Indique la sede', { code: 'VALIDATION_ERROR' });
  await assertSiteAccess(req, siteId);
  const from = isDate(filters.from) ? filters.from : null;
  const to = isDate(filters.to) ? filters.to : null;
  const page = Math.max(1, Number.parseInt(filters.page, 10) || 1);
  const where = `cr.site_id = $1 AND m.deleted_at IS NULL
    AND ($2::date IS NULL OR m.created_at >= $2::date) AND ($3::date IS NULL OR m.created_at < $3::date + 1)`;
  const [list, count] = await Promise.all([
    query(`${MOVEMENT_SELECT} WHERE ${where} ORDER BY m.created_at DESC, m.id DESC LIMIT ${PAGE_SIZE} OFFSET $4`, [
      siteId,
      from,
      to,
      (page - 1) * PAGE_SIZE,
    ]),
    query(
      `SELECT count(*) AS n FROM cash_movements m JOIN cash_registers cr ON cr.id = m.cash_register_id WHERE ${where}`,
      [siteId, from, to],
    ),
  ]);
  return { items: list.rows.map((r) => toDto(r, req.user)), page, pageSize: PAGE_SIZE, count: count.rows[0].n };
}

async function checkOperatorRules(client, user, { type, amount, siteId }) {
  if (isAdmin(user)) return;
  if (BASE_TYPES.includes(type)) {
    throw new HttpError(403, 'Los movimientos de base los registra un administrador', { code: 'FORBIDDEN_ROLE' });
  }
  if (type === 'EXPENSE') {
    const { rows } = await client.query('SELECT op_expense_limit FROM sites WHERE id = $1', [siteId]);
    const limit = rows[0].op_expense_limit;
    if (amount > limit) {
      throw new HttpError(403, `Un operador puede registrar egresos de hasta $ ${limit.toLocaleString('es-CO')}. Pida a un administrador los mayores.`, {
        code: 'EXPENSE_LIMIT',
        details: { limit },
      });
    }
  }
}

// La base del día (inicial + Base+ − Base−) nunca puede quedar negativa
async function assertBaseNotNegative(client, cashRegisterId) {
  const s = await registerSummary(client, cashRegisterId);
  if (s.baseFinal < 0) {
    throw new HttpError(409, `La base no puede quedar negativa (quedaría en $ ${s.baseFinal.toLocaleString('es-CO')})`, {
      code: 'BASE_NEGATIVE',
    });
  }
}

async function createMovement(req, body) {
  const data = validate(body ?? {});
  const id = await withTransaction(async (client) => {
    const siteId = body?.siteId ? Number.parseInt(body.siteId, 10) : null;
    const shiftId = body?.shiftId ? Number.parseInt(body.shiftId, 10) : null;
    const shift = await requireOpenShift(client, req.user, siteId, { shiftId, lock: true });
    await checkOperatorRules(client, req.user, { ...data, siteId: shift.siteId });
    const { rows } = await client.query(
      `INSERT INTO cash_movements (cash_register_id, type, amount, concept, created_by)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [shift.cashRegisterId, data.type, data.amount, data.concept ?? null, req.user.id],
    );
    if (data.type === 'BASE_OUT') await assertBaseNotNegative(client, shift.cashRegisterId);
    await recordAudit(
      { req, userId: req.user.id, siteId: shift.siteId, action: 'CASH_MOVEMENT_CREATED', entityType: 'cash_movement', entityId: rows[0].id, details: data },
      client,
    );
    return rows[0].id;
  });
  const { rows } = await query(`${MOVEMENT_SELECT} WHERE m.id = $1`, [id]);
  publish(rows[0].site_id, 'cash:movement', { action: 'created', id, type: rows[0].type, amount: rows[0].amount });
  return toDto(rows[0], req.user);
}

// Carga y bloquea el movimiento, y aplica las reglas comunes de edición/eliminación
async function lockForChange(client, req, rawId) {
  const id = Number.parseInt(rawId, 10);
  const { rows } = await client.query(`${MOVEMENT_SELECT} WHERE m.id = $1 AND m.deleted_at IS NULL FOR UPDATE OF m`, [id]);
  const m = rows[0];
  if (!m) throw new HttpError(404, 'Movimiento no encontrado', { code: 'NOT_FOUND' });
  await assertSiteAccess(req, m.site_id);
  if (m.withdrawal_to) {
    throw new HttpError(409, 'Un retiro de turno no se puede modificar', { code: 'WITHDRAWAL_LOCKED' });
  }
  if (!isAdmin(req.user) && !(m.created_by === req.user.id && m.shift_user_id === req.user.id && !m.register_closed)) {
    throw new HttpError(403, 'Solo puede modificar sus propios movimientos de la caja abierta', { code: 'FORBIDDEN_MOVEMENT' });
  }
  return m;
}

async function updateMovement(req, rawId, body) {
  const data = validate(body ?? {}, { partial: true });
  await withTransaction(async (client) => {
    const m = await lockForChange(client, req, rawId);
    if (m.created_day !== m.today) {
      throw new HttpError(409, 'Solo se puede editar el mismo día en que se registró', { code: 'EDIT_SAME_DAY_ONLY' });
    }
    const next = { type: data.type ?? m.type, amount: data.amount ?? m.amount, concept: data.concept !== undefined ? data.concept : m.concept };
    if (m.register_closed && (BASE_TYPES.includes(m.type) || BASE_TYPES.includes(next.type))) {
      throw new HttpError(409, 'Un movimiento de base de una caja cerrada no se puede editar', { code: 'BASE_LOCKED' });
    }
    await checkOperatorRules(client, req.user, { ...next, siteId: m.site_id });
    await client.query(
      'UPDATE cash_movements SET type = $2, amount = $3, concept = $4, updated_by = $5 WHERE id = $1',
      [m.id, next.type, next.amount, next.concept, req.user.id],
    );
    await assertBaseNotNegative(client, m.cash_register_id);
    await recordAudit(
      {
        req,
        userId: req.user.id,
        siteId: m.site_id,
        action: 'CASH_MOVEMENT_UPDATED',
        entityType: 'cash_movement',
        entityId: m.id,
        details: { before: { type: m.type, amount: m.amount, concept: m.concept }, after: next },
      },
      client,
    );
  });
  const { rows } = await query(`${MOVEMENT_SELECT} WHERE m.id = $1`, [Number.parseInt(rawId, 10)]);
  publish(rows[0].site_id, 'cash:movement', { action: 'updated', id: rows[0].id, type: rows[0].type, amount: rows[0].amount });
  return toDto(rows[0], req.user);
}

async function deleteMovement(req, rawId) {
  let siteId = null;
  await withTransaction(async (client) => {
    const m = await lockForChange(client, req, rawId);
    siteId = m.site_id;
    if (m.register_closed && BASE_TYPES.includes(m.type)) {
      throw new HttpError(409, 'Un movimiento de base de una caja cerrada no se puede eliminar', { code: 'BASE_LOCKED' });
    }
    await client.query('UPDATE cash_movements SET deleted_at = now(), deleted_by = $2 WHERE id = $1', [m.id, req.user.id]);
    await assertBaseNotNegative(client, m.cash_register_id);
    await recordAudit(
      {
        req,
        userId: req.user.id,
        siteId: m.site_id,
        action: 'CASH_MOVEMENT_DELETED',
        entityType: 'cash_movement',
        entityId: m.id,
        details: { type: m.type, amount: m.amount, concept: m.concept },
      },
      client,
    );
  });
  publish(siteId, 'cash:movement', { action: 'deleted', id: Number.parseInt(rawId, 10) });
}

module.exports = { listMovements, createMovement, updateMovement, deleteMovement, TYPE_LABELS, canAccessSite };
