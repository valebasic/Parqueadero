// Cálculo tarifario. Función pura (sin base de datos) para poder probarla a fondo.
//
// Modo 'normal' — idéntico a calculateTariff + calcNormal de ParkApp.html (v1.0):
//   - Se cuentan los minutos completos entre entrada y salida (se descartan los segundos).
//   - El tiempo se parte en bloques de 12 h (720 min). En cada bloque:
//       horas completas × valor hora + residuo (0 min = nada; 1–45 min = fracción; 46–59 min = hora).
//   - Si lo de un bloque alcanza o supera la tarifa plena de 12 h, ese bloque cobra la tarifa plena.
//
// Modo 'block12h' — ciclas: tarifa plena por cada bloque de 12 h o fracción iniciado.

const BLOCK_MINUTES = 12 * 60;
const FRACTION_MAX_MINUTES = 45;

// Cobro "normal" de un tramo de minutos, sin tope (calcNormal de la v1.0)
function normalFareFor(minutes, rate) {
  if (minutes <= 0) return 0;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  let fare = hours * rate.hourAmount;
  if (rest > 0) fare += rest <= FRACTION_MAX_MINUTES ? rate.fractionAmount : rate.hourAmount;
  return fare;
}

function toDate(value, name) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) throw new TypeError(`${name} no es una fecha válida`);
  return d;
}

/**
 * Calcula el valor de una estadía.
 * @param {object} params
 * @param {Date|string} params.entryAt  hora de entrada
 * @param {Date|string} params.exitAt   hora de salida
 * @param {{fractionAmount:number, hourAmount:number, full12hAmount:number, pricingMode?:string}} params.rate
 * @returns {{minutes:number, total:number, normalFare:number, blocks:number, usedFull12h:boolean, pricingMode:string}}
 */
function calculateFare({ entryAt, exitAt, rate }) {
  const start = toDate(entryAt, 'entryAt');
  const end = toDate(exitAt, 'exitAt');
  const pricingMode = rate.pricingMode || 'normal';
  const cap = Number(rate.full12hAmount) || 0;
  const minutes = Math.max(0, Math.floor((end.getTime() - start.getTime()) / 60000));

  const result = { minutes, total: 0, normalFare: 0, blocks: 0, usedFull12h: false, pricingMode };
  if (minutes <= 0) return result;

  if (pricingMode === 'block12h') {
    result.blocks = Math.ceil(minutes / BLOCK_MINUTES);
    result.total = result.blocks * cap;
    result.normalFare = result.total;
    result.usedFull12h = true;
    return result;
  }
  if (pricingMode !== 'normal') {
    throw new RangeError(`Modo de cobro desconocido: ${pricingMode}`);
  }

  const normalizedRate = {
    fractionAmount: Number(rate.fractionAmount) || 0,
    hourAmount: Number(rate.hourAmount) || 0,
  };
  let remaining = minutes;
  while (remaining > 0) {
    const block = Math.min(remaining, BLOCK_MINUTES);
    const blockNormal = normalFareFor(block, normalizedRate);
    result.normalFare += blockNormal;
    if (cap > 0 && blockNormal >= cap) {
      result.total += cap;
      result.usedFull12h = true;
    } else {
      result.total += blockNormal;
    }
    result.blocks += 1;
    remaining -= block;
  }
  return result;
}

module.exports = { calculateFare, normalFareFor, BLOCK_MINUTES };
