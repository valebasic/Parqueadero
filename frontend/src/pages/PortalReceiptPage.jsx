import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { apiGet, apiPost } from '../lib/api.js';
import { formatCOP, formatDateTime, formatDuration, formatTime12h } from '../lib/format.js';

// Portal del cliente — público, sin login. Se llega escaneando el QR del tiquete
// (/recibo?sede=FACA&recibo=FA1).
//   Pantalla 1 "Mi vehículo": estancia y valor a la fecha (se actualiza solo).
//   Pantalla 2 "Pago": pagar con Wompi; al volver, se verifica el pago y se muestra el tiempo para salir.
const REFRESH_MS = 30000;
const POLL_MS = 3000;

const STATE_TEXT = {
  INSIDE: { label: 'Su vehículo está en el parqueadero', tone: 'in' },
  EXITED: { label: 'Este vehículo ya salió', tone: 'out' },
  PENDING: { label: 'Salida registrada, con un cobro pendiente', tone: 'pending' },
};

function Row({ label, children }) {
  return (
    <div className="nx-portal__row">
      <span>{label}</span>
      <strong>{children}</strong>
    </div>
  );
}

// Minutos y segundos que faltan para `until`
function useCountdown(until) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!until) return undefined;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [until]);
  if (!until) return null;
  const left = Math.max(0, Math.floor((new Date(until).getTime() - now) / 1000));
  return { left, text: `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}` };
}

function PaidPanel({ payment }) {
  const countdown = useCountdown(payment.exitUntil);
  const active = countdown && countdown.left > 0;
  return (
    <div className={`nx-portal__paid${active ? '' : ' is-late'}`} role="status">
      <strong>{active ? '✔ Pago recibido' : 'Se acabó el tiempo para salir'}</strong>
      <span>Pagó {formatCOP(payment.amount)}</span>
      {active ? (
        <>
          <span className="nx-portal__count">{countdown.text}</span>
          <small>Puede retirar su vehículo sin cobro adicional hasta las {formatTime12h(payment.exitUntil)}</small>
        </>
      ) : (
        <small>Si todavía no sale, en caja le cobrarán solo la diferencia desde su pago.</small>
      )}
    </div>
  );
}

export default function PortalReceiptPage() {
  const [params, setParams] = useSearchParams();
  const sede = params.get('sede') || '';
  const recibo = params.get('recibo') || '';
  const ref = params.get('ref') || '';
  const txId = params.get('id') || '';

  const [stay, setStay] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [paying, setPaying] = useState(false);
  const [payError, setPayError] = useState('');
  const [email, setEmail] = useState('');
  const [mockRef, setMockRef] = useState('');
  const [verifying, setVerifying] = useState(Boolean(ref));
  const [payResult, setPayResult] = useState(null); // estado final de un pago que acaba de volver

  const load = useCallback(async () => {
    try {
      const data = await apiGet(`/portal/recibo?sede=${encodeURIComponent(sede)}&recibo=${encodeURIComponent(recibo)}`);
      setStay(data);
      setError('');
    } catch (err) {
      setError(err.message || 'No pudimos consultar su recibo. Intente de nuevo.');
    } finally {
      setLoading(false);
    }
  }, [sede, recibo]);

  useEffect(() => {
    load();
  }, [load]);

  // Valor a la fecha: se refresca solo mientras el vehículo siga adentro
  useEffect(() => {
    if (stay?.state !== 'INSIDE') return undefined;
    const id = setInterval(load, REFRESH_MS);
    return () => clearInterval(id);
  }, [stay?.state, load]);

  // Al volver de Wompi (?ref=...&id=...) se verifica el pago con el servidor, hasta que se resuelva
  useEffect(() => {
    if (!ref || !verifying) return undefined;
    let stop = false;
    let timer;
    async function check() {
      try {
        const p = await apiGet(`/portal/pagos/${encodeURIComponent(ref)}${txId ? `?id=${encodeURIComponent(txId)}` : ''}`);
        if (stop) return;
        if (p.status === 'PENDING') {
          timer = setTimeout(check, POLL_MS);
        } else {
          setPayResult(p.status);
          setVerifying(false);
          load();
        }
      } catch {
        if (!stop) timer = setTimeout(check, POLL_MS * 2);
      }
    }
    check();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [ref, txId, verifying, load]);

  async function startPayment() {
    setPaying(true);
    setPayError('');
    try {
      const p = await apiPost('/portal/pagos', { sede, recibo, email: email.trim() });
      if (p.mode === 'wompi') {
        window.location.assign(p.checkoutUrl);
        return;
      }
      setMockRef(p.reference);
    } catch (err) {
      setPayError(err.message || 'No pudimos iniciar el pago. Intente de nuevo.');
      load();
    } finally {
      setPaying(false);
    }
  }

  async function simulate(resultado) {
    setPaying(true);
    setPayError('');
    try {
      const p = await apiPost(`/portal/pagos/${encodeURIComponent(mockRef)}/simular`, { resultado });
      setMockRef('');
      setPayResult(p.status);
      await load();
    } catch (err) {
      setPayError(err.message || 'No se pudo simular el pago.');
    } finally {
      setPaying(false);
    }
  }

  function dismissResult() {
    setPayResult(null);
    if (ref) {
      const next = new URLSearchParams(params);
      ['ref', 'id'].forEach((k) => next.delete(k));
      setParams(next, { replace: true });
    }
  }

  const state = stay ? STATE_TEXT[stay.state] : null;

  return (
    <div className="nx-portal">
      <header className="nx-portal__brand">
        Nexo<span>.app</span>
      </header>

      <main className="nx-portal__card">
        {loading && <p className="nx-portal__muted">Consultando su recibo…</p>}

        {!loading && error && !stay && (
          <div className="nx-portal__error" role="alert">
            <h1>No encontramos su recibo</h1>
            <p>{error}</p>
            <button type="button" className="nx-portal__btn nx-portal__btn--ghost" onClick={load}>
              Intentar de nuevo
            </button>
          </div>
        )}

        {stay && (
          <>
            <p className="nx-portal__biz">{stay.business.name}</p>
            <h1 className="nx-portal__plate">{stay.plate}</h1>
            <p className={`nx-portal__state is-${state.tone}`}>{state.label}</p>

            {verifying && (
              <div className="nx-portal__notice" role="status">
                Verificando su pago con Wompi… no cierre esta página.
              </div>
            )}
            {payResult && payResult !== 'APPROVED' && (
              <div className="nx-portal__notice is-bad" role="alert">
                {payResult === 'DECLINED' ? 'El pago fue rechazado.' : 'El pago no se pudo completar.'} No se hizo ningún cobro.
                Puede intentarlo de nuevo.{' '}
                <button type="button" className="nx-portal__link" onClick={dismissResult}>
                  Entendido
                </button>
              </div>
            )}

            <div className="nx-portal__rows">
              <Row label="Servicio">{stay.vehicleLabel}</Row>
              {stay.space && <Row label="Puesto">{stay.space}</Row>}
              <Row label="Recibo">{stay.receipt}</Row>
              <Row label="Entrada">{formatDateTime(stay.entryAt)}</Row>
              {stay.exitAt && <Row label="Salida">{formatDateTime(stay.exitAt)}</Row>}
              {stay.minutes != null && <Row label="Tiempo">{formatDuration(stay.minutes)}</Row>}
            </div>

            {stay.state === 'INSIDE' && stay.payment && <PaidPanel payment={stay.payment} />}

            {stay.state === 'INSIDE' && !stay.monthly && !stay.payment && (
              <div className="nx-portal__total">
                <span>Valor a la fecha</span>
                <strong>{formatCOP(stay.amount)}</strong>
                <small>
                  {stay.paymentsEnabled === false
                    ? 'Se actualiza solo. Pague en caja al salir: el valor final se calcula en ese momento.'
                    : 'Se actualiza solo. Si paga ahora, tendrá 10 minutos para salir sin cobro adicional.'}
                </small>
              </div>
            )}

            {stay.state === 'INSIDE' && stay.monthly && (
              <div className="nx-portal__total">
                <span>Mensualidad</span>
                <strong>Sin cobro por tiempo</strong>
                <small>Su vehículo tiene una mensualidad vigente.</small>
              </div>
            )}

            {stay.state === 'EXITED' && stay.amount != null && (
              <div className="nx-portal__total">
                <span>Total cobrado</span>
                <strong>{formatCOP(stay.amount)}</strong>
              </div>
            )}

            {payError && (
              <p className="nx-portal__formerror" role="alert">
                {payError}
              </p>
            )}

            {stay.canPay && !mockRef && !verifying && (
              <>
                <label className="nx-portal__field">
                  <span>Comprobante por correo (opcional)</span>
                  <input
                    type="email"
                    inputMode="email"
                    autoComplete="email"
                    placeholder="su@correo.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    maxLength={120}
                  />
                  <small>Usaremos su correo solo para enviarle el comprobante.</small>
                </label>
                <button type="button" className="nx-portal__btn nx-portal__btn--block" onClick={startPayment} disabled={paying}>
                  {paying ? 'Iniciando…' : `Pagar ${formatCOP(stay.amount)}`}
                </button>
              </>
            )}

            {mockRef && (
              <div className="nx-portal__mock" role="group" aria-label="Pago de prueba">
                <strong>Pago de PRUEBA</strong>
                <p>No se cobra dinero. Así se verá la pasarela Wompi cuando esté conectada.</p>
                <button type="button" className="nx-portal__btn nx-portal__btn--block" onClick={() => simulate('APPROVED')} disabled={paying}>
                  Simular pago aprobado
                </button>
                <button type="button" className="nx-portal__btn nx-portal__btn--ghost nx-portal__btn--block" onClick={() => simulate('DECLINED')} disabled={paying}>
                  Simular pago rechazado
                </button>
              </div>
            )}

            {stay.state === 'INSIDE' && <p className="nx-portal__hint">Conserve su tiquete para retirar su vehículo.</p>}

            <footer className="nx-portal__foot">
              {[stay.business.address, stay.business.city].filter(Boolean).join(' · ')}
              {stay.business.phone ? <> · Tel. {stay.business.phone}</> : null}
            </footer>
          </>
        )}
      </main>
    </div>
  );
}
