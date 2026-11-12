/* Reglas de alertas del administrador. Se calculan con codigo (sin IA, sin internet).
 * Funciona en el navegador (window.NexoAlertas) y en Node (require). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.NexoAlertas = factory();
})(this, function () {
  var UMBRALES = {
    permanenciaHoras: 24,      // vehiculo dentro por mas de N horas
    caidaIngresosPct: 15,      // caida de ingresos vs periodo anterior (7 dias vs 7 dias previos)
    mensualidadDiasAviso: 3,   // mensualidades que vencen en los proximos N dias
    egresoMultiplo: 2          // egresos del mes > N veces el promedio mensual (hasta 12 meses)
  };
  function p2(n) { return n < 10 ? '0' + n : '' + n; }
  function dk(d) { return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()); }
  function mk(d) { return d.getFullYear() + '-' + p2(d.getMonth() + 1); }
  function cop(n) { return '$' + Math.round(n).toLocaleString('es-CO'); }
  function addDays(d, n) { var x = new Date(d.getTime()); x.setDate(x.getDate() + n); return x; }

  /* d = {
   *   ahora: Date,
   *   abiertos: [{entrada: Date}],                         vehiculos sin salida
   *   salidasAyer: [{total: number, cobrado: number}],     salidas del dia anterior
   *   ingresosPorDia: {'YYYY-MM-DD': number},
   *   egresosPorMes: {'YYYY-MM': number},
   *   mensualidades: [{fin: Date, activa: boolean}]
   * } -> [{tipo, texto}] */
  function calcular(d) {
    var out = [], now = d.ahora || new Date(), U = UMBRALES;

    var largos = (d.abiertos || []).map(function (a) { return (now - a.entrada) / 3600000; })
      .filter(function (h) { return h > U.permanenciaHoras; });
    if (largos.length) out.push({ tipo: 'permanencia', texto: largos.length + ' vehiculo(s) llevan mas de ' + U.permanenciaHoras + ' h dentro (el mayor, ' + Math.round(Math.max.apply(null, largos)) + ' h).' });

    function suma(desde, hasta) { var s = 0; for (var i = desde; i <= hasta; i++) s += (d.ingresosPorDia || {})[dk(addDays(now, -i))] || 0; return s; }
    var ult = suma(1, 7), prev = suma(8, 14);
    if (prev > 0) {
      var caida = (prev - ult) / prev * 100;
      if (caida > U.caidaIngresosPct) out.push({ tipo: 'caida', texto: 'Los ingresos de los ultimos 7 dias (' + cop(ult) + ') bajaron ' + Math.round(caida) + ' % frente a los 7 dias previos (' + cop(prev) + ').' });
    }

    var sal = d.salidasAyer || [];
    var sinPago = sal.filter(function (s) { return s.total > 0 && !(s.cobrado > 0); });
    if (sinPago.length) out.push({ tipo: 'sin_pago', texto: sinPago.length + ' salida(s) de ayer tienen valor a cobrar pero no registran pago (' + cop(sinPago.reduce(function (a, s) { return a + s.total; }, 0)) + ').' });

    var conPago = sal.filter(function (s) { return s.cobrado > 0; });
    var diff = conPago.reduce(function (a, s) { return a + (s.total - s.cobrado); }, 0);
    if (Math.abs(diff) >= 1) out.push({ tipo: 'descuadre', texto: 'Ayer el total de ventas no coincide con la suma de cobros: diferencia de ' + cop(Math.abs(diff)) + (diff > 0 ? ' (se cobro menos de lo vendido).' : ' (se cobro mas de lo vendido).') });

    var porVencer = (d.mensualidades || []).filter(function (m) {
      if (!m.activa || !m.fin) return false;
      var hoy = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      var dias = Math.round((new Date(m.fin.getFullYear(), m.fin.getMonth(), m.fin.getDate()) - hoy) / 86400000);
      return dias >= 0 && dias <= U.mensualidadDiasAviso;
    });
    if (porVencer.length) out.push({ tipo: 'mensualidades', texto: porVencer.length + ' mensualidad(es) vencen en los proximos ' + U.mensualidadDiasAviso + ' dias.' });

    var eg = d.egresosPorMes || {}, actual = eg[mk(now)] || 0, previos = [];
    for (var i = 1; i <= 12; i++) { var k = mk(new Date(now.getFullYear(), now.getMonth() - i, 1)); if (eg[k] != null) previos.push(eg[k]); }
    if (previos.length) {
      var prom = previos.reduce(function (a, b) { return a + b; }, 0) / previos.length;
      if (prom > 0 && actual > prom * U.egresoMultiplo) out.push({ tipo: 'egresos', texto: 'Los egresos de este mes (' + cop(actual) + ') superan ' + U.egresoMultiplo + ' veces el promedio mensual (' + cop(prom) + ').' });
    }
    return out;
  }
  return { UMBRALES: UMBRALES, calcular: calcular };
});
