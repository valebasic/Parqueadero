/* Herramientas del agente (se EJECUTAN aqui, donde estan los datos; solo lectura).
 * La IA las pide por nombre; main.js ya valido que su rol puede pedirlas y aqui se vuelve a validar.
 * Los numeros se calculan con codigo; la IA solo los interpreta. */
(function(){
  function get(k,d){try{var v=localStorage.getItem(k);return v?JSON.parse(v):d}catch(e){return d}}
  function pd(v){
    if(v==null||v==='')return null;
    var s=String(v).trim(),m=s.match(/^(\d{2})-(\d{2})-(\d{4})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/);
    if(m)return new Date(+m[3],+m[2]-1,+m[1],+(m[4]||0),+(m[5]||0),+(m[6]||0));
    // Solo fecha (AAAA-MM-DD, como guardan las mensualidades): hora local, no UTC.
    var q=s.match(/^(\d{4})-(\d{2})-(\d{2})$/);if(q)return new Date(+q[1],+q[2]-1,+q[3]);
    var d=new Date(s);return isNaN(d)?null:d;
  }
  function p2(n){return n<10?'0'+n:''+n}
  function fmtD(d){return d?p2(d.getDate())+'-'+p2(d.getMonth()+1)+'-'+d.getFullYear():null}
  function finDia(d){return d?new Date(d.getFullYear(),d.getMonth(),d.getDate(),23,59,59):null}
  function dk(d){return d.getFullYear()+'-'+p2(d.getMonth()+1)+'-'+p2(d.getDate())}
  function mk(d){return d.getFullYear()+'-'+p2(d.getMonth()+1)}
  function fmtF(d){return d?p2(d.getDate())+'-'+p2(d.getMonth()+1)+'-'+d.getFullYear()+' '+p2(d.getHours())+':'+p2(d.getMinutes()):null}
  function norm(s){return String(s||'').normalize('NFD').replace(/[̀-ͯ]/g,'').toLowerCase()}
  function plateKey(p){return String(p||'').toUpperCase().replace(/[^A-Z0-9]/g,'')}
  function allEntries(){
    var map=new Map();
    get('fp_entries_archive',[]).forEach(function(e){if(e&&e.id!=null)map.set(String(e.id),e)});
    get('fp_entries',[]).forEach(function(e){if(e&&e.id!=null)map.set(String(e.id),e)});
    return Array.from(map.values());
  }

  /* ---------- Tarifa (misma regla que ParkApp.html: calculateTariff) ---------- */
  function services(){return get('fp_services',[])}
  function calcNormal(min,t){
    if(min<=0)return 0;var hour=Number(t.hour||0),fr=Number(t.fraction||0),h=Math.floor(min/60),rem=min%60;
    return h*hour+(rem===0?0:(rem<=45?fr:hour));
  }
  function tarifa(entrada,idTarifa){
    var t=services().find(function(s){return String(s.id)===String(idTarifa)});if(!t||!entrada)return null;
    var min=Math.max(0,Math.floor((new Date()-entrada)/60000)),cap=Number(t.full12h||0),rest=min,total=0;
    while(rest>0){var b=Math.min(rest,720),n=calcNormal(b,t);total+=(cap>0&&n>=cap)?cap:n;rest-=b}
    return total;
  }
  function servicio(idTarifa){var t=services().find(function(s){return String(s.id)===String(idTarifa)});return t?t.name:''}

  /* ---------- Fechas y rangos ---------- */
  function fecha(s){
    var m=String(s||'').match(/^(\d{4})-(\d{2})-(\d{2})$/);if(!m)return null;
    var d=new Date(+m[1],+m[2]-1,+m[3]);return (d.getMonth()===+m[2]-1)?d:null;
  }
  function rango(a,b){
    var d=fecha(a),h=fecha(b);
    if(!d||!h)throw new Error('Las fechas deben tener formato AAAA-MM-DD.');
    if(d>h)throw new Error('La fecha "desde" es posterior a "hasta".');
    if((h-d)/86400000>400)throw new Error('El rango maximo es de 400 dias.');
    return {desde:dk(d),hasta:dk(h),d:d,h:new Date(h.getFullYear(),h.getMonth(),h.getDate(),23,59,59)};
  }
  function bucket(){return {vehiculos:0,ventas:0,manuales:0,egresos:0,pagos:0,cant:0}}

  /* ---------- Agregados por dia / mes ---------- */
  function agregados(){
    var daily={},monthly={};
    function add(d,f,v){if(!d)return;var a=daily[dk(d)]||(daily[dk(d)]=bucket()),b=monthly[mk(d)]||(monthly[mk(d)]=bucket());a[f]+=v;b[f]+=v}
    var confirmed=new Map();
    get('fp_monthly_extra_charges',[]).forEach(function(x){if(x&&x.confirmed&&x.entryId!=null&&x.confirmedAt)confirmed.set(String(x.entryId),x.confirmedAt)});
    allEntries().forEach(function(e){
      add(pd(e.entradaFecha),'vehiculos',1);
      if(e.salidaFecha&&!e.pendingMonthlyConfirmation)add(pd(confirmed.get(String(e.id))||e.salidaFecha),'ventas',Number(e.total)||0);
    });
    get('fp_incomes',[]).forEach(function(x){add(pd(x.dateTime),'manuales',Number(x.amount)||0)});
    get('fp_expenses',[]).forEach(function(x){add(pd(x.dateTime),'egresos',Number(x.amount)||0)});
    get('fp_monthly_payments',[]).forEach(function(x){var d=pd(x.dateTime);add(d,'pagos',Number(x.value)||0);add(d,'cant',1)});
    return {daily:daily,monthly:monthly};
  }
  function formato(b){
    var ing=b.ventas+b.manuales;
    return {vehiculos:b.vehiculos,ventas_parqueadero:b.ventas,ingresos_manuales:b.manuales,ingresos_total:ing,egresos:b.egresos,
      ganancia_neta:ing-b.egresos,ticket_promedio:b.vehiculos?Math.round(b.ventas/b.vehiculos):0,
      pagos_mensualidades:b.pagos,cantidad_pagos_mensualidades:b.cant};
  }
  function sumar(ag,r){
    var t=bucket(),dias=0,detalle=[];
    Object.keys(ag.daily).sort().forEach(function(k){
      if(k<r.desde||k>r.hasta)return;
      var b=ag.daily[k];Object.keys(t).forEach(function(f){t[f]+=b[f]});
      if(b.vehiculos>0)dias++;
      detalle.push(Object.assign({fecha:k},{vehiculos:b.vehiculos,ingresos_total:b.ventas+b.manuales,egresos:b.egresos}));
    });
    var out=Object.assign({desde:r.desde,hasta:r.hasta,dias_con_actividad:dias},formato(t));
    if((r.h-r.d)/86400000<=31)out.por_dia=detalle;
    return out;
  }

  /* ---------- Placas, clientes, mensualidades ---------- */
  function mensualidades(){return get('fp_monthly',[]).filter(function(m){return m&&!m.pendingConfirmation})}
  function mensualidadDe(key){
    var m=mensualidades().filter(function(x){return plateKey(x.plate)===key});
    m.sort(function(a,b){return (pd(b.end)||0)-(pd(a.end)||0)});
    return m[0]||null;
  }
  function infoPlaca(key){
    var es=allEntries().filter(function(e){return plateKey(e.placa||e.plate)===key}),mn=mensualidadDe(key);
    if(!es.length&&!mn)return null;
    var r={};
    if(es.length){
      es.sort(function(a,b){return (pd(b.entradaFecha)||0)-(pd(a.entradaFecha)||0)});
      var e=es.find(function(x){return !x.salidaFecha})||es[0],en=pd(e.entradaFecha);
      r.visitas_registradas=es.length;r.servicio=servicio(e.idTarifa);
      if(!e.salidaFecha){
        r.estado='dentro del parqueadero';r.hora_entrada=fmtF(en);
        r.minutos_dentro=Math.max(0,Math.floor((new Date()-en)/60000));
        r.saldo_actual=tarifa(en,e.idTarifa);r.saldo_calculado_a=fmtF(new Date());
      }else{
        r.estado='ya salio';r.ultima_entrada=fmtF(en);r.ultima_salida=fmtF(pd(e.salidaFecha));r.total_cobrado=Number(e.total)||0;
      }
    }else r.estado='sin entradas registradas';
    if(mn)r.mensualidad={cliente:mn.name||'',vigente_hasta:fmtD(pd(mn.end)),activa:!!mn.active,valor:mn.value};
    return r;
  }
  function filaMens(m){return {cliente:m.name||'',placa:plateKey(m.plate),vigente_hasta:fmtD(pd(m.end)),activa:!!m.active,valor:m.value}}

  /* ---------- Alertas (codigo, sin IA) ---------- */
  function alertas(){
    if(!window.NexoAlertas)return [];
    var now=new Date(),ayer=dk(new Date(now.getFullYear(),now.getMonth(),now.getDate()-1));
    var abiertos=[],salidasAyer=[],ing={},egm={};
    allEntries().forEach(function(e){
      var en=pd(e.entradaFecha),sa=pd(e.salidaFecha);
      if(!e.salidaFecha){if(en)abiertos.push({entrada:en});return}
      if(sa&&dk(sa)===ayer&&!e.pendingMonthlyConfirmation&&!e.isMonthly)
        salidasAyer.push({total:Number(e.total)||0,cobrado:(Number(e.cashAmount)||0)+(Number(e.nequiAmount)||0)});
      if(sa&&!e.pendingMonthlyConfirmation)ing[dk(sa)]=(ing[dk(sa)]||0)+(Number(e.total)||0);
    });
    get('fp_incomes',[]).forEach(function(x){var d=pd(x.dateTime);if(d)ing[dk(d)]=(ing[dk(d)]||0)+(Number(x.amount)||0)});
    get('fp_expenses',[]).forEach(function(x){var d=pd(x.dateTime);if(d)egm[mk(d)]=(egm[mk(d)]||0)+(Number(x.amount)||0)});
    var mens=mensualidades().map(function(m){return {fin:pd(m.end),activa:!!m.active}});
    return window.NexoAlertas.calcular({ahora:now,abiertos:abiertos,salidasAyer:salidasAyer,ingresosPorDia:ing,egresosPorMes:egm,mensualidades:mens});
  }

  /* ---------- Herramientas ---------- */
  var ALIAS={};
  function listaDentro(){
    return allEntries().filter(function(e){return !e.salidaFecha&&pd(e.entradaFecha)}).map(function(e){
      var en=pd(e.entradaFecha),mn=mensualidadDe(plateKey(e.placa||e.plate));
      return {placa:e.placa||e.plate||'',servicio:servicio(e.idTarifa),hora_entrada:fmtF(en),
        minutos_dentro:Math.max(0,Math.floor((new Date()-en)/60000)),saldo_actual:tarifa(en,e.idTarifa),con_mensualidad_activa:!!(mn&&mn.active)};
    });
  }
  var HERRAMIENTAS={
    vehiculos_dentro:function(a){
      var l=listaDentro();
      if(a.servicio){var s=norm(a.servicio);l=l.filter(function(v){return norm(v.servicio).indexOf(s)>=0})}
      if(a.sin_mensualidad===true)l=l.filter(function(v){return !v.con_mensualidad_activa});
      return {total:l.length,calculado_a:fmtF(new Date()),lista:l.slice(0,100)};
    },
    consultar_placa:function(a){
      var k=plateKey(a.placa);if(k.length<5)throw new Error('Placa invalida.');
      var i=infoPlaca(k);return i?Object.assign({placa:k},i):{placa:k,encontrada:false};
    },
    consultar_cliente:function(a){
      var toks=norm(a.nombre).split(/[^a-z0-9]+/).filter(Boolean);if(!toks.length)throw new Error('Nombre vacio.');
      var res=mensualidades().filter(function(m){var n=norm(m.name);return m.name&&toks.every(function(t){return n.indexOf(t)>=0})}).slice(0,5);
      if(!res.length)return {encontrado:false};
      return {encontrado:true,clientes:res.map(function(m){var k=plateKey(m.plate);return Object.assign(filaMens(m),{vehiculo:infoPlaca(k)||{encontrada:false}})})};
    },
    consultar_tarifas:function(){
      return {tarifas:services().filter(function(s){return s&&s.active!==false}).map(function(s){return {servicio:s.name,valor_hora:s.hour,valor_fraccion:s.fraction,tope_12_horas:s.full12h}})};
    },
    resumen_periodo:function(a){return sumar(agregados(),rango(a.desde,a.hasta))},
    comparar_periodos:function(a){
      var ag=agregados(),A=sumar(ag,rango(a.desde_a,a.hasta_a)),B=sumar(ag,rango(a.desde_b,a.hasta_b));
      delete A.por_dia;delete B.por_dia;
      function v(x,y){return y?Math.round((x-y)/Math.abs(y)*1000)/10:null}
      return {periodo_a:A,periodo_b:B,variacion_a_vs_b_pct:{vehiculos:v(A.vehiculos,B.vehiculos),ingresos_total:v(A.ingresos_total,B.ingresos_total),egresos:v(A.egresos,B.egresos),ganancia_neta:v(A.ganancia_neta,B.ganancia_neta)}};
    },
    resumen_por_mes:function(a){
      var n=Math.min(12,Math.max(1,parseInt(a.meses,10)||12)),ag=agregados(),now=new Date(),out={};
      for(var i=n-1;i>=0;i--){var k=mk(new Date(now.getFullYear(),now.getMonth()-i,1));out[k]=formato(ag.monthly[k]||bucket())}
      return {meses:out,nota:'El mes en curso esta incompleto.'};
    },
    ocupacion_por_franja:function(a){
      var r=rango(a.desde,a.hasta),fr=new Array(24).fill(0),dow=[0,0,0,0,0,0,0],tot=0;
      allEntries().forEach(function(e){var d=pd(e.entradaFecha);if(d&&d>=r.d&&d<=r.h){fr[d.getHours()]++;dow[d.getDay()]++;tot++}});
      var dias=['domingo','lunes','martes','miercoles','jueves','viernes','sabado'],pd7={};dow.forEach(function(n,i){pd7[dias[i]]=n});
      return {desde:r.desde,hasta:r.hasta,total_entradas:tot,franjas_mas_ocupadas:fr.map(function(n,h){return {hora:p2(h)+':00-'+p2(h)+':59',entradas:n}}).sort(function(x,y){return y.entradas-x.entradas}).slice(0,6),entradas_por_dia_semana:pd7};
    },
    actividad_empleados:function(a){
      var r=rango(a.desde,a.hasta),emp={},sin=0;
      allEntries().forEach(function(e){var d=pd(e.entradaFecha);if(!d||d<r.d||d>r.h)return;if(e.registradoPor)emp[e.registradoPor]=(emp[e.registradoPor]||0)+1;else sin++});
      var users=get('fp_users',[]),out={};ALIAS={};
      Object.keys(emp).sort().forEach(function(u,i){var c='E'+(i+1),x=users.find(function(y){return y&&String(y.username)===u});ALIAS[c]=(x&&x.name)||u;out[c]={registros:emp[u]}});
      return {desde:r.desde,hasta:r.hasta,empleados:out,entradas_sin_empleado_registrado:sin,nota:'El empleado se registra solo en entradas nuevas.'};
    },
    consultar_alertas:function(){var al=alertas();return {cantidad:al.length,alertas:al.map(function(x){return x.texto})}},
    listar_mensualidades:function(a){
      var est=a.estado||'activas',now=new Date(),lim=new Date(now.getFullYear(),now.getMonth(),now.getDate()+3,23,59,59);
      var l=mensualidades().filter(function(m){
        var fin=finDia(pd(m.end));
        if(est==='activas')return !!m.active;
        if(est==='vencidas')return !m.active||(fin&&fin<now);
        if(est==='por_vencer')return !!m.active&&fin&&fin>=now&&fin<=lim;
        return true;
      });
      return {estado:est,total:l.length,lista:l.slice(0,50).map(filaMens)};
    },
    listar_novedades:function(a){
      var n=Math.min(50,Math.max(1,parseInt(a.cantidad,10)||20));
      var l=get('fp_novedades',[]).slice().sort(function(x,y){return String(y.fecha).localeCompare(String(x.fecha))});
      return {total:l.length,novedades:l.slice(0,n).map(function(x){return {fecha:fmtF(pd(x.fecha)),placa:x.placa||null,texto:x.texto,registrada_por:x.usuario||''}})};
    }
  };
  /* Herramientas por rol (debe coincidir con agente/herramientas/index.js, que es la autoridad en main.js). */
  var COMUNES=['vehiculos_dentro','consultar_placa','consultar_cliente','consultar_tarifas'];
  var POR_ROL={
    empleado:COMUNES.concat(['proponer_novedad','proponer_entrada']),
    administrador:COMUNES.concat(['resumen_periodo','comparar_periodos','resumen_por_mes','ocupacion_por_franja','actividad_empleados','consultar_alertas','listar_mensualidades','listar_novedades',
      'proponer_movimiento','proponer_informe','proponer_cierre_caja','proponer_renovar_mensualidad','proponer_ajuste_tarifa'])
  };

  window.NexoHerramientas={
    /* Ejecuta una herramienta pedida por la IA. Revalida el rol y nunca lanza: devuelve {error}. */
    ejecutar:function(nombre,args,rol){
      try{
        if((POR_ROL[rol]||[]).indexOf(nombre)<0)return {error:'Tu rol no tiene acceso a esos datos.'};
        var a=args&&typeof args==='object'?args:{};
        // Las acciones solo se PROPONEN; se ejecutan cuando la persona pulsa Confirmar (agente/cliente/acciones.js).
        if(nombre.indexOf('proponer_')===0)return window.NexoAcciones?window.NexoAcciones.proponer(nombre,a,rol):{error:'Acciones no disponibles.'};
        var f=HERRAMIENTAS[nombre];
        if(!f)return {error:'Herramienta desconocida.'};
        return f(a);
      }catch(e){return {error:e.message}}
    },
    alertas:alertas,
    /* Datos para el informe (lo usa acciones.js). */
    datosInforme:function(desde,hasta){
      var r=rango(desde,hasta),res=sumar(agregados(),r);
      function mov(k){return get(k,[]).filter(function(x){var d=pd(x&&x.dateTime);return d&&d>=r.d&&d<=r.h}).map(function(x){return {fecha:fmtF(pd(x.dateTime)),concepto:x.concept||x.description||'',valor:+x.amount||0,usuario:x.user||''}})}
      if(!res.por_dia){ // rango largo: detalle por dia igual, para el archivo
        var ag=agregados();res.por_dia=Object.keys(ag.daily).sort().filter(function(k){return k>=r.desde&&k<=r.hasta}).map(function(k){var b=ag.daily[k];return {fecha:k,vehiculos:b.vehiculos,ingresos_total:b.ventas+b.manuales,egresos:b.egresos}});
      }
      return {resumen:res,egresos:mov('fp_expenses'),ingresos:mov('fp_incomes')};
    },
    util:{pd:pd,fmtF:fmtF,fmtD:fmtD,plateKey:plateKey,norm:norm,mensualidades:mensualidades,mensualidadDe:mensualidadDe,allEntries:allEntries,services:services},
    /* Cambia los codigos E1, E2... por los nombres reales (solo en pantalla). */
    nombres:function(t){return String(t).replace(/\bE(\d+)\b/g,function(m){return ALIAS[m]||m})}
  };
})();
