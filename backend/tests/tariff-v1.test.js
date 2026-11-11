// RF09: el cálculo de la v2 reproduce EXACTAMENTE calculateTariff de ParkApp.html (v1.0).
// Se extrae el código original de la v1.0 y se compara contra calculateFare minuto a minuto.
const fs = require('fs');
const path = require('path');
const { calculateFare } = require('../src/services/tariff.service');

const PARKAPP = fs.readFileSync(path.join(__dirname, '../../ParkApp.html'), 'utf8');

// Toma de ParkApp.html el bloque calcNormal → addMonthsClamped → calendarElapsed → calculateTariff
function loadV1Calculator() {
  const start = PARKAPP.indexOf('function calcNormal(');
  const end = PARKAPP.indexOf('function showCalculation(');
  if (start < 0 || end < 0) throw new Error('No se encontró calculateTariff en ParkApp.html');
  const source = PARKAPP.slice(start, end);
  // eslint-disable-next-line no-new-func
  const factory = new Function('getTariff', 'parseDate', 'Date', `${source}\nreturn calculateTariff;`);
  return (startDate, endDate, v1Tariff) => {
    // "new Date()" sin argumentos dentro de la v1.0 = momento de la salida
    class FixedDate extends Date {
      constructor(...args) {
        if (args.length === 0) super(endDate.getTime());
        else super(...args);
      }
    }
    const calculateTariff = factory(() => v1Tariff, (s) => new Date(s.getTime()), FixedDate);
    return calculateTariff(startDate, 'x');
  };
}

const v1 = loadV1Calculator();

// Tarifas en el formato de la v1.0 (getTariff) y en el de la v2 (rates)
const RATES = {
  carro: {
    v1: { fraction: 1800, valorHora: 3300, full12h: 20000 },
    v2: { fractionAmount: 1800, hourAmount: 3300, full12hAmount: 20000, pricingMode: 'normal' },
  },
  moto: {
    v1: { fraction: 1500, valorHora: 2200, full12h: 14000 },
    v2: { fractionAmount: 1500, hourAmount: 2200, full12hAmount: 14000, pricingMode: 'normal' },
  },
  'sin tope': {
    v1: { fraction: 1000, valorHora: 2000, full12h: 0 },
    v2: { fractionAmount: 1000, hourAmount: 2000, full12hAmount: 0, pricingMode: 'normal' },
  },
};

const ENTRY = new Date('2026-03-05T08:00:00-05:00');
const at = (minutes, seconds = 0) => new Date(ENTRY.getTime() + minutes * 60000 + seconds * 1000);

describe('paridad con la v1.0 minuto a minuto (0 a 4 días)', () => {
  test.each(Object.keys(RATES))('%s', (name) => {
    const { v1: t1, v2: t2 } = RATES[name];
    const mismatches = [];
    for (let m = 0; m <= 4 * 24 * 60; m += 1) {
      const expected = v1(ENTRY, at(m), t1);
      const actual = calculateFare({ entryAt: ENTRY, exitAt: at(m), rate: t2 });
      if (expected.total !== actual.total || expected.normalFare !== actual.normalFare) {
        mismatches.push({ m, v1: expected.total, v2: actual.total });
        if (mismatches.length > 5) break;
      }
    }
    expect(mismatches).toEqual([]);
  });
});

describe('bordes (carro: fracción $ 1.800, hora $ 3.300, 12 h $ 20.000)', () => {
  const car = RATES.carro;
  // [descripción, minutos, segundos, valor esperado]
  const CASES = [
    ['0 min', 0, 0, 0],
    ['59 s', 0, 59, 0],
    ['1 min', 1, 0, 1800],
    ['44 min', 44, 0, 1800],
    ['45 min (último de fracción)', 45, 0, 1800],
    ['45 min 59 s (los segundos no cuentan)', 45, 59, 1800],
    ['46 min (primero de hora)', 46, 0, 3300],
    ['59 min', 59, 0, 3300],
    ['60 min exactos', 60, 0, 3300],
    ['61 min', 61, 0, 5100],
    ['1 h 45 min', 105, 0, 5100],
    ['1 h 46 min', 106, 0, 6600],
    ['2 h exactas', 120, 0, 6600],
    ['5 h 45 min', 345, 0, 18300],
    ['6 h exactas (19.800, bajo el tope)', 360, 0, 19800],
    ['6 h 1 min (alcanza el tope)', 361, 0, 20000],
    ['11 h 59 min', 719, 0, 20000],
    ['12 h exactas', 720, 0, 20000],
    ['12 h 1 min', 721, 0, 21800],
    ['12 h 46 min', 766, 0, 23300],
    ['13 h', 780, 0, 23300],
    ['18 h 1 min (2.º bloque topado)', 1081, 0, 40000],
    ['24 h exactas (2 días… de bloques)', 1440, 0, 40000],
    ['24 h 30 min', 1470, 0, 41800],
    ['36 h', 2160, 0, 60000],
    ['2 días exactos', 2880, 0, 80000],
    ['2 días 1 h', 2940, 0, 83300],
    ['3 días 5 min', 4325, 0, 121800],
    ['7 días', 10080, 0, 280000],
    ['30 días', 43200, 0, 1200000],
  ];

  test.each(CASES)('%s → v1.0 y v2 coinciden', (_label, minutes, seconds, expected) => {
    const exitAt = at(minutes, seconds);
    expect(v1(ENTRY, exitAt, car.v1).total).toBe(expected);
    expect(calculateFare({ entryAt: ENTRY, exitAt, rate: car.v2 }).total).toBe(expected);
  });
});

describe('bordes (moto: fracción $ 1.500, hora $ 2.200, 12 h $ 14.000)', () => {
  const moto = RATES.moto;
  test.each([
    [45, 1500],
    [46, 2200],
    [60, 2200],
    [360, 13200],
    [361, 14000],
    [720, 14000],
    [721, 15500],
    [2880, 56000],
  ])('%i min → $ %i', (minutes, expected) => {
    expect(v1(ENTRY, at(minutes), moto.v1).total).toBe(expected);
    expect(calculateFare({ entryAt: ENTRY, exitAt: at(minutes), rate: moto.v2 }).total).toBe(expected);
  });
});

test('fechas que cruzan el cambio de mes y de año dan lo mismo que en la v1.0', () => {
  const entry = new Date('2026-12-31T22:10:00-05:00');
  for (const minutes of [50, 130, 720, 1500, 3000]) {
    const exitAt = new Date(entry.getTime() + minutes * 60000);
    expect(calculateFare({ entryAt: entry, exitAt, rate: RATES.carro.v2 }).total).toBe(
      v1(entry, exitAt, RATES.carro.v1).total,
    );
  }
});
