// Horas trabajadas según el calendario laboral de Colombia (RF44).
//
//   - Festivos: Ley 51 de 1983 ("Ley Emiliani"): los fijos (1 ene, 1 may, 20 jul, 7 ago, 8 dic,
//     25 dic) y Jueves y Viernes Santo se celebran en su día; Reyes, San José, San Pedro y San Pablo,
//     Asunción, Día de la Raza, Todos los Santos e Independencia de Cartagena, y los que dependen de
//     la Pascua (Ascensión, Corpus Christi, Sagrado Corazón) se pasan al lunes siguiente.
//   - Jornada nocturna: desde el 25 de diciembre de 2025 va de 7:00 p. m. a 6:00 a. m. (Ley 2466 de
//     2025); antes, de 9:00 p. m. a 6:00 a. m.
//   - Dominical o festivo: por el día calendario (hora de Colombia) en que se trabajó cada minuto.
//   Todo en hora de Colombia (UTC−5, sin horario de verano).

const OFFSET_MS = 5 * 3600 * 1000;
const NIGHT_REFORM_DATE = '2025-12-25';
const DAY_START = 6 * 60;

const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const utcDate = (y, m, d) => new Date(Date.UTC(y, m - 1, d));
const addDays = (d, n) => new Date(d.getTime() + n * 86400000);

// Domingo de Pascua (algoritmo de Meeus/Jones/Butcher, calendario gregoriano)
function easterSunday(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return utcDate(year, month, day);
}

// Lunes siguiente (o el mismo día si ya es lunes)
function nextMonday(d) {
  const dow = d.getUTCDay();
  return dow === 1 ? d : addDays(d, (8 - dow) % 7);
}

const holidayCache = new Map();

/** Festivos de Colombia del año: Map 'AAAA-MM-DD' → nombre */
function colombianHolidays(year) {
  if (holidayCache.has(year)) return holidayCache.get(year);
  const map = new Map();
  const add = (d, name) => map.set(ymd(d), name);
  add(utcDate(year, 1, 1), 'Año Nuevo');
  add(nextMonday(utcDate(year, 1, 6)), 'Reyes Magos');
  add(nextMonday(utcDate(year, 3, 19)), 'San José');
  const easter = easterSunday(year);
  add(addDays(easter, -3), 'Jueves Santo');
  add(addDays(easter, -2), 'Viernes Santo');
  add(utcDate(year, 5, 1), 'Día del Trabajo');
  add(addDays(easter, 43), 'Ascensión del Señor');
  add(addDays(easter, 64), 'Corpus Christi');
  add(addDays(easter, 71), 'Sagrado Corazón');
  add(nextMonday(utcDate(year, 6, 29)), 'San Pedro y San Pablo');
  add(utcDate(year, 7, 20), 'Día de la Independencia');
  add(utcDate(year, 8, 7), 'Batalla de Boyacá');
  add(nextMonday(utcDate(year, 8, 15)), 'Asunción de la Virgen');
  add(nextMonday(utcDate(year, 10, 12)), 'Día de la Raza');
  add(nextMonday(utcDate(year, 11, 1)), 'Todos los Santos');
  add(nextMonday(utcDate(year, 11, 11)), 'Independencia de Cartagena');
  add(utcDate(year, 12, 8), 'Inmaculada Concepción');
  add(utcDate(year, 12, 25), 'Navidad');
  holidayCache.set(year, map);
  return map;
}

function holidayName(dateStr) {
  return colombianHolidays(Number(dateStr.slice(0, 4))).get(dateStr) ?? null;
}

// ¿Domingo o festivo? (fecha 'AAAA-MM-DD')
function isSundayOrHoliday(dateStr) {
  return new Date(`${dateStr}T00:00:00Z`).getUTCDay() === 0 || holidayName(dateStr) !== null;
}

// Minuto del día en que empieza la jornada nocturna para esa fecha
function nightStartFor(dateStr) {
  return dateStr >= NIGHT_REFORM_DATE ? 19 * 60 : 21 * 60;
}

/**
 * Reparte un intervalo trabajado en minutos por categoría, y por fecha (hora de Colombia).
 * @returns {{ total, day, night, holidayDay, holidayNight, byDate: Map<string, {...}> }}
 *   day/night = ordinarias diurnas/nocturnas; holidayDay/holidayNight = en domingo o festivo.
 */
function splitWorkedTime(start, end) {
  const empty = () => ({ total: 0, day: 0, night: 0, holidayDay: 0, holidayNight: 0 });
  const out = { ...empty(), byDate: new Map() };
  let t = new Date(start).getTime();
  const stop = new Date(end).getTime();
  if (!(stop > t)) return out;
  // Se trabaja en minutos enteros
  t = Math.floor(t / 60000) * 60000;
  while (t < stop) {
    const local = new Date(t - OFFSET_MS);
    const date = ymd(local);
    const minute = local.getUTCHours() * 60 + local.getUTCMinutes();
    const nightStart = nightStartFor(date);
    // Próximo límite: 6:00, inicio de la noche o medianoche
    const bounds = [DAY_START, nightStart, 1440].filter((b) => b > minute);
    const nextBoundary = t + (Math.min(...bounds) - minute) * 60000;
    const segEnd = Math.min(nextBoundary, stop);
    const minutes = Math.round((segEnd - t) / 60000);
    const isNight = minute < DAY_START || minute >= nightStart;
    const holiday = isSundayOrHoliday(date);
    const key = holiday ? (isNight ? 'holidayNight' : 'holidayDay') : isNight ? 'night' : 'day';
    if (!out.byDate.has(date)) out.byDate.set(date, empty());
    const bucket = out.byDate.get(date);
    bucket[key] += minutes;
    bucket.total += minutes;
    out[key] += minutes;
    out.total += minutes;
    t = segEnd;
  }
  return out;
}

// Semana ISO de una fecha 'AAAA-MM-DD' → { key: '2026-W46', start: '2026-11-09' (lunes) }
function isoWeek(dateStr) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  const dow = (d.getUTCDay() + 6) % 7; // 0 = lunes
  const monday = addDays(d, -dow);
  const thursday = addDays(monday, 3);
  const yearStart = utcDate(thursday.getUTCFullYear(), 1, 1);
  const week = Math.ceil(((thursday - yearStart) / 86400000 + 1) / 7);
  return { key: `${thursday.getUTCFullYear()}-W${pad(week)}`, start: ymd(monday) };
}

module.exports = {
  colombianHolidays,
  holidayName,
  isSundayOrHoliday,
  nightStartFor,
  splitWorkedTime,
  isoWeek,
  easterSunday,
  NIGHT_REFORM_DATE,
};
