import { useCallback, useEffect, useState } from 'react';
import { apiDelete, apiDownload, apiGet, apiPatch, apiPost } from '../lib/api.js';
import { useSession } from '../context/SessionContext.jsx';
import { useWorkingSite } from '../context/ShiftContext.jsx';
import { ReceiptTicket } from '../components/Receipt.jsx';
import { formatCOP, formatDateTime } from '../lib/format.js';
import { VEHICLE_LABELS } from '../lib/plates.js';

// Configuración (RF23-RF25): tarifas con vigencia, datos del local, recibos y respaldos (solo AG).
export default function ConfigPage() {
  const { user } = useSession();
  const { siteId, sites, setSiteId } = useWorkingSite();
  const [tab, setTab] = useState('rates');
  const tabs = [
    ['rates', 'Tarifas'],
    ['site', 'Información del local'],
    ['receipts', 'Recibos'],
    ...(user.role === 'AG' ? [['backups', 'Respaldos']] : []),
  ];
  return (
    <div className="nx-stack">
      <section className="nx-card nx-card--tabs">
        <div className="nx-tabs" role="tablist">
          {tabs.map(([id, label]) => (
            <button key={id} type="button" role="tab" aria-selected={tab === id} className={tab === id ? 'is-active' : ''} onClick={() => setTab(id)}>
              {label}
            </button>
          ))}
        </div>
        {sites.length > 1 && tab !== 'backups' && (
          <label className="nx-form__field nx-form__field--inline">
            <span>Sede</span>
            <select value={siteId ?? ''} onChange={(e) => setSiteId(Number(e.target.value))}>
              {sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </label>
        )}
      </section>
      {siteId && tab === 'rates' && <RatesTab siteId={siteId} />}
      {siteId && (tab === 'site' || tab === 'receipts') && <SettingsTab siteId={siteId} receipts={tab === 'receipts'} />}
      {tab === 'backups' && <BackupsTab />}
    </div>
  );
}

// ---------------------------------------------------------------------------
const EMPTY_RATE = { vehicleType: 'CAR', pricingMode: 'normal', fractionAmount: '', hourAmount: '', full12hAmount: '', monthlyAmount: '', validFrom: '' };

function RatesTab({ siteId }) {
  const [rates, setRates] = useState(null);
  const [form, setForm] = useState(EMPTY_RATE);
  const [msg, setMsg] = useState(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(() => apiGet(`/config/${siteId}/rates`).then(setRates).catch((e) => setMsg({ type: 'error', text: e.message })), [siteId]);
  useEffect(() => {
    load();
  }, [load]);

  function prefill(type) {
    const cur = rates?.current.find((r) => r.vehicleType === type);
    setForm({
      ...EMPTY_RATE,
      vehicleType: type,
      pricingMode: cur?.pricingMode ?? 'normal',
      fractionAmount: String(cur?.fractionAmount ?? ''),
      hourAmount: String(cur?.hourAmount ?? ''),
      full12hAmount: String(cur?.full12hAmount ?? ''),
      monthlyAmount: String(cur?.monthlyAmount ?? ''),
    });
  }

  async function save() {
    setSaving(true);
    setMsg(null);
    try {
      const num = (v) => Number(v || 0);
      await apiPost(`/config/${siteId}/rates`, {
        vehicleType: form.vehicleType,
        pricingMode: form.pricingMode,
        fractionAmount: num(form.fractionAmount),
        hourAmount: num(form.hourAmount),
        full12hAmount: num(form.full12hAmount),
        monthlyAmount: num(form.monthlyAmount),
        validFrom: form.validFrom ? new Date(form.validFrom).toISOString() : undefined,
      });
      setMsg({ type: 'ok', text: form.validFrom ? 'Tarifa programada.' : 'Tarifa aplicada desde ya.' });
      setForm(EMPTY_RATE);
      load();
    } catch (e) {
      setMsg({ type: 'error', text: e.message });
    } finally {
      setSaving(false);
    }
  }

  async function cancel(rate) {
    if (!window.confirm(`¿Cancelar la tarifa programada de ${rate.vehicleLabel}?`)) return;
    try {
      await apiDelete(`/config/${siteId}/rates/${rate.id}`);
      load();
    } catch (e) {
      setMsg({ type: 'error', text: e.message });
    }
  }

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: k.endsWith('Amount') ? e.target.value.replace(/\D/g, '') : e.target.value }));
  const RateRow = ({ r, action }) => (
    <tr>
      <td>{r.vehicleLabel}</td>
      <td>{r.pricingMode === 'block12h' ? 'Por bloques de 12 h' : 'Normal'}</td>
      <td className="nx-num">{formatCOP(r.fractionAmount)}</td>
      <td className="nx-num">{formatCOP(r.hourAmount)}</td>
      <td className="nx-num">{formatCOP(r.full12hAmount)}</td>
      <td className="nx-num">{formatCOP(r.monthlyAmount)}</td>
      <td>{formatDateTime(r.validFrom)}{r.validTo ? ` → ${formatDateTime(r.validTo)}` : ''}</td>
      <td>{action}</td>
    </tr>
  );
  const head = (
    <thead>
      <tr><th>Vehículo</th><th>Modo</th><th className="nx-num">Fracción</th><th className="nx-num">Hora</th><th className="nx-num">12 h</th><th className="nx-num">Mensualidad</th><th>Vigencia</th><th aria-label="Acciones" /></tr>
    </thead>
  );

  return (
    <>
      {msg && <div className={`nx-banner nx-banner--${msg.type}`} role="status">{msg.text}</div>}
      <section className="nx-card">
        <h2 className="nx-card__title nx-card__title--spaced">Tarifas vigentes</h2>
        <div className="nx-table-wrap">
          <table className="nx-table">
            {head}
            <tbody>
              {rates?.current.map((r) => (
                <RateRow key={r.id} r={r} action={<button type="button" className="nx-btn nx-btn--ghost nx-btn--sm" onClick={() => prefill(r.vehicleType)}>Cambiar</button>} />
              ))}
            </tbody>
          </table>
        </div>
        <p className="nx-muted nx-small">1 a 45 min = fracción; 46 a 60 min = hora; por bloques de 12 h se cobra la tarifa plena si la normal la alcanza. "Por bloques de 12 h" (ciclas) cobra la tarifa plena por cada bloque iniciado.</p>
      </section>

      <section className="nx-card">
        <h2 className="nx-card__title nx-card__title--spaced">Nueva tarifa</h2>
        <div className="nx-form__grid">
          <label className="nx-form__field">
            <span>Vehículo</span>
            <select value={form.vehicleType} onChange={(e) => prefill(e.target.value)}>
              {Object.entries(VEHICLE_LABELS).map(([id, l]) => <option key={id} value={id}>{l}</option>)}
            </select>
          </label>
          <label className="nx-form__field">
            <span>Modo de cobro</span>
            <select value={form.pricingMode} onChange={set('pricingMode')}>
              <option value="normal">Normal (fracción / hora / tope 12 h)</option>
              <option value="block12h">Por bloques de 12 h</option>
            </select>
          </label>
          {form.pricingMode === 'normal' && (
            <>
              <label className="nx-form__field"><span>Fracción (1–45 min)</span><input inputMode="numeric" value={form.fractionAmount} onChange={set('fractionAmount')} /></label>
              <label className="nx-form__field"><span>Hora</span><input inputMode="numeric" value={form.hourAmount} onChange={set('hourAmount')} /></label>
            </>
          )}
          <label className="nx-form__field"><span>Tarifa plena 12 h</span><input inputMode="numeric" value={form.full12hAmount} onChange={set('full12hAmount')} /></label>
          <label className="nx-form__field"><span>Mensualidad</span><input inputMode="numeric" value={form.monthlyAmount} onChange={set('monthlyAmount')} /></label>
          <label className="nx-form__field"><span>Vigente desde (vacío = ya)</span><input type="datetime-local" value={form.validFrom} onChange={set('validFrom')} /></label>
        </div>
        <div className="nx-form__actions">
          <button type="button" className="nx-btn nx-btn--accent" onClick={save} disabled={saving}>
            {saving ? 'Guardando…' : form.validFrom ? 'Programar tarifa' : 'Aplicar desde ya'}
          </button>
        </div>
      </section>

      {rates?.scheduled.length > 0 && (
        <section className="nx-card">
          <h2 className="nx-card__title nx-card__title--spaced">Programadas</h2>
          <div className="nx-table-wrap">
            <table className="nx-table">
              {head}
              <tbody>
                {rates.scheduled.map((r) => (
                  <RateRow key={r.id} r={r} action={<button type="button" className="nx-btn nx-btn--ghost nx-btn--sm nx-btn--danger-text" onClick={() => cancel(r)}>Cancelar</button>} />
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {rates?.history.length > 0 && (
        <section className="nx-card">
          <h2 className="nx-card__title nx-card__title--spaced">Historial</h2>
          <div className="nx-table-wrap">
            <table className="nx-table">
              {head}
              <tbody>{rates.history.map((r) => <RateRow key={r.id} r={r} action={r.createdBy ?? ''} />)}</tbody>
            </table>
          </div>
        </section>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
const FIELD_LABELS = { business: 'Datos del negocio', vehicle: 'Servicio', duration: 'Tiempo', operator: 'Quién atendió', qr: 'Código QR', hours: 'Horario de atención' };
const LABEL_KEYS = { plate: 'Placa', vehicle: 'Servicio', entry: 'Entrada', exit: 'Salida', duration: 'Tiempo', total: 'Total', payment: 'Pago', receipt: 'Recibo', operator: 'Atendió' };
const TYPE_TABS = [['entry', 'Entrada'], ['exit', 'Salida / pago'], ['monthly', 'Mensualidad']];

function sampleReceipt(type, settings) {
  const now = new Date();
  const before = new Date(now.getTime() - 125 * 60000);
  const business = { name: settings.name, legalId: settings.legalId, address: settings.address, phone: settings.phone, hours: settings.businessHours };
  const common = { business, config: settings.receiptConfig, plate: 'ABC123', vehicleLabel: 'Carro', operator: 'Operador de ejemplo', qrUrl: null };
  if (type === 'entry') return { ...common, type: 'ENTRY', entryAt: before, receipt: `${settings.receiptPrefix}105` };
  if (type === 'exit') {
    return { ...common, type: 'EXIT', entryAt: before, exitAt: now, minutes: 125, calculatedAmount: 8400, discountAmount: 0, chargedAmount: 8400, paymentMethod: 'CASH', paymentLabel: 'Efectivo', receipt: `${settings.receiptPrefix}105` };
  }
  return { ...common, type: 'MONTHLY', clientName: 'Ana Pérez', periodStart: '2026-11-01', periodEnd: '2026-12-01', baseAmount: 130000, discountAmount: 0, chargedAmount: 130000, paymentMethod: 'CASH', paymentLabel: 'Efectivo', paidAt: now, receipt: `${settings.monthlyReceiptPrefix}12` };
}

function SettingsTab({ siteId, receipts }) {
  const [s, setS] = useState(null);
  const [msg, setMsg] = useState(null);
  const [saving, setSaving] = useState(false);
  const [previewType, setPreviewType] = useState('exit');

  useEffect(() => {
    apiGet(`/config/${siteId}/settings`).then(setS).catch((e) => setMsg({ type: 'error', text: e.message }));
  }, [siteId]);

  if (!s) return msg ? <div className="nx-banner nx-banner--error">{msg.text}</div> : <p className="nx-muted">Cargando…</p>;

  const set = (k) => (e) => setS((x) => ({ ...x, [k]: e.target.value }));
  const cfg = s.receiptConfig;
  const setCfg = (next) => setS((x) => ({ ...x, receiptConfig: next }));
  const isShown = (type, field) => cfg[type]?.show?.[field] !== false;

  async function save() {
    setSaving(true);
    setMsg(null);
    try {
      const body = receipts
        ? { receiptConfig: cfg, businessHours: s.businessHours }
        : {
            name: s.name, legalId: s.legalId, phone: s.phone, address: s.address, city: s.city, businessHours: s.businessHours,
            capacity: s.capacity === '' || s.capacity == null ? null : Number(s.capacity),
            opExpenseLimit: Number(s.opExpenseLimit || 0),
          };
      if (body.capacity === null) delete body.capacity;
      setS(await apiPatch(`/config/${siteId}/settings`, body));
      setMsg({ type: 'ok', text: 'Cambios guardados.' });
    } catch (e) {
      setMsg({ type: 'error', text: e.message });
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      {msg && <div className={`nx-banner nx-banner--${msg.type}`} role="status">{msg.text}</div>}
      {!receipts ? (
        <section className="nx-card">
          <div className="nx-form__grid">
            <label className="nx-form__field"><span>Nombre del local</span><input value={s.name ?? ''} onChange={set('name')} /></label>
            <label className="nx-form__field"><span>NIT</span><input value={s.legalId ?? ''} onChange={set('legalId')} /></label>
            <label className="nx-form__field"><span>Teléfono</span><input value={s.phone ?? ''} onChange={set('phone')} /></label>
            <label className="nx-form__field"><span>Dirección</span><input value={s.address ?? ''} onChange={set('address')} /></label>
            <label className="nx-form__field"><span>Ciudad</span><input value={s.city ?? ''} onChange={set('city')} /></label>
            <label className="nx-form__field"><span>Capacidad (cupos)</span><input inputMode="numeric" value={s.capacity ?? ''} onChange={(e) => setS((x) => ({ ...x, capacity: e.target.value.replace(/\D/g, '') }))} /></label>
            <label className="nx-form__field"><span>Tope de un egreso registrado por un operador</span><input inputMode="numeric" value={s.opExpenseLimit ?? ''} onChange={(e) => setS((x) => ({ ...x, opExpenseLimit: e.target.value.replace(/\D/g, '') }))} /></label>
          </div>
          <label className="nx-form__field">
            <span>Horario de atención (sale en los recibos)</span>
            <textarea rows={2} value={s.businessHours ?? ''} onChange={set('businessHours')} maxLength={300} />
          </label>
          <p className="nx-muted nx-small">Prefijos de recibo: {s.receiptPrefix} (entradas) · {s.monthlyReceiptPrefix} (mensualidades).</p>
          <div className="nx-form__actions">
            <button type="button" className="nx-btn nx-btn--accent" onClick={save} disabled={saving}>{saving ? 'Guardando…' : 'Guardar'}</button>
          </div>
        </section>
      ) : (
        <div className="nx-grid-2">
          <section className="nx-card">
            <div className="nx-tabs nx-tabs--small" role="tablist">
              {TYPE_TABS.map(([id, label]) => (
                <button key={id} type="button" role="tab" aria-selected={previewType === id} className={previewType === id ? 'is-active' : ''} onClick={() => setPreviewType(id)}>{label}</button>
              ))}
            </div>
            <fieldset className="nx-form__fieldset">
              <legend>Campos visibles en el recibo de {TYPE_TABS.find(([id]) => id === previewType)[1].toLowerCase()}</legend>
              <div className="nx-checks">
                {Object.entries(FIELD_LABELS).map(([field, label]) => (
                  <label key={field} className="nx-check">
                    <input
                      type="checkbox"
                      checked={isShown(previewType, field)}
                      onChange={(e) => setCfg({ ...cfg, [previewType]: { show: { ...(cfg[previewType]?.show ?? {}), [field]: e.target.checked } } })}
                    />
                    <span>{label}</span>
                  </label>
                ))}
              </div>
            </fieldset>
            <fieldset className="nx-form__fieldset">
              <legend>Etiquetas</legend>
              <div className="nx-form__grid nx-form__grid--dense">
                {Object.entries(LABEL_KEYS).map(([k, def]) => (
                  <label key={k} className="nx-form__field">
                    <span>{def}</span>
                    <input value={cfg.labels?.[k] ?? ''} placeholder={def} maxLength={24} onChange={(e) => setCfg({ ...cfg, labels: { ...cfg.labels, [k]: e.target.value } })} />
                  </label>
                ))}
              </div>
            </fieldset>
            <label className="nx-form__field">
              <span>Mensaje del tiquete de entrada</span>
              <input value={cfg.entryMessage ?? ''} placeholder="Conserve este tiquete para retirar su vehículo" maxLength={300} onChange={(e) => setCfg({ ...cfg, entryMessage: e.target.value })} />
            </label>
            <label className="nx-form__field">
              <span>Mensaje del recibo de pago</span>
              <input value={cfg.message ?? ''} placeholder="¡Gracias por su visita!" maxLength={300} onChange={(e) => setCfg({ ...cfg, message: e.target.value })} />
            </label>
            <label className="nx-form__field">
              <span>Mensaje del recibo de mensualidad</span>
              <input value={cfg.monthlyMessage ?? ''} placeholder="Gracias por su pago" maxLength={300} onChange={(e) => setCfg({ ...cfg, monthlyMessage: e.target.value })} />
            </label>
            <label className="nx-form__field">
              <span>Horario de atención</span>
              <textarea rows={2} value={s.businessHours ?? ''} onChange={set('businessHours')} maxLength={300} />
            </label>
            <div className="nx-form__actions">
              <button type="button" className="nx-btn nx-btn--accent" onClick={save} disabled={saving}>{saving ? 'Guardando…' : 'Guardar recibos'}</button>
            </div>
          </section>
          <section className="nx-card">
            <h2 className="nx-card__title nx-card__title--spaced">Vista previa</h2>
            <div className="rc-preview">
              <ReceiptTicket data={sampleReceipt(previewType, s)} qr={null} />
            </div>
            <p className="nx-muted nx-small">El QR se agrega al imprimir los recibos reales.</p>
          </section>
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
function BackupsTab() {
  const [list, setList] = useState(null);
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => apiGet('/backups').then(setList).catch((e) => setMsg({ type: 'error', text: e.message })), []);
  useEffect(() => {
    load();
  }, [load]);

  async function create() {
    setBusy(true);
    setMsg(null);
    try {
      const b = await apiPost('/backups');
      setMsg({ type: 'ok', text: `Respaldo ${b.name} creado.` });
      load();
    } catch (e) {
      setMsg({ type: 'error', text: e.message });
    } finally {
      setBusy(false);
    }
  }

  const size = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.ceil(n / 1024)} KB`);

  return (
    <section className="nx-card">
      <header className="nx-card__header">
        <div>
          <h2 className="nx-card__title">Respaldos de la base de datos</h2>
          <p className="nx-muted nx-card__subtitle">pg_dump diario a la hora configurada en el servidor (BACKUP_HOUR). Se restaura con pg_restore.</p>
        </div>
        <button type="button" className="nx-btn nx-btn--accent" onClick={create} disabled={busy}>{busy ? 'Creando…' : 'Crear respaldo ahora'}</button>
      </header>
      {msg && <div className={`nx-banner nx-banner--${msg.type}`} role="status">{msg.text}</div>}
      {!list ? (
        <p className="nx-muted">Cargando…</p>
      ) : list.length === 0 ? (
        <p className="nx-muted">Todavía no hay respaldos.</p>
      ) : (
        <div className="nx-table-wrap">
          <table className="nx-table">
            <thead><tr><th>Archivo</th><th>Fecha</th><th className="nx-num">Tamaño</th><th aria-label="Descargar" /></tr></thead>
            <tbody>
              {list.map((b) => (
                <tr key={b.name}>
                  <td>{b.name}</td>
                  <td>{formatDateTime(b.createdAt)}</td>
                  <td className="nx-num">{size(b.size)}</td>
                  <td><button type="button" className="nx-btn nx-btn--ghost nx-btn--sm" onClick={() => apiDownload(`/backups/${encodeURIComponent(b.name)}/download`, b.name).catch((e) => setMsg({ type: 'error', text: e.message }))}>Descargar</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
