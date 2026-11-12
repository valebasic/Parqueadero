/* Memoria del agente: solo PREFERENCIAS del administrador.
 * Se guarda en la carpeta de datos del usuario (el instalador es de solo lectura). */
const fs = require('fs');
const path = require('path');

const MAX = 400;
let dir = null;
function init(userDataPath) { dir = path.join(userDataPath, 'agente-memoria'); }
function file() { return path.join(dir, 'preferencias.json'); }

function leer() {
  try { return String(JSON.parse(fs.readFileSync(file(), 'utf8')).preferencias || ''); } catch (e) { return ''; }
}
function guardar(texto) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const limpio = String(texto || '').replace(/\s+/g, ' ').trim().slice(0, MAX);
    fs.writeFileSync(file(), JSON.stringify({ preferencias: limpio, actualizado: new Date().toISOString() }), 'utf8');
    return { ok: true, preferencias: limpio };
  } catch (e) { return { ok: false, error: e.message }; }
}
/* Registro de auditoria de acciones del agente (propuestas, confirmadas, canceladas, fallidas). Una linea JSON por evento. */
function auditar(evento) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const linea = JSON.stringify(Object.assign({ fecha: new Date().toISOString() }, evento && typeof evento === 'object' ? evento : { evento: String(evento) })).slice(0, 4000);
    fs.appendFileSync(path.join(dir, 'auditoria.jsonl'), linea + '\n', 'utf8');
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
}
module.exports = { init, leer, guardar, auditar, MAX };
