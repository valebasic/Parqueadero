// Reglas de alertas del administrador de la v1.0 (agente/alertas/reglas.js), calculadas con código,
// sin IA. En la v2.0 se suman a las alertas del panel (RF32) en la herramienta buscar_alertas.
//   - Permanencia inusual: vehículo con más de 24 h dentro
//   - Caída de ingresos: últimos 7 días más de 15 % por debajo de los 7 anteriores
//   - Mensualidades que vencen en los próximos 3 días
//   - Egreso inusual: egresos del mes > 2 veces el promedio mensual (hasta 12 meses)
//   - Cobros pendientes sin confirmar (en la v1.0: "salidas sin pago")
const UMBRALES = {
  permanenciaHoras: 24,
  caidaIngresosPct: 15,
  mensualidadDiasAviso: 3,
  egresoMultiplo: 2,
};

const cop = (n) => `$${Math.round(n).toLocaleString('es-CO').replace(/,/g, '.')}`;

/**
 * @param {{
 *   ahora: Date,
 *   abiertos: { entrada: Date }[],
 *   ingresosPorDia: Record<string, number>,   'AAAA-MM-DD' (hora de Colombia)
 *   egresosPorMes: Record<string, number>,    'AAAA-MM'
 *   mensualidadesPorVencer: number,           vencen en 0..3 días
 *   pendientes: { count: number, total: number },
 * }} d
 * @returns {{ tipo: string, texto: string }[]}
 */
function calcular(d) {
  const out = [];
  const now = d.ahora ?? new Date();
  const U = UMBRALES;

  const largos = (d.abiertos ?? []).map((a) => (now - new Date(a.entrada)) / 3600000).filter((h) => h > U.permanenciaHoras);
  if (largos.length) {
    out.push({ tipo: 'permanencia', texto: `${largos.length} vehículo(s) llevan más de ${U.permanenciaHoras} h dentro (el mayor, ${Math.round(Math.max(...largos))} h).` });
  }

  const dayKey = (offset) => new Date(now.getTime() - 5 * 3600000 - offset * 86400000).toISOString().slice(0, 10);
  const suma = (desde, hasta) => {
    let s = 0;
    for (let i = desde; i <= hasta; i += 1) s += d.ingresosPorDia?.[dayKey(i)] ?? 0;
    return s;
  };
  const ult = suma(1, 7);
  const prev = suma(8, 14);
  if (prev > 0) {
    const caida = ((prev - ult) / prev) * 100;
    if (caida > U.caidaIngresosPct) {
      out.push({ tipo: 'caida', texto: `Los ingresos de los últimos 7 días (${cop(ult)}) bajaron ${Math.round(caida)} % frente a los 7 días previos (${cop(prev)}).` });
    }
  }

  if (d.pendientes?.count) {
    out.push({ tipo: 'pendientes', texto: `${d.pendientes.count} cobro(s) pendiente(s) sin confirmar por ${cop(d.pendientes.total)}.` });
  }

  if (d.mensualidadesPorVencer) {
    out.push({ tipo: 'mensualidades', texto: `${d.mensualidadesPorVencer} mensualidad(es) vencen en los próximos ${U.mensualidadDiasAviso} días.` });
  }

  const eg = d.egresosPorMes ?? {};
  const local = new Date(now.getTime() - 5 * 3600000);
  const monthKey = (back) => {
    const x = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth() - back, 1));
    return x.toISOString().slice(0, 7);
  };
  const actual = eg[monthKey(0)] ?? 0;
  const previos = [];
  for (let i = 1; i <= 12; i += 1) if (eg[monthKey(i)] != null) previos.push(eg[monthKey(i)]);
  if (previos.length) {
    const prom = previos.reduce((a, b) => a + b, 0) / previos.length;
    if (prom > 0 && actual > prom * U.egresoMultiplo) {
      out.push({ tipo: 'egresos', texto: `Los egresos de este mes (${cop(actual)}) superan ${U.egresoMultiplo} veces el promedio mensual (${cop(prom)}).` });
    }
  }
  return out;
}

module.exports = { UMBRALES, calcular };
