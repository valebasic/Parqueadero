// Plano de espacios: validación (sin base de datos) y paridad con la copia del frontend, que el editor
// usa para avisar antes de guardar.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const server = require('../src/lib/maplayout');

function loadFrontend() {
  const code = fs
    .readFileSync(path.join(__dirname, '../../frontend/src/lib/maplayout.js'), 'utf8')
    .replace(/^export \{([^}]*)\};?\s*$/m, 'module.exports = {$1};');
  const ctx = { module: { exports: {} } };
  vm.createContext(ctx);
  vm.runInContext(code, ctx);
  return ctx.module.exports;
}

const sp = (code, row, col, extra = {}) => ({ id: code, kind: 'SPACE', code, row, col, spaceType: 'CAR', usage: 'HOURLY', size: '1x1', ...extra });
const CASES = [
  { rows: 3, cols: 3, elements: [sp('A1', 0, 0), sp('A2', 0, 1, { size: '1x2', orientation: 'V' })] },
  { rows: 3, cols: 3, elements: [sp('A1', 0, 0, { size: '1x2' }), sp('A2', 0, 1)] }, // se superponen
  { rows: 2, cols: 2, elements: [sp('A1', 1, 1, { size: '1x2' })] }, // fuera
  { rows: 2, cols: 2, elements: [sp('A1', 0, 0), sp('a1', 1, 1)] }, // código repetido
  { rows: 2, cols: 4, elements: [{ id: 'x', kind: 'BLOCKED', row: 0, col: 0, width: 2, height: 2 }, sp('B', 0, 2, { spaceType: 'BUS' })] },
  { rows: 0, cols: 5, elements: [] },
  { rows: 4, cols: 4, elements: [{ id: 'e', kind: 'ENTRANCE', row: 3, col: 0 }, sp('Z9', 0, 3)] },
  { rows: 6, cols: 6, elements: [sp('C1', 0, 0, { size: 'custom', width: 5, height: 2 }), sp('M1', 2, 0, { size: 'custom', width: 2, height: 1 })] },
  { rows: 6, cols: 6, elements: [sp('C1', 0, 0, { size: 'custom', width: 0, height: 2 }), sp('C2', 2, 0, { size: 'custom', width: 21, height: 1 })] },
];

describe('validación del plano', () => {
  test('mensajes', () => {
    expect(server.validateLayout(CASES[0]).errors).toEqual([]);
    expect(server.validateLayout(CASES[1]).errors[0]).toMatch('El puesto A2 se superpone con el puesto A1');
    expect(server.validateLayout(CASES[2]).errors).toEqual(['Puesto A1: queda fuera de la cuadrícula']);
    expect(server.validateLayout(CASES[3]).errors).toEqual(['Puesto A1: el código está repetido']);
    expect(server.validateLayout(CASES[4]).errors).toEqual(['Puesto B: tipo inválido']);
    expect(server.validateLayout(CASES[4]).elements[0].label).toBe('No disponible');
    expect(server.validateLayout(CASES[5]).errors[0]).toMatch('filas');
    // Tamaño libre (planos de más resolución)
    expect(server.validateLayout(CASES[7]).errors).toEqual([]);
    expect(server.validateLayout(CASES[7]).elements.map((e) => [e.width, e.height])).toEqual([[5, 2], [2, 1]]);
    expect(server.validateLayout(CASES[8]).errors.filter((x) => x.includes('tamaño inválido'))).toHaveLength(2);
  });

  test('distancia a la entrada (Manhattan entre rectángulos)', () => {
    const v = server.validateLayout(CASES[6]);
    expect(server.entranceDistance(v.elements[1], v.elements)).toBe(6);
    expect(server.entranceDistance(v.elements[1], [])).toBeNull();
  });

  test('el frontend valida igual que el servidor', () => {
    const front = loadFrontend();
    for (const c of CASES) {
      expect(JSON.parse(JSON.stringify(front.validateLayout(c)))).toEqual(JSON.parse(JSON.stringify(server.validateLayout(c))));
    }
  });
});
