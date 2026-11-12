// Plano de una zona (RF47): cuadrícula filas × columnas con elementos rectangulares.
//   SPACE    puesto: código único en la zona, tipo (CAR, MOTORCYCLE, BICYCLE, REDUCED_MOBILITY),
//            uso (MONTHLY, HOURLY, MIXED), techado, tamaño 1×1 o 1×2 con orientación H/V
//   ROAD     vía · ENTRANCE entrada · EXIT salida · BLOCKED área no disponible (con etiqueta)
// Reglas: todo dentro de la cuadrícula, sin superposiciones y códigos de puesto únicos.
// El mismo archivo se usa en el frontend (frontend/src/lib/maplayout.js; prueba de paridad).

const KINDS = ['SPACE', 'ROAD', 'ENTRANCE', 'EXIT', 'BLOCKED'];
const SPACE_TYPES = ['CAR', 'MOTORCYCLE', 'BICYCLE', 'REDUCED_MOBILITY'];
const USAGES = ['MONTHLY', 'HOURLY', 'MIXED'];
const MAX_SIDE = 80;
const CODE_RE = /^[A-Z0-9-]{1,10}$/;

// Tamaño en celdas de un puesto según su tamaño y orientación
function spaceSize(size, orientation) {
  if (size === '1x2') return orientation === 'V' ? { width: 1, height: 2 } : { width: 2, height: 1 };
  return { width: 1, height: 1 };
}

const isInt = (v) => Number.isInteger(v);

/**
 * Valida y normaliza un plano. Devuelve { rows, cols, elements, errors } (errors vacío = válido).
 * Los errores son textos en español pensados para mostrarse en el editor.
 */
function validateLayout(input) {
  const errors = [];
  const rows = Number(input?.rows);
  const cols = Number(input?.cols);
  if (!isInt(rows) || rows < 1 || rows > MAX_SIDE) errors.push(`Las filas deben ser de 1 a ${MAX_SIDE}`);
  if (!isInt(cols) || cols < 1 || cols > MAX_SIDE) errors.push(`Las columnas deben ser de 1 a ${MAX_SIDE}`);
  const raw = Array.isArray(input?.elements) ? input.elements : [];
  if (raw.length > rows * cols) errors.push('Hay más elementos que celdas');
  if (errors.length) return { rows, cols, elements: [], errors };

  const elements = [];
  const ids = new Set();
  const codes = new Map();
  raw.forEach((e, i) => {
    const where = `Elemento ${i + 1}`;
    const kind = e?.kind;
    if (!KINDS.includes(kind)) {
      errors.push(`${where}: tipo de elemento inválido`);
      return;
    }
    const id = String(e.id ?? `e${i + 1}`).slice(0, 40);
    if (ids.has(id)) errors.push(`${where}: identificador repetido`);
    ids.add(id);
    const row = Number(e.row);
    const col = Number(e.col);
    const out = { id, kind, row, col };
    if (kind === 'SPACE') {
      const code = String(e.code ?? '').trim().toUpperCase();
      if (!CODE_RE.test(code)) errors.push(`${where}: código de puesto inválido (letras, números o guion, máx. 10)`);
      else if (codes.has(code)) errors.push(`Puesto ${code}: el código está repetido`);
      codes.set(code, true);
      const size = e.size === '1x2' ? '1x2' : '1x1';
      const orientation = e.orientation === 'V' ? 'V' : 'H';
      if (!SPACE_TYPES.includes(e.spaceType)) errors.push(`Puesto ${code || i + 1}: tipo inválido`);
      if (!USAGES.includes(e.usage)) errors.push(`Puesto ${code || i + 1}: uso inválido`);
      Object.assign(out, { code, spaceType: e.spaceType, usage: e.usage, covered: e.covered === true, size, orientation, ...spaceSize(size, orientation) });
    } else {
      const width = Number(e.width ?? 1);
      const height = Number(e.height ?? 1);
      if (!isInt(width) || width < 1 || !isInt(height) || height < 1) errors.push(`${where}: tamaño inválido`);
      Object.assign(out, { width, height });
      if (kind === 'BLOCKED') out.label = String(e.label ?? '').trim().slice(0, 40) || 'No disponible';
    }
    if (!isInt(row) || !isInt(col) || row < 0 || col < 0 || row + out.height > rows || col + out.width > cols) {
      errors.push(`${kind === 'SPACE' ? `Puesto ${out.code}` : where}: queda fuera de la cuadrícula`);
    }
    elements.push(out);
  });
  if (errors.length) return { rows, cols, elements, errors };

  // Superposición: cada celda la ocupa a lo sumo un elemento
  const grid = new Map();
  const name = (e) => (e.kind === 'SPACE' ? `el puesto ${e.code}` : { ROAD: 'una vía', ENTRANCE: 'la entrada', EXIT: 'la salida', BLOCKED: `el área "${e.label}"` }[e.kind]);
  for (const e of elements) {
    for (let r = e.row; r < e.row + e.height; r += 1) {
      for (let c = e.col; c < e.col + e.width; c += 1) {
        const key = `${r}:${c}`;
        const other = grid.get(key);
        if (other && other !== e) {
          errors.push(`${name(e)[0].toUpperCase()}${name(e).slice(1)} se superpone con ${name(other)} (fila ${r + 1}, columna ${c + 1})`);
        } else grid.set(key, e);
      }
    }
  }
  return { rows, cols, elements, errors: [...new Set(errors)] };
}

// Distancia (en celdas, Manhattan) entre dos rectángulos
function rectDistance(a, b) {
  const dx = Math.max(0, b.col - (a.col + a.width - 1), a.col - (b.col + b.width - 1));
  const dy = Math.max(0, b.row - (a.row + a.height - 1), a.row - (b.row + b.height - 1));
  return dx + dy;
}

// Distancia de un puesto a la entrada más cercana (null si el plano no tiene entradas)
function entranceDistance(space, elements) {
  const entrances = elements.filter((e) => e.kind === 'ENTRANCE');
  if (!entrances.length) return null;
  return Math.min(...entrances.map((e) => rectDistance(space, e)));
}

// Tipo de puesto que corresponde a cada tipo de vehículo
const SPACE_TYPE_FOR_VEHICLE = { CAR: ['CAR'], MOTORCYCLE: ['MOTORCYCLE'], BICYCLE: ['BICYCLE'] };

module.exports = { validateLayout, spaceSize, rectDistance, entranceDistance, KINDS, SPACE_TYPES, USAGES, MAX_SIDE, SPACE_TYPE_FOR_VEHICLE };
