// Reloj del dispositivo al sincronizar: se guarda la hora de recepción del servidor y, si el reloj del
// equipo difiere más de 10 minutos (o la operación tiene hora futura), se marca en auditoría y se
// muestra como advertencia en la bandeja de conflictos. Nunca bloquea el cobro.
const crypto = require('crypto');
const request = require('supertest');
const { query, closePool } = require('../../src/db/pool');
const { clockCheck } = require('../../src/services/sync.service');
const { app, freshDatabase, siteIdByCode, createUser, loginAs, auditCount } = require('./helpers');

let site;
let op;
let as;
let shiftId;
let seq = 0;
const DEVICE = 'CLK01';

const uuid = () => crypto.randomUUID();
const at = (minutesFromNow) => new Date(Date.now() + minutesFromNow * 60000).toISOString();
const sync = (operations, deviceTime) =>
  request(app).post('/api/sync/operations').set(...op.auth).send({ deviceId: DEVICE, deviceTime, operations });
const entryOp = (plate, clientTs) => {
  seq += 1;
  return { id: uuid(), seq, kind: 'ENTRY', clientTs, provisionalReceipt: `FA-P-${DEVICE}-${seq}`, data: { siteId: site, plate, shiftId } };
};
const exitOp = (entryOpId, clientTs, charged) => {
  seq += 1;
  return {
    id: uuid(),
    seq,
    kind: 'EXIT',
    clientTs,
    data: { siteId: site, shiftId, entryOpId, paymentMethod: 'CASH', calculatedAmount: charged, chargedAmount: charged },
  };
};
const listClock = async () =>
  (await request(app).get(`/api/sync/conflicts?siteId=${site}&status=clock`).set(...as.auth)).body.data;

beforeAll(async () => {
  await freshDatabase();
  site = await siteIdByCode('FACA');
  await createUser({ username: 'op.clock', role: 'OP', siteIds: [site] });
  await createUser({ username: 'as.clock', role: 'AS', siteIds: [site] });
  op = await loginAs('op.clock');
  as = await loginAs('as.clock');
  const zone = (await query('SELECT id FROM zones WHERE site_id = $1 LIMIT 1', [site])).rows[0].id;
  shiftId = (await request(app).post('/api/shifts').set(...op.auth).send({ zoneId: zone, denominations: {} })).body.data.id;
});

afterAll(closePool);

describe('regla pura', () => {
  const receivedAt = new Date('2026-11-12T15:00:00Z');
  test.each([
    ['reloj al día', '2026-11-12T15:00:20Z', '2026-11-12T14:30:00Z', null, 20],
    ['10 min exactos: no marca', '2026-11-12T15:10:00Z', '2026-11-12T14:30:00Z', null, 600],
    ['adelantado 11 min', '2026-11-12T15:11:00Z', '2026-11-12T14:30:00Z', 'SKEW', 660],
    ['atrasado 2 h', '2026-11-12T13:00:00Z', '2026-11-12T12:30:00Z', 'SKEW', -7200],
    ['operación con hora futura', '2026-11-12T15:03:00Z', '2026-11-12T15:02:30Z', 'FUTURE', 180],
    ['sin hora del equipo (cliente viejo) y operación futura', null, '2026-11-12T15:05:00Z', 'FUTURE', null],
    ['sin hora del equipo y operación pasada', null, '2026-11-12T14:00:00Z', null, null],
  ])('%s', (_label, deviceTime, clientTs, warning, offset) => {
    const r = clockCheck({ receivedAt, deviceTime: deviceTime ? new Date(deviceTime) : null }, clientTs);
    expect(r.warning).toBe(warning);
    expect(r.offsetSeconds).toBe(offset);
  });
});

test('reloj al día: se guarda la hora de recepción y no hay advertencia', async () => {
  const e = entryOp('CLK001', at(-30));
  const res = await sync([e], at(0));
  expect(res.body.data.results[0]).toMatchObject({ status: 'APPLIED', clockWarning: null });
  const { rows } = await query('SELECT received_at, device_time, clock_offset_seconds, clock_warning FROM offline_operations WHERE id = $1', [e.id]);
  expect(rows[0].received_at).toBeInstanceOf(Date);
  expect(Math.abs(Date.now() - rows[0].received_at.getTime())).toBeLessThan(60000);
  expect(rows[0].device_time).toBeInstanceOf(Date);
  expect(Math.abs(rows[0].clock_offset_seconds)).toBeLessThan(60);
  expect(rows[0].clock_warning).toBeNull();
});

test('reloj adelantado 25 min: se aplica y cobra igual, se audita y aparece como advertencia', async () => {
  // El equipo cree que son 25 min más tarde: la entrada (hace 40 min "suyos") y la salida (hace 1 min "suyo")
  const e = entryOp('CLK002', at(25 - 40));
  const x = exitOp(e.id, at(24), 3600);
  const before = await auditCount('OFFLINE_CLOCK_SKEW');
  const res = await sync([e, x], at(25));
  expect(res.status).toBe(200);
  expect(res.body.data).toMatchObject({ applied: 2, conflicts: 0, clockWarnings: 2 });
  expect(res.body.data.results.map((r) => r.clockWarning)).toEqual(['SKEW', 'SKEW']);

  // El cobro no se bloqueó
  const { rows: entry } = await query("SELECT status, charged_amount FROM entries WHERE plate = 'CLK002'");
  expect(entry[0]).toMatchObject({ status: 'PAID', charged_amount: 3600 });

  expect(await auditCount('OFFLINE_CLOCK_SKEW')).toBe(before + 2);
  const { rows: audit } = await query(
    "SELECT details FROM audit_log WHERE action = 'OFFLINE_CLOCK_SKEW' AND entity_id = $1",
    [x.id],
  );
  expect(audit[0].details).toMatchObject({ warning: 'SKEW', deviceId: DEVICE });
  expect(audit[0].details.offsetSeconds).toBeGreaterThan(24 * 60);

  const items = await listClock();
  const row = items.find((i) => i.id === x.id);
  expect(row).toMatchObject({ status: 'APPLIED', conflict: null, kind: 'EXIT' });
  expect(row.clock).toMatchObject({ warning: 'SKEW', message: expect.stringContaining('10 minutos') });
  expect(row.clock.offsetSeconds).toBeGreaterThan(24 * 60);
});

test('reloj atrasado 3 h: también se marca', async () => {
  const e = entryOp('CLK003', at(-200));
  const res = await sync([e], at(-180));
  expect(res.body.data.results[0]).toMatchObject({ status: 'APPLIED', clockWarning: 'SKEW' });
  const row = (await listClock()).find((i) => i.id === e.id);
  expect(row.clock.offsetSeconds).toBeLessThan(-170 * 60);
});

test('operación con hora futura (sin hora del equipo): advertencia FUTURE', async () => {
  const e = entryOp('CLK004', at(3));
  const res = await request(app)
    .post('/api/sync/operations')
    .set(...op.auth)
    .send({ deviceId: DEVICE, operations: [e] });
  expect(res.body.data.results[0]).toMatchObject({ status: 'APPLIED', clockWarning: 'FUTURE' });
  const row = (await listClock()).find((i) => i.id === e.id);
  expect(row.clock).toMatchObject({ warning: 'FUTURE', offsetSeconds: null, deviceTime: null });
});

test('una operación en conflicto con el reloj desfasado muestra las dos cosas', async () => {
  await request(app).post('/api/entries').set(...op.auth).send({ siteId: site, plate: 'CLK005' });
  const e = entryOp('CLK005', at(20));
  const res = await sync([e], at(30));
  expect(res.body.data.results[0]).toMatchObject({ status: 'CONFLICT', clockWarning: 'SKEW' });
  const open = (await request(app).get(`/api/sync/conflicts?siteId=${site}&status=open`).set(...as.auth)).body.data;
  const row = open.find((i) => i.id === e.id);
  expect(row.conflict.code).toBe('PLATE_ALREADY_INSIDE');
  expect(row.clock.warning).toBe('SKEW');
});

test('reenviar el mismo UUID no vuelve a auditar la advertencia', async () => {
  const e = entryOp('CLK006', at(-5));
  await sync([e], at(40));
  const before = await auditCount('OFFLINE_CLOCK_SKEW');
  const again = await sync([e], at(40));
  expect(again.body.data.results[0]).toMatchObject({ duplicate: true, clockWarning: 'SKEW' });
  expect(await auditCount('OFFLINE_CLOCK_SKEW')).toBe(before);
});

test('hora del equipo inválida → 400; el operador no ve la bandeja', async () => {
  const bad = await sync([entryOp('CLK007', at(0))], 'ayer');
  expect(bad.status).toBe(400);
  expect((await request(app).get(`/api/sync/conflicts?siteId=${site}&status=clock`).set(...op.auth)).status).toBe(403);
});
