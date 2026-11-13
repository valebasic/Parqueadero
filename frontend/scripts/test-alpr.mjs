// Pruebas de la lógica pura de la lectura de placas (src/lib/alpr/plateLogic.js): npm run test:placas
// Vienen de tools/test-plate-logic.js de la v1.0 web (sin las del motor YOLO/ONNX, que no se trajo).
import assert from 'node:assert';
import * as P from '../src/lib/alpr/plateLogic.js';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('✓ ' + name); };

t('normalizePlate: placas válidas de carro y moto', () => {
  assert.deepStrictEqual(P.normalizePlate('ABC123'), { plate: 'ABC123', type: 'carro', fixes: 0 });
  assert.strictEqual(P.normalizePlate('abc-12d').plate, 'ABC12D');
  assert.strictEqual(P.normalizePlate('ABC12D').type, 'moto');
});
t('normalizePlate: corrige confusiones letra/número por posición', () => {
  assert.strictEqual(P.normalizePlate('8BC123').plate, 'BBC123');   // 8 en zona de letras
  assert.strictEqual(P.normalizePlate('ABC1Z3').plate, 'ABC123');   // Z en zona de números
  assert.strictEqual(P.normalizePlate('AB05S3').plate, 'ABO553');   // 0->O (zona de letras), S->5 (zona de números)
  assert.strictEqual(P.normalizePlate('ABC1O3').plate, 'ABC103');
});
t('normalizePlate: descarta basura y longitudes imposibles', () => {
  assert.strictEqual(P.normalizePlate(''), null);
  assert.strictEqual(P.normalizePlate('AB12'), null);
  assert.strictEqual(P.normalizePlate('ABCDEF'), null);
  assert.strictEqual(P.normalizePlate('123456'), null);
  assert.strictEqual(P.normalizePlate('ABC123XYZ12'), null);
});
t('normalizePlate: ignora caracteres sobrantes en los bordes (OCR de 7-8 posiciones)', () => {
  assert.strictEqual(P.normalizePlate('XABC123').plate, 'ABC123');
  assert.strictEqual(P.normalizePlate('ABC123X').plate, 'ABC123');
});

t('PlateVoter: confirma con 3 lecturas iguales y no repite', () => {
  const v = new P.PlateVoter({ window: 5, min: 3, maxAgeMs: 3000, releaseMs: 4000 });
  assert.strictEqual(v.push('ABC123', 0.9, 0), null);
  assert.strictEqual(v.push('ABC123', 0.9, 250), null);
  const r = v.push('ABC123', 0.8, 500);
  assert.strictEqual(r.plate, 'ABC123'); assert.strictEqual(r.votes, 3);
  assert.strictEqual(v.push('ABC123', 0.9, 750), null);   // ya confirmada
  assert.strictEqual(v.push('ABC123', 0.9, 1000), null);
});
t('PlateVoter: una lectura suelta errónea no confirma nada', () => {
  const v = new P.PlateVoter();
  ['ABC123', 'ABC128', 'ABC123', 'AQC123'].forEach((p, i) => assert.strictEqual(v.push(p, 0.9, i * 250), null));
  assert.strictEqual(v.push('ABC123', 0.9, 1000).plate, 'ABC123');
});
t('PlateVoter: variante de 1 carácter de la misma placa no se confirma como placa nueva', () => {
  const v = new P.PlateVoter();
  for (let i = 0; i < 3; i++) v.push('ABC123', 0.9, i * 250);
  let hit = null; for (let i = 3; i < 9; i++) hit = v.push('ABC128', 0.7, i * 250) || hit;
  assert.strictEqual(hit, null);
});
t('PlateVoter: otra placa distinta sí se confirma; la misma vuelve tras ausentarse', () => {
  const v = new P.PlateVoter();
  for (let i = 0; i < 3; i++) v.push('ABC123', 0.9, i * 250);
  let hit = null; for (let i = 3; i < 7; i++) hit = v.push('XYZ987', 0.9, i * 250) || hit;
  assert.strictEqual(hit.plate, 'XYZ987');
  v.push(null, 0, 20000);                                   // se fue
  let again = null; for (let i = 0; i < 4; i++) again = v.push('XYZ987', 0.9, 21000 + i * 250) || again;
  assert.strictEqual(again.plate, 'XYZ987');
});

/* YOLO: imagen 1280x720 en lienzo de 416 -> escala 0.325, pad vertical */
const W = 1280, H = 720, S = 416, scale = Math.min(S / W, S / H), padX = Math.floor((S - Math.round(W * scale)) / 2), padY = Math.floor((S - Math.round(H * scale)) / 2);
const letter = (x, y) => [x * scale + padX, y * scale + padY];
t('pickPlateFromTess: placa partida, ruido alrededor y texto completo', () => {
  assert.strictEqual(P.pickPlateFromTess({ text: 'ABC123\n' }).plate, 'ABC123');
  assert.strictEqual(P.pickPlateFromTess({ text: 'XX ABC 123 Q', words: [{ text: 'XX' }, { text: 'ABC' }, { text: '123' }, { text: 'Q' }] }).plate, 'ABC123');
  assert.strictEqual(P.pickPlateFromTess({ text: 'MJX44A', words: [{ text: 'MJX44A' }] }).type, 'moto');
  assert.strictEqual(P.pickPlateFromTess({ text: 'COLOMBIA', words: [{ text: 'COLOMBIA' }] }), null);
  assert.strictEqual(P.pickPlateFromTess({ text: 'COLOMBIA\nABC123', words: [{ text: 'COLOMBIA' }, { text: 'ABC123' }] }).plate, 'ABC123');
  assert.strictEqual(P.pickPlateFromTess({ text: 'C0L0MB1A', words: [{ text: 'C0L0MB1A' }] }), null);  // "COLOMBIA" mal leída
  assert.strictEqual(P.pickPlateFromTess({ text: 'OLOMBIA' }), null);
  assert.strictEqual(P.pickPlateFromTess({}), null);
});
t('locateYellowPlate: encuentra el bloque amarillo y descarta fondo gris y bloques mal formados', () => {
  const W = 640, H = 360, d = new Uint8ClampedArray(W * H * 4);
  const put = (x1, y1, x2, y2, c) => { for (let y = y1; y < y2; y++) for (let x = x1; x < x2; x++) { const p = (y * W + x) * 4; d[p] = c[0]; d[p + 1] = c[1]; d[p + 2] = c[2]; d[p + 3] = 255; } };
  put(0, 0, W, H, [60, 70, 80]);
  put(200, 120, 440, 240, [242, 200, 25]);      // placa 2:1
  put(20, 20, 40, 300, [242, 200, 25]);         // franja delgada: no es placa
  const b = P.locateYellowPlate(d, W, H);
  assert.ok(b && Math.abs(b.x1 - 200) <= 4 && Math.abs(b.x2 - 440) <= 4 && Math.abs(b.y1 - 120) <= 4 && Math.abs(b.y2 - 240) <= 4);
  put(0, 0, W, H, [60, 70, 80]);
  assert.strictEqual(P.locateYellowPlate(d, W, H), null);
});
t('locateLetterBand: toma solo la banda de letras (sin la línea de la ciudad ni los tornillos)', () => {
  const W = 640, H = 360, d = new Uint8ClampedArray(W * H * 4);
  const put = (x1, y1, x2, y2, c) => { for (let y = y1; y < y2; y++) for (let x = x1; x < x2; x++) { const p = (y * W + x) * 4; d[p] = c[0]; d[p + 1] = c[1]; d[p + 2] = c[2]; d[p + 3] = 255; } };
  put(0, 0, W, H, [60, 70, 80]);
  put(100, 60, 540, 300, [250, 224, 0]);                  // placa amarilla
  put(120, 70, 150, 90, [0, 0, 0]);                      // tornillo arriba
  [130, 190, 250, 330, 390, 450].forEach(x => put(x, 120, x + 40, 240, [0, 0, 0])); // letras grandes (y 120-240)
  put(200, 262, 440, 276, [0, 0, 0]);                    // línea pequeña de la ciudad (y 262-276)
  const bb = P.locateYellowPlate(d, W, H), lb = P.locateLetterBand(d, W, H, bb);
  assert.ok(lb, 'debe encontrar las letras');
  assert.ok(lb.y1 <= 120 && lb.y1 >= 105, 'no corta la parte de arriba de las letras: ' + lb.y1);
  assert.ok(lb.y2 >= 240 && lb.y2 <= 256, 'no incluye la línea de la ciudad: ' + lb.y2);
  assert.ok(lb.x1 <= 130 && lb.x2 >= 490);
  assert.strictEqual(P.locateLetterBand(d, W, H, null), null);
});
t('normalizeTessConf: acepta 0-100, 0-1 y "desconocida" (0) sin descartar la lectura', () => {
  assert.strictEqual(P.normalizeTessConf(86), 0.86);
  assert.strictEqual(P.normalizeTessConf(0.92), 0.92);
  assert.strictEqual(P.normalizeTessConf(0), 0.5);
  assert.strictEqual(P.normalizeTessConf(undefined), 0.5);
  assert.strictEqual(P.normalizeTessConf(NaN), 0.5);
  assert.strictEqual(P.normalizeTessConf(100), 1);
});
console.log('\n' + n + ' pruebas OK');
