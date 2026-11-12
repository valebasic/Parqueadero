/* Datos de PRUEBA para el agente. Se ejecuta DENTRO de la pagina (lo inyecta arrancar-con-datos.js)
 * y solo en el perfil aislado "nexoapp-pruebas". Una sola vez (bandera fp_seed_agente).
 *
 * Usuarios de prueba (solo en este perfil):
 *   admin    / admin         -> Administrador   (el usuario por defecto del proyecto)
 *   empleado / empleado123   -> Empleado
 *
 * Alertas que se generan a proposito:
 *   - permanencia: 1 vehiculo con 30 h dentro y otro con 26 h
 *   - caida de ingresos: ultimos 7 dias ~25 % por debajo de los 7 previos
 *   - sin pago: 1 salida de ayer con valor y sin pago
 *   - descuadre: 1 salida de ayer cobrada de menos
 *   - mensualidades: 2 vencen en 1 y 2 dias
 *   - egresos: gasto grande este mes (> 2x el promedio mensual)
 */
(function () {
  try {
    if (localStorage.getItem('fp_seed_agente') === '1') return;
    if (!window.FPModel || !window.FPModel.hashPassword) { console.log('[seed] FPModel aun no disponible'); return; }

    var seed = 12345;
    function rnd() { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; }
    function ri(a, b) { return a + Math.floor(rnd() * (b - a + 1)); }
    function p2(n) { return n < 10 ? '0' + n : '' + n; }
    function fmt(d) { return p2(d.getDate()) + '-' + p2(d.getMonth() + 1) + '-' + d.getFullYear() + ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds()); }
    function fmtHora(d) { return p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds()); }
    function addH(d, h) { return new Date(d.getTime() + h * 3600000); }
    function dayAt(daysAgo, h, m) { var d = new Date(); d.setDate(d.getDate() - daysAgo); d.setHours(h, m || 0, 0, 0); return d; }

    // Misma regla de cobro que ParkApp.html (calculateTariff)
    var TARIFAS = { '5': { hour: 3300, fraction: 1800, full12h: 20000 }, '6': { hour: 2200, fraction: 1500, full12h: 14000 } };
    function calcNormal(min, t) { if (min <= 0) return 0; var h = Math.floor(min / 60), r = min % 60; return h * t.hour + (r === 0 ? 0 : (r <= 45 ? t.fraction : t.hour)); }
    function cobro(min, id) { var t = TARIFAS[id], rest = min, tot = 0; while (rest > 0) { var b = Math.min(rest, 720), n = calcNormal(b, t); tot += (t.full12h > 0 && n >= t.full12h) ? t.full12h : n; rest -= b; } return tot; }

    var letras = 'ABCDEFGHJKLMNPRSTUVWXYZ';
    function placa(moto) { var l = ''; for (var i = 0; i < 3; i++) l += letras[ri(0, letras.length - 1)]; return l + p2(ri(10, 99)) + (moto ? letras[ri(0, letras.length - 1)] : String(ri(0, 9))); }

    var entries = [], nextId = 9000000000000, recibo = 1;
    function entry(entrada, salida, id, pago, quien, forcedTotal, placaFija) {
      var e = { id: nextId++, idParqueadero: '1', idCliente: '2', idTarifa: id, idUsuario: '3', placa: placaFija || placa(id === '6'), descripcion: 'NA', nota: 'NA',
        entradaFecha: fmt(entrada), entradaHora: fmtHora(entrada), reciboPrefijo: 'FA', reciboNumero: recibo++,
        salidaFecha: null, salidaHora: null, codigoBarras: 'NA', local: true, registradoPor: quien, seedPrueba: true };
      if (salida) {
        var total = forcedTotal != null ? forcedTotal : cobro(Math.max(1, Math.round((salida - entrada) / 60000)), id);
        e.salidaFecha = fmt(salida); e.salidaHora = fmtHora(salida); e.total = total;
        var cash = 0, nequi = 0;
        if (pago === 'cash') cash = total; else if (pago === 'nequi') nequi = total; else if (pago === 'mixto') { cash = Math.round(total / 2); nequi = total - cash; }
        else if (typeof pago === 'number') cash = pago;
        e.cashAmount = cash; e.nequiAmount = nequi;
        e.paymentMethod = pago === 'nequi' ? 'nequi' : pago === 'mixto' ? 'both' : pago === 'none' ? '' : 'cash';
      }
      entries.push(e);
      return e;
    }

    // 60 dias de historial. Ayer (1) se arma aparte para controlar las alertas de caja.
    for (var d = 60; d >= 2; d--) {
      var dow = dayAt(d, 12).getDay();
      var base = (dow === 0) ? 5 : (dow === 6 ? 8 : 12);
      if (d <= 8) base = Math.round(base * 0.75);               // ultimos 7 dias mas flojos -> alerta de caida
      var n = Math.max(2, base + ri(-2, 2));
      for (var k = 0; k < n; k++) {
        var h = rnd() < 0.55 ? ri(14, 17) : ri(7, 20);          // pico 2 a 5 p. m.
        var ent = dayAt(d, h, ri(0, 59)), dur = rnd() < 0.7 ? ri(1, 5) : ri(5, 11) + rnd();
        var id = rnd() < 0.7 ? '5' : '6', p = rnd() < 0.6 ? 'cash' : (rnd() < 0.7 ? 'nequi' : 'mixto');
        entry(ent, addH(ent, dur), id, p, rnd() < 0.6 ? 'empleado' : 'admin');
      }
    }
    // Ayer: salidas normales + 1 sin pago + 1 descuadre
    for (var a = 0; a < 6; a++) { var ea = dayAt(1, ri(8, 15), ri(0, 59)); entry(ea, addH(ea, ri(1, 4)), '5', 'cash', 'empleado'); }
    var es = dayAt(1, 10, 5); entry(es, addH(es, 3), '5', 'none', 'empleado');          // sin pago registrado
    var ed = dayAt(1, 11, 20); entry(ed, addH(ed, 2), '6', 4500, 'empleado', 5000);     // cobrado 4.500 de 5.000
    // Abiertos: dos con mas de 24 h y tres normales
    entry(addH(new Date(), -30), null, '5', null, 'admin');
    entry(addH(new Date(), -26), null, '6', null, 'empleado');
    entry(addH(new Date(), -2), null, '5', null, 'empleado');
    entry(addH(new Date(), -5), null, '6', null, 'empleado');
    entry(addH(new Date(), -0.5), null, '5', null, 'empleado');
    entry(addH(new Date(), -3.4), null, '5', null, 'empleado', null, 'JJJ999');   // placa de prueba: carro dentro hace ~3 h 24 min
    entry(addH(new Date(), -1.5), null, '5', null, 'admin', null, 'KKK111');      // vehiculo del cliente Carlos Ramirez

    // Egresos e ingresos manuales
    var expenses = [], incomes = [], eid = 9100000000000;
    for (var m = 4; m >= 1; m--) { // meses anteriores: promedio ~ 250 mil
      var dm = new Date(); dm.setMonth(dm.getMonth() - m); dm.setDate(10); dm.setHours(9, 0, 0, 0);
      expenses.push({ id: eid++, dateTime: fmt(dm), amount: ri(200000, 300000), user: 'admin', concept: 'Servicios (prueba)', seedPrueba: true });
    }
    var dn = new Date(); dn.setDate(Math.max(1, dn.getDate() - 1)); dn.setHours(9, 0, 0, 0);
    expenses.push({ id: eid++, dateTime: fmt(dn), amount: 900000, user: 'admin', concept: 'Reparacion barrera (prueba)', seedPrueba: true }); // alerta de egresos
    for (var q = 0; q < 6; q++) incomes.push({ id: eid++, dateTime: fmt(dayAt(ri(2, 40), 12)), amount: ri(20000, 60000), user: 'admin', concept: 'Ingreso manual (prueba)', seedPrueba: true });

    // Mensualidades
    // Las mensualidades guardan inicio/fin como AAAA-MM-DD (igual que la app).
    function fechaMes(dias) { var x = new Date(); x.setDate(x.getDate() + dias); return x.getFullYear() + '-' + p2(x.getMonth() + 1) + '-' + p2(x.getDate()); }
    var monthly = [
      { id: 9200000000001, plate: placa(false), name: 'Cliente Prueba 1', value: 130000, start: fechaMes(-28), end: fechaMes(2), active: true, seedPrueba: true },
      { id: 9200000000002, plate: placa(true), name: 'Cliente Prueba 2', value: 80000, start: fechaMes(-29), end: fechaMes(1), active: true, seedPrueba: true },
      { id: 9200000000003, plate: placa(false), name: 'Cliente Prueba 3', value: 130000, start: fechaMes(-10), end: fechaMes(20), active: true, seedPrueba: true },
      { id: 9200000000005, plate: 'KKK111', name: 'Carlos Ramirez', value: 130000, start: fechaMes(-12), end: fechaMes(18), active: true, seedPrueba: true },
      { id: 9200000000004, plate: placa(false), name: 'Cliente Prueba 4', value: 130000, start: fechaMes(-60), end: fechaMes(-30), active: false, seedPrueba: true }
    ];
    var payments = [];
    for (var pm = 0; pm < 8; pm++) payments.push({ id: 9300000000000 + pm, dateTime: fmt(dayAt(ri(1, 55), 10)), value: rnd() < 0.7 ? 130000 : 80000, seedPrueba: true });

    // Usuarios: se conserva el usuario por defecto del proyecto y se agrega un empleado.
    var M = window.FPModel, users = [
      Object.assign({}, M.defaults.user, { password: M.hashPassword(M.defaults.user.password) }),
      { username: 'admin', name: 'admin', document: '', email: '', phone: '', role: 'Administrador', password: M.hashPassword('admin') },
      { username: 'empleado', name: 'Empleado Prueba', document: '', email: '', phone: '', role: 'Empleado', password: M.hashPassword('empleado123') }
    ];

    // Caja abierta desde ayer: las salidas de ayer y el egreso grande quedan asociados a ella.
    var reg = { id: 'R' + (Date.now() - 86400000), openedAt: dayAt(1, 7, 0).toISOString(), openedBy: 'admin', initialCash: 100000, observation: 'Caja de prueba' };
    var ayerTxt = fmt(dayAt(1, 0)).slice(0, 10);
    entries.forEach(function (e) { if (e.salidaFecha && e.salidaFecha.slice(0, 10) === ayerTxt) e.registerId = reg.id; });
    expenses.forEach(function (x) { if (x.amount === 900000) x.registerId = reg.id; });
    localStorage.setItem('fp_cash_register', JSON.stringify(reg));

    localStorage.setItem('fp_users', JSON.stringify(users));
    localStorage.setItem('fp_entries', JSON.stringify(entries));
    localStorage.setItem('fp_expenses', JSON.stringify(expenses));
    localStorage.setItem('fp_incomes', JSON.stringify(incomes));
    localStorage.setItem('fp_monthly', JSON.stringify(monthly));
    localStorage.setItem('fp_monthly_payments', JSON.stringify(payments));
    localStorage.setItem('fp_seed_agente', '1');
    console.log('[seed] datos de prueba cargados: ' + entries.length + ' entradas');
    location.reload();
  } catch (e) { console.error('[seed] error', e); }
})();
