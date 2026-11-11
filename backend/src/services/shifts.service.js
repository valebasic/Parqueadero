// Turnos (RF41-RF43): apertura con base contada, entrega/recepción con arqueo y doble firma,
// y cierre sin relevo. La base de datos garantiza un turno abierto por zona y por usuario, y
// exactamente una caja por turno (ver migraciones 4 y 9).
const { query, withTransaction } = require('../db/pool');
const HttpError = require('../middlewares/httpError');
const { assertSiteAccess, canAccessSite } = require('../middlewares/authorize');
const { recordAudit } = require('./audit.service');
const { confirmUserPassword } = require('./auth.service');
const { registerSummary } = require('./cash.service');
const { parseCashCount } = require('../lib/denominations');
const { MAX_MONEY } = require('../lib/payments');

const SHIFT_SELECT = `
  SELECT sh.id, sh.site_id, sh.zone_id, sh.user_id, sh.opened_at, sh.closed_at, sh.close_type, sh.previous_shift_id,
         s.name AS site_name, s.code AS site_code, z.name AS zone_name,
         u.username, u.full_name,
         cr.id AS cash_register_id, cr.initial_cash
    FROM shifts sh
    JOIN sites s ON s.id = sh.site_id
    JOIN zones z ON z.id = sh.zone_id
    JOIN users u ON u.id = sh.user_id
    JOIN cash_registers cr ON cr.shift_id = sh.id`;

function toDto(r, summary) {
  return {
    id: r.id,
    site: { id: r.site_id, code: r.site_code, name: r.site_name },
    zone: { id: r.zone_id, name: r.zone_name },
    user: { id: r.user_id, username: r.username, fullName: r.full_name },
    openedAt: r.opened_at,
    closedAt: r.closed_at,
    closeType: r.close_type,
    previousShiftId: r.previous_shift_id,
    cashRegisterId: r.cash_register_id,
    initialCash: r.initial_cash,
    ...(summary ? { summary } : {}),
  };
}

// Retiro opcional al entregar o cerrar: { amount, receivedBy } (efectivo entregado al administrador).
// Devuelve null si no hay retiro.
function parseWithdrawal(input) {
  if (input == null || input === '' || (typeof input === 'object' && !input.amount)) return null;
  const amount = Number(input.amount);
  if (!Number.isInteger(amount) || amount <= 0 || amount > MAX_MONEY) {
    throw new HttpError(400, 'El retiro debe ser un valor entero mayor que $ 0', { code: 'VALIDATION_ERROR' });
  }
  const receivedBy = typeof input.receivedBy === 'string' ? input.receivedBy.trim().replace(/s+/g, ' ') : '';
  if (receivedBy.length < 3) {
    throw new HttpError(400, 'Indique quién recibe el retiro', { code: 'VALIDATION_ERROR' });
  }
  return { amount, receivedBy: receivedBy.slice(0, 80) };
}

function parseCount(input) {
  try {
    return parseCashCount(input);
  } catch (err) {
    throw new HttpError(400, err.message, { code: 'VALIDATION_ERROR' });
  }
}

// ---------------------------------------------------------------------------
// Consultas
// ---------------------------------------------------------------------------

// Turno abierto del usuario (o null), con el resumen de su caja
async function getCurrentShift(userId) {
  const { rows } = await query(`${SHIFT_SELECT} WHERE sh.user_id = $1 AND sh.closed_at IS NULL`, [userId]);
  if (!rows[0]) return null;
  const summary = await registerSummary({ query: (t, p) => query(t, p) }, rows[0].cash_register_id);
  return toDto(rows[0], summary);
}

// Turnos abiertos de una sede (para elegir zona libre o caja destino)
async function listOpenShifts(req, siteId) {
  await assertSiteAccess(req, siteId);
  const { rows } = await query(`${SHIFT_SELECT} WHERE sh.site_id = $1 AND sh.closed_at IS NULL ORDER BY z.name`, [
    siteId,
  ]);
  return rows.map((r) => toDto(r));
}

/**
 * Turno abierto con el que `user` puede operar en `siteId` (entradas, salidas, cobros).
 * Por defecto el propio; un AS/AG puede indicar `shiftId` de otro turno abierto de la sede
 * (p. ej. para que un cobro quede en esa caja). Lanza 409 NO_OPEN_SHIFT si no hay.
 */
async function requireOpenShift(client, user, siteId, { shiftId = null, lock = false } = {}) {
  const params = shiftId ? [shiftId] : [user.id];
  const where = shiftId ? 'sh.id = $1' : 'sh.user_id = $1';
  const { rows } = await client.query(
    `SELECT sh.id, sh.site_id, sh.zone_id, sh.user_id, cr.id AS cash_register_id
       FROM shifts sh JOIN cash_registers cr ON cr.shift_id = sh.id
      WHERE ${where} AND sh.closed_at IS NULL AND cr.closed_at IS NULL
      ${lock ? 'FOR SHARE OF sh' : ''}`,
    params,
  );
  const shift = rows[0];
  if (!shift || (siteId != null && shift.site_id !== Number(siteId))) {
    throw new HttpError(409, 'No hay un turno abierto en esta sede. Abra un turno en Cierre de caja.', {
      code: 'NO_OPEN_SHIFT',
    });
  }
  if (shiftId && shift.user_id !== user.id && !['AS', 'AG'].includes(user.role)) {
    throw new HttpError(403, 'Solo puede usar su propio turno', { code: 'FORBIDDEN_SHIFT' });
  }
  if (!canAccessSite(user, shift.site_id)) {
    throw new HttpError(403, 'No tiene acceso a esta sede', { code: 'FORBIDDEN_SITE' });
  }
  return { shiftId: shift.id, siteId: shift.site_id, zoneId: shift.zone_id, cashRegisterId: shift.cash_register_id };
}

// ---------------------------------------------------------------------------
// Apertura
// ---------------------------------------------------------------------------

async function openShift(req, body) {
  const zoneId = Number.parseInt(body?.zoneId, 10);
  if (!Number.isInteger(zoneId) || zoneId <= 0) {
    throw new HttpError(400, 'Seleccione la zona', { code: 'VALIDATION_ERROR' });
  }
  const count = parseCount(body?.denominations);

  const { rows: zones } = await query(
    'SELECT z.id, z.site_id, z.is_active, s.is_active AS site_active FROM zones z JOIN sites s ON s.id = z.site_id WHERE z.id = $1',
    [zoneId],
  );
  const zone = zones[0];
  if (!zone) throw new HttpError(404, 'Zona no encontrada', { code: 'NOT_FOUND' });
  await assertSiteAccess(req, zone.site_id);
  if (!zone.is_active || !zone.site_active) {
    throw new HttpError(409, 'La zona o la sede está inactiva', { code: 'ZONE_INACTIVE' });
  }

  const shiftId = await withTransaction(async (client) => {
    let shift;
    try {
      shift = await client.query(
        'INSERT INTO shifts (site_id, zone_id, user_id, notes) VALUES ($1, $2, $3, $4) RETURNING id',
        [zone.site_id, zoneId, req.user.id, body?.notes || null],
      );
    } catch (err) {
      if (err.constraint === 'shifts_one_open_per_user') {
        throw new HttpError(409, 'Ya tiene un turno abierto. Ciérrelo o entréguelo antes de abrir otro.', {
          code: 'SHIFT_ALREADY_OPEN',
        });
      }
      if (err.constraint === 'shifts_one_open_per_zone') {
        throw new HttpError(409, 'Esa zona ya tiene un turno abierto. Pida la entrega del turno.', {
          code: 'ZONE_HAS_OPEN_SHIFT',
        });
      }
      throw err;
    }
    const id = shift.rows[0].id;
    const register = await client.query(
      'INSERT INTO cash_registers (site_id, shift_id, opened_by, initial_cash) VALUES ($1, $2, $3, $4) RETURNING id',
      [zone.site_id, id, req.user.id, count.total],
    );
    await client.query(
      `INSERT INTO cash_counts (cash_register_id, kind, denominations, total, counted_by)
       VALUES ($1, 'OPENING', $2, $3, $4)`,
      [register.rows[0].id, count.denominations, count.total, req.user.id],
    );
    await recordAudit(
      {
        req,
        userId: req.user.id,
        siteId: zone.site_id,
        action: 'SHIFT_OPENED',
        entityType: 'shift',
        entityId: id,
        details: { zoneId, initialCash: count.total },
      },
      client,
    );
    return id;
  });

  return getCurrentShift(req.user.id).then((s) => s ?? { id: shiftId });
}

// ---------------------------------------------------------------------------
// Cierre (con o sin relevo)
// ---------------------------------------------------------------------------

// Bloquea el turno abierto y verifica que el actor pueda cerrarlo/entregarlo
async function lockOpenShift(client, req, shiftId) {
  const { rows } = await client.query(
    `SELECT sh.id, sh.site_id, sh.zone_id, sh.user_id, cr.id AS cash_register_id
       FROM shifts sh JOIN cash_registers cr ON cr.shift_id = sh.id
      WHERE sh.id = $1 AND sh.closed_at IS NULL
      FOR UPDATE OF sh, cr`,
    [shiftId],
  );
  const shift = rows[0];
  if (!shift) throw new HttpError(409, 'El turno ya está cerrado o no existe', { code: 'SHIFT_NOT_OPEN' });
  const isOwner = shift.user_id === req.user.id;
  const isAdmin = ['AS', 'AG'].includes(req.user.role) && canAccessSite(req.user, shift.site_id);
  if (!isOwner && !isAdmin) {
    throw new HttpError(403, 'Solo quien tiene el turno (o un administrador de la sede) puede cerrarlo', {
      code: 'FORBIDDEN_SHIFT',
    });
  }
  return shift;
}

// Cierra caja y turno. `count` es lo que QUEDA en el cajón (después del retiro, si lo hay).
// El retiro se registra antes como "Base -", así el esperado ya lo descuenta.
// Devuelve { summary, difference }.
async function closeRegisterAndShift(client, shift, count, { kind, closedBy, receivedBy = null, notes, closeType, withdrawal = null }) {
  if (withdrawal) {
    await client.query(
      `INSERT INTO cash_movements (cash_register_id, type, amount, concept, created_by, withdrawal_to)
       VALUES ($1, 'BASE_OUT', $2, $3, $4, $5)`,
      [shift.cash_register_id, withdrawal.amount,
        `Retiro al ${kind === 'HANDOVER' ? 'entregar' : 'cerrar'} el turno`, closedBy, withdrawal.receivedBy],
    );
  }
  const summary = await registerSummary(client, shift.cash_register_id);
  const difference = count.total - summary.expectedInDrawer;

  await client.query(
    `INSERT INTO cash_counts (cash_register_id, kind, denominations, total, expected_total, difference,
                              counted_by, received_by, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [shift.cash_register_id, kind, count.denominations, count.total, summary.expectedInDrawer, difference,
      closedBy, receivedBy, notes || null],
  );
  await client.query(
    `UPDATE cash_registers
        SET closed_at = now(), closed_by = $2, physical_cash = $3, expected_cash = $4, difference = $5,
            summary = $6, notes = $7
      WHERE id = $1`,
    [shift.cash_register_id, closedBy, count.total, summary.expectedCash, difference,
      { ...summary, countedTotal: count.total, denominations: count.denominations, withdrawal }, notes || null],
  );
  await client.query("UPDATE shifts SET closed_at = now(), close_type = $2 WHERE id = $1", [shift.id, closeType]);
  return { summary, difference };
}

// Cierre sin relevo
async function closeShift(req, rawShiftId, body) {
  const shiftId = Number.parseInt(rawShiftId, 10);
  const count = parseCount(body?.denominations);
  const withdrawal = parseWithdrawal(body?.withdrawal);

  const result = await withTransaction(async (client) => {
    const shift = await lockOpenShift(client, req, shiftId);
    const closed = await closeRegisterAndShift(client, shift, count, {
      withdrawal,
      kind: 'CLOSING',
      closedBy: req.user.id,
      notes: body?.notes,
      closeType: 'CLOSE',
    });
    await recordAudit(
      {
        req,
        userId: req.user.id,
        siteId: shift.site_id,
        action: 'SHIFT_CLOSED',
        entityType: 'shift',
        entityId: shift.id,
        details: { counted: count.total, expected: closed.summary.expectedInDrawer, difference: closed.difference, withdrawal },
      },
      client,
    );
    return { shiftId: shift.id, ...closed, counted: count.total };
  });

  return {
    shiftId: result.shiftId,
    withdrawal,
    counted: result.counted,
    expectedInDrawer: result.summary.expectedInDrawer,
    difference: result.difference,
    summary: result.summary,
  };
}

// Entrega y recepción en una sola transacción, con la contraseña de ambos
async function handoverShift(req, rawShiftId, body) {
  const shiftId = Number.parseInt(rawShiftId, 10);
  const count = parseCount(body?.denominations);
  const withdrawal = parseWithdrawal(body?.withdrawal);
  if (!body?.incomingUsername) {
    throw new HttpError(400, 'Indique el usuario que recibe el turno', { code: 'VALIDATION_ERROR' });
  }

  const { rows } = await query('SELECT user_id, site_id FROM shifts WHERE id = $1 AND closed_at IS NULL', [shiftId]);
  if (!rows[0]) throw new HttpError(409, 'El turno ya está cerrado o no existe', { code: 'SHIFT_NOT_OPEN' });

  // Firmas: quien entrega (dueño del turno) y quien recibe. Cada intento fallido cuenta para el bloqueo.
  const outgoing = await confirmUserPassword({ userId: rows[0].user_id }, body.outgoingPassword, req, 'SHIFT_HANDOVER');
  const incoming = await confirmUserPassword({ username: body.incomingUsername }, body.incomingPassword, req, 'SHIFT_HANDOVER');
  if (incoming.id === outgoing.id) {
    throw new HttpError(400, 'Quien recibe debe ser un usuario distinto de quien entrega', { code: 'VALIDATION_ERROR' });
  }
  if (!canAccessSite(incoming, rows[0].site_id)) {
    throw new HttpError(403, `${incoming.username} no tiene acceso a esta sede`, { code: 'FORBIDDEN_SITE' });
  }

  const result = await withTransaction(async (client) => {
    const shift = await lockOpenShift(client, req, shiftId);
    const closed = await closeRegisterAndShift(client, shift, count, {
      withdrawal,
      kind: 'HANDOVER',
      closedBy: outgoing.id,
      receivedBy: incoming.id,
      notes: body.notes,
      closeType: 'HANDOVER',
    });

    // Turno nuevo en la misma zona: recibe todo lo contado en el cajón como base
    let next;
    try {
      next = await client.query(
        'INSERT INTO shifts (site_id, zone_id, user_id, previous_shift_id) VALUES ($1, $2, $3, $4) RETURNING id',
        [shift.site_id, shift.zone_id, incoming.id, shift.id],
      );
    } catch (err) {
      if (err.constraint === 'shifts_one_open_per_user') {
        throw new HttpError(409, `${incoming.username} ya tiene otro turno abierto`, { code: 'SHIFT_ALREADY_OPEN' });
      }
      throw err;
    }
    const register = await client.query(
      'INSERT INTO cash_registers (site_id, shift_id, opened_by, initial_cash) VALUES ($1, $2, $3, $4) RETURNING id',
      [shift.site_id, next.rows[0].id, incoming.id, count.total],
    );
    await client.query(
      `INSERT INTO cash_counts (cash_register_id, kind, denominations, total, counted_by)
       VALUES ($1, 'OPENING', $2, $3, $4)`,
      [register.rows[0].id, count.denominations, count.total, incoming.id],
    );
    await recordAudit(
      {
        req,
        userId: req.user.id,
        siteId: shift.site_id,
        action: 'SHIFT_HANDOVER',
        entityType: 'shift',
        entityId: shift.id,
        details: {
          from: outgoing.username,
          to: incoming.username,
          newShiftId: next.rows[0].id,
          counted: count.total,
          expected: closed.summary.expectedInDrawer,
          difference: closed.difference,
          withdrawal,
        },
      },
      client,
    );
    return { closed, newShiftId: next.rows[0].id, siteId: shift.site_id };
  });

  return {
    shiftId,
    newShiftId: result.newShiftId,
    receivedBy: { id: incoming.id, username: incoming.username, fullName: incoming.fullName },
    withdrawal,
    newShiftBase: count.total,
    counted: count.total,
    expectedInDrawer: result.closed.summary.expectedInDrawer,
    difference: result.closed.difference,
    summary: result.closed.summary,
  };
}

module.exports = {
  getCurrentShift,
  listOpenShifts,
  requireOpenShift,
  openShift,
  closeShift,
  handoverShift,
};
