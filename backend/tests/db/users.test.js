// CRUD de usuarios por rol y por sede (RF05-RF06).
const request = require('supertest');
const { query, closePool } = require('../../src/db/pool');
const { app, freshDatabase, createSite, siteIdByCode, createUser, login, loginAs, auditCount } = require('./helpers');

let faca;
let other;
let ag;
let asFaca;
let op;
let opFacaId;
let opOtherId;
let opBothId;

const newUser = (overrides = {}) => ({
  username: `u${Math.random().toString(36).slice(2, 9)}`,
  fullName: 'Persona de Prueba',
  password: 'ClaveSegura1',
  role: 'OP',
  siteIds: [faca],
  ...overrides,
});

beforeAll(async () => {
  await freshDatabase();
  faca = await siteIdByCode('FACA');
  other = await createSite('OTRA', 'Otra sede');
  await createUser({ username: 'as.faca', role: 'AS', siteIds: [faca] });
  await createUser({ username: 'op.faca', role: 'OP', siteIds: [faca] });
  opFacaId = (await query("SELECT id FROM users WHERE username = 'op.faca'")).rows[0].id;
  opOtherId = await createUser({ username: 'op.otra', role: 'OP', siteIds: [other] });
  opBothId = await createUser({ username: 'op.ambas', role: 'OP', siteIds: [faca, other] });
  await createUser({ username: 'as.otra', role: 'AS', siteIds: [other] });
  ag = await loginAs('Felipe', process.env.SEED_ADMIN_PASSWORD);
  asFaca = await loginAs('as.faca');
  op = await loginAs('op.faca');
});

afterAll(closePool);

describe('acceso por rol', () => {
  test('sin sesión → 401', async () => {
    expect((await request(app).get('/api/users')).status).toBe(401);
  });

  test.each([
    ['GET', '/api/users'],
    ['POST', '/api/users'],
    ['GET', '/api/users/1'],
    ['PATCH', '/api/users/1'],
  ])('el OP recibe 403 en %s %s', async (method, path) => {
    const res = await request(app)[method.toLowerCase()](path).set(...op.auth).send({});
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN_ROLE');
  });

  test('el 403 queda auditado como ACCESS_DENIED', async () => {
    const before = await auditCount('ACCESS_DENIED', { userId: op.user.id });
    await request(app).get('/api/users').set(...op.auth);
    expect(await auditCount('ACCESS_DENIED', { userId: op.user.id })).toBe(before + 1);
  });
});

describe('listar', () => {
  test('el AG ve a todos', async () => {
    const res = await request(app).get('/api/users').set(...ag.auth);
    expect(res.status).toBe(200);
    expect(res.body.data.map((u) => u.username)).toEqual(
      expect.arrayContaining(['Felipe', 'as.faca', 'as.otra', 'op.faca', 'op.otra', 'op.ambas']),
    );
    expect(res.body.data[0]).not.toHaveProperty('passwordHash');
  });

  test('el AS solo ve operadores de sus sedes', async () => {
    const res = await request(app).get('/api/users').set(...asFaca.auth);
    expect(res.status).toBe(200);
    expect(res.body.data.map((u) => u.username).sort()).toEqual(['op.ambas', 'op.faca']);
  });

  test('el AS recibe 403 al abrir un operador de otra sede o a otro AS', async () => {
    expect((await request(app).get(`/api/users/${opOtherId}`).set(...asFaca.auth)).status).toBe(403);
    const asOtraId = (await query("SELECT id FROM users WHERE username = 'as.otra'")).rows[0].id;
    expect((await request(app).get(`/api/users/${asOtraId}`).set(...asFaca.auth)).status).toBe(403);
  });

  test('usuario inexistente → 404', async () => {
    expect((await request(app).get('/api/users/99999').set(...ag.auth)).status).toBe(404);
  });
});

describe('crear', () => {
  test('el AG crea un AS con contraseña bcrypt costo 12 y queda auditado', async () => {
    const body = newUser({ role: 'AS' });
    const res = await request(app).post('/api/users').set(...ag.auth).send(body);
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ username: body.username, role: 'AS', isActive: true });
    expect(res.body.data.sites.map((s) => s.id)).toEqual([faca]);
    const { rows } = await query('SELECT password_hash FROM users WHERE id = $1', [res.body.data.id]);
    expect(rows[0].password_hash).toMatch(/^\$2[aby]\$12\$/);
    expect(await auditCount('USER_CREATED', { entityId: res.body.data.id })).toBe(1);
    // El usuario nuevo puede iniciar sesión
    expect((await login(body.username, body.password)).status).toBe(200);
  });

  test('el AG crea otro AG (sin sedes)', async () => {
    const res = await request(app).post('/api/users').set(...ag.auth).send(newUser({ role: 'AG', siteIds: [] }));
    expect(res.status).toBe(201);
  });

  test('el AS crea un operador en su sede', async () => {
    const res = await request(app).post('/api/users').set(...asFaca.auth).send(newUser());
    expect(res.status).toBe(201);
  });

  test('el AS no puede crear operadores en otra sede (403)', async () => {
    const res = await request(app).post('/api/users').set(...asFaca.auth).send(newUser({ siteIds: [other] }));
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN_SITE');
  });

  test.each(['AS', 'AG'])('el AS no puede crear un %s (403)', async (role) => {
    const res = await request(app)
      .post('/api/users')
      .set(...asFaca.auth)
      .send(newUser({ role, siteIds: role === 'AG' ? [] : [faca] }));
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN_ROLE');
  });

  test('usuario repetido (sin distinguir mayúsculas) → 409', async () => {
    const res = await request(app).post('/api/users').set(...ag.auth).send(newUser({ username: 'OP.FACA' }));
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('USERNAME_TAKEN');
  });

  test.each([
    ['contraseña corta', { password: 'abc12' }],
    ['contraseña sin números', { password: 'soloLetrasAqui' }],
    ['usuario con espacios', { username: 'con espacio' }],
    ['rol inválido', { role: 'XX' }],
    ['AS u OP sin sedes', { siteIds: [] }],
    ['AG con sedes', { role: 'AG' }],
    ['sede inexistente', { siteIds: [9999] }],
  ])('validación: %s → 400', async (_name, overrides) => {
    const res = await request(app).post('/api/users').set(...ag.auth).send(newUser(overrides));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });
});

describe('editar', () => {
  test('el AS cambia el nombre de un operador de su sede', async () => {
    const res = await request(app)
      .patch(`/api/users/${opFacaId}`)
      .set(...asFaca.auth)
      .send({ fullName: 'Operador Renombrado' });
    expect(res.status).toBe(200);
    expect(res.body.data.fullName).toBe('Operador Renombrado');
    expect(await auditCount('USER_UPDATED', { entityId: opFacaId })).toBe(1);
  });

  test('el AS no puede editar un operador de otra sede (403)', async () => {
    const res = await request(app).patch(`/api/users/${opOtherId}`).set(...asFaca.auth).send({ fullName: 'Nombre Nuevo' });
    expect(res.status).toBe(403);
  });

  test('el AS no puede ascender un operador a AS (403)', async () => {
    const res = await request(app).patch(`/api/users/${opFacaId}`).set(...asFaca.auth).send({ role: 'AS' });
    expect(res.status).toBe(403);
  });

  test('el AS no toca las sedes ajenas de un operador compartido', async () => {
    // op.ambas trabaja en FACA y OTRA; as.faca le "quita" todo y le deja FACA: OTRA se conserva
    const res = await request(app).patch(`/api/users/${opBothId}`).set(...asFaca.auth).send({ siteIds: [faca] });
    expect(res.status).toBe(200);
    expect(res.body.data.sites.map((s) => s.id).sort()).toEqual([faca, other].sort());
  });

  test('el AS no puede asignar una sede ajena (403)', async () => {
    const res = await request(app).patch(`/api/users/${opFacaId}`).set(...asFaca.auth).send({ siteIds: [faca, other] });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN_SITE');
  });

  test('restablecer contraseña: desbloquea, cierra sus sesiones y se audita', async () => {
    const id = await createUser({ username: 'op.reset', role: 'OP', siteIds: [faca] });
    const s = await loginAs('op.reset');
    await query("UPDATE users SET locked_until = now() + interval '5 minutes' WHERE id = $1", [id]);

    const res = await request(app).patch(`/api/users/${id}`).set(...asFaca.auth).send({ password: 'Restablecida9' });
    expect(res.status).toBe(200);
    expect(res.body.data.isLocked).toBe(false);
    expect((await request(app).get('/api/auth/me').set(...s.auth)).status).toBe(401);
    expect((await login('op.reset', 'Restablecida9')).status).toBe(200);
    expect(await auditCount('USER_PASSWORD_RESET', { entityId: id })).toBe(1);
  });

  test('desactivar: cierra sus sesiones, impide el login y se audita; reactivar lo permite', async () => {
    const id = await createUser({ username: 'op.baja', role: 'OP', siteIds: [faca] });
    const s = await loginAs('op.baja');

    const off = await request(app).patch(`/api/users/${id}`).set(...ag.auth).send({ isActive: false });
    expect(off.status).toBe(200);
    expect(off.body.data.isActive).toBe(false);
    expect((await request(app).get('/api/auth/me').set(...s.auth)).status).toBe(401);
    expect((await login('op.baja')).status).toBe(403);
    expect(await auditCount('USER_DEACTIVATED', { entityId: id })).toBe(1);

    const on = await request(app).patch(`/api/users/${id}`).set(...ag.auth).send({ isActive: true });
    expect(on.status).toBe(200);
    expect((await login('op.baja')).status).toBe(200);
    expect(await auditCount('USER_ACTIVATED', { entityId: id })).toBe(1);
  });

  test('campos no permitidos → 400', async () => {
    const res = await request(app).patch(`/api/users/${opFacaId}`).set(...ag.auth).send({ username: 'otro' });
    expect(res.status).toBe(400);
  });
});

describe('reglas de protección', () => {
  test('nadie se desactiva a sí mismo (409)', async () => {
    const res = await request(app).patch(`/api/users/${ag.user.id}`).set(...ag.auth).send({ isActive: false });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('SELF_DEACTIVATION');
  });

  test('nadie cambia su propio rol (409)', async () => {
    const res = await request(app)
      .patch(`/api/users/${ag.user.id}`)
      .set(...ag.auth)
      .send({ role: 'AS', siteIds: [faca] });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('SELF_ROLE_CHANGE');
  });

  describe('último AG', () => {
    let secondAgId;

    beforeAll(async () => {
      // Deja a Felipe como único AG activo y agrega un segundo AG
      await query("UPDATE users SET is_active = false WHERE role = 'AG' AND username <> 'Felipe'");
      secondAgId = await createUser({ username: 'ag.segundo', role: 'AG' });
    });

    test('al último AG activo no se le puede desactivar ni quitar el rol (409 LAST_ADMIN)', async () => {
      // Por la API el último AG solo podría intentarlo sobre sí mismo (lo frena SELF_*). La regla
      // protege sobre todo frente a carreras; aquí se prueba en el servicio con otro AG como actor
      // (Felipe), habiendo dejado a ag.segundo como el único activo.
      await query("UPDATE users SET is_active = false WHERE username = 'Felipe'");
      try {
        const usersService = require('../../src/services/users.service');
        const fakeReq = {
          user: { id: ag.user.id, role: 'AG', siteIds: [] },
          ip: '127.0.0.1',
          get: () => 'jest',
          method: 'PATCH',
          originalUrl: `/api/users/${secondAgId}`,
        };
        await expect(usersService.updateUser(fakeReq, String(secondAgId), { isActive: false })).rejects.toMatchObject({
          status: 409,
          code: 'LAST_ADMIN',
        });
        await expect(
          usersService.updateUser(fakeReq, String(secondAgId), { role: 'AS', siteIds: [faca] }),
        ).rejects.toMatchObject({ status: 409, code: 'LAST_ADMIN' });
      } finally {
        await query("UPDATE users SET is_active = true WHERE username = 'Felipe'");
      }
    });

    test('dos AG que se desactivan al mismo tiempo: solo uno lo logra y siempre queda un AG', async () => {
      const felipe = await loginAs('Felipe', process.env.SEED_ADMIN_PASSWORD);
      const second = await loginAs('ag.segundo');
      const results = await Promise.all([
        request(app).patch(`/api/users/${secondAgId}`).set(...felipe.auth).send({ isActive: false }),
        request(app).patch(`/api/users/${felipe.user.id}`).set(...second.auth).send({ isActive: false }),
      ]);
      const statuses = results.map((r) => r.status).sort();
      expect(statuses.filter((s) => s === 200)).toHaveLength(1);
      expect(statuses.some((s) => s >= 500)).toBe(false);
      const { rows } = await query("SELECT count(*) AS n FROM users WHERE role = 'AG' AND is_active");
      expect(rows[0].n).toBe(1);
    });
  });
});
