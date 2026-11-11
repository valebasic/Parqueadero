// Formatos de presentación para Colombia, implementados a mano para que no dependan
// de los datos de idioma del navegador: $ 1.800 · 05/03/2026 · 2:05 p. m.

const pad2 = (n) => String(n).padStart(2, '0');

// Monto en pesos colombianos (enteros) con punto como separador de miles: 130000 → "$ 130.000"
export function formatCOP(amount) {
  const value = Math.round(Number(amount) || 0);
  const digits = String(Math.abs(value)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${value < 0 ? '-' : ''}$ ${digits}`;
}

// Fecha dd/mm/aaaa
export function formatDate(input) {
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) return '—';
  return `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()}`;
}

// Hora en formato de 12 horas: "2:05 p. m." (con segundos opcionales)
export function formatTime12h(input, { seconds = false } = {}) {
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) return '—';
  const h24 = d.getHours();
  const h12 = h24 % 12 || 12;
  const suffix = h24 < 12 ? 'a. m.' : 'p. m.';
  const secs = seconds ? `:${pad2(d.getSeconds())}` : '';
  return `${h12}:${pad2(d.getMinutes())}${secs} ${suffix}`;
}

// "05/03/2026 2:05 p. m."
export function formatDateTime(input) {
  return `${formatDate(input)} ${formatTime12h(input)}`;
}

// Duración legible: 1.505 min → "1 día 1 h 5 min"
export function formatDuration(totalMinutes) {
  const m = Math.max(0, Math.floor(Number(totalMinutes) || 0));
  const days = Math.floor(m / 1440);
  const hours = Math.floor((m % 1440) / 60);
  const minutes = m % 60;
  const parts = [];
  if (days) parts.push(`${days} ${days === 1 ? 'día' : 'días'}`);
  if (hours) parts.push(`${hours} h`);
  if (minutes || parts.length === 0) parts.push(`${minutes} min`);
  return parts.join(' ');
}

// Fecha local de hoy en formato AAAA-MM-DD (para filtros de fecha)
export function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

export const PAYMENT_LABELS = {
  CASH: 'Efectivo',
  ELECTRONIC: 'Electrónico',
  MIXED: 'Efectivo + Electrónico',
  PENDING: 'Pendiente',
};
