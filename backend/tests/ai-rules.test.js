// NexoIA sin base de datos: reglas de alertas de la v1.0 (portadas), códigos de empleados y
// herramientas por rol.
const { calcular, UMBRALES } = require('../src/ai/alertRules');
const { resolveEmployeeCodes } = require('../src/ai/privacy');
const tools = require('../src/ai/tools');
const { roleOf } = require('../src/ai/prompts');

const NOW = new Date('2026-11-12T17:00:00Z'); // 12:00 m. en Colombia
const day = (n) => new Date(NOW.getTime() - 5 * 3600000 - n * 86400000).toISOString().slice(0, 10);

describe('reglas de alertas (v1.0 agente/alertas/reglas.js)', () => {
  test('umbrales de la v1.0', () => {
    expect(UMBRALES).toEqual({ permanenciaHoras: 24, caidaIngresosPct: 15, mensualidadDiasAviso: 3, egresoMultiplo: 2 });
  });

  test('permanencia, caída de ingresos, pendientes, mensualidades y egresos inusuales', () => {
    const ingresos = {};
    for (let i = 1; i <= 7; i += 1) ingresos[day(i)] = 80000;
    for (let i = 8; i <= 14; i += 1) ingresos[day(i)] = 100000;
    const out = calcular({
      ahora: NOW,
      abiertos: [{ entrada: new Date(NOW - 30 * 3600000) }, { entrada: new Date(NOW - 2 * 3600000) }],
      ingresosPorDia: ingresos,
      egresosPorMes: { '2026-11': 900000, '2026-10': 300000, '2026-09': 300000 },
      mensualidadesPorVencer: 2,
      pendientes: { count: 1, total: 4000 },
    });
    expect(out.map((a) => a.tipo)).toEqual(['permanencia', 'caida', 'pendientes', 'mensualidades', 'egresos']);
    expect(out[0].texto).toContain('1 vehículo(s) llevan más de 24 h');
    expect(out[1].texto).toContain('bajaron 20 %');
    expect(out[4].texto).toContain('$900.000');
  });

  test('sin novedades no hay alertas', () => {
    expect(calcular({ ahora: NOW, abiertos: [], ingresosPorDia: {}, egresosPorMes: {}, mensualidadesPorVencer: 0, pendientes: { count: 0 } })).toEqual([]);
  });
});

describe('herramientas por rol', () => {
  test('rol desde la sesión: AG/AS administrador, OP (o desconocido) empleado', () => {
    expect(roleOf({ role: 'AG' })).toBe('administrador');
    expect(roleOf({ role: 'AS' })).toBe('administrador');
    expect(roleOf({ role: 'OP' })).toBe('empleado');
    expect(roleOf({ role: 'Superadmin' })).toBe('empleado');
  });

  test('el empleado solo tiene las de consulta operativa y proponer_entrada', () => {
    expect(tools.namesFor('empleado').sort()).toEqual(['calcular_cobro', 'consultar_placa', 'consultar_tarifas', 'proponer_entrada', 'vehiculos_activos']);
    expect(tools.namesFor('administrador')).toEqual(expect.arrayContaining(['resumen_periodo', 'comparar_periodos', 'ocupacion_por_franja', 'actividad_por_empleado', 'buscar_alertas']));
    // Todas las de lectura del administrador son declaraciones válidas de Gemini
    for (const d of tools.declarationsFor('administrador')) {
      expect(d.name).toMatch(/^[a-z_]+$/);
      expect(typeof d.description).toBe('string');
    }
  });
});

test('códigos de empleado → nombre solo para los conocidos', () => {
  const employees = new Map([[12, 'Pedro Pérez']]);
  expect(resolveEmployeeCodes('E12 registró 30; E99 registró 2. CE12 no.', employees)).toBe('Pedro Pérez registró 30; E99 registró 2. CE12 no.');
});
