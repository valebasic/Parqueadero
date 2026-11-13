// SMS (V4): código del portal y avisos de mensualidad. Se usa un enviador falso: no sale nada real.
process.env.PORTAL_LOOKUP_IP_LIMIT = '1000';
process.env.PORTAL_LOOKUP_PLATE_LIMIT = '1000';
const request = require('supertest');
const { query, closePool } = require('../../src/db/pool');
const { app, freshDatabase, siteIdByCode } = require('./helpers');
const mail = require('../../src/services/mail.service');
const sms = require('../../src/services/sms.service');
const { runMonthlyReminders } = require('../../src/services/notification.service');

let site;
const sentSms = [];
const sentMail = [];
const portal = { post: (p, body = {}) => request(app).post(`/api/portal${p}`).send(body) };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const smsCode = () => /código es (\d{6})/.exec(sentSms[sentSms.length - 1]?.body ?? '')?.[1];

async function addPlan(plate, { phones = ['3001234567'], email = null, endOffset = 12 } = {}) {
  const { rows } = await query(
    `INSERT INTO monthly_plans (site_id, plate, vehicle_type, client_name, phones, start_date, end_date, amount,
                                email, data_consent, data_consent_at, origin, payment_status)
     VALUES ($1, $2, 'CAR', 'Ana Titular', $3::text[], CURRENT_DATE - 18, CURRENT_DATE + $4::int, 130000,
             $5, true, now(), 'MANUAL', 'PAID') RETURNING id`,
    [site, plate, phones, endOffset, email],
  );
  return rows[0].id;
}

beforeAll(async () => {
  delete process.env.WOMPI_PUBLIC_KEY;
  await freshDatabase();
  site = await siteIdByCode('FACA');
  sms.setSenderForTests(async (m) => { sentSms.push(m); });
  mail.setTransportForTests({ sendMail: async (m) => { sentMail.push(m); } });
});
beforeEach(() => { sentSms.length = 0; sentMail.length = 0; });
afterAll(async () => {
  sms.setSenderForTests(null);
  mail.setTransportForTests(null);
  await closePool();
});

describe('utilidades', () => {
  test('solo los celulares colombianos reciben SMS; el número se enmascara', () => {
    expect(sms.toE164('300 123 4567')).toBe('+573001234567');
    expect(sms.toE164('6012345678')).toBeNull(); // fijo
    expect(sms.toE164('1234567')).toBeNull();
    expect(sms.isMobile('3001234567')).toBe(true);
    expect(sms.maskPhone('3001234567')).toBe('300***4567');
  });
});

describe('código del portal por SMS', () => {
  test('flujo completo: el código llega por SMS al celular (no al fijo) y abre la mensualidad', async () => {
    await addPlan('SMS111', { phones: ['6012345678', '3001234567'] });
    const r = await portal.post('/consulta/codigo', { placa: 'SMS111', canal: 'SMS' });
    expect(r.status).toBe(200);
    expect(r.body.data.devCode).toBeUndefined();
    await wait(200);
    expect(sentSms).toHaveLength(1);
    expect(sentSms[0].to).toBe('+573001234567');
    expect(sentMail).toHaveLength(0);
    const ok = await portal.post('/consulta/verificar', { placa: 'SMS111', codigo: smsCode() });
    expect(ok.status).toBe(200);
    const { rows } = await query("SELECT recipient, channel, status FROM notification_log WHERE kind = 'PORTAL_CODE'");
    expect(rows[0]).toEqual({ recipient: '300***4567', channel: 'SMS', status: 'SENT' });
  });

  test('si el plan no tiene celular (solo fijo) o no tiene el medio elegido: misma respuesta y nada se envía', async () => {
    await addPlan('SMS222', { phones: ['6012345678'], email: 'solo@correo.com' });
    const a = await portal.post('/consulta/codigo', { placa: 'SMS222', canal: 'SMS' });
    const b = await portal.post('/consulta/codigo', { placa: 'QQQ999', canal: 'SMS' });
    expect(a.body.data.message).toBe(b.body.data.message);
    await wait(150);
    expect(sentSms).toHaveLength(0);
    // por correo ese mismo plan sí recibe
    await wait(1); // (el límite de reenvío es de 60 s, pero aún no se creó ningún código)
    await portal.post('/consulta/codigo', { placa: 'SMS222', canal: 'EMAIL' });
    await wait(200);
    expect(sentMail).toHaveLength(1);
  });
});

describe('avisos de mensualidad por SMS', () => {
  test('avisa por SMS al celular, una sola vez, y también por correo si lo hay', async () => {
    await addPlan('SMR003', { phones: ['6012345678', '3109998888'], email: 'dos@correo.com', endOffset: 3 });
    await addPlan('SMR001', { phones: ['3101112222'], endOffset: 1 }); // solo SMS
    await addPlan('SMR006', { phones: ['6012345678'], endOffset: 6 }); // solo fijo y sin correo: nada
    const r1 = await runMonthlyReminders();
    expect(r1.sms).toBe(2);
    expect(sentSms.map((m) => m.to).sort()).toEqual(['+573101112222', '+573109998888']);
    expect(sentSms.every((m) => m.body.length <= 160)).toBe(true);
    expect(sentMail).toHaveLength(1);
    await runMonthlyReminders(); // mismo día: no repite
    expect(sentSms).toHaveLength(2);
    expect(sentMail).toHaveLength(1);
  });

  test('el tope diario frena los SMS', async () => {
    process.env.SMS_DAILY_LIMIT = '1';
    try {
      await addPlan('LIM001', { phones: ['3201110000'], endOffset: 3 });
      await addPlan('LIM002', { phones: ['3201110001'], endOffset: 3 });
      // Ya hay SMS enviados hoy por las pruebas anteriores: el tope de 1 se supera
      sentSms.length = 0;
      await runMonthlyReminders();
      expect(sentSms).toHaveLength(0);
      const { rows } = await query("SELECT error FROM notification_log WHERE status = 'FAILED' AND channel = 'SMS' LIMIT 1");
      expect(rows[0].error).toMatch(/límite diario/);
    } finally {
      delete process.env.SMS_DAILY_LIMIT;
    }
  });

  test('un fallo del proveedor no rompe nada y queda en la bitácora', async () => {
    sms.setSenderForTests(async () => { throw new Error('Twilio caído'); });
    await addPlan('FAL001', { phones: ['3301110000'], endOffset: 1 });
    await expect(runMonthlyReminders()).resolves.toBeDefined();
    const { rows } = await query("SELECT status, error FROM notification_log WHERE channel = 'SMS' ORDER BY id DESC LIMIT 1");
    expect(rows[0]).toMatchObject({ status: 'FAILED' });
    sms.setSenderForTests(async (m) => { sentSms.push(m); });
  });
});
