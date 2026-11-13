// Conversión de formatos de la v1.0 (sin base de datos): fechas, montos, formas de pago, usuarios y
// el hash de contraseñas de mvc/model.js.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const src = require('../src/migration/v1/source');
const { sanitizeUsername, v1ReceiptConfig } = require('../src/migration/v1/importer');
const { legacyV1Hash, verifyLegacyV1, isLegacyV1Hash } = require('../src/services/password.service');

describe('fechas de la v1.0 (hora de Colombia)', () => {
  test.each([
    ['02-03-2026 07:10:00', '2026-03-02T12:10:00.000Z'],
    ['2-3-2026 7:10', '2026-03-02T12:10:00.000Z'],
    ['02/03/2026 23:59:59', '2026-03-03T04:59:59.000Z'],
    ['2026-03-02T12:10:00.000Z', '2026-03-02T12:10:00.000Z'],
    ['2026-03-02T07:10:00', '2026-03-02T12:10:00.000Z'],
    ['2026-03-02', '2026-03-02T05:00:00.000Z'],
    [1772452200000, '2026-03-02T11:50:00.000Z'],
  ])('%p → %s', (input, iso) => {
    expect(src.parseDateTime(input).toISOString()).toBe(iso);
  });

  test.each(['31-02-2026 10:00:00', '2026-13-01', '25:00', '', null, 'ayer', '02-03-2026 24:10:00'])('inválida: %p', (v) => {
    expect(src.parseDateTime(v)).toBeNull();
  });

  test('fechas sin hora', () => {
    expect(src.parseDate('2026-03-31')).toBe('2026-03-31');
    expect(src.parseDate('31/03/2026')).toBe('2026-03-31');
    // 11:30 p. m. en Colombia ya es el día siguiente en UTC: se conserva el día de Colombia
    expect(src.parseDate('2026-04-01T04:30:00.000Z')).toBe('2026-03-31');
    expect(src.parseDate('31/02/2026')).toBeNull();
  });
});

describe('montos y formas de pago', () => {
  test('money', () => {
    expect(src.money('7200')).toBe(7200);
    expect(src.money(7199.6)).toBe(7200);
    expect(src.money(-1)).toBeNull();
    expect(src.money('abc')).toBeNull();
    expect(src.money(undefined)).toBeNull();
  });

  test.each([
    ['cash', 'CASH'],
    ['efectivo', 'CASH'],
    ['2', 'CASH'],
    ['nequi', 'ELECTRONIC'],
    ['Electrónico', 'ELECTRONIC'],
    ['both', 'MIXED'],
    ['', null],
    [undefined, null],
  ])('forma de pago %p → %p', (v, expected) => {
    expect(src.paymentMethod(v)).toBe(expected);
  });

  test('reparto del pago mixto', () => {
    expect(src.splitAmounts('MIXED', 6600, 3000, 3600)).toEqual({ method: 'MIXED', cash: 3000, electronic: 3600 });
    expect(src.splitAmounts('MIXED', 6600, undefined, 3600)).toEqual({ method: 'MIXED', cash: 3000, electronic: 3600 });
    expect(src.splitAmounts('MIXED', 6600, 6600, 0)).toEqual({ method: 'CASH', cash: 6600, electronic: 0 });
    expect(src.splitAmounts('MIXED', 6600, 0, 6600)).toEqual({ method: 'ELECTRONIC', cash: 0, electronic: 6600 });
    expect(src.splitAmounts('MIXED', 6600, 9000, 0).error).toMatch('fuera del total');
    expect(src.splitAmounts('CASH', 5000)).toEqual({ method: 'CASH', cash: 5000, electronic: 0 });
  });

  test('vehículo y horas', () => {
    expect(src.vehicleType('5')).toBe('CAR');
    expect(src.vehicleType('Moto')).toBe('MOTORCYCLE');
    expect(src.vehicleType('CICLA')).toBe('BICYCLE');
    expect(src.vehicleType('camión')).toBeNull();
    expect(src.hhmm('7:05')).toBe('07:05');
    expect(src.hhmm('25:00')).toBeNull();
  });
});

describe('usuarios', () => {
  test.each([
    ['Felipe', 'Felipe'],
    ['José Ñúñez', 'Jose.Nunez'],
    ['ana  maría', 'ana.maria'],
    ['op@turno#1', 'opturno1'],
    ['x', null],
    ['  ', null],
  ])('%p → %p', (input, expected) => {
    expect(sanitizeUsername(input)).toBe(expected);
  });

  test('el hash de contraseñas es el mismo de mvc/model.js (SHA-256 de salt + ":" + contraseña)', () => {
    // Se ejecuta el model.js real de la v1.0 en un contexto aislado
    const code = fs.readFileSync(path.join(__dirname, '../../mvc/model.js'), 'utf8');
    const store = {};
    const webCrypto = { getRandomValues: (a) => require('crypto').randomFillSync(a) };
    const ctx = {
      window: { crypto: webCrypto },
      localStorage: { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } },
      crypto: webCrypto,
      TextEncoder,
      console,
    };
    vm.createContext(ctx);
    vm.runInContext(code, ctx);
    const v1 = ctx.window.FPModel;
    const salt = '0123456789abcdef0123456789abcdef';
    for (const pw of ['admin', 'Turno2025', 'ñandú 2026', '']) {
      expect(legacyV1Hash(pw, salt)).toBe(v1.hashPassword(pw, salt));
      const stored = v1.hashPassword(pw);
      expect(isLegacyV1Hash(stored)).toBe(true);
      expect(verifyLegacyV1(pw, stored)).toBe(true);
      expect(verifyLegacyV1(`${pw}x`, stored)).toBe(false);
    }
  });
});

test('configuración de recibos v1.0 → v2.0', () => {
  const cfg = v1ReceiptConfig({ customMessage: 'Gracias', additionalInfo: 'Vuelva pronto', exitShowTime: false, exitLabelTotal: 'TOTAL' });
  expect(cfg.message).toBe('Gracias\nVuelva pronto');
  expect(cfg.exit.show.duration).toBe(false);
  expect(cfg.labels.total).toBe('TOTAL');
});
