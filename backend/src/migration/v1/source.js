// Lectura del archivo exportado de la v1.0 y conversión de sus formatos (fechas, montos, formas de pago).
//
// Formatos aceptados:
//   1. El que genera el botón "Exportar todo a JSON" de la v1.0 (Configuración, solo Superadmin):
//        { format: 'nexo-v1-export', formatVersion: 1, appVersion, exportedAt, exportedBy, keys: { fp_entries: '<json>', ... } }
//   2. Un volcado plano del localStorage: { fp_entries: '<json>' | [...], fp_users: ..., ... }
// Los valores de localStorage son texto: se intenta JSON.parse y, si no es JSON, quedan como texto.
const crypto = require('crypto');

const EXPORT_FORMAT = 'nexo-v1-export';
const BOGOTA_OFFSET = '-05:00'; // Colombia no tiene horario de verano

function parseValue(v) {
  if (typeof v !== 'string') return v;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

/**
 * @param {string|Buffer|object} raw contenido del archivo
 * @returns {{ meta: object, data: Record<string, any>, sha256: string }}
 */
function parseExport(raw) {
  const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : typeof raw === 'string' ? raw : JSON.stringify(raw);
  const sha256 = crypto.createHash('sha256').update(text, 'utf8').digest('hex');
  let obj;
  try {
    obj = JSON.parse(text.replace(/^﻿/, ''));
  } catch (err) {
    throw new Error(`El archivo no es un JSON válido: ${err.message}`);
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('Formato no reconocido: se esperaba un objeto JSON');

  let keys;
  let meta = {};
  if (obj.format === EXPORT_FORMAT) {
    if (obj.formatVersion !== 1) throw new Error(`Versión de exportación no soportada: ${obj.formatVersion}`);
    if (!obj.keys || typeof obj.keys !== 'object') throw new Error('La exportación no trae la sección "keys"');
    keys = obj.keys;
    meta = { appVersion: obj.appVersion ?? null, exportedAt: obj.exportedAt ?? null, exportedBy: obj.exportedBy ?? null };
  } else if (Object.keys(obj).some((k) => k.startsWith('fp_'))) {
    keys = obj;
  } else {
    throw new Error('Formato no reconocido: no es una exportación de la v1.0 (faltan las claves fp_*)');
  }

  const data = {};
  for (const [k, v] of Object.entries(keys)) data[k] = parseValue(v);
  return { meta, data, sha256 };
}

// Lista de una clave (si no es arreglo, vacía)
function list(data, key) {
  const v = data[key];
  return Array.isArray(v) ? v.filter((x) => x && typeof x === 'object') : [];
}

const pad = (n) => String(n).padStart(2, '0');

function validDate(y, m, d) {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/**
 * Fecha y hora de la v1.0 → Date. Formatos:
 *   'dd-mm-aaaa HH:MM[:SS]' (entradas/salidas de ParkApp, hora de Colombia)
 *   ISO con zona ('2026-03-05T15:04:05.000Z', toISOString de los demás registros)
 *   ISO sin zona o 'aaaa-mm-dd' (se toma como hora de Colombia)
 *   número (milisegundos)
 */
function parseDateTime(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const s = String(v).trim();
  let m = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})(?:[\sT]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (m) {
    const [, d, mo, y, h = '0', mi = '0', se = '0'] = m;
    if (!validDate(+y, +mo, +d) || +h > 23 || +mi > 59 || +se > 59) return null;
    return new Date(`${y}-${pad(mo)}-${pad(d)}T${pad(h)}:${pad(mi)}:${pad(se)}${BOGOTA_OFFSET}`);
  }
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T\s](\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)?)?(Z|[+-]\d{2}:?\d{2})?$/);
  if (m) {
    const [, y, mo, d, h = '00', mi = '00', se = '00', frac = '', zone] = m;
    if (!validDate(+y, +mo, +d) || +h > 23 || +mi > 59 || +se > 59) return null;
    const dt = new Date(`${y}-${mo}-${d}T${h}:${mi}:${se}${frac}${zone ?? BOGOTA_OFFSET}`);
    return Number.isNaN(dt.getTime()) ? null : dt;
  }
  return null;
}

// Fecha (sin hora) de la v1.0 → 'AAAA-MM-DD' en hora de Colombia
function parseDate(v) {
  if (v == null || v === '') return null;
  const s = String(v).trim();
  const ymd = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (ymd) return validDate(+ymd[1], +ymd[2], +ymd[3]) ? s : null;
  const dt = parseDateTime(s);
  if (!dt) return null;
  return bogotaDate(dt);
}

function bogotaDate(dt) {
  const local = new Date(dt.getTime() - 5 * 3600 * 1000);
  return `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}`;
}

// Monto COP entero ≥ 0, o null si no es un número válido
function money(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n);
}

// Forma de pago de la v1.0 (normalizePaymentMethod de ParkApp) → v2
function paymentMethod(v) {
  const p = String(v ?? '').trim().toLowerCase();
  if (['cash', 'efectivo', '2'].includes(p)) return 'CASH';
  if (['nequi', 'electronico', 'electrónico', 'electronic', '3'].includes(p)) return 'ELECTRONIC';
  if (['both', 'ambos', 'mixto', 'mixed'].includes(p)) return 'MIXED';
  return null;
}

/**
 * Reparte el valor entre efectivo y electrónico. Devuelve { method, cash, electronic } o { error }.
 * Mixto con todo en un lado se guarda como ese lado.
 */
function splitAmounts(method, total, cashAmount, electronicAmount) {
  if (method === 'CASH') return { method, cash: total, electronic: 0 };
  if (method === 'ELECTRONIC') return { method, cash: 0, electronic: total };
  let cash = money(cashAmount);
  if (cash == null) {
    const el = money(electronicAmount);
    if (el == null) return { error: 'pago mixto sin el valor en efectivo' };
    cash = total - el;
  }
  if (cash < 0 || cash > total) return { error: `pago mixto con efectivo (${cash}) fuera del total (${total})` };
  if (cash === total) return { method: 'CASH', cash: total, electronic: 0 };
  if (cash === 0) return { method: 'ELECTRONIC', cash: 0, electronic: total };
  return { method: 'MIXED', cash, electronic: total - cash };
}

// Vehículo de la v1.0: idTarifa '5' | '6' | '7' o texto 'Carro' | 'Moto' | 'Cicla'
function vehicleType(v) {
  const s = String(v ?? '').trim().toLowerCase();
  if (s === '5' || s.startsWith('carr') || s === 'car') return 'CAR';
  if (s === '6' || s.startsWith('moto')) return 'MOTORCYCLE';
  if (s === '7' || s.startsWith('cicl') || s.startsWith('bici')) return 'BICYCLE';
  return null;
}

// 'HH:MM' válido o null
function hhmm(v) {
  const m = String(v ?? '').trim().match(/^(\d{1,2}):(\d{2})/);
  if (!m || +m[1] > 23 || +m[2] > 59) return null;
  return `${pad(m[1])}:${m[2]}`;
}

module.exports = {
  EXPORT_FORMAT,
  parseExport,
  list,
  parseDateTime,
  parseDate,
  bogotaDate,
  money,
  paymentMethod,
  splitAmounts,
  vehicleType,
  hhmm,
};
