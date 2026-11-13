// Portal del cliente, pantalla 3: consulta por placa (tiquete o mensualidad con código por correo).
// Los límites reales se prueban aparte; aquí se amplían para no mezclar pruebas
process.env.PORTAL_LOOKUP_IP_LIMIT = '1000';
process.env.PORTAL_LOOKUP_PLATE_LIMIT = '1000';
const request = require('supertest');
const { query, closePool } = require('../../src/db/pool');
const { app, freshDatabase, siteIdByCode, createUser, loginAs } = require('./helpers');
const mail = require('../../src/services/mail.service');

let site;
let op;
const sent = [];
const portal = {
  get: (p, token) => {
    const r = request(app).get(`/api/portal${p}`);
    return token ? r.set('Authorization', `Bearer ${token}`) : r;
  },
  post: (p, body = {}) => request(app).post(`/api/portal${p}`).send(body),
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const lastCode = () => /Su código es: (\d{6})/.exec(sent[sent.length - 1]?.text ?? '')?.[1];

async function addPlan(plate, { email = 'titular@correo.com', consent = true, endOffset = 12 } = {}) {
  const { rows } = await query(
    `INSERT INTO monthly_plans (site_id, plate, vehicle_type, client_name, phones, start_date, end_date, amount,
                                email, data_consent, data_consent_at, origin, payment_status)
     VALUES ($1, $2, 'CAR', 'Ana Titular', '{3001234567}', CURRENT_DATE - 18, CURRENT_DATE + $3::int, 130000,
             $4, $5, CASE WHEN $5 THEN now() END, CASE WHEN $5 THEN 'MANUAL' ELSE 'CSV_IMPORT' END, 'PAID')
     RETURNING id`,
    [site, plate, endOffset, email, consent],
  );
  await query(
    `INSERT INTO monthly_payments (site_id, monthly_plan_id, receipt_prefix, receipt_number, period_start, period_end,
                                   base_amount, amount, payment_method, cash_amount, electronic_amount)
     VALUES ($1, $2, 'FM', $3, CURRENT_DATE - 18, CURRENT_DATE + 12, 130000, 130000, 'CASH', 130000, 0)`,
    [site, rows[0].id, rows[0].id],
  );
  return rows[0].id;
}

beforeAll(async () => {
  delete process.env.WOMPI_PUBLIC_KEY;
  await freshDatabase();
  site = await siteIdByCode('FACA');
  await createUser({ username: 'opl', role: 'OP', siteIds: [site] });
  op = await loginAs('opl');
  const zone = (await query('SELECT id FROM zones WHERE site_id = $1', [site])).rows[0].id;
  expect((await request(app).post('/api/shifts').set(...op.auth).send({ zoneId: zone, denominations: { 50000: 1 } })).status).toBe(201);
  mail.setTransportForTests({ sendMail: async (m) => { sent.push(m); } });
});
beforeEach(() => { sent.length = 0; });
afterAll(async () => {
  mail.setTransportForTests(null);
  await closePool();
});

describe('(a) tiquete: placa + recibo', () => {
  test('con placa y recibo correctos devuelve a qué pantalla ir; con otra placa, 404 igual', async () => {
    const e = await request(app).post('/api/entries').set(...op.auth).send({ siteId: site, plate: 'TIQ123' });
    const receipt = e.body.data.receipt;
    const ok = await portal.post('/consulta/tiquete', { placa: 'tiq-123', recibo: receipt });
    expect(ok.status).toBe(200);
    expect(ok.body.data).toEqual({ sede: 'FACA', recibo: receipt });
    const wrong = await portal.post('/consulta/tiquete', { placa: 'ZZZ999', recibo: receipt });
    expect(wrong.status).toBe(404);
    expect((await portal.post('/consulta/tiquete', { placa: 'TIQ123', recibo: 'FA9999' })).status).toBe(404);
    expect((await portal.post('/consulta/tiquete', { placa: 'basura', recibo: receipt })).status).toBe(400);
  });
});

describe('(b) mensualidad: código por correo', () => {
  test('flujo completo: pedir código, verificar y ver la mensualidad', async () => {
    await addPlan('MEN111');
    const r = await portal.post('/consulta/codigo', { placa: 'MEN-111' });
    expect(r.status).toBe(200);
    expect(r.body.data.message).toMatch(/Si la placa tiene/);
    expect(r.body.data.devCode).toBeUndefined(); // en pruebas nunca se muestra
    await wait(200);
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe('titular@correo.com');
    const code = lastCode();
    expect(code).toMatch(/^\d{6}$/);

    const bad = await portal.post('/consulta/verificar', { placa: 'MEN111', codigo: code === '000000' ? '111111' : '000000' });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('INVALID_CODE');

    const ok = await portal.post('/consulta/verificar', { placa: 'MEN111', codigo: code });
    expect(ok.status).toBe(200);
    const token = ok.body.data.token;

    // Un solo uso
    expect((await portal.post('/consulta/verificar', { placa: 'MEN111', codigo: code })).status).toBe(400);

    const view = await portal.get('/mensualidad', token);
    expect(view.status).toBe(200);
    expect(view.body.data).toMatchObject({
      plate: 'MEN111', clientName: 'Ana Titular', status: 'ACTIVE', daysLeft: 12, emailMasked: 't***@correo.com',
      paymentStatus: 'PAID', currentStay: null,
    });
    expect(view.body.data.payments).toHaveLength(1);
    // No expone teléfonos ni el correo completo
    const text = JSON.stringify(view.body);
    expect(text).not.toMatch(/3001234567|titular@correo\.com/);
  });

  test('no revela si la placa existe: misma respuesta y sin correo enviado', async () => {
    await addPlan('SIN111', { email: null });
    await addPlan('NOC111', { consent: false });
    const a = await portal.post('/consulta/codigo', { placa: 'SIN111' });
    const b = await portal.post('/consulta/codigo', { placa: 'NOC111' });
    const c = await portal.post('/consulta/codigo', { placa: 'QQQ999' });
    expect([a.status, b.status, c.status]).toEqual([200, 200, 200]);
    expect(a.body.data.message).toBe(c.body.data.message);
    await wait(150);
    expect(sent).toHaveLength(0);
    expect((await portal.post('/consulta/verificar', { placa: 'QQQ999', codigo: '123456' })).body.code).toBe('INVALID_CODE');
  });

  test('tras 5 intentos fallidos el código deja de servir, aunque se acierte después', async () => {
    await addPlan('INT111');
    await portal.post('/consulta/codigo', { placa: 'INT111' });
    await wait(200);
    const code = lastCode();
    const wrong = code === '123456' ? '654321' : '123456';
    for (let i = 0; i < 5; i += 1) expect((await portal.post('/consulta/verificar', { placa: 'INT111', codigo: wrong })).status).toBe(400);
    expect((await portal.post('/consulta/verificar', { placa: 'INT111', codigo: code })).status).toBe(400);
  });

  test('un código vencido no sirve y no se puede pedir otro de inmediato', async () => {
    await addPlan('VEN111');
    await portal.post('/consulta/codigo', { placa: 'VEN111' });
    await wait(200);
    const code = lastCode();
    await portal.post('/consulta/codigo', { placa: 'VEN111' }); // dentro de 60 s: no se envía otro
    await wait(150);
    expect(sent).toHaveLength(1);
    await query("UPDATE portal_codes SET expires_at = now() - interval '1 minute'");
    expect((await portal.post('/consulta/verificar', { placa: 'VEN111', codigo: code })).status).toBe(400);
  });

  test('la vista exige el token del portal: sin token, token de empleado o basura = 401', async () => {
    expect((await portal.get('/mensualidad')).status).toBe(401);
    expect((await portal.get('/mensualidad', 'basura')).status).toBe(401);
    expect((await portal.get('/mensualidad', op.token)).status).toBe(401);
    // y el token del portal no abre la API de empleados
    await addPlan('TOK111');
    await portal.post('/consulta/codigo', { placa: 'TOK111' });
    await wait(200);
    const t = (await portal.post('/consulta/verificar', { placa: 'TOK111', codigo: lastCode() })).body.data.token;
    expect((await request(app).get('/api/shifts/current').set('Authorization', `Bearer ${t}`)).status).toBe(401);
  });
});
