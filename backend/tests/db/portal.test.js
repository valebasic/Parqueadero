// Portal del cliente (V4): consulta por QR, pago (modo simulado y webhook firmado de Wompi) y
// aplicación del pago al dar salida, de punta a punta contra PostgreSQL.
const request = require('supertest');
const { query, closePool } = require('../../src/db/pool');
const { app, freshDatabase, siteIdByCode, createUser, loginAs } = require('./helpers');
const { sha256 } = require('../../src/services/wompi.service');

let site;
let op;

const portal = {
  get: (p) => request(app).get(`/api/portal${p}`),
  post: (p, body = {}) => request(app).post(`/api/portal${p}`).send(body),
};
const staff = {
  post: (p, body = {}) => request(app).post(p).set(...op.auth).send(body),
  get: (p) => request(app).get(p).set(...op.auth),
};

async function enterVehicle(plate, minutesAgo = 20) {
  const res = await staff.post('/api/entries', { siteId: site, plate });
  expect(res.status).toBe(201);
  const entryId = res.body.data.entryId;
  await query('UPDATE entries SET entry_at = now() - make_interval(mins => $2) WHERE id = $1', [entryId, minutesAgo]);
  return { entryId, receipt: res.body.data.receipt };
}

async function pay(receipt) {
  const res = await portal.post('/pagos', { sede: 'FACA', recibo: receipt });
  expect(res.status).toBe(201);
  return res.body.data;
}

beforeAll(async () => {
  delete process.env.WOMPI_PUBLIC_KEY; // modo simulado
  await freshDatabase();
  site = await siteIdByCode('FACA');
  await createUser({ username: 'opp', role: 'OP', siteIds: [site] });
  op = await loginAs('opp');
  const zone = (await query('SELECT id FROM zones WHERE site_id = $1', [site])).rows[0].id;
  const shift = await staff.post('/api/shifts', { zoneId: zone, denominations: { 50000: 1 } });
  expect(shift.status).toBe(201);
});

afterAll(closePool);

describe('consulta por QR (pantalla 1)', () => {
  test('muestra la estancia sin datos internos ni de empleados', async () => {
    const { receipt } = await enterVehicle('QRA111');
    const res = await portal.get(`/recibo?sede=FACA&recibo=${receipt}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ plate: 'QRA111', state: 'INSIDE', canPay: true });
    expect(res.body.data.amount).toBeGreaterThan(0);
    const text = JSON.stringify(res.body);
    expect(text).not.toMatch(/Felipe|opp|operator|entryId|"id"/);
  });

  test('recibo inexistente o mal escrito = 404 igual (no revela nada)', async () => {
    expect((await portal.get('/recibo?sede=FACA&recibo=FA99999')).status).toBe(404);
    expect((await portal.get("/recibo?sede=FACA&recibo=FA1';--")).status).toBe(404);
    expect((await portal.get('/recibo?sede=NOEXISTE&recibo=FA1')).status).toBe(404);
  });
});

describe('pago simulado y salida con pago del portal', () => {
  test('pagar → ventana de salida gratis → el operador finaliza sin cobrar de más', async () => {
    const { entryId, receipt } = await enterVehicle('PAY111');
    const p = await pay(receipt);
    expect(p).toMatchObject({ mode: 'mock', checkoutUrl: null });

    // Aún no pagado: no cuenta como crédito
    expect((await staff.get(`/api/entries/${entryId}/quote`)).body.data.portalPayment).toBeNull();

    const ok = await portal.post(`/pagos/${p.reference}/simular`, { resultado: 'APPROVED' });
    expect(ok.body.data).toMatchObject({ status: 'APPROVED', amount: p.amount });

    const stay = (await portal.get(`/recibo?sede=FACA&recibo=${receipt}`)).body.data;
    expect(stay).toMatchObject({ canPay: false });
    expect(stay.payment).toMatchObject({ status: 'APPROVED', withinWindow: true });

    // No se puede pagar dos veces
    const again = await portal.post('/pagos', { sede: 'FACA', recibo: receipt });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('ALREADY_PAID');

    const quote = (await staff.get(`/api/entries/${entryId}/quote`)).body.data;
    expect(quote.portalPayment).toMatchObject({ amount: p.amount, withinWindow: true, due: 0 });

    // Mientras tenga pago del portal no se puede dejar como pendiente
    const pend = await staff.post(`/api/entries/${entryId}/exit`, { paymentMethod: 'PENDING' });
    expect(pend.status).toBe(409);

    const exit = await staff.post(`/api/entries/${entryId}/exit`, { paymentMethod: 'CASH' });
    expect(exit.status).toBe(200);
    expect(exit.body.data).toMatchObject({ status: 'PAID', chargedAmount: p.amount, paymentMethod: 'ELECTRONIC', cashAmount: 0, electronicAmount: p.amount });

    const { rows } = await query('SELECT consumed_at FROM portal_payments WHERE reference = $1', [p.reference]);
    expect(rows[0].consumed_at).not.toBeNull();
  });

  test('pasada la ventana solo se cobra la diferencia en caja', async () => {
    const { entryId, receipt } = await enterVehicle('LAT111', 10);
    const p = await pay(receipt);
    await portal.post(`/pagos/${p.reference}/simular`, { resultado: 'APPROVED' });
    // Simula que pasaron 3 horas desde el pago (fuera de la ventana de 10 min)
    await query("UPDATE portal_payments SET paid_at = now() - interval '3 hours' WHERE reference = $1", [p.reference]);
    await query("UPDATE entries SET entry_at = now() - interval '3 hours 10 minutes' WHERE id = $1", [entryId]);

    const quote = (await staff.get(`/api/entries/${entryId}/quote`)).body.data;
    expect(quote.portalPayment.withinWindow).toBe(false);
    expect(quote.portalPayment.due).toBe(quote.total - p.amount);
    expect(quote.portalPayment.due).toBeGreaterThan(0);

    const exit = await staff.post(`/api/entries/${entryId}/exit`, { paymentMethod: 'CASH' });
    expect(exit.status).toBe(200);
    expect(exit.body.data).toMatchObject({
      chargedAmount: quote.total,
      cashAmount: quote.portalPayment.due,
      electronicAmount: p.amount,
      paymentMethod: 'MIXED',
    });
  });

  test('un pago rechazado no cuenta y se puede reintentar', async () => {
    const { receipt } = await enterVehicle('DEC111');
    const p = await pay(receipt);
    const res = await portal.post(`/pagos/${p.reference}/simular`, { resultado: 'DECLINED' });
    expect(res.body.data.status).toBe('DECLINED');
    expect((await portal.get(`/recibo?sede=FACA&recibo=${receipt}`)).body.data).toMatchObject({ canPay: true, payment: null });
    await pay(receipt); // reintento permitido
  });

  test('un vehículo que ya salió no puede pagar en línea', async () => {
    const { entryId, receipt } = await enterVehicle('OUT111');
    await staff.post(`/api/entries/${entryId}/exit`, { paymentMethod: 'CASH' });
    const res = await portal.post('/pagos', { sede: 'FACA', recibo: receipt });
    expect(res.status).toBe(409);
  });
});

describe('webhook de Wompi', () => {
  const EVENTS_SECRET = 'test_events_secreto';

  function signedEvent(tx, secret = EVENTS_SECRET) {
    const timestamp = 1700000000;
    const checksum = sha256(`${tx.id}${tx.status}${tx.amount_in_cents}${timestamp}${secret}`);
    return {
      event: 'transaction.updated',
      data: { transaction: tx },
      timestamp,
      signature: { properties: ['transaction.id', 'transaction.status', 'transaction.amount_in_cents'], checksum },
    };
  }

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

  test('crea el checkout con firma de integridad correcta', async () => {
    const { receipt } = await enterVehicle('WOM111');
    const p = await pay(receipt);
    expect(p.mode).toBe('wompi');
    const url = new URL(p.checkoutUrl);
    expect(url.origin + url.pathname).toBe('https://checkout.wompi.co/p/');
    expect(url.searchParams.get('amount-in-cents')).toBe(String(p.amount * 100));
    expect(url.searchParams.get('signature:integrity')).toBe(sha256(`${p.reference}${p.amount * 100}COPtest_integrity_x`));
    // En modo real el endpoint de simulación no existe
    expect((await portal.post(`/pagos/${p.reference}/simular`, { resultado: 'APPROVED' })).status).toBe(404);
  });

  test('firma inválida = 401; firma válida aprueba una sola vez (idempotente); monto distinto se rechaza', async () => {
    const { receipt } = await enterVehicle('WOM222');
    const p = await pay(receipt);
    const tx = { id: 'tx-1', status: 'APPROVED', amount_in_cents: p.amount * 100, reference: p.reference };

    const bad = await portal.post('/wompi/webhook', signedEvent(tx, 'otro_secreto'));
    expect(bad.status).toBe(401);
    expect((await portal.get(`/pagos/${p.reference}`)).body.data.status).toBe('PENDING');

    const wrongAmount = await portal.post('/wompi/webhook', signedEvent({ ...tx, id: 'tx-2', amount_in_cents: 100 }));
    expect(wrongAmount.status).toBe(409);
    expect((await portal.get(`/pagos/${p.reference}`)).body.data.status).toBe('PENDING');

    expect((await portal.post('/wompi/webhook', signedEvent(tx))).status).toBe(200);
    expect((await portal.post('/wompi/webhook', signedEvent(tx))).status).toBe(200); // repetido
    expect((await portal.get(`/pagos/${p.reference}`)).body.data.status).toBe('APPROVED');
    const { rows } = await query("SELECT count(*)::int AS n FROM audit_log WHERE action = 'PORTAL_PAYMENT_APPROVED'");
    expect(rows[0].n).toBeGreaterThanOrEqual(1);
  });
});
