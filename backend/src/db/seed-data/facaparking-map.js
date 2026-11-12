// Plano de Facaparking, zona "Principal" (según la foto del croquis). 32 filas × 26 columnas.
// Escala: un puesto de carro mide 2 celdas de ancho × 5 de fondo, así caben puestos de moto más
// pequeños (2 × 1) y las islas pueden quedar a media altura entre dos puestos de pared.
//
//   Columnas:  0-4 pared izquierda · 5-9 isla izquierda / pasillo · 10-15 vía central (arriba: 14,
//              15 y la columna de motos) · 16-20 isla derecha / pasillo · 21-25 pared derecha.
//   Por fila (· = vía, ### = estructura, E/S = entrada y salida):
//
//   fila | 0-4 | 5-9 |10-11|12-13|14-15|16-20|21-25
//     0  | 13  |  ·  | 14  | 15  | M1  | ### | ###
//     1  | 13  |  ·  | 14  | 15  | M2  | ### | ###
//     2  | 12  |  ·  | 14  | 15  | M3  | ### | ###
//     3  | 12  |  ·  | 14  | 15  | M4  | ### | ###
//     4  | 11  |  ·  | 14  | 15  | M5  | ### | ###
//     5  | 11  |  ·  |  ·  |  ·  |  ·  |  ·  | 16
//     6  | 10  | 30  |  ·  |  ·  |  ·  | 29  | 16
//     7  | 10  | 30  |  ·  |  ·  |  ·  | 29  | 17
//     8  |  9  |  ·  |  ·  |  ·  |  ·  |  ·  | 17
//     9  |  9  |  ·  |  ·  |  ·  |  ·  |  ·  | 18
//    10  |  8  | 31  |  ·  |  ·  |  ·  | 28  | 18
//    11  |  8  | 31  |  ·  |  ·  |  ·  | 28  | 19
//    12  |  7  |  ·  |  ·  |  ·  |  ·  |  ·  | 19
//    …   |  …  |  ·  |  ·  |  ·  |  ·  |  ·  |  …
//    20  |  3  |  ·  |  ·  |  ·  |  ·  |  ·  | 23
//    21  |  3  |  ·  |  ·  |  ·  |  ·  |  ·  | 24
//    22  |     |  ·  |  ·  |  ·  |  ·  |  ·  | 24
//    23  |     |  ·  |  ·  |  ·  |  ·  | 27  | 25
//    24  |  2  |  ·  |  ·  |  ·  |  ·  | 27  | 25
//    25  |  2  |  ·  |  ·  |  ·  |  ·  |  ·  | 26
//    26  |     |  ·  |  ·  |  ·  |  ·  |  ·  | 26
//    27  |     |  ·  |  ·  |  ·  | ### | ### | ###
//    28  |  1  |  ·  |  ·  |  ·  | ### | ### | ###
//    29  |  1  |  ·  |  ·  |  ·  | ### | ### | ###
//    30  | Caseta | E/S |  E/S  | ### | ### | ###
//    31  | Caseta | E/S |  E/S  | ### | ### | ###
//
// - Puestos 1-31: carro, uso mixto (las mensualidades ocupan cualquier puesto libre; sin reservados).
// - M1-M5: moto y cicla, una columna de 5 puestos pequeños apilados a la derecha del 15.
// - Techados: 3-13 y 16-26.
// - Parqueo en reversa: el frente mira hacia la vía (pared e isla izquierdas → E; pared e isla
//   derechas → W; 14, 15 y motos → S).
// - Piden llaves (bloquean puestos de pared): 27, 28, 29, 30 y 31.
//   30 queda a la altura del 10 y 31 a la del 8 (frente al 9 queda vía libre);
//   29 a la altura de 16-17, 28 a la de 18-19 y 27 a la del 25.

const CAR_W = 2; // ancho de un carro (celdas)
const CAR_D = 5; // fondo de un carro (celdas)

// Puesto de pared o isla: el carro entra de lado (fondo horizontal)
const side = (code, row, col, facing, extra = {}) => ({
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
  size: 'custom',
  orientation: 'H',
  width: CAR_D,
  height: CAR_W,
  ...extra,
});
// Puesto vertical (fondo hacia abajo)
const upright = (code, row, col, facing) => ({ ...side(code, row, col, facing), width: CAR_W, height: CAR_D, orientation: 'V' });
const moto = (code, row) => ({
  id: `p${code}`,
  kind: 'SPACE',
  code,
  row,
  col: 14,
  spaceType: 'MOTORCYCLE_BICYCLE',
  usage: 'MIXED',
  covered: false,
  requiresKeys: false,
  facing: 'S',
  size: 'custom',
  orientation: 'H',
  width: 2,
  height: 1,
});
const road = (id, row, col, width, height) => ({ id, kind: 'ROAD', row, col, width, height });

const elements = [
  // Pared izquierda: 13 (arriba) … 3, seguidos; más abajo 2 y luego 1
  ...[13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3].map((code, i) => side(code, i * CAR_W, 0, 'E', { covered: true })),
  side(2, 24, 0, 'E'),
  side(1, 28, 0, 'E'),
  // Arriba al centro: 14 y 15 verticales y, a la derecha del 15, la columna de motos y ciclas
  upright(14, 0, 10, 'S'),
  upright(15, 0, 12, 'S'),
  ...['M1', 'M2', 'M3', 'M4', 'M5'].map((code, i) => moto(code, i)),
  { id: 'estructura-arriba', kind: 'BLOCKED', row: 0, col: 16, width: 10, height: 5, label: 'Estructura' },
  // Pared derecha: 16 (arriba) … 26, seguidos
  ...Array.from({ length: 11 }, (_, i) => side(16 + i, 5 + i * CAR_W, 21, 'W', { covered: true })),
  // Isla izquierda (30 frente al 10, 31 frente al 8; frente al 9 queda libre) e isla derecha (piden llaves)
  side(30, 6, 5, 'E', { requiresKeys: true }),
  side(31, 10, 5, 'E', { requiresKeys: true }),
  side(29, 6, 16, 'W', { requiresKeys: true }), // a la altura de 16-17
  side(28, 10, 16, 'W', { requiresKeys: true }), // a la altura de 18-19
  side(27, 23, 16, 'W', { requiresKeys: true }), // a la altura del 25
  // Vías y pasillos
  road('pasillo-izq-1', 0, 5, 5, 6),
  road('pasillo-izq-paso', 8, 5, 5, 2),
  road('pasillo-izq-2', 12, 5, 5, 15),
  road('via-central', 5, 10, 6, 22),
  road('pasillo-der-1', 5, 16, 5, 1),
  road('pasillo-der-2', 8, 16, 5, 2),
  road('pasillo-der-3', 12, 16, 5, 11),
  road('pasillo-der-4', 25, 16, 5, 2),
  road('via-salida', 27, 5, 8, 3),
  // Abajo: caseta, entrada/salida única y estructura grande a la derecha
  { id: 'caseta', kind: 'BLOCKED', row: 30, col: 0, width: 5, height: 2, label: 'Caseta' },
  { id: 'entrada', kind: 'ENTRANCE', row: 30, col: 5, width: 8, height: 2, label: 'Entrada y salida' },
  { id: 'estructura-abajo', kind: 'BLOCKED', row: 27, col: 13, width: 13, height: 5, label: 'Estructura' },
];

module.exports = {
  zoneName: 'Principal',
  layout: { rows: 32, cols: 26, elements },
  notes: 'Plano de Facaparking (seed, según el croquis)',
};
