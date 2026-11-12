import { useCallback, useEffect, useState } from 'react';
import { apiGet, apiPost } from '../lib/api.js';
import { useWorkingSite } from '../context/ShiftContext.jsx';
import { useSiteEvents } from '../context/RealtimeContext.jsx';
import Modal from '../components/Modal.jsx';
import { formatCOP, formatDateTime, PAYMENT_LABELS } from '../lib/format.js';

// Bandeja de conflictos de sincronización (RF62): operaciones hechas sin conexión que no se pudieron
// aplicar. AS/AG las resuelven a mano (aplicar o descartar) con una nota; todo queda en auditoría.
const KIND = { ENTRY: 'Entrada', EXIT: 'Salida' };

function detailText(c) {
  const d = c.conflict.detail ?? {};
  switch (c.conflict.code) {
    case 'PLATE_OPEN_ELSEWHERE':
    case 'PLATE_ALREADY_INSIDE':
      return `Abierta en ${d.site ?? 'esta sede'} con recibo ${d.receipt ?? '—'} desde ${d.entryAt ? formatDateTime(d.entryAt) : '—'} · aplicar anula esa entrada.`;
    case 'MONTHLY_ACTIVE':
      return `Mensualidad de ${d.clientName ?? '—'}. Aplicar la registra como entrada normal (con cobro).`;
    case 'ALREADY_EXITED':
      return `Ya salió (recibo ${d.receipt}) cobrando ${formatCOP(d.existingCharged)}; sin conexión se cobró ${formatCOP(d.offlineCharged)}. Solo se puede descartar.`;
    case 'ENTRY_IN_CONFLICT':
      return 'Resuelva primero su entrada; luego aplique esta salida.';
    case 'REGISTER_CLOSED':
      return `La caja de ese turno ya cerró. Elija la caja abierta donde entra el cobro de ${formatCOP(d.charged)}.`;
    default:
      return d.reason ?? '';
  }
}

export default function ConflictsPage() {
  const { siteId, sites, setSiteId } = useWorkingSite();
  const [tab, setTab] = useState('open');
  const [items, setItems] = useState(null);
  const [error, setError] = useState('');
  const [resolving, setResolving] = useState(null); // { item, action }

  const load = useCallback(async () => {
    if (!siteId) return;
    try {
      setItems(await apiGet(`/sync/conflicts?siteId=${siteId}&status=${tab}`));
      setError('');
    } catch (err) {
      setError(err.message);
    }
  }, [siteId, tab]);

  useEffect(() => {
    load();
  }, [load]);
  useSiteEvents(siteId, ['sync:conflict', 'sync:conflict-resolved'], () => load());

  return (
    <div className="nx-stack">
      <section className="nx-card nx-card--tabs">
        <div className="nx-tabs" role="tablist">
          <button type="button" role="tab" aria-selected={tab === 'open'} className={tab === 'open' ? 'is-active' : ''} onClick={() => setTab('open')}>Por resolver</button>
          <button type="button" role="tab" aria-selected={tab === 'resolved'} className={tab === 'resolved' ? 'is-active' : ''} onClick={() => setTab('resolved')}>Resueltos</button>
        </div>
        {sites.length > 1 && (
          <label className="nx-form__field nx-form__field--inline">
            <span>Sede</span>
            <select value={siteId ?? ''} onChange={(e) => setSiteId(Number(e.target.value))}>
              {sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </label>
        )}
      </section>

      {error && <div className="nx-banner nx-banner--error" role="alert">{error}</div>}

      <section className="nx-card">
        <p className="nx-muted nx-small">
          Operaciones registradas sin conexión que el servidor no pudo aplicar al sincronizar. Nada se descarta solo:
          cada una se resuelve a mano, con una nota, y queda en auditoría.
        </p>
        {!items ? (
          <p className="nx-muted">Cargando…</p>
        ) : items.length === 0 ? (
          <p className="nx-muted">{tab === 'open' ? 'No hay conflictos por resolver.' : 'Todavía no hay conflictos resueltos.'}</p>
        ) : (
          <div className="nx-table-wrap">
            <table className="nx-table">
              <thead>
                <tr>
                  <th>Hora (dispositivo)</th>
                  <th>Operación</th>
                  <th>Placa</th>
                  <th>Operador</th>
                  <th>Conflicto</th>
                  <th aria-label={tab === 'open' ? 'Acciones' : 'Resolución'} />
                </tr>
              </thead>
              <tbody>
                {items.map((c) => (
                  <tr key={c.id}>
                    <td>{formatDateTime(c.clientTs)}</td>
                    <td>
                      {KIND[c.kind]}
                      {c.provisionalReceipt && <div className="nx-muted nx-small">{c.provisionalReceipt}</div>}
                      {c.kind === 'EXIT' && c.paymentMethod && (
                        <div className="nx-muted nx-small">{PAYMENT_LABELS[c.paymentMethod]} · {formatCOP(c.chargedAmount)}</div>
                      )}
                    </td>
                    <td><strong>{c.plate ?? '—'}</strong></td>
                    <td>{c.operator}<div className="nx-muted nx-small">Equipo {c.deviceId}</div></td>
                    <td>
                      <span className="nx-badge nx-badge--danger nx-badge--wrap">{c.conflict.message}</span>
                      <div className="nx-small">{detailText(c)}</div>
                    </td>
                    <td className="nx-actions">
                      {tab === 'open' ? (
                        <>
                          {c.conflict.canApply && (
                            <button type="button" className="nx-btn nx-btn--accent nx-btn--sm" onClick={() => setResolving({ item: c, action: 'apply' })}>Aplicar</button>
                          )}
                          <button type="button" className="nx-btn nx-btn--ghost nx-btn--sm" onClick={() => setResolving({ item: c, action: 'discard' })}>Descartar</button>
                        </>
                      ) : (
                        <div className="nx-small nx-left">
                          <strong>{c.resolution.applied ? 'Aplicada' : 'Descartada'}</strong>
                          {c.entryReceipt ? ` · ${c.entryReceipt}` : ''}
                          <div>{c.resolution.by} · {formatDateTime(c.resolution.at)}</div>
                          <div className="nx-muted">{c.resolution.note}</div>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {resolving && (
        <ResolveModal
          siteId={siteId}
          item={resolving.item}
          action={resolving.action}
          onClose={(done) => {
            setResolving(null);
            if (done) load();
          }}
        />
      )}
    </div>
  );
}

function ResolveModal({ siteId, item, action, onClose }) {
  const [note, setNote] = useState('');
  const [shiftId, setShiftId] = useState('');
  const [shifts, setShifts] = useState([]);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const needsShift = action === 'apply' && item.conflict.needsShift;

  useEffect(() => {
    if (needsShift) apiGet(`/shifts/open?siteId=${siteId}`).then(setShifts).catch(() => {});
  }, [needsShift, siteId]);

  async function save() {
    setSaving(true);
    setError('');
    try {
      await apiPost(`/sync/conflicts/${item.id}/resolve`, { action, note, shiftId: shiftId ? Number(shiftId) : undefined });
      onClose(true);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      title={`${action === 'apply' ? 'Aplicar' : 'Descartar'} · ${KIND[item.kind]} ${item.plate ?? ''}`}
      busy={saving}
      onClose={() => onClose(false)}
      actions={
        <>
          <button type="button" className="nx-btn nx-btn--ghost" onClick={() => onClose(false)} disabled={saving}>Cancelar</button>
          <button type="button" className="nx-btn nx-btn--accent" onClick={save} disabled={saving || note.trim().length < 5 || (needsShift && !shiftId)}>
            {saving ? 'Guardando…' : action === 'apply' ? 'Aplicar' : 'Descartar'}
          </button>
        </>
      }
    >
      <p className="nx-muted">{item.conflict.message}. {detailText(item)}</p>
      {needsShift && (
        <label className="nx-form__field">
          <span>Caja (turno abierto) donde entra el cobro</span>
          <select value={shiftId} onChange={(e) => setShiftId(e.target.value)}>
            <option value="">{shifts.length ? 'Seleccione' : 'No hay turnos abiertos'}</option>
            {shifts.map((s) => <option key={s.id} value={s.id}>{s.zone.name} · {s.user.fullName}</option>)}
          </select>
        </label>
      )}
      <label className="nx-form__field">
        <span>Nota (obligatoria, queda en auditoría)</span>
        <textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} autoFocus />
      </label>
      {error && <p className="nx-form__alert" role="alert">{error}</p>}
    </Modal>
  );
}
