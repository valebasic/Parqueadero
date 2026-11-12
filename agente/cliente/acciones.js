/* Acciones del agente con AUTORIZACION.
 * La IA solo puede PROPONER (herramientas proponer_*). Cada propuesta se valida aqui con codigo,
 * se muestra como tarjeta y SOLO se ejecuta cuando la persona pulsa Confirmar (clic real).
 * La ejecucion replica exactamente lo que hace cada pantalla de la app (mismos campos y reglas)
 * y queda en el registro de auditoria (userData/agente-memoria/auditoria.jsonl). */
(function(){
  var H=function(){return window.NexoHerramientas.util};
  var V=function(){return window.FPValidate||{}};
  function get(k,d){try{var v=localStorage.getItem(k);return v?JSON.parse(v):d}catch(e){return d}}
  function set(k,v){localStorage.setItem(k,JSON.stringify(v))}
  function p2(n){return n<10?'0'+n:''+n}
  function money(n){n=Math.round(+n||0);return (n<0?'-$':'$')+Math.abs(n).toLocaleString('es-CO')}
  function usuario(){var u=get('fp_user',{})||{};return {nombre:u.name||u.username||'Usuario',username:u.username||''}}
  function nowString(){var d=new Date();return p2(d.getDate())+'-'+p2(d.getMonth()+1)+'-'+d.getFullYear()+' '+p2(d.getHours())+':'+p2(d.getMinutes())+':'+p2(d.getSeconds())}
  function fmt24(x){var d=x instanceof Date?x:new Date(x);return isNaN(d)?'':p2(d.getDate())+'-'+p2(d.getMonth()+1)+'-'+d.getFullYear()+' '+p2(d.getHours())+':'+p2(d.getMinutes())}
  function fmtDateOnly(d){return d.getFullYear()+'-'+p2(d.getMonth()+1)+'-'+p2(d.getDate())}
  function fmtDateEs(s){var d=new Date(String(s||'')+'T00:00:00');return isNaN(d)?String(s||''):p2(d.getDate())+'-'+p2(d.getMonth()+1)+'-'+d.getFullYear()}
  function addCalendarMonthsDate(s,m){var d=new Date(s+'T00:00:00'),day=d.getDate();d.setDate(1);d.setMonth(d.getMonth()+m);var last=new Date(d.getFullYear(),d.getMonth()+1,0).getDate();d.setDate(Math.min(day,last));return d}
  function dinero(v,label,opts){
    var err=V().moneyError?V().moneyError(String(v==null?'':v),label,opts):(/^\d+$/.test(String(v))?'':label+' debe ser un numero entero.');
    if(err)throw new Error(err);return Number(v);
  }
  function texto(v,label,min,max){var s=String(v==null?'':v).replace(/\s+/g,' ').trim();if(s.length<min)throw new Error(label+' es obligatorio.');if(s.length>max)throw new Error(label+' es muy largo (maximo '+max+' caracteres).');return s}

  /* ---------- Caja (igual que initCash en mvc/app-controller.js) ---------- */
  function cajaAbierta(){return get('fp_cash_register',null)}
  function calcularCierre(reg){
    var F=window.FPModel;
    var ps=F.entries().filter(function(e){return e.salidaFecha&&!e.pendingMonthlyConfirmation&&(!reg||!reg.id||e.registerId===reg.id)});
    var mine=function(x){return x&&(!reg||!reg.id||x.registerId===reg.id)};
    var ex=get('fp_expenses',[]).filter(mine),inc=get('fp_incomes',[]).filter(mine),bInL=get('fp_base_in',[]).filter(mine),bOutL=get('fp_base_out',[]).filter(mine);
    var sum=function(a,f){return a.reduce(function(s,x){return s+(+x[f]||0)},0)};
    var salesCash=ps.reduce(function(a,x){return a+F.cashPart(x)},0),totalPark=sum(ps,'total'),eg=sum(ex,'amount'),ig=sum(inc,'amount'),bIn=sum(bInL,'amount'),bOut=sum(bOutL,'amount');
    var nums=ps.map(function(x){return parseInt(x.reciboNumero||x.receiptNumber,10)}).filter(function(n){return isFinite(n)}).sort(function(a,b){return a-b});
    return {ps:ps,totalPark:totalPark,totalSales:totalPark,salesElectronic:totalPark-salesCash,eg:eg,ig:ig,expected:salesCash+ig-eg,bIn:bIn,bOut:bOut,baseFinal:(+reg.initialCash||0)+bIn-bOut,
      receiptStart:nums.length?nums[0]:null,receiptEnd:nums.length?nums[nums.length-1]:null,receiptCount:nums.length};
  }

  /* ---------- Mensualidades (igual que payMonthly / fpProcessMonthlyPayment) ---------- */
  function monthlyRenewalDates(m){
    var today=new Date();today.setHours(0,0,0,0);
    var end=new Date((m.end||'')+'T00:00:00');if(isNaN(end))return null;end.setHours(0,0,0,0);
    var before=new Date(end);before.setDate(before.getDate()-1);
    if(today<before)return {allowed:false,reason:'La renovacion se puede hacer desde un dia antes del vencimiento ('+fmtDateEs(m.end)+').'};
    return {allowed:true,start:fmtDateOnly(end),end:fmtDateOnly(addCalendarMonthsDate(fmtDateOnly(end),1))};
  }
  function nextMonthlyReceipt(){
    var key='facaparking_offline_receipt_monthly_v1',cfg=get('fp_config',{})||{},max=0;
    get('fp_monthly_payments',[]).forEach(function(x){var n=parseInt(x&&x.receiptNumber,10);if(isFinite(n)&&n>max)max=n});
    var stored=parseInt(localStorage.getItem(key)||'0',10);if(isFinite(stored)&&stored>max)max=stored;
    var conf=parseInt(cfg.nextReceiptNumberMonthly,10)-1;if(isFinite(conf)&&conf>max)max=conf;
    var n=max+1;localStorage.setItem(key,String(n));cfg.nextReceiptNumberMonthly=n+1;cfg.receiptPrefixMonthly=cfg.receiptPrefixMonthly||'FM';set('fp_config',cfg);
    return {prefix:cfg.receiptPrefixMonthly,number:n};
  }
  function buscarMensualidad(a){
    var data=get('fp_monthly',[]),U=H(),k=U.plateKey(a.placa),toks=U.norm(a.cliente).split(/[^a-z0-9]+/).filter(Boolean);
    var idx=[];
    data.forEach(function(m,i){
      if(!m||m.pendingConfirmation)return;
      if(k&&U.plateKey(m.plate)===k)idx.push(i);
      else if(!k&&toks.length&&m.name&&toks.every(function(t){return U.norm(m.name).indexOf(t)>=0}))idx.push(i);
    });
    if(!k&&!toks.length)throw new Error('Indica el nombre del cliente o la placa.');
    if(!idx.length)throw new Error('No encontre una mensualidad con '+(k?'la placa '+k:'ese nombre')+'.');
    if(idx.length>1)throw new Error('Hay varias mensualidades que coinciden ('+idx.map(function(i){return (data[i].name||'?')+' '+String(data[i].plate||'').toUpperCase()}).join(', ')+'). Indica la placa.');
    return {data:data,i:idx[0],m:data[idx[0]]};
  }
  function validarRenovacion(m){
    if(m.nextPeriod)throw new Error('Esta mensualidad ya tiene pagado por adelantado el siguiente periodo.');
    if(m.installment||m.biweekly)throw new Error('Es una mensualidad quincenal o con abono pendiente: registrala desde la pantalla Mensualidades.');
    if(String(m.paymentStatus||'').toLowerCase()==='pending')throw new Error('La mensualidad tiene un pago pendiente: registralo desde la pantalla Mensualidades.');
    var v=+m.value||0;if(v<=0)throw new Error('La mensualidad no tiene un valor configurado.');
    var d=monthlyRenewalDates(m);if(!d)throw new Error('La mensualidad no tiene una fecha de fin valida.');
    if(!d.allowed)throw new Error(d.reason);
    return d;
  }

  /* ---------- Entradas (igual que window.registrar en ParkApp.html) ---------- */
  function nextReceipt(){
    var COUNTER='facaparking_offline_receipt_v4',max=0;
    get('fp_entries',[]).forEach(function(x){var n=parseInt(x&&(x.reciboNumero!=null?x.reciboNumero:x.receiptNumber),10);if(isFinite(n)&&n>max)max=n});
    var stored=parseInt(localStorage.getItem(COUNTER)||'0',10);if(isFinite(stored)&&stored>max)max=stored;
    var cfg=get('fp_config',{})||{},conf=parseInt(cfg.nextReceiptNumber,10)-1;if(isFinite(conf)&&conf>max)max=conf;
    var next=max+1;localStorage.setItem(COUNTER,String(next));cfg.nextReceiptNumber=next+1;cfg.receiptPrefix=cfg.receiptPrefix||'FA';set('fp_config',cfg);
    return next;
  }
  function validarEntrada(placaRaw){
    var Vv=V(),placa=Vv.normalizePlate?Vv.normalizePlate(placaRaw):String(placaRaw||'').toUpperCase().replace(/[\s-]/g,'');
    var err=Vv.plateError?Vv.plateError(placa):'';if(err)throw new Error(err);
    var sid=Vv.plateServiceId?Vv.plateServiceId(placa):'';
    var serv=H().services().find(function(s){return String(s.id)===String(sid)});
    if(!sid||!serv)throw new Error('No se reconocio el servicio para la placa '+placa+'. Registrala desde Entradas.');
    if(serv.active===false)throw new Error('El servicio '+serv.name+' esta inactivo.');
    var k=H().plateKey(placa);
    if(get('fp_entries',[]).some(function(e){return e&&!e.salidaFecha&&H().plateKey(e.placa||e.plate)===k}))throw new Error('La placa '+placa+' ya tiene una entrada abierta.');
    var mn=H().mensualidadDe(k);
    if(mn&&mn.active)throw new Error('La placa '+placa+' tiene una mensualidad activa (tiene reglas de horario): registrala desde Entradas.');
    return {placa:placa,idTarifa:String(sid),servicio:serv.name};
  }

  /* ---------- Tarifas ---------- */
  var CAMPOS={hora:{f:'hour',l:'valor por hora'},fraccion:{f:'fraction',l:'valor de la fraccion'},tope_12_horas:{f:'full12h',l:'tope de 12 horas'},mensualidad:{f:'monthly',l:'valor de la mensualidad'}};
  function buscarServicio(nombre){
    var U=H(),n=U.norm(nombre).trim(),s=get('fp_services',[]);
    if(!n)throw new Error('Indica el servicio (por ejemplo Carro o Moto).');
    var i=s.findIndex(function(x){return x&&U.norm(x.name)===n});
    if(i<0){var c=s.map(function(x,j){return x&&U.norm(x.name).indexOf(n)>=0?j:-1}).filter(function(j){return j>=0});if(c.length===1)i=c[0]}
    if(i<0)throw new Error('No encontre el servicio "'+nombre+'".');
    return {s:s,i:i};
  }

  /* ---------- Informe ---------- */
  function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})}
  function htmlInforme(d,desde,hasta){
    var r=d.resumen,cfg=get('fp_config',{})||{};
    function fila(a){return '<tr>'+a.map(function(x){return '<td>'+esc(x)+'</td>'}).join('')+'</tr>'}
    var kpi=[['Vehiculos',r.vehiculos],['Ventas parqueadero',money(r.ventas_parqueadero)],['Ingresos manuales',money(r.ingresos_manuales)],['Ingresos total',money(r.ingresos_total)],['Egresos',money(r.egresos)],['Ganancia neta',money(r.ganancia_neta)],['Ticket promedio',money(r.ticket_promedio)],['Pagos de mensualidades',money(r.pagos_mensualidades)+' ('+r.cantidad_pagos_mensualidades+')']];
    return '<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Informe</title><style>body{font-family:Arial,sans-serif;padding:28px;color:#222}h1{font-size:20px;margin:0}h2{font-size:15px;margin:22px 0 8px;border-bottom:1px solid #ccc;padding-bottom:4px}.sub{color:#666;font-size:12px;margin:4px 0 16px}.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}.box{border:1px solid #ddd;border-radius:6px;padding:8px;font-size:11px}.box b{display:block;font-size:14px;margin-top:3px}table{width:100%;border-collapse:collapse;font-size:11px}td,th{border:1px solid #ddd;padding:5px;text-align:left}th{background:#f3f3f3}</style></head><body>'+
      '<h1>Informe '+esc(cfg.parkingName||'Nexo.app')+'</h1><div class="sub">Periodo: '+esc(fmtDateEs(desde))+' a '+esc(fmtDateEs(hasta))+' · Generado: '+esc(fmt24(new Date()))+' por '+esc(usuario().nombre)+' · Dias con actividad: '+r.dias_con_actividad+'</div>'+
      '<div class="grid">'+kpi.map(function(k){return '<div class="box">'+esc(k[0])+'<b>'+esc(k[1])+'</b></div>'}).join('')+'</div>'+
      '<h2>Detalle por dia</h2><table><thead><tr><th>Fecha</th><th>Vehiculos</th><th>Ingresos</th><th>Egresos</th></tr></thead><tbody>'+(r.por_dia||[]).map(function(x){return fila([fmtDateEs(x.fecha),x.vehiculos,money(x.ingresos_total),money(x.egresos)])}).join('')+'</tbody></table>'+
      '<h2>Egresos</h2><table><thead><tr><th>Fecha</th><th>Concepto</th><th>Valor</th><th>Usuario</th></tr></thead><tbody>'+(d.egresos.map(function(x){return fila([x.fecha,x.concepto,money(x.valor),x.usuario])}).join('')||'<tr><td colspan="4">Sin egresos.</td></tr>')+'</tbody></table>'+
      '<h2>Ingresos manuales</h2><table><thead><tr><th>Fecha</th><th>Concepto</th><th>Valor</th><th>Usuario</th></tr></thead><tbody>'+(d.ingresos.map(function(x){return fila([x.fecha,x.concepto,money(x.valor),x.usuario])}).join('')||'<tr><td colspan="4">Sin ingresos manuales.</td></tr>')+'</tbody></table>'+
      '<p class="sub">Ingresos = ventas de parqueadero + ingresos manuales. Los pagos de mensualidades se muestran aparte y no suman en ingresos.</p></body></html>';
  }
  function csvInforme(d,desde,hasta){
    var r=d.resumen,L=[];
    function c(v){var s=String(v==null?'':v);return /[;"\n]/.test(s)?'"'+s.replace(/"/g,'""')+'"':s}
    function row(a){L.push(a.map(c).join(';'))}
    row(['Informe Nexo.app']);row(['Periodo',fmtDateEs(desde)+' a '+fmtDateEs(hasta)]);row(['Generado',fmt24(new Date())]);row([]);
    row(['Indicador','Valor']);
    [['Vehiculos',r.vehiculos],['Ventas parqueadero',r.ventas_parqueadero],['Ingresos manuales',r.ingresos_manuales],['Ingresos total',r.ingresos_total],['Egresos',r.egresos],['Ganancia neta',r.ganancia_neta],['Ticket promedio',r.ticket_promedio],['Pagos de mensualidades',r.pagos_mensualidades],['Cantidad de pagos de mensualidades',r.cantidad_pagos_mensualidades],['Dias con actividad',r.dias_con_actividad]].forEach(row);
    row([]);row(['Fecha','Vehiculos','Ingresos','Egresos']);(r.por_dia||[]).forEach(function(x){row([fmtDateEs(x.fecha),x.vehiculos,x.ingresos_total,x.egresos])});
    row([]);row(['Egresos']);row(['Fecha','Concepto','Valor','Usuario']);d.egresos.forEach(function(x){row([x.fecha,x.concepto,x.valor,x.usuario])});
    row([]);row(['Ingresos manuales']);row(['Fecha','Concepto','Valor','Usuario']);d.ingresos.forEach(function(x){row([x.fecha,x.concepto,x.valor,x.usuario])});
    return L.join('\r\n');
  }

  /* ---------- Definicion de cada accion: preparar (valida y describe) / ejecutar ---------- */
  var ACCIONES={
    proponer_movimiento:{
      preparar:function(a){
        var tipo=String(a.tipo||'').toLowerCase();if(tipo!=='ingreso'&&tipo!=='egreso')throw new Error('El tipo debe ser "ingreso" o "egreso".');
        var valor=dinero(a.valor,'El valor'),concepto=texto(a.concepto,'El concepto',2,120);
        var reg=cajaAbierta();if(!reg)throw new Error('No hay una caja abierta. Abre la caja en la pantalla Caja antes de registrar movimientos.');
        return {titulo:'Registrar '+tipo,riesgo:'bajo',detalle:['Valor: '+money(valor),'Concepto: '+concepto,'Se asocia a la caja abierta desde '+fmt24(reg.openedAt)],datos:{tipo:tipo,valor:valor,concepto:concepto}};
      },
      ejecutar:function(d){
        var reg=cajaAbierta();if(!reg)throw new Error('Ya no hay una caja abierta.');
        var key=d.tipo==='ingreso'?'fp_incomes':'fp_expenses',pref=d.tipo==='ingreso'?'I':'E',a=get(key,[]);
        a.push({id:pref+Date.now(),concept:d.concepto,amount:d.valor,observation:'Registrado con el asistente',dateTime:new Date().toISOString(),user:usuario().nombre,registerId:reg.id});
        set(key,a);
        return {mensaje:(d.tipo==='ingreso'?'Ingreso':'Egreso')+' de '+money(d.valor)+' registrado ("'+d.concepto+'").'};
      }
    },
    proponer_informe:{
      preparar:function(a){
        var formato=String(a.formato||'pdf').toLowerCase();if(formato!=='pdf'&&formato!=='excel')throw new Error('El formato debe ser "pdf" o "excel".');
        var d=window.NexoHerramientas.datosInforme(a.desde,a.hasta),r=d.resumen;
        return {titulo:'Generar informe '+(formato==='pdf'?'PDF':'Excel'),riesgo:'bajo',
          detalle:['Periodo: '+fmtDateEs(r.desde)+' a '+fmtDateEs(r.hasta),'Vehiculos: '+r.vehiculos+' · Ingresos: '+money(r.ingresos_total)+' · Egresos: '+money(r.egresos),'Se guarda en Documentos\\Nexo informes'],
          datos:{desde:r.desde,hasta:r.hasta,formato:formato}};
      },
      ejecutar:function(d){
        var datos=window.NexoHerramientas.datosInforme(d.desde,d.hasta);
        var nombre='informe_'+d.desde+'_a_'+d.hasta;
        var contenido=d.formato==='pdf'?htmlInforme(datos,d.desde,d.hasta):csvInforme(datos,d.desde,d.hasta);
        return window.nexoAI.guardarInforme({nombre:nombre,formato:d.formato,contenido:contenido}).then(function(r){
          if(!r||!r.ok)throw new Error((r&&r.error)||'No se pudo guardar el informe.');
          return {mensaje:'Informe guardado: '+r.archivo,archivo:r.archivo};
        });
      }
    },
    proponer_cierre_caja:{
      preparar:function(a){
        var reg=cajaAbierta();if(!reg)throw new Error('No hay una caja abierta para cerrar.');
        if(a.efectivo_fisico==null||a.efectivo_fisico==='')throw new Error('Falta el efectivo contado en caja (efectivo_fisico). Preguntaselo a la persona.');
        var fis=dinero(a.efectivo_fisico,'El efectivo contado',{allowZero:true}),obs=String(a.observacion||'').trim().slice(0,200),c=calcularCierre(reg),diff=fis-c.expected;
        return {titulo:'Cerrar caja',riesgo:'medio',detalle:['Caja abierta desde '+fmt24(reg.openedAt)+' por '+(reg.openedBy||''),'Ventas: '+money(c.totalSales)+' ('+c.ps.length+') · Electronico: '+money(c.salesElectronic),'Ingresos manuales: '+money(c.ig)+' · Egresos: '+money(c.eg),'Efectivo esperado: '+money(c.expected)+' · Contado: '+money(fis),'Diferencia: '+money(diff)+' ('+(diff===0?'cuadrada':diff>0?'sobrante':'faltante')+')'].concat(obs?['Observacion: '+obs]:[]),
          datos:{regId:reg.id,fisico:fis,obs:obs}};
      },
      ejecutar:function(d){
        var reg=cajaAbierta();if(!reg||reg.id!==d.regId)throw new Error('La caja cambio desde la propuesta. Pide de nuevo el cierre.');
        var c=calcularCierre(reg),diff=d.fisico-c.expected,cfg=get('fp_config',{})||{},u=usuario(),cs=get('fp_cash_closings',[]);
        var st=diff===0?'balanced':diff>0?'surplus':'deficit';
        cs.push({id:'C'+Date.now(),registerId:reg.id,openedAt:reg.openedAt,closedAt:new Date().toISOString(),openedBy:reg.openedBy,closedBy:u.nombre,initialCash:+reg.initialCash||0,baseAdded:c.bIn,baseRemoved:c.bOut,baseFinal:c.baseFinal,totalSales:c.totalSales,totalPark:c.totalPark,totalElectronic:c.salesElectronic,totalEgresos:c.eg,totalIngresosManuales:c.ig,expectedCash:c.expected,physicalCash:d.fisico,difference:diff,status:st,receiptStart:c.receiptStart,receiptEnd:c.receiptEnd,receiptCount:c.receiptCount,observation:d.obs||'Cierre con el asistente'});
        set('fp_cash_closings',cs);localStorage.removeItem('fp_cash_register');
        void cfg;
        return {mensaje:'Caja cerrada. Esperado '+money(c.expected)+', contado '+money(d.fisico)+', diferencia '+money(diff)+'.'};
      }
    },
    proponer_renovar_mensualidad:{
      preparar:function(a){
        var mp=String(a.medio_pago||'').toLowerCase();if(mp!=='efectivo'&&mp!=='nequi')throw new Error('Falta el medio de pago ("efectivo" o "nequi"). Preguntaselo a la persona.');
        var b=buscarMensualidad(a),m=b.m,d=validarRenovacion(m);
        return {titulo:'Renovar mensualidad',riesgo:'medio',detalle:['Cliente: '+(m.name||'')+' · Placa: '+String(m.plate||'').toUpperCase(),'Nuevo periodo: '+fmtDateEs(d.start)+' a '+fmtDateEs(d.end),'Valor: '+money(m.value)+' en '+(mp==='efectivo'?'efectivo':'Nequi'),'Se genera el recibo pero no se imprime desde el asistente.'],
          datos:{id:m.id!=null?String(m.id):null,placa:H().plateKey(m.plate),mp:mp}};
      },
      ejecutar:function(dt){
        var data=get('fp_monthly',[]),payments=get('fp_monthly_payments',[]);
        var i=data.findIndex(function(m){return m&&(dt.id?String(m.id)===dt.id:H().plateKey(m.plate)===dt.placa)});
        if(i<0)throw new Error('La mensualidad ya no existe.');
        var m=data[i],d=validarRenovacion(m),full=+m.value||0,receipt=nextMonthlyReceipt(),paidAt=new Date(),pm=dt.mp==='efectivo'?'cash':'nequi';
        payments.push({id:'MP'+Date.now(),monthlyId:m.id||('M'+i),plate:String(m.plate||'').toUpperCase(),client:m.name||'',document:m.document||'',vehicle:m.vehicle||'',value:full,originalValue:full,discountAmount:0,paymentMethod:pm,cashAmount:pm==='cash'?full:0,nequiAmount:pm==='nequi'?full:0,dateTime:paidAt.toISOString(),periodStart:d.start,periodEnd:d.end,receiptPrefix:receipt.prefix,receiptNumber:receipt.number,registerId:null,user:usuario().nombre,isInstallment:false,installmentPaid:full,installmentTotal:full,origen:'asistente'});
        var nm=Object.assign({},m,{start:d.start,end:d.end,active:true,paymentStatus:'paid',updatedAt:paidAt.toISOString(),lastPaymentDate:paidAt.toISOString(),lastReceiptPrefix:receipt.prefix,lastReceiptNumber:receipt.number});
        delete nm.installment;data[i]=nm;
        set('fp_monthly',data);set('fp_monthly_payments',payments);
        return {mensaje:'Mensualidad de '+(m.name||String(m.plate||'').toUpperCase())+' renovada hasta '+fmtDateEs(d.end)+'. Recibo '+receipt.prefix+receipt.number+' (imprimelo desde Mensualidades si lo necesitas).'};
      }
    },
    proponer_ajuste_tarifa:{
      preparar:function(a){
        var C=CAMPOS[String(a.campo||'').toLowerCase()];if(!C)throw new Error('El campo debe ser hora, fraccion, tope_12_horas o mensualidad.');
        var b=buscarServicio(a.servicio),sv=b.s[b.i],nuevo=dinero(a.valor,'El nuevo valor',{allowZero:true}),actual=+sv[C.f]||0;
        if(nuevo===actual)throw new Error(sv.name+' ya tiene '+C.l+' de '+money(actual)+'.');
        var pct=actual?Math.round((nuevo-actual)/actual*1000)/10:null;
        var det=[sv.name+' · '+C.l+': '+money(actual)+' → '+money(nuevo)+(pct!=null?' ('+(pct>0?'+':'')+String(pct).replace('.',',')+' %)':''),'Aplica a todos los cobros que se calculen desde ahora, incluidos los vehiculos que ya estan dentro.'];
        if(pct!=null&&Math.abs(pct)>=50)det.push('Atencion: es un cambio de mas del 50 %.');
        return {titulo:'Ajustar tarifa',riesgo:'alto',detalle:det,datos:{id:String(sv.id),campo:C.f,etiqueta:C.l,nuevo:nuevo,anterior:actual,servicio:sv.name}};
      },
      ejecutar:function(d){
        var s=get('fp_services',[]),i=s.findIndex(function(x){return x&&String(x.id)===d.id});
        if(i<0)throw new Error('El servicio ya no existe.');
        if((+s[i][d.campo]||0)!==d.anterior)throw new Error('La tarifa cambio desde la propuesta. Pide de nuevo el ajuste.');
        s[i]=Object.assign({},s[i]);s[i][d.campo]=d.nuevo;set('fp_services',s);
        return {mensaje:'Tarifa actualizada: '+d.servicio+' · '+d.etiqueta+' '+money(d.anterior)+' → '+money(d.nuevo)+'.'};
      }
    },
    proponer_novedad:{
      preparar:function(a){
        var t=texto(a.texto,'La descripcion de la novedad',3,300),placa=a.placa?H().plateKey(a.placa):'';
        var det=['Novedad: '+t];
        if(placa){var dentro=get('fp_entries',[]).some(function(e){return e&&!e.salidaFecha&&H().plateKey(e.placa||e.plate)===placa});det.push('Placa: '+placa+(dentro?' (esta dentro)':' (no esta dentro ahora)'))}
        return {titulo:'Registrar novedad',riesgo:'bajo',detalle:det,datos:{texto:t,placa:placa||null}};
      },
      ejecutar:function(d){
        var u=usuario(),l=get('fp_novedades',[]);
        l.push({id:'N'+Date.now(),fecha:new Date().toISOString(),texto:d.texto,placa:d.placa,usuario:u.nombre,username:u.username,origen:'asistente'});
        set('fp_novedades',l);
        return {mensaje:'Novedad registrada'+(d.placa?' para '+d.placa:'')+'. El administrador la puede consultar en el asistente.'};
      }
    },
    proponer_entrada:{
      preparar:function(a){
        var v=validarEntrada(a.placa);
        return {titulo:'Registrar entrada',riesgo:'medio',detalle:['Placa: '+v.placa+' · Servicio: '+v.servicio,'Hora de entrada: la del momento de confirmar','El recibo de entrada NO se imprime desde el asistente.'],datos:{placa:v.placa}};
      },
      ejecutar:function(d){
        var v=validarEntrada(d.placa),cfg=get('fp_config',{})||{},recibo=nextReceipt(),db=get('fp_entries',[]);
        var e={id:Date.now(),idParqueadero:'1',idCliente:'2',idTarifa:v.idTarifa,idUsuario:'3',placa:v.placa,descripcion:'NA',nota:'NA',entradaFecha:nowString(),registradoPor:usuario().username,entradaHora:new Date().toTimeString().slice(0,8),reciboPrefijo:cfg.receiptPrefix||'FA',reciboNumero:recibo,salidaFecha:null,salidaHora:null,codigoBarras:'NA',local:true,origen:'asistente'};
        db.push(e);set('fp_entries',db);
        return {mensaje:'Entrada registrada: '+v.placa+' ('+v.servicio+'), recibo '+(cfg.receiptPrefix||'FA')+recibo+'. Recuerda que el recibo no se imprimio.'};
      }
    }
  };
  var POR_ROL={administrador:['proponer_movimiento','proponer_informe','proponer_cierre_caja','proponer_renovar_mensualidad','proponer_ajuste_tarifa'],empleado:['proponer_novedad','proponer_entrada']};
  var PEND={},NUEVAS=[],TTL=10*60*1000,seq=0;
  function auditar(x){try{window.nexoAI.audit&&window.nexoAI.audit(Object.assign({usuario:usuario().username},x))}catch(e){}}

  window.NexoAcciones={
    /* La IA propone: se valida y queda pendiente. Devuelve a la IA solo un resumen. */
    proponer:function(nombre,args,rol){
      var A=ACCIONES[nombre];
      if(!A||(POR_ROL[rol]||[]).indexOf(nombre)<0)return {error:'Tu rol no puede realizar esa accion.'};
      try{var p=A.preparar(args||{})}catch(e){return {error:e.message,ejecutada:false}}
      var id='A'+Date.now()+'_'+(++seq);
      PEND[id]={id:id,nombre:nombre,rol:rol,datos:p.datos,titulo:p.titulo,detalle:p.detalle,riesgo:p.riesgo,creado:Date.now()};
      NUEVAS.push(PEND[id]);
      auditar({evento:'propuesta',accion:nombre,datos:p.datos});
      return {estado:'pendiente_de_confirmacion',ejecutada:false,titulo:p.titulo,detalle:p.detalle,
        nota:'La accion NO se ha ejecutado. Se muestra una tarjeta y la persona debe pulsar Confirmar.'};
    },
    /* Propuestas nuevas para dibujar como tarjetas. */
    tomarNuevas:function(){var n=NUEVAS;NUEVAS=[];return n},
    /* Solo se llama desde el clic de Confirmar. Siempre devuelve una promesa {ok, mensaje}. */
    ejecutar:function(id,rol){
      var p=PEND[id];delete PEND[id];
      if(!p)return Promise.resolve({ok:false,mensaje:'La propuesta ya no esta disponible.'});
      if(p.rol!==rol)return Promise.resolve({ok:false,mensaje:'La sesion cambio; pide la accion de nuevo.'});
      if(Date.now()-p.creado>TTL){auditar({evento:'vencida',accion:p.nombre});return Promise.resolve({ok:false,mensaje:'La propuesta vencio (10 minutos). Pidela de nuevo.'})}
      return Promise.resolve().then(function(){return ACCIONES[p.nombre].ejecutar(p.datos)}).then(function(r){
        auditar({evento:'ejecutada',accion:p.nombre,datos:p.datos,resultado:r.mensaje});
        try{window.dispatchEvent(new Event('storage'))}catch(e){}
        return Object.assign({ok:true},r);
      },function(e){
        auditar({evento:'fallida',accion:p.nombre,datos:p.datos,error:e.message});
        return {ok:false,mensaje:'No se pudo completar: '+e.message};
      });
    },
    cancelar:function(id){var p=PEND[id];delete PEND[id];if(p)auditar({evento:'cancelada',accion:p.nombre,datos:p.datos})}
  };
})();
