// Plano real de Facaparking (seed) y puestos que piden llaves: orden de la sugerencia (primero los que
// no piden llaves, del más cercano a la entrada al más lejano; las islas al final), registro de las
// llaves y puestos de moto y cicla.
process.env.SEED_SITE_MAP = '1';
const request = require('supertest');
const { query, closePool } = require('../../src/db/pool');
const { seed } = require('../../src/db/seed');
const { app, freshDatabase, siteIdByCode, createUser, loginAs, auditCount } = require('./helpers');

let faca;
let zone;
let op;
let as;

const api = (s) => ({
  get: (p) => request(app).get(p).set(...s.auth),
  post: (p, b) => request(app).post(p).set(...s.auth).send(b),
  put: (p, b) => request(app).put(p).set(...s.auth).send(b),
});
const suggest = async (plate) => (await api(op).get(`/api/spaces/suggest?siteId=${faca}&plate=${plate}`)).body.data.suggested;
const spaceId = async (code) => Number((await query('SELECT id FROM parking_spaces WHERE zone_id = $1 AND code = $2', [zone, code])).rows[0].id);

beforeAll(async () => {
  await freshDatabase();
  faca = await siteIdByCode('FACA');
  zone = (await query("SELECT id FROM zones WHERE site_id = $1 AND name = 'Principal'", [faca])).rows[0].id;
  await createUser({ username: 'op.faca', role: 'OP', siteIds: [faca] });
  await createUser({ username: 'as.faca', role: 'AS', siteIds: [faca] });
  op = await loginAs('op.faca');
  as = await loginAs('as.faca');
  await api(op).post('/api/shifts', { zoneId: zone, denominations: {} });
});

afterAll(closePool);

describe('seed del plano de Facaparking', () => {
  test('zona Principal con el plano publicado (versión 1) y sus 36 puestos', async () => {
    const res = await api(as).get(`/api/maps/zones/${zone}`);
    expect(res.body.data).toMatchObject({ published: { version: 1, rows: 32, cols: 26 }, draft: null });
    const { rows } = await query('SELECT code, space_type, usage, covered, requires_keys, facing, reserved_plan_id FROM parking_spaces WHERE zone_id = $1 ORDER BY length(code), code', [zone]);
    expect(rows).toHaveLength(36);
    const cars = rows.filter((r) => /^\d+$/.test(r.code));
    expect(cars.map((r) => Number(r.code)).sort((a, b) => a - b)).toEqual(Array.from({ length: 31 }, (_, i) => i + 1));
    expect(cars.every((r) => r.space_type === 'CAR' && r.usage === 'MIXED' && r.reserved_plan_id === null)).toBe(true);
    expect(rows.filter((r) => r.code.startsWith('M')).map((r) => r.space_type)).toEqual(Array(5).fill('MOTORCYCLE_BICYCLE'));
    const covered = cars.filter((r) => r.covered).map((r) => Number(r.code)).sort((a, b) => a - b);
    expect(covered).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26]);
    expect(cars.filter((r) => r.requires_keys).map((r) => r.code).sort()).toEqual(['27', '28', '29', '30', '31']);
    // Parqueo en reversa: el frente mira hacia la vía
    const facing = Object.fromEntries(cars.map((r) => [r.code, r.facing]));
    expect([facing['1'], facing['13'], facing['30']]).toEqual(['E', 'E', 'E']);
    expect([facing['16'], facing['26'], facing['27']]).toEqual(['W', 'W', 'W']);
    expect([facing['14'], facing['15']]).toEqual(['S', 'S']);
    // Islas a media altura: 29 entre 16 y 17, 28 entre 18 y 19; 27 a la altura del 25
    const pos = Object.fromEntries((await query('SELECT code, row FROM parking_spaces WHERE zone_id = $1', [zone])).rows.map((r) => [r.code, r.row]));
    expect(pos['29']).toBe(pos['16'] + 1);
    expect(pos['17']).toBe(pos['29'] + 1);
    expect(pos['28']).toBe(pos['18'] + 1);
    expect(pos['19']).toBe(pos['28'] + 1);
    expect(pos['27']).toBe(pos['25']);
    // Caseta, estructuras y entrada única
    const labels = res.body.data.published.elements.filter((e) => e.kind !== 'SPACE' && e.kind !== 'ROAD').map((e) => `${e.kind}:${e.label}`);
    expect(labels.sort()).toEqual(['BLOCKED:Caseta', 'BLOCKED:Estructura', 'BLOCKED:Estructura', 'ENTRANCE:Entrada y salida']);
  });

  test('volver a correr el seed no toca el plano', async () => {
    const out = await seed({ log: () => {} });
    expect(out.mapCreated).toBe(false);
    expect((await query('SELECT count(*) AS n FROM zone_maps WHERE zone_id = $1', [zone])).rows[0].n).toBe(1);
  });
});

describe('sugerencia de puesto', () => {
  test('primero los que no piden llaves, del más cercano a la entrada al más lejano', async () => {
    expect((await suggest('ABC123')).code).toBe('1');
    const e1 = await api(op).post('/api/entries', { siteId: faca, plate: 'ABC123' });
    expect(e1.body.data.space).toMatchObject({ code: '1', requiresKeys: false });
    expect(e1.body.data.keysReceived).toBeNull();
    expect((await suggest('ABD123')).code).toBe('2');
    // 3 (distancia 10) va antes que 27 (también 10) porque 27 pide llaves
    await api(op).post('/api/entries', { siteId: faca, plate: 'ABD123' });
    expect((await suggest('ABE123')).code).toBe('3');
    await api(op).post('/api/entries', { siteId: faca, plate: 'ABE123' });
    // Luego 4 (12) y 26 (13)
    expect((await suggest('ABF123')).code).toBe('4');
    await api(op).post('/api/entries', { siteId: faca, plate: 'ABF123' });
    expect((await suggest('ABG123')).code).toBe('26');
  });

  test('las islas (piden llaves) solo cuando no quedan otros puestos de carro', async () => {
    // Se bloquean los puestos de pared y centro que quedan libres
    await query(
      `UPDATE parking_spaces SET blocked_at = now(), blocked_reason = 'Prueba'
        WHERE zone_id = $1 AND space_type = 'CAR' AND NOT requires_keys
          AND NOT EXISTS (SELECT 1 FROM entries e WHERE e.space_id = parking_spaces.id AND e.status = 'OPEN')`,
      [zone],
    );
    const s = await suggest('ISL001');
    expect(s).toMatchObject({ code: '27', requiresKeys: true });
    // Orden de las islas por cercanía: 27 (10), 31 (19), 30 (21), 28 (23), 29 (27)
    const order = [];
    for (const plate of ['ISL001', 'ISL002', 'ISL003', 'ISL004', 'ISL005']) {
      const res = await api(op).post('/api/entries', { siteId: faca, plate, keysReceived: plate === 'ISL001' });
      order.push(res.body.data.space.code);
    }
    expect(order).toEqual(['27', '31', '30', '28', '29']);
    expect(await suggest('ISL006')).toBeNull();
  });
});

describe('llaves', () => {
  test('la entrada guarda si se recibieron las llaves y quién las recibió', async () => {
    const { rows } = await query(
      "SELECT e.plate, e.keys_received, e.keys_received_by, ps.code FROM entries e JOIN parking_spaces ps ON ps.id = e.space_id WHERE e.plate LIKE 'ISL%' ORDER BY e.plate",
    );
    expect(rows[0]).toMatchObject({ plate: 'ISL001', code: '27', keys_received: true, keys_received_by: op.user.id });
    expect(rows[1]).toMatchObject({ plate: 'ISL002', keys_received: false, keys_received_by: null });
  });

  test('se pueden registrar después (auditado) y el mapa y la salida lo recuerdan', async () => {
    const id = (await query("SELECT id FROM entries WHERE plate = 'ISL002'")).rows[0].id;
    const res = await api(op).post(`/api/spaces/keys/${id}`, { received: true });
    expect(res.body.data).toEqual({ entryId: Number(id), plate: 'ISL002', keysReceived: true });
    expect(await auditCount('ENTRY_KEYS_RECORDED')).toBe(1);
    const live = (await api(op).get(`/api/maps/zones/${zone}/live`)).body.data;
    const e31 = live.elements.find((e) => e.code === '31');
    expect(e31).toMatchObject({ requiresKeys: true, entry: { plate: 'ISL002', keysReceived: true } });
    // Cotización de la salida: trae las llaves para recordar devolverlas
    const q = await api(op).get(`/api/entries/${id}/quote`);
    expect(q.body.data.entry.keysReceived).toBe(true);
    // Un puesto sin llaves no admite registrarlas
    const plain = (await query("SELECT id FROM entries WHERE plate = 'ABC123'")).rows[0].id;
    expect((await api(op).post(`/api/spaces/keys/${plain}`, { received: true })).body.code).toBe('KEYS_NOT_REQUIRED');
    expect((await api(op).post(`/api/spaces/keys/${id}`, {})).status).toBe(400);
  });

  test('mover a un puesto que pide llaves las pide; salir de él conserva el registro', async () => {
    await query("UPDATE parking_spaces SET blocked_at = NULL, blocked_reason = NULL WHERE zone_id = $1 AND code = '5'", [zone]);
    const id = (await query("SELECT id FROM entries WHERE plate = 'ISL001'")).rows[0].id;
    const moved = await api(op).post(`/api/spaces/move/${id}`, { spaceId: await spaceId('5'), reason: 'Se liberó un puesto de pared' });
    expect(moved.body.data).toMatchObject({ from: '27', to: '5', requiresKeys: false, keysReceived: true });
  });
});

describe('motos y ciclas', () => {
  test('motos y ciclas van a los puestos M (columna a la derecha del 15); un carro no', async () => {
    const live = (await api(op).get(`/api/maps/zones/${zone}/live`)).body.data;
    const ms = live.elements.filter((e) => e.code?.startsWith('M'));
    expect(ms.map((e) => [e.code, e.row, e.col, e.width, e.height])).toEqual([
      ['M1', 0, 14, 2, 1], ['M2', 1, 14, 2, 1], ['M3', 2, 14, 2, 1], ['M4', 3, 14, 2, 1], ['M5', 4, 14, 2, 1],
    ]);
    const p15 = live.elements.find((e) => e.code === '15');
    expect(p15.col + p15.width).toBe(14); // justo a la derecha del 15
    const moto = await api(op).post('/api/entries', { siteId: faca, plate: 'MOT12A' });
    expect(moto.body.data.space.code).toBe('M5'); // el más cercano a la entrada (abajo)
    const cicla = await api(op).post('/api/entries', { siteId: faca, plate: 'CICLA' });
    expect(cicla.body.data.space.code).toBe('M4');
    const car = await api(op).post('/api/entries', { siteId: faca, plate: 'CAR999', spaceId: await spaceId('M2') });
    expect(car.body.code).toBe('SPACE_TYPE_MISMATCH');
  });
});

describe('editor', () => {
  test('"pide llaves" y el sentido se editan en el plano y se publican', async () => {
    const maps = (await api(as).get(`/api/maps/zones/${zone}`)).body.data;
    const elements = maps.published.elements.map((e) => (e.code === '14' ? { ...e, requiresKeys: true, facing: 'N' } : e));
    expect((await api(as).put(`/api/maps/zones/${zone}/draft`, { rows: 32, cols: 26, elements })).status).toBe(200);
    expect((await api(as).post(`/api/maps/zones/${zone}/publish`)).body.data.published.version).toBe(2);
    const { rows } = await query("SELECT requires_keys, facing FROM parking_spaces WHERE zone_id = $1 AND code = '14'", [zone]);
    expect(rows[0]).toEqual({ requires_keys: true, facing: 'N' });
    // Un sentido inválido se descarta
    const bad = maps.published.elements.map((e) => (e.code === '15' ? { ...e, facing: 'X' } : e));
    await api(as).put(`/api/maps/zones/${zone}/draft`, { rows: 32, cols: 26, elements: bad });
    const draft = (await api(as).get(`/api/maps/zones/${zone}`)).body.data.draft;
    expect(draft.elements.find((e) => e.code === '15').facing).toBeNull();
  });
});
