// Sincronización sin conexión (RF60, RF62): idempotencia, consecutivos, tarifa recalculada y conflictos.
const crypto = require('crypto');
const request = require('supertest');
const { query, closePool } = require('../../src/db/pool');
const { app, freshDatabase, createSite, siteIdByCode, createUser, loginAs, auditCount } = require('./helpers');

let site;
let siteB;

let op;
let opB;
let shiftId;
let shiftB;
const DEVICE = 'TAB01';
let seq = 0;

const uuid = () => crypto.randomUUID();
const minutesAgo = (m) => new Date(Date.now() - m * 60000).toISOString();

function sync(session, operations, token = session.token) {
  return request(app).post('/api/sync/operations').set('Authorization', `Bearer ${token}`).send({ deviceId: DEVICE, operations });
}

const entryOp = (plate, { minutes = 0, siteId = site, shift = shiftId, id = uuid() } = {}) => {
  seq += 1;
  return { id, seq, kind: 'ENTRY', clientTs: minutesAgo(minutes), provisionalReceipt: `FA-P-${DEVICE}-${String(seq).padStart(4, '0')}`, data: { siteId, plate, shiftId: shift } };
};
const exitOp = (data, { minutes = 0, id = uuid() } = {}) => {
  seq += 1;
  return { id, seq, kind: 'EXIT', clientTs: minutesAgo(minutes), data: { siteId: site, shiftId, paymentMethod: 'CASH', ...data } };
};

async function openShift(session, siteId) {
  const z = (await query('SELECT id FROM zones WHERE site_id = $1 LIMIT 1', [siteId])).rows[0].id;
  const res = await request(app).post('/api/shifts').set(...session.auth).send({ zoneId: z, denominations: {} });
  return res.body.data.id;
}

beforeAll(async () => {
  await freshDatabase();
  site = await siteIdByCode('FACA');
  siteB = await createSite('NORTE', 'Sede Norte');

  await createUser({ username: 'op.off', role: 'OP', siteIds: [site] });
  await createUser({ username: 'op.norte', role: 'OP', siteIds: [siteB] });
  op = await loginAs('op.off');
  opB = await loginAs('op.norte');
  shiftId = await openShift(op, site);
  shiftB = await openShift(opB, siteB);
});

afterAll(closePool);

test('login y refresh entregan el token de sincronización', async () => {
  const res = await request(app).post('/api/auth/login').send({ username: 'op.off', password: 'Prueba2026x' });
  expect(res.body.data.offlineToken).toEqual(expect.any(String));
});

test('copia local: tarifas, mensualidades vigentes y entradas abiertas', async () => {
  const res = await request(app).get(`/api/sync/snapshot?siteId=${site}`).set(...op.auth);
  expect(res.status).toBe(200);
  expect(res.body.data.rates.map((r) => r.vehicleType).sort()).toEqual(['BICYCLE', 'CAR', 'MOTORCYCLE']);
  expect(res.body.data.site).toMatchObject({ code: 'FACA', receiptPrefix: 'FA' });
  expect(res.body.data).toHaveProperty('monthly');
  expect(res.body.data).toHaveProperty('openEntries');
  expect((await request(app).get(`/api/sync/snapshot?siteId=${siteB}`).set(...op.auth)).status).toBe(403);
});

test('idempotencia: enviar dos veces el mismo UUID no duplica nada', async () => {
  const e = entryOp('OFF001', { minutes: 30 });
  const first = await sync(op, [e]);
  expect(first.status).toBe(200);
  expect(first.body.data.results[0]).toMatchObject({ status: 'APPLIED', receipt: 'FA1', provisionalReceipt: e.provisionalReceipt });

  const again = await sync(op, [e]);
  expect(again.body.data.results[0]).toMatchObject({ status: 'APPLIED', receipt: 'FA1', duplicate: true });

  // Y dos envíos simultáneos del mismo UUID tampoco
  const e2 = entryOp('OFF002', { minutes: 25 });
  const both = await Promise.all([sync(op, [e2]), sync(op, [e2])]);
  expect(both.map((r) => r.status)).toEqual([200, 200]);
  const { rows } = await query("SELECT count(*) AS n FROM entries WHERE plate IN ('OFF001', 'OFF002')");
  expect(rows[0].n).toBe(2);
  const { rows: e1 } = await query("SELECT entry_at, origin, provisional_receipt FROM entries WHERE plate = 'OFF001'");
  expect(e1[0]).toMatchObject({ origin: 'OFFLINE', provisional_receipt: e.provisionalReceipt });
  expect(Math.abs(new Date(e1[0].entry_at) - new Date(e.clientTs))).toBeLessThan(1000); // hora real del dispositivo
});

test('consecutivos provisionales → definitivos en orden y sin huecos (un conflicto no consume número)', async () => {
  const online = await request(app).post('/api/entries').set(...op.auth).send({ siteId: site, plate: 'ONL001' });
  const base = Number(online.body.data.receipt.slice(2));
  const ops = [entryOp('SEQ001', { minutes: 9 }), entryOp('ONL001', { minutes: 8 }), entryOp('SEQ002', { minutes: 7 }), entryOp('SEQ003', { minutes: 6 })];
  const res = await sync(op, ops);
  const r = res.body.data.results;
  expect(r.map((x) => x.status)).toEqual(['APPLIED', 'CONFLICT', 'APPLIED', 'APPLIED']);
  expect(r.filter((x) => x.status === 'APPLIED').map((x) => x.receipt)).toEqual([`FA${base + 1}`, `FA${base + 2}`, `FA${base + 3}`]);
  expect(r[1].conflict.code).toBe('PLATE_ALREADY_INSIDE');
  const { rows } = await query("SELECT provisional_receipt FROM entries WHERE plate LIKE 'SEQ%' ORDER BY receipt_number");
  expect(rows.map((x) => x.provisional_receipt)).toEqual([ops[0].provisionalReceipt, ops[2].provisionalReceipt, ops[3].provisionalReceipt]);
});

test('salida sin conexión de una entrada abierta en línea', async () => {
  const online = await request(app).post('/api/entries').set(...op.auth).send({ siteId: site, plate: 'ONL002' });
  const entryId = online.body.data.entryId;
  await query("UPDATE entries SET entry_at = now() - interval '61 minutes' WHERE id = $1", [entryId]);
  const x = exitOp({ entryId, calculatedAmount: 5100, chargedAmount: 5100, paymentMethod: 'ELECTRONIC' });
  const res = await sync(op, [x]);
  expect(res.body.data.results[0]).toMatchObject({ status: 'APPLIED', entryId, receipt: online.body.data.receipt });
  const { rows } = await query('SELECT status, payment_method, charged_amount, cash_register_id, exit_at FROM entries WHERE id = $1', [entryId]);
  expect(rows[0]).toMatchObject({ status: 'PAID', payment_method: 'ELECTRONIC', charged_amount: 5100 });
  expect(rows[0].cash_register_id).not.toBeNull();
  expect(Math.abs(new Date(rows[0].exit_at) - new Date(x.clientTs))).toBeLessThan(1000);
});

test('entrada y salida creadas ambas sin conexión (la salida referencia a la entrada por su UUID)', async () => {
  const e = entryOp('OFF003', { minutes: 50 });
  const x = exitOp({ entryOpId: e.id, calculatedAmount: 3300, chargedAmount: 3300 }, { minutes: 2 });
  const res = await sync(op, [e, x]);
  expect(res.body.data.results.map((r) => r.status)).toEqual(['APPLIED', 'APPLIED']);
  expect(res.body.data.results[1].entryId).toBe(res.body.data.results[0].entryId);
});

test('recálculo de tarifa: si difiere se audita la diferencia y no se cambia lo cobrado', async () => {
  const e = entryOp('TAR001', { minutes: 61 });
  // El dispositivo calculó 3.300 (p. ej. reloj o tarifa desactualizada); el servidor calcula 5.100
  const x = exitOp({ entryOpId: e.id, calculatedAmount: 3300, chargedAmount: 3300 });
  const res = await sync(op, [e, x]);
  expect(res.body.data.results[1]).toMatchObject({ status: 'APPLIED', tariffDifference: { local: 3300, server: 5100, difference: 1800 } });
  const { rows } = await query("SELECT charged_amount, calculated_amount FROM entries WHERE plate = 'TAR001'");
  expect(rows[0]).toEqual({ charged_amount: 3300, calculated_amount: 3300 });
  expect(await auditCount('OFFLINE_TARIFF_DIFFERENCE')).toBe(1);
});

test('entrada duplicada en dos sedes → conflicto (no se descarta: queda guardada y auditada)', async () => {
  await request(app).post('/api/entries').set(...opB.auth).send({ siteId: siteB, plate: 'DOS001' });
  const e = entryOp('DOS001', { minutes: 3 });
  const res = await sync(op, [e]);
  expect(res.body.data.results[0]).toMatchObject({ status: 'CONFLICT', conflict: { code: 'PLATE_OPEN_ELSEWHERE', detail: { site: 'Sede Norte' } } });
  const { rows } = await query('SELECT status, conflict_code, payload FROM offline_operations WHERE id = $1', [e.id]);
  expect(rows[0]).toMatchObject({ status: 'CONFLICT', conflict_code: 'PLATE_OPEN_ELSEWHERE' });
  expect(rows[0].payload.plate).toBe('DOS001');
  expect(await auditCount('OFFLINE_CONFLICT')).toBeGreaterThanOrEqual(2);
  // Repetir el envío no crea otro conflicto
  const again = await sync(op, [e]);
  expect(again.body.data.results[0]).toMatchObject({ status: 'CONFLICT', duplicate: true });
});

test('salida sin conexión de una entrada que ya salió en línea → conflicto', async () => {
  const online = await request(app).post('/api/entries').set(...op.auth).send({ siteId: site, plate: 'YAS001' });
  await request(app).post(`/api/entries/${online.body.data.entryId}/exit`).set(...op.auth).send({ paymentMethod: 'CASH' });
  const x = exitOp({ entryId: online.body.data.entryId, calculatedAmount: 1800, chargedAmount: 1800 });
  const res = await sync(op, [x]);
  expect(res.body.data.results[0]).toMatchObject({ status: 'CONFLICT', conflict: { code: 'ALREADY_EXITED' } });
});

test('mensualidad vigente detectada al sincronizar → conflicto', async () => {
  await query(
    `INSERT INTO monthly_plans (site_id, plate, vehicle_type, client_name, start_date, end_date, amount, data_consent, data_consent_at)
     VALUES ($1, 'MEN001', 'CAR', 'Cliente Mensual', CURRENT_DATE - 5, CURRENT_DATE + 25, 130000, true, now())`,
    [site],
  );
  const res = await sync(op, [entryOp('MEN001')]);
  expect(res.body.data.results[0]).toMatchObject({ status: 'CONFLICT', conflict: { code: 'MONTHLY_ACTIVE' } });
});

test('una salida cuya entrada quedó en conflicto también queda en conflicto', async () => {
  const e = entryOp('MEN001', { minutes: 20 });
  const x = exitOp({ entryOpId: e.id, calculatedAmount: 1800, chargedAmount: 1800 });
  const res = await sync(op, [e, x]);
  expect(res.body.data.results.map((r) => r.conflict?.code)).toEqual(['MONTHLY_ACTIVE', 'ENTRY_IN_CONFLICT']);
});

test('el token de sincronización sirve aunque la sesión haya quedado inactiva (sin internet)', async () => {
  const s = await loginAs('op.off');
  const offline = (await request(app).post('/api/auth/login').send({ username: 'op.off', password: 'Prueba2026x' })).body.data;
  const sid = JSON.parse(Buffer.from(offline.offlineToken.split('.')[1], 'base64url').toString()).sid;
  await query("UPDATE user_sessions SET last_activity_at = now() - interval '2 hours' WHERE id = $1", [sid]);
  const res = await sync(s, [entryOp('INA001')], offline.offlineToken);
  expect(res.status).toBe(200);
  expect(res.body.data.results[0].status).toBe('APPLIED');
  // El token de sincronización no sirve para el resto de la API
  expect((await request(app).get('/api/auth/me').set('Authorization', `Bearer ${offline.offlineToken}`)).status).toBe(401);
});

test('con la sesión revocada (logout) el token de sincronización ya no sirve', async () => {
  const login = await request(app).post('/api/auth/login').send({ username: 'op.off', password: 'Prueba2026x' });
  const cookie = login.headers['set-cookie'].find((c) => c.startsWith('nexo_rt=')).split(';')[0];
  await request(app).post('/api/auth/logout').set('Cookie', cookie);
  const res = await sync(op, [entryOp('REV001')], login.body.data.offlineToken);
  expect(res.status).toBe(401);
});

test('lote inválido → 400; sede ajena → 403', async () => {
  expect((await request(app).post('/api/sync/operations').set(...op.auth).send({ deviceId: 'x', operations: [] })).status).toBe(400);
  expect((await sync(op, [{ ...entryOp('BAD001'), id: 'no-es-uuid' }])).status).toBe(400);
  expect((await sync(op, [entryOp('BAD002', { siteId: siteB, shift: shiftB })])).status).toBe(403);
});
