// Operación (RF07-RF12, RF19, RF41-RF43): turnos, entradas, salidas, mensualidades, pendientes,
// ventas y recibos, de punta a punta contra PostgreSQL.
const request = require('supertest');
const { query, closePool } = require('../../src/db/pool');
const { app, freshDatabase, siteIdByCode, createUser, loginAs, auditCount, DEFAULT_PASSWORD } = require('./helpers');

let site;
let zones; // { principal, sotano, norte, sur }
let op1;
let op2;
let op3;
let as1;

const api = (session) => ({
  get: (path) => request(app).get(path).set(...session.auth),
  post: (path, body = {}) => request(app).post(path).set(...session.auth).send(body),
  patch: (path, body = {}) => request(app).patch(path).set(...session.auth).send(body),
});

async function addZone(name) {
  const { rows } = await query('INSERT INTO zones (site_id, name) VALUES ($1, $2) RETURNING id', [site, name]);
  return rows[0].id;
}

async function openShift(session, zoneId, denominations = { 50000: 1 }) {
  const res = await api(session).post('/api/shifts', { zoneId, denominations });
  if (res.status !== 201) throw new Error(`no abrió turno: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.data;
}

async function enter(session, plate) {
  return api(session).post('/api/entries', { siteId: site, plate });
}

// Mueve la hora de entrada `minutes` minutos atrás (para simular estadías)
async function backdate(entryId, minutes) {
  await query('UPDATE entries SET entry_at = now() - make_interval(mins => $2) WHERE id = $1', [entryId, minutes]);
}

async function addMonthly({ plate, schedule = 'DAY', startOffset = -10, endOffset = 20, nightStart, nightEnd }) {
  const { rows } = await query(
    `INSERT INTO monthly_plans (site_id, plate, vehicle_type, client_name, start_date, end_date, amount,
                                schedule, night_start, night_end, data_consent, data_consent_at)
     VALUES ($1, $2, 'CAR', 'Cliente Mensual', CURRENT_DATE + $3::int, CURRENT_DATE + $4::int, 130000, $5,
             $6::time, $7::time, true, now())
     RETURNING id`,
    [site, plate, startOffset, endOffset, schedule, nightStart ?? null, nightEnd ?? null],
  );
  return rows[0].id;
}

beforeAll(async () => {
  await freshDatabase();
  site = await siteIdByCode('FACA');
  zones = {
    principal: (await query('SELECT id FROM zones WHERE site_id = $1', [site])).rows[0].id,
    sotano: await addZone('Sótano'),
    norte: await addZone('Norte'),
    sur: await addZone('Sur'),
  };
  for (const u of ['op1', 'op2', 'op3', 'op4', 'op5']) await createUser({ username: u, role: 'OP', siteIds: [site] });
  await createUser({ username: 'as1', role: 'AS', siteIds: [site] });
  op1 = await loginAs('op1');
  op2 = await loginAs('op2');
  op3 = await loginAs('op3');
  as1 = await loginAs('as1');
});

afterAll(closePool);

// ---------------------------------------------------------------------------
describe('turnos: apertura', () => {
  test('sin turno abierto no se puede registrar una entrada (409 NO_OPEN_SHIFT)', async () => {
    const res = await enter(op1, 'AAA111');
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('NO_OPEN_SHIFT');
  });

  test('abre turno con la base contada por denominación', async () => {
    const shift = await openShift(op1, zones.principal, { 20000: 2, 5000: 1, 1000: 5 });
    expect(shift).toMatchObject({ zone: { name: 'Principal' }, initialCash: 50000 });
    expect(shift.summary).toMatchObject({ initialCash: 50000, expectedCash: 0, expectedInDrawer: 50000 });
    const { rows } = await query("SELECT total, denominations FROM cash_counts WHERE kind = 'OPENING'");
    expect(rows[0]).toEqual({ total: 50000, denominations: { 20000: 2, 5000: 1, 1000: 5 } });
    expect(await auditCount('SHIFT_OPENED', { userId: op1.user.id })).toBe(1);
  });

  test('GET /api/shifts/current devuelve sede, zona y caja', async () => {
    const res = await api(op1).get('/api/shifts/current');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ site: { code: 'FACA' }, zone: { name: 'Principal' } });
  });

  test('un usuario no abre dos turnos; una zona no tiene dos turnos', async () => {
    const again = await api(op1).post('/api/shifts', { zoneId: zones.sotano, denominations: {} });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('SHIFT_ALREADY_OPEN');
    const sameZone = await api(op2).post('/api/shifts', { zoneId: zones.principal, denominations: {} });
    expect(sameZone.status).toBe(409);
    expect(sameZone.body.code).toBe('ZONE_HAS_OPEN_SHIFT');
  });

  test('arqueo inválido → 400', async () => {
    const res = await api(op2).post('/api/shifts', { zoneId: zones.sotano, denominations: { 3000: 1 } });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
describe('entradas (RF07)', () => {
  test('normaliza la placa, deduce el tipo y asigna el consecutivo FA', async () => {
    const res = await enter(op1, 'abc-123');
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      type: 'ENTRY',
      plate: 'ABC123',
      vehicleType: 'CAR',
      receipt: 'FA1',
      business: { name: 'Facaparking' },
      zone: 'Principal',
    });
    expect(res.body.data.qrUrl).toBe('https://portal.ejemplo.com/recibo?sede=FACA&recibo=FA1');
  });

  test('moto ABC12D → MOTORCYCLE', async () => {
    const res = await enter(op1, 'jhb-02c');
    expect(res.status).toBe(201);
    expect(res.body.data.vehicleType).toBe('MOTORCYCLE');
  });

  test.each(['AB123', 'ABCD12', '', 'ABC-1234'])('placa inválida %p → 400', async (plate) => {
    const res = await enter(op1, plate);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_PLATE');
  });

  test('entrada duplicada → 409 con el recibo de la que está adentro', async () => {
    const res = await enter(op1, 'ABC123');
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ENTRY_ALREADY_OPEN');
    expect(res.body.error).toMatch(/ya está adentro.*FA1/);
  });

  test('dos registros simultáneos de la misma placa: solo uno entra', async () => {
    const results = await Promise.all([enter(op1, 'DUP999'), enter(op1, 'DUP999')]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    const { rows } = await query("SELECT count(*) AS n FROM entries WHERE plate = 'DUP999'");
    expect(rows[0].n).toBe(1);
  });

  test('consecutivo sin repetidos aunque entren 10 vehículos a la vez', async () => {
    const plates = Array.from({ length: 10 }, (_, i) => `CON${String(i).padStart(3, '0')}`);
    const results = await Promise.all(plates.map((p) => enter(op1, p)));
    expect(results.every((r) => r.status === 201)).toBe(true);
    const numbers = results.map((r) => Number(r.body.data.receipt.slice(2))).sort((a, b) => a - b);
    expect(new Set(numbers).size).toBe(10);
    expect(numbers[9] - numbers[0]).toBe(9); // consecutivos, sin huecos
  });

  test('ciclas: placa genérica y servicio cicla; una CICLA adentro a la vez por sede', async () => {
    expect((await enter(op1, 'CICLA')).body.data.vehicleType).toBe('BICYCLE');
    expect((await enter(op1, 'CICLA')).status).toBe(409);
    expect((await enter(op1, 'CICLA0')).status).toBe(201);
    const wrong = await api(op1).post('/api/entries', { siteId: site, plate: 'ABC999', vehicleType: 'BICYCLE' });
    expect(wrong.status).toBe(400);
  });

  test('lookup: tipo de vehículo y si ya está adentro', async () => {
    const res = await api(op1).get(`/api/entries/lookup?siteId=${site}&plate=abc-123`);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ plate: 'ABC123', valid: true, vehicleType: 'CAR', openEntry: { receipt: 'FA1' } });
    const bad = await api(op1).get(`/api/entries/lookup?siteId=${site}&plate=xx`);
    expect(bad.body.data).toMatchObject({ valid: false });
  });

  test('lista de vehículos adentro de la sede', async () => {
    const res = await api(op1).get(`/api/entries/open?siteId=${site}`);
    expect(res.status).toBe(200);
    expect(res.body.data.map((e) => e.plate)).toEqual(expect.arrayContaining(['ABC123', 'JHB02C', 'CICLA']));
  });
});

// ---------------------------------------------------------------------------
describe('mensualidades (RF08)', () => {
  test('mensualidad de día vigente bloquea la entrada normal', async () => {
    await addMonthly({ plate: 'MEN001' });
    const res = await enter(op1, 'MEN001');
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('MONTHLY_ACTIVE');
  });

  test('vencida hace 3 días todavía bloquea (gracia); hace 4 días ya no', async () => {
    await addMonthly({ plate: 'GRA003', startOffset: -40, endOffset: -3 });
    await addMonthly({ plate: 'GRA004', startOffset: -40, endOffset: -4 });
    expect((await enter(op1, 'GRA003')).status).toBe(409);
    expect((await enter(op1, 'GRA004')).status).toBe(201);
  });

  test('una mensualidad que aún no empieza no bloquea', async () => {
    await addMonthly({ plate: 'FUT001', startOffset: 2, endOffset: 32 });
    expect((await enter(op1, 'FUT001')).status).toBe(201);
  });

  test('nocturna dentro de su franja bloquea', async () => {
    const { rows } = await query(
      "SELECT (LOCALTIME - interval '1 hour')::time AS s, (LOCALTIME + interval '1 hour')::time AS e",
    );
    await addMonthly({ plate: 'NOC001', schedule: 'NIGHT', nightStart: rows[0].s, nightEnd: rows[0].e });
    const res = await enter(op1, 'NOC001');
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/nocturna/);
  });

  test('nocturna fuera de franja: entra, y al salir el cobro queda en Pendientes', async () => {
    const { rows } = await query(
      "SELECT (LOCALTIME + interval '1 hour')::time AS s, (LOCALTIME + interval '2 hours')::time AS e",
    );
    const planId = await addMonthly({ plate: 'NOC002', schedule: 'NIGHT', nightStart: rows[0].s, nightEnd: rows[0].e });

    const lookup = await api(op1).get(`/api/entries/lookup?siteId=${site}&plate=NOC002`);
    expect(lookup.body.data.monthly).toMatchObject({ id: planId, blocksEntry: false });

    const entry = await enter(op1, 'NOC002');
    expect(entry.status).toBe(201);
    const entryId = entry.body.data.entryId;
    await backdate(entryId, 61);

    const quote = await api(op1).get(`/api/entries/${entryId}/quote`);
    expect(quote.body.data).toMatchObject({ total: 5100, goesToPending: true });

    // Aunque el operador elija "Efectivo", una nocturna fuera de franja va a Pendientes
    const exit = await api(op1).post(`/api/entries/${entryId}/exit`, { paymentMethod: 'CASH' });
    expect(exit.status).toBe(200);
    expect(exit.body.data).toMatchObject({ status: 'PENDING_CHARGE', paymentLabel: 'Pendiente', chargedAmount: 5100 });

    const { rows: pc } = await query('SELECT reason, amount, monthly_plan_id FROM pending_charges WHERE entry_id = $1', [entryId]);
    expect(pc[0]).toEqual({ reason: 'OUT_OF_SCHEDULE', amount: 5100, monthly_plan_id: planId });
  });
});

// ---------------------------------------------------------------------------
describe('salidas (RF09, RF10)', () => {
  let entryId;

  beforeAll(async () => {
    entryId = (await enter(op1, 'SAL001')).body.data.entryId;
    await backdate(entryId, 61); // 1 h 1 min → $ 5.100
  });

  test('salida sin turno abierto → 409 NO_OPEN_SHIFT', async () => {
    const res = await api(op2).post(`/api/entries/${entryId}/exit`, { paymentMethod: 'CASH' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('NO_OPEN_SHIFT');
  });

  test('descuento sin motivo → 400; cobrar más de lo calculado → 400; "Ambos" mal repartido → 400', async () => {
    const noReason = await api(op1).post(`/api/entries/${entryId}/exit`, { paymentMethod: 'CASH', chargedAmount: 4000 });
    expect(noReason.status).toBe(400);
    expect(noReason.body.code).toBe('DISCOUNT_REASON_REQUIRED');
    const more = await api(op1).post(`/api/entries/${entryId}/exit`, { paymentMethod: 'CASH', chargedAmount: 9000 });
    expect(more.status).toBe(400);
    const mixed = await api(op1).post(`/api/entries/${entryId}/exit`, { paymentMethod: 'MIXED', cashAmount: 5100 });
    expect(mixed.status).toBe(400);
  });

  test('salida con descuento y "Ambos": guarda motivo y reparto; el recibo trae todo', async () => {
    const res = await api(op1).post(`/api/entries/${entryId}/exit`, {
      paymentMethod: 'MIXED',
      cashAmount: 2000,
      chargedAmount: 4000,
      discountReason: 'Cliente frecuente',
    });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      type: 'EXIT',
      status: 'PAID',
      calculatedAmount: 5100,
      discountAmount: 1100,
      discountReason: 'Cliente frecuente',
      chargedAmount: 4000,
      cashAmount: 2000,
      electronicAmount: 2000,
      paymentLabel: 'Efectivo + Electrónico',
      minutes: 61,
    });
  });

  test('una salida ya registrada no se puede repetir', async () => {
    const res = await api(op1).post(`/api/entries/${entryId}/exit`, { paymentMethod: 'CASH' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ENTRY_NOT_OPEN');
  });

  test('dos operadores no pueden cerrar la misma entrada a la vez', async () => {
    await openShift(op2, zones.sotano);
    const id = (await enter(op1, 'CON999')).body.data.entryId;
    await backdate(id, 30);
    const results = await Promise.all([
      api(op1).post(`/api/entries/${id}/exit`, { paymentMethod: 'CASH' }),
      api(op2).post(`/api/entries/${id}/exit`, { paymentMethod: 'ELECTRONIC' }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const loser = results.find((r) => r.status === 409);
    expect(loser.body.code).toBe('ENTRY_NOT_OPEN');
    const { rows } = await query('SELECT status, cash_register_id FROM entries WHERE id = $1', [id]);
    expect(rows[0].status).toBe('PAID');
    expect(rows[0].cash_register_id).not.toBeNull();
  });

  test('"Pendiente" a mano: sale sin cobrar y queda en Pendientes', async () => {
    const id = (await enter(op1, 'PEN001')).body.data.entryId;
    await backdate(id, 50);
    const res = await api(op1).post(`/api/entries/${id}/exit`, { paymentMethod: 'PENDING' });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('PENDING_CHARGE');
    const { rows } = await query('SELECT reason, amount FROM pending_charges WHERE entry_id = $1', [id]);
    expect(rows[0]).toEqual({ reason: 'MANUAL', amount: 3300 });
  });
});

// ---------------------------------------------------------------------------
describe('pendientes (RF12)', () => {
  test('solo administradores (el OP recibe 403)', async () => {
    expect((await api(op1).get(`/api/pending-charges?siteId=${site}`)).status).toBe(403);
  });

  test('lista agrupada por mensualidad o placa', async () => {
    const res = await api(as1).get(`/api/pending-charges?siteId=${site}`);
    expect(res.status).toBe(200);
    const plates = res.body.data.map((g) => g.plate);
    expect(plates).toEqual(expect.arrayContaining(['NOC002', 'PEN001']));
    const noc = res.body.data.find((g) => g.plate === 'NOC002');
    expect(noc).toMatchObject({ clientName: 'Cliente Mensual', total: 5100 });
  });

  test('confirmar exige caja abierta: el AS sin turno recibe 409; indicando el turno de un operador, entra a esa caja', async () => {
    const list = (await api(as1).get(`/api/pending-charges?siteId=${site}`)).body.data;
    const noc = list.find((g) => g.plate === 'NOC002');
    const chargeIds = noc.charges.map((c) => c.id);

    const noShift = await api(as1).post('/api/pending-charges/confirm', { chargeIds, paymentMethod: 'CASH' });
    expect(noShift.status).toBe(409);
    expect(noShift.body.code).toBe('NO_OPEN_SHIFT');

    const shift = (await api(op1).get('/api/shifts/current')).body.data;
    const res = await api(as1).post('/api/pending-charges/confirm', {
      chargeIds,
      paymentMethod: 'ELECTRONIC',
      shiftId: shift.id,
    });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ confirmed: 1, charged: 5100, cashRegisterId: shift.cashRegisterId });

    const { rows } = await query(
      "SELECT e.status, e.payment_method, e.cash_register_id, e.paid_at IS NOT NULL AS paid FROM entries e WHERE plate = 'NOC002'",
    );
    expect(rows[0]).toMatchObject({ status: 'PAID', payment_method: 'ELECTRONIC', cash_register_id: shift.cashRegisterId, paid: true });

    const again = await api(as1).post('/api/pending-charges/confirm', { chargeIds, paymentMethod: 'CASH', shiftId: shift.id });
    expect(again.status).toBe(409);
    expect(await auditCount('PENDING_CONFIRMED', { userId: as1.user.id })).toBe(1);
  });
});

// ---------------------------------------------------------------------------
describe('ventas (RF19) y recibos (RF11)', () => {
  test('listado del día con totales, búsqueda por placa y por recibo', async () => {
    const today = (await query('SELECT CURRENT_DATE::text AS d')).rows[0].d;
    const res = await api(op1).get(`/api/sales?siteId=${site}&from=${today}&to=${today}`);
    expect(res.status).toBe(200);
    expect(res.body.data.count).toBeGreaterThanOrEqual(3);
    expect(res.body.data.items.length).toBeLessThanOrEqual(10);

    const byPlate = await api(op1).get(`/api/sales?siteId=${site}&q=sal-001`);
    expect(byPlate.body.data.items.map((s) => s.plate)).toEqual(['SAL001']);
    const receipt = byPlate.body.data.items[0].receipt;
    const byReceipt = await api(op1).get(`/api/sales?siteId=${site}&q=${receipt.slice(2)}`);
    expect(byReceipt.body.data.items[0].receipt).toBe(receipt);
  });

  test('cambio de forma de pago exige motivo y queda auditado', async () => {
    const sale = (await api(op1).get(`/api/sales?siteId=${site}&q=SAL001`)).body.data.items[0];
    const noReason = await api(op1).patch(`/api/sales/${sale.id}/payment`, { paymentMethod: 'CASH' });
    expect(noReason.status).toBe(400);
    expect(noReason.body.code).toBe('REASON_REQUIRED');

    const res = await api(op1).patch(`/api/sales/${sale.id}/payment`, { paymentMethod: 'CASH', reason: 'Pagó todo en efectivo' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ paymentMethod: 'CASH', cashAmount: 4000, electronicAmount: 0 });
    const { rows } = await query(
      "SELECT details FROM audit_log WHERE action = 'SALE_PAYMENT_CHANGED' AND entity_id = $1",
      [String(sale.id)],
    );
    expect(rows[0].details).toMatchObject({ reason: 'Pagó todo en efectivo', before: { paymentMethod: 'MIXED' }, after: { paymentMethod: 'CASH' } });
  });

  test('un OP no cambia ventas de la caja de otro (403); el AS sí', async () => {
    const sale = (await api(op1).get(`/api/sales?siteId=${site}&q=SAL001`)).body.data.items[0];
    const other = await api(op2).patch(`/api/sales/${sale.id}/payment`, { paymentMethod: 'ELECTRONIC', reason: 'Prueba de permisos' });
    expect(other.status).toBe(403);
    const admin = await api(as1).patch(`/api/sales/${sale.id}/payment`, { paymentMethod: 'ELECTRONIC', reason: 'Corrección del administrador' });
    expect(admin.status).toBe(200);
  });

  test('pasar una venta a "Pendiente" la saca de Ventas y la deja en Pendientes', async () => {
    const id = (await enter(op1, 'VEN001')).body.data.entryId;
    await api(op1).post(`/api/entries/${id}/exit`, { paymentMethod: 'CASH' });
    const res = await api(op1).patch(`/api/sales/${id}/payment`, { paymentMethod: 'PENDING', reason: 'No alcanzó a pagar' });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('PENDING_CHARGE');
    const list = (await api(as1).get(`/api/pending-charges?siteId=${site}`)).body.data;
    expect(list.map((g) => g.plate)).toContain('VEN001');
  });

  test('reimpresión desde Ventas devuelve el recibo y queda en auditoría', async () => {
    const sale = (await api(op1).get(`/api/sales?siteId=${site}&q=SAL001`)).body.data.items[0];
    const res = await api(op1).post(`/api/sales/${sale.id}/reprint`);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ type: 'EXIT', receipt: sale.receipt, plate: 'SAL001' });
    expect(await auditCount('RECEIPT_REPRINTED', { entityId: sale.id })).toBe(1);
  });
});

// ---------------------------------------------------------------------------
describe('entrega y cierre de turno (RF42, RF43)', () => {
  let shift;

  beforeAll(async () => {
    shift = await openShift(op3, zones.norte, { 50000: 1 });
    const id = (await enter(op3, 'TUR001')).body.data.entryId;
    await backdate(id, 61);
    await api(op3).post(`/api/entries/${id}/exit`, { paymentMethod: 'CASH' }); // + $ 5.100 en efectivo
  });

  test('contraseña incorrecta de quien recibe → 400 y el turno sigue abierto', async () => {
    const res = await api(op3).post(`/api/shifts/${shift.id}/handover`, {
      denominations: { 50000: 1, 5000: 1, 100: 1 },
      outgoingPassword: DEFAULT_PASSWORD,
      incomingUsername: 'op4',
      incomingPassword: 'mala1234',
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('CONFIRMATION_FAILED');
    const { rows } = await query('SELECT closed_at FROM shifts WHERE id = $1', [shift.id]);
    expect(rows[0].closed_at).toBeNull();
  });

  test('contraseña incorrecta de quien entrega → 400', async () => {
    const res = await api(op3).post(`/api/shifts/${shift.id}/handover`, {
      denominations: { 50000: 1 },
      outgoingPassword: 'mala1234',
      incomingUsername: 'op4',
      incomingPassword: DEFAULT_PASSWORD,
    });
    expect(res.status).toBe(400);
  });

  test('cambio de turno con diferencia de caja: se registra el faltante y el nuevo turno recibe lo contado', async () => {
    // Debía haber 50.000 de base + 5.100 de la venta = 55.100; se cuentan 50.000 → faltan 5.100
    const res = await api(op3).post(`/api/shifts/${shift.id}/handover`, {
      denominations: { 50000: 1 },
      outgoingPassword: DEFAULT_PASSWORD,
      incomingUsername: 'op4',
      incomingPassword: DEFAULT_PASSWORD,
      notes: 'Faltante por revisar',
    });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      counted: 50000,
      expectedInDrawer: 55100,
      difference: -5100,
      receivedBy: { username: 'op4' },
    });

    const { rows: old } = await query(
      `SELECT sh.closed_at IS NOT NULL AS closed, sh.close_type, cr.physical_cash, cr.expected_cash, cr.difference
         FROM shifts sh JOIN cash_registers cr ON cr.shift_id = sh.id WHERE sh.id = $1`,
      [shift.id],
    );
    expect(old[0]).toEqual({ closed: true, close_type: 'HANDOVER', physical_cash: 50000, expected_cash: 5100, difference: -5100 });

    const { rows: count } = await query("SELECT counted_by, received_by, expected_total, difference FROM cash_counts WHERE kind = 'HANDOVER'");
    expect(count[0]).toMatchObject({ counted_by: op3.user.id, expected_total: 55100, difference: -5100 });

    const op4 = await loginAs('op4');
    const current = (await api(op4).get('/api/shifts/current')).body.data;
    expect(current).toMatchObject({ zone: { name: 'Norte' }, initialCash: 50000, previousShiftId: shift.id });

    // Quien entregó ya no tiene turno: no puede registrar entradas
    expect((await enter(op3, 'TUR002')).status).toBe(409);
    expect(await auditCount('SHIFT_HANDOVER', { userId: op3.user.id })).toBe(1);
  });

  test('cierre sin relevo con el arqueo exacto: diferencia 0 y la zona queda libre', async () => {
    const s = await openShift(op3, zones.sur, { 10000: 2 });
    const res = await api(op3).post(`/api/shifts/${s.id}/close`, { denominations: { 10000: 2 } });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ counted: 20000, expectedInDrawer: 20000, difference: 0 });
    expect((await api(op3).get('/api/shifts/current')).body.data).toBeNull();
    // La zona Sur admite un turno nuevo
    await openShift(op3, zones.sur, {});
  });

  test('otro operador no puede cerrar un turno ajeno (403)', async () => {
    const current = (await api(op1).get('/api/shifts/current')).body.data;
    const res = await api(op2).post(`/api/shifts/${current.id}/close`, { denominations: {} });
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
describe('retiro al entregar o cerrar el turno', () => {
  let zoneA;
  let zoneB;

  beforeAll(async () => {
    zoneA = await addZone('Retiro A');
    zoneB = await addZone('Retiro B');
    await createUser({ username: 'op6', role: 'OP', siteIds: [site] });
    await createUser({ username: 'op7', role: 'OP', siteIds: [site] });
  });

  test('entrega con retiro: queda como "Base −" con quien lo recibe y el resto es la base del turno nuevo', async () => {
    const op6 = await loginAs('op6');
    const shift = await openShift(op6, zoneA, { 50000: 1 });
    const id = (await enter(op6, 'RET001')).body.data.entryId;
    await backdate(id, 61);
    await api(op6).post(`/api/entries/${id}/exit`, { paymentMethod: 'CASH' }); // cajón: 55.100

    // Se retiran 40.000 para el administrador; quedan 15.100 (exacto)
    const res = await api(op6).post(`/api/shifts/${shift.id}/handover`, {
      denominations: { 10000: 1, 5000: 1, 100: 1 },
      withdrawal: { amount: 40000, receivedBy: 'Admin Felipe' },
      outgoingPassword: DEFAULT_PASSWORD,
      incomingUsername: 'op7',
      incomingPassword: DEFAULT_PASSWORD,
    });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      counted: 15100,
      expectedInDrawer: 15100,
      difference: 0,
      newShiftBase: 15100,
      withdrawal: { amount: 40000, receivedBy: 'Admin Felipe' },
    });

    const { rows } = await query(
      `SELECT m.type, m.amount, m.withdrawal_to FROM cash_movements m
         JOIN cash_registers cr ON cr.id = m.cash_register_id WHERE cr.shift_id = $1`,
      [shift.id],
    );
    expect(rows).toEqual([{ type: 'BASE_OUT', amount: 40000, withdrawal_to: 'Admin Felipe' }]);

    const op7 = await loginAs('op7');
    const current = (await api(op7).get('/api/shifts/current')).body.data;
    expect(current).toMatchObject({ initialCash: 15100, zone: { name: 'Retiro A' } });
  });

  test('cierre sin relevo con retiro y faltante: la diferencia no cuenta el retiro', async () => {
    const op6 = await loginAs('op6');
    const shift = await openShift(op6, zoneB, { 20000: 1 });
    // Cajón: 20.000. Retira 15.000 y cuenta 4.000 → faltan 1.000
    const res = await api(op6).post(`/api/shifts/${shift.id}/close`, {
      denominations: { 2000: 2 },
      withdrawal: { amount: 15000, receivedBy: 'Administradora Sede' },
    });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ counted: 4000, expectedInDrawer: 5000, difference: -1000 });
    expect(res.body.data.summary).toMatchObject({ initialCash: 20000, baseOut: 15000, baseFinal: 5000 });
  });

  test('retiro sin quién lo recibe → 400 y el turno sigue abierto', async () => {
    const op6 = await loginAs('op6');
    const shift = await openShift(op6, zoneB, { 20000: 1 });
    const res = await api(op6).post(`/api/shifts/${shift.id}/close`, {
      denominations: { 5000: 1 },
      withdrawal: { amount: 15000, receivedBy: '' },
    });
    expect(res.status).toBe(400);
    expect((await api(op6).get('/api/shifts/current')).body.data.id).toBe(shift.id);
  });

  test('los dos retiros quedan registrados con quién los recibió', async () => {
    const { rows } = await query("SELECT count(*) AS n FROM cash_movements WHERE withdrawal_to IS NOT NULL");
    expect(rows[0].n).toBe(2);
  });
});
