// Mapa de espacios (RF47-RF52): editor con borrador y publicación, permisos por sede, asignación
// de puestos (sugerencia, reservado de mensualidad, bloqueado, concurrencia), cambios manuales,
// indicadores y sincronización sin conexión.
const crypto = require('crypto');
const request = require('supertest');
const { query, closePool } = require('../../src/db/pool');
const { validateLayout, entranceDistance } = require('../../src/lib/maplayout');
const { app, freshDatabase, siteIdByCode, createSite, createUser, loginAs, auditCount } = require('./helpers');

let faca;
let norte;
let zPrincipal;
let zSotano;
let asFaca;
let asNorte;
let opFaca;
const ids = {};

const api = (s) => ({
  get: (p) => request(app).get(p).set(...s.auth),
  post: (p, b) => request(app).post(p).set(...s.auth).send(b),
  put: (p, b) => request(app).put(p).set(...s.auth).send(b),
  del: (p) => request(app).delete(p).set(...s.auth),
});
const space = (id, code, row, col, extra = {}) => ({ id, kind: 'SPACE', code, row, col, spaceType: 'CAR', usage: 'HOURLY', covered: false, size: '1x1', orientation: 'H', ...extra });

// Plano de prueba (4 × 6):
//   fila 0: [ENTRADA] A1 A2 A3(solo mensualidad) M1(moto) R1(movilidad reducida)
//   fila 1: vía
//   filas 2-3: B1 (carro 1×2 vertical) · área "Columna" 2×2 · C1 (carro) · SALIDA
const LAYOUT = {
  rows: 4,
  cols: 6,
  elements: [
    { id: 'in', kind: 'ENTRANCE', row: 0, col: 0, width: 1, height: 1 },
    space('a1', 'A1', 0, 1),
    space('a2', 'A2', 0, 2, { usage: 'MIXED', covered: true }),
    space('a3', 'A3', 0, 3, { usage: 'MONTHLY' }),
    space('m1', 'M1', 0, 4, { spaceType: 'MOTORCYCLE' }),
    space('r1', 'R1', 0, 5, { spaceType: 'REDUCED_MOBILITY' }),
    { id: 'road', kind: 'ROAD', row: 1, col: 0, width: 6, height: 1 },
    space('b1', 'B1', 2, 0, { size: '1x2', orientation: 'V' }),
    { id: 'col', kind: 'BLOCKED', row: 2, col: 1, width: 2, height: 2, label: 'Columna' },
    space('c1', 'C1', 2, 3),
    { id: 'out', kind: 'EXIT', row: 3, col: 5, width: 1, height: 1 },
  ],
};

const spaceId = async (code, zoneId = zPrincipal) => Number((await query('SELECT id FROM parking_spaces WHERE zone_id = $1 AND code = $2', [zoneId, code])).rows[0].id);
const entry = (plate, extra = {}) => api(opFaca).post('/api/entries', { siteId: faca, plate, ...extra });

beforeAll(async () => {
  await freshDatabase();
  faca = await siteIdByCode('FACA');
  norte = await createSite('NORTE', 'Sede Norte');
  zPrincipal = (await query("SELECT id FROM zones WHERE site_id = $1 AND name = 'Principal'", [faca])).rows[0].id;
  zSotano = (await query("INSERT INTO zones (site_id, name) VALUES ($1, 'Sótano') RETURNING id", [faca])).rows[0].id;
  await createUser({ username: 'as.faca', role: 'AS', siteIds: [faca] });
  await createUser({ username: 'as.norte', role: 'AS', siteIds: [norte] });
  await createUser({ username: 'op.faca', role: 'OP', siteIds: [faca] });
  asFaca = await loginAs('as.faca');
  asNorte = await loginAs('as.norte');
  opFaca = await loginAs('op.faca');
  ids.shift = (await api(opFaca).post('/api/shifts', { zoneId: zPrincipal, denominations: {} })).body.data.id;
});

afterAll(closePool);

describe('validación del plano (regla pura)', () => {
  test('el plano de prueba es válido y calcula la distancia a la entrada', () => {
    const v = validateLayout(LAYOUT);
    expect(v.errors).toEqual([]);
    const b1 = v.elements.find((e) => e.code === 'B1');
    expect(b1).toMatchObject({ width: 1, height: 2 });
    expect(entranceDistance(v.elements.find((e) => e.code === 'A1'), v.elements)).toBe(1);
    expect(entranceDistance(b1, v.elements)).toBe(2);
  });

  test('superposición, códigos repetidos y fuera de la cuadrícula', () => {
    const overlap = validateLayout({ ...LAYOUT, elements: [...LAYOUT.elements, space('x', 'X1', 2, 2)] });
    expect(overlap.errors.join(' ')).toMatch(/El puesto X1 se superpone con el área "Columna"/);
    const dup = validateLayout({ ...LAYOUT, elements: [...LAYOUT.elements, space('x', 'a1', 3, 4)] });
    expect(dup.errors).toContain('Puesto A1: el código está repetido');
    const out = validateLayout({ ...LAYOUT, elements: [space('x', 'Z1', 3, 5, { size: '1x2', orientation: 'V' })] });
    expect(out.errors).toContain('Puesto Z1: queda fuera de la cuadrícula');
  });
});

describe('RF47 editor: permisos, borrador y publicación', () => {
  test('solo AG/AS de la sede editan; el OP y el AS de otra sede reciben 403', async () => {
    expect((await api(opFaca).put(`/api/maps/zones/${zPrincipal}/draft`, LAYOUT)).status).toBe(403);
    expect((await api(asNorte).put(`/api/maps/zones/${zPrincipal}/draft`, LAYOUT)).status).toBe(403);
    expect((await api(asNorte).post(`/api/maps/zones/${zPrincipal}/publish`)).status).toBe(403);
    expect((await api(asNorte).get(`/api/maps/zones/${zPrincipal}`)).status).toBe(403);
  });

  test('un plano inválido no se guarda (detalle de los errores)', async () => {
    const res = await api(asFaca).put(`/api/maps/zones/${zPrincipal}/draft`, { ...LAYOUT, elements: [...LAYOUT.elements, space('x', 'A1', 3, 4)] });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MAP_INVALID');
    expect(res.body.details.errors).toContain('Puesto A1: el código está repetido');
  });

  test('borrador → publicación v1; sin mapa publicado la zona no asigna puestos', async () => {
    const noMap = await entry('ZZZ001');
    expect(noMap.status).toBe(201);
    expect(noMap.body.data.space).toBeNull();
    await api(opFaca).post(`/api/entries/${noMap.body.data.entryId}/exit`, { paymentMethod: 'CASH' });

    const draft = await api(asFaca).put(`/api/maps/zones/${zPrincipal}/draft`, { ...LAYOUT, notes: 'Primera versión' });
    expect(draft.status).toBe(200);
    expect(draft.body.data).toMatchObject({ draft: { version: 1, status: 'DRAFT' }, published: null });
    // El borrador no afecta la operación
    expect((await query('SELECT count(*) AS n FROM parking_spaces')).rows[0].n).toBe(0);
    const pub = await api(asFaca).post(`/api/maps/zones/${zPrincipal}/publish`);
    expect(pub.body.data).toMatchObject({ published: { version: 1, status: 'PUBLISHED' }, draft: null });
    expect((await query('SELECT code, entrance_distance FROM parking_spaces WHERE zone_id = $1 ORDER BY code', [zPrincipal])).rows).toEqual([
      { code: 'A1', entrance_distance: 1 },
      { code: 'A2', entrance_distance: 2 },
      { code: 'A3', entrance_distance: 3 },
      { code: 'B1', entrance_distance: 2 },
      { code: 'C1', entrance_distance: 5 },
      { code: 'M1', entrance_distance: 4 },
      { code: 'R1', entrance_distance: 5 },
    ]);
    expect(await auditCount('MAP_PUBLISHED')).toBe(1);
    expect((await api(asFaca).post(`/api/maps/zones/${zPrincipal}/publish`)).status).toBe(404); // sin borrador
  });

  test('duplicar como plantilla en otra zona (y no desde una sede ajena)', async () => {
    const copy = await api(asFaca).post(`/api/maps/zones/${zSotano}/copy`, { sourceZoneId: zPrincipal });
    expect(copy.status).toBe(200);
    expect(copy.body.data.draft.elements).toHaveLength(LAYOUT.elements.length);
    expect(copy.body.data.draft.notes).toContain('Principal');
    expect((await api(asFaca).post(`/api/maps/zones/${zSotano}/copy`, { sourceZoneId: zPrincipal })).body.code).toBe('DRAFT_EXISTS');
    const nz = (await query('SELECT id FROM zones WHERE site_id = $1', [norte])).rows[0].id;
    expect((await api(asNorte).post(`/api/maps/zones/${nz}/copy`, { sourceZoneId: zPrincipal })).status).toBe(403);
    expect((await api(asFaca).del(`/api/maps/zones/${zSotano}/draft`)).status).toBe(200);
  });
});

describe('RF48-RF50 vista en vivo y asignación', () => {
  test('la entrada recibe el puesto libre más cercano a la entrada, del tipo correcto', async () => {
    const sug = await api(opFaca).get(`/api/spaces/suggest?siteId=${faca}&plate=CAR001`);
    expect(sug.body.data).toMatchObject({ hasMap: true, suggested: { code: 'A1' } });
    const e1 = await entry('CAR001');
    expect(e1.body.data.space).toMatchObject({ code: 'A1' });
    const e2 = await entry('CAR002');
    expect(e2.body.data.space.code).toBe('A2'); // A3 es solo mensualidad
    const moto = await entry('MOT12A');
    expect(moto.body.data.space.code).toBe('M1');
    ids.e1 = e1.body.data.entryId;
    ids.e2 = e2.body.data.entryId;
  });

  test('vista en vivo para todos los roles con acceso: estado, reserva y vehículo', async () => {
    const live = await api(opFaca).get(`/api/maps/zones/${zPrincipal}/live`);
    expect(live.status).toBe(200);
    const a1 = live.body.data.elements.find((e) => e.code === 'A1');
    expect(a1).toMatchObject({ state: 'OCCUPIED', entry: { plate: 'CAR001', minutes: expect.any(Number) } });
    expect(live.body.data.elements.find((e) => e.code === 'C1').state).toBe('FREE');
    expect(live.body.data.counts).toMatchObject({ total: 7, occupied: 3, free: 4, blocked: 0 });
    expect((await api(asNorte).get(`/api/maps/zones/${zPrincipal}/live`)).status).toBe(403);
  });

  test('puesto bloqueado (con motivo) no se asigna ni se elige; no se bloquea uno ocupado', async () => {
    const b1 = await spaceId('B1');
    expect((await api(opFaca).post(`/api/spaces/${b1}/block`, {})).body.code).toBe('REASON_REQUIRED');
    expect((await api(opFaca).post(`/api/spaces/${b1}/block`, { reason: 'Mancha de aceite' })).status).toBe(200);
    expect((await api(opFaca).post(`/api/spaces/${await spaceId('A1')}/block`, { reason: 'Prueba' })).body.code).toBe('SPACE_TAKEN');
    const chosen = await entry('CAR003', { spaceId: b1 });
    expect(chosen.status).toBe(409);
    expect(chosen.body.code).toBe('SPACE_BLOCKED');
    const auto = await entry('CAR003');
    expect(auto.body.data.space.code).toBe('C1'); // salta B1 (bloqueado), A3 (mensualidad) y R1
    ids.e3 = auto.body.data.entryId;
    expect(await auditCount('SPACE_BLOCKED')).toBe(1);
    // Liberar exige motivo y queda auditado
    expect((await api(opFaca).post(`/api/spaces/${b1}/unblock`, { reason: 'Ya se limpió' })).status).toBe(200);
    expect(await auditCount('SPACE_UNBLOCKED')).toBe(1);
  });

  test('tipo: una moto no puede ocupar un puesto de carro; un carro puede elegir movilidad reducida', async () => {
    const res = await entry('MOT34B', { spaceId: await spaceId('B1') });
    expect(res.body.code).toBe('SPACE_TYPE_MISMATCH');
    const r1 = await entry('CAR004', { spaceId: await spaceId('R1') });
    expect(r1.body.data.space.code).toBe('R1');
    ids.e4 = r1.body.data.entryId;
  });

  test('dos entradas a la vez al mismo puesto: solo una lo obtiene', async () => {
    const b1 = await spaceId('B1');
    const [a, b] = await Promise.all([entry('CON001', { spaceId: b1 }), entry('CON002', { spaceId: b1 })]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([201, 409]);
    expect([a.body.code, b.body.code]).toContain('SPACE_TAKEN');
    expect((await query("SELECT count(*) AS n FROM entries WHERE space_id = $1 AND status = 'OPEN'", [b1])).rows[0].n).toBe(1);
    ids.b1Entry = (a.status === 201 ? a : b).body.data.entryId;
  });

  test('puesto reservado para un titular de mensualidad: solo él lo ocupa y se le sugiere primero', async () => {
    // Mensualidad nocturna cuya franja no es ahora (así puede registrar entrada)
    const { rows } = await query(
      `INSERT INTO monthly_plans (site_id, plate, vehicle_type, client_name, start_date, end_date, amount, payment_status, origin,
                                  data_consent, data_consent_at, schedule, night_start, night_end)
       VALUES ($1, 'MEN001', 'CAR', 'Ana', CURRENT_DATE - 1, CURRENT_DATE + 29, 90000, 'PAID', 'MANUAL', true, now(), 'NIGHT',
               (now() + interval '2 hours')::time, (now() + interval '3 hours')::time) RETURNING id`,
      [faca],
    );
    const a3 = await spaceId('A3');
    expect((await api(opFaca).put(`/api/spaces/${a3}/reservation`, { monthlyPlanId: rows[0].id })).status).toBe(403); // solo AS/AG
    expect((await api(asFaca).put(`/api/spaces/${await spaceId('M1')}/reservation`, { monthlyPlanId: rows[0].id })).body.code).toBe('SPACE_TYPE_MISMATCH');
    const reserved = await api(asFaca).put(`/api/spaces/${a3}/reservation`, { monthlyPlanId: rows[0].id });
    expect(reserved.body.data).toMatchObject({ code: 'A3', reservedPlanId: Number(rows[0].id) });
    // Otro vehículo no puede tomarlo
    expect((await entry('OTR001', { spaceId: a3 })).body.code).toBe('SPACE_RESERVED');
    // Al titular se le sugiere su puesto
    expect((await api(opFaca).get(`/api/spaces/suggest?siteId=${faca}&plate=MEN001`)).body.data.suggested).toMatchObject({ code: 'A3', reserved: true });
    const own = await entry('MEN001');
    expect(own.status).toBe(201);
    expect(own.body.data.space.code).toBe('A3');
    const live = await api(opFaca).get(`/api/maps/zones/${zPrincipal}/live`);
    expect(live.body.data.elements.find((e) => e.code === 'A3')).toMatchObject({ reserved: true, state: 'OCCUPIED', usage: 'MONTHLY' });
  });

  test('sin puestos libres del tipo, la entrada se registra sin puesto', async () => {
    const res = await entry('OTR002');
    expect(res.status).toBe(201);
    expect(res.body.data.space).toBeNull();
  });
});

describe('RF51 cambios manuales', () => {
  test('mover un vehículo de puesto con motivo (auditado); no a uno ocupado', async () => {
    const moto = (await query("SELECT id FROM entries WHERE plate = 'OTR002'")).rows[0].id;
    expect((await api(opFaca).post(`/api/spaces/move/${ids.e1}`, { spaceId: await spaceId('A2'), reason: 'Cliente lo pidió' })).body.code).toBe('SPACE_TAKEN');
    expect((await api(opFaca).post(`/api/spaces/move/${ids.e1}`, { spaceId: await spaceId('A2') })).body.code).toBe('REASON_REQUIRED');
    // Sale el de A2 y se mueve el de A1 a A2
    await api(opFaca).post(`/api/entries/${ids.e2}/exit`, { paymentMethod: 'CASH' });
    const moved = await api(opFaca).post(`/api/spaces/move/${ids.e1}`, { spaceId: await spaceId('A2'), reason: 'Cliente lo pidió' });
    expect(moved.body.data).toMatchObject({ entryId: ids.e1, plate: 'CAR001', from: 'A1', to: 'A2', requiresKeys: false, keysReceived: null });
    expect(await auditCount('ENTRY_SPACE_MOVED')).toBe(1);
    // Al quedar libre A1, el vehículo sin puesto puede pasarse ahí
    expect((await api(opFaca).post(`/api/spaces/move/${moto}`, { spaceId: await spaceId('A1'), reason: 'Ya hay cupo' })).body.data.to).toBe('A1');
    expect((await api(asNorte).post(`/api/spaces/move/${moto}`, { spaceId: await spaceId('C1'), reason: 'Desde otra sede' })).status).toBe(403);
  });

  test('publicar un plano que quita un puesto ocupado se rechaza; si no, crea la versión 2', async () => {
    const without = { ...LAYOUT, elements: LAYOUT.elements.filter((e) => e.code !== 'C1') };
    await api(asFaca).put(`/api/maps/zones/${zPrincipal}/draft`, without);
    const res = await api(asFaca).post(`/api/maps/zones/${zPrincipal}/publish`);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('SPACE_IN_USE');
    expect(res.body.details.errors[0]).toMatch('C1 está ocupado (CAR003)');
    // Sale el carro de C1 y ya se puede
    await api(opFaca).post(`/api/entries/${ids.e3}/exit`, { paymentMethod: 'CASH' });
    const ok = await api(asFaca).post(`/api/maps/zones/${zPrincipal}/publish`);
    expect(ok.body.data.published.version).toBe(2);
    expect(ok.body.data.versions.map((v) => [v.version, v.status])).toEqual([[2, 'PUBLISHED'], [1, 'ARCHIVED']]);
    expect((await query("SELECT is_active FROM parking_spaces WHERE code = 'C1'")).rows[0].is_active).toBe(false);
  });
});

describe('RF52 indicadores', () => {
  test('ocupación por zona y tipo, histórico por hora y mapa de calor (solo AS/AG)', async () => {
    const ind = await api(asFaca).get('/api/maps/indicators');
    const z = ind.body.data.find((x) => x.zoneId === zPrincipal);
    expect(z).toMatchObject({ total: 6, reserved: 1 });
    expect(z.byType.find((t) => t.spaceType === 'CAR')).toMatchObject({ total: 4 });
    expect((await api(opFaca).get('/api/maps/indicators')).status).toBe(403);
    expect((await api(asNorte).get(`/api/maps/indicators?siteId=${faca}`)).status).toBe(403);

    // Un vehículo lleva un rato dentro (desde el inicio de esta hora, o 20 min)
    await query("UPDATE entries SET entry_at = GREATEST(date_trunc('hour', now()), now() - interval '20 minutes') WHERE plate = 'CAR001'");
    const hist = await api(asFaca).get(`/api/maps/zones/${zPrincipal}/history`);
    expect(hist.body.data.hours).toHaveLength(24);
    expect(hist.body.data.spaces).toBe(6);
    // Todas las entradas de la prueba son de esta hora: las horas anteriores quedan en 0 y ninguna es negativa
    const nowHour = new Date(Date.now() - 5 * 3600000).getUTCHours();
    expect(hist.body.data.hours.every((h) => h.occupiedMinutes >= 0)).toBe(true);
    expect(hist.body.data.hours.filter((h) => h.hour < nowHour).every((h) => h.occupiedMinutes === 0)).toBe(true);
    expect(hist.body.data.hours.find((h) => h.hour === nowHour).occupiedMinutes).toBeGreaterThan(0);
    const heat = await api(asFaca).get(`/api/maps/zones/${zPrincipal}/heatmap`);
    const a2 = heat.body.data.elements.find((e) => e.code === 'A2');
    expect(a2.heat.entries).toBeGreaterThanOrEqual(2);
    expect(a2.heat.utilization).toBeGreaterThanOrEqual(0);
  });
});

describe('sin conexión', () => {
  test('la copia local trae el mapa; al sincronizar, un puesto ya ocupado se corrige sin conflicto', async () => {
    const snap = await api(opFaca).get(`/api/sync/snapshot?siteId=${faca}`);
    const map = snap.body.data.maps.find((m) => m.zone.id === zPrincipal);
    expect(map).toMatchObject({ published: true, rows: 4, cols: 6 });
    expect(map.elements.find((e) => e.code === 'A1').entry).toEqual({ id: expect.any(Number) });
    expect(snap.body.data.openEntries.find((e) => e.plate === 'CAR001').spaceId).toBe(await spaceId('A2'));

    // El equipo eligió A1 sin saber que ya está ocupado: se le da otro puesto (B1 queda libre)
    await api(opFaca).post(`/api/entries/${ids.b1Entry}/exit`, { paymentMethod: 'CASH' });
    const op = {
      id: crypto.randomUUID(),
      seq: 1,
      kind: 'ENTRY',
      clientTs: new Date().toISOString(),
      provisionalReceipt: 'FA-P-TAB01-0001',
      data: { siteId: faca, plate: 'OFF001', shiftId: ids.shift, spaceId: await spaceId('A1') },
    };
    const res = await api(opFaca).post('/api/sync/operations', { deviceId: 'TAB01', operations: [op] });
    expect(res.body.data.results[0].status).toBe('APPLIED');
    const e = (await query("SELECT ps.code FROM entries e JOIN parking_spaces ps ON ps.id = e.space_id WHERE e.plate = 'OFF001'")).rows[0];
    expect(e.code).toBe('B1');
  });
});
