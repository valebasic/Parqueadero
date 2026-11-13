// Portal del cliente: pagar o renovar la mensualidad en línea (simulado y webhook firmado de Wompi).
process.env.PORTAL_LOOKUP_IP_LIMIT = '1000';
process.env.PORTAL_LOOKUP_PLATE_LIMIT = '1000';
process.env.PORTAL_PAY_RATE_LIMIT_MAX = '1000';
const request = require('supertest');
const { query, closePool } = require('../../src/db/pool');
const { app, freshDatabase, siteIdByCode } = require('./helpers');
const mail = require('../../src/services/mail.service');
const { sha256 } = require('../../src/services/wompi.service');

let site;
const sent = [];
const portal = {
  get: (p, token) => request(app).get(`/api/portal${p}`).set('Authorization', `Bearer ${token ?? ''}`),
  post: (p, body = {}, token) => {
    const r = request(app).post(`/api/portal${p}`);
    return (token ? r.set('Authorization', `Bearer ${token}`) : r).send(body);
  },
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function addPlan(plate, { endOffset, status = 'PAID', biweekly = false, email = 'titular@correo.com' } = {}) {
  const { rows } = await query(
    `INSERT INTO monthly_plans (site_id, plate, vehicle_type, client_name, phones, start_date, end_date, amount,
                                email, data_consent, data_consent_at, origin, payment_status, is_biweekly)
     VALUES ($1, $2, 'CAR', 'Ana Titular', '{3001234567}', CURRENT_DATE + $3::int - 30, CURRENT_DATE + $3::int, 130000,
             $4, true, now(), 'MANUAL', $5, $6) RETURNING id`,
    [site, plate, endOffset, email, status, biweekly],
  );
  return rows[0].id;
}

// Sesión del portal del titular (código por correo)
async function sessionFor(plate) {
  sent.length = 0;
  await portal.post('/consulta/codigo', { placa: plate });
  await wait(200);
  const code = /Su código es: (\d{6})/.exec(sent[sent.length - 1]?.text ?? '')?.[1];
  const r = await portal.post('/consulta/verificar', { placa: plate, codigo: code });
  expect(r.status).toBe(200);
  return r.body.data.token;
}

const planRow = async (id) => (await query(
  'SELECT start_date::text AS s, end_date::text AS e, next_period_start::text AS ns, next_period_end::text AS ne, payment_status FROM monthly_plans WHERE id = $1', [id],
)).rows[0];
const plusDays = async (n) => (await query('SELECT (CURRENT_DATE + $1::int)::text AS d', [n])).rows[0].d;
const plusMonth = async (n, months = 1) => (await query("SELECT ((CURRENT_DATE + $1::int) + make_interval(months => $2))::date::text AS d", [n, months])).rows[0].d;

beforeAll(async () => {
  delete process.env.WOMPI_PUBLIC_KEY;
  await freshDatabase();
  site = await siteIdByCode('FACA');
  mail.setTransportForTests({ sendMail: async (m) => { sent.push(m); } });
});
afterAll(async () => {
  mail.setTransportForTests(null);
  await closePool();
});

describe('renovar (vence en 1 día o ya venció)', () => {
  test('pagar → se registra el pago FM electrónico y la vigencia avanza un mes; llega el comprobante', async () => {
    const id = await addPlan('PRN111', { endOffset: 1 });
    const token = await sessionFor('PRN111');

    const view = (await portal.get('/mensualidad', token)).body.data;
    expect(view.payOnline).toMatchObject({ canPay: true, mode: 'RENEW', amount: 130000 });

    const p = await portal.post('/mensualidad/pagos', {}, token);
    expect(p.status).toBe(201);
    expect(p.body.data).toMatchObject({ mode: 'mock', amount: 130000 });
    expect((await planRow(id)).e).toBe(await plusDays(1)); // aún sin pagar

    sent.length = 0;
    const ok = await portal.post(`/mensualidad/pagos/${p.body.data.reference}/simular`, { resultado: 'APPROVED' }, token);
    expect(ok.body.data).toMatchObject({ status: 'APPROVED', kind: 'MONTHLY', amount: 130000, needsReview: false });
    expect(ok.body.data.receipt).toMatch(/^FM\d+$/);
    expect(ok.body.data.validUntil).toBe(await plusMonth(1));

    const plan = await planRow(id);
    expect(plan).toMatchObject({ s: await plusDays(1), e: await plusMonth(1), payment_status: 'PAID', ne: null });
    const { rows } = await query('SELECT payment_method, cash_amount, electronic_amount, paid_by, is_advance FROM monthly_payments WHERE monthly_plan_id = $1 ORDER BY id DESC LIMIT 1', [id]);
    expect(rows[0]).toEqual({ payment_method: 'ELECTRONIC', cash_amount: 0, electronic_amount: 130000, paid_by: null, is_advance: false });

    await wait(300);
    expect(sent.some((m) => /Comprobante de mensualidad/.test(m.subject) && m.to === 'titular@correo.com')).toBe(true);

    // Repetir la aprobación no duplica el pago
    await portal.post(`/mensualidad/pagos/${p.body.data.reference}/simular`, { resultado: 'APPROVED' }, token);
    expect((await query('SELECT count(*)::int AS n FROM monthly_payments WHERE monthly_plan_id = $1', [id])).rows[0].n).toBe(1);
  });

  test('vencida: el período continúa desde la fecha de fin anterior (sin límite de mora)', async () => {
    const id = await addPlan('PRN222', { endOffset: -5 });
    const token = await sessionFor('PRN222');
    const p = await portal.post('/mensualidad/pagos', {}, token);
    await portal.post(`/mensualidad/pagos/${p.body.data.reference}/simular`, { resultado: 'APPROVED' }, token);
    expect(await planRow(id)).toMatchObject({ s: await plusDays(-5), e: await plusMonth(-5) });
  });

  test('primer pago de una mensualidad pendiente', async () => {
    const id = await addPlan('PRN333', { endOffset: 20, status: 'PENDING' });
    const token = await sessionFor('PRN333');
    expect((await portal.get('/mensualidad', token)).body.data.payOnline.mode).toBe('FIRST');
    const p = await portal.post('/mensualidad/pagos', {}, token);
    await portal.post(`/mensualidad/pagos/${p.body.data.reference}/simular`, { resultado: 'APPROVED' }, token);
    expect(await planRow(id)).toMatchObject({ payment_status: 'PAID', e: await plusDays(20) }); // paga el período actual
  });
});

describe('pago adelantado (faltan más de 1 día)', () => {
  test('el siguiente período queda en cola; no se puede adelantar dos veces', async () => {
    const id = await addPlan('PRE111', { endOffset: 12 });
    const token = await sessionFor('PRE111');
    expect((await portal.get('/mensualidad', token)).body.data.payOnline.mode).toBe('PREPAY');
    const p = await portal.post('/mensualidad/pagos', {}, token);
    const ok = await portal.post(`/mensualidad/pagos/${p.body.data.reference}/simular`, { resultado: 'APPROVED' }, token);
    expect(ok.body.data.status).toBe('APPROVED');
    expect(await planRow(id)).toMatchObject({ e: await plusDays(12), ns: await plusDays(12), ne: await plusMonth(12) });
    const { rows } = await query('SELECT is_advance FROM monthly_payments WHERE monthly_plan_id = $1', [id]);
    expect(rows[0].is_advance).toBe(true);
    const again = await portal.post('/mensualidad/pagos', {}, token);
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('NOT_PAYABLE_ONLINE');
  });
});

describe('casos que se atienden en el parqueadero y seguridad', () => {
  test('quincenal: no se puede pagar en línea', async () => {
    await addPlan('QUI111', { endOffset: 1, biweekly: true });
    const token = await sessionFor('QUI111');
    expect((await portal.get('/mensualidad', token)).body.data.payOnline.canPay).toBe(false);
    expect((await portal.post('/mensualidad/pagos', {}, token)).status).toBe(409);
  });

  test('un pago rechazado no cambia nada y se puede reintentar', async () => {
    const id = await addPlan('REJ111', { endOffset: 1 });
    const token = await sessionFor('REJ111');
    const p = await portal.post('/mensualidad/pagos', {}, token);
    const r = await portal.post(`/mensualidad/pagos/${p.body.data.reference}/simular`, { resultado: 'DECLINED' }, token);
    expect(r.body.data.status).toBe('DECLINED');
    expect((await planRow(id)).e).toBe(await plusDays(1));
    expect((await portal.post('/mensualidad/pagos', {}, token)).status).toBe(201);
  });

  test('sin sesión del portal = 401; el pago de otra mensualidad no se puede simular', async () => {
    expect((await portal.post('/mensualidad/pagos', {})).status).toBe(401);
    await addPlan('SEG111', { endOffset: 1 });
    await addPlan('SEG222', { endOffset: 1 });
    const t1 = await sessionFor('SEG111');
    const t2 = await sessionFor('SEG222');
    const p = await portal.post('/mensualidad/pagos', {}, t1);
    const stolen = await portal.post(`/mensualidad/pagos/${p.body.data.reference}/simular`, { resultado: 'APPROVED' }, t2);
    expect(stolen.status).toBe(404);
  });

  test('la consulta pública del estado del pago no filtra datos personales', async () => {
    await addPlan('PUB111', { endOffset: 1 });
    const token = await sessionFor('PUB111');
    const p = await portal.post('/mensualidad/pagos', {}, token);
    const s = await request(app).get(`/api/portal/pagos/${p.body.data.reference}`);
    expect(s.status).toBe(200);
    expect(Object.keys(s.body.data).sort()).toEqual(['amount', 'kind', 'needsReview', 'paidAt', 'receipt', 'reference', 'status', 'validUntil']);
    expect(JSON.stringify(s.body)).not.toMatch(/Ana|PUB111|titular@/);
  });
});

describe('webhook de Wompi para mensualidades', () => {
  const EVENTS_SECRET = 'test_events_mensual';
  const signed = (tx, secret = EVENTS_SECRET) => {
    const timestamp = 1700000001;
    return {
      event: 'transaction.updated',
      data: { transaction: tx },
      timestamp,
      signature: {
        properties: ['transaction.id', 'transaction.status', 'transaction.amount_in_cents'],
        checksum: sha256(`${tx.id}${tx.status}${tx.amount_in_cents}${timestamp}${secret}`),
      },
    };
  };
  beforeAll(() => {
    process.env.WOMPI_PUBLIC_KEY = 'pub_test_x';
    process.env.WOMPI_INTEGRITY_SECRET = 'test_integrity_x';
    process.env.WOMPI_EVENTS_SECRET = EVENTS_SECRET;
  });
  afterAll(() => {
    delete process.env.WOMPI_PUBLIC_KEY;
    delete process.env.WOMPI_INTEGRITY_SECRET;
    delete process.env.WOMPI_EVENTS_SECRET;
  });

  test('checkout con firma de integridad; el evento firmado aplica el pago una sola vez', async () => {
    const id = await addPlan('WOM111', { endOffset: 1 });
    const token = await sessionFor('WOM111');
    const p = await portal.post('/mensualidad/pagos', {}, token);
    expect(p.body.data.mode).toBe('wompi');
    const url = new URL(p.body.data.checkoutUrl);
    expect(url.searchParams.get('reference')).toMatch(/^NXM-/);
    expect(url.searchParams.get('signature:integrity')).toBe(sha256(`${p.body.data.reference}13000000COPtest_integrity_x`));
    expect(url.searchParams.get('redirect-url')).toMatch(/\/portal\?tab=mensualidad&ref=NXM-/);
    // en modo real no existe la simulación
    expect((await portal.post(`/mensualidad/pagos/${p.body.data.reference}/simular`, { resultado: 'APPROVED' }, token)).status).toBe(404);

    const tx = { id: 'txm-1', status: 'APPROVED', amount_in_cents: 13000000, reference: p.body.data.reference };
    expect((await portal.post('/wompi/webhook', signed(tx, 'otro'))).status).toBe(401);
    expect((await portal.post('/wompi/webhook', signed({ ...tx, id: 'txm-2', amount_in_cents: 100 }))).status).toBe(409);
    expect((await planRow(id)).e).toBe(await plusDays(1));

    expect((await portal.post('/wompi/webhook', signed(tx))).status).toBe(200);
    expect((await portal.post('/wompi/webhook', signed(tx))).status).toBe(200); // repetido
    expect((await planRow(id)).e).toBe(await plusMonth(1));
    expect((await query('SELECT count(*)::int AS n FROM monthly_payments WHERE monthly_plan_id = $1', [id])).rows[0].n).toBe(1);
  });

  test('si mientras tanto ya no se puede aplicar, el pago queda aprobado y marcado para revisión (no se pierde)', async () => {
    const id = await addPlan('WOM222', { endOffset: 1 });
    const token = await sessionFor('WOM222');
    const p = await portal.post('/mensualidad/pagos', {}, token);
    // En caja la dejan como quincenal antes de que llegue el evento
    await query("UPDATE monthly_plans SET is_biweekly = true WHERE id = $1", [id]);
    const tx = { id: 'txm-3', status: 'APPROVED', amount_in_cents: 13000000, reference: p.body.data.reference };
    expect((await portal.post('/wompi/webhook', signed(tx))).status).toBe(200);
    const s = await request(app).get(`/api/portal/pagos/${p.body.data.reference}`);
    expect(s.body.data).toMatchObject({ status: 'APPROVED', needsReview: true, receipt: null });
    const { rows } = await query("SELECT count(*)::int AS n FROM audit_log WHERE action = 'PORTAL_PLAN_PAYMENT_UNAPPLIED'");
    expect(rows[0].n).toBeGreaterThanOrEqual(1);
  });
});

describe('enlace de pago del correo/SMS (directo a pagar, sin placa ni código)', () => {
  const { runMonthlyReminders } = require('../../src/services/notification.service');
  const get = (p) => request(app).get(`/api/portal${p}`);
  const post = (p, body = {}) => request(app).post(`/api/portal${p}`).send(body);
  const linkOf = (msg) => /\/pagar\/([A-Za-z0-9_-]{22})/.exec(msg ?? '')?.[1];

  test('el aviso trae un enlace que abre solo lo mínimo y permite pagar de una vez', async () => {
    const id = await addPlan('LNK111', { endOffset: 3 });
    sent.length = 0;
    await runMonthlyReminders();
    const mail1 = sent.find((m) => /LNK111/.test(m.subject));
    const token = linkOf(mail1.text);
    expect(token).toBeTruthy();
    expect(mail1.html).toContain(`/pagar/${token}`);
    expect(mail1.text).not.toMatch(/\?tab=|placa=/); // ya no hay que escribir la placa

    const view = await get(`/pagar/${token}`);
    expect(view.status).toBe(200);
    expect(view.body.data).toMatchObject({ plate: 'LNK111', daysLeft: 3 });
    expect(view.body.data.payOnline).toMatchObject({ canPay: true, mode: 'PREPAY', amount: 130000 });
    // lo mínimo: sin titular, correo, teléfonos ni pagos anteriores
    expect(JSON.stringify(view.body)).not.toMatch(/Ana|titular@|3001234567|payments|clientName/);

    const p = await post(`/pagar/${token}/pago`);
    expect(p.status).toBe(201);
    expect(p.body.data).toMatchObject({ mode: 'mock', amount: 130000 });
    const ok = await post(`/pagar/${token}/pago/${p.body.data.reference}/simular`, { resultado: 'APPROVED' });
    expect(ok.body.data).toMatchObject({ status: 'APPROVED', needsReview: false });
    expect((await planRow(id)).ne).toBe(await plusMonth(3));
    // el mismo enlace ya no deja pagar otra vez
    const after = await get(`/pagar/${token}`);
    expect(after.body.data.payOnline.canPay).toBe(false);
  });

  test('enlace inválido, vencido o de otra mensualidad = 404 y no se puede pagar con él', async () => {
    expect((await get('/pagar/abcdefghijklmnopqrstuv')).status).toBe(404);
    expect((await get('/pagar/corto')).status).toBe(404);
    expect((await post('/pagar/abcdefghijklmnopqrstuv/pago')).status).toBe(404);

    await addPlan('LNK222', { endOffset: 1 });
    await addPlan('LNK333', { endOffset: 1 });
    sent.length = 0;
    await runMonthlyReminders();
    const t222 = linkOf(sent.find((m) => /LNK222/.test(m.subject)).text);
    const t333 = linkOf(sent.find((m) => /LNK333/.test(m.subject)).text);
    // un enlace no puede simular el pago de otra mensualidad
    const p = await post(`/pagar/${t222}/pago`);
    expect((await post(`/pagar/${t333}/pago/${p.body.data.reference}/simular`, { resultado: 'APPROVED' })).status).toBe(404);
    // vencido
    await query("UPDATE portal_pay_links SET expires_at = now() - interval '1 minute'");
    expect((await get(`/pagar/${t222}`)).status).toBe(404);
    expect((await post(`/pagar/${t222}/pago`)).status).toBe(404);
  });
});
