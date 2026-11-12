// Panel multisede, parte 1 (RF26-RF30): sedes y zonas, tablero multisede, contabilidad consolidada
// y horarios programados. Cubre en especial los permisos por sede (AG todas, AS las suyas, OP nada).
const request = require('supertest');
const { query, closePool } = require('../../src/db/pool');
const presence = require('../../src/realtime/presence');
const { schedulesActiveAt, overlaps } = require('../../src/services/admin/schedules.service');
const { app, freshDatabase, siteIdByCode, createUser, loginAs, auditCount } = require('./helpers');

let faca;
let norte; // creada por el AG en la primera prueba
let ag;
let asFaca;
let asNorte;
let opFaca;
let ids = {};

const api = (s) => ({
  get: (p) => request(app).get(p).set(...s.auth),
  post: (p, b) => request(app).post(p).set(...s.auth).send(b),
  patch: (p, b) => request(app).patch(p).set(...s.auth).send(b),
});
const zoneOf = async (siteId, name = 'Principal') =>
  (await query('SELECT id FROM zones WHERE site_id = $1 AND name = $2', [siteId, name])).rows[0].id;

beforeAll(async () => {
  await freshDatabase();
  faca = await siteIdByCode('FACA');
  ids.asFaca = await createUser({ username: 'as.faca', role: 'AS', siteIds: [faca] });
  ids.asNorte = await createUser({ username: 'as.norte', role: 'AS', siteIds: [] });
  ids.opFaca = await createUser({ username: 'op.faca', role: 'OP', siteIds: [faca] });
  ids.opNorte = await createUser({ username: 'op.norte', role: 'OP', siteIds: [] });
  ag = await loginAs('Felipe', process.env.SEED_ADMIN_PASSWORD);
  asFaca = await loginAs('as.faca');
  opFaca = await loginAs('op.faca');
});

afterAll(closePool);

describe('RF26-RF27 sedes y zonas', () => {
  test('el AG crea una sede con capacidad por tipo, responsable AS y tarifas copiadas', async () => {
    const res = await api(ag).post('/api/sites', {
      code: 'norte',
      name: 'Sede Norte',
      address: 'Calle 1 # 2-3',
      city: 'Facatativá',
      businessHours: 'Lunes a sábado 6:00 a. m. a 10:00 p. m.',
      capacityByType: { CAR: 40, MOTORCYCLE: 25, BICYCLE: 10 },
      managerUserId: ids.asNorte,
      copyRatesFromSiteId: faca,
    });
    expect(res.status).toBe(201);
    norte = res.body.data.id;
    expect(res.body.data).toMatchObject({
      code: 'NORTE',
      city: 'Facatativá',
      capacity: 75,
      capacityByType: { CAR: 40, MOTORCYCLE: 25, BICYCLE: 10 },
      manager: { id: ids.asNorte },
      isActive: true,
    });
    expect(res.body.data.zones).toEqual([expect.objectContaining({ name: 'Principal', vehicleTypes: ['CAR', 'MOTORCYCLE', 'BICYCLE'] })]);
    // El responsable queda asignado a la sede y las tarifas se copiaron
    expect((await query('SELECT 1 FROM user_sites WHERE user_id = $1 AND site_id = $2', [ids.asNorte, norte])).rowCount).toBe(1);
    expect((await query('SELECT count(*) AS n FROM rates WHERE site_id = $1', [norte])).rows[0].n).toBe(3);
    expect(await auditCount('SITE_CREATED')).toBe(1);
    await query('INSERT INTO user_sites (user_id, site_id) VALUES ($1, $2)', [ids.opNorte, norte]);
    asNorte = await loginAs('as.norte');
  });

  test('validaciones: código repetido, responsable que no es AS, capacidad negativa', async () => {
    expect((await api(ag).post('/api/sites', { code: 'FACA', name: 'Otra' })).status).toBe(409);
    const bad = await api(ag).post('/api/sites', { code: 'SUR', name: 'Sur', managerUserId: ids.opFaca, capacityByType: { CAR: -1 } });
    expect(bad.status).toBe(400);
    expect(bad.body.details).toHaveProperty(['capacityByType.CAR']);
  });

  test('solo el AG crea y edita sedes; el AS y el OP reciben 403', async () => {
    expect((await api(asFaca).post('/api/sites', { code: 'XX', name: 'X' })).status).toBe(403);
    expect((await api(asFaca).patch(`/api/sites/${faca}`, { name: 'Cambio' })).status).toBe(403);
    expect((await api(opFaca).patch(`/api/sites/${faca}`, { name: 'Cambio' })).status).toBe(403);
    const upd = await api(ag).patch(`/api/sites/${norte}`, { capacityByType: { CAR: 50, MOTORCYCLE: 25, BICYCLE: 10 }, city: 'Madrid' });
    expect(upd.body.data).toMatchObject({ capacity: 85, city: 'Madrid' });
  });

  test('zonas: el AS gestiona las de su sede, no las de otra; tipos admitidos', async () => {
    const created = await api(asFaca).post(`/api/sites/${faca}/zones`, { name: 'Motos', capacity: 30, vehicleTypes: ['MOTORCYCLE'] });
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({ name: 'Motos', capacity: 30, vehicleTypes: ['MOTORCYCLE'] });
    expect((await api(asFaca).post(`/api/sites/${norte}/zones`, { name: 'Ajena' })).status).toBe(403);
    expect((await api(opFaca).post(`/api/sites/${faca}/zones`, { name: 'X' })).status).toBe(403);
    expect((await api(asFaca).post(`/api/sites/${faca}/zones`, { name: 'Motos' })).status).toBe(409);
    expect((await api(asFaca).patch(`/api/sites/${faca}/zones/${created.body.data.id}`, { vehicleTypes: [] })).status).toBe(400);
  });

  test('una zona solo de motos rechaza carros', async () => {
    const motos = await zoneOf(faca, 'Motos');
    const shift = await api(opFaca).post('/api/shifts', { zoneId: motos, denominations: {} });
    expect(shift.status).toBe(201);
    const car = await api(opFaca).post('/api/entries', { siteId: faca, plate: 'ABC123' });
    expect(car.status).toBe(409);
    expect(car.body.code).toBe('ZONE_VEHICLE_NOT_ALLOWED');
    expect((await api(opFaca).post('/api/entries', { siteId: faca, plate: 'ABC12D' })).status).toBe(201);
    ids.motoShift = shift.body.data.id;
  });

  test('no se desactiva una sede o zona con turno abierto; nunca se borran', async () => {
    expect((await api(ag).patch(`/api/sites/${faca}`, { isActive: false })).body.code).toBe('SITE_HAS_OPEN_SHIFTS');
    const motos = await zoneOf(faca, 'Motos');
    expect((await api(asFaca).patch(`/api/sites/${faca}/zones/${motos}`, { isActive: false })).body.code).toBe('ZONE_HAS_OPEN_SHIFT');
    // Sede sin turnos: se desactiva y deja de salir en el listado normal (sí con includeInactive)
    const off = await api(ag).post('/api/sites', { code: 'TEMP', name: 'Temporal' });
    expect((await api(ag).patch(`/api/sites/${off.body.data.id}`, { isActive: false })).body.data.isActive).toBe(false);
    expect((await api(ag).get('/api/sites')).body.data.map((s) => s.code)).not.toContain('TEMP');
    expect((await api(ag).get('/api/sites?includeInactive=1')).body.data.map((s) => s.code)).toContain('TEMP');
    expect(await auditCount('SITE_DEACTIVATED')).toBe(1);
    expect((await request(app).delete(`/api/sites/${off.body.data.id}`).set(...ag.auth)).status).toBe(404);
  });
});

describe('RF28 tablero multisede', () => {
  test('el AG ve todas sus sedes y el consolidado', async () => {
    const res = await api(ag).get('/api/admin/overview');
    expect(res.status).toBe(200);
    const codes = res.body.data.sites.map((s) => s.site.code).sort();
    expect(codes).toEqual(['FACA', 'NORTE']);
    const f = res.body.data.sites.find((s) => s.site.code === 'FACA');
    expect(f.inside).toMatchObject({ total: 1, byType: { MOTORCYCLE: 1 } });
    expect(f.today.entries).toBe(1);
    expect(res.body.data.consolidated.inside.total).toBe(1);
    expect(res.body.data.consolidated.capacity.total).toBe(f.capacity.total + 85);
  });

  test('el AS solo ve sus sedes; pedir otra → 403; el OP no entra', async () => {
    const own = await api(asFaca).get('/api/admin/overview');
    expect(own.body.data.sites.map((s) => s.site.code)).toEqual(['FACA']);
    expect((await api(asFaca).get(`/api/admin/overview?siteId=${norte}`)).status).toBe(403);
    expect((await api(asNorte).get('/api/admin/overview')).body.data.sites.map((s) => s.site.code)).toEqual(['NORTE']);
    expect((await api(opFaca).get('/api/admin/overview')).status).toBe(403);
  });

  test('estado de conexión: sin turno, sin conexión y en línea', async () => {
    presence.reset();
    let data = (await api(ag).get('/api/admin/overview')).body.data;
    expect(data.sites.find((s) => s.site.code === 'NORTE').connection.status).toBe('NO_SHIFT');
    expect(data.sites.find((s) => s.site.code === 'FACA').connection.status).toBe('OFFLINE');
    presence.connected(ids.opFaca);
    data = (await api(ag).get('/api/admin/overview')).body.data;
    const f = data.sites.find((s) => s.site.code === 'FACA');
    expect(f.connection.status).toBe('ONLINE');
    expect(f.openShifts[0]).toMatchObject({ zone: 'Motos', online: true });
    expect(data.consolidated.connection).toEqual({ online: 1, offline: 0, noShift: 1 });
    presence.disconnected(ids.opFaca);
  });
});

describe('RF29 contabilidad consolidada', () => {
  beforeAll(async () => {
    // Venta de parqueadero en FACA (moto de hace 2 h) y cierre con faltante
    const { rows } = await query("UPDATE entries SET entry_at = now() - interval '2 hours' WHERE plate = 'ABC12D' RETURNING id");
    await api(opFaca).post(`/api/entries/${rows[0].id}/exit`, { paymentMethod: 'MIXED', cashAmount: 2000 });
    await api(opFaca).post('/api/cash-movements', { siteId: faca, type: 'INCOME', amount: 10000, concept: 'Lavado' });
    await api(opFaca).post('/api/cash-movements', { siteId: faca, type: 'EXPENSE', amount: 3000, concept: 'Bolsas', category: 'SUPPLIES' });
    await api(opFaca).post('/api/cash-movements', { siteId: faca, type: 'EXPENSE', amount: 1000, concept: 'Tinto' });
    // Pago de mensualidad en NORTE
    const plan = await query(
      `INSERT INTO monthly_plans (site_id, plate, vehicle_type, client_name, start_date, end_date, amount, payment_status, origin, data_consent, data_consent_at)
       VALUES ($1, 'MEN001', 'CAR', 'Ana', CURRENT_DATE, CURRENT_DATE + 30, 130000, 'PAID', 'MANUAL', true, now()) RETURNING id`,
      [norte],
    );
    await query(
      `INSERT INTO monthly_payments (site_id, monthly_plan_id, receipt_prefix, receipt_number, period_start, period_end, base_amount, amount, payment_method, cash_amount, electronic_amount)
       VALUES ($1, $2, 'FM', 1, CURRENT_DATE, CURRENT_DATE + 30, 130000, 130000, 'ELECTRONIC', 0, 130000)`,
      [norte, plan.rows[0].id],
    );
    // Cierre del turno con $ 500 menos de lo esperado
    const shift = (await api(opFaca).get('/api/shifts/current')).body.data;
    const expected = shift.summary.expectedInDrawer;
    const denominations = { 1000: Math.floor((expected - 500) / 1000) };
    const rest = expected - 500 - denominations[1000] * 1000;
    if (rest) denominations[rest >= 500 ? 500 : 100] = rest >= 500 ? rest / 500 : rest / 100;
    const closed = await api(opFaca).post(`/api/shifts/${shift.id}/close`, { denominations });
    expect(closed.body.data.difference).toBe(-500);
  });

  const today = () => new Date(Date.now() - 5 * 3600 * 1000).toISOString().slice(0, 10);

  test('estado de resultados por sede y consolidado, flujo diario y diferencias', async () => {
    const res = await api(ag).get(`/api/admin/accounting?from=${today()}&to=${today()}`);
    expect(res.status).toBe(200);
    const d = res.body.data;
    const f = d.sites.find((s) => s.site.code === 'FACA');
    const sale = (await query("SELECT charged_amount, cash_amount FROM entries WHERE plate = 'ABC12D'")).rows[0];
    expect(f.statement.income).toEqual({ parking: sale.charged_amount, monthly: 0, other: 10000, total: sale.charged_amount + 10000 });
    expect(f.statement.expenses.byCategory).toMatchObject({ SUPPLIES: 3000, OTHER: 1000 });
    expect(f.statement.profit).toBe(sale.charged_amount + 10000 - 4000);
    const n = d.sites.find((s) => s.site.code === 'NORTE');
    expect(n.statement.income.monthly).toBe(130000);
    expect(d.consolidated.statement.income.total).toBe(sale.charged_amount + 10000 + 130000);
    expect(d.consolidated.cashFlow).toHaveLength(1);
    expect(d.consolidated.cashFlow[0]).toMatchObject({ parkingCash: 2000, monthlyElectronic: 130000, otherIncome: 10000, expenses: 4000 });
    expect(d.consolidated.differences.totals).toMatchObject({ count: 1, shortage: 500, surplus: 0, net: -500 });
    expect(d.categoryLabels.SUPPLIES).toBe('Insumos');
  });

  test('el AS solo ve sus sedes; la de otro → 403; Excel', async () => {
    const own = await api(asNorte).get(`/api/admin/accounting?from=${today()}&to=${today()}`);
    expect(own.body.data.sites.map((s) => s.site.code)).toEqual(['NORTE']);
    expect(own.body.data.consolidated.differences.totals.count).toBe(0);
    expect((await api(asNorte).get(`/api/admin/accounting?from=${today()}&to=${today()}&siteId=${faca}`)).status).toBe(403);
    expect((await api(opFaca).get(`/api/admin/accounting?from=${today()}&to=${today()}`)).status).toBe(403);
    expect((await api(ag).get('/api/admin/accounting')).status).toBe(400);
    const xlsx = await api(ag).get(`/api/admin/accounting/export?from=${today()}&to=${today()}`);
    expect(xlsx.status).toBe(200);
    expect(xlsx.headers['content-type']).toContain('spreadsheetml');
  });

  test('categoría de egreso: solo en egresos y de la lista', async () => {
    const bad = await api(asFaca).post('/api/cash-movements', { siteId: faca, type: 'EXPENSE', amount: 100, category: 'VIAJES' });
    expect(bad.status).toBe(400);
  });
});

describe('RF30 horarios programados', () => {
  test('el AS programa a su gente; cruces, persona ajena y sede ajena se rechazan', async () => {
    const principal = await zoneOf(faca);
    const ok = await api(asFaca).post('/api/admin/schedules', { siteId: faca, userId: ids.opFaca, zoneId: principal, weekday: 1, startTime: '19:00', endTime: '07:00' });
    expect(ok.status).toBe(201);
    expect(ok.body.data).toMatchObject({ weekdayLabel: 'Lunes', startTime: '19:00', endTime: '07:00', overnight: true });
    // Martes 06:00-08:00 se cruza con el lunes nocturno (que termina el martes a las 07:00)
    const clash = await api(asFaca).post('/api/admin/schedules', { siteId: faca, userId: ids.opFaca, zoneId: principal, weekday: 2, startTime: '06:00', endTime: '08:00' });
    expect(clash.status).toBe(409);
    expect(clash.body.code).toBe('SCHEDULE_OVERLAP');
    expect((await api(asFaca).post('/api/admin/schedules', { siteId: faca, userId: ids.opFaca, zoneId: principal, weekday: 2, startTime: '07:00', endTime: '15:00' })).status).toBe(201);
    // Persona que no es de la sede
    expect((await api(asFaca).post('/api/admin/schedules', { siteId: faca, userId: ids.opNorte, zoneId: principal, weekday: 3, startTime: '07:00', endTime: '15:00' })).body.code).toBe('USER_NOT_IN_SITE');
    // Sede ajena y zona de otra sede
    expect((await api(asFaca).post('/api/admin/schedules', { siteId: norte, userId: ids.opNorte, zoneId: await zoneOf(norte), weekday: 3, startTime: '07:00', endTime: '15:00' })).status).toBe(403);
    expect((await api(asNorte).post('/api/admin/schedules', { siteId: norte, userId: ids.opNorte, zoneId: principal, weekday: 3, startTime: '07:00', endTime: '15:00' })).status).toBe(400);
    expect((await api(opFaca).get(`/api/admin/schedules?siteId=${faca}`)).status).toBe(403);
    expect((await api(asNorte).get(`/api/admin/schedules?siteId=${faca}`)).status).toBe(403);
    // Domingo nocturno → lunes: se cruza con un lunes temprano
    expect((await api(asFaca).post('/api/admin/schedules', { siteId: faca, userId: ids.opFaca, zoneId: principal, weekday: 7, startTime: '22:00', endTime: '06:00' })).status).toBe(201);
    expect((await api(asFaca).post('/api/admin/schedules', { siteId: faca, userId: ids.opFaca, zoneId: principal, weekday: 1, startTime: '05:00', endTime: '09:00' })).status).toBe(409);
  });

  test('listar, desactivar (no se borra) y horario activo en un instante', async () => {
    const list = (await api(asFaca).get(`/api/admin/schedules?siteId=${faca}`)).body.data;
    expect(list).toHaveLength(3);
    const monday = list.find((s) => s.weekday === 1);
    const off = await api(asFaca).patch(`/api/admin/schedules/${monday.id}`, { isActive: false });
    expect(off.body.data.isActive).toBe(false);
    expect((await api(asFaca).get(`/api/admin/schedules?siteId=${faca}`)).body.data).toHaveLength(2);
    expect((await api(asFaca).get(`/api/admin/schedules?siteId=${faca}&includeInactive=1`)).body.data).toHaveLength(3);
    expect(await auditCount('SCHEDULE_DEACTIVATED')).toBe(1);
    // Martes 10:00 (hora de Colombia) → el turno de 07:00 a 15:00, iniciado hace 180 min
    const active = await schedulesActiveAt([faca], new Date('2026-11-17T15:00:00Z'));
    expect(active).toEqual([expect.objectContaining({ weekday: 2, minutesSinceStart: 180 })]);
    // Lunes 02:00 → el nocturno del domingo (22:00), iniciado hace 240 min
    const night = await schedulesActiveAt([faca], new Date('2026-11-16T07:00:00Z'));
    expect(night).toEqual([expect.objectContaining({ weekday: 7, minutesSinceStart: 240 })]);
  });

  test('cruce de horarios (regla pura)', () => {
    expect(overlaps({ weekday: 1, startTime: '08:00', endTime: '12:00' }, { weekday: 1, startTime: '12:00', endTime: '14:00' })).toBe(false);
    expect(overlaps({ weekday: 1, startTime: '08:00', endTime: '12:00' }, { weekday: 1, startTime: '11:59', endTime: '14:00' })).toBe(true);
    expect(overlaps({ weekday: 7, startTime: '23:00', endTime: '01:00' }, { weekday: 1, startTime: '00:30', endTime: '02:00' })).toBe(true);
  });
});
