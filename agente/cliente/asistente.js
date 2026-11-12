/* Asistente de Nexo.app (interfaz). La IA pide datos con herramientas (agente/cliente/herramientas.js);
 * aqui se muestra el chat, se ejecutan las herramientas que la IA pida y se arma la respuesta.
 * El rol sale de la sesion (fp_user). */
(function(){
  if(!window.nexoAI||!window.NexoHerramientas) return; // fuera de Electron no se muestra
  var H=window.NexoHerramientas;
  var MODULE=document.body.getAttribute('data-module')||'';
  var SCOPE=MODULE==='monthlyreport'?'mensualidades':'general';
  function get(k,d){try{var v=localStorage.getItem(k);return v?JSON.parse(v):d}catch(e){return d}}
  function userRole(){var r=String((get('fp_user',{})||{}).role||'Empleado').trim().toLowerCase();return (r==='administrador'||r==='superadmin')?'administrador':'empleado'}
  var ROLE=userRole(), ADMIN=ROLE==='administrador';

  /* ---------- UI ---------- */
  var ROBOT='<svg class="nxbot" viewBox="0 0 32 32" width="28" height="28" aria-hidden="true">'+
    '<line x1="16" y1="4" x2="16" y2="8" stroke="#9fe8ff" stroke-width="2" stroke-linecap="round"/>'+
    '<circle class="nxant" cx="16" cy="3.5" r="2.4" fill="#ff4081"/>'+
    '<rect x="2" y="14" width="3" height="6" rx="1.5" fill="#9fe8ff"/><rect x="27" y="14" width="3" height="6" rx="1.5" fill="#9fe8ff"/>'+
    '<rect x="5" y="8" width="22" height="17" rx="6" fill="#e8f4ff"/>'+
    '<g class="nxeyes"><circle cx="12" cy="16" r="2.7" fill="#0b2748"/><circle cx="20" cy="16" r="2.7" fill="#0b2748"/></g>'+
    '<rect x="11" y="21" width="10" height="2" rx="1" fill="#0b2748"/></svg>';
  var css='#nxAiBtn{position:fixed;right:22px;bottom:22px;z-index:2500;background:#0b2748;color:#fff;border:0;border-radius:28px;padding:12px 18px;font-weight:700;box-shadow:0 6px 18px rgba(0,0,0,.3);cursor:pointer}'+
  '@property --nxa{syntax:"<angle>";inherits:false;initial-value:0deg}'+
  '#nxAiBtn{display:flex;align-items:center;gap:8px;isolation:isolate}'+
  '#nxAiBtn::before,#nxAiBtn::after{content:"";position:absolute;inset:-3px;padding:3px;border-radius:31px;background:conic-gradient(from var(--nxa),#00e5ff,#7c4dff,#ff4081,#ffd740,#00e5ff);animation:nxspin 3s linear infinite;pointer-events:none;-webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);-webkit-mask-composite:xor;mask-composite:exclude}'+
  '#nxAiBtn::after{filter:blur(8px);opacity:.8}'+
  '.nxbot{flex:none;transform-origin:50% 90%;animation:nxfloat 2.4s ease-in-out infinite}'+
  '.nxbot .nxeyes{transform-box:fill-box;transform-origin:center;animation:nxblink 4s infinite}'+
  '.nxbot .nxant{animation:nxping 1.2s ease-in-out infinite}'+
  '@keyframes nxspin{to{--nxa:360deg}}'+
  '@keyframes nxfloat{0%,100%{transform:translateY(0) rotate(-6deg)}50%{transform:translateY(-3px) rotate(6deg)}}'+
  '@keyframes nxblink{0%,92%,100%{transform:scaleY(1)}96%{transform:scaleY(.1)}}'+
  '@keyframes nxping{0%,100%{opacity:1}50%{opacity:.2}}'+
  '@media (prefers-reduced-motion:reduce){#nxAiBtn::before,#nxAiBtn::after,.nxbot,.nxbot .nxeyes,.nxbot .nxant{animation:none}}'+
  '#nxAiBtn .nxb{display:inline-block;background:#e0452b;color:#fff;border-radius:10px;padding:0 7px;margin-left:6px;font-size:12px}'+
  '#nxAiBox{position:fixed;right:22px;bottom:78px;z-index:2500;width:380px;max-width:calc(100vw - 30px);height:520px;max-height:calc(100vh - 110px);background:#fff;border:1px solid #d9dde2;border-radius:16px;box-shadow:0 18px 50px rgba(0,0,0,.3);display:none;flex-direction:column;overflow:hidden}'+
  '#nxAiBox.open{display:flex}#nxAiHead{background:#0b2748;color:#fff;padding:12px 16px;font-weight:700;display:flex;justify-content:space-between;align-items:center}'+
  '#nxAiHead button{background:none;border:0;color:#fff;font-size:20px;cursor:pointer;line-height:1}'+
  '#nxAiMsgs{flex:1;overflow:auto;padding:12px;background:#f7f8fa;font-size:14px}'+
  '.nxm{margin:0 0 10px;padding:9px 12px;border-radius:12px;max-width:88%;white-space:pre-wrap;line-height:1.4}'+
  '.nxm.u{background:#0b2748;color:#fff;margin-left:auto}.nxm.a{background:#fff;border:1px solid #e1e5ea;color:#30343b}.nxm.e{background:#fdecea;color:#b3261e}.nxm.w{background:#fff6e0;border:1px solid #f0d9a0;color:#5b4300;max-width:100%}'+
  '#nxAiSug{display:flex;flex-wrap:wrap;gap:6px;padding:0 12px 8px;background:#f7f8fa}'+
  '#nxAiSug button{border:1px solid #c9d8ea;background:#eef4fb;color:#0b2748;border-radius:14px;padding:4px 10px;font-size:12px;cursor:pointer}'+
  '#nxAiForm{display:flex;gap:8px;padding:10px;border-top:1px solid #e1e5ea}#nxAiForm input{flex:1;border:1px solid #d9dde2;border-radius:10px;padding:8px 10px}'+
  '.nxm.ok{background:#e9f7ee;border:1px solid #b9e2c6;color:#1d5b33}'+
  '.nxcard{background:#fff;border:1px solid #c9d8ea;border-left:4px solid #0b2748;border-radius:12px;padding:10px 12px;margin:0 0 10px;font-size:13px}'+
  '.nxch{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:4px}.nxch b{color:#0b2748}'+
  '.nxrk{font-size:11px;font-weight:700;border-radius:10px;padding:2px 8px}.nxrk-bajo{background:#e9f7ee;color:#1d5b33}.nxrk-medio{background:#fff4d6;color:#7a5600}.nxrk-alto{background:#fdecea;color:#b3261e}'+
  '.nxcard ul{margin:4px 0 8px;padding-left:18px;color:#30343b}.nxcard li{margin:2px 0}'+
  '.nxcb{display:flex;gap:8px}.nxcb button{border:0;border-radius:8px;padding:6px 14px;font-weight:700;cursor:pointer}.nxok{background:#0b2748;color:#fff}.nxno{background:#eef1f5;color:#30343b}.nxcb button:disabled{opacity:.6;cursor:default}.nxcs{font-size:12px;color:#5f6670;font-weight:700}'+
  '.nxopen{margin-top:6px;border:1px solid #1d5b33;background:#fff;color:#1d5b33;border-radius:8px;padding:3px 10px;cursor:pointer;font-weight:700}'+
  '#nxAiForm button{background:#0b2748;color:#fff;border:0;border-radius:10px;padding:0 14px;font-weight:700;cursor:pointer}';
  var st=document.createElement('style');st.textContent=css;document.head.appendChild(st);

  var btn=document.createElement('button');btn.id='nxAiBtn';btn.innerHTML=ROBOT+'<span>NexoIA</span>';
  var box=document.createElement('div');box.id='nxAiBox';
  box.innerHTML='<div id="nxAiHead"><span>'+(ADMIN?'Asistente del administrador':'Asistente operativo')+'</span><span>'+
    '<button id="nxAiX">×</button></span></div>'+
    '<div id="nxAiMsgs"></div><div id="nxAiSug"></div>'+
    '<form id="nxAiForm"><input id="nxAiIn" placeholder="'+(ADMIN?'Pregunta sobre tus reportes...':'Pregunta sobre un vehículo o un procedimiento...')+'" autocomplete="off"><button>Enviar</button></form>';
  document.body.appendChild(btn);document.body.appendChild(box);
  var msgs=box.querySelector('#nxAiMsgs'),inp=box.querySelector('#nxAiIn'),history=[];
  var sugs=!ADMIN
    ?['¿Qué vehículos siguen dentro?','¿Cómo registro una salida?','¿Cómo registro una novedad?','¿Cuáles son las tarifas?']
    :(SCOPE==='general'
      ?['¿Cómo estuvo el parqueadero esta semana?','¿Cuánto gané en los últimos 10 días?','¿Qué empleado hizo más registros?','¿Qué tarifas conviene revisar?']
      :['¿Cuánto recaudé por mensualidades este mes?','¿Qué mes recaudé más en los últimos 3 meses?']);
  var sg=box.querySelector('#nxAiSug');
  sugs.forEach(function(t){var b=document.createElement('button');b.type='button';b.textContent=t;b.onclick=function(){send(t)};sg.appendChild(b)});

  function say(cls,t){var d=document.createElement('div');d.className='nxm '+cls;d.textContent=t;msgs.appendChild(d);msgs.scrollTop=msgs.scrollHeight;return d}
  say('a',ADMIN?'Hola. Pregúntame por tus ingresos, egresos, ocupación o comparaciones entre periodos.':'Hola. Te ayudo con vehículos dentro, valores a cobrar, tarifas y procedimientos.');
  function open(){box.classList.add('open');var b=btn.querySelector('.nxb');if(b)b.remove();inp.focus()}
  btn.onclick=function(){box.classList.contains('open')?box.classList.remove('open'):open()};
  box.querySelector('#nxAiX').onclick=function(){box.classList.remove('open')};
  // Alertas del administrador (pantalla de inicio), calculadas con codigo.
  if(ADMIN&&MODULE==='dashboard'){
    var al=[];try{al=H.alertas()}catch(e){}
    if(al.length){
      say('w','Alertas de hoy:\n- '+al.map(function(a){return a.texto}).join('\n- '));
      var bd=document.createElement('span');bd.className='nxb';bd.textContent=al.length;btn.appendChild(bd);
    }
  }
  // El chat se abre al ingresar (primera pantalla de cada sesion de usuario), para ambos roles.
  try{
    var sesionId=ROLE+'|'+String((get('fp_user',{})||{}).username||'')+'|'+(localStorage.getItem('fp_session')||'');
    if(sessionStorage.getItem('nxChatAbierto')!==sesionId){sessionStorage.setItem('nxChatAbierto',sesionId);open()}
  }catch(e){open()}
  async function send(q){
    q=(q||'').trim();if(!q)return;inp.value='';sg.style.display='none';
    say('u',q);
    if(navigator.onLine===false){say('e','El asistente solo funciona con internet. Revisa la conexión e inténtalo de nuevo.');return}
    var w=say('a','Pensando...');
    ROLE=userRole();ADMIN=ROLE==='administrador';
    var r,extra=[];
    try{
      for(var ronda=0;ronda<8;ronda++){
        r=await window.nexoAI.ask({question:q,role:ROLE,history:history,extra:extra});
        if(!(r&&r.ok&&r.tipo==='herramientas'))break;
        w.textContent='Consultando datos...';
        var resp=r.llamadas.map(function(c){return {functionResponse:{name:c.nombre,response:{resultado:H.ejecutar(c.nombre,c.args,ROLE)}}}});
        extra.push(r.contenido,{role:'user',parts:resp});
      }
    }catch(e){r={ok:false,error:e.message}}
    var nuevas=window.NexoAcciones?window.NexoAcciones.tomarNuevas():[];
    if(r&&r.ok&&r.tipo==='texto'){var out=ADMIN?H.nombres(r.text):r.text;w.textContent=out;history.push({role:'user',text:q},{role:'model',text:r.text})}
    else if(nuevas.length){w.textContent='Te dejé la acción lista para confirmar.'}
    else{w.className='nxm e';w.textContent=(r&&r.error==='NO_KEY')?(ADMIN?'Falta la API key de Gemini. Defínela como GEMINI_API_KEY en el archivo .env.':'El asistente no está configurado. Avisa al administrador.'):'No pude responder: '+((r&&r.error)||'la consulta necesitó demasiados pasos');}
    nuevas.forEach(tarjeta);
    msgs.scrollTop=msgs.scrollHeight;
  }
  /* Tarjeta de confirmacion: la accion solo se ejecuta con un clic real en Confirmar. */
  function tarjeta(p){
    var c=document.createElement('div');c.className='nxcard';
    var h=document.createElement('div');h.className='nxch';
    var t=document.createElement('b');t.textContent=p.titulo;
    var rk=document.createElement('span');rk.className='nxrk nxrk-'+p.riesgo;rk.textContent='Riesgo '+p.riesgo;
    h.appendChild(t);h.appendChild(rk);c.appendChild(h);
    var ul=document.createElement('ul');(p.detalle||[]).forEach(function(d){var li=document.createElement('li');li.textContent=d;ul.appendChild(li)});c.appendChild(ul);
    var bs=document.createElement('div');bs.className='nxcb';
    var ok=document.createElement('button');ok.type='button';ok.className='nxok';ok.textContent='Confirmar';
    var no=document.createElement('button');no.type='button';no.className='nxno';no.textContent='Cancelar';
    bs.appendChild(ok);bs.appendChild(no);c.appendChild(bs);msgs.appendChild(c);
    function fin(txt){bs.innerHTML='';var s=document.createElement('span');s.className='nxcs';s.textContent=txt;bs.appendChild(s)}
    ok.onclick=async function(ev){
      if(!ev||!ev.isTrusted)return; // solo un clic real de la persona
      ok.disabled=no.disabled=true;ok.textContent='Ejecutando...';
      var res=await window.NexoAcciones.ejecutar(p.id,userRole());
      fin(res.ok?'Confirmada':'No se completó');
      var m=say(res.ok?'ok':'e',res.mensaje);
      if(res.ok&&res.archivo){var ab=document.createElement('button');ab.type='button';ab.className='nxopen';ab.textContent='Abrir informe';ab.onclick=function(){window.nexoAI.abrirInforme(res.archivo)};m.appendChild(document.createElement('br'));m.appendChild(ab)}
      history.push({role:'user',text:'[Sistema] La persona confirmó la acción "'+p.titulo+'".'},{role:'model',text:res.mensaje});
    };
    no.onclick=function(){window.NexoAcciones.cancelar(p.id);fin('Cancelada');say('a','Acción cancelada. No se hizo ningún cambio.');history.push({role:'user',text:'[Sistema] La persona canceló la acción "'+p.titulo+'".'},{role:'model',text:'Acción cancelada.'})};
  }
  box.querySelector('#nxAiForm').onsubmit=function(e){e.preventDefault();send(inp.value)};
})();
