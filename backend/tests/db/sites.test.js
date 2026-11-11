const request = require('supertest');
const { createApp } = require('../../src/app');
const { closePool } = require('../../src/db/pool');

afterAll(closePool);

describe('GET /api/sites', () => {
  test('lista la sede del seed con su zona', async () => {
    const res = await request(createApp()).get('/api/sites');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).toMatchObject({
      code: 'FACA',
      name: 'Facaparking',
      city: 'Facatativá',
      receiptPrefix: 'FA',
      isActive: true,
      zones: [{ name: 'Principal', capacity: 100, isActive: true }],
    });
  });
});
