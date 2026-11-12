// Cálculo tarifario: copia de backend/src/services/tariff.service.js para cobrar sin conexión.
// Si cambia uno, cambiar el otro: backend/tests/tariff-v1.test.js compara ambos con la v1.0.

const BLOCK_MINUTES = 12 * 60;
const FRACTION_MAX_MINUTES = 45;

function normalFareFor(minutes, rate) {
  if (minutes <= 0) return 0;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  let fare = hours * rate.hourAmount;
  if (rest > 0) fare += rest <= FRACTION_MAX_MINUTES ? rate.fractionAmount : rate.hourAmount;
  return fare;
}

export function calculateFare({ entryAt, exitAt, rate }) {
  const start = new Date(entryAt);
  const end = new Date(exitAt);
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
  const r = { fractionAmount: Number(rate.fractionAmount) || 0, hourAmount: Number(rate.hourAmount) || 0 };
  let remaining = minutes;
  while (remaining > 0) {
    const block = Math.min(remaining, BLOCK_MINUTES);
    const blockNormal = normalFareFor(block, r);
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
