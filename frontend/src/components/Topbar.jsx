import { useEffect, useState } from 'react';
import Icon from './Icon.jsx';
import { useSession } from '../context/SessionContext.jsx';
import { ROLES } from '../lib/roles.js';
import { formatDate, formatTime12h } from '../lib/format.js';

// Barra superior: título de la pantalla, sede, zona, turno, reloj y usuario.
export default function Topbar({ title, onToggleMenu }) {
  const { session } = useSession();
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 15000);
    return () => clearInterval(id);
  }, []);

  const { user, sede, zona, turno } = session;
  const initial = (user.username || '?').charAt(0).toUpperCase();

  return (
    <header className="nx-topbar">
      <button type="button" className="nx-topbar__menu" onClick={onToggleMenu} aria-label="Abrir menú">
        <Icon name="menu" />
      </button>
      <h1 className="nx-topbar__title">{title}</h1>

      <dl className="nx-topbar__context">
        <div className="nx-chip">
          <dt>Sede</dt>
          <dd>{sede?.name || 'Sin sede'}</dd>
        </div>
        <div className="nx-chip">
          <dt>Zona</dt>
          <dd>{zona?.name || 'Sin zona'}</dd>
        </div>
        <div className={`nx-chip ${turno ? 'nx-chip--ok' : 'nx-chip--warn'}`}>
          <dt>Turno</dt>
          <dd>{turno ? `Abierto desde ${formatTime12h(turno.openedAt)}` : 'Sin turno abierto'}</dd>
        </div>
      </dl>

      <div className="nx-topbar__right">
        <span className="nx-topbar__clock">
          {formatDate(now)} · {formatTime12h(now)}
        </span>
        <span className="nx-user" title={ROLES[user.role]}>
          <span className="nx-user__avatar" aria-hidden="true">{initial}</span>
          <span className="nx-user__text">
            <strong>{user.username}</strong>
            <small>{ROLES[user.role]}</small>
          </span>
        </span>
      </div>
    </header>
  );
}
