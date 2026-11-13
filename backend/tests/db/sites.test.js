// GET /api/sites y /api/sites/:siteId: autenticación y autorización por sede.
const request = require('supertest');
const { closePool } = require('../../src/db/pool');
const { app, freshDatabase, createSite, siteIdByCode, createUser, loginAs, auditCount } = require('./helpers');

let faca;
let other;
let ag;
let as;
let op;

beforeAll(async () => {
  await freshDatabase();
  faca = await siteIdByCode('FACA');
  other = await createSite('OTRA', 'Otra sede');
  await createUser({ username: 'admin.faca', role: 'AS', siteIds: [faca] });
  await createUser({ username: 'op.faca', role: 'OP', siteIds: [faca] });
  ag = await loginAs('Felipe', process.env.SEED_ADMIN_PASSWORD);
  as = await loginAs('admin.faca');
  op = await loginAs('op.faca');
});

afterAll(closePool);

describe('GET /api/sites', () => {
  test('sin sesión → 401', async () => {
    const res = await request(app).get('/api/sites');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('AUTH_REQUIRED');
  });

  test('el AG ve todas las sedes con sus zonas', async () => {
    const res = await request(app).get('/api/sites').set(...ag.auth);
    expect(res.status).toBe(200);
    expect(res.body.data.map((s) => s.code)).toEqual(['FACA', 'OTRA']);
    expect(res.body.data[0]).toMatchObject({
      name: 'Facaparking',
      city: 'Facatativá',
      zones: [{ name: 'Principal', capacity: 100, isActive: true }],
    });
  });

  test.each([
    ['AS', () => as],
    ['OP', () => op],
  ])('el %s solo ve sus sedes', async (_role, session) => {
    const res = await request(app).get('/api/sites').set(...session().auth);
    expect(res.status).toBe(200);
    expect(res.body.data.map((s) => s.code)).toEqual(['FACA']);
  });
});

describe('GET /api/sites/:siteId', () => {
  test('el AG abre cualquier sede', async () => {
    const res = await request(app).get(`/api/sites/${other}`).set(...ag.auth);
    expect(res.status).toBe(200);
    expect(res.body.data.code).toBe('OTRA');
  });

  test('el OP abre su sede', async () => {
    const res = await request(app).get(`/api/sites/${faca}`).set(...op.auth);
    expect(res.status).toBe(200);
  });

  test.each([
    ['AS', () => as],
    ['OP', () => op],
  ])('el %s recibe 403 en una sede ajena y queda auditado', async (_role, session) => {
    const s = session();
    const before = await auditCount('ACCESS_DENIED', { userId: s.user.id });
    const res = await request(app).get(`/api/sites/${other}`).set(...s.auth);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN_SITE');
    expect(await auditCount('ACCESS_DENIED', { userId: s.user.id })).toBe(before + 1);
  });

  test('sede inexistente → 404 para el AG', async () => {
    const res = await request(app).get('/api/sites/9999').set(...ag.auth);
    expect(res.status).toBe(404);
  });

  test('identificador inválido → 400', async () => {
    const res = await request(app).get('/api/sites/abc').set(...ag.auth);
    expect(res.status).toBe(400);
  });
});
