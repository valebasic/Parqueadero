// Panel multisede, parte 2 (RF31-RF33, RF44-RF46): zonas a cargo, alertas, comparativo, horas
// trabajadas (festivos de Colombia), reporte de turnos y ajuste autorizado. Permisos por sede.
const request = require('supertest');
const { query, withTransaction, closePool } = require('../../src/db/pool');
const presence = require('../../src/realtime/presence');
const alerts = require('../../src/services/admin/alerts.service');
const { app, freshDatabase, siteIdByCode, createSite, createUser, loginAs, auditCount } = require('./helpers');

let faca;
let norte;
let zFaca;
let zNorte;
let ag;
let asFaca;
let asNorte;
let opFaca;
const ids = {};

const api = (s) => ({
  get: (p) => request(app).get(p).set(...s.auth),
  post: (p, b) => request(app).post(p).set(...s.auth).send(b),
  put: (p, b) => request(app).put(p).set(...s.auth).send(b),
});
const local = (s) => new Date(`${s}-05:00`);

// Turno cerrado directamente en la base (con su caja), para fechas pasadas
async function insertShift({ userId, siteId, zoneId, start, end, difference = 0, expected = 50000 }) {
  return withTransaction(async (c) => {
    const { rows } = await c.query(
      `INSERT INTO shifts (site_id, zone_id, user_id, opened_at, closed_at, close_type) VALUES ($1, $2, $3, $4, $5, 'CLOSE') RETURNING id`,
      [siteId, zoneId, userId, start, end],
    );
    await c.query(
      `INSERT INTO cash_registers (site_id, shift_id, opened_at, opened_by, initial_cash, closed_at, closed_by, physical_cash, expected_cash, difference, summary)
       VALUES ($1, $2, $3, $4, 0, $5, $4, $6, $7, $8, $9)`,
      [siteId, rows[0].id, start, userId, end, expected + difference, expected, difference, { expectedInDrawer: expected, totalSales: 30000, salesCount: 3 }],
    );
    return rows[0].id;
  });
}

beforeAll(async () => {
  await freshDatabase();
  faca = await siteIdByCode('FACA');
  norte = await createSite('NORTE', 'Sede Norte');
  zFaca = (await query("SELECT id FROM zones WHERE site_id = $1 AND name = 'Principal'", [faca])).rows[0].id;
  zNorte = (await query('SELECT id FROM zones WHERE site_id = $1', [norte])).rows[0].id;
  ids.asFaca = await createUser({ username: 'as.faca', role: 'AS', siteIds: [faca] });
  ids.asNorte = await createUser({ username: 'as.norte', role: 'AS', siteIds: [norte] });
  ids.opFaca = await createUser({ username: 'op.faca', role: 'OP', siteIds: [faca] });
  ids.opNorte = await createUser({ username: 'op.norte', role: 'OP', siteIds: [norte] });
  ag = await loginAs('Felipe', process.env.SEED_ADMIN_PASSWORD);
  ids.ag = ag.user.id;
  asFaca = await loginAs('as.faca');
  asNorte = await loginAs('as.norte');
  opFaca = await loginAs('op.faca');

  // Turnos pasados de op.faca: sábado 31/10/2026 18:00 → domingo 01/11 08:00 (con faltante de $ 3.000)
  // y lunes festivo 02/11 (Todos los Santos) 08:00 → 12:00
  ids.shiftSat = await insertShift({ userId: ids.opFaca, siteId: faca, zoneId: zFaca, start: local('2026-10-31T18:00:00'), end: local('2026-11-01T08:00:00'), difference: -3000 });
  ids.shiftMon = await insertShift({ userId: ids.opFaca, siteId: faca, zoneId: zFaca, start: local('2026-11-02T08:00:00'), end: local('2026-11-02T12:00:00') });
  // En NORTE: op.norte, martes 03/11 06:00 → 14:00
  ids.shiftNorte = await insertShift({ userId: ids.opNorte, siteId: norte, zoneId: zNorte, start: local('2026-11-03T06:00:00'), end: local('2026-11-03T14:00:00'), difference: 2000 });
  // Un turno del propio AS de FACA (para probar que no puede autoajustarse)
  ids.shiftAs = await insertShift({ userId: ids.asFaca, siteId: faca, zoneId: zFaca, start: local('2026-10-27T08:00:00'), end: local('2026-10-27T16:00:00') });
});

afterAll(closePool);

describe('RF44 horas trabajadas', () => {
  const q = '/api/admin/hours?from=2026-10-31&to=2026-11-03';

  test('por día: diurnas, nocturnas y dominicales/festivas (Colombia)', async () => {
    const res = await api(ag).get(`${q}&groupBy=day`);
    expect(res.status).toBe(200);
    const op = res.body.data.employees.find((e) => e.user.id === ids.opFaca);
    // Sábado 18-19 diurna (1 h), 19-24 nocturna (5 h); domingo 0-6 nocturna dominical (6 h), 6-8 diurna dominical (2 h);
    // lunes 02/11 (festivo) 8-12 diurna festiva (4 h)
    expect(op.hours).toEqual({ total: 18, day: 1, night: 5, holidayDay: 6, holidayNight: 6 });
    expect(op.periods.map((p) => p.label)).toEqual(['2026-10-31', '2026-11-01', '2026-11-02']);
    expect(op.periods.find((p) => p.label === '2026-11-02')).toMatchObject({ holiday: 'Todos los Santos', hours: { holidayDay: 4 } });
  });

  test('por turno, semana y mes', async () => {
    const byShift = (await api(ag).get(`${q}&groupBy=shift&userId=${ids.opFaca}`)).body.data;
    expect(byShift.employees).toHaveLength(1);
    expect(byShift.employees[0].periods.map((p) => p.hours.total)).toEqual([14, 4]);
    const byWeek = (await api(ag).get(`${q}&groupBy=week&userId=${ids.opFaca}`)).body.data.employees[0].periods;
    // 31/10 y 01/11 son de la semana 44; 02/11 de la 45
    expect(byWeek.map((p) => [p.key, p.hours.total])).toEqual([['2026-W44', 14], ['2026-W45', 4]]);
    const byMonth = (await api(ag).get(`${q}&groupBy=month`)).body.data;
    // Octubre: sábado 31 (6 h); noviembre: domingo 1 (8 h) + lunes festivo 2 (4 h)
    expect(byMonth.employees.find((e) => e.user.id === ids.opFaca).periods.map((p) => [p.key, p.hours.total])).toEqual([['2026-10', 6], ['2026-11', 12]]);
    // El rango recorta: solo el domingo 01/11 → 8 h del turno del sábado
    const sunday = (await api(ag).get(`/api/admin/hours?from=2026-11-01&to=2026-11-01&userId=${ids.opFaca}`)).body.data;
    expect(sunday.employees[0].hours).toEqual({ total: 8, day: 0, night: 0, holidayDay: 2, holidayNight: 6 });
  });

  test('permisos: el AS solo ve su sede; la de otro → 403; el OP no entra', async () => {
    const own = (await api(asNorte).get(q)).body.data;
    expect(own.employees.map((e) => e.user.id)).toEqual([ids.opNorte]);
    expect((await api(asNorte).get(`${q}&siteId=${faca}`)).status).toBe(403);
    expect((await api(opFaca).get(q)).status).toBe(403);
  });
});

describe('RF45 reporte de turnos y RF46 ajuste autorizado', () => {
  test('reporte con diferencias y totales', async () => {
    const res = await api(asFaca).get('/api/admin/shift-report?from=2026-10-27&to=2026-11-03');
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.items.map((i) => i.shiftId)).toEqual([ids.shiftAs, ids.shiftSat, ids.shiftMon]);
    expect(d.items.find((i) => i.shiftId === ids.shiftSat)).toMatchObject({ difference: -3000, expected: 50000, counted: 47000, workedHours: { total: 14 } });
    expect(d.totals).toMatchObject({ shifts: 3, withDifference: 1, shortage: 3000, surplus: 0, hours: 26 });
    expect((await api(asNorte).get(`/api/admin/shift-report?from=2026-10-27&to=2026-11-03&siteId=${faca}`)).status).toBe(403);
    const xlsx = await api(asFaca).get('/api/admin/shift-report/export?from=2026-10-27&to=2026-11-03');
    expect(xlsx.headers['content-type']).toContain('spreadsheetml');
  });

  test('ajuste: motivo obligatorio, nadie ajusta su propio turno, no se cruza con otro turno', async () => {
    const url = `/api/admin/shifts/${ids.shiftMon}/adjust`;
    expect((await api(asFaca).post(url, { workedEnd: local('2026-11-02T13:00:00'), reason: 'corto' })).body.code).toBe('REASON_REQUIRED');
    expect((await api(asFaca).post(`/api/admin/shifts/${ids.shiftAs}/adjust`, { workedEnd: local('2026-10-27T17:00:00'), reason: 'Me quedé una hora más' })).body.code).toBe('SELF_ADJUST_FORBIDDEN');
    // Empezar el domingo a las 07:00 se cruza con el turno del sábado → domingo (hasta las 08:00)
    const clash = await api(asFaca).post(url, { workedStart: local('2026-11-01T07:00:00'), reason: 'Llegó antes de lo registrado' });
    expect(clash.body.code).toBe('SHIFT_OVERLAP');
    expect((await api(asNorte).post(url, { workedEnd: local('2026-11-02T13:00:00'), reason: 'Ajuste desde otra sede' })).status).toBe(403);
    expect((await api(opFaca).post(url, { workedEnd: local('2026-11-02T13:00:00'), reason: 'Me quedé una hora más' })).status).toBe(403);
  });

  test('ajuste correcto: cambia las horas, no toca el turno real, queda historial y auditoría', async () => {
    const res = await api(asFaca).post(`/api/admin/shifts/${ids.shiftMon}/adjust`, {
      workedEnd: local('2026-11-02T14:30:00'),
      reason: 'Se quedó cubriendo la zona hasta las 2:30 p. m.',
    });
    expect(res.status).toBe(200);
    expect(res.body.data.adjustments[0]).toMatchObject({ reason: expect.stringContaining('2:30'), authorizedBy: 'Usuario as.faca' });
    const s = (await query('SELECT closed_at, worked_end FROM shifts WHERE id = $1', [ids.shiftMon])).rows[0];
    expect(s.closed_at.toISOString()).toBe(local('2026-11-02T12:00:00').toISOString());
    expect(s.worked_end.toISOString()).toBe(local('2026-11-02T14:30:00').toISOString());
    expect(await auditCount('SHIFT_ADJUSTED')).toBe(1);
    const hours = (await api(ag).get(`/api/admin/hours?from=2026-11-02&to=2026-11-02&userId=${ids.opFaca}`)).body.data;
    expect(hours.employees[0].hours).toMatchObject({ total: 6.5, holidayDay: 6.5 });
    const report = (await api(ag).get('/api/admin/shift-report?from=2026-11-02&to=2026-11-02')).body.data;
    expect(report.items[0]).toMatchObject({ adjusted: true, adjustments: 1 });
    // El turno abierto solo admite ajustar el inicio
    const shift = await api(opFaca).post('/api/shifts', { zoneId: zFaca, denominations: {} });
    ids.openShift = shift.body.data.id;
    expect((await api(asFaca).post(`/api/admin/shifts/${ids.openShift}/adjust`, { workedEnd: new Date(), reason: 'Cierre adelantado por error' })).body.code).toBe('SHIFT_STILL_OPEN');
  });
});

describe('RF31 quién está a cargo de cada zona', () => {
  test('turno actual con operaciones, efectivo esperado, correcciones e historial de diferencias', async () => {
    const entry = await api(opFaca).post('/api/entries', { siteId: faca, plate: 'ZON123' });
    await query("UPDATE entries SET entry_at = now() - interval '90 minutes' WHERE id = $1", [entry.body.data.entryId]);
    await api(opFaca).post(`/api/entries/${entry.body.data.entryId}/exit`, { paymentMethod: 'CASH' });
    await request(app).patch(`/api/sales/${entry.body.data.entryId}/payment`).set(...asFaca.auth).send({ paymentMethod: 'ELECTRONIC', reason: 'Pagó por transferencia' });

    const res = await api(asFaca).get('/api/admin/zones-status');
    expect(res.status).toBe(200);
    const z = res.body.data.find((x) => x.zone.id === zFaca);
    expect(z.current).toMatchObject({ shiftId: ids.openShift, user: { id: ids.opFaca }, operations: { entries: 1, exits: 1, sales: 1 } });
    expect(z.current.corrections).toMatchObject({ total: 1, paymentChanges: 1 });
    expect(z.current.expectedInDrawer).toBe(0); // la venta pasó a electrónico
    expect(z.history).toMatchObject({ withDifference: expect.any(Number) });
    // Sede ajena
    expect((await api(asFaca).get(`/api/admin/zones-status?siteId=${norte}`)).status).toBe(403);
    expect(res.body.data.every((x) => x.site.id === faca)).toBe(true);
    // Historial de la zona
    const hist = await api(asFaca).get(`/api/admin/zones/${zFaca}/history`);
    expect(hist.body.data.items.find((i) => i.shiftId === ids.shiftSat)).toMatchObject({ difference: -3000 });
    expect((await api(asNorte).get(`/api/admin/zones/${zFaca}/history`)).status).toBe(403);
  });
});

describe('RF32 alertas', () => {
  beforeAll(() => {
    alerts.resetState();
    presence.reset();
  });

  test('configuración por sede, con validación y permisos', async () => {
    const def = await api(asFaca).get(`/api/admin/alert-settings/${faca}`);
    expect(def.body.data.config.occupancy).toEqual({ enabled: true, threshold: 90 });
    const upd = await api(asFaca).put(`/api/admin/alert-settings/${faca}`, { cashDifference: { threshold: 1000 }, siteOffline: { minutes: 10 } });
    expect(upd.body.data.config.cashDifference).toEqual({ enabled: true, threshold: 1000 });
    expect((await api(asFaca).put(`/api/admin/alert-settings/${faca}`, { occupancy: { threshold: 150 } })).status).toBe(400);
    expect((await api(asNorte).put(`/api/admin/alert-settings/${faca}`, { occupancy: { threshold: 50 } })).status).toBe(403);
    expect(await auditCount('ALERT_SETTINGS_UPDATED')).toBe(1);
  });

  test('zona sin turno en su horario: una sola vez por ocurrencia, atender y descartar', async () => {
    const zSotano = (await query("SELECT id FROM zones WHERE site_id = $1 AND name = 'Sótano'", [faca])).rows[0]?.id
      ?? (await query("INSERT INTO zones (site_id, name) VALUES ($1, 'Sótano') RETURNING id", [faca])).rows[0].id;
    // Horario del miércoles 18/11/2026 de 08:00 a 16:00 en el Sótano (sin turno abierto)
    await api(asFaca).post('/api/admin/schedules', { siteId: faca, userId: ids.asFaca, zoneId: zSotano, weekday: 3, startTime: '08:00', endTime: '16:00' });
    const early = await alerts.evaluate([faca], local('2026-11-18T08:10:00'));
    expect(early.filter((a) => a.type === 'ZONE_WITHOUT_SHIFT')).toHaveLength(0); // dentro de los 15 min de gracia
    const late = await alerts.evaluate([faca], local('2026-11-18T08:30:00'));
    expect(late.filter((a) => a.type === 'ZONE_WITHOUT_SHIFT')).toHaveLength(1);
    expect((await alerts.evaluate([faca], local('2026-11-18T09:00:00'))).filter((a) => a.type === 'ZONE_WITHOUT_SHIFT')).toHaveLength(0);

    const open = (await api(asFaca).get('/api/admin/alerts')).body.data;
    const zoneAlert = open.find((a) => a.type === 'ZONE_WITHOUT_SHIFT');
    expect(zoneAlert).toMatchObject({ typeLabel: 'Zona sin turno', severity: 'DANGER', zone: { id: zSotano } });
    // El AS de otra sede no la ve ni la puede atender
    expect((await api(asNorte).get('/api/admin/alerts')).body.data.find((a) => a.id === zoneAlert.id)).toBeUndefined();
    expect((await api(asNorte).post(`/api/admin/alerts/${zoneAlert.id}/attend`, {})).status).toBe(403);
    expect((await api(asFaca).post(`/api/admin/alerts/${zoneAlert.id}/dismiss`, {})).body.code).toBe('NOTE_REQUIRED');
    const attended = await api(asFaca).post(`/api/admin/alerts/${zoneAlert.id}/attend`, { note: 'Se llamó al operador' });
    expect(attended.body.data).toMatchObject({ status: 'ATTENDED', resolution: { note: 'Se llamó al operador' } });
    expect((await api(asFaca).post(`/api/admin/alerts/${zoneAlert.id}/attend`, {})).body.code).toBe('ALREADY_RESOLVED');
    // Misma ocurrencia: no se repite aunque siga sin turno
    expect((await alerts.evaluate([faca], local('2026-11-18T10:00:00'))).filter((a) => a.type === 'ZONE_WITHOUT_SHIFT')).toHaveLength(0);
    // Otro miércoles sí
    expect((await alerts.evaluate([faca], local('2026-11-25T09:00:00'))).filter((a) => a.type === 'ZONE_WITHOUT_SHIFT')).toHaveLength(1);
    expect(await auditCount('ALERT_ATTENDED')).toBe(1);
  });

  test('ocupación por encima del límite (con espera de una hora después de atendida)', async () => {
    await query('UPDATE sites SET capacity = 2 WHERE id = $1', [faca]);
    await api(opFaca).post('/api/entries', { siteId: faca, plate: 'OCU001' });
    await api(opFaca).post('/api/entries', { siteId: faca, plate: 'OCU002' });
    const created = (await alerts.evaluate([faca])).filter((a) => a.type === 'OCCUPANCY_HIGH');
    expect(created).toHaveLength(1);
    expect(created[0].message).toContain('100%');
    const id = created[0].id;
    await api(asFaca).post(`/api/admin/alerts/${id}/dismiss`, { note: 'Fin de semana, normal' });
    expect((await alerts.evaluate([faca])).filter((a) => a.type === 'OCCUPANCY_HIGH')).toHaveLength(0);
    await query("UPDATE alerts SET resolved_at = now() - interval '61 minutes' WHERE id = $1", [id]);
    expect((await alerts.evaluate([faca])).filter((a) => a.type === 'OCCUPANCY_HIGH')).toHaveLength(1);
  });

  test('sede sin conexión más de N minutos; al reconectarse se reinicia', async () => {
    alerts.resetState();
    const t0 = new Date();
    expect((await alerts.evaluate([faca], t0)).filter((a) => a.type === 'SITE_OFFLINE')).toHaveLength(0);
    const t1 = new Date(t0.getTime() + 11 * 60000);
    const off = (await alerts.evaluate([faca], t1)).filter((a) => a.type === 'SITE_OFFLINE');
    expect(off).toHaveLength(1);
    expect(off[0].message).toContain('11 min');
    // Se conecta el operador: no hay más alertas y el conteo se reinicia
    presence.connected(ids.opFaca);
    expect((await alerts.evaluate([faca], new Date(t0.getTime() + 30 * 60000))).filter((a) => a.type === 'SITE_OFFLINE')).toHaveLength(0);
    presence.disconnected(ids.opFaca);
    expect((await alerts.evaluate([faca], new Date(t0.getTime() + 31 * 60000))).filter((a) => a.type === 'SITE_OFFLINE')).toHaveLength(0);
  });

  test('diferencia de arqueo mayor que el monto al cerrar el turno', async () => {
    const shift = (await api(opFaca).get('/api/shifts/current')).body.data;
    // Cuenta $ 5.000 de más
    const closed = await api(opFaca).post(`/api/shifts/${shift.id}/close`, { denominations: { 5000: 1 } });
    expect(closed.body.data.difference).toBe(5000 - shift.summary.expectedInDrawer);
    const list = (await api(ag).get(`/api/admin/alerts?siteId=${faca}`)).body.data;
    const cash = list.find((a) => a.type === 'CASH_DIFFERENCE');
    expect(cash).toMatchObject({ details: { shiftId: shift.id } });
    expect(cash.message).toMatch(/Sobrante|Faltante/);
    // El OP no ve el panel de alertas
    expect((await api(opFaca).get('/api/admin/alerts')).status).toBe(403);
    // Cerradas
    expect((await api(asFaca).get('/api/admin/alerts?status=closed')).body.data.length).toBeGreaterThanOrEqual(2);
  });
});

describe('RF33 comparativo entre sedes', () => {
  test('ingresos, ticket y estancia promedio, ocupación y productividad', async () => {
    const day = new Date(Date.now() - 5 * 3600000).toISOString().slice(0, 10);
    const res = await api(ag).get(`/api/admin/compare?from=2026-10-27&to=${day}`);
    expect(res.status).toBe(200);
    const f = res.body.data.sites.find((s) => s.site.code === 'FACA');
    expect(f.sales).toBe(1);
    expect(f.ticketAverage).toBe(f.parking);
    expect(f.averageStayMinutes).toBeGreaterThanOrEqual(89);
    expect(f.employees).toBeGreaterThanOrEqual(2);
    expect(f.workedHours).toBeGreaterThan(20);
    expect(f.occupancyAverage).not.toBeNull();
    expect(res.body.data.sites.map((s) => s.site.code).sort()).toEqual(['FACA', 'NORTE']);
    const own = (await api(asNorte).get(`/api/admin/compare?from=2026-10-27&to=${day}`)).body.data.sites;
    expect(own.map((s) => s.site.code)).toEqual(['NORTE']);
    expect(own[0]).toMatchObject({ employees: 1, workedHours: 8 });
    expect((await api(opFaca).get(`/api/admin/compare?from=2026-10-27&to=${day}`)).status).toBe(403);
  });
});
