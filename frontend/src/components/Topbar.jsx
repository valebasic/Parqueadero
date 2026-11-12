import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import Icon from './Icon.jsx';
import { useSession } from '../context/SessionContext.jsx';
import { useShift } from '../context/ShiftContext.jsx';
import { useRealtime } from '../context/RealtimeContext.jsx';
import { ROLES } from '../lib/roles.js';
import { formatDate, formatTime12h } from '../lib/format.js';

function siteLabel(user) {
  if (user.allSites) return 'Todas las sedes';
  if (user.sites.length === 0) return 'Sin sede';
  if (user.sites.length === 1) return user.sites[0].name;
  return `${user.sites.length} sedes`;
}

// Barra superior: título de la pantalla, sede, zona, turno, reloj y usuario.
export default function Topbar({ title, onToggleMenu }) {
  const { user } = useSession();
  const { shift } = useShift();
  const { status: live } = useRealtime();
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 15000);
    return () => clearInterval(id);
  }, []);

  const initial = (user.fullName || user.username || '?').charAt(0).toUpperCase();

  return (
    <header className="nx-topbar">
      <button type="button" className="nx-topbar__menu" onClick={onToggleMenu} aria-label="Abrir menú">
        <Icon name="menu" />
      </button>
      <h1 className="nx-topbar__title">{title}</h1>

      <dl className="nx-topbar__context">
        <div className="nx-chip" title={user.sites.map((s) => s.name).join(', ')}>
          <dt>Sede</dt>
          <dd>{shift ? shift.site.name : siteLabel(user)}</dd>
        </div>
        <div className="nx-chip">
          <dt>Zona</dt>
          <dd>{shift ? shift.zone.name : 'Sin zona'}</dd>
        </div>
        <div className={`nx-chip ${shift ? 'nx-chip--ok' : 'nx-chip--warn'}`}>
          <dt>Turno</dt>
          <dd>
            <Link to="/caja" className="nx-chip__link" title="Ver turno y caja">
              {shift ? `Abierto desde ${formatTime12h(shift.openedAt)}` : 'Sin turno abierto'}
            </Link>
          </dd>
        </div>
      </dl>

      <div className="nx-topbar__right">
        <span className={`nx-live nx-live--${live}`} role="status" title="Actualización en tiempo real">
          <i aria-hidden="true" />
          {live === 'live' ? 'En vivo' : live === 'off' ? 'Sin conexión' : 'Reconectando…'}
        </span>
        <span className="nx-topbar__clock">
          {formatDate(now)} · {formatTime12h(now)}
        </span>
        <Link to="/cuenta" className="nx-user" title="Mi cuenta">
          <span className="nx-user__avatar" aria-hidden="true">
            {initial}
          </span>
          <span className="nx-user__text">
            <strong>{user.fullName}</strong>
            <small>{ROLES[user.role]}</small>
          </span>
        </Link>
      </div>
    </header>
  );
}
