import { useCallback, useEffect, useState } from 'react';
import { apiGet, apiPost, apiPut } from '../../lib/api.js';
import { formatDateTime } from '../../lib/format.js';
import Modal from '../Modal.jsx';

// Alertas del panel (RF32): abiertas, en tiempo real (el panel avisa con refreshKey), con atender o
// descartar (con nota). Configuración por sede: zona sin turno, ocupación, diferencia de arqueo y
// sede sin conexión.
export default function AlertsPanel({ sites, refreshKey }) {
  const [items, setItems] = useState(null);
  const [tab, setTab] = useState('open');
  const [resolving, setResolving] = useState(null); // { alert, action }
  const [configSite, setConfigSite] = useState(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      setItems(await apiGet(`/admin/alerts?status=${tab}`, { background: true }));
      setError('');
    } catch (err) {
      setError(err.message);
    }
  }, [tab]);

  useEffect(() => {
    load();
  }, [load, refreshKey]);

  return (
    <section className="nx-card">
      <header className="nx-card__header">
        <h2 className="nx-card__title">
          Alertas {tab === 'open' && items?.length ? <span className="nx-badge nx-badge--danger">{items.length}</span> : null}
        </h2>
        <div className="nx-actions">
          <div className="nx-tabs nx-tabs--small" role="tablist">
            <button type="button" role="tab" aria-selected={tab === 'open'} className={tab === 'open' ? 'is-active' : ''} onClick={() => setTab('open')}>Abiertas</button>
            <button type="button" role="tab" aria-selected={tab === 'closed'} className={tab === 'closed' ? 'is-active' : ''} onClick={() => setTab('closed')}>Atendidas</button>
          </div>
          {sites.length > 0 && (
            <select aria-label="Configurar alertas de la sede" value="" onChange={(e) => setConfigSite(sites.find((s) => s.id === Number(e.target.value)))}>
              <option value="">Configurar…</option>
              {sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          )}
        </div>
      </header>
      {error && <p className="nx-form__alert" role="alert">{error}</p>}
      {!items ? (
        <p className="nx-muted">Cargando…</p>
      ) : items.length === 0 ? (
        <p className="nx-muted">{tab === 'open' ? 'Sin alertas abiertas.' : 'Todavía no hay alertas atendidas.'}</p>
      ) : (
        <div>
          {items.map((a) => (
            <div key={a.id} className={`nx-alert-row${a.severity === 'DANGER' ? ' is-danger' : ''}`}>
              <span className="nx-alert-row__icon" aria-hidden="true">⚠</span>
              <div>
                <strong>{a.typeLabel}</strong> · {a.site.name}{a.zone ? ` · ${a.zone.name}` : ''}
                <div>{a.message}</div>
                <small className="nx-muted">
                  {formatDateTime(a.createdAt)}
                  {a.resolution && ` · ${a.status === 'ATTENDED' ? 'Atendida' : 'Descartada'} por ${a.resolution.by} (${formatDateTime(a.resolution.at)})${a.resolution.note ? `: ${a.resolution.note}` : ''}`}
                </small>
              </div>
              {a.status === 'OPEN' && (
                <div className="nx-actions">
                  <button type="button" className="nx-btn nx-btn--accent nx-btn--sm" onClick={() => setResolving({ alert: a, action: 'attend' })}>Atender</button>
                  <button type="button" className="nx-btn nx-btn--ghost nx-btn--sm" onClick={() => setResolving({ alert: a, action: 'dismiss' })}>Descartar</button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {resolving && (
        <ResolveAlert
          {...resolving}
          onClose={(done) => {
            setResolving(null);
            if (done) load();
          }}
        />
      )}
      {configSite && <AlertSettings site={configSite} onClose={() => setConfigSite(null)} />}
    </section>
  );
}

function ResolveAlert({ alert, action, onClose }) {
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const dismiss = action === 'dismiss';

  async function save() {
    setSaving(true);
    try {
      await apiPost(`/admin/alerts/${alert.id}/${action}`, { note });
      onClose(true);
    } catch (err) {
      setError(err.message);
      setSaving(false);
    }
  }

  return (
    <Modal
      title={`${dismiss ? 'Descartar' : 'Atender'} · ${alert.typeLabel}`}
      busy={saving}
      onClose={() => onClose(false)}
      actions={
        <>
          <button type="button" className="nx-btn nx-btn--ghost" onClick={() => onClose(false)} disabled={saving}>Cancelar</button>
          <button type="button" className="nx-btn nx-btn--accent" onClick={save} disabled={saving || (dismiss && note.trim().length < 3)}>
            {dismiss ? 'Descartar' : 'Marcar atendida'}
          </button>
        </>
      }
    >
      <p>{alert.message}</p>
      <label className="nx-form__field">
        <span>{dismiss ? 'Motivo (obligatorio)' : 'Nota (opcional)'}</span>
        <textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} autoFocus />
      </label>
      {error && <p className="nx-form__alert" role="alert">{error}</p>}
    </Modal>
  );
}

const SETTINGS = [
  ['zoneWithoutShift', 'Zona sin turno en su horario', 'graceMinutes', 'Minutos de tolerancia'],
  ['occupancy', 'Ocupación alta', 'threshold', 'Ocupación mayor que (%)'],
  ['cashDifference', 'Diferencia de arqueo', 'threshold', 'Diferencia mayor que ($)'],
  ['siteOffline', 'Sede sin conexión', 'minutes', 'Minutos sin conexión'],
];

function AlertSettings({ site, onClose }) {
  const [config, setConfig] = useState(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    apiGet(`/admin/alert-settings/${site.id}`).then((d) => setConfig(d.config)).catch((e) => setError(e.message));
  }, [site.id]);

  const set = (k, field, value) => setConfig((c) => ({ ...c, [k]: { ...c[k], [field]: value } }));

  async function save() {
    setSaving(true);
    setError('');
    const body = Object.fromEntries(SETTINGS.map(([k, , field]) => [k, { enabled: config[k].enabled, [field]: Number(config[k][field]) }]));
    try {
      await apiPut(`/admin/alert-settings/${site.id}`, body);
      onClose();
    } catch (err) {
      setError(err.message);
      setSaving(false);
    }
  }

  return (
    <Modal
      title={`Alertas · ${site.name}`}
      busy={saving}
      onClose={onClose}
      actions={
        <>
          <button type="button" className="nx-btn nx-btn--ghost" onClick={onClose} disabled={saving}>Cancelar</button>
          <button type="button" className="nx-btn nx-btn--accent" onClick={save} disabled={saving || !config}>Guardar</button>
        </>
      }
    >
      {!config ? (
        <p className="nx-muted">Cargando…</p>
      ) : (
        <div className="nx-stack nx-stack--tight">
          {SETTINGS.map(([k, label, field, fieldLabel]) => (
            <fieldset key={k} className="nx-form__fieldset">
              <legend>
                <label className="nx-check">
                  <input type="checkbox" checked={config[k].enabled} onChange={(e) => set(k, 'enabled', e.target.checked)} />
                  <span>{label}</span>
                </label>
              </legend>
              <label className="nx-form__field">
                <span>{fieldLabel}</span>
                <input type="number" min="0" value={config[k][field]} disabled={!config[k].enabled} onChange={(e) => set(k, field, e.target.value)} />
              </label>
            </fieldset>
          ))}
        </div>
      )}
      {error && <p className="nx-form__alert" role="alert">{error}</p>}
    </Modal>
  );
}
