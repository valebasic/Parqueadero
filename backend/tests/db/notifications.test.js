// Notificaciones por correo (V4): comprobante del portal y avisos de mensualidad.
// Se usa un transporte falso: no se envía nada real.
const request = require('supertest');
const { query, closePool } = require('../../src/db/pool');
const { app, freshDatabase, siteIdByCode, createUser, loginAs } = require('./helpers');
const mail = require('../../src/services/mail.service');
const { runMonthlyReminders } = require('../../src/services/notification.service');

let site;
let op;
const sent = [];

const staff = {
  post: (p, body = {}) => request(app).post(p).set(...op.auth).send(body),
};
const portal = { post: (p, body = {}) => request(app).post(`/api/portal${p}`).send(body) };

async function addMonthly({ plate, endOffset, email = 'cliente@correo.com', consent = true }) {
  const { rows } = await query(
    `INSERT INTO monthly_plans (site_id, plate, vehicle_type, client_name, start_date, end_date, amount,
                                email, data_consent, data_consent_at, origin)
     VALUES ($1, $2, 'CAR', 'María Pérez', CURRENT_DATE - 20, CURRENT_DATE + $3::int, 130000, $4, $5,
             CASE WHEN $5 THEN now() END, CASE WHEN $5 THEN 'MANUAL' ELSE 'CSV_IMPORT' END)
     RETURNING id`,
    [site, plate, endOffset, email, consent],
  );
  return rows[0].id;
}

beforeAll(async () => {
  delete process.env.WOMPI_PUBLIC_KEY;
  await freshDatabase();
  site = await siteIdByCode('FACA');
  await createUser({ username: 'opn', role: 'OP', siteIds: [site] });
  op = await loginAs('opn');
  const zone = (await query('SELECT id FROM zones WHERE site_id = $1', [site])).rows[0].id;
  expect((await staff.post('/api/shifts', { zoneId: zone, denominations: { 50000: 1 } })).status).toBe(201);
  mail.setTransportForTests({ sendMail: async (m) => { sent.push(m); } });
});
beforeEach(() => { sent.length = 0; });
afterAll(async () => {
  mail.setTransportForTests(null);
  await closePool();
});

async function payWith(plate, email) {
  const e = await staff.post('/api/entries', { siteId: site, plate });
  const entryId = e.body.data.entryId;
  await query("UPDATE entries SET entry_at = now() - interval '30 minutes' WHERE id = $1", [entryId]);
  return portal.post('/pagos', { sede: 'FACA', recibo: e.body.data.receipt, email });
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

describe('comprobante de pago del portal', () => {
  test('con correo: se envía una sola vez al aprobar', async () => {
    const p = await payWith('MAI111', 'Cliente@Correo.com');
    expect(p.status).toBe(201);
    expect(sent).toHaveLength(0); // aún no se paga
    await portal.post(`/pagos/${p.body.data.reference}/simular`, { resultado: 'APPROVED' });
    await wait(300);
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe('cliente@correo.com');
    expect(sent[0].subject).toMatch(/Comprobante de pago/);
    expect(sent[0].text).toMatch(/MAI111/);
    expect(sent[0].text).toMatch(/sin cobro adicional/);
    // repetir la aprobación no reenvía
    await portal.post(`/pagos/${p.body.data.reference}/simular`, { resultado: 'APPROVED' });
    await wait(200);
    expect(sent).toHaveLength(1);
    const { rows } = await query("SELECT recipient, status FROM notification_log WHERE kind = 'PAYMENT_RECEIPT'");
    expect(rows[0]).toMatchObject({ recipient: 'c***@correo.com', status: 'SENT' });
  });

  test('sin correo: no se envía nada; con correo inválido: 400', async () => {
    const p = await payWith('MAI222', '');
    await portal.post(`/pagos/${p.body.data.reference}/simular`, { resultado: 'APPROVED' });
    await wait(200);
    expect(sent).toHaveLength(0);
    const bad = await payWith('MAI333', 'no-es-correo');
    expect(bad.status).toBe(400);
  });

  test('si el correo falla, el pago igual queda aprobado', async () => {
    mail.setTransportForTests({ sendMail: async () => { throw new Error('SMTP caído'); } });
    const p = await payWith('MAI444', 'otro@correo.com');
    const r = await portal.post(`/pagos/${p.body.data.reference}/simular`, { resultado: 'APPROVED' });
    expect(r.body.data.status).toBe('APPROVED');
    await wait(200);
    const { rows } = await query(
      "SELECT status FROM notification_log WHERE entity_id = (SELECT id::text FROM portal_payments WHERE reference = $1)",
      [p.body.data.reference],
    );
    expect(rows[0].status).toBe('FAILED');
    mail.setTransportForTests({ sendMail: async (m) => { sent.push(m); } });
  });
});

describe('avisos de mensualidad', () => {
  test('avisa a 6, 3 y 1 días y al día siguiente del vencimiento, una sola vez cada uno', async () => {
    await addMonthly({ plate: 'MEN006', endOffset: 6 });
    await addMonthly({ plate: 'MEN003', endOffset: 3 });
    await addMonthly({ plate: 'MEN001', endOffset: 1 });
    await addMonthly({ plate: 'MENV01', endOffset: -1 });
    await addMonthly({ plate: 'MEN010', endOffset: 10 }); // fuera de los días de aviso
    const r1 = await runMonthlyReminders();
    expect(r1).toEqual({ due: 3, overdue: 1 });
    expect(sent).toHaveLength(4);
    expect(sent.some((m) => /vence en 6 días/.test(m.subject))).toBe(true);
    expect(sent.some((m) => /vence en 1 día /.test(m.subject))).toBe(true);
    expect(sent.some((m) => /vencida/.test(m.subject))).toBe(true);
    const r2 = await runMonthlyReminders(); // mismo día: no repite
    expect(r2).toEqual({ due: 0, overdue: 0 });
    expect(sent).toHaveLength(4);
  });

  test('no avisa sin correo, sin autorización de datos ni si ya renovó', async () => {
    await addMonthly({ plate: 'NOM001', endOffset: 3, email: null });
    await addMonthly({ plate: 'NOC001', endOffset: 3, consent: false });
    await addMonthly({ plate: 'REN001', endOffset: 3 });
    await query(
      `INSERT INTO monthly_plans (site_id, plate, vehicle_type, client_name, start_date, end_date, amount, email, data_consent, data_consent_at)
       VALUES ($1, 'REN001', 'CAR', 'María Pérez', CURRENT_DATE + 4, CURRENT_DATE + 34, 130000, 'cliente@correo.com', true, now())`,
      [site],
    );
    const r = await runMonthlyReminders();
    expect(r).toEqual({ due: 0, overdue: 0 });
    expect(sent).toHaveLength(0);
  });
});

describe('aviso manual desde el panel principal (botón del sobre)', () => {
  let admin;
  const asAdmin = (m, p, body) => request(app)[m](p).set(...admin.auth).send(body);

  beforeAll(async () => {
    await createUser({ username: 'adm1', role: 'AS', siteIds: [site] });
    admin = await loginAs('adm1');
  });

  test('el administrador envía el aviso por correo; el operador no puede; no se repite en 10 minutos', async () => {
    const id = await addMonthly({ plate: 'MAN001', endOffset: 5 });
    const op1 = await request(app).post(`/api/monthly/${id}/remind`).set(...op.auth).send({});
    expect(op1.status).toBe(403);

    const r = await asAdmin('post', `/api/monthly/${id}/remind`, {});
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual({ sent: true, to: 'c***@correo.com' });
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe('cliente@correo.com');
    expect(sent[0].subject).toMatch(/Su mensualidad vence en 5 días · MAN001/);
    expect(sent[0].text).toMatch(/Hola María Pérez/);
    expect(sent[0].text).toMatch(/\/pagar\/[A-Za-z0-9_-]{22}/);

    const again = await asAdmin('post', `/api/monthly/${id}/remind`, {});
    expect(again.status).toBe(429);
    expect(again.body.code).toBe('RECENTLY_SENT');
    expect(sent).toHaveLength(1);

    const { rows } = await query("SELECT user_id, details FROM audit_log WHERE action = 'MONTHLY_REMINDER_MANUAL' AND entity_id = $1", [String(id)]);
    expect(rows).toHaveLength(1);
    expect(rows[0].details.to).toBe('c***@correo.com'); // la bitácora no guarda el correo completo
  });

  test('avisa también el día que vence y cuando ya está vencida (no solo a 6, 3 y 1 días)', async () => {
    const hoy = await addMonthly({ plate: 'MAN002', endOffset: 0 });
    const mora = await addMonthly({ plate: 'MAN003', endOffset: -4 });
    await asAdmin('post', `/api/monthly/${hoy}/remind`, {});
    await asAdmin('post', `/api/monthly/${mora}/remind`, {});
    expect(sent[0].subject).toMatch(/vence hoy · MAN002/);
    expect(sent[1].subject).toMatch(/Mensualidad vencida · MAN003/);
  });

  test('sin correo o sin autorización de datos: 409 y no se envía nada; el panel lo marca', async () => {
    const sinCorreo = await addMonthly({ plate: 'MAN004', endOffset: 2, email: null });
    const sinConsent = await addMonthly({ plate: 'MAN005', endOffset: 2, consent: false });
    expect((await asAdmin('post', `/api/monthly/${sinCorreo}/remind`, {})).body.code).toBe('NO_EMAIL');
    expect((await asAdmin('post', `/api/monthly/${sinConsent}/remind`, {})).body.code).toBe('NO_CONSENT');
    expect(sent).toHaveLength(0);

    const { rows: dash } = await query('SELECT 1');
    expect(dash).toHaveLength(1);
    const d = await asAdmin('get', `/api/reports/dashboard?siteId=${site}`);
    const byPlate = Object.fromEntries(d.body.data.monthlyAlerts.map((a) => [a.plate, a]));
    expect(byPlate.MAN004).toMatchObject({ canNotify: false, notifyReason: 'Sin correo registrado' });
    expect(byPlate.MAN005).toMatchObject({ canNotify: false, notifyReason: 'Sin autorización de datos' });
    expect(byPlate.MAN002).toMatchObject({ canNotify: true, notifyReason: null });
  });

  test('una mensualidad inexistente: 404', async () => {
    expect((await asAdmin('post', '/api/monthly/99999999/remind', {})).status).toBe(404);
  });
});
