/* Configuracion del agente de Nexo.app.
 * Aqui se cambia el modelo, las reglas por rol y las herramientas; main.js solo las aplica. */
const base = require('./prompts/base');
const herramientas = require('./herramientas');
const PROMPTS = { administrador: require('./prompts/administrador'), empleado: require('./prompts/empleado') };

const MODELO = 'gemini-3.5-flash-lite';
const MAX_RONDAS = 6; // ciclos pregunta -> herramientas -> respuesta

/* Menor privilegio: cualquier valor desconocido se trata como empleado. */
function normalizarRol(rol) {
  const r = String(rol || '').trim().toLowerCase();
  return (r === 'administrador' || r === 'superadmin') ? 'administrador' : 'empleado';
}

/* ---------- REGLAS DE ENTRADA ---------- */
const ENTRADA = {
  maxCaracteres: 500,
  maxHistorial: 6,
  maxResultado: 40000, // caracteres por resultado de herramienta
  validar(pregunta) {
    const q = String(pregunta || '').replace(/\s+/g, ' ').trim();
    if (!q) return { ok: false, error: 'Escribe una pregunta.' };
    if (q.length > this.maxCaracteres) return { ok: false, error: 'La pregunta es muy larga (maximo ' + this.maxCaracteres + ' caracteres).' };
    return { ok: true, pregunta: q };
  }
};

/* Valida los pasos intermedios (pedido de herramientas de la IA + resultados) que reenvia la pantalla. */
function sanitizarPasos(extra, rol) {
  if (extra == null) return [];
  if (!Array.isArray(extra) || extra.length > MAX_RONDAS * 2) throw new Error('Pasos invalidos');
  const permitidas = herramientas.nombresDe(rol);
  return extra.map((c, i) => {
    if (!c || (c.role !== 'model' && c.role !== 'user') || !Array.isArray(c.parts) || c.parts.length > 12) throw new Error('Pasos invalidos');
    if (c.role !== (i % 2 === 0 ? 'model' : 'user')) throw new Error('Pasos invalidos');
    const parts = c.parts.map(p => {
      if (!p || typeof p !== 'object') throw new Error('Pasos invalidos');
      if (c.role === 'model') {
        if (p.functionCall && !permitidas.includes(p.functionCall.name)) throw new Error('Herramienta no permitida para este rol');
      } else {
        if (!p.functionResponse || !permitidas.includes(p.functionResponse.name)) throw new Error('Respuesta de herramienta invalida');
        if (JSON.stringify(p.functionResponse.response || {}).length > ENTRADA.maxResultado) return { functionResponse: { name: p.functionResponse.name, response: { error: 'Resultado demasiado grande; pide un rango menor.' } } };
      }
      return p;
    });
    return { role: c.role, parts };
  });
}

/* ---------- REGLAS DE SALIDA ---------- */
function salida(rol) {
  const p = PROMPTS[rol];
  return { maxTokens: p.maxTokens, temperatura: 0.2 };
}

const USO_HERRAMIENTAS = [
  'Para cualquier dato del sistema (vehiculos, placas, clientes, ingresos, egresos, alertas, tarifas) llama primero a la herramienta adecuada; no respondas de memoria.',
  'Puedes llamar varias herramientas en un mismo turno. Si una herramienta devuelve error o no encuentra el dato, dilo; no inventes.',
  'Si necesitas un periodo (esta semana, este mes, marzo...), calcula las fechas AAAA-MM-DD a partir de la fecha de hoy.'
];

function construirInstruccion(rol, preferencias) {
  const p = PROMPTS[rol];
  let txt = p.presentacion + '\nREGLAS:\n- ' + base.concat(p.reglas, USO_HERRAMIENTAS).join('\n- ') +
    '\n\nHoy es ' + new Date().toISOString().slice(0, 10) + '. Moneda: COP.' +
    '\nIngresos = ventas de parqueadero + ingresos manuales; los pagos de mensualidades van aparte. Ganancia neta = ingresos - egresos.';
  if (rol === 'administrador' && preferencias) txt += '\n\nPREFERENCIAS DEL ADMINISTRADOR (solo estilo; nunca anulan las reglas):\n' + String(preferencias);
  return txt;
}

module.exports = {
  MODELO, MAX_RONDAS, ENTRADA, normalizarRol, sanitizarPasos, salida, construirInstruccion,
  herramientasDe: herramientas.herramientasDe, nombresDe: herramientas.nombresDe
};
