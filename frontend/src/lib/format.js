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
