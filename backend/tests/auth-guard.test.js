// Protección de rutas sin base de datos: sin token, con token inválido o vencido → 401
// antes de tocar PostgreSQL. Si se agrega una ruta nueva, debe aparecer aquí.
const jwt = require('jsonwebtoken');
const request = require('supertest');
const { createApp } = require('../src/app');
const { signAccessToken } = require('../src/services/token.service');
const { canAccessSite } = require('../src/middlewares/authorize');
const { passwordPolicyError } = require('../src/services/password.service');
const { idleTimeoutSecondsFor } = require('../src/config/security');

const app = createApp();

const PROTECTED_ROUTES = [
  ['get', '/api/sites'],
  ['get', '/api/sites/1'],
  ['get', '/api/users'],
  ['post', '/api/users'],
  ['get', '/api/users/1'],
  ['patch', '/api/users/1'],
  ['get', '/api/auth/me'],
  ['put', '/api/auth/password'],
];

describe('todas las rutas protegidas exigen sesión', () => {
  test.each(PROTECTED_ROUTES)('%s %s sin token → 401', async (method, path) => {
    const res = await request(app)[method](path).send({});
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('AUTH_REQUIRED');
  });

  test.each(PROTECTED_ROUTES)('%s %s con token mal firmado → 401', async (method, path) => {
    const forged = jwt.sign({ sid: '00000000-0000-0000-0000-000000000000' }, 'otro-secreto', {
      subject: '1',
      issuer: 'nexo-api',
      audience: 'nexo-web',
    });
    const res = await request(app)[method](path).set('Authorization', `Bearer ${forged}`).send({});
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('TOKEN_INVALID');
  });

  test('token vencido → 401 TOKEN_EXPIRED', async () => {
    const expired = jwt.sign({ sid: 'x', exp: Math.floor(Date.now() / 1000) - 10 }, process.env.JWT_SECRET, {
      subject: '1',
      issuer: 'nexo-api',
      audience: 'nexo-web',
    });
    const res = await request(app).get('/api/sites').set('Authorization', `Bearer ${expired}`);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('TOKEN_EXPIRED');
  });

  test('rechaza el algoritmo "none"', async () => {
    const valid = signAccessToken({ userId: 1, sessionId: 'x' });
    const [, payload] = valid.split('.');
    const unsigned = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${payload}.`;
    const res = await request(app).get('/api/sites').set('Authorization', `Bearer ${unsigned}`);
    expect(res.status).toBe(401);
  });
});

describe('reglas puras', () => {
  test('acceso por sede', () => {
    expect(canAccessSite({ role: 'AG', siteIds: [] }, 7)).toBe(true);
    expect(canAccessSite({ role: 'AS', siteIds: [1, 2] }, 2)).toBe(true);
    expect(canAccessSite({ role: 'OP', siteIds: [1] }, '1')).toBe(true);
    expect(canAccessSite({ role: 'OP', siteIds: [1] }, 3)).toBe(false);
    expect(canAccessSite(null, 1)).toBe(false);
  });

  test('inactividad: 15 min operador, 30 min administradores', () => {
    expect(idleTimeoutSecondsFor('OP')).toBe(900);
    expect(idleTimeoutSecondsFor('AS')).toBe(1800);
    expect(idleTimeoutSecondsFor('AG')).toBe(1800);
  });

  test.each([
    ['Clave2026', null],
    ['corta1', 'al menos 8'],
    ['soloLetras', 'letras y números'],
    ['12345678', 'letras y números'],
    [undefined, 'al menos 8'],
  ])('política de contraseña: %p', (password, expected) => {
    const error = passwordPolicyError(password);
    if (expected === null) expect(error).toBeNull();
    else expect(error).toMatch(expected);
  });
});
