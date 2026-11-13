// Bandeja de conflictos de sincronización (RF62): resolución manual, con nota y auditada.
const crypto = require('crypto');
const request = require('supertest');
const { query, closePool } = require('../../src/db/pool');
const { app, freshDatabase, createSite, siteIdByCode, createUser, loginAs, auditCount } = require('./helpers');

let site;
let siteB;
let op;
let opB;
let as;
let ag;
let shiftId;
let seq = 0;

const uuid = () => crypto.randomUUID();
const sync = (s, operations, device = 'TAB01') =>
  request(app).post('/api/sync/operations').set(...s.auth).send({ deviceId: device, operations });
const entryOp = (plate, extra = {}) => {
  seq += 1;
  return { id: uuid(), seq, kind: 'ENTRY', clientTs: new Date().toISOString(), provisionalReceipt: `FA-P-TAB01-${seq}`, data: { siteId: site, plate, shiftId, ...extra } };
};
const exitOp = (data) => {
  seq += 1;
  return { id: uuid(), seq, kind: 'EXIT', clientTs: new Date().toISOString(), data: { siteId: site, shiftId, paymentMethod: 'CASH', calculatedAmount: 0, chargedAmount: 0, ...data } };
};

async function openShift(session, siteId, zoneName) {
  const zone = zoneName
    ? (await query('INSERT INTO zones (site_id, name) VALUES ($1, $2) RETURNING id', [siteId, zoneName])).rows[0].id
    : (await query('SELECT id FROM zones WHERE site_id = $1 LIMIT 1', [siteId])).rows[0].id;
  return (await request(app).post('/api/shifts').set(...session.auth).send({ zoneId: zone, denominations: {} })).body.data.id;
}

const list = async (status = 'open') => (await request(app).get(`/api/sync/conflicts?siteId=${site}&status=${status}`).set(...as.auth)).body.data;
const resolve = (id, body, session = as) => request(app).post(`/api/sync/conflicts/${id}/resolve`).set(...session.auth).send(body);
const find = async (pred) => (await list()).find(pred);

beforeAll(async () => {
  await freshDatabase();
  site = await siteIdByCode('FACA');
  siteB = await createSite('NORTE', 'Sede Norte');
  await createUser({ username: 'op.off', role: 'OP', siteIds: [site] });
  await createUser({ username: 'op.norte', role: 'OP', siteIds: [siteB] });
  await createUser({ username: 'as.off', role: 'AS', siteIds: [site] });
  op = await loginAs('op.off');
  opB = await loginAs('op.norte');
  as = await loginAs('as.off');
  ag = await loginAs('Felipe', process.env.SEED_ADMIN_PASSWORD);
  shiftId = await openShift(op, site);
  await openShift(opB, siteB);

  // Conflictos de partida
  await request(app).post('/api/entries').set(...opB.auth).send({ siteId: siteB, plate: 'DOS001' });
  await sync(op, [entryOp('DOS001')]); // PLATE_OPEN_ELSEWHERE

  const online = await request(app).post('/api/entries').set(...op.auth).send({ siteId: site, plate: 'YAS001' });
  await request(app).post(`/api/entries/${online.body.data.entryId}/exit`).set(...op.auth).send({ paymentMethod: 'CASH' });
  await sync(op, [exitOp({ entryId: online.body.data.entryId })]); // ALREADY_EXITED

  await query(
    `INSERT INTO monthly_plans (site_id, plate, vehicle_type, client_name, start_date, end_date, amount, data_consent, data_consent_at)
     VALUES ($1, 'MEN001', 'CAR', 'Cliente Mensual', CURRENT_DATE - 5, CURRENT_DATE + 25, 130000, true, now())`,
    [site],
  );
  const e = entryOp('MEN001');
  await sync(op, [e, exitOp({ entryOpId: e.id })]); // MONTHLY_ACTIVE + ENTRY_IN_CONFLICT
});

afterAll(closePool);

test('el OP no ve la bandeja (403)', async () => {
  expect((await request(app).get(`/api/sync/conflicts?siteId=${site}`).set(...op.auth)).status).toBe(403);
});

test('lista los conflictos abiertos con su motivo y si se pueden aplicar', async () => {
  const items = await list();
  expect(items.map((c) => c.conflict.code).sort()).toEqual(['ALREADY_EXITED', 'ENTRY_IN_CONFLICT', 'MONTHLY_ACTIVE', 'PLATE_OPEN_ELSEWHERE']);
  expect(items.find((c) => c.conflict.code === 'PLATE_OPEN_ELSEWHERE')).toMatchObject({
    kind: 'ENTRY',
    plate: 'DOS001',
    operator: 'Usuario op.off',
    conflict: { canApply: true, detail: { site: 'Sede Norte' } },
  });
  expect(items.find((c) => c.conflict.code === 'ALREADY_EXITED').conflict.canApply).toBe(false);
});

test('resolver exige una nota', async () => {
  const c = await find((x) => x.plate === 'DOS001');
  const res = await resolve(c.id, { action: 'discard', note: '' });
  expect(res.status).toBe(400);
  expect(res.body.code).toBe('NOTE_REQUIRED');
});

test('una salida ya cobrada en línea no se aplica: solo se descarta (auditado, una sola vez)', async () => {
  const c = await find((x) => x.conflict.code === 'ALREADY_EXITED');
  expect((await resolve(c.id, { action: 'apply', note: 'Intento aplicar' })).body.code).toBe('APPLY_NOT_ALLOWED');
  const res = await resolve(c.id, { action: 'discard', note: 'Se cobró dos veces: se devolvió el dinero al cliente' });
  expect(res.status).toBe(200);
  expect(res.body.data).toMatchObject({ status: 'RESOLVED_DISCARDED', resolution: { applied: false, by: 'Usuario as.off' } });
  expect(await auditCount('OFFLINE_CONFLICT_RESOLVED')).toBe(1);
  expect((await resolve(c.id, { action: 'discard', note: 'Otra vez la misma' })).body.code).toBe('ALREADY_RESOLVED');
});

test('aplicar la entrada duplicada en dos sedes anula la otra y la crea a nombre del operador', async () => {
  const c = await find((x) => x.plate === 'DOS001');
  const res = await resolve(c.id, { action: 'apply', note: 'El vehículo estaba aquí; la entrada en Norte fue un error' });
  expect(res.status).toBe(200);
  expect(res.body.data).toMatchObject({ status: 'RESOLVED_APPLIED', entryReceipt: expect.stringMatching(/^FA\d+$/) });
  const { rows } = await query("SELECT site_id, status, origin, entry_by FROM entries WHERE plate = 'DOS001' ORDER BY id");
  expect(rows).toEqual([
    { site_id: siteB, status: 'CANCELLED', origin: 'ONLINE', entry_by: opB.user.id },
    { site_id: site, status: 'OPEN', origin: 'OFFLINE', entry_by: op.user.id },
  ]);
  const { rows: r } = await query('SELECT resolved_by FROM offline_operations WHERE id = $1', [c.id]);
  expect(r[0].resolved_by).toBe(as.user.id);
});

test('mensualidad detectada después: aplicar la entrada y luego reintentar su salida', async () => {
  const entry = await find((x) => x.conflict.code === 'MONTHLY_ACTIVE');
  const exitDep = await find((x) => x.conflict.code === 'ENTRY_IN_CONFLICT');
  expect((await resolve(exitDep.id, { action: 'apply', note: 'Reintento de la salida' })).status).toBe(409);
  expect((await resolve(entry.id, { action: 'apply', note: 'Ese día entró como visitante' })).status).toBe(200);
  const res = await resolve(exitDep.id, { action: 'apply', note: 'Salida del mismo vehículo' });
  expect(res.status).toBe(200);
  const { rows } = await query("SELECT status FROM entries WHERE plate = 'MEN001'");
  expect(rows.map((x) => x.status)).toEqual(['PAID']);
});

test('caja cerrada: el cobro entra a la caja del turno abierto que elija el administrador', async () => {
  await createUser({ username: 'op.cierra', role: 'OP', siteIds: [site] });
  const oc = await loginAs('op.cierra');
  const shiftC = await openShift(oc, site, 'Cierre');
  const online = await request(app).post('/api/entries').set(...oc.auth).send({ siteId: site, plate: 'CAJ001' });
  const x = { id: uuid(), seq: 999, kind: 'EXIT', clientTs: new Date().toISOString(), data: { siteId: site, shiftId: shiftC, entryId: online.body.data.entryId, paymentMethod: 'CASH', calculatedAmount: 1800, chargedAmount: 1800 } };
  await request(app).post(`/api/shifts/${shiftC}/close`).set(...oc.auth).send({ denominations: {} });
  const synced = await sync(oc, [x], 'TAB02');
  expect(synced.body.data.results[0].conflict.code).toBe('REGISTER_CLOSED');

  const c = await find((y) => y.id === x.id);
  expect(c.conflict.needsShift).toBe(true);
  expect((await resolve(c.id, { action: 'apply', note: 'Entra a la caja abierta' })).status).toBe(400);
  const res = await resolve(c.id, { action: 'apply', note: 'El efectivo se entregó al turno de op.off', shiftId }, ag);
  expect(res.status).toBe(200);
  const { rows } = await query(
    "SELECT e.status, cr.shift_id FROM entries e JOIN cash_registers cr ON cr.id = e.cash_register_id WHERE e.plate = 'CAJ001'",
  );
  expect(rows[0]).toEqual({ status: 'PAID', shift_id: shiftId });
});

test('los resueltos quedan con quién, cuándo y la nota; la bandeja abierta queda vacía', async () => {
  expect(await list()).toEqual([]);
  const resolved = await list('resolved');
  expect(resolved).toHaveLength(5);
  expect(resolved.every((r) => r.resolution.note && r.resolution.by)).toBe(true);
  expect(await auditCount('OFFLINE_CONFLICT_RESOLVED')).toBe(5);
});
