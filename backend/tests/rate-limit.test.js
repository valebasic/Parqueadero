// Límite por IP: 429 en español al superar el cupo; reutilizable con otros parámetros.
const express = require('express');
const request = require('supertest');
const { createRateLimiter } = require('../src/middlewares/rateLimit');

function appWith(limiter) {
  const app = express();
  app.post('/intento', limiter, (req, res) => res.status(req.query.ok ? 200 : 401).json({ ok: !!req.query.ok }));
  return app;
}

test('a partir del intento 4 (límite 3) responde 429 con mensaje y código', async () => {
  const app = appWith(createRateLimiter({ limit: 3, windowMs: 15 * 60 * 1000 }));
  for (let i = 0; i < 3; i += 1) expect((await request(app).post('/intento')).status).toBe(401);
  const res = await request(app).post('/intento');
  expect(res.status).toBe(429);
  expect(res.body).toMatchObject({ ok: false, code: 'RATE_LIMITED' });
  expect(res.body.error).toMatch(/Intente de nuevo en 15 minutos/);
  expect(res.body.details.retryAfterSeconds).toBeGreaterThan(800);
  expect(res.headers.ratelimit).toBeDefined();
});

test('con skipSuccessfulRequests solo cuentan los fallos (útil para el portal del cliente)', async () => {
  const app = appWith(createRateLimiter({ limit: 2, windowMs: 60000, skipSuccessfulRequests: true }));
  for (let i = 0; i < 5; i += 1) expect((await request(app).post('/intento?ok=1')).status).toBe(200);
  await request(app).post('/intento');
  await request(app).post('/intento');
  expect((await request(app).post('/intento')).status).toBe(429);
});

test('el login real usa el limitador (20 por defecto, configurable)', () => {
  const routes = require('../src/routes/auth.routes');
  const login = routes.stack.find((l) => l.route?.path === '/login');
  expect(login.route.stack.length).toBe(2); // limitador + controlador
});
