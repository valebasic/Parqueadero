// Arqueo por denominación (pesos colombianos en circulación).
// Billete y moneda de $ 1.000 se cuentan juntos.
const DENOMINATIONS = [100000, 50000, 20000, 10000, 5000, 2000, 1000, 500, 200, 100, 50];
const MAX_UNITS = 100000;

/**
 * Valida un conteo { "50000": 2, "1000": 7 } y devuelve { denominations, total } normalizado
 * (solo denominaciones con cantidad > 0, como claves de texto). Lanza Error con mensaje en español.
 */
function parseCashCount(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('El arqueo debe indicar la cantidad de billetes y monedas por denominación');
  }
  const denominations = {};
  let total = 0;
  for (const [key, rawQty] of Object.entries(input)) {
    const value = Number(key);
    if (!DENOMINATIONS.includes(value)) throw new Error(`Denominación no válida: ${key}`);
    if (!Number.isInteger(rawQty) || rawQty < 0 || rawQty > MAX_UNITS) {
      throw new Error(`La cantidad de $ ${value} debe ser un número entero entre 0 y ${MAX_UNITS}`);
    }
    if (rawQty > 0) {
      denominations[String(value)] = rawQty;
      total += value * rawQty;
    }
  }
  return { denominations, total };
}

module.exports = { DENOMINATIONS, parseCashCount };
