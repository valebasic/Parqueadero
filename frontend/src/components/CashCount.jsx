import { formatCOP } from '../lib/format.js';

// Arqueo por denominación (billetes y monedas COP). value = { "50000": 2, ... }
export const DENOMINATIONS = [100000, 50000, 20000, 10000, 5000, 2000, 1000, 500, 200, 100, 50];

export function cashCountTotal(value) {
  return DENOMINATIONS.reduce((sum, d) => sum + d * (Number(value?.[d]) || 0), 0);
}

// Solo cantidades enteras > 0, como espera la API
export function cleanCashCount(value) {
  const out = {};
  for (const d of DENOMINATIONS) {
    const q = Number.parseInt(value?.[d], 10);
    if (q > 0) out[d] = q;
  }
  return out;
}

export default function CashCount({ value, onChange, disabled = false }) {
  function set(d, raw) {
    const digits = String(raw).replace(/\D/g, '').slice(0, 5);
    onChange({ ...value, [d]: digits });
  }
  const total = cashCountTotal(value);

  return (
    <div className="nx-cashcount">
      <div className="nx-cashcount__grid">
        {DENOMINATIONS.map((d) => (
          <label key={d} className="nx-cashcount__row">
            <span className="nx-cashcount__denom">
              {formatCOP(d)} <small>{d >= 2000 ? 'billete' : d === 1000 ? 'billete/moneda' : 'moneda'}</small>
            </span>
            <input
              inputMode="numeric"
              value={value?.[d] ?? ''}
              onChange={(e) => set(d, e.target.value)}
              placeholder="0"
              disabled={disabled}
              aria-label={`Cantidad de ${formatCOP(d)}`}
            />
            <span className="nx-cashcount__sub">{formatCOP(d * (Number(value?.[d]) || 0))}</span>
          </label>
        ))}
      </div>
      <div className="nx-cashcount__total">
        <span>Total contado</span>
        <strong>{formatCOP(total)}</strong>
      </div>
    </div>
  );
}
