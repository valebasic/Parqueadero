import { useCallback, useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { apiGet, apiPost } from '../lib/api.js';
import { formatCOP } from '../lib/format.js';
import { PayResult } from './PortalHomePage.jsx';

// Portal del cliente — enlace de pago del correo/SMS (/pagar/<token>). Lleva DIRECTO a pagar la
// mensualidad: sin placa ni código (el aviso llegó al contacto registrado). Solo muestra lo mínimo.
function fmtDate(iso) {
  const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('es-CO', { day: 'numeric', month: 'long', year: 'numeric' });
}

const TITLE = { RENEW: 'Renovar mi mensualidad', FIRST: 'Pagar mi mensualidad', PREPAY: 'Pagar por adelantado' };

export default function PortalPayLinkPage() {
  const { token } = useParams();
  const [params, setParams] = useSearchParams();
  const ref = params.get('ref') || '';
  const txId = params.get('id') || '';

  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [payError, setPayError] = useState('');
  const [mockRef, setMockRef] = useState('');
  const [result, setResult] = useState(ref ? { status: 'PENDING' } : null);

  const base = `/portal/pagar/${encodeURIComponent(token)}`;

  const load = useCallback(async () => {
    try {
      setData(await apiGet(base));
      setError('');
    } catch (err) {
      setError(err.message || 'No pudimos abrir este enlace.');
    } finally {
      setLoading(false);
    }
  }, [base]);

  useEffect(() => {
    load();
  }, [load]);

  // Al volver de Wompi (?ref=...&id=...) se verifica el pago con el servidor hasta que se resuelva
  useEffect(() => {
    if (!ref) return undefined;
    let stop = false;
    let timer;
    async function check() {
      try {
        const p = await apiGet(`/portal/pagos/${encodeURIComponent(ref)}${txId ? `?id=${encodeURIComponent(txId)}` : ''}`);
        if (stop) return;
        if (p.status === 'PENDING') {
          timer = setTimeout(check, 3000);
          return;
        }
        setResult(p);
        load();
      } catch {
        if (!stop) timer = setTimeout(check, 6000);
      }
    }
    check();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [ref, txId, load]);

  async function start() {
    setBusy(true);
    setPayError('');
    try {
      const p = await apiPost(`${base}/pago`, {});
      if (p.mode === 'wompi') {
        window.location.assign(p.checkoutUrl);
        return;
      }
      setMockRef(p.reference);
    } catch (err) {
      setPayError(err.message);
      load();
    } finally {
      setBusy(false);
    }
  }

  async function simulate(resultado) {
    setBusy(true);
    setPayError('');
    try {
      const r = await apiPost(`${base}/pago/${encodeURIComponent(mockRef)}/simular`, { resultado });
      setMockRef('');
      setResult(r);
      await load();
    } catch (err) {
      setPayError(err.message);
    } finally {
      setBusy(false);
    }
  }

  function dismiss() {
    setResult(null);
    if (ref) {
      const next = new URLSearchParams(params);
      ['ref', 'id'].forEach((k) => next.delete(k));
      setParams(next, { replace: true });
    }
  }

  const o = data?.payOnline;

  return (
    <div className="nx-portal">
      <header className="nx-portal__brand">
        Nexo<span>.app</span>
      </header>

      <main className="nx-portal__card">
        {loading && <p className="nx-portal__muted">Abriendo su enlace…</p>}

        {!loading && error && !data && (
          <div className="nx-portal__error" role="alert">
            <h1>No pudimos abrir el enlace</h1>
            <p>{error}</p>
          </div>
        )}

        {data && (
          <>
            <p className="nx-portal__biz">{data.business.name}</p>
            <h1 className="nx-portal__plate">{data.plate}</h1>
            <p className={`nx-portal__state is-${data.daysLeft < 0 ? 'bad' : data.daysLeft <= 6 ? 'pending' : 'in'}`}>
              {data.daysLeft < 0
                ? `Mensualidad vencida hace ${Math.abs(data.daysLeft)} ${Math.abs(data.daysLeft) === 1 ? 'día' : 'días'}`
                : data.daysLeft === 0
                  ? 'Su mensualidad vence hoy'
                  : `Su mensualidad vence en ${data.daysLeft} ${data.daysLeft === 1 ? 'día' : 'días'}`}
            </p>

            {result && <PayResult result={result} onClose={dismiss} />}

            <div className="nx-portal__rows">
              <div className="nx-portal__row">
                <span>{data.daysLeft < 0 ? 'Venció' : 'Vence'}</span>
                <strong>{fmtDate(data.endDate)}</strong>
              </div>
              {o?.canPay && (
                <>
                  <div className="nx-portal__row">
                    <span>El pago cubre</span>
                    <strong>
                      {fmtDate(o.periodStart)} → {fmtDate(o.periodEnd)}
                    </strong>
                  </div>
                  <div className="nx-portal__row">
                    <span>Valor</span>
                    <strong>{formatCOP(o.amount)}</strong>
                  </div>
                </>
              )}
            </div>

            {o?.canPay && !mockRef && (
              <>
                {o.mode === 'PREPAY' && (
                  <p className="nx-portal__hint">Es un pago adelantado: empieza cuando termine su período actual.</p>
                )}
                <button type="button" className="nx-portal__btn nx-portal__btn--block" onClick={start} disabled={busy}>
                  {busy ? 'Iniciando…' : `${TITLE[o.mode]} · ${formatCOP(o.amount)}`}
                </button>
              </>
            )}

            {mockRef && (
              <div className="nx-portal__mock" role="group" aria-label="Pago de prueba">
                <strong>Pago de PRUEBA</strong>
                <p>No se cobra dinero. Así se verá la pasarela Wompi cuando esté conectada.</p>
                <button type="button" className="nx-portal__btn nx-portal__btn--block" onClick={() => simulate('APPROVED')} disabled={busy}>
                  Simular pago aprobado
                </button>
                <button type="button" className="nx-portal__btn nx-portal__btn--ghost nx-portal__btn--block" onClick={() => simulate('DECLINED')} disabled={busy}>
                  Simular pago rechazado
                </button>
              </div>
            )}

            {o && !o.canPay && !result && <p className="nx-portal__hint">{o.reason}</p>}
            {payError && <p className="nx-portal__formerror" role="alert">{payError}</p>}

            <footer className="nx-portal__foot">
              {data.business.phone ? `¿Dudas? Llámenos al ${data.business.phone}` : 'También puede renovar en el parqueadero'}
            </footer>
          </>
        )}
      </main>
    </div>
  );
}
