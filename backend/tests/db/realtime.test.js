// Tiempo real (RF28): Socket.IO autenticado con la sesión, salas por sede y desconexión al revocar.
const http = require('http');
const request = require('supertest');
const { io: connect } = require('socket.io-client');
const { query, closePool } = require('../../src/db/pool');
const { createApp } = require('../../src/app');
const { initRealtime } = require('../../src/realtime');
const { freshDatabase, createSite, siteIdByCode, createUser, loginAs } = require('./helpers');

let server;
let realtime;
let url;
let app;
let siteA;
let siteB;
const sockets = [];

function open(token) {
  const s = connect(url, { path: '/socket.io', auth: token ? { token } : {}, transports: ['websocket'], reconnection: false, forceNew: true });
  sockets.push(s);
  return s;
}

// Espera el evento 'ready' (conectado y unido a sus salas) o el error de conexión
function ready(socket) {
  return new Promise((resolve, reject) => {
    socket.once('ready', resolve);
    socket.once('connect_error', reject);
  });
}

// Junta los eventos de dominio que recibe un socket
function collect(socket) {
  const events = [];
  socket.on('event', (e) => events.push(e));
  return events;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, timeout = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (fn()) return true;
    await wait(25);
  }
  return false;
}

beforeAll(async () => {
  await freshDatabase();
  siteA = await siteIdByCode('FACA');
  siteB = await createSite('NORTE', 'Sede Norte');
  await createUser({ username: 'op.a', role: 'OP', siteIds: [siteA] });
  await createUser({ username: 'op.b', role: 'OP', siteIds: [siteB] });
  app = createApp();
  server = http.createServer(app);
  realtime = initRealtime(server);
  await new Promise((r) => server.listen(0, r));
  url = `http://localhost:${server.address().port}`;
});

afterAll(async () => {
  sockets.forEach((s) => s.close());
  await realtime.close();
  await new Promise((r) => server.close(r));
  await closePool();
});

const api = (s) => ({ post: (p, b = {}) => request(app).post(p).set(...s.auth).send(b) });

async function openShiftAndEnter(session, siteId, plate) {
  const zone = (await query('SELECT id FROM zones WHERE site_id = $1 LIMIT 1', [siteId])).rows[0].id;
  await api(session).post('/api/shifts', { zoneId: zone, denominations: {} });
  return api(session).post('/api/entries', { siteId, plate });
}

test('sin sesión la conexión se rechaza', async () => {
  await expect(ready(open(null))).rejects.toMatchObject({ message: 'AUTH_REQUIRED' });
  await expect(ready(open('token.falso.x'))).rejects.toMatchObject({ message: 'TOKEN_INVALID' });
});

test('cada cliente recibe solo los eventos de sus sedes; el AG recibe todos', async () => {
  const a = await loginAs('op.a');
  const b = await loginAs('op.b');
  const ag = await loginAs('Felipe', process.env.SEED_ADMIN_PASSWORD);
  const sa = open(a.token);
  const sb = open(b.token);
  const sg = open(ag.token);
  expect((await ready(sa)).sites).toEqual([siteA]);
  expect((await ready(sb)).sites).toEqual([siteB]);
  expect((await ready(sg)).sites.sort()).toEqual([siteA, siteB].sort());
  const ea = collect(sa);
  const eb = collect(sb);
  const eg = collect(sg);

  const started = Date.now();
  expect((await openShiftAndEnter(a, siteA, 'RTA111')).status).toBe(201);
  expect((await openShiftAndEnter(b, siteB, 'RTB222')).status).toBe(201);

  await until(() => ea.some((e) => e.type === 'entry:created') && eb.some((e) => e.type === 'entry:created') && eg.filter((e) => e.type === 'entry:created').length === 2);
  expect(Date.now() - started).toBeLessThan(3000); // RNF03: llega en menos de 3 s

  expect(ea.filter((e) => e.type === 'entry:created').map((e) => e.payload.plate)).toEqual(['RTA111']);
  expect(eb.filter((e) => e.type === 'entry:created').map((e) => e.payload.plate)).toEqual(['RTB222']);
  expect(ea.every((e) => e.siteId === siteA)).toBe(true);
  expect(eb.every((e) => e.siteId === siteB)).toBe(true);
  expect(eg.filter((e) => e.type === 'entry:created').map((e) => e.payload.plate).sort()).toEqual(['RTA111', 'RTB222']);

  // Apertura de turno y ocupación también llegan a la sede
  expect(ea.some((e) => e.type === 'shift:opened')).toBe(true);
  await until(() => ea.some((e) => e.type === 'occupancy:changed'));
  expect(ea.find((e) => e.type === 'occupancy:changed').payload).toMatchObject({ inside: 1, capacity: 100 });
});

test('salida y movimiento de caja se notifican a la sede', async () => {
  const a = await loginAs('op.a');
  const sa = open(a.token);
  await ready(sa);
  const ea = collect(sa);
  const entry = (await query("SELECT id FROM entries WHERE plate = 'RTA111'")).rows[0].id;
  expect((await api(a).post(`/api/entries/${entry}/exit`, { paymentMethod: 'CASH' })).status).toBe(200);
  expect((await api(a).post('/api/cash-movements', { type: 'INCOME', amount: 1000 })).status).toBe(201);
  await until(() => ea.some((e) => e.type === 'entry:exited') && ea.some((e) => e.type === 'cash:movement'));
  expect(ea.find((e) => e.type === 'entry:exited').payload).toMatchObject({ plate: 'RTA111', status: 'PAID' });
  expect(ea.find((e) => e.type === 'cash:movement').payload).toMatchObject({ action: 'created', type: 'INCOME' });
});

test('una sesión revocada (logout) se desconecta de inmediato', async () => {
  const a = await loginAs('op.a');
  const sa = open(a.token);
  await ready(sa);
  const ended = new Promise((resolve) => sa.once('session:ended', resolve));
  const closed = new Promise((resolve) => sa.once('disconnect', resolve));
  await request(app).post('/api/auth/logout').set('Cookie', a.cookie);
  expect(await ended).toMatchObject({ reason: 'LOGOUT' });
  await closed;
  expect(sa.connected).toBe(false);
  // Y no puede volver a conectarse con ese token
  await expect(ready(open(a.token))).rejects.toMatchObject({ message: 'SESSION_REVOKED' });
});

test('desactivar al usuario desconecta todos sus sockets', async () => {
  const b = await loginAs('op.b');
  const s1 = open(b.token);
  await ready(s1);
  const closed = new Promise((resolve) => s1.once('disconnect', resolve));
  const ag = await loginAs('Felipe', process.env.SEED_ADMIN_PASSWORD);
  const id = (await query("SELECT id FROM users WHERE username = 'op.b'")).rows[0].id;
  expect((await request(app).patch(`/api/users/${id}`).set(...ag.auth).send({ isActive: false })).status).toBe(200);
  await closed;
  expect(s1.connected).toBe(false);
});

test('la revalidación periódica cierra una sesión vencida por inactividad', async () => {
  await createUser({ username: 'op.c', role: 'OP', siteIds: [siteA] });
  const c = await loginAs('op.c');
  const sc = open(c.token);
  await ready(sc);
  const ended = new Promise((resolve) => sc.once('session:ended', resolve));
  const sid = JSON.parse(Buffer.from(c.token.split('.')[1], 'base64url').toString()).sid;
  await query("UPDATE user_sessions SET last_activity_at = now() - interval '16 minutes' WHERE id = $1", [sid]);
  await realtime.revalidateAll();
  expect(await ended).toMatchObject({ reason: 'IDLE' });
});

test('los cambios de mensualidades publican las alertas de vencimiento', async () => {
  const ag = await loginAs('Felipe', process.env.SEED_ADMIN_PASSWORD);
  const sg = open(ag.token);
  await ready(sg);
  const eg = collect(sg);
  const res = await request(app).post('/api/monthly').set(...ag.auth).send({
    siteId: siteA, plate: 'ALR777', clientName: 'Cliente Alerta', phones: ['3001234567'], dataConsent: true,
    startDate: '2026-01-01', endDate: '2026-01-31',
  });
  expect(res.status).toBe(201);
  await until(() => eg.some((e) => e.type === 'monthly:alerts'));
  const alerts = eg.find((e) => e.type === 'monthly:alerts');
  expect(alerts.siteId).toBe(siteA);
  expect(alerts.payload.alerts.map((a) => a.plate)).toContain('ALR777');
});
