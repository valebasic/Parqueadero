// Placas: mismas respuestas que mvc/validators.js de la v1.0 y que la copia del frontend.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const plates = require('../src/lib/plates');
const { DENOMINATIONS, parseCashCount } = require('../src/lib/denominations');

const ROOT = path.join(__dirname, '../..');

// Carga FPValidate de la v1.0 (es un IIFE que cuelga el objeto de `window`)
function loadV1Validators() {
  const code = fs.readFileSync(path.join(ROOT, 'mvc/validators.js'), 'utf8');
  // DOM mínimo: las máscaras en vivo de la v1.0 se registran al cargar, pero aquí no se usan
  const document = { addEventListener() {}, querySelectorAll: () => [], readyState: 'complete' };
  const sandbox = { window: {}, document };
  sandbox.self = sandbox.window;
  vm.createContext(sandbox);
  vm.runInContext(code.replace(/\(this\)\s*;?\s*$/, '(window);'), sandbox);
  return sandbox.window.FPValidate;
}

// Carga la copia ESM del frontend quitando los `export`
function loadFrontendPlates() {
  const code = fs.readFileSync(path.join(ROOT, 'frontend/src/lib/plates.js'), 'utf8').replace(/^export /gm, '');
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(`${code}\nthis.api = { normalizePlate, detectVehicleType, plateError };`, sandbox);
  return sandbox.api;
}

const V1_TYPE = { Carro: 'CAR', Moto: 'MOTORCYCLE', Cicla: 'BICYCLE', '': null };

const SAMPLES = [
  'ABC123', 'abc-123', ' jmv 025 ', 'ABC12D', 'jhb-02c', 'CICLA', 'cicla0', 'CICLA1', 'BICI', 'BICI1', 'PATIN',
  'PATIN0', 'PTELEC', 'PTELE0', 'PTELE1', 'MTELEC', 'MTELE1', 'AB123', 'ABCD12', 'ABC1234', '123ABC', 'ABC12',
  'CICLA2', 'BICIS', '', '   ', 'A-B-C-1-2-3', 'ÑAB123', 'ABC-12-D',
];

describe('placas iguales a la v1.0', () => {
  const v1 = loadV1Validators();

  test.each(SAMPLES)('%p', (sample) => {
    expect(plates.normalizePlate(sample)).toBe(v1.normalizePlate(sample));
    expect(plates.detectVehicleType(sample)).toBe(V1_TYPE[v1.detectPlateType(sample)]);
    expect(plates.plateError(sample) ?? '').toBe(v1.plateError(sample));
  });
});

describe('la copia del frontend es idéntica al backend', () => {
  const front = loadFrontendPlates();
  test.each(SAMPLES)('%p', (sample) => {
    expect(front.normalizePlate(sample)).toBe(plates.normalizePlate(sample));
    expect(front.detectVehicleType(sample)).toBe(plates.detectVehicleType(sample));
    expect(front.plateError(sample)).toBe(plates.plateError(sample));
  });
});

describe('arqueo por denominación', () => {
  test('suma billetes y monedas y descarta los ceros', () => {
    expect(parseCashCount({ 50000: 2, 10000: 3, 1000: 0, 500: 4 })).toEqual({
      denominations: { 50000: 2, 10000: 3, 500: 4 },
      total: 132000,
    });
  });

  test('conteo vacío = $ 0', () => {
    expect(parseCashCount({})).toEqual({ denominations: {}, total: 0 });
  });

  test.each([
    [{ 3000: 1 }, /Denominación no válida/],
    [{ 1000: -1 }, /número entero/],
    [{ 1000: 1.5 }, /número entero/],
    [null, /cantidad de billetes/],
    [[1, 2], /cantidad de billetes/],
  ])('rechaza %p', (input, message) => {
    expect(() => parseCashCount(input)).toThrow(message);
  });

  test('denominaciones COP en circulación', () => {
    expect(DENOMINATIONS).toEqual([100000, 50000, 20000, 10000, 5000, 2000, 1000, 500, 200, 100, 50]);
  });
});
