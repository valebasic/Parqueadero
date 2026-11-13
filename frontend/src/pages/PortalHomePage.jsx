import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { apiGet, apiPost } from '../lib/api.js';
import { formatCOP } from '../lib/format.js';

// Portal del cliente — pantalla 3: consulta por placa, sin QR. Pública, sin login.
//   "Tengo mi tiquete": placa + número de recibo → lleva a la pantalla 1.
//   "Tengo mensualidad": código de 6 dígitos al correo registrado → ve su mensualidad.
const STATUS = {
  ACTIVE: { label: 'Mensualidad vigente', tone: 'in' },
  EXPIRING: { label: 'Está por vencer', tone: 'pending' },
  EXPIRED: { label: 'Mensualidad vencida', tone: 'bad' },
};
const PAY_TEXT = { PAID: 'Al día', PARTIAL: 'Pagó la primera quincena', PENDING: 'Pendiente de pago' };

function fmtDate(iso) {
  // Fecha "AAAA-MM-DD" del servidor, sin corrimientos de zona horaria
  const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('es-CO', { day: 'numeric', month: 'long', year: 'numeric' });
}

function Row({ label, children }) {
  return (
    <div className="nx-portal__row">
      <span>{label}</span>
      <strong>{children}</strong>
    </div>
  );
}

async function fetchMonthly(token) {
  const res = await fetch('/api/portal/mensualidad', { headers: { Accept: 'application/json', Authorization: `Bearer ${token}` } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || 'No pudimos consultar su mensualidad.');
  return body.data;
}

// Petición con la sesión del portal (token del titular que verificó su código)
async function authed(method, path, token, body) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || 'Algo salió mal. Intente de nuevo.');
  return json.data;
}

// El token dura 30 minutos; se guarda solo en esta pestaña para no perderlo al ir a Wompi y volver
const TOKEN_KEY = 'nx_portal_token';
const saveToken = (t) => { try { sessionStorage.setItem(TOKEN_KEY, t); } catch { /* sin almacenamiento */ } };
const loadToken = () => { try { return sessionStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; } };
const clearToken = () => { try { sessionStorage.removeItem(TOKEN_KEY); } catch { /* sin almacenamiento */ } };

const PAY_BUTTON = { RENEW: 'Renovar mi mensualidad', FIRST: 'Pagar mi mensualidad', PREPAY: 'Pagar por adelantado' };

function PayBox({ data, pay }) {
  const o = data.payOnline;
  if (!o) return null;
  if (!o.canPay) {
    return <p className="nx-portal__hint">{o.reason}</p>;
  }
  return (
    <div className="nx-portal__paybox">
      <p>
        Cubre del <strong>{fmtDate(o.periodStart)}</strong> al <strong>{fmtDate(o.periodEnd)}</strong>
        {o.mode === 'PREPAY' ? '. Es un pago adelantado: empieza cuando termine su período actual.' : '.'}
      </p>
      {pay.mockRef ? (
        <div className="nx-portal__mock" role="group" aria-label="Pago de prueba">
          <strong>Pago de PRUEBA</strong>
          <p>No se cobra dinero. Así se verá la pasarela Wompi cuando esté conectada.</p>
          <button type="button" className="nx-portal__btn nx-portal__btn--block" onClick={() => pay.simulate('APPROVED')} disabled={pay.busy}>
            Simular pago aprobado
          </button>
          <button type="button" className="nx-portal__btn nx-portal__btn--ghost nx-portal__btn--block" onClick={() => pay.simulate('DECLINED')} disabled={pay.busy}>
            Simular pago rechazado
          </button>
        </div>
      ) : (
        <button type="button" className="nx-portal__btn nx-portal__btn--block" onClick={pay.start} disabled={pay.busy}>
          {pay.busy ? 'Iniciando…' : `${PAY_BUTTON[o.mode]} · ${formatCOP(o.amount)}`}
        </button>
      )}
      {pay.error && <p className="nx-portal__formerror" role="alert">{pay.error}</p>}
    </div>
  );
}

// Resultado de un pago que acaba de volver de la pasarela (o del simulador)
export function PayResult({ result, onClose }) {
  if (result.status === 'PENDING') {
    return <div className="nx-portal__notice" role="status">Verificando su pago con Wompi… no cierre esta página.</div>;
  }
  if (result.status === 'APPROVED') {
    return (
      <div className="nx-portal__paid" role="status">
        <strong>✔ Pago recibido</strong>
        <span>Pagó {formatCOP(result.amount)}</span>
        {result.needsReview ? (
          <small>Recibimos su pago, pero hay que revisarlo en el parqueadero. No pague de nuevo: ya nos avisamos.</small>
        ) : (
          <small>
            {result.receipt ? `Recibo ${result.receipt}. ` : ''}Su mensualidad queda cubierta hasta el {fmtDate(result.validUntil)}.
          </small>
        )}
        <button type="button" className="nx-portal__link" onClick={onClose}>Entendido</button>
      </div>
    );
  }
  return (
    <div className="nx-portal__notice is-bad" role="alert">
      {result.status === 'DECLINED' ? 'El pago fue rechazado.' : 'El pago no se pudo completar.'} No se hizo ningún cobro. Puede intentarlo de nuevo.{' '}
      <button type="button" className="nx-portal__link" onClick={onClose}>Entendido</button>
    </div>
  );
}

function MonthlyView({ data, onExit, pay, result, onDismissResult }) {
  const navigate = useNavigate();
  const st = STATUS[data.status];
  return (
    <>
      <p className="nx-portal__biz">{data.business.name}</p>
      <h1 className="nx-portal__plate">{data.plate}</h1>
      <p className={`nx-portal__state is-${st.tone}`}>{st.label}</p>
      {result && <PayResult result={result} onClose={onDismissResult} />}
      <div className="nx-portal__rows">
        <Row label="Titular">{data.clientName}</Row>
        <Row label="Servicio">{data.vehicleLabel}</Row>
        <Row label="Horario">{data.schedule === 'NIGHT' ? `Nocturno ${data.nightStart}–${data.nightEnd}` : 'Diurno'}</Row>
        <Row label="Vigente desde">{fmtDate(data.startDate)}</Row>
        <Row label="Vence">{fmtDate(data.endDate)}</Row>
        <Row label="Valor mensual">{formatCOP(data.monthlyAmount)}</Row>
        <Row label="Estado de pago">{PAY_TEXT[data.paymentStatus] ?? data.paymentStatus}</Row>
        {data.installmentDueDate && <Row label="Segunda quincena hasta">{fmtDate(data.installmentDueDate)}</Row>}
      </div>

      <div className="nx-portal__total">
        <span>{data.daysLeft < 0 ? 'Venció hace' : 'Le quedan'}</span>
        <strong>
          {Math.abs(data.daysLeft)} {Math.abs(data.daysLeft) === 1 ? 'día' : 'días'}
        </strong>
        <small>También puede renovar en el parqueadero{data.business.phone ? ` o llamar al ${data.business.phone}` : ''}.</small>
      </div>
      <PayBox data={data} pay={pay} />

      {data.currentStay && (
        <button
          type="button"
          className="nx-portal__btn nx-portal__btn--ghost nx-portal__btn--block"
          onClick={() => navigate(`/recibo?sede=${encodeURIComponent(data.currentStay.sede)}&recibo=${encodeURIComponent(data.currentStay.recibo)}`)}
        >
          Ver mi vehículo (está adentro)
        </button>
      )}

      {data.payments.length > 0 && (
        <>
          <h2 className="nx-portal__h2">Mis pagos</h2>
          <div className="nx-portal__rows">
            {data.payments.map((p) => (
              <Row key={p.receipt} label={`${fmtDate(p.periodStart)} → ${fmtDate(p.periodEnd)}`}>
                {formatCOP(p.amount)}
              </Row>
            ))}
          </div>
        </>
      )}

      <p className="nx-portal__hint">Correo registrado: {data.emailMasked}</p>
      <button type="button" className="nx-portal__btn nx-portal__btn--ghost nx-portal__btn--block" onClick={onExit}>
        Salir
      </button>
    </>
  );
}

export default function PortalHomePage() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  // El correo/SMS de aviso trae ?tab=mensualidad&placa=ABC123; al volver de Wompi trae &ref=NXM-...
  const [tab, setTab] = useState(params.get('tab') === 'mensualidad' ? 'monthly' : 'ticket'); // 'ticket' | 'monthly'
  const [plate, setPlate] = useState(String(params.get('placa') || '').toUpperCase().slice(0, 7));
  const [token, setToken] = useState('');
  const [payBusy, setPayBusy] = useState(false);
  const [payError, setPayError] = useState('');
  const [mockRef, setMockRef] = useState('');
  const [result, setResult] = useState(null); // resultado del último pago
  const [receipt, setReceipt] = useState('');
  const [step, setStep] = useState('plate'); // monthly: 'plate' | 'code'
  const [code, setCode] = useState('');
  const [notice, setNotice] = useState('');
  const [devCode, setDevCode] = useState('');
  const [channel, setChannel] = useState('EMAIL'); // medio con el que se pidió el código
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState(null);

  function switchTab(next) {
    setTab(next);
    setError('');
    setNotice('');
  }

  async function run(fn) {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (err) {
      setError(err.message || 'Algo salió mal. Intente de nuevo.');
    } finally {
      setBusy(false);
    }
  }

  const findTicket = (e) => {
    e.preventDefault();
    run(async () => {
      const r = await apiPost('/portal/consulta/tiquete', { placa: plate, recibo: receipt });
      navigate(`/recibo?sede=${encodeURIComponent(r.sede)}&recibo=${encodeURIComponent(r.recibo)}`);
    });
  };

  const askCode = (via = channel) => {
    setChannel(via);
    run(async () => {
      const r = await apiPost('/portal/consulta/codigo', { placa: plate, canal: via });
      setNotice(r.message);
      setDevCode(r.devCode || '');
      setStep('code');
    });
  };

  const verify = (e) => {
    e.preventDefault();
    run(async () => {
      const r = await apiPost('/portal/consulta/verificar', { placa: plate, codigo: code });
      setToken(r.token);
      saveToken(r.token);
      setView(await fetchMonthly(r.token));
      setCode('');
      setDevCode('');
    });
  };

  // Al volver de Wompi (?ref=NXM-...&id=...): se verifica el pago con el servidor y, si la sesión
  // sigue vigente (30 min), se muestra de nuevo la mensualidad con su nueva vigencia.
  const ref = params.get('ref') || '';
  const txId = params.get('id') || '';
  useEffect(() => {
    if (!ref.startsWith('NXM-')) return undefined;
    let stop = false;
    let timer;
    setResult({ status: 'PENDING' });
    async function check() {
      try {
        const p = await apiGet(`/portal/pagos/${encodeURIComponent(ref)}${txId ? `?id=${encodeURIComponent(txId)}` : ''}`);
        if (stop) return;
        if (p.status === 'PENDING') {
          timer = setTimeout(check, 3000);
          return;
        }
        setResult(p);
        const saved = loadToken();
        if (saved) {
          try {
            setToken(saved);
            setView(await fetchMonthly(saved));
          } catch {
            clearToken();
          }
        }
      } catch {
        if (!stop) timer = setTimeout(check, 6000);
      }
    }
    check();
    return () => { stop = true; clearTimeout(timer); };
  }, [ref, txId]);

  // Al recargar la página dentro de los 30 minutos de la sesión, se recupera sin pedir otro código
  useEffect(() => {
    const saved = loadToken();
    if (!saved) return;
    fetchMonthly(saved)
      .then((v) => { setToken(saved); setView(v); setTab('monthly'); })
      .catch(() => clearToken());
  }, []);

  function dismissResult() {
    setResult(null);
    if (ref) {
      const next = new URLSearchParams(params);
      ['ref', 'id'].forEach((k) => next.delete(k));
      setParams(next, { replace: true });
    }
  }

  const pay = {
    busy: payBusy,
    error: payError,
    mockRef,
    start: async () => {
      setPayBusy(true);
      setPayError('');
      try {
        const p = await authed('POST', '/portal/mensualidad/pagos', token, {});
        if (p.mode === 'wompi') {
          saveToken(token);
          window.location.assign(p.checkoutUrl);
          return;
        }
        setMockRef(p.reference);
      } catch (err) {
        setPayError(err.message);
        try { setView(await fetchMonthly(token)); } catch { /* sesión vencida */ }
      } finally {
        setPayBusy(false);
      }
    },
    simulate: async (resultado) => {
      setPayBusy(true);
      setPayError('');
      try {
        const r = await authed('POST', `/portal/mensualidad/pagos/${encodeURIComponent(mockRef)}/simular`, token, { resultado });
        setMockRef('');
        setResult(r);
        setView(await fetchMonthly(token));
      } catch (err) {
        setPayError(err.message);
      } finally {
        setPayBusy(false);
      }
    },
  };

  function exit() {
    clearToken();
    setToken('');
    setMockRef('');
    setResult(null);
    setPayError('');
    setView(null);
    setStep('plate');
    setPlate('');
    setError('');
    setNotice('');
  }

  return (
    <div className="nx-portal">
      <header className="nx-portal__brand">
        Nexo<span>.app</span>
      </header>

      <main className="nx-portal__card">
        {view ? (
          <MonthlyView data={view} onExit={exit} pay={pay} result={result} onDismissResult={dismissResult} />
        ) : (
          <>
            <h1 className="nx-portal__title">Consulte su vehículo</h1>
            {result && <PayResult result={result} onClose={dismissResult} />}
            <div className="nx-portal__tabs" role="tablist">
              <button type="button" role="tab" aria-selected={tab === 'ticket'} className={tab === 'ticket' ? 'is-active' : ''} onClick={() => switchTab('ticket')}>
                Tengo mi tiquete
              </button>
              <button type="button" role="tab" aria-selected={tab === 'monthly'} className={tab === 'monthly' ? 'is-active' : ''} onClick={() => switchTab('monthly')}>
                Tengo mensualidad
              </button>
            </div>

            {tab === 'ticket' && (
              <form onSubmit={findTicket} noValidate>
                <p className="nx-portal__muted">Escriba la placa y el número de recibo que aparece en su tiquete (por ejemplo FA12).</p>
                <label className="nx-portal__field">
                  <span>Placa</span>
                  <input value={plate} onChange={(e) => setPlate(e.target.value.toUpperCase())} placeholder="ABC123" maxLength={7} autoCapitalize="characters" autoComplete="off" />
                </label>
                <label className="nx-portal__field">
                  <span>Número de recibo</span>
                  <input value={receipt} onChange={(e) => setReceipt(e.target.value.toUpperCase())} placeholder="FA12" maxLength={14} autoCapitalize="characters" autoComplete="off" />
                </label>
                <button type="submit" className="nx-portal__btn nx-portal__btn--block" disabled={busy || !plate.trim() || !receipt.trim()}>
                  {busy ? 'Buscando…' : 'Consultar'}
                </button>
              </form>
            )}

            {tab === 'monthly' && step === 'plate' && (
              <form onSubmit={(e) => { e.preventDefault(); askCode('EMAIL'); }} noValidate>
                <p className="nx-portal__muted">Le enviaremos un código de 6 dígitos al correo o al celular que registró en su mensualidad.</p>
                <label className="nx-portal__field">
                  <span>Placa</span>
                  <input value={plate} onChange={(e) => setPlate(e.target.value.toUpperCase())} placeholder="ABC123" maxLength={7} autoCapitalize="characters" autoComplete="off" />
                </label>
                <button type="submit" className="nx-portal__btn nx-portal__btn--block" disabled={busy || !plate.trim()}>
                  {busy ? 'Enviando…' : 'Enviarme el código por correo'}
                </button>
                <button type="button" className="nx-portal__btn nx-portal__btn--ghost nx-portal__btn--block" disabled={busy || !plate.trim()} onClick={() => askCode('SMS')}>
                  Enviármelo por SMS
                </button>
              </form>
            )}

            {tab === 'monthly' && step === 'code' && (
              <form onSubmit={verify} noValidate>
                <div className="nx-portal__notice">{notice}</div>
                {devCode && (
                  <div className="nx-portal__notice is-dev">
                    Modo de pruebas (sin {channel === 'SMS' ? 'SMS' : 'correo'} configurado): su código es <strong>{devCode}</strong>
                  </div>
                )}
                <label className="nx-portal__field">
                  <span>Código de 6 dígitos</span>
                  <input
                    value={code}
                    onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    placeholder="000000"
                    className="nx-portal__code"
                  />
                </label>
                <button type="submit" className="nx-portal__btn nx-portal__btn--block" disabled={busy || code.length !== 6}>
                  {busy ? 'Verificando…' : 'Ver mi mensualidad'}
                </button>
                <button type="button" className="nx-portal__link nx-portal__center" onClick={() => askCode(channel)} disabled={busy}>
                  Enviar otro código
                </button>
              </form>
            )}

            {error && (
              <p className="nx-portal__formerror" role="alert">
                {error}
              </p>
            )}
          </>
        )}
      </main>
    </div>
  );
}
