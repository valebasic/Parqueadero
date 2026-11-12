import { formatCOP, PAYMENT_LABELS } from '../lib/format.js';

// Campos de cobro reutilizables: valor a cobrar (descuento con motivo) y forma de pago.
// value = { charged: '', reason: '', method: 'CASH', cash: '' }  ·  base = valor sin descuento
export function paymentPayload(value, base) {
  const body = { paymentMethod: value.method };
  if (value.charged !== '' && Number(value.charged) !== base) {
    body.chargedAmount = Number(value.charged);
    body.discountReason = value.reason;
  }
  if (value.method === 'MIXED') body.cashAmount = Number(value.cash);
  return body;
}

export function paymentIsValid(value, base) {
  const total = value.charged === '' ? base : Number(value.charged) || 0;
  if (total > base) return false;
  if (total < base && value.reason.trim().length < 3) return false;
  if (value.method === 'MIXED') {
    const cash = Number(value.cash) || 0;
    return cash > 0 && cash < total;
  }
  return true;
}

export default function PaymentFields({ value, onChange, base }) {
  const set = (k) => (v) => onChange({ ...value, [k]: v });
  const total = value.charged === '' ? base : Number(value.charged) || 0;
  const discount = Math.max(0, base - total);
  return (
    <div className="nx-stack nx-stack--tight">
      <div className="nx-form__grid nx-form__grid--2">
        <label className="nx-form__field">
          <span>Valor a cobrar</span>
          <input
            inputMode="numeric"
            value={value.charged === '' ? String(base) : value.charged}
            onChange={(e) => {
              const d = e.target.value.replace(/\D/g, '');
              set('charged')(d === '' || Number(d) === base ? '' : d);
            }}
          />
        </label>
        <label className="nx-form__field">
          <span>Motivo del descuento{discount > 0 ? ' (obligatorio)' : ''}</span>
          <input value={value.reason} onChange={(e) => set('reason')(e.target.value)} disabled={discount === 0} maxLength={200} />
        </label>
      </div>
      {discount > 0 && (
        <p className="nx-muted nx-small">
          Valor {formatCOP(base)} · descuento −{formatCOP(discount)} · total <strong>{formatCOP(total)}</strong>
        </p>
      )}
      {total > base && <p className="nx-form__error">No puede cobrar más del valor.</p>}
      <div className="nx-paymethods nx-paymethods--3">
        {['CASH', 'ELECTRONIC', 'MIXED'].map((m) => (
          <button key={m} type="button" className={`nx-paymethod${value.method === m ? ' is-active' : ''}`} onClick={() => set('method')(m)}>
            {m === 'MIXED' ? 'Ambos' : PAYMENT_LABELS[m]}
          </button>
        ))}
      </div>
      {value.method === 'MIXED' && (
        <label className="nx-form__field">
          <span>Efectivo (el resto, electrónico: {formatCOP(Math.max(0, total - (Number(value.cash) || 0)))})</span>
          <input inputMode="numeric" value={value.cash} onChange={(e) => set('cash')(e.target.value.replace(/\D/g, ''))} />
        </label>
      )}
    </div>
  );
}
