import { useCallback, useEffect, useMemo, useState } from 'react';
import { apiGet, apiPatch, apiPost } from '../lib/api.js';
import { useWorkingSite } from '../context/ShiftContext.jsx';
import Modal from '../components/Modal.jsx';

// Horarios programados (RF30): quién atiende cada zona, por día de la semana.
// La asignación de personas a sedes se hace en Usuarios; aquí se programa zona y horario.
const DAYS = [
  [1, 'Lunes'],
  [2, 'Martes'],
  [3, 'Miércoles'],
  [4, 'Jueves'],
  [5, 'Viernes'],
  [6, 'Sábado'],
  [7, 'Domingo'],
];

// "19:00" → "7:00 p. m."
function hm12(hm) {
  const [h, m] = hm.split(':').map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'a. m.' : 'p. m.'}`;
}

export default function SchedulesPage() {
  const { siteId, sites, setSiteId } = useWorkingSite();
  const [items, setItems] = useState(null);
  const [site, setSite] = useState(null);
  const [people, setPeople] = useState([]);
  const [showInactive, setShowInactive] = useState(false);
  const [editing, setEditing] = useState(null); // 'new' | schedule
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    if (!siteId) return;
    try {
      const [list, s, users] = await Promise.all([
        apiGet(`/admin/schedules?siteId=${siteId}${showInactive ? '&includeInactive=1' : ''}`),
        apiGet(`/sites/${siteId}`),
        apiGet('/users'),
      ]);
      setItems(list);
      setSite(s);
      setPeople(users.filter((u) => u.isActive && (u.role === 'AG' || u.sites?.some((x) => x.id === siteId))));
      setError('');
    } catch (err) {
      setError(err.message);
    }
  }, [siteId, showInactive]);

  useEffect(() => {
    load();
  }, [load]);

  const byDay = useMemo(() => DAYS.map(([d, label]) => ({ day: d, label, list: (items ?? []).filter((s) => s.weekday === d) })), [items]);

  async function toggle(s) {
    try {
      await apiPatch(`/admin/schedules/${s.id}`, { isActive: !s.isActive });
      load();
    } catch (err) {
      window.alert(err.message);
    }
  }

  return (
    <div className="nx-stack">
      <section className="nx-card nx-card--tabs">
        {sites.length > 1 ? (
          <label className="nx-form__field nx-form__field--inline">
            <span>Sede</span>
            <select value={siteId ?? ''} onChange={(e) => setSiteId(Number(e.target.value))}>
              {sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </label>
        ) : <strong>{site?.name}</strong>}
        <label className="nx-check">
          <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
          <span>Ver desactivados</span>
        </label>
        <button type="button" className="nx-btn nx-btn--accent" onClick={() => setEditing('new')} disabled={!site}>Programar horario</button>
      </section>

      {error && <div className="nx-banner nx-banner--error" role="alert">{error}</div>}
      {!items ? (
        <p className="nx-muted">Cargando…</p>
      ) : (
        <section className="nx-card">
          <p className="nx-muted nx-small">
            Un horario que termina antes de la hora de inicio sigue hasta el día siguiente. Las personas se asignan a la sede en Usuarios.
          </p>
          <div className="nx-week">
            {byDay.map((d) => (
              <div key={d.day} className="nx-week__day">
                <h3>{d.label}</h3>
                {d.list.length === 0 && <p className="nx-muted nx-small">Sin horarios</p>}
                {d.list.map((s) => (
                  <div key={s.id} className={`nx-week__slot${s.isActive ? '' : ' is-off'}`}>
                    <strong>{hm12(s.startTime)} – {hm12(s.endTime)}{s.overnight ? ' (+1)' : ''}</strong>
                    <span>{s.user.fullName}</span>
                    <small className="nx-muted">{s.zone.name}</small>
                    <div className="nx-week__actions">
                      <button type="button" className="nx-linkbtn" onClick={() => setEditing(s)}>Editar</button>
                      <button type="button" className="nx-linkbtn" onClick={() => toggle(s)}>{s.isActive ? 'Desactivar' : 'Activar'}</button>
                    </div>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </section>
      )}

      {editing && site && (
        <ScheduleForm
          site={site}
          people={people}
          schedule={editing === 'new' ? null : editing}
          onClose={(saved) => {
            setEditing(null);
            if (saved) load();
          }}
        />
      )}
    </div>
  );
}

function ScheduleForm({ site, people, schedule, onClose }) {
  const creating = !schedule;
  const zones = site.zones.filter((z) => z.isActive);
  const [form, setForm] = useState({
    userId: schedule?.user.id ?? '',
    zoneId: schedule?.zone.id ?? zones[0]?.id ?? '',
    days: schedule ? [schedule.weekday] : [1, 2, 3, 4, 5],
    startTime: schedule?.startTime ?? '06:00',
    endTime: schedule?.endTime ?? '14:00',
    notes: schedule?.notes ?? '',
  });
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const toggleDay = (d) => setForm((f) => ({ ...f, days: f.days.includes(d) ? f.days.filter((x) => x !== d) : [...f.days, d] }));

  async function save(e) {
    e.preventDefault();
    setSaving(true);
    setError('');
    const base = { userId: Number(form.userId), zoneId: Number(form.zoneId), startTime: form.startTime, endTime: form.endTime, notes: form.notes };
    try {
      if (creating) {
        // Un horario por día elegido; si uno falla se informa cuál
        const done = [];
        for (const d of [...form.days].sort()) {
          try {
            await apiPost('/admin/schedules', { ...base, siteId: site.id, weekday: d });
            done.push(d);
          } catch (err) {
            throw new Error(`${DAYS.find(([x]) => x === d)[1]}: ${err.message}${done.length ? ' (los días anteriores sí se guardaron)' : ''}`);
          }
        }
      } else {
        await apiPatch(`/admin/schedules/${schedule.id}`, { ...base, weekday: form.days[0] });
      }
      onClose(true);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      title={creating ? `Programar horario · ${site.name}` : 'Editar horario'}
      busy={saving}
      onClose={() => onClose(false)}
      actions={
        <>
          <button type="button" className="nx-btn nx-btn--ghost" onClick={() => onClose(false)} disabled={saving}>Cancelar</button>
          <button type="submit" form="schedule-form" className="nx-btn nx-btn--accent" disabled={saving || !form.userId || !form.days.length}>
            {saving ? 'Guardando…' : 'Guardar'}
          </button>
        </>
      }
    >
      <form id="schedule-form" className="nx-form" onSubmit={save} noValidate>
        <label className="nx-form__field">
          <span>Persona</span>
          <select value={form.userId} onChange={set('userId')}>
            <option value="">Seleccione</option>
            {people.map((p) => <option key={p.id} value={p.id}>{p.fullName}</option>)}
          </select>
        </label>
        <label className="nx-form__field">
          <span>Zona</span>
          <select value={form.zoneId} onChange={set('zoneId')}>
            {zones.map((z) => <option key={z.id} value={z.id}>{z.name}</option>)}
          </select>
        </label>
        <fieldset className="nx-form__fieldset">
          <legend>{creating ? 'Días' : 'Día'}</legend>
          <div className="nx-checks">
            {DAYS.map(([d, label]) => (
              <label key={d} className="nx-check">
                <input
                  type={creating ? 'checkbox' : 'radio'}
                  name="day"
                  checked={form.days.includes(d)}
                  onChange={() => (creating ? toggleDay(d) : setForm((f) => ({ ...f, days: [d] })))}
                />
                <span>{label}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <div className="nx-form__grid">
          <label className="nx-form__field"><span>Desde</span><input type="time" value={form.startTime} onChange={set('startTime')} /></label>
          <label className="nx-form__field"><span>Hasta</span><input type="time" value={form.endTime} onChange={set('endTime')} /></label>
        </div>
        <label className="nx-form__field"><span>Nota</span><input value={form.notes} onChange={set('notes')} maxLength={200} /></label>
        {error && <p className="nx-form__alert" role="alert">{error}</p>}
      </form>
    </Modal>
  );
}
