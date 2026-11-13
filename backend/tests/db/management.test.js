// Fase 5: mensualidades, transacciones, configuración (tarifas), inicio y reportes.
const request = require('supertest');
const { query, closePool } = require('../../src/db/pool');
const { app, freshDatabase, siteIdByCode, createUser, loginAs, auditCount } = require('./helpers');

let site;
let zone;
let as1;
let op1;
let today;

const api = (session) => ({
  get: (path) => request(app).get(path).set(...session.auth),
  post: (path, body = {}) => request(app).post(path).set(...session.auth).send(body),
  patch: (path, body = {}) => request(app).patch(path).set(...session.auth).send(body),
  del: (path) => request(app).delete(path).set(...session.auth),
});

const plan = (overrides = {}) => ({
  siteId: site,
  plate: 'MEN100',
  clientName: 'Ana Pérez',
  phones: ['3001234567'],
  email: 'ana@correo.com',
  schedule: 'DAY',
  dataConsent: true,
  ...overrides,
});

async function sqlDate(offset) {
  const { rows } = await query('SELECT (CURRENT_DATE + $1::int)::text AS d', [offset]);
  return rows[0].d;
}

// Mensualidad ya pagada (como si viniera de meses atrás), insertada directo en la base
async function paidPlan(plate, startOffset, endOffset) {
  const { rows } = await query(
    `INSERT INTO monthly_plans (site_id, plate, vehicle_type, client_name, phones, start_date, end_date, amount,
                                payment_status, data_consent, data_consent_at)
     VALUES ($1, $2, 'CAR', 'Cliente Antiguo', '{3001112233}', CURRENT_DATE + $3::int, CURRENT_DATE + $4::int, 130000,
             'PAID', true, now())
     RETURNING id`,
    [site, plate, startOffset, endOffset],
  );
  return rows[0].id;
}

beforeAll(async () => {
  await freshDatabase();
  site = await siteIdByCode('FACA');
  zone = (await query('SELECT id FROM zones WHERE site_id = $1', [site])).rows[0].id;
  await createUser({ username: 'as1', role: 'AS', siteIds: [site] });
  await createUser({ username: 'op1', role: 'OP', siteIds: [site] });
  as1 = await loginAs('as1');
  op1 = await loginAs('op1');
  today = await sqlDate(0);
});

afterAll(closePool);

// ===========================================================================
describe('mensualidades: registro (RF13)', () => {
  test('registra con titular, teléfono, correo, modalidad y autorización; no cobra (pendiente de pago)', async () => {
    const res = await api(as1).post('/api/monthly', plan({ spaceLabel: 'A-12' }));
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      plate: 'MEN100',
      vehicleType: 'CAR',
      amount: 130000, // tarifa de mensualidad del carro
      startDate: today,
      spaceLabel: 'A-12',
      paymentStatus: 'PENDING',
      status: { code: 'PENDING_PAYMENT' },
      dataConsent: true,
    });
    expect(await auditCount('MONTHLY_CREATED')).toBe(1);
  });

  test('sin autorización de datos → 400', async () => {
    const res = await api(as1).post('/api/monthly', plan({ plate: 'MEN101', dataConsent: false }));
    expect(res.status).toBe(400);
    expect(res.body.details).toHaveProperty('dataConsent');
  });

  test.each([
    ['teléfono inválido', { phones: ['123'] }],
    ['correo inválido', { email: 'no-es-correo' }],
    ['noche sin horas', { schedule: 'NIGHT' }],
    ['nombre con números', { clientName: 'Ana 123' }],
  ])('validación: %s → 400', async (_n, o) => {
    expect((await api(as1).post('/api/monthly', plan({ plate: 'MEN102', ...o }))).status).toBe(400);
  });

  test('noche con franja: acepta "7pm" y "7:00 a. m."', async () => {
    const res = await api(as1).post('/api/monthly', plan({ plate: 'NOC100', schedule: 'NIGHT', nightStart: '7pm', nightEnd: '7:00 a. m.' }));
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ schedule: 'NIGHT', nightStart: '19:00', nightEnd: '07:00' });
  });

  test('mensualidad duplicada: la misma placa no puede tener dos vigentes (409)', async () => {
    const res = await api(as1).post('/api/monthly', plan({ clientName: 'Otra Persona', phones: ['3110000000'] }));
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('MONTHLY_DUPLICATE');
    // Tampoco al registrar dos a la vez
    const both = await Promise.all([
      api(as1).post('/api/monthly', plan({ plate: 'DUP100' })),
      api(as1).post('/api/monthly', plan({ plate: 'dup-100' })),
    ]);
    expect(both.map((r) => r.status).sort()).toEqual([201, 409]);
  });

  test('una vencida hace más de 3 días ya no impide registrar otra; una eliminada tampoco', async () => {
    await paidPlan('OLD100', -60, -10);
    expect((await api(as1).post('/api/monthly', plan({ plate: 'OLD100' }))).status).toBe(201);
    const second = (await api(as1).post('/api/monthly', plan({ plate: 'DEL100' }))).body.data;
    expect((await api(as1).del(`/api/monthly/${second.id}`)).status).toBe(200);
    expect((await api(as1).post('/api/monthly', plan({ plate: 'DEL100' }))).status).toBe(201);
  });

  test('el OP no gestiona mensualidades (403)', async () => {
    expect((await api(op1).get(`/api/monthly?siteId=${site}`)).status).toBe(403);
  });
});

// ===========================================================================
describe('mensualidades: pagos (RF14-RF15)', () => {
  test('pago único: cubre el período registrado, recibo FM y no pasa por caja', async () => {
    const p = (await api(as1).post('/api/monthly', plan({ plate: 'PAG100' }))).body.data;
    const res = await api(as1).post(`/api/monthly/${p.id}/pay`, { paymentMethod: 'CASH' });
    expect(res.status).toBe(200);
    expect(res.body.data.plan).toMatchObject({ paymentStatus: 'PAID', startDate: p.startDate, endDate: p.endDate, status: { code: 'ACTIVE' } });
    expect(res.body.data.receipt).toMatchObject({ type: 'MONTHLY', receipt: 'FM1', chargedAmount: 130000, periodStart: p.startDate });
    const { rows } = await query('SELECT count(*) AS n FROM entries WHERE cash_register_id IS NOT NULL');
    expect(rows[0].n).toBe(0);
    // Al día y lejos del vencimiento: no se puede "renovar"; debe usar pago adelantado
    const again = await api(as1).post(`/api/monthly/${p.id}/pay`, { paymentMethod: 'CASH' });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('RENEWAL_NOT_YET');
  });

  test('pago quincenal completo: 2 abonos, saldo sobre lo realmente cobrado', async () => {
    const p = (await api(as1).post('/api/monthly', plan({ plate: 'QUI100', isBiweekly: true }))).body.data;

    // 1.er abono: la mitad (65.000) pero con descuento se cobran 60.000 → saldo 70.000
    const first = await api(as1).post(`/api/monthly/${p.id}/pay`, {
      paymentMethod: 'ELECTRONIC',
      chargedAmount: 60000,
      discountReason: 'Acuerdo con el cliente',
    });
    expect(first.status).toBe(200);
    expect(first.body.data).toMatchObject({ isFinal: false, balance: 70000 });
    expect(first.body.data.plan).toMatchObject({
      paymentStatus: 'PARTIAL',
      installment: { paid: 60000, balance: 70000, periodStart: p.startDate, dueDate: await sqlDate(15) },
      status: { code: 'INSTALLMENT' },
    });
    expect(first.body.data.receipt).toMatchObject({ installmentNumber: 1, balance: 70000 });

    // Un abono mayor que el saldo → 400
    expect((await api(as1).post(`/api/monthly/${p.id}/pay`, { paymentMethod: 'CASH', installmentAmount: 80000 })).status).toBe(400);

    // 2.º abono: por defecto el saldo → queda pagada con el período registrado
    const second = await api(as1).post(`/api/monthly/${p.id}/pay`, { paymentMethod: 'CASH' });
    expect(second.status).toBe(200);
    expect(second.body.data).toMatchObject({ isFinal: true, balance: 0 });
    expect(second.body.data.plan).toMatchObject({ paymentStatus: 'PAID', installment: null, startDate: p.startDate, endDate: p.endDate });

    const { rows } = await query(
      'SELECT installment_number, amount, discount_amount FROM monthly_payments WHERE monthly_plan_id = $1 ORDER BY id',
      [p.id],
    );
    expect(rows).toEqual([
      { installment_number: 1, amount: 60000, discount_amount: 5000 },
      { installment_number: 2, amount: 70000, discount_amount: 0 },
    ]);
  });

  test('pago en mora: se paga sin límite de días y el período continúa desde el vencimiento anterior', async () => {
    const id = await paidPlan('MOR100', -40, -10);
    const list = (await api(as1).get(`/api/monthly?siteId=${site}&q=MOR100`)).body.data.items[0];
    expect(list.status).toMatchObject({ code: 'OVERDUE', moraDays: 10, label: 'En mora (10 d)', canPay: true });

    const res = await api(as1).post(`/api/monthly/${id}/pay`, { paymentMethod: 'CASH' });
    expect(res.status).toBe(200);
    const oldEnd = await sqlDate(-10);
    expect(res.body.data.plan).toMatchObject({ startDate: oldEnd, status: { moraDays: 0 } });
    expect(res.body.data.receipt.periodStart).toBe(oldEnd);

    // Con meses de atraso, un pago no alcanza: sigue en mora hasta ponerse al día
    const late = await paidPlan('MOR200', -130, -100);
    const r2 = await api(as1).post(`/api/monthly/${late}/pay`, { paymentMethod: 'CASH' });
    expect(r2.status).toBe(200);
    expect(r2.body.data.plan.status.code).toBe('OVERDUE');
    expect(r2.body.data.plan.startDate).toBe(await sqlDate(-100));
  });

  test('ventana −1 día: pagar un día antes del vencimiento ya renueva al período siguiente', async () => {
    const id = await paidPlan('VEN100', -29, 1);
    const res = await api(as1).post(`/api/monthly/${id}/pay`, { paymentMethod: 'CASH' });
    expect(res.status).toBe(200);
    expect(res.body.data.plan.startDate).toBe(await sqlDate(1));
  });

  test('pago adelantado: queda en cola, el período actual sigue y el nuevo arranca solo en su fecha', async () => {
    const id = await paidPlan('ADE100', -20, 10);
    const res = await api(as1).post(`/api/monthly/${id}/prepay`, { paymentMethod: 'CASH' });
    expect(res.status).toBe(200);
    const end = await sqlDate(10);
    expect(res.body.data.plan).toMatchObject({
      startDate: await sqlDate(-20),
      endDate: end,
      nextPeriod: { start: end },
      status: { code: 'PREPAID' },
    });
    expect(res.body.data.receipt).toMatchObject({ isAdvance: true, periodStart: end });

    // No se puede pagar ni adelantar otra vez
    expect((await api(as1).post(`/api/monthly/${id}/pay`, { paymentMethod: 'CASH' })).body.code).toBe('ALREADY_PREPAID');
    expect((await api(as1).post(`/api/monthly/${id}/prepay`, { paymentMethod: 'CASH' })).status).toBe(409);

    // Llega la fecha de inicio del adelanto: el período corre solo
    await query('UPDATE monthly_plans SET end_date = CURRENT_DATE, next_period_start = CURRENT_DATE WHERE id = $1', [id]);
    const after = (await api(as1).get(`/api/monthly/${id}`)).body.data;
    expect(after).toMatchObject({ startDate: today, nextPeriod: null, endDate: res.body.data.plan.nextPeriod.end });
  });

  test('adelantar no se permite faltando 1 día o menos (se usa el pago normal)', async () => {
    const id = await paidPlan('ADE200', -29, 1);
    const res = await api(as1).post(`/api/monthly/${id}/prepay`, { paymentMethod: 'CASH' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PREPAY_NOT_ALLOWED');
  });

  test('una mensualidad pagada por adelantado sigue bloqueando la entrada normal', async () => {
    const shift = await api(op1).post('/api/shifts', { zoneId: zone, denominations: { 50000: 1 } });
    expect(shift.status).toBe(201);
    const res = await api(op1).post('/api/entries', { siteId: site, plate: 'ADE100' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('MONTHLY_ACTIVE');
  });
});

// ===========================================================================
describe('mensualidades: importación CSV (RF16)', () => {
  test('descarga la plantilla', async () => {
    const res = await api(as1).get('/api/monthly/import/template');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.text).toMatch(/placa,nombre,telefono,correo,vehiculo,valor,inicio,vence/);
  });

  test('importación con errores: carga las válidas, informa cada fila mala y quedan por confirmar', async () => {
    const csv = [
      'placa;nombre;telefono;correo;vehiculo;valor;inicio;vence;horario;hora_entrada;hora_salida',
      'IMP001;Carlos Ruiz;3001234567;;carro;130.000;2026-11-01;2026-12-01;dia;;',
      'IMP002;Marta Díaz;;;moto;80000;01/11/2026;01/12/2026;noche;7pm;6:00 a. m.',
      'XX1;Placa Mala;3001234567;;carro;130000;2026-11-01;2026-12-01;dia;;',
      'IMP003;Fecha Mala;3001234567;;carro;130000;2026-13-45;2026-12-01;dia;;',
      'IMP001;Repetida En Archivo;3001234567;;carro;130000;2026-11-01;2026-12-01;dia;;',
      'MEN100;Ya Tiene Vigente;3001234567;;carro;130000;2026-11-01;2026-12-01;dia;;',
      'IMP004;Noche Sin Horas;3001234567;;carro;130000;2026-11-01;2026-12-01;noche;;',
      'IMP005;Sin Valor;3001234567;;carro;;2026-11-01;2026-12-01;dia;;',
    ].join('\n');
    const res = await api(as1).post('/api/monthly/import', { siteId: site, csv });
    expect(res.status).toBe(200);
    expect(res.body.data.imported).toBe(2);
    expect(res.body.data.total).toBe(8);
    expect(res.body.data.errors.map((e) => e.line)).toEqual([4, 5, 6, 7, 8, 9]);
    expect(res.body.data.errors.find((e) => e.line === 7).reason).toMatch(/vigente/);

    const items = (await api(as1).get(`/api/monthly?siteId=${site}&q=IMP`)).body.data.items;
    expect(items.map((m) => m.status.code)).toEqual(['PENDING_CONFIRMATION', 'PENDING_CONFIRMATION']);
    expect(items.find((m) => m.plate === 'IMP002')).toMatchObject({ vehicleType: 'MOTORCYCLE', nightStart: '19:00', nightEnd: '06:00' });
  });

  test('una importada no se paga hasta confirmarla; confirmar la deja pagada sin pasar por caja', async () => {
    const m = (await api(as1).get(`/api/monthly?siteId=${site}&q=IMP001`)).body.data.items[0];
    expect((await api(as1).post(`/api/monthly/${m.id}/pay`, { paymentMethod: 'CASH' })).body.code).toBe('NOT_CONFIRMED');
    const res = await api(as1).post(`/api/monthly/${m.id}/confirm-import`);
    expect(res.status).toBe(200);
    expect(res.body.data.paymentStatus).toBe('PAID');
    expect((await api(as1).post(`/api/monthly/${m.id}/confirm-import`)).status).toBe(409);
  });

  test('una importada sin autorización de datos la exige al cobrar su primera renovación', async () => {
    const m = (await api(as1).get(`/api/monthly?siteId=${site}&q=IMP001`)).body.data.items[0];
    expect(m.dataConsent).toBe(false);

    const without = await api(as1).post(`/api/monthly/${m.id}/prepay`, { paymentMethod: 'CASH' });
    expect(without.status).toBe(400);
    expect(without.body.code).toBe('CONSENT_REQUIRED');
    const { rows: none } = await query('SELECT count(*) AS n FROM monthly_payments WHERE monthly_plan_id = $1', [m.id]);
    expect(none[0].n).toBe(0);

    const ok = await api(as1).post(`/api/monthly/${m.id}/prepay`, { paymentMethod: 'CASH', dataConsent: true });
    expect(ok.status).toBe(200);
    expect(ok.body.data.plan.dataConsent).toBe(true);
    const { rows } = await query('SELECT data_consent_at IS NOT NULL AS has_date FROM monthly_plans WHERE id = $1', [m.id]);
    expect(rows[0].has_date).toBe(true);
  });

  test('una registrada a mano (ya autorizada) no vuelve a pedir la autorización', async () => {
    const p = (await api(as1).post('/api/monthly', plan({ plate: 'CON100' }))).body.data;
    expect((await api(as1).post(`/api/monthly/${p.id}/pay`, { paymentMethod: 'CASH' })).status).toBe(200);
  });

  test('archivo sin columnas obligatorias → 400', async () => {
    const res = await api(as1).post('/api/monthly/import', { siteId: site, csv: 'placa,nombre\nABC123,Ana' });
    expect(res.status).toBe(400);
  });
});

// ===========================================================================
describe('reporte de mensualidades y alertas', () => {
  test('reporte del día: pagos FM, totales y cartera', async () => {
    const res = await api(as1).get(`/api/monthly/report?siteId=${site}&from=${today}&to=${today}`);
    expect(res.status).toBe(200);
    expect(res.body.data.totals.count).toBeGreaterThanOrEqual(6);
    expect(res.body.data.payments[0].receipt).toMatch(/^FM\d+$/);
    expect(res.body.data.portfolio).toEqual(expect.objectContaining({ pending: expect.any(Number), overdue: expect.any(Number) }));
  });

  test('alertas rojo / amarillo / verde en el Inicio', async () => {
    await paidPlan('ALR000', -30, 0); // vence hoy → rojo
    await paidPlan('ALR002', -28, 2); // 2 días → amarillo
    await paidPlan('ALR005', -25, 5); // 5 días → verde
    await paidPlan('ALR009', -21, 9); // 9 días → no aparece
    const res = await api(as1).get(`/api/reports/dashboard?siteId=${site}`);
    expect(res.status).toBe(200);
    const byPlate = Object.fromEntries(res.body.data.monthlyAlerts.map((a) => [a.plate, a]));
    expect(byPlate.ALR000).toMatchObject({ color: 'red', label: 'Vence hoy' });
    expect(byPlate.ALR002.color).toBe('yellow');
    expect(byPlate.ALR005.color).toBe('green');
    expect(byPlate.ALR009).toBeUndefined();
    expect(byPlate.MOR200).toMatchObject({ color: 'red' }); // sigue en mora
    expect(byPlate.ADE100).toBeUndefined(); // ya pagó el siguiente período
  });
});

// ===========================================================================
describe('transacciones (RF18)', () => {
  let shift;

  beforeAll(async () => {
    shift = (await api(op1).get('/api/shifts/current')).body.data;
    await query('UPDATE sites SET op_expense_limit = 50000 WHERE id = $1', [site]);
  });

  test('el OP registra ingresos y egresos hasta el tope; más del tope → 403', async () => {
    expect((await api(op1).post('/api/cash-movements', { type: 'INCOME', amount: 10000, concept: 'Lavada' })).status).toBe(201);
    expect((await api(op1).post('/api/cash-movements', { type: 'EXPENSE', amount: 40000, concept: 'Escoba' })).status).toBe(201);
    const over = await api(op1).post('/api/cash-movements', { type: 'EXPENSE', amount: 60000, concept: 'Pintura' });
    expect(over.status).toBe(403);
    expect(over.body.code).toBe('EXPENSE_LIMIT');
  });

  test('el OP no registra movimientos de base; el AS sí, en la caja del turno indicado', async () => {
    expect((await api(op1).post('/api/cash-movements', { type: 'BASE_IN', amount: 5000 })).status).toBe(403);
    const res = await api(as1).post('/api/cash-movements', { type: 'BASE_IN', amount: 20000, shiftId: shift.id });
    expect(res.status).toBe(201);
    const s = (await api(op1).get('/api/shifts/current')).body.data.summary;
    expect(s).toMatchObject({ baseIn: 20000, baseFinal: 70000, incomes: 10000, expenses: 40000, expectedCash: -30000 });
  });

  test('la base no puede quedar negativa', async () => {
    const res = await api(as1).post('/api/cash-movements', { type: 'BASE_OUT', amount: 80000, shiftId: shift.id });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('BASE_NEGATIVE');
  });

  test('listado con colores por tipo y permisos', async () => {
    const res = await api(op1).get(`/api/cash-movements?siteId=${site}&from=${today}&to=${today}`);
    expect(res.status).toBe(200);
    expect(res.body.data.items.map((m) => m.type)).toEqual(['BASE_IN', 'EXPENSE', 'INCOME']);
    const base = res.body.data.items[0];
    expect(base).toMatchObject({ canEdit: false, canDelete: false }); // movimiento ajeno para el OP
  });

  test('edición de un movimiento de otro día: rechazada (409); eliminar sí se permite', async () => {
    const created = (await api(op1).post('/api/cash-movements', { type: 'INCOME', amount: 3000, concept: 'Ayer' })).body.data;
    await query("UPDATE cash_movements SET created_at = now() - interval '1 day' WHERE id = $1", [created.id]);
    const edit = await api(as1).patch(`/api/cash-movements/${created.id}`, { amount: 4000 });
    expect(edit.status).toBe(409);
    expect(edit.body.code).toBe('EDIT_SAME_DAY_ONLY');
    expect((await api(as1).del(`/api/cash-movements/${created.id}`)).status).toBe(200);
    expect(await auditCount('CASH_MOVEMENT_DELETED')).toBe(1);
  });

  test('edición el mismo día: cambia el tipo y el valor y queda auditada', async () => {
    const created = (await api(op1).post('/api/cash-movements', { type: 'INCOME', amount: 3000 })).body.data;
    const res = await api(op1).patch(`/api/cash-movements/${created.id}`, { type: 'EXPENSE', amount: 2500 });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ type: 'EXPENSE', amount: 2500, typeLabel: 'Egreso' });
    expect(await auditCount('CASH_MOVEMENT_UPDATED')).toBe(1);
  });
});

// ===========================================================================
describe('configuración: tarifas con vigencia (RF23)', () => {
  let entryId;

  beforeAll(async () => {
    entryId = (await api(op1).post('/api/entries', { siteId: site, plate: 'TAR100' })).body.data.entryId;
    await query("UPDATE entries SET entry_at = now() - interval '61 minutes' WHERE id = $1", [entryId]);
  });

  const quote = async () => (await api(op1).get(`/api/entries/${entryId}/quote`)).body.data.total;

  test('una tarifa programada a futuro no cambia el cobro de hoy', async () => {
    const tomorrow = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
    const res = await api(as1).post(`/api/config/${site}/rates`, {
      vehicleType: 'CAR', fractionAmount: 2000, hourAmount: 4000, full12hAmount: 22000, monthlyAmount: 140000, validFrom: tomorrow,
    });
    expect(res.status).toBe(201);
    expect(await quote()).toBe(5100);
    const rates = (await api(as1).get(`/api/config/${site}/rates`)).body.data;
    expect(rates.scheduled).toHaveLength(1);
    expect(rates.current.find((r) => r.vehicleType === 'CAR')).toMatchObject({ hourAmount: 3300 });
  });

  test('no se puede programar otra antes de la ya programada ni con vigencia en el pasado', async () => {
    const res = await api(as1).post(`/api/config/${site}/rates`, { vehicleType: 'CAR', fractionAmount: 1, hourAmount: 1, full12hAmount: 0 });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('RATE_OVERLAP');
    const past = await api(as1).post(`/api/config/${site}/rates`, {
      vehicleType: 'MOTORCYCLE', hourAmount: 2500, validFrom: '2020-01-01T00:00:00-05:00',
    });
    expect(past.status).toBe(400);
  });

  test('cancelar la programada y aplicar una desde ya: el cobro cambia y el historial se conserva', async () => {
    const scheduled = (await api(as1).get(`/api/config/${site}/rates`)).body.data.scheduled[0];
    expect((await api(as1).del(`/api/config/${site}/rates/${scheduled.id}`)).status).toBe(200);

    const res = await api(as1).post(`/api/config/${site}/rates`, {
      vehicleType: 'CAR', fractionAmount: 2000, hourAmount: 4000, full12hAmount: 22000, monthlyAmount: 140000,
    });
    expect(res.status).toBe(201);
    expect(await quote()).toBe(6000); // 1 h 1 min = hora 4.000 + fracción 2.000

    const rates = (await api(as1).get(`/api/config/${site}/rates`)).body.data;
    expect(rates.current.find((r) => r.vehicleType === 'CAR')).toMatchObject({ hourAmount: 4000 });
    expect(rates.history.find((r) => r.vehicleType === 'CAR')).toMatchObject({ hourAmount: 3300, validTo: expect.any(String) });
    expect(await auditCount('RATE_CHANGED')).toBe(2);
  });

  test('el OP no cambia tarifas (403)', async () => {
    expect((await api(op1).post(`/api/config/${site}/rates`, { vehicleType: 'CAR', hourAmount: 1 })).status).toBe(403);
  });

  test('datos del local y recibos: se guardan y viajan en el recibo', async () => {
    const res = await api(as1).patch(`/api/config/${site}/settings`, {
      businessHours: 'Lunes a domingo 6:00 a. m. a 10:00 p. m.',
      receiptConfig: { exit: { show: { qr: false } }, labels: { plate: 'Vehículo' }, message: 'Gracias por preferirnos', basura: 1 },
    });
    expect(res.status).toBe(200);
    expect(res.body.data.receiptConfig).toEqual({
      labels: { plate: 'Vehículo' },
      entry: { show: {} },
      exit: { show: { qr: false } },
      monthly: { show: {} },
      message: 'Gracias por preferirnos',
    });
    const receipt = (await api(op1).get(`/api/entries/${entryId}/receipt`)).body.data;
    expect(receipt.business.hours).toMatch(/Lunes a domingo/);
    expect(receipt.config.labels.plate).toBe('Vehículo');
  });
});

// ===========================================================================
describe('inicio y reportes (RF20-RF22)', () => {
  beforeAll(async () => {
    const id = (await api(op1).post('/api/entries', { siteId: site, plate: 'REP100' })).body.data.entryId;
    await query("UPDATE entries SET entry_at = now() - interval '61 minutes' WHERE id = $1", [id]);
    await api(op1).post(`/api/entries/${id}/exit`, { paymentMethod: 'CASH' });
  });

  test('inicio: vehículos dentro, entradas/salidas del día, ventas por forma de pago y ocupación', async () => {
    const res = await api(as1).get(`/api/reports/dashboard?siteId=${site}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      inside: { total: 1, capacity: 100, occupancy: 1 },
      today: { entries: 2, exits: 1 },
      sales: { total: 6000, cash: 6000, count: 1 },
    });
    expect(res.body.data.openShifts).toHaveLength(1);
    expect((await api(op1).get(`/api/reports/dashboard?siteId=${site}`)).status).toBe(403);
  });

  test('resumen del día: KPIs y serie por horas', async () => {
    const res = await api(as1).get(`/api/reports/summary?siteId=${site}&from=${today}&to=${today}`);
    expect(res.status).toBe(200);
    expect(res.body.data.granularity).toBe('hour');
    expect(res.body.data.series).toHaveLength(24);
    // Ingresos = ventas (6.000) + ingresos manuales (10.000); egresos 40.000 + 2.500
    expect(res.body.data.kpis).toMatchObject({ sales: 6000, incomes: 10000, income: 16000, expenses: 42500, net: -26500, cash: 6000 });
    const sum = res.body.data.series.reduce((s, b) => s + b.income, 0);
    expect(sum).toBe(16000);
  });

  test('la agrupación depende del rango: días, semanas y meses', async () => {
    const g = async (from, to) => (await api(as1).get(`/api/reports/summary?siteId=${site}&from=${from}&to=${to}`)).body.data.granularity;
    expect(await g('2026-11-01', '2026-11-30')).toBe('day');
    expect(await g('2026-01-01', '2026-11-30')).toBe('week');
    expect(await g('2024-01-01', '2026-11-30')).toBe('month');
    // Desde > Hasta se intercambian solos
    expect(await g('2026-11-30', '2026-11-01')).toBe('day');
  });

  test('cierres de caja con detalle', async () => {
    const shift = (await api(op1).get('/api/shifts/current')).body.data;
    await api(op1).post(`/api/shifts/${shift.id}/close`, { denominations: { 20000: 1 } });
    const list = await api(as1).get(`/api/reports/closures?siteId=${site}&from=${today}&to=${today}`);
    expect(list.status).toBe(200);
    expect(list.body.data).toHaveLength(1);
    const detail = await api(as1).get(`/api/reports/closures/${list.body.data[0].id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.data.counts.map((c) => c.kind)).toEqual(['OPENING', 'CLOSING']);
    expect(detail.body.data.sales).toHaveLength(1);
    expect(detail.body.data.movements.length).toBeGreaterThanOrEqual(3);
  });

  test('fidelidad de clientes', async () => {
    const res = await api(as1).get(`/api/reports/loyalty?siteId=${site}`);
    expect(res.status).toBe(200);
    expect(res.body.data.totalClients).toBeGreaterThanOrEqual(2);
    expect(res.body.data.clients[0]).toEqual(expect.objectContaining({ plate: expect.any(String), score: expect.any(Number), level: expect.any(Object) }));
  });

  test('exportación a Excel (.xlsx) y PDF', async () => {
    const xlsx = await request(app)
      .get(`/api/reports/export?format=xlsx&siteId=${site}&from=${today}&to=${today}`)
      .set(...as1.auth)
      .buffer(true)
      .parse((res, cb) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(xlsx.status).toBe(200);
    expect(xlsx.headers['content-type']).toMatch(/spreadsheetml/);
    expect(xlsx.body.subarray(0, 2).toString()).toBe('PK'); // .xlsx es un zip

    const pdf = await request(app)
      .get(`/api/reports/export?format=pdf&siteId=${site}&from=${today}&to=${today}`)
      .set(...as1.auth)
      .buffer(true)
      .parse((res, cb) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(pdf.status).toBe(200);
    expect(pdf.body.subarray(0, 4).toString()).toBe('%PDF');
  });

  test('respaldos: solo el AG (el AS recibe 403)', async () => {
    expect((await api(as1).get('/api/backups')).status).toBe(403);
    const ag = await loginAs('Felipe', process.env.SEED_ADMIN_PASSWORD);
    expect((await api(ag).get('/api/backups')).status).toBe(200);
    expect((await api(ag).get('/api/backups/..%2F..%2F.env/download')).status).toBe(400);
  });
});
