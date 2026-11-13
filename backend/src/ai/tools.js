// Herramientas de NexoIA. Todas son de SOLO LECTURA sobre PostgreSQL y reutilizan los servicios de la
// API con la petición (req) del usuario: los mismos permisos por sede (AG todas, AS las suyas, OP las
// asignadas). Las acciones (proponer_*) no cambian nada: crean una propuesta que la persona confirma
// en una tarjeta y que el frontend ejecuta contra el endpoint normal.
//
// Por rol (de la v1.0, AGENTE.md §6):
//   AS/AG: resumen_periodo, comparar_periodos, ocupacion_por_franja, actividad_por_empleado, buscar_alertas
//   todos: vehiculos_activos, consultar_placa, calcular_cobro, consultar_tarifas
// Lo que devuelven nunca incluye nombres, teléfonos, documentos ni correos (empleados = "E<id>").
const { query } = require('../db/pool');
const HttpError = require('../middlewares/httpError');
const { normalizePlate, plateError, VEHICLE_LABELS } = require('../lib/plates');
const { MAX_MONEY } = require('../lib/payments');
const entries = require('../services/entries.service');
const config = require('../services/config.service');
const reports = require('../services/reports.service');
const monthly = require('../services/monthly.service');
const { EXPENSE_CATEGORIES } = require('../services/movements.service');
const { accounting } = require('../services/admin/accounting.service');
const { compareSites } = require('../services/admin/compare.service');
const { overview } = require('../services/admin/overview.service');
const alerts = require('../services/admin/alerts.service');
const staff = require('../services/admin/staff.service');
const alertRules = require('./alertRules');
const { employeeCode } = require('./privacy');
const aiConfig = require('./config');

// ---------------------------------------------------------------------------
// Declaraciones (formato de Gemini)
// ---------------------------------------------------------------------------
const S = (description) => ({ type: 'STRING', description });
const FECHA = 'Fecha en formato AAAA-MM-DD';
const SEDE = S('Opcional. Código de la sede (por ejemplo FACA). Sin sede = todas las sedes de la persona.');

const DECLARATIONS = {
  // --- Todos los roles ---
  vehiculos_activos: {
    description: 'Vehículos que están dentro ahora mismo: placa, tipo, sede, hora de entrada, minutos dentro, valor actual a cobrar y si tienen mensualidad.',
    parameters: { type: 'OBJECT', properties: {
      servicio: S('Opcional. "Carro", "Moto" o "Cicla".'),
      sin_mensualidad: { type: 'BOOLEAN', description: 'Opcional. true para excluir los vehículos con mensualidad.' },
      sede: SEDE,
    } },
  },
  consultar_placa: {
    description: 'Estado de una placa: si está dentro (hora de entrada y valor actual), o su última salida y total cobrado; número de visitas y si tiene mensualidad vigente.',
    parameters: { type: 'OBJECT', properties: { placa: S('Placa, por ejemplo ABC123.'), sede: SEDE }, required: ['placa'] },
  },
  calcular_cobro: {
    description: 'Valor a cobrar ahora por un vehículo que está dentro, con el tiempo y la tarifa aplicada.',
    parameters: { type: 'OBJECT', properties: { placa: S('Placa del vehículo.') }, required: ['placa'] },
  },
  consultar_tarifas: {
    description: 'Tarifas vigentes por tipo de vehículo (fracción, hora, tope de 12 h, mensualidad) y cambios programados.',
    parameters: { type: 'OBJECT', properties: { sede: SEDE } },
  },
  proponer_entrada: {
    description: 'Propone registrar la entrada de un vehículo por su placa. No ejecuta nada: la persona debe confirmarla con un botón.',
    parameters: { type: 'OBJECT', properties: { placa: S('Placa del vehículo.'), sede: SEDE }, required: ['placa'] },
  },
  // --- Solo AS y AG ---
  resumen_periodo: {
    description: 'Resumen entre dos fechas (máximo 400 días) por sede y consolidado: vehículos, ventas de parqueadero, ticket promedio, estancia y ocupación promedio, mensualidades, otros ingresos, egresos por categoría, utilidad y diferencias de arqueo. Hasta 31 días incluye el detalle por día.',
    parameters: { type: 'OBJECT', properties: { desde: S(FECHA), hasta: S(FECHA), sede: SEDE }, required: ['desde', 'hasta'] },
  },
  comparar_periodos: {
    description: 'Compara dos periodos (A contra B): resumen consolidado de cada uno y variación porcentual de vehículos, ingresos, egresos y utilidad.',
    parameters: { type: 'OBJECT', properties: { desde_a: S(FECHA), hasta_a: S(FECHA), desde_b: S(FECHA), hasta_b: S(FECHA), sede: SEDE }, required: ['desde_a', 'hasta_a', 'desde_b', 'hasta_b'] },
  },
  ocupacion_por_franja: {
    description: 'Ocupación entre dos fechas: franjas horarias con más entradas, entradas por día de la semana y ocupación promedio por sede.',
    parameters: { type: 'OBJECT', properties: { desde: S(FECHA), hasta: S(FECHA), sede: SEDE }, required: ['desde', 'hasta'] },
  },
  actividad_por_empleado: {
    description: 'Actividad por empleado entre dos fechas: turnos, horas trabajadas (diurnas, nocturnas, dominicales/festivas), entradas registradas, ventas de sus turnos y diferencias de arqueo. Los empleados vienen como códigos (E12...): úsalos tal cual.',
    parameters: { type: 'OBJECT', properties: { desde: S(FECHA), hasta: S(FECHA), sede: SEDE }, required: ['desde', 'hasta'] },
  },
  buscar_alertas: {
    description: 'Alertas actuales: las del panel (zona sin turno, ocupación alta, diferencia de arqueo, sede sin conexión) y las reglas del administrador (vehículos con más de 24 h, caída de ingresos, cobros pendientes, mensualidades por vencer, egresos inusuales).',
    parameters: { type: 'OBJECT', properties: { sede: SEDE } },
  },
  proponer_movimiento: {
    description: 'Propone registrar un ingreso o egreso manual en la caja de un turno abierto. No ejecuta nada: la persona debe confirmarlo con un botón.',
    parameters: { type: 'OBJECT', properties: {
      tipo: { type: 'STRING', enum: ['ingreso', 'egreso'], description: 'ingreso o egreso.' },
      valor: { type: 'INTEGER', description: 'Valor en pesos, entero y mayor que cero.' },
      concepto: S('Concepto, por ejemplo "papelería".'),
      categoria: { type: 'STRING', enum: Object.keys(EXPENSE_CATEGORIES), description: 'Solo egresos: categoría (por defecto OTHER).' },
      sede: SEDE,
    }, required: ['tipo', 'valor', 'concepto'] },
  },
  proponer_informe: {
    description: 'Propone descargar el informe de una sede y un periodo en PDF o Excel. No ejecuta nada: la persona debe confirmarlo con un botón.',
    parameters: { type: 'OBJECT', properties: {
      desde: S(FECHA), hasta: S(FECHA),
      formato: { type: 'STRING', enum: ['pdf', 'excel'], description: 'pdf o excel. Por defecto pdf.' },
      sede: SEDE,
    }, required: ['desde', 'hasta'] },
  },
  proponer_ajuste_tarifa: {
    description: 'Propone cambiar una tarifa desde ahora (queda en el historial de tarifas). No ejecuta nada: la persona debe confirmarlo con un botón.',
    parameters: { type: 'OBJECT', properties: {
      servicio: S('Carro, Moto o Cicla.'),
      campo: { type: 'STRING', enum: ['hora', 'fraccion', 'tope_12_horas', 'mensualidad'], description: 'Qué valor se cambia.' },
      valor: { type: 'INTEGER', description: 'Nuevo valor en pesos.' },
      sede: SEDE,
    }, required: ['servicio', 'campo', 'valor'] },
  },
  proponer_renovar_mensualidad: {
    description: 'Propone cobrar la renovación de la mensualidad de una placa. Si no dijeron el medio de pago, pregúntalo antes. No ejecuta nada: la persona debe confirmarlo con un botón.',
    parameters: { type: 'OBJECT', properties: {
      placa: S('Placa de la mensualidad.'),
      medio_pago: { type: 'STRING', enum: ['efectivo', 'electronico'], description: 'efectivo o electronico.' },
      sede: SEDE,
    }, required: ['placa', 'medio_pago'] },
  },
};

const COMMON = ['vehiculos_activos', 'consultar_placa', 'calcular_cobro', 'consultar_tarifas', 'proponer_entrada'];
const ADMIN_ONLY = [
  'resumen_periodo', 'comparar_periodos', 'ocupacion_por_franja', 'actividad_por_empleado', 'buscar_alertas',
  'proponer_movimiento', 'proponer_informe', 'proponer_ajuste_tarifa', 'proponer_renovar_mensualidad',
];
const BY_ROLE = { administrador: [...COMMON, ...ADMIN_ONLY], empleado: COMMON };

function namesFor(role) {
  return BY_ROLE[role] ?? COMMON;
}
function declarationsFor(role) {
  return namesFor(role).map((name) => ({ name, ...DECLARATIONS[name] }));
}

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------
class ToolError extends Error {}

const TYPE_BY_NAME = { carro: 'CAR', carros: 'CAR', car: 'CAR', moto: 'MOTORCYCLE', motos: 'MOTORCYCLE', cicla: 'BICYCLE', ciclas: 'BICYCLE', bicicleta: 'BICYCLE' };
const vehicleOf = (s) => TYPE_BY_NAME[String(s ?? '').trim().toLowerCase()] ?? null;
const pad = (n) => String(n).padStart(2, '0');
function localText(d) {
  if (!d) return null;
  const t = new Date(new Date(d).getTime() - 5 * 3600000);
  const h = t.getUTCHours();
  return `${pad(t.getUTCDate())}/${pad(t.getUTCMonth() + 1)}/${t.getUTCFullYear()} ${h % 12 || 12}:${pad(t.getUTCMinutes())} ${h < 12 ? 'a. m.' : 'p. m.'}`;
}
const todayLocal = () => new Date(Date.now() - 5 * 3600000).toISOString().slice(0, 10);
function daysAgo(n) {
  return new Date(Date.now() - 5 * 3600000 - n * 86400000).toISOString().slice(0, 10);
}
function monthsAgoStart(n) {
  const t = new Date(Date.now() - 5 * 3600000);
  return new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() - n, 1)).toISOString().slice(0, 10);
}
function isDate(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
}
function range(desde, hasta) {
  if (!isDate(desde) || !isDate(hasta)) throw new ToolError('Las fechas deben tener formato AAAA-MM-DD.');
  if (desde > hasta) throw new ToolError('La fecha "desde" es posterior a "hasta".');
  return { from: desde, to: hasta };
}
const pct = (a, b) => (b ? Math.round(((a - b) / b) * 1000) / 10 : null);

// Sedes sobre las que actúa la herramienta (siempre dentro del alcance de la persona)
function pickSites(ctx, sede) {
  if (sede) {
    const site = ctx.sites.find((s) => s.code === String(sede).trim().toUpperCase());
    if (!site) throw new ToolError(`La sede ${sede} no existe o no está entre las sedes de esta persona.`);
    return [site];
  }
  if (ctx.role === 'empleado' && ctx.shiftSiteId) return ctx.sites.filter((s) => s.id === ctx.shiftSiteId);
  return ctx.sites;
}
function pickOneSite(ctx, sede) {
  const sites = pickSites(ctx, sede);
  if (sites.length !== 1) {
    throw new ToolError(`Indica la sede (códigos: ${ctx.sites.map((s) => s.code).join(', ')}).`);
  }
  return sites[0];
}
// Filtro de alcance para los servicios del panel (una sede o todas las de la persona)
// eslint-disable-next-line no-unused-vars
const scopeFilter = (sites, ctx) => (sites.length === 1 ? { siteId: sites[0].id } : {});

// ---------------------------------------------------------------------------
// Lectura: todos los roles
// ---------------------------------------------------------------------------

async function openVehicles(ctx, { servicio, sin_mensualidad: sinMensualidad, sede }) {
  const sites = pickSites(ctx, sede);
  const type = servicio ? vehicleOf(servicio) : null;
  if (servicio && !type) throw new ToolError('Servicio inválido: usa Carro, Moto o Cicla.');
  const list = [];
  for (const site of sites) {
    for (const e of await entries.listOpenEntries(ctx.req, site.id)) list.push({ ...e, site });
  }
  const filtered = list.filter((e) => (!type || e.vehicleType === type) && (!sinMensualidad || !e.monthlyPlanId));
  const LIMIT = 60;
  const vehicles = [];
  for (const e of filtered.slice(0, LIMIT)) {
    const q = await entries.quoteExit(ctx.req, e.id);
    vehicles.push({
      placa: e.plate,
      tipo: VEHICLE_LABELS[e.vehicleType],
      sede: e.site.code,
      entrada: localText(e.entryAt),
      minutos_dentro: q.minutes,
      valor_actual: q.total,
      mensualidad: Boolean(e.monthlyPlanId),
    });
  }
  return { total: filtered.length, mostrados: vehicles.length, calculado_a: localText(new Date()), vehiculos: vehicles };
}

async function plateInfo(ctx, { placa, sede }) {
  const plate = normalizePlate(placa);
  const err = plateError(plate);
  if (err) throw new ToolError(`Placa inválida: ${err}`);
  const sites = pickSites(ctx, sede);
  const ids = sites.map((s) => s.id);
  const look = await entries.lookupPlate(ctx.req, sites[0].id, plate);
  const out = { placa: plate, tipo: VEHICLE_LABELS[look.vehicleType] ?? null };
  const open = look.openEntry;
  if (open && ids.includes(open.siteId)) {
    const q = await entries.quoteExit(ctx.req, open.id);
    Object.assign(out, {
      estado: 'dentro',
      sede: ctx.sites.find((s) => s.id === open.siteId)?.code,
      recibo: open.receipt,
      entrada: localText(open.entryAt),
      minutos_dentro: q.minutes,
      valor_actual: q.total,
      calculado_a: localText(q.at),
    });
  } else if (open) {
    out.estado = 'dentro de otra sede (sin acceso a sus datos)';
  } else {
    const { rows } = await query(
      `SELECT site_id, entry_at, exit_at, charged_amount, status FROM entries
        WHERE plate = $1 AND site_id = ANY($2) AND status <> 'OPEN' ORDER BY exit_at DESC NULLS LAST LIMIT 1`,
      [plate, ids],
    );
    if (rows[0]) {
      Object.assign(out, {
        estado: rows[0].status === 'CANCELLED' ? 'entrada anulada' : rows[0].status === 'PENDING_CHARGE' ? 'salió con cobro pendiente' : 'salió',
        sede: ctx.sites.find((s) => s.id === rows[0].site_id)?.code,
        ultima_entrada: localText(rows[0].entry_at),
        ultima_salida: localText(rows[0].exit_at),
        total_cobrado: rows[0].charged_amount,
      });
    } else out.estado = 'sin registros en estas sedes';
  }
  const { rows: visits } = await query('SELECT count(*) AS n FROM entries WHERE plate = $1 AND site_id = ANY($2)', [plate, ids]);
  out.visitas = visits[0].n;
  // Mensualidad: solo si está vigente y su horario; nunca el titular
  out.mensualidad = look.monthly
    ? { vigente: true, horario: look.monthly.schedule === 'NIGHT' ? `nocturna ${look.monthly.nightStart}–${look.monthly.nightEnd}` : 'día completo', vence: look.monthly.endDate }
    : { vigente: false };
  return out;
}

async function quote(ctx, { placa }) {
  const plate = normalizePlate(placa);
  if (plateError(plate)) throw new ToolError('Placa inválida.');
  const ids = ctx.sites.map((s) => s.id);
  const { rows } = await query(
    "SELECT id, site_id FROM entries WHERE plate = $1 AND status = 'OPEN' AND site_id = ANY($2) ORDER BY entry_at DESC LIMIT 1",
    [plate, ids],
  );
  if (!rows[0]) return { placa: plate, dentro: false, mensaje: 'La placa no está dentro en tus sedes.' };
  const q = await entries.quoteExit(ctx.req, rows[0].id);
  return {
    placa: plate,
    dentro: true,
    sede: ctx.sites.find((s) => s.id === rows[0].site_id)?.code,
    entrada: localText(q.entry.entryAt),
    minutos: q.minutes,
    valor_a_cobrar: q.total,
    calculado_a: localText(q.at),
    tarifa: q.rate ? { fraccion: q.rate.fractionAmount, hora: q.rate.hourAmount, tope_12h: q.rate.full12hAmount } : null,
    va_a_pendientes: q.goesToPending,
  };
}

async function rates(ctx, { sede }) {
  const out = [];
  for (const site of pickSites(ctx, sede)) {
    const r = await config.listRates(ctx.req, site.id);
    const fmt = (x) => ({
      servicio: VEHICLE_LABELS[x.vehicleType],
      fraccion: x.fractionAmount,
      hora: x.hourAmount,
      tope_12h: x.full12hAmount,
      mensualidad: x.monthlyAmount,
      modo: x.pricingMode === 'block12h' ? 'por bloques de 12 h' : 'normal',
      desde: localText(x.validFrom),
    });
    out.push({ sede: site.code, vigentes: r.current.map(fmt), programadas: r.scheduled.map(fmt) });
  }
  return { tarifas: out };
}

// ---------------------------------------------------------------------------
// Lectura: AS y AG (reutiliza contabilidad, comparativo, panel, alertas y turnos)
// ---------------------------------------------------------------------------

async function periodSummary(ctx, desde, hasta, sede) {
  const r = range(desde, hasta);
  const sites = pickSites(ctx, sede);
  const filter = scopeFilter(sites, ctx);
  const [acc, cmp] = await Promise.all([
    accounting(ctx.req, { ...r, ...filter }),
    compareSites(ctx.req, { ...r, ...filter }),
  ]);
  const ids = sites.map((s) => s.id);
  const perSite = [];
  for (const s of acc.sites.filter((x) => ids.includes(x.site.id))) {
    const k = (await reports.summary(ctx.req, { siteId: s.site.id, ...r })).kpis;
    const c = cmp.sites.find((x) => x.site.id === s.site.id) ?? {};
    const st = s.statement;
    perSite.push({
      sede: s.site.code,
      vehiculos: k.vehicles,
      salidas: k.exits,
      ventas_parqueadero: st.income.parking,
      cantidad_ventas: k.salesCount,
      ticket_promedio: c.ticketAverage ?? null,
      estancia_promedio_min: c.averageStayMinutes ?? null,
      ocupacion_promedio_pct: c.occupancyAverage ?? null,
      mensualidades: st.income.monthly,
      otros_ingresos: st.income.other,
      ingresos_total: st.income.total,
      egresos: st.expenses.total,
      egresos_por_categoria: Object.fromEntries(Object.entries(st.expenses.byCategory).filter(([, v]) => v).map(([cat, v]) => [EXPENSE_CATEGORIES[cat], v])),
      utilidad: st.profit,
      faltantes_arqueo: s.differences.totals.shortage,
      sobrantes_arqueo: s.differences.totals.surplus,
      dias_con_actividad: s.cashFlow.filter((d) => d.income || d.expenses).length,
    });
  }
  const sum = (k) => perSite.reduce((a, s) => a + (s[k] ?? 0), 0);
  const consolidated = {
    vehiculos: sum('vehiculos'),
    ventas_parqueadero: sum('ventas_parqueadero'),
    cantidad_ventas: sum('cantidad_ventas'),
    ticket_promedio: sum('cantidad_ventas') ? Math.round(sum('ventas_parqueadero') / sum('cantidad_ventas')) : null,
    mensualidades: sum('mensualidades'),
    otros_ingresos: sum('otros_ingresos'),
    ingresos_total: sum('ingresos_total'),
    egresos: sum('egresos'),
    utilidad: sum('utilidad'),
    faltantes_arqueo: sum('faltantes_arqueo'),
  };
  const out = { periodo: r, sedes: perSite, consolidado: consolidated };
  const days = (Date.parse(r.to) - Date.parse(r.from)) / 86400000 + 1;
  if (days <= 31) {
    // Detalle por día del bloque consolidado de contabilidad (solo de las sedes pedidas)
    const block = sites.length === ctx.sites.length || filter.siteId ? acc.consolidated : null;
    if (block) {
      out.detalle_por_dia = block.cashFlow.filter((d) => d.income || d.expenses).map((d) => ({ fecha: d.date, ingresos: d.income, egresos: d.expenses, neto: d.net }));
    }
  }
  return out;
}

async function comparePeriods(ctx, a) {
  const [pa, pb] = [await periodSummary(ctx, a.desde_a, a.hasta_a, a.sede), await periodSummary(ctx, a.desde_b, a.hasta_b, a.sede)];
  const A = pa.consolidado;
  const B = pb.consolidado;
  return {
    periodo_a: { ...pa.periodo, ...A },
    periodo_b: { ...pb.periodo, ...B },
    variacion_pct_a_vs_b: {
      vehiculos: pct(A.vehiculos, B.vehiculos),
      ingresos_total: pct(A.ingresos_total, B.ingresos_total),
      egresos: pct(A.egresos, B.egresos),
      utilidad: pct(A.utilidad, B.utilidad),
      ticket_promedio: pct(A.ticket_promedio ?? 0, B.ticket_promedio ?? 0),
    },
  };
}

const DOW = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
async function occupancyByHour(ctx, { desde, hasta, sede }) {
  const r = range(desde, hasta);
  const sites = pickSites(ctx, sede);
  const ids = sites.map((s) => s.id);
  const [hours, days, cmp] = await Promise.all([
    query(
      `SELECT extract(hour FROM entry_at)::int AS h, count(*) AS n FROM entries
        WHERE site_id = ANY($1) AND entry_at >= $2::date AND entry_at < $3::date + 1 AND status <> 'CANCELLED' GROUP BY 1 ORDER BY n DESC`,
      [ids, r.from, r.to],
    ),
    query(
      `SELECT extract(dow FROM entry_at)::int AS d, count(*) AS n FROM entries
        WHERE site_id = ANY($1) AND entry_at >= $2::date AND entry_at < $3::date + 1 AND status <> 'CANCELLED' GROUP BY 1 ORDER BY 1`,
      [ids, r.from, r.to],
    ),
    compareSites(ctx.req, { ...r, ...scopeFilter(sites, ctx) }),
  ]);
  const hourLabel = (h) => `${h % 12 || 12}:00 ${h < 12 ? 'a. m.' : 'p. m.'}–${(h + 1) % 12 || 12}:00 ${h + 1 < 12 || h + 1 === 24 ? 'a. m.' : 'p. m.'}`;
  return {
    periodo: r,
    franjas_con_mas_entradas: hours.rows.slice(0, 6).map((x) => ({ franja: hourLabel(x.h), entradas: x.n })),
    entradas_por_dia_semana: days.rows.map((x) => ({ dia: DOW[x.d], entradas: x.n })),
    ocupacion_promedio_por_sede: cmp.sites.filter((s) => ids.includes(s.site.id)).map((s) => ({ sede: s.site.code, ocupacion_pct: s.occupancyAverage })),
  };
}

async function employeeActivity(ctx, { desde, hasta, sede }) {
  const r = range(desde, hasta);
  const sites = pickSites(ctx, sede);
  const filter = scopeFilter(sites, ctx);
  const [hours, report, registered] = await Promise.all([
    staff.workedHours(ctx.req, { ...r, ...filter, groupBy: 'month' }),
    staff.shiftReport(ctx.req, { ...r, ...filter }),
    query(
      `SELECT entry_by, count(*) AS n FROM entries
        WHERE site_id = ANY($1) AND entry_at >= $2::date AND entry_at < $3::date + 1 GROUP BY 1`,
      [sites.map((s) => s.id), r.from, r.to],
    ),
  ]);
  const by = new Map();
  const get = (id) => {
    if (!by.has(id)) by.set(id, { empleado: employeeCode(id), turnos: 0, horas: 0, horas_diurnas: 0, horas_nocturnas: 0, horas_dominicales_festivas: 0, entradas_registradas: 0, ventas_turnos: 0, faltantes: 0, sobrantes: 0 });
    return by.get(id);
  };
  for (const e of hours.employees) {
    const x = get(e.user.id);
    x.turnos = e.shifts;
    x.horas = e.hours.total;
    x.horas_diurnas = e.hours.day;
    x.horas_nocturnas = e.hours.night;
    x.horas_dominicales_festivas = Math.round((e.hours.holidayDay + e.hours.holidayNight) * 100) / 100;
  }
  for (const i of report.items) {
    const x = get(i.user.id);
    x.ventas_turnos += i.sales.total;
    if (i.difference < 0) x.faltantes -= i.difference;
    if (i.difference > 0) x.sobrantes += i.difference;
  }
  for (const row of registered.rows) {
    if (ctx.privacy.employees.has(row.entry_by)) get(row.entry_by).entradas_registradas = row.n;
  }
  return { periodo: r, empleados: [...by.values()].sort((a, b) => b.entradas_registradas - a.entradas_registradas || b.horas - a.horas) };
}

// Las alertas del panel se describen con sus datos, sin el texto (que trae nombres)
function describePanelAlert(a, ctx) {
  const d = a.details ?? {};
  const base = { tipo: a.typeLabel, sede: ctx.sites.find((s) => s.id === a.site.id)?.code, zona: a.zone?.name ?? null, desde: localText(a.createdAt), gravedad: a.severity === 'DANGER' ? 'alta' : 'media' };
  switch (a.type) {
    case 'ZONE_WITHOUT_SHIFT':
      return { ...base, le_corresponde_a: d.userId ? employeeCode(d.userId) : null, horario_desde: d.startTime, minutos_tarde: d.minutesLate };
    case 'OCCUPANCY_HIGH':
      return { ...base, ocupacion_pct: d.occupancy, limite_pct: d.threshold, dentro: d.inside, capacidad: d.capacity };
    case 'CASH_DIFFERENCE':
      return { ...base, diferencia: d.difference, limite: d.threshold };
    case 'SITE_OFFLINE':
      return { ...base, minutos_sin_conexion: d.minutes };
    default:
      return base;
  }
}

async function findAlerts(ctx, { sede }) {
  const sites = pickSites(ctx, sede);
  const filter = scopeFilter(sites, ctx);
  const ids = sites.map((s) => s.id);
  const [panel, ov, open, recent, months] = await Promise.all([
    alerts.listAlerts(ctx.req, filter),
    overview(ctx.req, filter),
    query("SELECT entry_at FROM entries WHERE site_id = ANY($1) AND status = 'OPEN'", [ids]),
    accounting(ctx.req, { from: daysAgo(14), to: todayLocal(), ...filter }),
    // Egresos por mes: los 12 meses anteriores completos y el actual (cabe en el máximo de 400 días)
    accounting(ctx.req, { from: monthsAgoStart(12), to: todayLocal(), ...filter }),
  ]);
  const byDay = Object.fromEntries(recent.consolidated.cashFlow.map((d) => [d.date, d.income]));
  const byMonth = {};
  for (const d of months.consolidated.cashFlow) byMonth[d.date.slice(0, 7)] = (byMonth[d.date.slice(0, 7)] ?? 0) + d.expenses;
  let expiring = 0;
  for (const s of sites) expiring += (await monthly.alerts(s.id)).filter((m) => m.daysToEnd >= 0 && m.daysToEnd <= alertRules.UMBRALES.mensualidadDiasAviso).length;
  const rules = alertRules.calcular({
    ahora: new Date(),
    abiertos: open.rows.map((r) => ({ entrada: r.entry_at })),
    ingresosPorDia: byDay,
    egresosPorMes: byMonth,
    mensualidadesPorVencer: expiring,
    pendientes: ov.consolidated.pending,
  });
  return {
    alertas_del_panel: panel.filter((a) => ids.includes(a.site.id)).map((a) => describePanelAlert(a, ctx)),
    alertas_de_reglas: rules,
  };
}

// ---------------------------------------------------------------------------
// Acciones: solo propuestas (se guardan; el frontend ejecuta el endpoint al confirmar)
// ---------------------------------------------------------------------------

async function propose(ctx, { kind, site, title, risk, details, request, extra = {}, forAi }) {
  const { rows } = await query(
    `INSERT INTO ai_proposals (user_id, site_id, kind, title, request, details, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, now() + make_interval(mins => $7)) RETURNING id`,
    [ctx.user.id, site?.id ?? null, kind, title, request, JSON.stringify(details), aiConfig.proposalMinutes],
  );
  const proposal = { id: rows[0].id, kind, title, risk, details, request, site: site ? { id: site.id, code: site.code, name: site.name } : null, ...extra };
  ctx.proposals.push(proposal);
  return { estado: 'lista para confirmar (no se ha ejecutado)', accion: title, ...forAi };
}

const cop = (n) => `$ ${Math.round(n).toLocaleString('es-CO').replace(/,/g, '.')}`;

async function proposeEntry(ctx, { placa, sede }) {
  const plate = normalizePlate(placa);
  const err = plateError(plate);
  if (err) throw new ToolError(`Placa inválida: ${err}`);
  const site = pickOneSite(ctx, sede);
  const look = await entries.lookupPlate(ctx.req, site.id, plate);
  if (look.openEntry) throw new ToolError(`La placa ${plate} ya está dentro; no se puede registrar otra entrada.`);
  if (look.monthly?.blocksEntry) throw new ToolError(`La placa ${plate} tiene mensualidad vigente: no se registra como entrada normal.`);
  return propose(ctx, {
    kind: 'ENTRY',
    site,
    title: `Registrar entrada de ${plate}`,
    risk: 'bajo',
    details: [`Placa: ${plate} (${VEHICLE_LABELS[look.vehicleType] ?? ''})`, `Sede: ${site.name}`],
    request: { method: 'POST', path: '/entries', body: { siteId: site.id, plate } },
    forAi: { placa: plate, sede: site.code },
  });
}

async function proposeMovement(ctx, { tipo, valor, concepto, categoria, sede }) {
  if (!['ingreso', 'egreso'].includes(tipo)) throw new ToolError('El tipo debe ser ingreso o egreso.');
  if (!Number.isInteger(valor) || valor <= 0 || valor > MAX_MONEY) throw new ToolError('El valor debe ser un entero mayor que cero.');
  const concept = String(concepto ?? '').trim().slice(0, 200);
  if (!concept) throw new ToolError('Falta el concepto.');
  if (categoria && !EXPENSE_CATEGORIES[categoria]) throw new ToolError('Categoría inválida.');
  const site = pickOneSite(ctx, sede);
  // Caja: el turno abierto de la persona en la sede, o el primero abierto de la sede
  const { rows } = await query(
    `SELECT sh.id, sh.user_id, z.name AS zone, u.full_name FROM shifts sh JOIN zones z ON z.id = sh.zone_id JOIN users u ON u.id = sh.user_id
      WHERE sh.site_id = $1 AND sh.closed_at IS NULL ORDER BY (sh.user_id = $2) DESC, sh.opened_at LIMIT 1`,
    [site.id, ctx.user.id],
  );
  if (!rows[0]) throw new ToolError(`No hay un turno abierto en ${site.code}: el movimiento necesita una caja abierta.`);
  const type = tipo === 'ingreso' ? 'INCOME' : 'EXPENSE';
  const body = { siteId: site.id, shiftId: rows[0].id, type, amount: valor, concept };
  if (type === 'EXPENSE') body.category = categoria || 'OTHER';
  return propose(ctx, {
    kind: 'MOVEMENT',
    site,
    title: `Registrar ${tipo} de ${cop(valor)}`,
    risk: 'medio',
    details: [
      `Tipo: ${tipo === 'ingreso' ? 'Ingreso' : 'Egreso'}`,
      `Valor: ${cop(valor)}`,
      `Concepto: ${concept}`,
      ...(type === 'EXPENSE' ? [`Categoría: ${EXPENSE_CATEGORIES[body.category]}`] : []),
      `Caja: ${site.name} · ${rows[0].zone} · ${rows[0].full_name}`,
    ],
    request: { method: 'POST', path: '/cash-movements', body },
    forAi: { tipo, valor, concepto: concept, sede: site.code },
  });
}

async function proposeReport(ctx, { desde, hasta, formato, sede }) {
  const r = range(desde, hasta);
  const site = pickOneSite(ctx, sede);
  const format = formato === 'excel' ? 'xlsx' : 'pdf';
  return propose(ctx, {
    kind: 'REPORT',
    site,
    title: `Descargar informe ${format === 'pdf' ? 'PDF' : 'Excel'}`,
    risk: 'bajo',
    details: [`Sede: ${site.name}`, `Del ${r.from.split('-').reverse().join('/')} al ${r.to.split('-').reverse().join('/')}`],
    request: { method: 'GET', path: `/reports/export?siteId=${site.id}&from=${r.from}&to=${r.to}&format=${format}`, download: `reporte_${site.code}_${r.from}_${r.to}.${format}` },
    forAi: { sede: site.code, ...r, formato: format },
  });
}

const RATE_FIELDS = { hora: 'hourAmount', fraccion: 'fractionAmount', tope_12_horas: 'full12hAmount', mensualidad: 'monthlyAmount' };
const RATE_LABELS = { hora: 'Hora', fraccion: 'Fracción', tope_12_horas: 'Tope de 12 h', mensualidad: 'Mensualidad' };
async function proposeRate(ctx, { servicio, campo, valor, sede }) {
  const type = vehicleOf(servicio);
  if (!type) throw new ToolError('Servicio inválido: usa Carro, Moto o Cicla.');
  if (!RATE_FIELDS[campo]) throw new ToolError('Campo inválido.');
  if (!Number.isInteger(valor) || valor < 0 || valor > MAX_MONEY) throw new ToolError('El valor debe ser un entero de $ 0 en adelante.');
  const site = pickOneSite(ctx, sede);
  const current = (await config.listRates(ctx.req, site.id)).current.find((x) => x.vehicleType === type);
  if (!current) throw new ToolError(`La sede ${site.code} no tiene tarifa vigente para ${VEHICLE_LABELS[type]}.`);
  const body = {
    vehicleType: type,
    fractionAmount: current.fractionAmount,
    hourAmount: current.hourAmount,
    full12hAmount: current.full12hAmount,
    monthlyAmount: current.monthlyAmount,
    pricingMode: current.pricingMode,
    [RATE_FIELDS[campo]]: valor,
  };
  return propose(ctx, {
    kind: 'RATE',
    site,
    title: `Cambiar ${RATE_LABELS[campo].toLowerCase()} de ${VEHICLE_LABELS[type].toLowerCase()}`,
    risk: 'alto',
    details: [`Sede: ${site.name}`, `Servicio: ${VEHICLE_LABELS[type]}`],
    request: { method: 'POST', path: `/config/${site.id}/rates`, body },
    // La tarjeta muestra la tarifa actual y la nueva lado a lado, con su vigencia
    extra: {
      comparison: {
        columns: ['Actual', 'Nueva'],
        rows: Object.entries(RATE_FIELDS).map(([k, field]) => ({
          label: RATE_LABELS[k],
          current: current[field],
          next: body[field],
          changed: current[field] !== body[field],
        })),
        validity: {
          current: `Vigente desde ${localText(current.validFrom)}`,
          next: 'Rige desde el momento en que confirme (la actual queda en el historial)',
        },
      },
    },
    forAi: { sede: site.code, servicio: VEHICLE_LABELS[type], campo, antes: current[RATE_FIELDS[campo]], despues: valor },
  });
}

async function proposeMonthlyRenewal(ctx, { placa, medio_pago: method, sede }) {
  const plate = normalizePlate(placa);
  if (plateError(plate)) throw new ToolError('Placa inválida.');
  if (!['efectivo', 'electronico'].includes(method)) throw new ToolError('Indica el medio de pago: efectivo o electrónico.');
  const sites = pickSites(ctx, sede);
  const { rows } = await query(
    `SELECT id, site_id, client_name, end_date::text, amount, data_consent FROM monthly_plans
      WHERE plate = $1 AND site_id = ANY($2) AND deleted_at IS NULL AND is_active
      ORDER BY end_date DESC LIMIT 1`,
    [plate, sites.map((s) => s.id)],
  );
  const p = rows[0];
  if (!p) throw new ToolError(`La placa ${plate} no tiene una mensualidad activa en tus sedes.`);
  const site = ctx.sites.find((s) => s.id === p.site_id);
  return propose(ctx, {
    kind: 'MONTHLY_RENEWAL',
    site,
    title: `Renovar mensualidad de ${plate}`,
    risk: 'medio',
    details: [`Titular: ${p.client_name}`, `Vence: ${p.end_date.split('-').reverse().join('/')}`, `Valor: ${cop(p.amount)}`, `Pago: ${method === 'efectivo' ? 'Efectivo' : 'Electrónico'}`],
    request: { method: 'POST', path: `/monthly/${p.id}/pay`, body: { paymentMethod: method === 'efectivo' ? 'CASH' : 'ELECTRONIC' } },
    // Sin autorización de datos (mensualidad importada) la tarjeta la pide antes de confirmar
    extra: { needsConsent: !p.data_consent },
    forAi: { placa: plate, vence: p.end_date, valor: p.amount, sede: site.code },
  });
}

// ---------------------------------------------------------------------------

const EXECUTORS = {
  vehiculos_activos: openVehicles,
  consultar_placa: plateInfo,
  calcular_cobro: quote,
  consultar_tarifas: rates,
  proponer_entrada: proposeEntry,
  resumen_periodo: (ctx, a) => periodSummary(ctx, a.desde, a.hasta, a.sede),
  comparar_periodos: comparePeriods,
  ocupacion_por_franja: occupancyByHour,
  actividad_por_empleado: employeeActivity,
  buscar_alertas: findAlerts,
  proponer_movimiento: proposeMovement,
  proponer_informe: proposeReport,
  proponer_ajuste_tarifa: proposeRate,
  proponer_renovar_mensualidad: proposeMonthlyRenewal,
};

/**
 * Ejecuta una herramienta YA autorizada para el rol (agent.js lo verifica antes).
 * Los errores esperables vuelven como { error } para que la IA los explique.
 */
async function execute(ctx, name, args) {
  try {
    return await EXECUTORS[name](ctx, args ?? {});
  } catch (err) {
    if (err instanceof ToolError) return { error: err.message };
    if (err instanceof HttpError) return { error: err.status === 403 ? 'No tienes permiso para esos datos.' : err.message };
    throw err;
  }
}

module.exports = { declarationsFor, namesFor, execute, COMMON, ADMIN_ONLY, DECLARATIONS };
