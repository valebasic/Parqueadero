import { useEffect } from 'react';

// Ventana modal sencilla. Escape la cierra (salvo que esté ocupada).
export default function Modal({ title, onClose, children, actions, wide = false, busy = false }) {
  useEffect(() => {
    function onKey(e) {
      if (e.key === 'Escape' && !busy) onClose?.();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, busy]);

  return (
    <div className="nx-modal-backdrop" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose?.()}>
      <div className={`nx-modal${wide ? ' nx-modal--wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <h2>{title}</h2>
        <div className="nx-modal__body">{children}</div>
        {actions && <div className="nx-modal__actions">{actions}</div>}
      </div>
    </div>
  );
}
