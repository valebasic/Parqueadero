import { useCallback, useEffect, useRef, useState } from 'react';
import { apiDownload, apiGet, apiPost, apiRequest } from '../lib/api.js';
import { useSession } from '../context/SessionContext.jsx';
import { formatCOP } from '../lib/format.js';
import { useOffline } from '../context/OfflineContext.jsx';

// NexoIA (de la v1.0: agente/cliente/asistente.js). Chat flotante en todas las pantallas.
//   - AS/AG: asistente del administrador · OP: asistente operativo. El rol lo decide la API con la
//     sesión; aquí solo cambian los textos y las sugerencias.
//   - Sin internet o sin clave de Gemini se muestra "no disponible".
//   - Las acciones llegan como tarjetas: solo se ejecutan con un clic real en Confirmar, contra el
//     endpoint normal de la API, y luego se informa el resultado para la auditoría.
const SUGGESTIONS = {
  admin: ['¿Cómo estuvo el parqueadero esta semana?', '¿Cuánto ganamos en los últimos 10 días?', '¿Qué empleado hizo más registros este mes?', '¿Hay alertas?'],
  op: ['¿Qué vehículos siguen dentro?', '¿Cuánto debe pagar una placa?', '¿Cómo registro una salida?', '¿Cuáles son las tarifas?'],
};

function Robot() {
  return (
    <svg className="nxai-bot" viewBox="0 0 32 32" width="24" height="24" aria-hidden="true">
      <line x1="16" y1="4" x2="16" y2="8" stroke="#9fe8ff" strokeWidth="2" strokeLinecap="round" />
      <circle className="nxai-ant" cx="16" cy="3.5" r="2.4" fill="#ff8a3d" />
      <rect x="5" y="8" width="22" height="17" rx="6" fill="#e8f4ff" />
      <g className="nxai-eyes">
        <circle cx="12" cy="16" r="2.7" fill="#0b2748" />
        <circle cx="20" cy="16" r="2.7" fill="#0b2748" />
      </g>
      <rect x="11" y="21" width="10" height="2" rx="1" fill="#0b2748" />
    </svg>
  );
}

export default function NexoIA() {
  const { user } = useSession();
  const { online } = useOffline();
  const admin = user.role === 'AG' || user.role === 'AS';
  const [open, setOpen] = useState(false);
  const [available, setAvailable] = useState(null); // null = verificando
  const [messages, setMessages] = useState(() => [
    { id: 'hello', who: 'ai', text: admin ? 'Hola. Pregúntame por ingresos, egresos, ocupación, empleados o alertas de tus sedes.' : 'Hola. Te ayudo con vehículos dentro, valores a cobrar, tarifas y procedimientos.' },
  ]);
  const [history, setHistory] = useState([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [alertCount, setAlertCount] = useState(0);
  const listRef = useRef(null);

  useEffect(() => {
    if (!online) return;
    apiGet('/ai/status', { background: true }).then((s) => setAvailable(s.available)).catch(() => setAvailable(false));
  }, [online]);

  // Administradores: alertas abiertas del panel como aviso al abrir (como en la v1.0)
  useEffect(() => {
    if (!admin || !online) return;
    apiGet('/admin/alerts', { background: true })
      .then((list) => {
        setAlertCount(list.length);
        if (list.length) {
          setMessages((m) => (m.some((x) => x.id === 'alerts') ? m : [...m, { id: 'alerts', who: 'warn', text: `Alertas abiertas:\n- ${list.slice(0, 5).map((a) => `${a.site.name}: ${a.message}`).join('\n- ')}${list.length > 5 ? `\n… y ${list.length - 5} más en el Panel multisede.` : ''}` }]));
        }
      })
      .catch(() => {});
  }, [admin, online]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages, open]);

  const push = useCallback((msg) => setMessages((m) => [...m, { id: `${Date.now()}-${Math.random()}`, ...msg }]), []);
  const usable = online && available === true;

  async function send(question) {
    const q = question.trim();
    if (!q || busy) return;
    setInput('');
    push({ who: 'me', text: q });
    if (!usable) {
      push({ who: 'error', text: unavailableText() });
      return;
    }
    setBusy(true);
    try {
      const r = await apiPost('/ai/ask', { question: q, history });
      push({ who: 'ai', text: r.text });
      r.proposals.forEach((p) => push({ who: 'card', proposal: p, state: 'pending' }));
      setHistory((h) => [...h, { role: 'user', text: q }, { role: 'model', text: r.rawText }].slice(-6));
    } catch (err) {
      push({ who: 'error', text: err.code === 'AI_NO_KEY' || err.code === 'AI_UNAVAILABLE' ? unavailableText(err) : `No pude responder: ${err.message}` });
      if (err.code === 'AI_NO_KEY') setAvailable(false);
    } finally {
      setBusy(false);
    }
  }

  function unavailableText(err) {
    if (!online) return 'NexoIA no está disponible sin internet. Revisa la conexión e inténtalo de nuevo.';
    if (err?.code === 'AI_UNAVAILABLE') return 'NexoIA no está disponible en este momento. Inténtalo más tarde.';
    return admin ? 'NexoIA no está disponible: falta configurar GEMINI_API_KEY en el servidor.' : 'NexoIA no está disponible. Avisa al administrador.';
  }

  function updateCard(id, patch) {
    setMessages((m) => m.map((x) => (x.who === 'card' && x.proposal.id === id ? { ...x, ...patch } : x)));
  }

  async function confirm(card, consent, event) {
    if (!event?.isTrusted) return; // solo un clic real de la persona
    const p = card.proposal;
    updateCard(p.id, { state: 'running' });
    try {
      if (p.request.download) await apiDownload(p.request.path, p.request.download);
      else await apiRequest(p.request.method, p.request.path, { body: { ...p.request.body, ...(p.needsConsent && consent ? { dataConsent: true } : {}) } });
      updateCard(p.id, { state: 'done' });
      await apiPost(`/ai/proposals/${p.id}/resolve`, { outcome: 'CONFIRMED' }).catch(() => {});
      push({ who: 'ok', text: `Listo: ${p.title}.` });
      setHistory((h) => [...h, { role: 'user', text: `[Sistema] La persona confirmó la acción "${p.title}".` }, { role: 'model', text: 'Acción realizada.' }].slice(-6));
    } catch (err) {
      updateCard(p.id, { state: 'failed' });
      await apiPost(`/ai/proposals/${p.id}/resolve`, { outcome: 'FAILED', error: err.message }).catch(() => {});
      push({ who: 'error', text: `No se completó: ${err.message}` });
    }
  }

  async function cancel(card) {
    updateCard(card.proposal.id, { state: 'cancelled' });
    await apiPost(`/ai/proposals/${card.proposal.id}/resolve`, { outcome: 'CANCELLED' }).catch(() => {});
    push({ who: 'ai', text: 'Acción cancelada. No se hizo ningún cambio.' });
  }

  return (
    <>
      <button type="button" className={`nxai-btn${open ? ' is-open' : ''}`} onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-controls="nxai-panel">
        <Robot />
        <span>NexoIA</span>
        {alertCount > 0 && !open && <span className="nxai-badge" aria-label={`${alertCount} alertas`}>{alertCount}</span>}
      </button>
      {open && (
        <section id="nxai-panel" className="nxai-panel" aria-label="NexoIA">
          <header className="nxai-head">
            <span>{admin ? 'Asistente del administrador' : 'Asistente operativo'}</span>
            <span className={`nxai-state ${usable ? 'is-on' : 'is-off'}`}>{available === null && online ? 'Verificando…' : usable ? 'Disponible' : 'No disponible'}</span>
            <button type="button" onClick={() => setOpen(false)} aria-label="Cerrar NexoIA">×</button>
          </header>
          <div className="nxai-msgs" ref={listRef} aria-live="polite">
            {messages.map((m) =>
              m.who === 'card' ? (
                <ProposalCard key={m.id} card={m} onConfirm={confirm} onCancel={cancel} />
              ) : (
                <div key={m.id} className={`nxai-msg nxai-msg--${m.who}`}>{m.text}</div>
              ),
            )}
            {busy && <div className="nxai-msg nxai-msg--ai nxai-msg--busy">Pensando…</div>}
            {!usable && available !== null && <div className="nxai-msg nxai-msg--error">{unavailableText()}</div>}
          </div>
          {history.length === 0 && usable && (
            <div className="nxai-sugs">
              {(admin ? SUGGESTIONS.admin : SUGGESTIONS.op).map((s) => (
                <button key={s} type="button" onClick={() => send(s)}>{s}</button>
              ))}
            </div>
          )}
          <form className="nxai-form" onSubmit={(e) => { e.preventDefault(); send(input); }}>
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              maxLength={500}
              disabled={!usable || busy}
              placeholder={admin ? 'Pregunta sobre tus sedes…' : 'Pregunta sobre un vehículo o un procedimiento…'}
              aria-label="Pregunta para NexoIA"
            />
            <button type="submit" disabled={!usable || busy || !input.trim()}>Enviar</button>
          </form>
        </section>
      )}
    </>
  );
}

const RISK = { bajo: 'Riesgo bajo', medio: 'Riesgo medio', alto: 'Riesgo alto' };

function ProposalCard({ card, onConfirm, onCancel }) {
  const p = card.proposal;
  const [consent, setConsent] = useState(false);
  const pending = card.state === 'pending';
  const stateText = { running: 'Ejecutando…', done: 'Confirmada', failed: 'No se completó', cancelled: 'Cancelada' }[card.state];
  return (
    <div className="nxai-card">
      <div className="nxai-card__head">
        <strong>{p.title}</strong>
        <span className={`nxai-risk nxai-risk--${p.risk}`}>{RISK[p.risk]}</span>
      </div>
      <ul>
        {p.details.map((d) => <li key={d}>{d}</li>)}
      </ul>
      {p.comparison && (
        <table className="nxai-compare">
          <thead>
            <tr>
              <th scope="col"><span className="nx-sr-only">Valor</span></th>
              {p.comparison.columns.map((c) => <th key={c} scope="col">{c}</th>)}
            </tr>
          </thead>
          <tbody>
            {p.comparison.rows.map((r) => (
              <tr key={r.label} className={r.changed ? 'is-changed' : ''}>
                <th scope="row">{r.label}</th>
                <td>{formatCOP(r.current)}</td>
                <td>{formatCOP(r.next)}{r.changed && <span className="nx-sr-only"> (cambia)</span>}</td>
              </tr>
            ))}
            <tr className="nxai-compare__validity">
              <th scope="row">Vigencia</th>
              <td>{p.comparison.validity.current}</td>
              <td>{p.comparison.validity.next}</td>
            </tr>
          </tbody>
        </table>
      )}
      {p.needsConsent && pending && (
        <label className="nx-check nxai-consent">
          <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
          <span>El titular autoriza el tratamiento de sus datos personales</span>
        </label>
      )}
      {pending ? (
        <div className="nxai-card__actions">
          <button type="button" className="nxai-ok" disabled={p.needsConsent && !consent} onClick={(e) => onConfirm(card, consent, e)}>Confirmar</button>
          <button type="button" className="nxai-no" onClick={() => onCancel(card)}>Cancelar</button>
        </div>
      ) : (
        <span className="nxai-card__state">{stateText}</span>
      )}
    </div>
  );
}
