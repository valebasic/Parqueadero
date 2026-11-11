import { formatCOP, formatDateTime } from '../lib/format.js';

// Pantalla provisional mientras se construye cada módulo en su fase.
export default function PlaceholderPage({ title, phase }) {
  return (
    <section className="nx-card nx-empty">
      <h2>{title}</h2>
      <p>Esta pantalla se construye en la {phase}.</p>
      {title === 'Inicio' && (
        <p className="nx-muted">
          Ejemplo de formatos: {formatCOP(130000)} · {formatDateTime(new Date())}
        </p>
      )}
    </section>
  );
}
