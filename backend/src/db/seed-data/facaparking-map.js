// Plano de Facaparking, zona "Principal" (según el croquis del equipo). 16 filas × 11 columnas;
// cada celda es el ancho de un carro y un puesto de carro ocupa 2 celdas de fondo (1×2).
//
//        col: 0 1 | 2 3 | 4 5 6 | 7 8 | 9 10
//   fila  0:  13  | vía | 14 15 vía | M1 M2 M3 | Estr.
//   fila  1:  12  | vía | 14 15 vía | M4 M5 vía | Estr.
//   fila  2:  11  | vía |  vía      | vía   | 16
//   fila  3:  10  | vía |  vía      | vía   | 17
//   fila  4:   9  | 30  |  vía      | 29    | 18
//   fila  5:   8  | 31  |  vía      | 28    | 19
//   fila  6:   7  | vía |  vía      | vía   | 20
//   …         …
//   fila 10:   3  | vía |  vía      | vía   | 24
//   fila 11:   —  | vía |  vía      | 27    | 25
//   fila 12:   2  | vía |  vía      | vía   | 26
//   fila 13:   —  |   vía   | Estructura (hasta el final del lote)
//   fila 14:   1  |   vía   | Estructura
//   fila 15: Caseta | Entrada y salida | Estructura
//
// - Puestos 1-31: carro, uso mixto (las mensualidades ocupan cualquier puesto libre; sin reservados).
// - M1-M5: moto y cicla.
// - Techados: 3-13 y 16-26.
// - Parqueo en reversa: el frente mira hacia la vía (pared izquierda e isla izquierda → E; pared
//   derecha e isla derecha → W; 14 y 15 → S).
// - Piden llaves (bloquean puestos de pared): 27, 28, 29, 30 y 31.

const car = (code, row, col, facing, extra = {}) => ({
  id: `p${code}`,
  kind: 'SPACE',
  code: String(code),
  row,
  col,
  spaceType: 'CAR',
  usage: 'MIXED',
  covered: false,
  requiresKeys: false,
  facing,
  size: '1x2',
  orientation: 'H',
  ...extra,
});
const two = (code, row, col) => ({
  id: `p${code}`,
  kind: 'SPACE',
  code,
  row,
  col,
  spaceType: 'MOTORCYCLE_BICYCLE',
  usage: 'MIXED',
  covered: false,
  requiresKeys: false,
  facing: 'S',
  size: '1x1',
  orientation: 'H',
});
const road = (id, row, col, width, height) => ({ id, kind: 'ROAD', row, col, width, height });

const elements = [
  // Pared izquierda: 13 (arriba) … 3, seguidos; más abajo 2 y luego 1
  ...[13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3].map((code, i) => car(code, i, 0, 'E', { covered: true })),
  car(2, 12, 0, 'E'),
  car(1, 14, 0, 'E'),
  // Arriba al centro: 14 y 15 verticales
  car(14, 0, 4, 'S', { orientation: 'V' }),
  car(15, 0, 5, 'S', { orientation: 'V' }),
  // Islas de la vía (piden llaves)
  car(30, 4, 2, 'E', { requiresKeys: true }),
  car(31, 5, 2, 'E', { requiresKeys: true }),
  car(29, 4, 7, 'W', { requiresKeys: true }),
  car(28, 5, 7, 'W', { requiresKeys: true }),
  car(27, 11, 7, 'W', { requiresKeys: true }),
  // Pared derecha: 16 (arriba) … 26, seguidos
  ...Array.from({ length: 11 }, (_, i) => car(16 + i, 2 + i, 9, 'W', { covered: true })),
  // Arriba a la derecha: motos y ciclas, y la estructura a su derecha
  two('M1', 0, 7),
  two('M2', 0, 8),
  two('M3', 0, 9),
  two('M4', 1, 7),
  two('M5', 1, 8),
  { id: 'estructura-arriba', kind: 'BLOCKED', row: 0, col: 10, width: 1, height: 2, label: 'Estructura' },
  // Vía central y pasillos frente a los puestos
  road('via-1', 0, 2, 2, 4),
  road('via-2', 0, 6, 1, 2),
  road('via-3', 1, 9, 1, 1),
  road('via-central', 2, 4, 3, 11),
  road('via-4', 2, 7, 2, 2),
  road('via-5', 6, 2, 2, 7),
  road('via-6', 6, 7, 2, 5),
  road('via-7', 12, 7, 2, 1),
  road('via-salida', 13, 2, 4, 2),
  // Abajo: caseta, entrada/salida única y estructura grande a la derecha
  { id: 'caseta', kind: 'BLOCKED', row: 15, col: 0, width: 2, height: 1, label: 'Caseta' },
  { id: 'entrada', kind: 'ENTRANCE', row: 15, col: 2, width: 4, height: 1, label: 'Entrada y salida' },
  { id: 'estructura-abajo', kind: 'BLOCKED', row: 13, col: 6, width: 5, height: 3, label: 'Estructura' },
];

module.exports = {
  zoneName: 'Principal',
  layout: { rows: 16, cols: 11, elements },
  notes: 'Plano de Facaparking (seed, según el croquis)',
};
