const request = require('supertest');
const { createApp } = require('../src/app');

describe('GET /api/health', () => {
  const app = createApp();

  test('responde 200 con {ok:true}', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  test('una ruta inexistente responde 404 en JSON', async () => {
    const res = await request(app).get('/api/no-existe');
    expect(res.status).toBe(404);
    expect(res.body.ok).toBe(false);
  });

  test('un JSON mal formado responde 400, no 500', async () => {
    const res = await request(app)
      .post('/api/health')
      .set('Content-Type', 'application/json')
      .send('{malo');
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
  });
});
