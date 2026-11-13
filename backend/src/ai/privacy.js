// Privacidad de NexoIA: a la IA nunca le llegan nombres, teléfonos, documentos ni correos.
//   - Las herramientas devuelven solo campos permitidos (placas, montos, horas, códigos).
//   - Los empleados van como códigos "E<id>"; el backend los cambia por el nombre en la respuesta,
//     después de recibirla (resolveEmployeeCodes), y solo si el usuario puede ver a ese empleado.
//   - Además, todo texto que sale (pregunta, historial y resultados) pasa por un redactor que tapa
//     los nombres, teléfonos y correos conocidos de las sedes del usuario y los patrones típicos
//     (correos, celulares, fijos y números de documento).
const { query } = require('../db/pool');

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// Celulares (3xx xxx xxxx), fijos nacionales (60x xxx xxxx) y con indicativo +57
const PHONE_RES = [/\+?57[\s-]?\d{3}[\s-]?\d{3}[\s-]?\d{4}\b/g, /\b3\d{2}[\s-]?\d{3}[\s-]?\d{4}\b/g, /\b60\d[\s-]?\d{3}[\s-]?\d{4}\b/g];
// "cc 1.070.111.222", "cédula 1070111222", "documento: 52.123.456", "NIT 900123456-1"
const DOCUMENT_RE = /\b(c\.?\s?c\.?|c[ée]dula|documento|doc\.?|nit|pasaporte)\s*(n[°oº.]*\s*)?[:#]?\s*[\d][\d.\s-]{4,}\d/gi;

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const normalize = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '');

/**
 * Datos sensibles conocidos dentro del alcance del usuario (sus sedes) y el mapa de empleados.
 * @returns {{ redact(text): string, redactDeep(value): any, employees: Map<number, string> }}
 */
async function buildPrivacy(user, siteIds) {
  const [people, clients] = await Promise.all([
    query(
      `SELECT DISTINCT u.id, u.full_name, u.username FROM users u
         LEFT JOIN user_sites us ON us.user_id = u.id
        WHERE u.role = 'AG' OR us.site_id = ANY($1) OR u.id = $2`,
      [siteIds, user.id],
    ),
    query(
      `SELECT client_name, phones, email FROM monthly_plans WHERE site_id = ANY($1)`,
      [siteIds],
    ),
  ]);
  const employees = new Map(people.rows.map((p) => [p.id, p.full_name]));
  const terms = new Set();
  const addTerm = (t) => {
    const s = String(t ?? '').trim();
    if (s.length >= 3) terms.add(s);
  };
  for (const p of people.rows) {
    addTerm(p.full_name);
    addTerm(p.username);
  }
  for (const c of clients.rows) {
    addTerm(c.client_name);
    for (const ph of c.phones ?? []) addTerm(ph);
    addTerm(c.email);
  }
  // Los más largos primero ("Ana María Torres" antes que "Ana")
  const sorted = [...terms].sort((a, b) => b.length - a.length);
  const patterns = sorted.map((t) => new RegExp(`(?<![\\p{L}\\d])${escapeRe(normalize(t))}(?![\\p{L}\\d])`, 'giu'));

  function redact(text) {
    if (typeof text !== 'string' || !text) return text;
    let out = text.normalize('NFC').replace(EMAIL_RE, '[correo]').replace(DOCUMENT_RE, '[documento]');
    for (const re of PHONE_RES) out = out.replace(re, '[teléfono]');
    // Nombres y datos conocidos: se buscan sin tildes ("Jose" tapa "José"). Quitar las tildes de un
    // texto NFC no cambia su largo, así que las posiciones sirven sobre el texto original.
    for (const re of patterns) {
      const plain = normalize(out);
      if (plain.length !== out.length) {
        out = out.replace(re, '[dato personal]');
        continue;
      }
      const hits = [...plain.matchAll(re)];
      for (const m of hits.reverse()) out = `${out.slice(0, m.index)}[dato personal]${out.slice(m.index + m[0].length)}`;
    }
    return out;
  }

  function redactDeep(value) {
    if (typeof value === 'string') return redact(value);
    if (Array.isArray(value)) return value.map(redactDeep);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactDeep(v)]));
    }
    return value;
  }

  return { redact, redactDeep, employees };
}

// "E12" → nombre del empleado (solo los del alcance del usuario; el resto queda como código)
function resolveEmployeeCodes(text, employees) {
  return String(text ?? '').replace(/\bE(\d{1,9})\b/g, (code, id) => employees.get(Number(id)) ?? code);
}

const employeeCode = (userId) => `E${userId}`;

module.exports = { buildPrivacy, resolveEmployeeCodes, employeeCode };
