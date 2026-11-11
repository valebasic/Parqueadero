import { useEffect, useRef, useState } from 'react';
import { useSession } from '../context/SessionContext.jsx';
import { getLastServerActivity } from '../lib/api.js';
import { lastActivity, markActivity, resetActivity } from '../lib/activity.js';

// Cierre por inactividad (15 min operador, 30 min administradores; el tiempo lo dicta el servidor).
//   - Cuenta como actividad: mouse, teclado, toques y scroll, en cualquier pestaña.
//   - Un minuto antes avisa con la opción "Seguir conectado".
//   - Mientras el usuario está activo, renueva la sesión en el servidor cada ~2 min aunque no haya
//     peticiones (p. ej. llenando un formulario largo), para que el servidor no la cierre.
//   - Al llegar al límite cierra la sesión. El servidor aplica la misma regla por su cuenta.
const EVENTS = ['mousemove', 'mousedown', 'keydown', 'touchstart', 'scroll', 'wheel'];
const CHECK_EVERY_MS = 5000;
const WARN_BEFORE_MS = 60 * 1000;
const KEEPALIVE_EVERY_MS = 2 * 60 * 1000;

export default function IdleGuard() {
  const { session, logout, keepAlive } = useSession();
  const [secondsLeft, setSecondsLeft] = useState(null);
  const keepAliveRunning = useRef(false);
  const timeoutMs = (session?.idleTimeoutSeconds ?? 15 * 60) * 1000;

  useEffect(() => {
    resetActivity();
    const onActivity = () => markActivity();
    EVENTS.forEach((e) => window.addEventListener(e, onActivity, { passive: true }));
    return () => EVENTS.forEach((e) => window.removeEventListener(e, onActivity));
  }, []);

  useEffect(() => {
    const id = setInterval(() => {
      const now = Date.now();
      const idleMs = now - lastActivity();

      if (idleMs >= timeoutMs) {
        logout('idle');
        return;
      }
      setSecondsLeft(idleMs >= timeoutMs - WARN_BEFORE_MS ? Math.ceil((timeoutMs - idleMs) / 1000) : null);

      // Activo desde la última vez que el servidor supo de él y hace rato que no le avisa
      const serverTouch = getLastServerActivity();
      if (lastActivity() > serverTouch && now - serverTouch >= KEEPALIVE_EVERY_MS && !keepAliveRunning.current) {
        keepAliveRunning.current = true;
        keepAlive().finally(() => {
          keepAliveRunning.current = false;
        });
      }
    }, CHECK_EVERY_MS);
    return () => clearInterval(id);
  }, [timeoutMs, logout, keepAlive]);

  if (secondsLeft === null) return null;

  return (
    <div className="nx-modal-backdrop" role="presentation">
      <div className="nx-modal" role="alertdialog" aria-modal="true" aria-labelledby="idle-title">
        <h2 id="idle-title">¿Sigue ahí?</h2>
        <p>
          Por seguridad, la sesión se cerrará por inactividad en <strong>{secondsLeft} s</strong>.
        </p>
        <div className="nx-modal__actions">
          <button type="button" className="nx-btn nx-btn--ghost" onClick={() => logout('logout')}>
            Cerrar sesión
          </button>
          <button
            type="button"
            className="nx-btn nx-btn--accent"
            autoFocus
            onClick={() => {
              resetActivity();
              setSecondsLeft(null);
              keepAlive();
            }}
          >
            Seguir conectado
          </button>
        </div>
      </div>
    </div>
  );
}
