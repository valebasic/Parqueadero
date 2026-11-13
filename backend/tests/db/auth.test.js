// Login, bloqueo, sesiones, inactividad, logout y cambio de contraseña (RF01-RF04).
const request = require('supertest');
const { query, closePool } = require('../../src/db/pool');
const { app, DEFAULT_PASSWORD, freshDatabase, siteIdByCode, createUser, login, loginAs, auditCount } =
  require('./helpers');

let faca;

beforeAll(async () => {
  await freshDatabase();
  faca = await siteIdByCode('FACA');
});

afterAll(closePool);

// Simula que la sesión lleva `minutes` minutos sin actividad
async function ageSession(token, minutes) {
  const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
  await query(
    `UPDATE user_sessions SET last_activity_at = now() - make_interval(mins => $2) WHERE id = $1`,
    [payload.sid, minutes],
  );
}

describe('POST /api/auth/login', () => {
  beforeAll(async () => {
    await createUser({ username: 'op.login', role: 'OP', siteIds: [faca] });
  });

  test('credenciales correctas → token, cookie httpOnly, perfil y auditoría', async () => {
    const res = await login('op.login');
    expect(res.status).toBe(200);
    expect(res.body.data.accessToken).toEqual(expect.any(String));
    expect(res.body.data.user).toMatchObject({ username: 'op.login', role: 'OP', allSites: false });
    expect(res.body.data.user.sites.map((s) => s.code)).toEqual(['FACA']);
    expect(res.body.data.session.idleTimeoutSeconds).toBe(15 * 60);
    const cookie = res.headers['set-cookie'].find((c) => c.startsWith('nexo_rt='));
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Strict/);
    expect(cookie).toMatch(/Path=\/api\/auth/);
    expect(await auditCount('LOGIN_SUCCESS', { entityId: res.body.data.user.id })).toBe(1);
  });

  test('no distingue mayúsculas en el usuario', async () => {
    const res = await login('OP.LOGIN');
    expect(res.status).toBe(200);
  });

  test('administradores: 30 min de inactividad', async () => {
    const res = await login('Felipe', process.env.SEED_ADMIN_PASSWORD);
    expect(res.status).toBe(200);
    expect(res.body.data.session.idleTimeoutSeconds).toBe(30 * 60);
    expect(res.body.data.user.allSites).toBe(true);
  });

  test('contraseña incorrecta → 401 y auditoría LOGIN_FAILED', async () => {
    const userId = (await query("SELECT id FROM users WHERE username = 'op.login'")).rows[0].id;
    const before = await auditCount('LOGIN_FAILED', { entityId: userId });
    const res = await login('op.login', 'otraClave99');
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: 'INVALID_CREDENTIALS', error: 'Usuario o contraseña incorrectos' });
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(await auditCount('LOGIN_FAILED', { entityId: userId })).toBe(before + 1);
    await login('op.login'); // deja el contador en cero para las demás pruebas
  });

  test('usuario inexistente → el mismo 401 (no revela si existe) y queda auditado', async () => {
    const before = await auditCount('LOGIN_FAILED');
    const res = await login('no.existe', 'loQueSea123');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Usuario o contraseña incorrectos');
    expect(await auditCount('LOGIN_FAILED')).toBe(before + 1);
  });

  test('datos incompletos → 400', async () => {
    const res = await request(app).post('/api/auth/login').send({ username: 'op.login' });
    expect(res.status).toBe(400);
  });

  test('usuario desactivado con la contraseña correcta → 403', async () => {
    await createUser({ username: 'op.inactivo', role: 'OP', siteIds: [faca], isActive: false });
    const res = await login('op.inactivo');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('USER_INACTIVE');
  });
});

describe('bloqueo tras 5 intentos fallidos', () => {
  let userId;

  beforeAll(async () => {
    userId = await createUser({ username: 'op.bloqueo', role: 'OP', siteIds: [faca] });
  });

  test('los intentos 1 a 4 responden 401; el 5.º bloquea la cuenta 5 minutos', async () => {
    for (let i = 1; i <= 4; i += 1) {
      const res = await login('op.bloqueo', `mala${i}clave`);
      expect(res.status).toBe(401);
    }
    const fifth = await login('op.bloqueo', 'mala5clave');
    expect(fifth.status).toBe(423);
    expect(fifth.body.code).toBe('ACCOUNT_LOCKED');
    expect(fifth.body.details.retryAfterSeconds).toBe(300);
    expect(await auditCount('ACCOUNT_LOCKED', { entityId: userId })).toBe(1);

    const { rows } = await query(
      "SELECT round(extract(epoch FROM locked_until - now()) / 60) AS minutes FROM users WHERE id = $1",
      [userId],
    );
    expect(Number(rows[0].minutes)).toBe(5);
  });

  test('bloqueada, ni la contraseña correcta entra (y se audita)', async () => {
    const res = await login('op.bloqueo');
    expect(res.status).toBe(423);
    expect(res.body.error).toMatch(/Intente de nuevo en 5 minutos/);
    expect(await auditCount('LOGIN_BLOCKED', { entityId: userId })).toBe(1);
  });

  test('pasados los 5 minutos vuelve a entrar y el contador queda en cero', async () => {
    await query("UPDATE users SET locked_until = now() - interval '1 second' WHERE id = $1", [userId]);
    const res = await login('op.bloqueo');
    expect(res.status).toBe(200);
    const { rows } = await query('SELECT failed_login_count, locked_until FROM users WHERE id = $1', [userId]);
    expect(rows[0]).toEqual({ failed_login_count: 0, locked_until: null });
  });

  test('un login correcto reinicia el contador de fallos', async () => {
    for (let i = 1; i <= 4; i += 1) await login('op.bloqueo', `mala${i}clave`);
    expect((await login('op.bloqueo')).status).toBe(200);
    expect((await login('op.bloqueo', 'otra1mala')).status).toBe(401); // 1.er fallo, no 5.º
  });
});

describe('sesión: acceso, renovación e inactividad', () => {
  beforeAll(async () => {
    await createUser({ username: 'op.sesion', role: 'OP', siteIds: [faca] });
    await createUser({ username: 'as.sesion', role: 'AS', siteIds: [faca] });
  });

  test('GET /api/auth/me con token → perfil', async () => {
    const s = await loginAs('op.sesion');
    const res = await request(app).get('/api/auth/me').set(...s.auth);
    expect(res.status).toBe(200);
    expect(res.body.data.user.username).toBe('op.sesion');
  });

  test('token inválido → 401 TOKEN_INVALID', async () => {
    const res = await request(app).get('/api/auth/me').set('Authorization', 'Bearer abc.def.ghi');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('TOKEN_INVALID');
  });

  test('refresh con la cookie entrega un token nuevo', async () => {
    const s = await loginAs('op.sesion');
    const res = await request(app).post('/api/auth/refresh').set('Cookie', s.cookie);
    expect(res.status).toBe(200);
    expect(res.body.data.accessToken).toEqual(expect.any(String));
    expect(res.body.data.user.username).toBe('op.sesion');
  });

  test('refresh sin cookie → 401', async () => {
    const res = await request(app).post('/api/auth/refresh');
    expect(res.status).toBe(401);
  });

  test('OP: con 14 min de inactividad la sesión sigue; la actividad la renueva', async () => {
    const s = await loginAs('op.sesion');
    await ageSession(s.token, 14);
    expect((await request(app).get('/api/auth/me').set(...s.auth)).status).toBe(200);
    // La petición anterior contó como actividad: 14 min más tampoco la cierran
    await ageSession(s.token, 14);
    expect((await request(app).get('/api/auth/me').set(...s.auth)).status).toBe(200);
  });

  test('OP: con 16 min de inactividad se cierra (401 SESSION_IDLE), se revoca y se audita', async () => {
    const s = await loginAs('op.sesion');
    await ageSession(s.token, 16);
    const res = await request(app).get('/api/auth/me').set(...s.auth);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('SESSION_IDLE');
    // Ni el refresh la revive
    const refreshed = await request(app).post('/api/auth/refresh').set('Cookie', s.cookie);
    expect(refreshed.status).toBe(401);
    expect(await auditCount('SESSION_IDLE_TIMEOUT', { userId: s.user.id })).toBeGreaterThanOrEqual(1);
  });

  test('OP: el refresh tampoco renueva una sesión inactiva por más de 15 min', async () => {
    const s = await loginAs('op.sesion');
    await ageSession(s.token, 16);
    const res = await request(app).post('/api/auth/refresh').set('Cookie', s.cookie);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('SESSION_IDLE');
  });

  test('AS: 16 min de inactividad no la cierran; 31 sí', async () => {
    const s = await loginAs('as.sesion');
    await ageSession(s.token, 16);
    expect((await request(app).get('/api/auth/me').set(...s.auth)).status).toBe(200);
    await ageSession(s.token, 31);
    expect((await request(app).get('/api/auth/me').set(...s.auth)).status).toBe(401);
  });

  test('las peticiones en segundo plano no cuentan como actividad', async () => {
    const s = await loginAs('op.sesion');
    await ageSession(s.token, 14);
    const bg = await request(app).get('/api/auth/me').set(...s.auth).set('X-Nexo-Background', '1');
    expect(bg.status).toBe(200);
    const { rows } = await query(
      'SELECT extract(epoch FROM now() - last_activity_at) / 60 AS idle FROM user_sessions WHERE id = $1',
      [JSON.parse(Buffer.from(s.token.split('.')[1], 'base64url').toString()).sid],
    );
    expect(Number(rows[0].idle)).toBeGreaterThan(13);
  });

  test('logout revoca la sesión: el token deja de servir y queda auditado', async () => {
    const s = await loginAs('op.sesion');
    const res = await request(app).post('/api/auth/logout').set('Cookie', s.cookie);
    expect(res.status).toBe(200);
    expect((await request(app).get('/api/auth/me').set(...s.auth)).status).toBe(401);
    expect((await request(app).post('/api/auth/refresh').set('Cookie', s.cookie)).status).toBe(401);
    expect(await auditCount('LOGOUT', { userId: s.user.id })).toBeGreaterThanOrEqual(1);
  });

  test('si desactivan al usuario, su sesión abierta deja de servir', async () => {
    const id = await createUser({ username: 'op.desact', role: 'OP', siteIds: [faca] });
    const s = await loginAs('op.desact');
    await query('UPDATE users SET is_active = false WHERE id = $1', [id]);
    const res = await request(app).get('/api/auth/me').set(...s.auth);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('USER_INACTIVE');
  });
});

describe('PUT /api/auth/password (contraseña propia)', () => {
  test('cambia la contraseña, cierra las otras sesiones y audita', async () => {
    await createUser({ username: 'op.clave', role: 'OP', siteIds: [faca] });
    const other = await loginAs('op.clave');
    const current = await loginAs('op.clave');

    const res = await request(app)
      .put('/api/auth/password')
      .set(...current.auth)
      .send({ currentPassword: DEFAULT_PASSWORD, newPassword: 'NuevaClave2026' });
    expect(res.status).toBe(200);

    expect((await request(app).get('/api/auth/me').set(...current.auth)).status).toBe(200);
    expect((await request(app).get('/api/auth/me').set(...other.auth)).status).toBe(401);
    expect((await login('op.clave')).status).toBe(401);
    expect((await login('op.clave', 'NuevaClave2026')).status).toBe(200);
    expect(await auditCount('PASSWORD_CHANGED', { userId: current.user.id })).toBe(1);
  });

  test('rechaza si la contraseña actual no coincide o la nueva es débil', async () => {
    await createUser({ username: 'op.clave2', role: 'OP', siteIds: [faca] });
    const s = await loginAs('op.clave2');
    const wrong = await request(app)
      .put('/api/auth/password')
      .set(...s.auth)
      .send({ currentPassword: 'equivocada1', newPassword: 'NuevaClave2026' });
    expect(wrong.status).toBe(400);
    const weak = await request(app)
      .put('/api/auth/password')
      .set(...s.auth)
      .send({ currentPassword: DEFAULT_PASSWORD, newPassword: 'corta' });
    expect(weak.status).toBe(400);
  });
});
