// Operación sin conexión (RF60): entradas y salidas contra la copia local, encoladas para sincronizar.
//   - Solo con un turno YA abierto (guardado en la copia local al abrirlo / al refrescar).
//   - Recibo provisional único por dispositivo: FA-P-<dispositivo>-0001.
//   - Tarifa calculada con la tarifa guardada; el servidor la recalcula al sincronizar.
//   - Mensualidades vigentes y "ya está adentro" se revisan contra la copia local; lo que solo se
//     pueda detectar en el servidor queda como conflicto al sincronizar (nunca se pierde).
import { apiGet } from '../api.js';
import { calculateFare } from '../tariff.js';
import { detectVehicleType, normalizePlate, plateError, VEHICLE_LABELS } from '../plates.js';
import { PAYMENT_LABELS } from '../format.js';
import {
  decryptOfflineToken,
  deviceId,
  enqueue,
  loadCache,
  nextCounter,
  readQueue,
  removeFromQueue,
  saveCache,
  setMeta,
  getMeta,
} from './secureStore.js';

const SNAPSHOT_KEY = (siteId) => `snapshot:${siteId}`;
const SHIFT_KEY = (userId) => `shift:${userId}`;
const pad4 = (n) => String(n).padStart(4, '0');

export class OfflineError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Copia local
// ---------------------------------------------------------------------------

export async function refreshSnapshot(siteId, shift, userId) {
  const data = await apiGet(`/sync/snapshot?siteId=${siteId}`, { background: true });
  await saveCache(SNAPSHOT_KEY(siteId), data);
  if (userId) await saveCache(SHIFT_KEY(userId), shift ?? null);
  return data;
}

export async function loadSnapshot(siteId) {
  return (await loadCache(SNAPSHOT_KEY(siteId)))?.value ?? null;
}

export async function loadCachedShift(userId) {
  return (await loadCache(SHIFT_KEY(userId)))?.value ?? null;
}

// ---------------------------------------------------------------------------
// Reglas locales
// ---------------------------------------------------------------------------

const localDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const localTime = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

// Igual que findActiveMonthly del servidor, con la copia local
export function localMonthly(snapshot, plate, at = new Date()) {
  const today = localDate(at);
  const t = localTime(at);
  const m = snapshot.monthly
    .filter((x) => x.plate === plate && x.startDate <= today && today <= x.coveredUntil)
    .sort((a, b) => b.coveredUntil.localeCompare(a.coveredUntil))[0];
  if (!m) return null;
  let inside = true;
  if (m.schedule === 'NIGHT') {
    if (m.nightStart < m.nightEnd) inside = t >= m.nightStart && t < m.nightEnd;
    else if (m.nightStart > m.nightEnd) inside = t >= m.nightStart || t < m.nightEnd;
  }
  return { ...m, blocksEntry: m.schedule === 'DAY' || inside };
}

export function localRate(snapshot, vehicleType, at = new Date()) {
  return snapshot.rates.find(
    (r) => r.vehicleType === vehicleType && new Date(r.validFrom) <= at && (!r.validTo || new Date(r.validTo) > at),
  );
}

/**
 * Vehículos adentro según la copia local + la cola: entradas del servidor y las registradas sin
 * conexión, menos las que ya tienen salida encolada.
 */
export async function localOpenEntries(snapshot, userId) {
  const queue = await readQueue(userId);
  const exitedIds = new Set(queue.filter((o) => o.kind === 'EXIT').map((o) => o.data.entryId ?? o.data.entryOpId));
  const server = snapshot.openEntries.filter((e) => !exitedIds.has(e.id)).map((e) => ({ ...e, key: `s${e.id}`, offline: false }));
  const local = queue
    .filter((o) => o.kind === 'ENTRY' && !exitedIds.has(o.id))
    .map((o) => ({
      key: `o${o.id}`,
      opId: o.id,
      plate: o.data.plate,
      vehicleType: o.data.vehicleType,
      receipt: o.provisionalReceipt,
      entryAt: o.clientTs,
      monthlyPlanId: o.data.monthlyLinked ? 1 : null,
      offline: true,
    }));
  return [...local, ...server]
    .map((e) => ({ ...e, vehicleLabel: VEHICLE_LABELS[e.vehicleType] }))
    .sort((a, b) => new Date(b.entryAt) - new Date(a.entryAt));
}

// ---------------------------------------------------------------------------
// Registrar sin conexión
// ---------------------------------------------------------------------------

async function baseOp(kind, user) {
  const device = await deviceId();
  const seq = await nextCounter('op');
  return { id: crypto.randomUUID(), seq, kind, clientTs: new Date().toISOString(), userId: user.id, deviceId: device };
}

function receiptBase(snapshot) {
  return { business: snapshot.site.business, config: snapshot.site.config, qrUrl: null };
}

export async function registerEntryOffline({ user, shift, snapshot, plate: rawPlate, vehicleType }) {
  const plate = normalizePlate(rawPlate);
  const err = plateError(plate);
  if (err) throw new OfflineError(err, 'INVALID_PLATE');
  const type = vehicleType || detectVehicleType(plate);
  const open = await localOpenEntries(snapshot, user.id);
  if (open.some((e) => e.plate === plate)) throw new OfflineError(`La placa ${plate} ya está adentro.`, 'ENTRY_ALREADY_OPEN');
  const monthly = localMonthly(snapshot, plate);
  if (monthly?.blocksEntry) {
    throw new OfflineError(`La placa ${plate} tiene mensualidad vigente (${monthly.clientName}). No se registra como entrada normal.`, 'MONTHLY_ACTIVE');
  }

  const op = await baseOp('ENTRY', user);
  const device = op.deviceId;
  op.provisionalReceipt = `${snapshot.site.receiptPrefix}-P-${device}-${pad4(await nextCounter('provisional'))}`;
  op.data = { siteId: snapshot.site.id, plate, vehicleType: type, shiftId: shift.id, monthlyLinked: Boolean(monthly) };
  await enqueue(user.id, op);
  return {
    ...receiptBase(snapshot),
    type: 'ENTRY',
    provisional: true,
    receipt: op.provisionalReceipt,
    plate,
    vehicleType: type,
    vehicleLabel: VEHICLE_LABELS[type],
    entryAt: op.clientTs,
    operator: user.fullName,
  };
}

export function quoteOffline(snapshot, entry, at = new Date()) {
  const rate = localRate(snapshot, entry.vehicleType, at);
  if (!rate) throw new OfflineError('No hay tarifa guardada para este vehículo', 'NO_RATE');
  return { ...calculateFare({ entryAt: entry.entryAt, exitAt: at, rate }), goesToPending: Boolean(entry.monthlyPlanId) };
}

/** method: CASH | ELECTRONIC | PENDING (sin conexión no hay "Ambos") */
export async function registerExitOffline({ user, shift, snapshot, entry, method, chargedAmount, discountReason }) {
  if (!['CASH', 'ELECTRONIC', 'PENDING'].includes(method)) {
    throw new OfflineError('Sin conexión solo se puede cobrar en efectivo, electrónico o dejar pendiente', 'VALIDATION');
  }
  const at = new Date();
  const quote = quoteOffline(snapshot, entry, at);
  const charged = chargedAmount ?? quote.total;
  if (charged > quote.total) throw new OfflineError('No puede cobrar más de lo calculado', 'VALIDATION');
  if (charged < quote.total && String(discountReason ?? '').trim().length < 3) {
    throw new OfflineError('Escriba el motivo del descuento', 'DISCOUNT_REASON_REQUIRED');
  }
  const op = await baseOp('EXIT', user);
  op.clientTs = at.toISOString();
  const pending = method === 'PENDING' || quote.goesToPending;
  op.data = {
    siteId: snapshot.site.id,
    shiftId: shift.id,
    ...(entry.offline ? { entryOpId: entry.opId } : { entryId: entry.id }),
    paymentMethod: pending ? 'PENDING' : method,
    calculatedAmount: quote.total,
    chargedAmount: charged,
    discountReason: charged < quote.total ? discountReason.trim() : undefined,
    plate: entry.plate,
  };
  await enqueue(user.id, op);
  return {
    ...receiptBase(snapshot),
    type: 'EXIT',
    provisional: entry.offline,
    receipt: entry.receipt,
    plate: entry.plate,
    vehicleLabel: VEHICLE_LABELS[entry.vehicleType],
    status: pending ? 'PENDING_CHARGE' : 'PAID',
    entryAt: entry.entryAt,
    exitAt: op.clientTs,
    minutes: quote.minutes,
    calculatedAmount: quote.total,
    discountAmount: quote.total - charged,
    chargedAmount: charged,
    paymentMethod: pending ? null : method,
    paymentLabel: pending ? 'Pendiente' : PAYMENT_LABELS[method],
    operator: user.fullName,
  };
}

// ---------------------------------------------------------------------------
// Sincronización
// ---------------------------------------------------------------------------

const BATCH = 20;

async function postBatch(token, device, ops) {
  const res = await fetch('/api/sync/operations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    // deviceTime: hora del equipo al enviar; el servidor la compara con la suya (advertencia si difiere > 10 min)
    body: JSON.stringify({ deviceId: device, deviceTime: new Date().toISOString(), operations: ops }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const e = new Error(body?.error || `Error ${res.status}`);
    e.status = res.status;
    e.code = body?.code;
    throw e;
  }
  return body.data;
}

/**
 * Envía la cola en orden. Usa el token de acceso si hay sesión en línea; si no (o si fue rechazado),
 * el token de sincronización (8 h). Lo aplicado o en conflicto sale de la cola (el conflicto queda
 * en el servidor para AS/AG). Devuelve el resumen.
 */
export async function syncQueue({ userId, accessToken, onProgress }) {
  const ops = await readQueue(userId);
  if (!ops.length) return { applied: 0, conflicts: 0, total: 0, results: [] };
  const device = await deviceId();
  const offlineToken = await decryptOfflineToken(userId);
  const summary = { applied: 0, conflicts: 0, total: ops.length, results: [] };
  onProgress?.({ done: 0, total: ops.length });

  for (let i = 0; i < ops.length; i += BATCH) {
    const chunk = ops.slice(i, i + BATCH).map(({ userId: _u, deviceId: _d, ...op }) => op);
    let data;
    try {
      data = await postBatch(accessToken || offlineToken, device, chunk);
    } catch (err) {
      if (err.status === 401 && offlineToken && accessToken) data = await postBatch(offlineToken, device, chunk);
      else throw err;
    }
    summary.applied += data.applied;
    summary.conflicts += data.conflicts;
    summary.results.push(...data.results);
    await removeFromQueue(data.results.map((r) => r.id));
    onProgress?.({ done: Math.min(ops.length, i + chunk.length), total: ops.length });
  }

  // Recibos provisionales → definitivos (para consulta del operador)
  const map = (await getMeta('provisionalMap', {})) || {};
  summary.results.filter((r) => r.provisionalReceipt && r.receipt).forEach((r) => {
    map[r.provisionalReceipt] = r.receipt;
  });
  await setMeta('provisionalMap', map);
  await setMeta('lastSync', { at: Date.now(), applied: summary.applied, conflicts: summary.conflicts });
  return summary;
}
