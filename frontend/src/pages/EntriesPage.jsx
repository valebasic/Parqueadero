import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiGet, apiPost } from '../lib/api.js';
import { useShift, useWorkingSite } from '../context/ShiftContext.jsx';
import { useReceipt } from '../components/Receipt.jsx';
import { useSiteEvents } from '../context/RealtimeContext.jsx';
import { useSession } from '../context/SessionContext.jsx';
import { useOffline } from '../context/OfflineContext.jsx';
import {
  loadSnapshot,
  localMonthly,
  localMap,
  localOpenEntries,
  OfflineError,
  suggestSpaceOffline,
  quoteOffline,
  registerEntryOffline,
  registerExitOffline,
} from '../lib/offline/engine.js';
import { formatCOP, formatDate, formatDuration, formatTime12h } from '../lib/format.js';
import { detectVehicleType, normalizePlate, plateError, PLATE_MAX_LENGTH, VEHICLE_LABELS } from '../lib/plates.js';
import SpacePicker from '../components/map/SpacePicker.jsx';
import PlateCamera from '../components/PlateCamera.jsx';

// Entradas (RF07-RF11), con el flujo de ParkApp.html de la v1.0:
//   ENTRADA (≤ 3 acciones): escribir la placa → Enter (registra) → Enter (imprime el tiquete).
//   SALIDA: escribir la placa (o tocarla en la lista) → elegir forma de pago → "Finalizar venta".
//   CÁMARA (VA2, RF35/RF37): la placa leída se escribe en el campo como si la hubieran digitado. Si es una entrada
//   nueva y el registro automático está activo, se registra tras un instante (con Cancelar); si el vehículo ya está
//   adentro se abre su salida para cobrar (Facaparking tiene una sola entrada y salida). Nunca cobra sola.
// El tipo de vehículo se deduce de la placa; la lista de la izquierda se filtra mientras se escribe.

const METHODS = [
  { id: 'CASH', label: 'Efectivo', icon: '▣' },
  { id: 'ELECTRONIC', label: 'Electrónico', icon: '▯' },
  { id: 'MIXED', label: 'Ambos', icon: '⇄' },
  { id: 'PENDING', label: 'Pendiente', icon: '◷' },
];

export default function EntriesPage() {
  const { shift } = useShift();
  const { siteId } = useWorkingSite();
  const { showReceipt } = useReceipt();
  const { user } = useSession();
  const { online, pending, notifyQueued } = useOffline();
  const offline = !online;
  const [snapshot, setSnapshot] = useState(null);
  const plateRef = useRef(null);
  // Cámara: registro automático (preferencia de este equipo), placa leída que espera registrarse y aviso del panel
  const [camAuto, setCamAuto] = useState(() => {
    try {
      return localStorage.getItem('nexo_plate_auto') !== '0';
    } catch {
      return true;
    }
  });
  const [camPending, setCamPending] = useState(null);
  const [camNotice, setCamNotice] = useState(null);
  const camFilledRef = useRef(''); // última placa que escribió la cámara (para no pisar lo que digite el operador)
  const camCancelledRef = useRef(''); // el operador canceló el registro automático de esta placa

  const [openEntries, setOpenEntries] = useState([]);
  const [plateInput, setPlateInput] = useState('');
  const [lookup, setLookup] = useState(null);
  const [vehicleType, setVehicleType] = useState('');
  const [selected, setSelected] = useState(null);
  const [quote, setQuote] = useState(null);
  const [method, setMethod] = useState('CASH');
  const [charged, setCharged] = useState(''); // '' = cobrar lo calculado
  const [reason, setReason] = useState('');
  const [cashAmount, setCashAmount] = useState('');
  const [message, setMessage] = useState(null); // { type: 'error' | 'ok' | 'warn', text }
  const [busy, setBusy] = useState(false);
  // RF50: puesto sugerido para la entrada y el que el operador elija en el mapa
  const [suggestion, setSuggestion] = useState(null); // { hasMap, suggested: { id, code, reserved } | null }
  const [spaceChoice, setSpaceChoice] = useState(null); // { id, code }
  const [picking, setPicking] = useState(false);
  // Puesto que pide llaves (isla): se avisa "Solicitar llaves" y se marca si se recibieron
  const [keysOk, setKeysOk] = useState(false);
  const spaceNeedsKeys = Boolean(spaceChoice ? spaceChoice.requiresKeys : suggestion?.suggested?.requiresKeys);

  const plate = normalizePlate(plateInput);
  const selectedRef = useRef(null);
  const busyRef = useRef(false);
  selectedRef.current = selected;
  busyRef.current = busy;

  // --- Datos ---
  const loadOpen = useCallback(async () => {
    if (!siteId) return;
    try {
      if (offline) {
        const snap = await loadSnapshot(siteId);
        setSnapshot(snap);
        setOpenEntries(snap ? await localOpenEntries(snap, user.id) : []);
      } else {
        setOpenEntries((await apiGet(`/entries/open?siteId=${siteId}`, { background: true })).map((e) => ({ ...e, key: `s${e.id}` })));
      }
    } catch (err) {
      if (err.code !== 'NETWORK') setMessage({ type: 'error', text: err.message });
    }
  }, [siteId, offline, user.id]);

  useEffect(() => {
    loadOpen();
    const id = setInterval(loadOpen, 60000);
    return () => clearInterval(id);
  }, [loadOpen]);

  // Tiempo real: entradas y salidas registradas por otros operadores de la sede
  useSiteEvents(siteId, ['entry:created', 'entry:exited'], (events) => {
    loadOpen();
    const closedHere = events.find((e) => e.type === 'entry:exited' && e.payload.entryId === selectedRef.current?.id);
    if (closedHere && !busyRef.current) {
      reset(true);
      setMessage({ type: 'warn', text: `Otro operador ya registró la salida de ${closedHere.payload.plate}.` });
    }
  });

  // Consulta la placa mientras se escribe (tipo, si ya está adentro, mensualidad)
  useEffect(() => {
    setLookup(null);
    if (!siteId || plateError(plate)) return undefined;
    if (offline) {
      if (!snapshot) return undefined;
      const inside = openEntries.find((e) => e.plate === plate);
      setLookup({ plate, valid: true, vehicleType: detectVehicleType(plate), openEntry: inside ? { ...inside, inThisSite: true } : null, monthly: localMonthly(snapshot, plate) });
      if (inside && selectedRef.current?.key !== inside.key) selectEntry(inside);
      return undefined;
    }
    const t = setTimeout(() => {
      apiGet(`/entries/lookup?siteId=${siteId}&plate=${encodeURIComponent(plate)}`, { background: true })
        .then((data) => {
          setLookup(data);
          if (data.vehicleType) setVehicleType(data.vehicleType);
          if (data.openEntry?.inThisSite) selectEntry({ ...data.openEntry, key: `s${data.openEntry.id}` });
        })
        .catch(() => {});
    }, 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plate, siteId, offline, snapshot, openEntries]);

  // Puesto sugerido para una entrada nueva (si la zona del turno tiene mapa)
  useEffect(() => {
    setSuggestion(null);
    if (!siteId || !shift || selected || plateError(plate) || lookup?.openEntry) return undefined;
    const type = vehicleType || detectVehicleType(plate);
    if (offline) {
      if (!snapshot) return undefined;
      const map = localMap(snapshot, shift.zone.id, openEntries);
      const sp = suggestSpaceOffline(map, type);
      setSuggestion({ hasMap: Boolean(map), suggested: sp ? { id: sp.spaceId, code: sp.code } : null, offline: true });
      return undefined;
    }
    const t = setTimeout(() => {
      apiGet(`/spaces/suggest?siteId=${siteId}&plate=${encodeURIComponent(plate)}${type ? `&vehicleType=${type}` : ''}`, { background: true })
        .then(setSuggestion)
        .catch(() => {});
    }, 300);
    return () => clearTimeout(t);
  }, [plate, siteId, shift, selected, lookup?.openEntry, vehicleType, offline, snapshot, openEntries]);

  // Tipo deducido al instante (sin esperar a la API)
  useEffect(() => {
    if (!selected) setVehicleType(detectVehicleType(plate) ?? '');
  }, [plate, selected]);

  // Cotización de la salida (se refresca cada 30 s mientras está seleccionada)
  useEffect(() => {
    if (!selected) {
      setQuote(null);
      return undefined;
    }
    let cancelled = false;
    const load = () => {
      if (offline) {
        try {
          setQuote(snapshot ? quoteOffline(snapshot, selected) : null);
        } catch (err) {
          setMessage({ type: 'error', text: err.message });
        }
        return Promise.resolve();
      }
      return apiGet(`/entries/${selected.id}/quote`, { background: true })
        .then((q) => !cancelled && setQuote(q))
        .catch((err) => !cancelled && err.code !== 'NETWORK' && setMessage({ type: 'error', text: err.message }));
    };
    load();
    const id = setInterval(load, 30000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [selected, offline, snapshot]);

  function selectEntry(entry) {
    setSelected(entry);
    setPlateInput(entry.plate);
    setVehicleType(entry.vehicleType);
    setMethod('CASH');
    setCharged('');
    setReason('');
    setCashAmount('');
    setMessage(null);
  }

  function reset(keepMessage = false) {
    setSelected(null);
    setSpaceChoice(null);
    setSuggestion(null);
    setKeysOk(false);
    setQuote(null);
    setPlateInput('');
    setLookup(null);
    setCharged('');
    setReason('');
    setCashAmount('');
    setMethod('CASH');
    if (!keepMessage) setMessage(null);
    setTimeout(() => plateRef.current?.focus(), 0);
  }

  // --- Acciones ---
  async function registerEntry() {
    const error = plateError(plate);
    if (error) {
      setMessage({ type: 'error', text: error });
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const receipt = offline
        ? await registerEntryOffline({ user, shift, snapshot, plate, vehicleType, spaceId: spaceChoice?.id ?? null, keysReceived: keysOk })
        : await apiPost('/entries', { siteId, plate, vehicleType: vehicleType || undefined, spaceId: spaceChoice?.id, keysReceived: keysOk });
      reset(true);
      setMessage({
        type: 'ok',
        text: offline
          ? `Entrada de ${receipt.plate} guardada sin conexión (recibo provisional ${receipt.receipt}). Se sincroniza al volver internet.`
          : `Entrada de ${receipt.plate} registrada (recibo ${receipt.receipt}).`,
      });
      if (receipt.space) setMessage((m) => ({ ...m, text: `${m.text} Puesto ${receipt.space.code}.` }));
      if (receipt.space?.requiresKeys && !receipt.keysReceived) {
        setMessage({ type: 'warn', text: `Solicitar las llaves de ${receipt.plate}: el puesto ${receipt.space.code} bloquea a otros. Cuando las reciba, márquelo en el Mapa.` });
      }
      if (offline) notifyQueued();
      loadOpen();
      showReceipt(receipt);
    } catch (err) {
      setMessage({ type: 'error', text: err.message });
    } finally {
      setBusy(false);
    }
  }

  async function finishSale() {
    if (!selected) return;
    setBusy(true);
    setMessage(null);
    try {
      const body = { paymentMethod: method };
      if (charged !== '') {
        body.chargedAmount = Number(charged);
        body.discountReason = reason;
      }
      if (method === 'MIXED') body.cashAmount = Number(cashAmount);
      const receipt = offline
        ? await registerExitOffline({
            user,
            shift,
            snapshot,
            entry: selected,
            method,
            chargedAmount: charged !== '' ? Number(charged) : undefined,
            discountReason: reason,
          })
        : await apiPost(`/entries/${selected.id}/exit`, body);
      if (offline) notifyQueued();
      reset(true);
      setMessage(
        receipt.status === 'PENDING_CHARGE'
          ? { type: 'warn', text: `Salida de ${receipt.plate} registrada sin cobrar: ${formatCOP(receipt.chargedAmount)} quedan en Pendientes.` }
          : { type: 'ok', text: `Salida de ${receipt.plate} cobrada: ${formatCOP(receipt.chargedAmount)} (${receipt.paymentLabel}).` },
      );
      loadOpen();
      showReceipt(receipt);
    } catch (err) {
      setMessage({ type: 'error', text: err instanceof OfflineError || err.code !== 'NETWORK' ? err.message : 'Se perdió la conexión: intente de nuevo (se guardará sin conexión).' });
      if (err.code === 'ENTRY_NOT_OPEN') {
        reset(true);
        loadOpen();
      }
    } finally {
      setBusy(false);
    }
  }

  function onPlateKeyDown(e) {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (busy) return;
    if (selected) finishSale();
    else registerEntry();
  }

  // --- Derivados ---
  const filtered = useMemo(
    () => (plate ? openEntries.filter((e) => e.plate.includes(plate)) : openEntries),
    [openEntries, plate],
  );
  const calculated = quote?.total ?? 0;
  const goesToPending = Boolean(quote?.goesToPending) || method === 'PENDING';
  const total = selected ? (charged !== '' ? Number(charged) || 0 : calculated) : 0;
  const discount = selected ? Math.max(0, calculated - total) : 0;
  const cash = Number(cashAmount) || 0;
  const noShift = !shift;
  const noLocalCopy = offline && !snapshot;
  const blocked = noShift || noLocalCopy;
  const insideElsewhere = lookup?.openEntry && !lookup.openEntry.inThisSite;
  const monthly = lookup?.monthly;

  const canFinish =
    selected &&
    quote &&
    !blocked &&
    total <= calculated &&
    (discount === 0 || reason.trim().length >= 3) &&
    (method !== 'MIXED' || goesToPending || (cash > 0 && cash < total));
  const canRegister = !selected && !blocked && !plateError(plate) && !(monthly?.blocksEntry) && !lookup?.openEntry;

  // --- Cámara ---
  function changeCamAuto(onOff) {
    setCamAuto(onOff);
    try {
      if (onOff) localStorage.removeItem('nexo_plate_auto');
      else localStorage.setItem('nexo_plate_auto', '0');
    } catch {
      /* sin almacenamiento: solo no se recuerda */
    }
    if (!onOff) cancelCamAuto();
  }
  function cancelCamAuto(text) {
    if (camPending) camCancelledRef.current = camPending;
    setCamPending(null);
    setCamNotice(text ? { type: 'warn', text } : null);
  }
  function onCameraPlate(read, { force = false } = {}) {
    const current = normalizePlate(plateInput);
    if (!force && busy) return;
    if (!force && current && current !== read && current !== camFilledRef.current) {
      setCamNotice({ type: 'warn', text: `Placa leída: ${read}. El campo ya tiene otra placa; use «Usar» para reemplazarla.` });
      return;
    }
    if (!force && selected && selected.plate !== read) {
      setCamNotice({ type: 'warn', text: `Placa leída: ${read}. Termine primero la salida de ${selected.plate}.` });
      return;
    }
    camFilledRef.current = read;
    if (current !== read) {
      setPlateInput(read);
      if (selected && selected.plate !== read) {
        setSelected(null);
        setQuote(null);
      }
    }
    if (force) camCancelledRef.current = '';
    setCamNotice({ type: 'ok', text: `Placa leída: ${read}` });
    if (camAuto && camCancelledRef.current !== read) setCamPending(read);
    else if (!camAuto) setCamNotice({ type: 'ok', text: `Placa leída: ${read}. El registro automático está apagado: presione Enter o Registrar.` });
  }

  // Registro automático de la placa leída: espera la consulta de la placa (lookup) y decide con las mismas reglas
  // que el botón Registrar. Si algo lo impide, dice por qué (antes la v1.0 se quedaba callada).
  useEffect(() => {
    if (!camPending) return undefined;
    if (plate !== camPending) {
      setCamPending(null); // el operador cambió la placa: no registrar
      return undefined;
    }
    const waiting = !(offline && !snapshot) && (!lookup || lookup.plate !== camPending);
    if (waiting) return undefined; // esperando la consulta de la placa
    let why = null;
    if (lookup?.openEntry) {
      why = lookup.openEntry.inThisSite
        ? `${camPending} ya está adentro: se abrió su salida para cobrar.`
        : `${camPending} figura adentro en otra sede: revise antes de registrar.`;
    } else if (noShift) why = 'no hay un turno abierto.';
    else if (noLocalCopy) why = 'sin conexión y sin copia local de tarifas.';
    else if (monthly?.blocksEntry) why = 'tiene una mensualidad activa que cubre este horario.';
    else if (!canRegister) why = 'revise el aviso bajo la placa.';
    if (why) {
      setCamPending(null);
      setCamNotice({ type: lookup?.openEntry?.inThisSite ? 'ok' : 'warn', text: lookup?.openEntry ? why : `Placa leída: ${camPending}, pero no se registró: ${why}` });
      return undefined;
    }
    setCamNotice({ type: 'info', text: `Registrando ${camPending}…`, cancelable: true });
    const t = setTimeout(() => {
      setCamPending(null);
      setCamNotice(null);
      registerEntry();
    }, 1200);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camPending, plate, lookup, canRegister, offline, snapshot]);

  return (
    <div className="nx-entries">
      {offline && (
        <div className="nx-banner nx-banner--offline" role="status">
          <strong>Sin conexión.</strong> Las entradas y salidas se guardan cifradas en este equipo con recibo provisional
          {pending ? ` · ${pending} ${pending === 1 ? 'operación' : 'operaciones'} por sincronizar` : ''}. Se envían solas al volver internet.
          {noLocalCopy && ' No hay copia local de tarifas y vehículos: no se puede operar sin conexión.'}
        </div>
      )}
      {noShift && !offline && (
        <div className="nx-banner nx-banner--warn" role="alert">
          No tiene un turno abierto: no puede registrar entradas ni salidas. <Link to="/caja">Abrir turno</Link>
        </div>
      )}

      {/* Fila superior: placa + total, como en la v1.0 */}
      <div className="nx-entries__top">
        <div className="nx-plate">
          <label htmlFor="placa" className="nx-sr-only">
            Placa
          </label>
          <input
            id="placa"
            ref={plateRef}
            className="nx-plate__input"
            value={plateInput}
            onChange={(e) => {
              const v = e.target.value.toUpperCase().slice(0, PLATE_MAX_LENGTH);
              setPlateInput(v);
              if (selected && normalizePlate(v) !== selected.plate) {
                setSelected(null);
                setQuote(null);
              }
            }}
            onKeyDown={onPlateKeyDown}
            placeholder="PLACA"
            autoComplete="off"
            autoFocus
            spellCheck={false}
          />
          <PlateHint plate={plate} lookup={lookup} selected={selected} insideElsewhere={insideElsewhere} />
          {suggestion?.hasMap && !selected && (
            <div className="nx-space-hint" aria-live="polite">
              {spaceChoice ? (
                <>Puesto elegido: <strong>{spaceChoice.code}</strong> · </>
              ) : suggestion.suggested ? (
                <>Puesto sugerido: <strong>{suggestion.suggested.code}</strong>{suggestion.suggested.reserved ? ' (reservado para esta mensualidad)' : ''} · </>
              ) : (
                <>Sin puestos libres de este tipo: se registra sin puesto · </>
              )}
              <button type="button" className="nx-linkbtn" onClick={() => setPicking(true)}>{spaceChoice ? 'Cambiar' : 'Elegir en el mapa'}</button>
              {spaceChoice && <> · <button type="button" className="nx-linkbtn" onClick={() => setSpaceChoice(null)}>Usar el sugerido</button></>}
              {spaceNeedsKeys && (
                <div className="nx-keys-alert" role="alert">
                  <strong>Solicitar llaves:</strong> este puesto bloquea a otros.{' '}
                  <label className="nx-check">
                    <input type="checkbox" checked={keysOk} onChange={(e) => setKeysOk(e.target.checked)} />
                    <span>Llaves recibidas</span>
                  </label>
                </div>
              )}
            </div>
          )}
          {selected?.keysReceived && (
            <div className="nx-keys-alert" role="status"><strong>Devolver las llaves</strong> del vehículo antes de que salga.</div>
          )}
          <PlateCamera
            onPlate={onCameraPlate}
            autoRegister={camAuto}
            onAutoRegisterChange={changeCamAuto}
            notice={camNotice}
            onCancelNotice={() => cancelCamAuto('Registro automático cancelado. Corrija la placa o registre a mano.')}
          />
        </div>
        <div className={`nx-bigtotal${goesToPending && selected ? ' is-pending' : ''}`} aria-live="polite">
          {formatCOP(total)}
        </div>
      </div>

      {message && (
        <div className={`nx-banner nx-banner--${message.type}`} role={message.type === 'error' ? 'alert' : 'status'}>
          {message.text}
        </div>
      )}

      <div className="nx-entries__main">
        {/* Lista de vehículos adentro */}
        <section className="nx-card nx-entries__list">
          <header className="nx-card__header">
            <h2 className="nx-card__title">Entradas</h2>
            <span className="nx-badge nx-badge--ok">{openEntries.length} adentro</span>
          </header>
          <div className="nx-table-wrap nx-entries__scroll">
            <table className="nx-table nx-table--clickable">
              <thead>
                <tr>
                  <th>Placa</th>
                  <th>Fecha</th>
                  <th>Hora</th>
                  <th>Servicio</th>
                  <th>Recibo</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((e) => (
                  <tr
                    key={e.key}
                    className={selected?.key === e.key ? 'is-selected' : ''}
                    onClick={() => selectEntry(e)}
                    tabIndex={0}
                    onKeyDown={(ev) => ev.key === 'Enter' && selectEntry(e)}
                  >
                    <td>
                      <strong>{e.plate}</strong>
                      {e.monthlyPlanId && <span className="nx-tag" title="Mensualidad nocturna fuera de horario">M</span>}
                      {e.offline && <span className="nx-tag nx-tag--offline" title="Registrada sin conexión, pendiente de sincronizar">sin sincronizar</span>}
                    </td>
                    <td>{formatDate(e.entryAt)}</td>
                    <td>{formatTime12h(e.entryAt)}</td>
                    <td>{e.vehicleLabel}</td>
                    <td>{e.receipt}</td>
                  </tr>
                ))}
                {filtered.length === 0 && (
                  <tr>
                    <td colSpan={5} className="nx-muted">
                      {plate ? 'Ningún vehículo adentro con esa placa.' : 'No hay vehículos adentro.'}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        {/* Panel de registro / cobro */}
        <section className="nx-card nx-entries__panel">
          <div className="nx-elapsed">{selected && quote ? formatDuration(quote.minutes) : selected ? 'Calculando…' : '—'}</div>

          <div className="nx-form__grid nx-form__grid--2">
            <label className="nx-form__field">
              <span>Servicio</span>
              <select value={vehicleType} onChange={(e) => setVehicleType(e.target.value)} disabled={Boolean(selected) || vehicleType === 'BICYCLE'}>
                <option value="">Seleccione</option>
                {Object.entries(VEHICLE_LABELS).map(([id, label]) => (
                  <option key={id} value={id} disabled={(id === 'BICYCLE') !== (detectVehicleType(plate) === 'BICYCLE')}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <div className="nx-form__field">
              <span>{selected ? 'Entrada' : 'Hora'}</span>
              <div className="nx-readonly">
                {selected ? `${formatDate(selected.entryAt)} ${formatTime12h(selected.entryAt)}` : formatTime12h(new Date())}
              </div>
            </div>
          </div>

          {selected ? (
            <>
              {quote?.goesToPending && (
                <div className="nx-banner nx-banner--warn">
                  Mensualidad nocturna fuera de su horario: al dar salida, el cobro queda en Pendientes.
                </div>
              )}
              {quote?.portalPayment && (
                <div className={`nx-banner ${quote.portalPayment.withinWindow ? 'nx-banner--ok' : 'nx-banner--warn'}`} role="status">
                  <strong>Pagó en el portal {formatCOP(quote.portalPayment.amount)}.</strong>{' '}
                  {quote.portalPayment.withinWindow
                    ? `Sale sin cobro adicional (tiene hasta las ${formatTime12h(quote.portalPayment.exitUntil)}). Pulse Finalizar venta.`
                    : `Se pasó del tiempo para salir: cobre solo la diferencia, ${formatCOP(quote.portalPayment.due)}.`}
                </div>
              )}

              <div className="nx-paypanel">
                <div className="nx-paypanel__title">Descuento</div>
                <div className="nx-form__grid nx-form__grid--2">
                  <label className="nx-form__field">
                    <span>Valor a cobrar</span>
                    <input
                      inputMode="numeric"
                      value={charged !== '' ? charged : String(calculated)}
                      onChange={(e) => {
                        const digits = e.target.value.replace(/\D/g, '');
                        setCharged(digits === '' || Number(digits) === calculated ? '' : digits);
                      }}
                    />
                  </label>
                  <label className="nx-form__field">
                    <span>Motivo{discount > 0 ? ' (obligatorio)' : ''}</span>
                    <input
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                      placeholder={discount > 0 ? 'Escriba el motivo' : 'Solo si hay descuento'}
                      aria-invalid={discount > 0 && reason.trim().length < 3}
                      maxLength={200}
                    />
                  </label>
                </div>
                {discount > 0 && (
                  <div className="nx-paysummary">
                    <span>Valor original {formatCOP(calculated)}</span>
                    <span className="is-danger">Descuento −{formatCOP(discount)}</span>
                    <strong>Total {formatCOP(total)}</strong>
                  </div>
                )}
                {total > calculated && <p className="nx-form__error">No puede cobrar más de lo calculado.</p>}
              </div>

              {!quote?.goesToPending && (
                <div className="nx-paypanel">
                  <div className="nx-paypanel__title">Método de pago</div>
                  <div className="nx-paymethods" role="radiogroup" aria-label="Método de pago">
                    {METHODS.filter((m) => !offline || m.id !== 'MIXED').map((m) => (
                      <button
                        key={m.id}
                        type="button"
                        role="radio"
                        aria-checked={method === m.id}
                        className={`nx-paymethod${method === m.id ? ' is-active' : ''}${m.id === 'PENDING' ? ' nx-paymethod--pending' : ''}`}
                        onClick={() => setMethod(m.id)}
                      >
                        <span aria-hidden="true">{m.icon}</span> {m.label}
                      </button>
                    ))}
                  </div>
                  {method === 'MIXED' && (
                    <div className="nx-form__grid nx-form__grid--2">
                      <label className="nx-form__field">
                        <span>Efectivo</span>
                        <input inputMode="numeric" value={cashAmount} onChange={(e) => setCashAmount(e.target.value.replace(/\D/g, ''))} />
                      </label>
                      <div className="nx-form__field">
                        <span>Electrónico (calculado)</span>
                        <div className="nx-readonly">{formatCOP(Math.max(0, total - cash))}</div>
                      </div>
                    </div>
                  )}
                </div>
              )}

              <div className="nx-entries__actions">
                <button type="button" className="nx-btn nx-btn--ghost" onClick={() => reset()} disabled={busy}>
                  Nueva entrada
                </button>
                <button type="button" className="nx-btn nx-btn--accent nx-btn--big" onClick={finishSale} disabled={!canFinish || busy}>
                  {busy ? 'Guardando…' : goesToPending ? 'Registrar salida (pendiente)' : 'Finalizar venta'}
                </button>
              </div>
            </>
          ) : (
            <div className="nx-entries__actions">
              <button type="button" className="nx-btn nx-btn--accent nx-btn--big nx-btn--block" onClick={registerEntry} disabled={!canRegister || busy}>
                {busy ? 'Registrando…' : 'Registrar'}
              </button>
            </div>
          )}
        </section>
      </div>
      {picking && shift && (
        <SpacePicker
          siteId={siteId}
          zoneId={shift.zone.id}
          vehicleType={vehicleType || detectVehicleType(plate)}
          plate={plate}
          offline={offline}
          snapshot={snapshot}
          openEntries={openEntries}
          suggestedId={suggestion?.suggested?.id}
          onClose={(choice) => {
            setPicking(false);
            if (choice) setSpaceChoice(choice);
            setTimeout(() => plateRef.current?.focus(), 0);
          }}
        />
      )}
    </div>
  );
}

// Aviso bajo la placa: formato, tipo, si ya está adentro o tiene mensualidad
function PlateHint({ plate, lookup, selected, insideElsewhere }) {
  if (!plate) return <p className="nx-plate__hint">Escriba la placa y presione Enter.</p>;
  const error = plateError(plate);
  if (error) return <p className="nx-plate__hint is-error">{plate.length >= 5 ? error : 'Carro ABC-123 · Moto ABC-12D · CICLA'}</p>;
  if (selected) return <p className="nx-plate__hint is-info">Vehículo adentro: elija la forma de pago y finalice la venta.</p>;
  if (insideElsewhere) {
    return <p className="nx-plate__hint is-error">Esta placa ya está adentro en otra sede (recibo {lookup.openEntry.receipt}).</p>;
  }
  const m = lookup?.monthly;
  if (m?.blocksEntry) {
    return (
      <p className="nx-plate__hint is-error">
        Mensualidad {m.schedule === 'NIGHT' ? `nocturna (${m.nightStart} a ${m.nightEnd})` : 'vigente'} de {m.clientName}: no se registra como entrada normal.
      </p>
    );
  }
  if (m) {
    return (
      <p className="nx-plate__hint is-warn">
        Mensualidad nocturna de {m.clientName} fuera de su horario ({m.nightStart} a {m.nightEnd}): puede entrar; el cobro quedará en Pendientes.
      </p>
    );
  }
  return <p className="nx-plate__hint is-ok">{VEHICLE_LABELS[detectVehicleType(plate)]} · presione Enter para registrar.</p>;
}
