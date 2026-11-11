// Si PostgreSQL no responde, la API contesta 503 con un mensaje claro (sin necesitar una base real).
jest.mock('../src/services/sites.service', () => ({
  listSitesWithZones: jest.fn(async () => {
    const err = new Error('connect ECONNREFUSED 127.0.0.1:5432');
    err.code = 'ECONNREFUSED';
    throw err;
  }),
}));

const request = require('supertest');
const { createApp } = require('../src/app');

test('GET /api/sites responde 503 si la base de datos no está disponible', async () => {
  const res = await request(createApp()).get('/api/sites');
  expect(res.status).toBe(503);
  expect(res.body).toEqual({ ok: false, error: 'Base de datos no disponible' });
});
