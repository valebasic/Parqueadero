// Si PostgreSQL no responde, la API contesta 503 con un mensaje claro (sin necesitar una base real).
jest.mock('../src/db/pool', () => {
  const refused = async () => {
    const err = new Error('connect ECONNREFUSED 127.0.0.1:5432');
    err.code = 'ECONNREFUSED';
    throw err;
  };
  return { query: refused, withTransaction: refused, getPool: refused, closePool: async () => {} };
});

const request = require('supertest');
const { createApp } = require('../src/app');

test('POST /api/auth/login responde 503 si la base de datos no está disponible', async () => {
  const res = await request(createApp()).post('/api/auth/login').send({ username: 'x', password: 'y' });
  expect(res.status).toBe(503);
  expect(res.body).toEqual({ ok: false, error: 'Base de datos no disponible', code: 'DB_UNAVAILABLE' });
});
