// Cálculo tarifario (tarifas del seed). Base para la Fase 4, que sumará más casos.
const { calculateFare } = require('../src/services/tariff.service');

const CAR = { fractionAmount: 1800, hourAmount: 3300, full12hAmount: 20000, pricingMode: 'normal' };
const MOTO = { fractionAmount: 1500, hourAmount: 2200, full12hAmount: 14000, pricingMode: 'normal' };
const BICYCLE = { fractionAmount: 0, hourAmount: 0, full12hAmount: 10000, pricingMode: 'block12h' };

const ENTRY = new Date('2026-03-05T08:00:00-05:00');
const after = (minutes, seconds = 0) => new Date(ENTRY.getTime() + minutes * 60000 + seconds * 1000);
const fare = (rate, minutes, seconds) => calculateFare({ entryAt: ENTRY, exitAt: after(minutes, seconds), rate });

describe("modo 'normal' (carro)", () => {
  test.each([
    [0, 0],
    [1, 1800], // 1–45 min = fracción
    [45, 1800],
    [46, 3300], // 46–60 min = hora
    [60, 3300],
    [61, 5100], // 1 h + fracción
    [105, 5100],
    [106, 6600], // 1 h + 46 min = 2 horas
    [300, 16500], // 5 h
    [360, 19800], // 6 h: todavía por debajo de la tarifa plena
    [361, 20000], // 6 h 1 min: 21.600 alcanza la plena → 20.000
    [720, 20000], // 12 h
    [721, 21800], // 12 h + fracción del bloque siguiente
    [780, 23300], // 13 h
    [1440, 40000], // 24 h = 2 bloques plenos
    [1441, 41800],
  ])('%i min → $ %i', (minutes, expected) => {
    expect(fare(CAR, minutes).total).toBe(expected);
  });

  test('descarta los segundos: 45 min 59 s sigue siendo fracción', () => {
    expect(fare(CAR, 45, 59).total).toBe(1800);
  });

  test('menos de un minuto no cobra', () => {
    expect(fare(CAR, 0, 59)).toMatchObject({ minutes: 0, total: 0 });
  });

  test('marca cuándo se aplicó la tarifa plena', () => {
    expect(fare(CAR, 360)).toMatchObject({ usedFull12h: false, normalFare: 19800 });
    expect(fare(CAR, 361)).toMatchObject({ usedFull12h: true, normalFare: 21600, blocks: 1 });
  });
});

describe("modo 'normal' (moto)", () => {
  test.each([
    [30, 1500],
    [50, 2200],
    [360, 13200],
    [365, 14000], // 13.200 + 1.500 = 14.700 → tope 14.000
    [720, 14000],
  ])('%i min → $ %i', (minutes, expected) => {
    expect(fare(MOTO, minutes).total).toBe(expected);
  });
});

describe("modo 'block12h' (cicla)", () => {
  test.each([
    [0, 0],
    [1, 10000], // bloque iniciado
    [719, 10000],
    [720, 10000],
    [721, 20000],
    [1440, 20000],
    [1441, 30000],
  ])('%i min → $ %i', (minutes, expected) => {
    expect(fare(BICYCLE, minutes).total).toBe(expected);
  });

  test('cuenta los bloques', () => {
    expect(fare(BICYCLE, 1441)).toMatchObject({ blocks: 3, pricingMode: 'block12h' });
  });

  test('una cicla configurada en modo normal con fracción y hora en 0 cobraría $ 0 (por eso existe block12h)', () => {
    expect(fare({ ...BICYCLE, pricingMode: 'normal' }, 300).total).toBe(0);
  });
});

describe('entradas inválidas', () => {
  test('salida anterior a la entrada → $ 0', () => {
    expect(fare(CAR, -30).total).toBe(0);
  });

  test('fecha inválida lanza error', () => {
    expect(() => calculateFare({ entryAt: 'no-es-fecha', exitAt: ENTRY, rate: CAR })).toThrow(TypeError);
  });

  test('modo de cobro desconocido lanza error', () => {
    expect(() => fare({ ...CAR, pricingMode: 'otro' }, 30)).toThrow(RangeError);
  });

  test('acepta fechas en texto ISO', () => {
    const r = calculateFare({ entryAt: ENTRY.toISOString(), exitAt: after(46).toISOString(), rate: CAR });
    expect(r.total).toBe(3300);
  });
});
