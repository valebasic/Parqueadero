// Bandeja de conflictos de sincronización (RF62): AS/AG revisan cada operación hecha sin conexión que
// no se pudo aplicar y la resuelven a mano. Toda resolución exige una nota y queda en auditoría.
//
//   discard → no se aplica (p. ej. error de digitación, o la salida ya se cobró en línea y se
//             devolvió el dinero). La operación queda guardada como RESOLVED_DISCARDED.
//   apply   → se aplica a la fuerza, según el conflicto:
//             PLATE_OPEN_ELSEWHERE / PLATE_ALREADY_INSIDE → se anula la otra entrada abierta
//             MONTHLY_ACTIVE      → se registra como entrada normal
//             REGISTER_CLOSED     → el cobro entra a la caja del turno abierto que se indique
//             ENTRY_IN_CONFLICT   → se reintenta (sirve si su entrada ya se resolvió aplicándola)
//             ALREADY_EXITED, INVALID, SHIFT_INVALID → no se pueden aplicar, solo descartar
const { query, withTransaction } = require('../db/pool');
const HttpError = require('../middlewares/httpError');
const { assertSiteAccess } = require('../middlewares/authorize');
const { recordAudit } = require('./audit.service');
const { publish } = require('../realtime/bus');
const { processOperation, CONFLICT_MESSAGES, CLOCK_MESSAGES } = require('./sync.service');

const APPLICABLE = ['PLATE_OPEN_ELSEWHERE', 'PLATE_ALREADY_INSIDE', 'MONTHLY_ACTIVE', 'REGISTER_CLOSED', 'ENTRY_IN_CONFLICT'];
const MIN_NOTE = 5;

function toDto(r) {
  return {
    id: r.id,
    kind: r.kind,
    status: r.status,
    siteId: r.site_id,
    deviceId: r.device_id,
    clientTs: r.client_ts,
    receivedAt: r.received_at,
    provisionalReceipt: r.provisional_receipt,
    operator: r.operator_name,
    plate: r.payload?.plate ?? r.conflict_detail?.plate ?? null,
    paymentMethod: r.payload?.paymentMethod ?? null,
    chargedAmount: r.payload?.chargedAmount ?? null,
    // Advertencia de reloj (no bloquea): hora del dispositivo vs. hora de recepción en el servidor
    clock: r.clock_warning
      ? {
          warning: r.clock_warning,
          message: CLOCK_MESSAGES[r.clock_warning],
          offsetSeconds: r.clock_offset_seconds,
          deviceTime: r.device_time,
          receivedAt: r.received_at,
        }
      : null,
    entryId: r.entry_id,
    conflict: r.conflict_code ? {
      code: r.conflict_code,
      message: CONFLICT_MESSAGES[r.conflict_code] ?? r.conflict_code,
      detail: r.conflict_detail,
      canApply: APPLICABLE.includes(r.conflict_code),
      needsShift: r.conflict_code === 'REGISTER_CLOSED',
    } : null,
    resolution: r.resolved_at
      ? { at: r.resolved_at, by: r.resolved_by_name, note: r.resolution_note, applied: r.status === 'RESOLVED_APPLIED' }
      : null,
    entryReceipt: r.entry_receipt,
  };
}

const SELECT = `
  SELECT o.*, u.full_name AS operator_name, ur.full_name AS resolved_by_name,
         e.receipt_prefix || e.receipt_number AS entry_receipt
    FROM offline_operations o
    JOIN users u ON u.id = o.user_id
    LEFT JOIN users ur ON ur.id = o.resolved_by
    LEFT JOIN entries e ON e.id = o.entry_id`;

async function listConflicts(req, filters) {
  const siteId = Number.parseInt(filters.siteId, 10);
  if (!Number.isInteger(siteId)) throw new HttpError(400, 'Indique la sede', { code: 'VALIDATION_ERROR' });
  await assertSiteAccess(req, siteId);
  // open = por resolver · resolved = resueltos · clock = advertencias de reloj (aplicadas o no)
  const status = ['resolved', 'clock'].includes(filters.status) ? filters.status : 'open';
  const where = {
    open: "o.status = 'CONFLICT'",
    resolved: "o.status LIKE 'RESOLVED_%'",
    clock: 'o.clock_warning IS NOT NULL',
  }[status];
  const order = { open: 'o.client_ts, o.seq', resolved: 'o.resolved_at DESC', clock: 'o.received_at DESC, o.seq' }[status];
  const { rows } = await query(
    `${SELECT}
      WHERE o.site_id = $1 AND ${where}
      ORDER BY ${order}
      LIMIT 200`,
    [siteId],
  );
  return rows.map(toDto);
}

async function resolveConflict(req, rawId, body) {
  const action = body?.action;
  if (!['apply', 'discard'].includes(action)) {
    throw new HttpError(400, 'Elija cómo resolver: aplicar o descartar', { code: 'VALIDATION_ERROR' });
  }
  const note = typeof body?.note === 'string' ? body.note.trim() : '';
  if (note.length < MIN_NOTE) {
    throw new HttpError(400, 'Escriba una nota que explique la resolución (mínimo 5 caracteres)', { code: 'NOTE_REQUIRED' });
  }

  if (!/^[0-9a-f-]{36}$/i.test(String(rawId))) throw new HttpError(404, 'Conflicto no encontrado', { code: 'NOT_FOUND' });
  const { rows } = await query('SELECT * FROM offline_operations WHERE id = $1', [rawId]);
  const op = rows[0];
  if (!op) throw new HttpError(404, 'Conflicto no encontrado', { code: 'NOT_FOUND' });
  await assertSiteAccess(req, op.site_id);
  if (op.status !== 'CONFLICT') throw new HttpError(409, 'Este conflicto ya fue resuelto', { code: 'ALREADY_RESOLVED' });

  if (action === 'discard') {
    await withTransaction(async (client) => {
      const upd = await client.query(
        `UPDATE offline_operations
            SET status = 'RESOLVED_DISCARDED', resolved_at = now(), resolved_by = $2, resolution_note = $3
          WHERE id = $1 AND status = 'CONFLICT'`,
        [op.id, req.user.id, note],
      );
      if (upd.rowCount === 0) throw new HttpError(409, 'Este conflicto ya fue resuelto', { code: 'ALREADY_RESOLVED' });
      await recordAudit(
        {
          req,
          userId: req.user.id,
          siteId: op.site_id,
          action: 'OFFLINE_CONFLICT_RESOLVED',
          entityType: 'offline_operation',
          entityId: op.id,
          details: { action, note, code: op.conflict_code, kind: op.kind, operatorId: op.user_id, payload: op.payload },
        },
        client,
      );
    });
  } else {
    if (!APPLICABLE.includes(op.conflict_code)) {
      throw new HttpError(409, `Este conflicto no se puede aplicar (${CONFLICT_MESSAGES[op.conflict_code]}); solo se puede descartar con una nota.`, {
        code: 'APPLY_NOT_ALLOWED',
      });
    }
    const shiftId = body?.shiftId ? Number.parseInt(body.shiftId, 10) : null;
    if (op.conflict_code === 'REGISTER_CLOSED' && !shiftId) {
      throw new HttpError(400, 'Elija el turno abierto en cuya caja entra el cobro', { code: 'VALIDATION_ERROR' });
    }
    // Se aplica a nombre del operador que la hizo (su turno, su registro); resuelve el administrador
    const { rows: u } = await query(
      `SELECT u.id, u.role, u.full_name, COALESCE((SELECT array_agg(site_id) FROM user_sites WHERE user_id = u.id), '{}') AS site_ids
         FROM users u WHERE u.id = $1`,
      [op.user_id],
    );
    const operator = { id: u[0].id, role: u[0].role, fullName: u[0].full_name, siteIds: u[0].site_ids };
    const original = {
      id: op.id,
      seq: op.seq,
      kind: op.kind,
      clientTs: op.client_ts,
      provisionalReceipt: op.provisional_receipt,
      data: op.payload,
    };
    await processOperation(operator, original, op.device_id, req, {
      resolving: true,
      force: true,
      shiftId,
      note,
      resolvedBy: req.user.id,
    });
    await recordAudit({
      req,
      userId: req.user.id,
      siteId: op.site_id,
      action: 'OFFLINE_CONFLICT_RESOLVED',
      entityType: 'offline_operation',
      entityId: op.id,
      details: { action, note, code: op.conflict_code, kind: op.kind, operatorId: op.user_id, shiftId },
    });
  }

  publish(op.site_id, 'sync:conflict-resolved', { operationId: op.id, action });
  const { rows: after } = await query(`${SELECT} WHERE o.id = $1`, [op.id]);
  return toDto(after[0]);
}

module.exports = { listConflicts, resolveConflict, APPLICABLE };
