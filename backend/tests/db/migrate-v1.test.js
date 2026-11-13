// Migración de datos de la v1.0 (Fase 7): simulación, importación completa, idempotencia, contraseñas
// heredadas y reversión total cuando los totales no cuadran. Usa tests/fixtures/v1-export.json
// (generado por tests/fixtures/build-v1-export.js con la forma real de los datos de la v1.0).
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const request = require('supertest');
const { query, closePool } = require('../../src/db/pool');
const { parseExport } = require('../../src/migration/v1/source');
const { runImport } = require('../../src/migration/v1/importer');
const { app, freshDatabase, siteIdByCode, auditCount } = require('./helpers');

const FIXTURE = path.join(__dirname, '../fixtures/v1-export.json');
const raw = fs.readFileSync(FIXTURE, 'utf8');
let site;

const parsed = () => parseExport(raw);
const one = async (sql, params = []) => (await query(sql, params)).rows[0];
const count = async (sql, params = []) => Number((await one(sql, params)).n);
const login = (username, password) => request(app).post('/api/auth/login').send({ username, password });

// Estado de la base que la migración podría tocar
async function snapshot() {
  return {
    users: await count('SELECT count(*) AS n FROM users'),
    entries: await count('SELECT count(*) AS n FROM entries'),
    sales: Number((await one("SELECT COALESCE(sum(charged_amount), 0) AS t FROM entries WHERE status = 'PAID'")).t),
    plans: await count('SELECT count(*) AS n FROM monthly_plans'),
    payments: await count('SELECT count(*) AS n FROM monthly_payments'),
    movements: await count('SELECT count(*) AS n FROM cash_movements'),
    registers: await count('SELECT count(*) AS n FROM cash_registers'),
    pending: await count('SELECT count(*) AS n FROM pending_charges'),
    rates: await count('SELECT count(*) AS n FROM rates'),
    counters: (await query('SELECT prefix, last_number FROM receipt_counters ORDER BY prefix')).rows,
    map: await count('SELECT count(*) AS n FROM v1_import_map'),
    runs: await count('SELECT count(*) AS n FROM v1_import_runs'),
    siteName: (await one('SELECT name FROM sites WHERE id = $1', [site])).name,
  };
}

beforeAll(async () => {
  await freshDatabase();
  site = await siteIdByCode('FACA');
});

afterAll(closePool);

describe('lectura del archivo', () => {
  test('acepta la exportación del botón y también un volcado plano del localStorage', () => {
    const a = parsed();
    expect(a.meta).toMatchObject({ exportedBy: 'Felipe', appVersion: '2.6.52' });
    expect(Array.isArray(a.data.fp_entries)).toBe(true);
    const flat = parseExport(JSON.stringify(JSON.parse(raw).keys));
    expect(flat.data.fp_entries).toEqual(a.data.fp_entries);
  });

  test('rechaza archivos que no son de la v1.0', () => {
    expect(() => parseExport('no es json')).toThrow('JSON válido');
    expect(() => parseExport('{"hola": 1}')).toThrow('Formato no reconocido');
    expect(() => parseExport('{"format":"nexo-v1-export","formatVersion":9,"keys":{}}')).toThrow('Versión');
  });
});

describe('--dry-run', () => {
  test('informa todo y no guarda nada', async () => {
    const before = await snapshot();
    const report = await runImport(parsed(), { dryRun: true, fileName: 'v1-export.json' });
    expect(report.outcome).toBe('DRY_RUN');
    expect(report.committed).toBe(false);
    expect(report.balanced).toBe(true);
    expect(report.categories.ventas.imported).toEqual({ count: 9, total: 49900 });
    expect(await snapshot()).toEqual(before);
  });

  test('por consola: npm run migrate:v1 -- archivo.json --dry-run', () => {
    const out = execFileSync(process.execPath, [path.join(__dirname, '../../scripts/migrate-v1.js'), FIXTURE, '--dry-run'], {
      env: { ...process.env, NODE_ENV: 'test' },
      encoding: 'utf8',
    });
    expect(out).toContain('SIMULACIÓN (--dry-run): no se guardó nada');
    expect(out).toContain('Cuadre: OK');
    expect(out).toContain('Rechazados (10)');
  });
});

describe('importación real', () => {
  let report;
  beforeAll(async () => {
    report = await runImport(parsed(), { fileName: 'v1-export.json' });
  });

  test('se aplica, cuadra y queda registrada en auditoría', async () => {
    expect(report.outcome).toBe('COMMITTED');
    expect(report.balanced).toBe(true);
    for (const c of Object.values(report.categories)) {
      expect(c.balanced).toBe(true);
      expect(c.db.after.count - c.db.before.count).toBe(c.imported.count);
      expect(c.db.after.total - c.db.before.total).toBe(c.imported.total);
    }
    expect(await count('SELECT count(*) AS n FROM v1_import_runs')).toBe(1);
    expect(await auditCount('V1_IMPORT')).toBe(1);
  });

  test('reporte: conteos y totales en COP por categoría', () => {
    const c = report.categories;
    expect(c.ventas).toMatchObject({
      v1: { count: 13, total: 67600 },
      imported: { count: 9, total: 49900 },
      skipped: { count: 1, total: 7200 },
      rejected: { count: 3, total: 10500 },
    });
    expect(c.pendientes.imported).toEqual({ count: 1, total: 4000 });
    expect(c.adentro.imported.count).toBe(1);
    expect(c.mensualidades.imported).toEqual({ count: 5, total: 560000 });
    expect(c.pagos_mensualidad.imported).toEqual({ count: 5, total: 535000 });
    expect(c.ingresos.imported).toEqual({ count: 1, total: 10000 });
    expect(c.egresos.imported).toEqual({ count: 2, total: 23000 });
    expect(c.base_mas.imported).toEqual({ count: 1, total: 20000 });
    expect(c.base_menos.imported).toEqual({ count: 1, total: 30000 });
    expect(c.cierres.imported).toEqual({ count: 2, total: 26700 });
  });

  test('rechazados con su motivo', () => {
    const reasons = Object.fromEntries(report.rejected.map((r) => [r.v1Id, r.reason]));
    expect(reasons.x).toMatch('nombre de usuario inválido');
    expect(reasons['1772548200000']).toMatch('recibo FA1006 repetido');
    expect(reasons['1772550000000']).toMatch('placa inválida');
    expect(reasons['1772625600000']).toMatch('caja que seguía ABIERTA');
    expect(reasons.E1772630000000).toMatch('caja que seguía ABIERTA');
    expect(reasons.MX1772562000000).toMatch('sin su entrada');
    expect(reasons.MP1772000000005).toMatch('recibo FM50 repetido');
    expect(reasons.M1772000000005).toMatch('mensualidad duplicada');
    expect(reasons.M1772000000006).toMatch('fecha de vencimiento inválida');
    expect(reasons.I1772460000001).toMatch('valor inválido');
    expect(report.rejected).toHaveLength(10);
  });

  test('usuarios: roles, admin por defecto desactivado, contraseñas heredadas', async () => {
    const users = (await query("SELECT username, role, is_active, password_hash, legacy_password_hash FROM users WHERE username <> 'Felipe' ORDER BY username")).rows;
    const by = Object.fromEntries(users.map((u) => [u.username, u]));
    expect(by.admin).toMatchObject({ role: 'AS', is_active: false, password_hash: null });
    expect(by['carlos.p']).toMatchObject({ role: 'OP', is_active: true, password_hash: null });
    expect(by.maria).toMatchObject({ role: 'AS', is_active: true });
    expect(by['Jose.Nunez']).toMatchObject({ role: 'OP', is_active: true });
    expect(by['carlos.p'].legacy_password_hash).toMatch(/^[0-9a-f]{32}:[0-9a-f]{64}$/);
    // El texto plano de la v1.0 no queda guardado tal cual
    expect(by.maria.legacy_password_hash).not.toContain('maria123');
    expect(by['migracion.v1']).toMatchObject({ is_active: false });
    expect(await count('SELECT count(*) AS n FROM user_sites us JOIN users u ON u.id = us.user_id WHERE u.username = $1 AND us.site_id = $2', ['carlos.p', site])).toBe(1);
  });

  test('ventas: forma de pago, mixto, descuento sin motivo, "Sin método", hora de Colombia', async () => {
    const e = Object.fromEntries((await query("SELECT * FROM entries WHERE origin = 'V1_IMPORT'")).rows.map((r) => [r.plate, r]));
    expect(e.ABC123).toMatchObject({ status: 'PAID', payment_method: 'CASH', charged_amount: 7200, receipt_prefix: 'FA', receipt_number: 1001 });
    expect(e.ABC123.entry_at.toISOString()).toBe('2026-03-02T12:10:00.000Z');
    expect(e.DEF456).toMatchObject({ payment_method: 'MIXED', cash_amount: 3000, electronic_amount: 3600 });
    expect(e.GHI789).toMatchObject({ calculated_amount: 9000, discount_amount: 2000, charged_amount: 7000 });
    expect(e.GHI789.discount_reason).toMatch('sin motivo');
    expect(e.JKL321).toMatchObject({ payment_method: 'ELECTRONIC', electronic_amount: 3300 });
    expect(e.XYZ12D).toMatchObject({ vehicle_type: 'MOTORCYCLE', payment_method: 'ELECTRONIC' });
    expect(e.CICLA.vehicle_type).toBe('BICYCLE');
    expect(e.OPN777).toMatchObject({ status: 'OPEN', exit_at: null });
    expect(e.AAA111).toMatchObject({ status: 'PAID', cash_register_id: null });
    // Pendiente por cobrar (mensualidad nocturna) y pendiente ya confirmado
    expect(e.NOC123).toMatchObject({ status: 'PENDING_CHARGE', charged_amount: 4000 });
    expect(e.NOC123.monthly_plan_id).not.toBeNull();
    const pend = await one('SELECT * FROM pending_charges WHERE entry_id = $1', [e.NOC123.id]);
    expect(pend).toMatchObject({ amount: 4000, reason: 'OUT_OF_SCHEDULE', confirmed_at: null, monthly_plan_id: e.NOC123.monthly_plan_id });
    expect(e.PEN111).toMatchObject({ status: 'PAID' });
    expect(e.PEN111.paid_at.toISOString()).toBe('2026-03-03T19:00:00.000Z');
    const confirmed = await one('SELECT * FROM pending_charges WHERE entry_id = $1', [e.PEN111.id]);
    expect(confirmed).toMatchObject({ reason: 'MANUAL', cash_register_id: e.PEN111.cash_register_id });
    expect(confirmed.confirmed_at).not.toBeNull();
  });

  test('cierres: turno y caja cerrados con el resumen de la v1.0 y sus movimientos', async () => {
    const regs = (await query('SELECT cr.*, sh.close_type, sh.closed_at AS shift_closed FROM cash_registers cr JOIN shifts sh ON sh.id = cr.shift_id ORDER BY cr.opened_at')).rows;
    expect(regs).toHaveLength(2);
    expect(regs[0]).toMatchObject({ physical_cash: 12200, expected_cash: 12200, difference: 0, initial_cash: 50000, close_type: 'CLOSE' });
    expect(regs[0].summary).toMatchObject({ source: 'v1', totalSales: 28500, cashSales: 17200, electronicSales: 11300, baseFinal: 70000 });
    expect(regs[1]).toMatchObject({ physical_cash: 14500, difference: -100, notes: 'Faltaron 100 pesos' });
    const movs = (await query('SELECT type, amount FROM cash_movements WHERE cash_register_id = $1 ORDER BY type', [regs[0].id])).rows;
    expect(movs).toEqual([
      { type: 'BASE_IN', amount: 20000 },
      { type: 'EXPENSE', amount: 15000 },
      { type: 'INCOME', amount: 10000 },
    ]);
    // Las ventas de la caja R1 quedan en su caja
    expect(Number((await one("SELECT sum(charged_amount) AS t FROM entries WHERE cash_register_id = $1 AND status = 'PAID'", [regs[0].id])).t)).toBe(28500);
    // El cierre se ve en Reportes con el resumen guardado
    const ag = await login('Felipe', process.env.SEED_ADMIN_PASSWORD);
    const detail = await request(app).get(`/api/reports/closures/${regs[0].id}`).set('Authorization', `Bearer ${ag.body.data.accessToken}`);
    expect(detail.status).toBe(200);
    expect(detail.body.data.summary.totalSales).toBe(28500);
  });

  test('mensualidades: estados, quincenal, adelantado, nocturna y la eliminada con pagos', async () => {
    const p = Object.fromEntries((await query('SELECT * FROM monthly_plans').then((r) => r.rows)).map((x) => [x.plate, x]));
    expect(p.MEN001).toMatchObject({ payment_status: 'PAID', next_period_start: '2026-04-01', next_period_end: '2026-04-30', origin: 'V1_MIGRATION', data_consent: false });
    expect(p.NOC123).toMatchObject({ schedule: 'NIGHT', night_start: '19:00:00', night_end: '07:00:00' });
    expect(p.NOC123.phones).toEqual(['3009876543', '3155550000']);
    expect(p.MIG001).toMatchObject({ payment_status: 'PENDING_CONFIRMATION', is_active: true, vehicle_type: 'MOTORCYCLE' });
    expect(p.QUI001).toMatchObject({ payment_status: 'PARTIAL', is_biweekly: true, installment_paid: 65000, installment_period_start: '2026-03-15' });
    expect(p.OLD999.deleted_at).not.toBeNull();
    const pays = Object.fromEntries((await query('SELECT * FROM monthly_payments').then((r) => r.rows)).map((x) => [x.receipt_number, x]));
    expect(pays[52]).toMatchObject({ installment_number: 1, amount: 65000 });
    expect(pays[53]).toMatchObject({ payment_method: 'MIXED', cash_amount: 60000, electronic_amount: 60000, discount_amount: 10000, base_amount: 130000, monthly_plan_id: p.OLD999.id });
    expect(pays[54]).toMatchObject({ is_advance: true, payment_method: 'ELECTRONIC' });
  });

  test('configuración: tarifas, datos del local, recibos y consecutivos', async () => {
    const moto = await one("SELECT hour_amount FROM rates WHERE site_id = $1 AND vehicle_type = 'MOTORCYCLE' AND valid_to IS NULL", [site]);
    expect(moto.hour_amount).toBe(2400);
    expect(await count("SELECT count(*) AS n FROM rates WHERE site_id = $1 AND vehicle_type = 'CAR'", [site])).toBe(1);
    const s = await one('SELECT * FROM sites WHERE id = $1', [site]);
    expect(s).toMatchObject({ legal_id: '35529806-9', receipt_prefix: 'FA', monthly_receipt_prefix: 'FM' });
    expect(s.business_hours).toContain('Lunes a Miércoles');
    expect(s.receipt_config.message).toContain('Gracias por su visita');
    expect(s.receipt_config.labels.payment).toBe('Forma de pago');
    const counters = Object.fromEntries((await query('SELECT prefix, last_number FROM receipt_counters WHERE site_id = $1', [site])).rows.map((r) => [r.prefix, r.last_number]));
    expect(counters).toEqual({ FA: 1041, FM: 56 });
    // La siguiente entrada en la v2.0 sigue el consecutivo de la v1.0
    const { nextReceiptNumber } = require('../../src/services/receipts.service');
    const { withTransaction } = require('../../src/db/pool');
    await withTransaction(async (c) => {
      expect(await nextReceiptNumber(c, site, 'FA')).toBe(1042);
      throw new Error('rollback');
    }).catch(() => {});
  });

  describe('idempotencia', () => {
    test('correrla otra vez no duplica nada (y da igual el formato del archivo)', async () => {
      const before = await snapshot();
      const again = await runImport(parsed(), { fileName: 'v1-export.json' });
      expect(again.outcome).toBe('COMMITTED');
      for (const c of Object.values(again.categories)) expect(c.imported).toEqual({ count: 0, total: 0 });
      expect(again.categories.ventas.skipped.count).toBe(10);
      const flat = await runImport(parseExport(JSON.stringify(JSON.parse(raw).keys)), { fileName: 'dump.json' });
      for (const c of Object.values(flat.categories)) expect(c.imported.count).toBe(0);
      const after = await snapshot();
      expect({ ...after, runs: before.runs }).toEqual(before);
      expect(after.runs).toBe(before.runs + 2);
    });

    test('una exportación posterior solo agrega lo nuevo', async () => {
      const data = JSON.parse(raw);
      const entries = JSON.parse(data.keys.fp_entries);
      entries.push({
        id: 1772700000000, idTarifa: '5', placa: 'NEW123', entradaFecha: '05-03-2026 08:00:00', salidaFecha: '05-03-2026 09:00:00',
        reciboPrefijo: 'FA', reciboNumero: 1040, total: 3300, subtotal: 3300, paymentMethod: 'cash', cashAmount: 3300, nequiAmount: 0,
      });
      data.keys.fp_entries = JSON.stringify(entries);
      const r = await runImport(parseExport(JSON.stringify(data)), { fileName: 'v1-export-2.json' });
      expect(r.outcome).toBe('COMMITTED');
      expect(r.categories.ventas.imported).toEqual({ count: 1, total: 3300 });
      expect(await count("SELECT count(*) AS n FROM entries WHERE plate = 'NEW123'")).toBe(1);
    });
  });

  describe('contraseñas de la v1.0', () => {
    test('primer login correcto: verifica SHA-256+salt, re-hashea con bcrypt y borra el legacy', async () => {
      const before = await auditCount('PASSWORD_REHASHED');
      const res = await login('carlos.p', 'Turno2025');
      expect(res.status).toBe(200);
      const u = await one("SELECT password_hash, legacy_password_hash FROM users WHERE username = 'carlos.p'");
      expect(u.password_hash).toMatch(/^\$2[aby]\$12\$/);
      expect(u.legacy_password_hash).toBeNull();
      expect(await auditCount('PASSWORD_REHASHED')).toBe(before + 1);
      // Desde ahora entra con bcrypt
      expect((await login('carlos.p', 'Turno2025')).status).toBe(200);
      expect(await auditCount('PASSWORD_REHASHED')).toBe(before + 1);
    });

    test('contraseña incorrecta: no entra y el legacy sigue', async () => {
      const res = await login('Jose.Nunez', 'otra-clave1');
      expect(res.status).toBe(401);
      expect((await one("SELECT legacy_password_hash FROM users WHERE username = 'Jose.Nunez'")).legacy_password_hash).not.toBeNull();
      expect((await login('jose.nunez', 'Noche2025')).status).toBe(200);
    });

    test('la que estaba en texto plano en la v1.0 también funciona', async () => {
      expect((await login('maria', 'maria123')).status).toBe(200);
      expect((await one("SELECT legacy_password_hash FROM users WHERE username = 'maria'")).legacy_password_hash).toBeNull();
    });

    test('admin/admin quedó desactivada y no se re-hashea', async () => {
      const res = await login('admin', 'admin');
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('USER_INACTIVE');
      expect((await one("SELECT legacy_password_hash FROM users WHERE username = 'admin'")).legacy_password_hash).not.toBeNull();
    });
  });
});

describe('reversión', () => {
  test('si los totales no cuadran se revierte TODO (también lo nuevo del archivo)', async () => {
    const data = JSON.parse(raw);
    const incomes = JSON.parse(data.keys.fp_incomes);
    incomes.push({ id: 'I1772470000000', concept: 'Nuevo', amount: 7000, observation: '', dateTime: '2026-03-02T17:00:00.000Z', user: 'Felipe', registerId: 'R1772450000000' });
    data.keys.fp_incomes = JSON.stringify(incomes);
    const before = await snapshot();
    const r = await runImport(parseExport(JSON.stringify(data)), {
      fileName: 'v1-export-3.json',
      // Simula una inconsistencia: algo cambia el total de egresos sin pasar por el importador
      beforeVerify: async (client) => {
        const { rows } = await client.query('SELECT id FROM cash_registers ORDER BY id LIMIT 1');
        await client.query("INSERT INTO cash_movements (cash_register_id, type, amount, concept, created_by) VALUES ($1, 'EXPENSE', 999, 'fantasma', 1)", [rows[0].id]);
      },
    });
    expect(r.outcome).toBe('ROLLED_BACK_UNBALANCED');
    expect(r.committed).toBe(false);
    expect(r.balanced).toBe(false);
    expect(r.categories.egresos.balanced).toBe(false);
    expect(r.categories.ingresos).toMatchObject({ imported: { count: 1, total: 7000 }, balanced: true });
    // Ni el ingreso nuevo ni el egreso fantasma quedaron
    expect(await snapshot()).toEqual(before);
    expect(await count("SELECT count(*) AS n FROM cash_movements WHERE concept IN ('Nuevo', 'fantasma')")).toBe(0);
  });

  test('una sede que no existe cancela sin tocar nada', async () => {
    const r = await runImport(parsed(), { siteCode: 'NOEXISTE' });
    expect(r.outcome).toBe('ABORTED');
    expect(r.error).toMatch('No existe la sede');
  });
});
