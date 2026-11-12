// Fechas de calendario 'AAAA-MM-DD' (sin hora ni zona), con la misma aritmética de la v1.0.
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function toUtc(s) {
  return new Date(`${s}T00:00:00Z`);
}

function fmt(d) {
  return d.toISOString().slice(0, 10);
}

function addDays(s, days) {
  const d = toUtc(s);
  d.setUTCDate(d.getUTCDate() + days);
  return fmt(d);
}

// addCalendarMonthsDate de la v1.0: mismo día del mes, recortado al último día si no existe
// (31 de enero + 1 mes = 28/29 de febrero).
function addMonths(s, months) {
  const d = toUtc(s);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return fmt(d);
}

// Días de a hasta b (b − a)
function diffDays(a, b) {
  return Math.round((toUtc(b) - toUtc(a)) / 86400000);
}

const minDate = (a, b) => (a < b ? a : b);

// Acepta AAAA-MM-DD o DD/MM/AAAA (también con guiones): devuelve AAAA-MM-DD o null
function parseFlexibleDate(value) {
  const s = String(value ?? '').trim();
  if (isDate(s)) return s;
  const m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(s);
  if (!m) return null;
  const iso = `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return isDate(iso) ? iso : null;
}

// Hora "19:00", "7pm", "7:00 p. m.", "19" → "HH:MM" o null (normalizeHHMM de la v1.0)
function parseFlexibleTime(value) {
  const s = String(value ?? '').trim().toLowerCase().replace(/\./g, '').replace(/\s+/g, '');
  if (!s) return null;
  const m = /^(\d{1,2})(?::(\d{2}))?(?::\d{2})?(am|pm)?h?$/.exec(s);
  if (!m) return null;
  let h = Number(m[1]);
  const mi = Number(m[2] || 0);
  if (m[3] === 'pm' && h < 12) h += 12;
  if (m[3] === 'am' && h === 12) h = 0;
  if (h > 23 || mi > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}`;
}

module.exports = { isDate, addDays, addMonths, diffDays, minDate, parseFlexibleDate, parseFlexibleTime };
