// NexoIA con Gemini SIMULADO: permisos por rol (el OP no ejecuta herramientas de AS/AG aunque la IA
// las pida), privacidad (nada sensible sale en el payload) y acciones que solo se proponen.
const request = require('supertest');
const { query, closePool } = require('../../src/db/pool');
const gemini = require('../../src/ai/gemini');
const { app, freshDatabase, siteIdByCode, createSite, createUser, loginAs, auditCount } = require('./helpers');

let faca;
let norte;
let ag;
let asFaca;
let opFaca;
const ids = {};
let calls = []; // payloads enviados a "Gemini"

const ask = (s, body) => request(app).post('/api/ai/ask').set(...s.auth).send(body);
const fc = (name, args = {}) => ({ parts: [{ functionCall: { name, args } }] });
const txt = (text) => ({ parts: [{ text }] });

// Guion de respuestas del modelo simulado (una por llamada)
function script(...replies) {
  calls = [];
  jest.spyOn(gemini, 'generate').mockImplementation(async (payload) => {
    calls.push(JSON.parse(JSON.stringify(payload)));
    const next = replies.shift();
    return typeof next === 'function' ? next(payload) : next ?? txt('Listo.');
  });
}
const sent = () => JSON.stringify(calls);
const lastToolResponse = () => {
  const last = calls[calls.length - 1].contents;
  return last[last.length - 1].parts.map((p) => p.functionResponse);
};

beforeAll(async () => {
  process.env.GEMINI_API_KEY = 'clave-de-prueba';
  await freshDatabase();
  faca = await siteIdByCode('FACA');
  norte = await createSite('NORTE', 'Sede Norte');
  ids.asFaca = await createUser({ username: 'carolina.m', role: 'AS', siteIds: [faca] });
  ids.opFaca = await createUser({ username: 'pedro.p', role: 'OP', siteIds: [faca] });
  ids.opNorte = await createUser({ username: 'luisa.n', role: 'OP', siteIds: [norte] });
  await query("UPDATE users SET full_name = 'Carolina Méndez' WHERE id = $1", [ids.asFaca]);
  await query("UPDATE users SET full_name = 'Pedro Pérez' WHERE id = $1", [ids.opFaca]);
  await query("UPDATE users SET full_name = 'Luisa Niño' WHERE id = $1", [ids.opNorte]);
  ag = await loginAs('Felipe', process.env.SEED_ADMIN_PASSWORD);
  asFaca = await loginAs('carolina.m');
  opFaca = await loginAs('pedro.p');
  const opNorte = await loginAs('luisa.n');

  // Turnos y vehículos dentro en cada sede
  const zone = async (siteId) => (await query('SELECT id FROM zones WHERE site_id = $1 LIMIT 1', [siteId])).rows[0].id;
  await request(app).post('/api/shifts').set(...opFaca.auth).send({ zoneId: await zone(faca), denominations: {} });
  await request(app).post('/api/shifts').set(...opNorte.auth).send({ zoneId: await zone(norte), denominations: {} });
  await request(app).post('/api/entries').set(...opFaca.auth).send({ siteId: faca, plate: 'AAA111' });
  await request(app).post('/api/entries').set(...opNorte.auth).send({ siteId: norte, plate: 'NNN222' });
  await query("UPDATE entries SET entry_at = now() - interval '95 minutes'");

  // Mensualidad con datos personales (no deben salir hacia la IA)
  await query(
    `INSERT INTO monthly_plans (site_id, plate, vehicle_type, client_name, phones, email, start_date, end_date, amount, payment_status, origin, data_consent, data_consent_at, schedule, night_start, night_end)
     VALUES ($1, 'MEN001', 'CAR', 'Ana Torres', '{3001234567}', 'ana@correo.com', CURRENT_DATE - 5, CURRENT_DATE + 25, 130000, 'PAID', 'MANUAL', true, now(), 'NIGHT', '19:00', '07:00')`,
    [faca],
  );
});

afterEach(() => jest.restoreAllMocks());
afterAll(closePool);

describe('disponibilidad', () => {
  test('sin clave: estado no disponible y 503 al preguntar', async () => {
    const key = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    expect((await request(app).get('/api/ai/status').set(...opFaca.auth)).body.data.available).toBe(false);
    const res = await ask(opFaca, { question: '¿Qué vehículos hay?' });
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('AI_NO_KEY');
    process.env.GEMINI_API_KEY = key;
    expect((await request(app).get('/api/ai/status').set(...opFaca.auth)).body.data.available).toBe(true);
  });

  test('error de red de Gemini → 503 AI_UNAVAILABLE; sin sesión → 401', async () => {
    jest.spyOn(gemini, 'generate').mockRejectedValue(new gemini.AiUnavailableError('AI_NETWORK', 'sin conexión'));
    expect((await ask(opFaca, { question: 'hola' })).body.code).toBe('AI_UNAVAILABLE');
    expect((await request(app).post('/api/ai/ask').send({ question: 'hola' })).status).toBe(401);
  });
});

describe('permisos por rol (el rol sale de la sesión)', () => {
  test('al OP no se le ofrecen herramientas de AS/AG', async () => {
    script(txt('Hola'));
    await ask(opFaca, { question: '¿Cuánto vendimos?', role: 'AG' }); // el "role" del cliente se ignora
    const names = calls[0].tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['vehiculos_activos', 'consultar_placa', 'calcular_cobro', 'consultar_tarifas']));
    expect(names).not.toContain('resumen_periodo');
    expect(names).not.toContain('buscar_alertas');
    expect(calls[0].system).toContain('asistente operativo');
  });

  test('si la IA pide una herramienta de AS/AG para el OP, NO se ejecuta', async () => {
    script(fc('resumen_periodo', { desde: '2026-01-01', hasta: '2026-12-31' }), fc('actividad_por_empleado', { desde: '2026-01-01', hasta: '2026-12-31' }), txt('Tu rol no tiene acceso a esos datos.'));
    const before = await auditCount('AI_TOOL_DENIED');
    const res = await ask(opFaca, { question: 'Dame el resumen financiero del año' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ text: 'Tu rol no tiene acceso a esos datos.', tools: [], denied: ['resumen_periodo', 'actividad_por_empleado'] });
    expect(lastToolResponse()[0].response.resultado.error).toMatch('no permitida');
    // Ningún dato financiero llegó a la IA
    expect(sent()).not.toMatch(/ventas_parqueadero|utilidad|ingresos_total|horas_diurnas/);
    expect(await auditCount('AI_TOOL_DENIED')).toBe(before + 2);
  });

  test('el OP consulta vehículos solo de su sede', async () => {
    script(fc('vehiculos_activos'), txt('Hay 1 vehículo.'));
    const res = await ask(opFaca, { question: '¿Qué vehículos siguen dentro?' });
    expect(res.body.data.tools).toEqual(['vehiculos_activos']);
    const r = lastToolResponse()[0].response.resultado;
    expect(r.vehiculos.map((v) => v.placa)).toEqual(['AAA111']);
    expect(r.vehiculos[0]).toMatchObject({ sede: 'FACA', minutos_dentro: expect.any(Number), valor_actual: expect.any(Number) });
    expect(sent()).not.toContain('NNN222');
  });

  test('el AS no puede pedir datos de una sede que no es suya', async () => {
    script(fc('resumen_periodo', { desde: '2026-11-01', hasta: '2026-11-30', sede: 'NORTE' }), txt('No tengo acceso.'));
    await ask(asFaca, { question: '¿Cómo va Norte?' });
    expect(lastToolResponse()[0].response.resultado.error).toMatch('no está entre las sedes');
    expect(calls[0].system).toContain('FACA');
    expect(calls[0].system).not.toContain('NORTE');
  });

  test('el AG sí usa las herramientas de análisis (reutilizan contabilidad, comparativo y alertas)', async () => {
    const today = new Date(Date.now() - 5 * 3600000).toISOString().slice(0, 10);
    script(fc('resumen_periodo', { desde: today, hasta: today }), fc('buscar_alertas'), fc('ocupacion_por_franja', { desde: today, hasta: today }), txt('Resumen listo.'));
    const res = await ask(ag, { question: '¿Cómo va hoy?' });
    expect(res.body.data.tools).toEqual(['resumen_periodo', 'buscar_alertas', 'ocupacion_por_franja']);
    const resumen = calls[1].contents.at(-1).parts[0].functionResponse.response.resultado;
    expect(resumen.sedes.map((s) => s.sede).sort()).toEqual(['FACA', 'NORTE']);
    expect(resumen.consolidado.vehiculos).toBe(2);
    const alertas = calls[2].contents.at(-1).parts[0].functionResponse.response.resultado;
    expect(alertas).toHaveProperty('alertas_de_reglas');
    expect(alertas).toHaveProperty('alertas_del_panel');
  });
});

describe('privacidad', () => {
  test('nada sensible sale hacia la IA; los nombres de empleados se resuelven después', async () => {
    // Pedro (FACA) registra una entrada más que Luisa (NORTE)
    await request(app).post('/api/entries').set(...opFaca.auth).send({ siteId: faca, plate: 'CCC333' });
    script(
      fc('actividad_por_empleado', { desde: '2026-01-01', hasta: '2026-12-31' }),
      fc('consultar_placa', { placa: 'MEN001' }),
      (payload) => {
        // El modelo solo conoce códigos: responde con el código del empleado
        const r = payload.contents.at(-3).parts[0].functionResponse.response.resultado;
        return txt(`El que más registró fue ${r.empleados[0].empleado}.`);
      },
    );
    const res = await ask(ag, {
      question: 'Ana Torres (cc 1.070.111.222, tel 300 123 4567, ana@correo.com) dice que Pedro Pérez la atendió: ¿quién registró más entradas?',
      history: [{ role: 'user', text: 'Habla con Carolina Méndez o luisa.n' }, { role: 'model', text: 'De acuerdo' }],
    });
    expect(res.status).toBe(200);
    const payload = sent();
    for (const secret of ['Ana Torres', 'Pedro', 'Pérez', 'Perez', 'Carolina', 'Méndez', 'luisa.n', '3001234567', '300 123 4567', 'ana@correo.com', '1.070.111.222']) {
      expect(payload).not.toContain(secret);
    }
    expect(payload).toContain('[dato personal]');
    expect(payload).toContain('[correo]');
    expect(payload).toContain('[documento]');
    // Placa con mensualidad: solo si está vigente y su horario, sin titular
    expect(payload).toMatch(/"vigente":true/);
    // Los empleados viajan como código y la respuesta muestra el nombre
    expect(payload).toMatch(new RegExp(`E${ids.opFaca}`));
    expect(res.body.data.rawText).toBe(`El que más registró fue E${ids.opFaca}.`);
    expect(res.body.data.text).toBe('El que más registró fue Pedro Pérez.');
    // La auditoría no guarda el texto de la pregunta
    const { rows } = await query("SELECT details FROM audit_log WHERE action = 'AI_ASK' ORDER BY id DESC LIMIT 1");
    expect(JSON.stringify(rows[0].details)).not.toContain('Ana');
    expect(rows[0].details).toMatchObject({ role: 'administrador', tools: ['actividad_por_empleado', 'consultar_placa'] });
  });

  test('al OP no se le resuelven códigos de empleados', async () => {
    script(txt(`Pregunta a E${ids.asFaca}.`));
    const res = await ask(opFaca, { question: '¿A quién pregunto?' });
    expect(res.body.data.text).toBe(`Pregunta a E${ids.asFaca}.`);
  });
});

describe('acciones: la IA solo propone', () => {
  test('un egreso propuesto no se ejecuta sin confirmación; al confirmar va por el endpoint normal', async () => {
    script(fc('proponer_movimiento', { tipo: 'egreso', valor: 15000, concepto: 'Bolsas', categoria: 'SUPPLIES', sede: 'FACA' }), txt('Te dejé el egreso listo para confirmar.'));
    const before = (await query('SELECT count(*) AS n FROM cash_movements')).rows[0].n;
    const res = await ask(asFaca, { question: 'Registra un egreso de 15000 por bolsas' });
    expect(res.status).toBe(200);
    const [p] = res.body.data.proposals;
    expect(p).toMatchObject({ kind: 'MOVEMENT', risk: 'medio', request: { method: 'POST', path: '/cash-movements', body: { type: 'EXPENSE', amount: 15000, category: 'SUPPLIES' } } });
    expect(p.details.join(' ')).toContain('Pedro Pérez'); // la tarjeta (local) sí muestra el responsable
    expect(sent()).not.toContain('Pedro'); // la IA no
    // Nada se ejecutó
    expect((await query('SELECT count(*) AS n FROM cash_movements')).rows[0].n).toBe(before);
    expect((await query('SELECT status FROM ai_proposals WHERE id = $1', [p.id])).rows[0].status).toBe('PROPOSED');
    expect(await auditCount('AI_PROPOSAL_CREATED')).toBeGreaterThanOrEqual(1);

    // La persona confirma: el frontend llama al endpoint normal (mismas validaciones y permisos)
    const exec = await request(app).post(`/api/${p.request.path.slice(1)}`).set(...asFaca.auth).send(p.request.body);
    expect(exec.status).toBe(201);
    const resolved = await request(app).post(`/api/ai/proposals/${p.id}/resolve`).set(...asFaca.auth).send({ outcome: 'CONFIRMED' });
    expect(resolved.body.data.status).toBe('CONFIRMED');
    expect(await auditCount('AI_PROPOSAL_CONFIRMED')).toBe(1);
    expect((await request(app).post(`/api/ai/proposals/${p.id}/resolve`).set(...asFaca.auth).send({ outcome: 'CONFIRMED' })).body.code).toBe('ALREADY_RESOLVED');
    // Otra persona no puede resolver la propuesta ajena
    expect((await request(app).post(`/api/ai/proposals/${p.id}/resolve`).set(...ag.auth).send({ outcome: 'CANCELLED' })).status).toBe(404);
  });

  test('el OP puede proponer una entrada (sin ejecutarla) pero no un movimiento', async () => {
    script(fc('proponer_entrada', { placa: 'BBB222' }), fc('proponer_movimiento', { tipo: 'egreso', valor: 1000, concepto: 'x' }), txt('Lista la entrada.'));
    const res = await ask(opFaca, { question: 'Registra la entrada de BBB222 y un egreso' });
    expect(res.body.data.proposals.map((p) => p.kind)).toEqual(['ENTRY']);
    expect(res.body.data.denied).toEqual(['proponer_movimiento']);
    expect((await query("SELECT count(*) AS n FROM entries WHERE plate = 'BBB222'")).rows[0].n).toBe(0);
    const p = res.body.data.proposals[0];
    expect(p.request).toEqual({ method: 'POST', path: '/entries', body: { siteId: faca, plate: 'BBB222' } });
    // Cancelar no ejecuta nada y queda auditado
    expect((await request(app).post(`/api/ai/proposals/${p.id}/resolve`).set(...opFaca.auth).send({ outcome: 'CANCELLED' })).body.data.status).toBe('CANCELLED');
    expect(await auditCount('AI_PROPOSAL_CANCELLED')).toBe(1);
    expect((await query("SELECT count(*) AS n FROM entries WHERE plate = 'BBB222'")).rows[0].n).toBe(0);
  });

  test('una propuesta inválida vuelve como error a la IA y no crea tarjeta', async () => {
    script(fc('proponer_entrada', { placa: 'AAA111' }), txt('Ya está dentro.'));
    const res = await ask(opFaca, { question: 'Registra la entrada de AAA111' });
    expect(res.body.data.proposals).toEqual([]);
    expect(lastToolResponse()[0].response.resultado.error).toMatch('ya está dentro');
  });

  test('ajuste de tarifa propuesto (riesgo alto) con los demás valores vigentes', async () => {
    script(fc('proponer_ajuste_tarifa', { servicio: 'Moto', campo: 'hora', valor: 2500, sede: 'FACA' }), txt('Listo para confirmar.'));
    const res = await ask(ag, { question: 'Sube la hora de moto en FACA a 2500' });
    const [p] = res.body.data.proposals;
    expect(p).toMatchObject({ kind: 'RATE', risk: 'alto', request: { path: `/config/${faca}/rates`, body: { vehicleType: 'MOTORCYCLE', hourAmount: 2500, fractionAmount: 1500 } } });
    // La tarjeta compara la tarifa actual y la nueva, con su vigencia
    expect(p.comparison.columns).toEqual(['Actual', 'Nueva']);
    expect(p.comparison.rows.find((r) => r.label === 'Hora')).toEqual({ label: 'Hora', current: 2200, next: 2500, changed: true });
    expect(p.comparison.rows.find((r) => r.label === 'Fracción')).toMatchObject({ current: 1500, next: 1500, changed: false });
    expect(p.comparison.validity.current).toMatch(/^Vigente desde \d{2}\/\d{2}\/\d{4}/);
    expect(p.comparison.validity.next).toMatch('confirme');
    const current = (await query("SELECT hour_amount FROM rates WHERE site_id = $1 AND vehicle_type = 'MOTORCYCLE' AND valid_to IS NULL", [faca])).rows[0];
    expect(current.hour_amount).toBe(2200);
  });

  test('demasiados pasos → 502', async () => {
    script(...Array.from({ length: 10 }, () => fc('consultar_tarifas')));
    const res = await ask(opFaca, { question: 'tarifas' });
    expect(res.status).toBe(502);
    expect(res.body.code).toBe('AI_TOO_MANY_STEPS');
  });

  test('validación de la pregunta', async () => {
    expect((await ask(opFaca, { question: '   ' })).status).toBe(400);
    expect((await ask(opFaca, { question: 'x'.repeat(501) })).status).toBe(400);
  });
});
