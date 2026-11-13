import { useEffect, useRef, useState } from 'react';
import { createPlateCamera } from '../lib/alpr/plateCamera.js';

// Panel "Lectura de placa por cámara" de Entradas (VA2: RF35 entrada por placa, RF37 validación manual).
// Viene de mvc/plate-ui.js de la v1.0 web. La cámara del equipo lee la placa en el navegador; cuando una lectura
// se confirma (3 iguales) llama a onPlate(placa). Quien decide si se registra es la página de Entradas.
//
// Preferencias de ESTE equipo (localStorage, no se sincronizan): si el operador la apagó y qué cámara usa.
const KEY_OFF = 'nexo_plate_off';
const KEY_CAM = 'nexo_plate_cam';

function pref(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(key);
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* navegador sin almacenamiento: solo no se recuerda la preferencia */
  }
  return null;
}

export default function PlateCamera({ onPlate, autoRegister, onAutoRegisterChange, notice, onCancelNotice }) {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const readerRef = useRef(null);
  const retryRef = useRef(null);
  const onPlateRef = useRef(onPlate);
  const [on, setOn] = useState(false);
  const [status, setStatus] = useState({ text: '', error: false });
  const [debug, setDebug] = useState('');
  const [cameras, setCameras] = useState([]);
  const [cameraId, setCameraId] = useState(() => pref(KEY_CAM) || '');
  const [lastRead, setLastRead] = useState('');

  onPlateRef.current = onPlate;

  useEffect(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    const g = canvas.getContext('2d');

    function draw(f) {
      setDebug(`${f.found ? 'Placa amarilla vista' : 'Sin placa amarilla (recuadro de respaldo)'} · OCR leyó: ${f.text ? JSON.stringify(f.text.replace(/\s+/g, ' ').slice(0, 40)) : '(nada)'}`);
      const w = video.clientWidth;
      const h = video.clientHeight;
      if (canvas.width !== w) canvas.width = w;
      if (canvas.height !== h) canvas.height = h;
      g.clearRect(0, 0, w, h);
      if (!f.box || !f.width) return;
      const sx = w / f.width;
      const sy = h / f.height;
      g.lineWidth = 2;
      g.strokeStyle = '#2ecc71';
      g.strokeRect(f.box.x1 * sx, f.box.y1 * sy, (f.box.x2 - f.box.x1) * sx, (f.box.y2 - f.box.y1) * sy);
    }

    const reader = createPlateCamera({
      video,
      onCameraReset: () => {
        pref(KEY_CAM, null);
        setCameraId('');
      },
      onStatus: (s) => {
        if (s.state === 'error') {
          setStatus({ text: s.msg, error: true });
          setOn(false);
          // Fallos pasajeros (cámara ocupada o desconectada): reintenta sola. Faltan archivos o permiso: espera al operador.
          if (!s.fatal && pref(KEY_OFF) !== '1') {
            clearTimeout(retryRef.current);
            retryRef.current = setTimeout(() => {
              if (!reader.isRunning() && pref(KEY_OFF) !== '1') start(true);
            }, 8000);
          }
        } else if (s.state === 'loading' || s.state === 'running') setStatus({ text: s.msg, error: false });
        else if (s.state === 'stopped') {
          setStatus({ text: '', error: false });
          g.clearRect(0, 0, canvas.width, canvas.height);
        }
      },
      onFrame: draw,
      onPlate: (r) => {
        setLastRead(r.plate);
        onPlateRef.current?.(r.plate);
      },
    });
    readerRef.current = reader;

    function start(auto) {
      clearTimeout(retryRef.current);
      if (!auto) pref(KEY_OFF, null);
      const saved = pref(KEY_CAM);
      if (saved) reader.setCamera(saved);
      setOn(true);
      setStatus({ text: 'Iniciando…', error: false });
      reader
        .start()
        .then(() => reader.listCameras().then(setCameras))
        .catch(() => {
          /* el mensaje ya llegó por onStatus */
        });
    }
    reader.startFromUi = start;

    // Arranca sola al abrir Entradas, salvo que el operador la haya apagado a propósito en este equipo
    if (pref(KEY_OFF) !== '1') start(true);
    return () => {
      clearTimeout(retryRef.current);
      reader.stop();
    };
  }, []);

  function toggle() {
    const reader = readerRef.current;
    if (!reader) return;
    if (reader.isRunning()) {
      clearTimeout(retryRef.current);
      reader.stop();
      setOn(false);
      setLastRead('');
      pref(KEY_OFF, '1');
    } else reader.startFromUi(false);
  }

  function changeCamera(id) {
    setCameraId(id);
    pref(KEY_CAM, id || null);
    readerRef.current?.setCamera(id);
  }

  return (
    <section className="nx-cam" aria-label="Lectura de placa por cámara">
      <div className="nx-cam__bar">
        <button type="button" className={`nx-btn nx-btn--sm ${on ? '' : 'nx-btn--ghost'}`} onClick={toggle} aria-pressed={on}>
          {on ? 'Pausar cámara' : 'Leer placas con la cámara'}
        </button>
        <span className={`nx-cam__status${status.error ? ' is-error' : ''}`} role="status">
          {status.text}
        </span>
      </div>
      <div className="nx-cam__body" hidden={!on}>
        <div className="nx-cam__view">
          <video ref={videoRef} playsInline muted />
          <canvas ref={canvasRef} />
        </div>
        <div className="nx-cam__side">
          <div className="nx-cam__debug">{debug}</div>
          {cameras.length > 1 && (
            <select className="nx-cam__select" aria-label="Cámara" value={cameraId} onChange={(e) => changeCamera(e.target.value)}>
              {cameras.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
          )}
          {lastRead && (
            <div className="nx-cam__last">
              Última placa: <strong>{lastRead}</strong>{' '}
              <button type="button" className="nx-linkbtn" onClick={() => onPlate(lastRead, { force: true })}>
                Usar
              </button>
            </div>
          )}
          <label className="nx-check nx-cam__auto">
            <input type="checkbox" checked={autoRegister} onChange={(e) => onAutoRegisterChange(e.target.checked)} />
            <span>Registrar la entrada automáticamente al leer la placa</span>
          </label>
          {notice && (
            <div className={`nx-cam__notice is-${notice.type}`} role={notice.type === 'error' ? 'alert' : 'status'}>
              {notice.text}
              {notice.cancelable && (
                <>
                  {' '}
                  <button type="button" className="nx-btn nx-btn--sm" onClick={onCancelNotice}>
                    Cancelar
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
