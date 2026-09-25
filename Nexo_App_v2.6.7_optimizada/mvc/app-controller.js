/* FacaParking MVC - CONTROLADOR
 * Orquesta eventos, validaciones y flujo entre vistas y modelo.
 */
(function(window){
'use strict';
const {KEY,defaults,get,set,entries,paymentLabel,cashPart,plateUpper,hashPassword,verifyPassword,needsRehash}=window.FPModel;
/* Mantener igual a "version" de package.json (y a package-lock.json). */
const APP_VERSION='2.6.17';
/* Historial de ingresos (login history): la clave debe quedar disponible en
 * todo el archivo, no solo dentro de initLogin(), porque initLoginHistory()
 * (usada en Configuración) también la necesita. Antes estaba declarada solo
 * dentro de initLogin() y eso rompía initConfig() con "LOGIN_HISTORY_KEY is
 * not defined", lo que a su vez impedía que initConfigUsers() se ejecutara
 * (por eso no aparecía la opción de registrar Superadmin ni la tabla de
 * usuarios en Configuración). */
const LOGIN_HISTORY_KEY='fp_login_history', LOGIN_HISTORY_MAX=300;
const esc=(s)=>String(s??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[m]));
const money=(n)=>new Intl.NumberFormat('es-CO',{style:'currency',currency:'COP',maximumFractionDigits:0}).format(Number(n)||0);
/* Si se renombra un usuario (Perfil o Configuración de usuarios), su entrada
 * en la lista de "usuarios recordados" del login debe actualizarse también,
 * o quedaría un chip apuntando a un usuario que ya no existe. */
function syncRememberedRename(oldU,newU){
  if(!oldU||!newU||String(oldU).toLowerCase()===String(newU).toLowerCase())return;
  let list=get(KEY.remembered,[]);
  if(!Array.isArray(list))return;
  let idx=list.findIndex(x=>String(x).toLowerCase()===String(oldU).toLowerCase());
  if(idx>-1){list[idx]=newU;set(KEY.remembered,list)}
}

/* ---------------------------------------------------------------------
 * fpAlert: reemplazo no bloqueante de alert().
 * El alert() nativo congela por completo el hilo de la interfaz de
 * Electron hasta que se cierra manualmente; si el diálogo no recibe el
 * foco (frecuente en ventanas sin barra de título/menú como esta), el
 * usuario percibe la app como "trabada" y termina cerrándola a la
 * fuerza. fpAlert muestra una notificación (toast) que no bloquea nada
 * y se cierra sola.
 * ------------------------------------------------------------------- */
(function(){
  let host=null;
  function ensureHost(){
    if(host && document.body && document.body.contains(host)) return host;
    if(!document.body) return null;
    host=document.createElement('div');
    host.id='fpToastHost';
    host.style.cssText='position:fixed;top:16px;right:16px;z-index:2147483000;display:flex;flex-direction:column;gap:8px;max-width:380px;pointer-events:none';
    document.body.appendChild(host);
    return host;
  }
  window.fpAlert=function(message,type){
    try{
      const h=ensureHost();
      const text=String(message??'');
      if(!h){ console.log('[fpAlert]',text); return; }
      const isError=type==='error' || /no (fue posible|válid|autorizad)|obligatori|debe |error|inv[aá]lid|no se pudo|no coinciden/i.test(text);
      const div=document.createElement('div');
      div.style.cssText='pointer-events:auto;background:'+(isError?'#c0392b':'#1f7a4d')+';color:#fff;padding:12px 16px;border-radius:10px;box-shadow:0 8px 22px rgba(0,0,0,.35);font:14px/1.4 Arial,Helvetica,sans-serif;white-space:pre-line;cursor:pointer;opacity:0;transform:translateY(-8px);transition:opacity .18s ease,transform .18s ease';
      div.textContent=text;
      let timer=null;
      function dismiss(){clearTimeout(timer);div.style.opacity='0';div.style.transform='translateY(-8px)';setTimeout(()=>div.remove(),200)}
      div.addEventListener('click',dismiss);
      h.appendChild(div);
      requestAnimationFrame(()=>{div.style.opacity='1';div.style.transform='translateY(0)'});
      timer=setTimeout(dismiss,4200);
    }catch(err){ console.error('fpAlert:',err); }
  };
})();

/* ---------------------------------------------------------------------
 * fpConfirm / fpPrompt: reemplazo NO bloqueante de confirm() / prompt().
 * En Electron (Windows) los diálogos nativos confirm()/prompt() dejan la
 * ventana sin foco de teclado al cerrarse (la app "se congela": no deja
 * escribir hasta cambiar de ventana) y prompt() ni siquiera está soportado.
 * Estos diálogos son HTML propio: no bloquean ni pierden el foco.
 *   fpConfirm(mensaje, onSi, {okText, cancelText, danger})
 *   fpPrompt(mensaje, onAceptar(valor), {okText, cancelText, danger})
 * ------------------------------------------------------------------- */
(function(){
  function mkBtn(label,primary,danger){
    const b=document.createElement('button');
    b.type='button';b.textContent=label;
    const bg=primary?(danger?'#c0392b':'#1f7a4d'):'#e9ecef';
    b.style.cssText='border:0;border-radius:8px;padding:8px 16px;font:600 14px Arial,Helvetica,sans-serif;cursor:pointer;background:'+bg+';color:'+(primary?'#fff':'#333');
    return b;
  }
  function open(message,opts,withInput,cb){
    if(!document.body)return;
    const ov=document.createElement('div');
    ov.style.cssText='position:fixed;top:0;left:0;right:0;bottom:0;z-index:2147483100;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;padding:16px';
    const card=document.createElement('div');
    card.style.cssText='background:#fff;color:#222;border-radius:12px;box-shadow:0 12px 40px rgba(0,0,0,.35);max-width:460px;width:100%;padding:20px 22px;font:14px/1.45 Arial,Helvetica,sans-serif;box-sizing:border-box';
    const msg=document.createElement('div');
    msg.style.cssText='white-space:pre-line;margin-bottom:14px';
    msg.textContent=String(message==null?'':message);
    card.appendChild(msg);
    let input=null;
    if(withInput){
      input=document.createElement('input');input.type='text';
      input.style.cssText='width:100%;padding:8px 10px;border:1px solid #bbb;border-radius:8px;font-size:14px;margin-bottom:14px;box-sizing:border-box';
      card.appendChild(input);
    }
    const row=document.createElement('div');
    row.style.cssText='display:flex;justify-content:flex-end;gap:8px';
    const cancel=mkBtn(opts.cancelText||'Cancelar',false,false);
    const ok=mkBtn(opts.okText||'Aceptar',true,!!opts.danger);
    row.appendChild(cancel);row.appendChild(ok);card.appendChild(row);ov.appendChild(card);
    let done=false;
    function finish(accepted){
      if(done)return;done=true;
      document.removeEventListener('keydown',onKey,true);
      if(ov.parentNode)ov.parentNode.removeChild(ov);
      if(accepted)cb(input?input.value:undefined);
    }
    function onKey(e){
      if(e.key==='Escape'){e.preventDefault();e.stopPropagation();finish(false);}
      else if(e.key==='Enter'){e.preventDefault();e.stopPropagation();finish(document.activeElement!==cancel);}
    }
    cancel.onclick=function(){finish(false)};
    ok.onclick=function(){finish(true)};
    ov.addEventListener('mousedown',function(e){if(e.target===ov)finish(false)});
    document.addEventListener('keydown',onKey,true);
    document.body.appendChild(ov);
    // Acciones destructivas: el foco inicial queda en Cancelar para que un Enter accidental no las ejecute.
    (input||(opts.danger?cancel:ok)).focus();
  }
  window.fpConfirm=function(message,onYes,opts){open(message,opts||{},false,function(){if(typeof onYes==='function')onYes()})};
  window.fpPrompt=function(message,onOk,opts){open(message,opts||{},true,function(v){if(typeof onOk==='function')onOk(v)})};
})();

/* ---------------------------------------------------------------------
 * entriesFull(): entries() (fp_entries) crece para siempre con cada
 * vehículo que entra/sale. Antes existía un archivado automático que
 * movía lo viejo a 'fp_entries_archive', pero como la purga (más abajo)
 * ya borra definitivamente todo lo de más de PURGE_MONTHS meses, ese
 * archivado nunca llegaba a conservar nada a largo plazo y se quitó.
 * entriesFull() se mantiene y sigue leyendo también 'fp_entries_archive'
 * por compatibilidad, por si el equipo todavía tiene datos ahí de una
 * versión anterior de la app.
 * ------------------------------------------------------------------- */
const ARCHIVE_KEY='fp_entries_archive';
function entriesFull(){
  const m=new Map();
  get(ARCHIVE_KEY,[]).forEach(e=>{if(e&&e.id!=null)m.set(String(e.id),e)});
  entries().forEach(e=>{if(e&&e.id!=null)m.set(String(e.id),e)});
  return Array.from(m.values());
}

/* ---------------------------------------------------------------------
 * Purga de memoria (borrado permanente e incremental día por día).
 * Se conservan PURGE_MONTHS meses (hoy 12) de historial "en caliente". Pasado ese
 * plazo, cada día que se abre la app se borra DEFINITIVAMENTE un único día de
 * historial (el más antiguo que ya superó el plazo), nunca un lote completo de
 * golpe. Ej. con 12 meses: lo registrado el 1 de enero se conserva hasta el 1 de
 * enero del año siguiente; el 2 de enero se borra lo del 1 de enero, el 3 de enero
 * lo del 2 de enero, y así sucesivamente, un día por día, tanto para el rezago que
 * ya existiera como para lo que se vaya generando de ahora en adelante.
 * Aplica a: entradas/salidas (incluye lo ya archivado), ingresos y egresos, pagos
 * de mensualidades, cierres de caja y mensualidades ya vencidas (nunca
 * a una mensualidad activa). Un vehículo que sigue parqueado (sin fecha
 * de salida) nunca se borra, sin importar cuán vieja sea su entrada.
 * ------------------------------------------------------------------- */
const PURGE_MONTHS=12;
const PURGE_FRONTIER_KEY='fp_purge_frontier';
const PURGE_LAST_RUN_KEY='fp_last_purge_run';
function purgeOldMemory(force){
  try{
    const today=startOfDay(new Date());
    const todayStr=dayKey(today);
    if(!force && localStorage.getItem(PURGE_LAST_RUN_KEY)===todayStr) return {purged:0,skipped:true};
    const cutoff=new Date(today); cutoff.setMonth(cutoff.getMonth()-PURGE_MONTHS);

    let frontier=parseFPDate(localStorage.getItem(PURGE_FRONTIER_KEY));
    if(!frontier){
      let min=null;
      const consider=(v)=>{const d=parseFPDate(v); if(d && (!min||d<min)) min=d;};
      [KEY.db,ARCHIVE_KEY].forEach(k=>get(k,[]).forEach(e=>{if(e&&e.salidaFecha)consider(e.salidaFecha)}));
      get('fp_expenses',[]).forEach(e=>consider(e&&e.dateTime));
      get('fp_incomes',[]).forEach(e=>consider(e&&e.dateTime));
      get('fp_base_in',[]).forEach(e=>consider(e&&e.dateTime));
      get('fp_base_out',[]).forEach(e=>consider(e&&e.dateTime));
      get('fp_monthly_payments',[]).forEach(e=>consider(e&&e.dateTime));
      get('fp_cash_closings',[]).forEach(e=>consider(e&&e.closedAt));
      get('fp_monthly',[]).forEach(x=>{if(x&&!x.active)consider(x.end)});
      localStorage.setItem(PURGE_LAST_RUN_KEY,todayStr);
      if(!min){ return {purged:0,skipped:false}; }
      frontier=startOfDay(min); frontier.setDate(frontier.getDate()-1);
      localStorage.setItem(PURGE_FRONTIER_KEY,dayKey(frontier));
      return {purged:0,skipped:false,initialized:true};
    }

    const nextDay=new Date(frontier); nextDay.setDate(nextDay.getDate()+1);
    localStorage.setItem(PURGE_LAST_RUN_KEY,todayStr);
    if(nextDay>cutoff){
      return {purged:0,skipped:false,waiting:true};
    }
    const targetStr=dayKey(nextDay);
    let purged=0;
    const isTarget=(v)=>{const d=parseFPDate(v); return d && dayKey(d)===targetStr};

    [KEY.db,ARCHIVE_KEY].forEach(k=>{
      const arr=get(k,[]);
      const kept=arr.filter(e=>{
        if(!e || !e.salidaFecha) return true; // nunca borrar entradas sin salida (parqueado actualmente)
        if(isTarget(e.salidaFecha)){ purged++; return false; }
        return true;
      });
      if(kept.length!==arr.length) set(k,kept);
    });
    ['fp_expenses','fp_incomes','fp_base_in','fp_base_out'].forEach(k=>{
      const arr=get(k,[]);
      const kept=arr.filter(e=>{ if(e && isTarget(e.dateTime)){ purged++; return false; } return true; });
      if(kept.length!==arr.length) set(k,kept);
    });
    ['fp_monthly_payments'].forEach(k=>{
      const arr=get(k,[]);
      const kept=arr.filter(e=>{ if(e && isTarget(e.dateTime)){ purged++; return false; } return true; });
      if(kept.length!==arr.length) set(k,kept);
    });
    ['fp_cash_closings'].forEach(k=>{
      const arr=get(k,[]);
      const kept=arr.filter(e=>{ if(e && isTarget(e.closedAt)){ purged++; return false; } return true; });
      if(kept.length!==arr.length) set(k,kept);
    });
    {
      const arr=get('fp_monthly',[]);
      const kept=arr.filter(x=>{
        if(!x || x.active) return true; // nunca borrar una mensualidad activa
        if(isTarget(x.end)){ purged++; return false; }
        return true;
      });
      if(kept.length!==arr.length) set('fp_monthly',kept);
    }

    localStorage.setItem(PURGE_FRONTIER_KEY,targetStr);
    return {purged,skipped:false,day:targetStr};
  }catch(err){ console.error('Purga de memoria:',err); return {purged:0,error:true}; }
}
window.__fpPurge={purgeOldMemory,PURGE_MONTHS,PURGE_FRONTIER_KEY,PURGE_LAST_RUN_KEY};

function pad2(n){return String(n).padStart(2,'0')}
function parseFPDate(v){
 if(v instanceof Date) return isNaN(v)?null:v;
 if(v==null||v==='') return null;
 const s=String(v).trim();
 const m=s.match(/^(\d{2})-(\d{2})-(\d{4})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/);
 if(m) return new Date(+m[3],+m[2]-1,+m[1],+(m[4]||0),+(m[5]||0),+(m[6]||0));
 const d=new Date(s);
 return isNaN(d)?null:d;
}
function dayKey(d){return d.getFullYear()+'-'+pad2(d.getMonth()+1)+'-'+pad2(d.getDate())}
function dayLabel(d){return pad2(d.getDate())+'/'+pad2(d.getMonth()+1)}
function startOfDay(d){const x=new Date(d);x.setHours(0,0,0,0);return x}
function endOfDay(d){const x=new Date(d);x.setHours(23,59,59,999);return x}
function ymdInput(d){return d.getFullYear()+'-'+pad2(d.getMonth()+1)+'-'+pad2(d.getDate())}
function drawBarChart(canvasId,labels,series,opts){
 opts=opts||{};
 const canvas=document.getElementById(canvasId);
 if(!canvas) return;
 const wrap=canvas.parentElement;
 const cssWidth=Math.max((wrap&&wrap.clientWidth)||canvas.clientWidth||600,260);
 const cssHeight=opts.height||260;
 const dpr=window.devicePixelRatio||1;
 canvas.width=cssWidth*dpr; canvas.height=cssHeight*dpr;
 canvas.style.width=cssWidth+'px'; canvas.style.height=cssHeight+'px';
 const ctx=canvas.getContext('2d');
 ctx.setTransform(dpr,0,0,dpr,0,0);
 ctx.clearRect(0,0,cssWidth,cssHeight);
 if(!labels.length){
   ctx.fillStyle='#7c8ba1'; ctx.font='13px Arial'; ctx.textAlign='center'; ctx.textBaseline='middle';
   ctx.fillText('Sin datos para el período seleccionado',cssWidth/2,cssHeight/2);
   return;
 }
 const padding={top:26,right:18,bottom:30,left:opts.leftPad||58};
 const chartW=cssWidth-padding.left-padding.right, chartH=cssHeight-padding.top-padding.bottom;
 const maxVal=Math.max(1,...series.flatMap(s=>s.values));
 const steps=4;
 ctx.strokeStyle='rgba(150,180,215,.16)'; ctx.lineWidth=1;
 ctx.fillStyle='#8fa0b8'; ctx.font='11px Arial'; ctx.textAlign='right'; ctx.textBaseline='middle';
 for(let i=0;i<=steps;i++){
   const y=padding.top+chartH-(chartH*i/steps);
   ctx.beginPath(); ctx.moveTo(padding.left,y); ctx.lineTo(cssWidth-padding.right,y); ctx.stroke();
   const val=maxVal*i/steps;
   ctx.fillText(opts.formatY?opts.formatY(val):String(Math.round(val)),padding.left-8,y);
 }
 const n=labels.length, groupW=chartW/n, seriesCount=series.length;
 const barGap=Math.max(2,groupW*0.12);
 const barW=Math.max(3,(groupW-barGap*2)/seriesCount);
 const skip=n>16?Math.ceil(n/16):1;
 labels.forEach((lab,i)=>{
   const groupX=padding.left+i*groupW;
   series.forEach((s,si)=>{
     const val=s.values[i]||0;
     const barH=maxVal>0?(val/maxVal)*chartH:0;
     const x=groupX+barGap+si*barW;
     const y=padding.top+chartH-barH;
     ctx.fillStyle=s.color;
     if(barH>0) ctx.fillRect(x,y,Math.max(barW-2,1),barH);
   });
   if(i%skip===0){
     ctx.fillStyle='#8fa0b8'; ctx.textAlign='center'; ctx.textBaseline='top'; ctx.font='10px Arial';
     ctx.fillText(lab,groupX+groupW/2,padding.top+chartH+6);
   }
 });
 if(series.length>1){
   let lx=padding.left;
   series.forEach(s=>{
     ctx.fillStyle=s.color; ctx.fillRect(lx,4,10,10);
     ctx.fillStyle='#cfd9e6'; ctx.textAlign='left'; ctx.textBaseline='top'; ctx.font='11px Arial';
     ctx.fillText(s.name,lx+14,3);
     lx+=14+ctx.measureText(s.name).width+18;
   });
 }
}
function drawLineChart(canvasId,labels,series,opts){
 opts=opts||{};
 const canvas=document.getElementById(canvasId);
 if(!canvas) return;
 const wrap=canvas.parentElement;
 const cssWidth=Math.max((wrap&&wrap.clientWidth)||canvas.clientWidth||600,260);
 const cssHeight=opts.height||260;
 const dpr=window.devicePixelRatio||1;
 canvas.width=cssWidth*dpr; canvas.height=cssHeight*dpr;
 canvas.style.width=cssWidth+'px'; canvas.style.height=cssHeight+'px';
 const ctx=canvas.getContext('2d');
 ctx.setTransform(dpr,0,0,dpr,0,0);
 ctx.clearRect(0,0,cssWidth,cssHeight);
 if(!labels.length){
   ctx.fillStyle='#7c8ba1'; ctx.font='13px Arial'; ctx.textAlign='center'; ctx.textBaseline='middle';
   ctx.fillText('Sin datos para el período seleccionado',cssWidth/2,cssHeight/2);
   return;
 }
 const padding={top:26,right:18,bottom:30,left:opts.leftPad||58};
 const chartW=cssWidth-padding.left-padding.right, chartH=cssHeight-padding.top-padding.bottom;
 const maxVal=Math.max(1,...series.flatMap(s=>s.values));
 const steps=4;
 ctx.strokeStyle='rgba(150,180,215,.16)'; ctx.lineWidth=1;
 ctx.fillStyle='#8fa0b8'; ctx.font='11px Arial'; ctx.textAlign='right'; ctx.textBaseline='middle';
 for(let i=0;i<=steps;i++){
   const y=padding.top+chartH-(chartH*i/steps);
   ctx.beginPath(); ctx.moveTo(padding.left,y); ctx.lineTo(cssWidth-padding.right,y); ctx.stroke();
   const val=maxVal*i/steps;
   ctx.fillText(opts.formatY?opts.formatY(val):String(Math.round(val)),padding.left-8,y);
 }
 const n=labels.length;
 const stepX=n>1?chartW/(n-1):0;
 const xAt=i=>padding.left+(n>1?i*stepX:chartW/2);
 const yAt=val=>padding.top+chartH-(maxVal>0?(val/maxVal)*chartH:0);
 const skip=n>16?Math.ceil(n/16):1;
 labels.forEach((lab,i)=>{
   if(i%skip===0){
     ctx.fillStyle='#8fa0b8'; ctx.textAlign='center'; ctx.textBaseline='top'; ctx.font='10px Arial';
     ctx.fillText(lab,xAt(i),padding.top+chartH+6);
   }
 });
 series.forEach(s=>{
   ctx.strokeStyle=s.color; ctx.lineWidth=2; ctx.lineJoin='round'; ctx.lineCap='round';
   ctx.beginPath();
   s.values.forEach((val,i)=>{const x=xAt(i),y=yAt(val||0); if(i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);});
   ctx.stroke();
   ctx.fillStyle=s.color;
   s.values.forEach((val,i)=>{
     const x=xAt(i),y=yAt(val||0);
     ctx.beginPath(); ctx.arc(x,y,3,0,Math.PI*2); ctx.fill();
   });
 });
 if(series.length>1){
   let lx=padding.left;
   series.forEach(s=>{
     ctx.fillStyle=s.color; ctx.fillRect(lx,4,10,10);
     ctx.fillStyle='#cfd9e6'; ctx.textAlign='left'; ctx.textBaseline='top'; ctx.font='11px Arial';
     ctx.fillText(s.name,lx+14,3);
     lx+=14+ctx.measureText(s.name).width+18;
   });
 }
}
function isAdminLevelRole(role){const r=String(role||'Empleado').trim().toLowerCase();return r==='administrador'||r==='superadmin'}
/* Renovación automática de mensualidades pagadas por adelantado.
 * Cuando el cliente ya pagó el siguiente período (x.nextPeriod, ver payMonthlyAdvance) y llega
 * la fecha de inicio de ese período (= fecha de vencimiento del actual), las fechas de la
 * mensualidad se renuevan solas, SIN pedir ningún cobro: el pago ya existe en
 * fp_monthly_payments. Se ejecuta desde ensure() (todas las pantallas), el Dashboard y ParkApp,
 * para no depender de que alguien abra la pantalla Mensualidades. */
function activateDueAdvancePeriods(){
  try{
    const list=get('fp_monthly',[]); if(!Array.isArray(list)||!list.length)return false;
    const today=new Date();today.setHours(0,0,0,0);let changed=false;
    list.forEach(x=>{
      if(!x||!x.nextPeriod)return;
      const npStart=new Date((x.nextPeriod.start||'')+'T00:00:00');
      if(isNaN(npStart))return;
      npStart.setHours(0,0,0,0);
      if(today>=npStart){
        x.start=x.nextPeriod.start; x.end=x.nextPeriod.end; x.active=true; x.paymentStatus='paid';
        x.lastReceiptPrefix=x.nextPeriod.receiptPrefix; x.lastReceiptNumber=x.nextPeriod.receiptNumber;
        x.updatedAt=new Date().toISOString();
        delete x.nextPeriod; changed=true;
      }
    });
    if(changed)set('fp_monthly',list);
    return changed;
  }catch(e){console.error('Renovación automática de mensualidades:',e);return false}
}
/* Desactiva las mensualidades que ya superaron el plazo de gracia de 3 días.
 * Antes esto solo corría dentro de initMonthly() (al abrir la pantalla Mensualidades), así que
 * el Dashboard mostraba una mensualidad vencida como "en mora" hasta que alguien entraba
 * a Mensualidades, y entonces desaparecía. Ahora corre en cada carga de página (ensure) y en
 * cada redibujado del Dashboard, con la misma regla en todas partes. Solo escribe si algo cambió. */
function deactivateExpiredMonthlies(){
  try{
    const list=get('fp_monthly',[]); if(!Array.isArray(list)||!list.length)return false;
    const today=new Date();today.setHours(0,0,0,0);let changed=false;
    list.forEach(x=>{
      if(!x)return;
      const en=monthlyEndWithGrace(x);
      const a=!!x.active && (!en || en>=today);
      if(a!==!!x.active){x.active=a;changed=true}
    });
    if(changed)set('fp_monthly',list);
    return changed;
  }catch(e){console.error('Vencimiento de mensualidades:',e);return false}
}
function ensure(){let users=get(KEY.users,null);if(!Array.isArray(users)||!users.length){let old=get(KEY.user,null);users=old?[old]:[{...defaults.user,password:hashPassword(defaults.user.password)},{username:'admin',name:'admin',document:'',email:'',phone:'',role:'Administrador',password:hashPassword('admin')}];set(KEY.users,users)}
 /* El usuario "Felipe" es la cuenta raíz del sistema y siempre debe tener rol
  * Superadmin, sin importar cómo haya quedado guardado antes (instalaciones
  * previas a esta regla, ediciones manuales, etc.). Se normaliza en cada
  * arranque para que quede garantizado y, de paso, quede oculto para los
  * Administradores junto con las demás cuentas Superadmin. */
 let felipeFixed=false;
 users=users.map(u=>{if(u && String(u.username||'').trim().toLowerCase()==='felipe' && String(u.role||'').trim().toLowerCase()!=='superadmin'){felipeFixed=true;return {...u,role:'Superadmin'}}return u});
 if(felipeFixed)set(KEY.users,users);
 let current=get(KEY.user,null);
 if(!current){set(KEY.user,users[0])}
 else{
  /* La sesión activa guarda su propia copia del usuario (fp_user), separada
   * de la lista (fp_users). Si esa copia quedó desactualizada (por ejemplo,
   * una sesión abierta antes de que existiera esta regla de Felipe/Superadmin,
   * o cualquier otro cambio de rol hecho en Configuración), se sincroniza
   * aquí con el registro más reciente de la lista, para que no haga falta
   * cerrar sesión y volver a entrar. */
  const match=users.find(u=>String(u.username||'').trim().toLowerCase()===String(current.username||'').trim().toLowerCase());
  if(match && JSON.stringify(match)!==JSON.stringify(current)){set(KEY.user,match)}
 }
 set(KEY.registered,'1');if(!localStorage.getItem(KEY.services))set(KEY.services,defaults.services);if(!localStorage.getItem(KEY.clients))set(KEY.clients,defaults.clients);if(!localStorage.getItem(KEY.config))set(KEY.config,defaults.config);if(!localStorage.getItem(KEY.closures))set(KEY.closures,defaults.closures);activateDueAdvancePeriods();deactivateExpiredMonthlies();purgeOldMemory()}
function auth(){
 ensure();
 let p=location.pathname.split('/').pop().toLowerCase();
 if(p==='registro.html'||p==='login.html')return true;
 let session=get(KEY.session,null);
 if(!session){location.replace('login.html');return false}
 let users=get(KEY.users,[]);
 let u=users.find(x=>String(x.username||'').toLowerCase()===String(session.username||'').toLowerCase());
 if(!u){
   /* La cuenta de la sesión guardada ya no existe (fue eliminada o
    * renombrada). Antes esto caía a un usuario "de respaldo" que podía
    * terminar siendo el Administrador por defecto, dando privilegios que
    * nadie autorizó. En vez de eso, se invalida la sesión y se obliga a
    * iniciar sesión de nuevo. */
   localStorage.removeItem(KEY.session);
   location.replace('login.html');
   return false;
 }
 set(KEY.user,u);
 let role=String(u?.role||'Empleado').trim().toLowerCase();
 /* Superadmin tiene, como mínimo, todos los privilegios de Administrador
  * (incluye el acceso a Reportes y Configuración). */
 const adminLevel=isAdminLevelRole(role);
 const employeeAllowed=['index.html','parkapp.html','mensualidades.html','caja.html','pagos.html','egresos.html'];
 const adminOnly=['reportes.html','configuracion.html'];
 if(!adminLevel && !employeeAllowed.includes(p) && adminOnly.includes(p)){
   fpAlert('Acceso no autorizado. Esta sección es exclusiva del Administrador.');
   location.replace('index.html');
   return false;
 }
 if(!adminLevel && !employeeAllowed.includes(p) && !adminOnly.includes(p)){
   fpAlert('Acceso no autorizado.');
   location.replace('index.html');
   return false;
 }
 return true;
}
/* El cierre de sesión automático por inactividad fue eliminado por completo:
 * la sesión solo se cierra cuando la persona presiona "Salir" (o inicia
 * sesión desde otro dispositivo/usuario). No hay ningún watcher de
 * inactividad ni límite de minutos. */
function startSessionWatch(){}
function nav(){
 const u=get(KEY.user,defaults.user), role=String(u?.role||'Empleado').trim().toLowerCase();
 const admin=isAdminLevelRole(role);
 const current=location.pathname.split('/').pop().toLowerCase();
 const items=[
  ['index.html','fa-dashboard','Inicio',true],
  ['ParkApp.html','fa-map-marker','Entradas',true],
  ['mensualidades.html','fa-calendar','Mensualidades',admin],
  ['pendientes.html','fa-pending','Pendientes',admin],
  ['caja.html','fa-money','Cierre de Caja',true],
  ['pagos.html','fa-shopping-cart','Ventas',true],
  ['egresos.html','fa-sign-out','Transacciones',admin],
  ['reportes.html','fa-bar-chart','Reportes',admin],
  ['configuracion.html','fa-cog','Configuración',admin]
 ];
 const ul=document.querySelector('.sidebar .sidebar-wrapper ul.nav');
 if(ul){
   const icons={
     'fa-dashboard':'<svg class="fp-nav-icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>',
     'fa-map-marker':'<svg class="fp-nav-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s7-6.2 7-12A7 7 0 1 0 5 9c0 5.8 7 12 7 12Z"/><circle cx="12" cy="9" r="2.2"/></svg>',
     'fa-calendar':'<svg class="fp-nav-icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 3v4M17 3v4M3 10h18"/></svg>',
     'fa-money':'<svg class="fp-nav-icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="6" width="18" height="12" rx="2"/><circle cx="12" cy="12" r="3"/><path d="M6 9h.01M18 15h.01"/></svg>',
     'fa-shopping-cart':'<svg class="fp-nav-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 4h2l2.2 11.2a2 2 0 0 0 2 1.6h7.7a2 2 0 0 0 2-1.6L20 8H6"/><circle cx="10" cy="20" r="1"/><circle cx="18" cy="20" r="1"/></svg>',
     'fa-sign-out':'<svg class="fp-nav-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M10 4H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h5M14 8l4 4-4 4M9 12h9"/></svg>',
     'fa-bar-chart':'<svg class="fp-nav-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 20V10M12 20V4M19 20v-7"/></svg>',
     'fa-pending':'<svg class="fp-nav-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/></svg>',
     'fa-cog':'<svg class="fp-nav-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-1.7 1.7-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V20h-2.4v-.2a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1-1.7-1.7.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H5.2V12h.2a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.9l-.1-.1 1.7-1.7.1.1a1.7 1.7 0 0 0 1.9.3 1.7 1.7 0 0 0 1-1.5V4h2.4v.2a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1 1.7 1.7-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 .3 1.9 1.7 1.7 0 0 0 1.5 1h.2v2.4h-.2a1.7 1.7 0 0 0-1.5 1Z"/></svg>'
   };
   ul.innerHTML=items.filter(x=>x[3]).map(x=>`<li class="nav-item ${current===x[0]?'active':''}"><a class="nav-link" href="${x[0]}">${icons[x[1]]||icons['fa-dashboard']}<p>${x[2]}</p></a></li>`).join('')+
     '<li class="nav-item active-pro"><a class="nav-link" href="login.html" id="fpLogout">'+icons['fa-sign-out']+'<p>Salir</p></a></li>';
 }
 if(!document.getElementById('fp-nav-theme')){
   const st=document.createElement('style'); st.id='fp-nav-theme'; st.textContent=`
   .sidebar{background:linear-gradient(180deg,#071a33 0%,#0b2748 55%,#06162c 100%)!important;border-right:1px solid rgba(255,255,255,.08)!important;box-shadow:6px 0 24px rgba(3,18,38,.18)!important}
   .sidebar .logo{background:transparent!important;border-bottom:1px solid rgba(255,255,255,.08)!important;padding:18px 14px!important}
   .sidebar .logo a{color:#fff!important;font-weight:800!important;font-size:22px!important;letter-spacing:-.2px}
   .sidebar .logo a .fp-brand-orange{color:#ff9f00!important}
   .sidebar .nav{padding-top:10px!important}
   .sidebar .nav li>a{color:#fff!important;border-radius:10px!important;margin:4px 10px!important;width:calc(100% - 20px)!important;padding:11px 14px!important;display:flex!important;align-items:center!important;gap:10px!important;min-height:44px!important}
   .sidebar .nav li>a p{color:#fff!important;margin:0!important;font-weight:500!important}
   .sidebar .nav li>a i{color:#fff!important;width:24px!important;text-align:center!important;font-size:18px!important;margin-right:2px!important}.sidebar .nav li>a .fp-nav-icon{width:21px!important;height:21px!important;min-width:21px!important;stroke:currentColor;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;margin-right:2px!important}
   .sidebar .nav li.active>a,.sidebar .nav li>a:hover{background:linear-gradient(90deg,#ff6b00,#ffb300)!important;box-shadow:0 7px 18px rgba(255,122,0,.2)!important}
   .sidebar .nav li.active>a i,.sidebar .nav li.active>a p,.sidebar .nav li>a:hover i,.sidebar .nav li>a:hover p{color:#fff!important}
   .sidebar .sidebar-wrapper{overflow-x:hidden!important}.sidebar .nav li>a.fp-nav-loading{pointer-events:none;opacity:.72!important}
   #fpSidebarToggle{position:absolute;top:14px;right:8px;width:26px;height:26px;padding:0;border:1px solid rgba(255,255,255,.25)!important;border-radius:7px;background:rgba(255,255,255,.08)!important;color:#fff!important;display:flex!important;align-items:center;justify-content:center;cursor:pointer;z-index:5;transition:transform .25s}
   #fpSidebarToggle:hover{background:rgba(255,255,255,.18)!important}
   .sidebar-mini #fpSidebarToggle svg{transform:rotate(180deg)}
   @media (max-width:990px){#fpSidebarToggle{display:none!important}}
   /* El tema base expande el sidebar al pasar el mouse por encima (efecto "peek"),
      lo que hacía parecer que el botón de minimizar no funcionaba: como el botón
      está dentro del sidebar, al hacer clic el mouse queda encima y se re-expande
      al instante. Forzamos que se mantenga en modo icono aunque el mouse esté encima. */
   @media (min-width:991px){
     .sidebar-mini .sidebar:hover{width:80px!important}
     .sidebar-mini .sidebar:hover .sidebar-wrapper{width:80px!important}
     .sidebar-mini .sidebar:hover .logo a.logo-normal{opacity:0!important;transform:translate3d(-25px,0,0)!important}
     .sidebar-mini .sidebar:hover .sidebar-wrapper>.nav li>a p{opacity:0!important;transform:translate3d(-25px,0,0)!important}
   }
   `; document.head.appendChild(st);
 }
 const logo=document.querySelector('.sidebar .logo a');
 if(logo && !logo.dataset.fpBranded){logo.innerHTML='Nexo<span class="fp-brand-orange">.App</span>';logo.dataset.fpBranded='1';}
 document.querySelectorAll('.fp-user-name').forEach(e=>e.textContent=u.name||u.username);
 document.querySelectorAll('.fp-user-role').forEach(e=>e.textContent=u.role||'Empleado');
 let logout=document.getElementById('fpLogout');
 if(logout)logout.onclick=e=>{e.preventDefault();localStorage.removeItem(KEY.session);location.replace('login.html')};
 // Navegación robusta: evita doble activación accidental y mantiene el comportamiento
 // normal de los enlaces locales dentro de Electron.
 ul?.querySelectorAll('a.nav-link[href]').forEach(a=>{
   if(a.id==='fpLogout')return;
   a.addEventListener('click',()=>{a.setAttribute('aria-busy','true'); a.classList.add('fp-nav-loading');});
 });
 const miniKey='fp_sidebar_mini';
 const applyMini=(on)=>{
   document.body.classList.toggle('sidebar-mini',!!on);
   const b=document.getElementById('fpSidebarToggle');
   if(b){b.setAttribute('aria-pressed',on?'true':'false');b.title=on?'Expandir menú':'Minimizar menú';b.setAttribute('aria-label',b.title);}
 };
 applyMini(localStorage.getItem(miniKey)==='1');
 const logoDiv=document.querySelector('.sidebar .logo');
 if(logoDiv && !document.getElementById('fpSidebarToggle')){
   const tbtn=document.createElement('button');
   tbtn.type='button';
   tbtn.id='fpSidebarToggle';
   tbtn.innerHTML='<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 6 9 12 15 18"/></svg>';
   tbtn.onclick=()=>{
     const on=!document.body.classList.contains('sidebar-mini');
     applyMini(on);
     localStorage.setItem(miniKey,on?'1':'0');
   };
   logoDiv.appendChild(tbtn);
 }
}

function initRegistration(){ensure();let f=document.getElementById('registerForm');if(!f)return;f.onsubmit=e=>{e.preventDefault();let username=f.username.value.trim(),name=f.name.value.trim(),password=f.password.value,confirm=f.confirm.value,m=document.getElementById('registerMsg');if(!username||!name||!password){m.textContent='Complete los campos obligatorios.';m.style.display='block';return}if(password!==confirm){m.textContent='Las contraseñas no coinciden.';m.style.display='block';return}let users=get(KEY.users,[]);if(users.some(u=>String(u.username).toLowerCase()===username.toLowerCase())){m.textContent='Ese nombre de usuario ya está registrado.';m.style.display='block';return}
 /* Esta pantalla es pública (no requiere sesión), así que nunca debe poder
  * crear una cuenta con rol Administrador, sin importar lo que traiga el
  * formulario. Los roles de administrador solo se otorgan desde
  * Configuración > Usuarios, estando ya autenticado como Administrador. */
 let nu={username,name,document:f.document.value.trim(),email:f.email.value.trim(),phone:f.phone.value.trim(),role:'Empleado',password:hashPassword(password)};users.push(nu);set(KEY.users,users);m.textContent='Usuario registrado correctamente. Ahora puedes iniciar sesión.';m.style.display='block';f.reset();setTimeout(()=>location.href='login.html',700)}}
function initLogin(){
ensure();
localStorage.removeItem(KEY.session);
let f=document.getElementById('loginForm');
if(!f)return;

/* --- Usuarios recordados: se guarda una lista (no solo el último) y,
 * si hay usuarios guardados, la persona solo elige de la lista en vez
 * de volver a escribir su usuario. --- */
let legacy=localStorage.getItem('fp_remember_user');
let remembered=get(KEY.remembered,[]);
if(!Array.isArray(remembered))remembered=[];
if(legacy){
  if(!remembered.some(x=>String(x).toLowerCase()===legacy.toLowerCase()))remembered.unshift(legacy);
  localStorage.removeItem('fp_remember_user');
  set(KEY.remembered,remembered);
}
const pickerWrap=document.getElementById('userPicker'),pickerList=document.getElementById('userPickerList'),
      useOtherBtn=document.getElementById('useOtherUser'),fieldWrap=document.getElementById('userFieldWrap'),
      selectedWrap=document.getElementById('selectedUser'),selectedName=document.getElementById('selectedUserName'),
      selectedAvatar=document.getElementById('selectedUserAvatar'),changeUserBtn=document.getElementById('changeUser'),
      rememberBox=document.getElementById('remember');

function initials(u){return String(u||'?').trim().slice(0,2).toUpperCase()}

function showManualEntry(prefill){
  pickerWrap.style.display='none';
  selectedWrap.style.display='none';
  fieldWrap.style.display='';
  f.username.removeAttribute('readonly');
  f.username.value=prefill||'';
  if(rememberBox)rememberBox.checked=false;
  f.username.focus();
}
function showSelected(u){
  fieldWrap.style.display='none';
  pickerWrap.style.display='none';
  f.username.value=u;
  selectedName.textContent=u;
  selectedAvatar.textContent=initials(u);
  selectedWrap.style.display='';
  f.password.focus();
}
function renderPicker(){
  remembered=get(KEY.remembered,[]);
  if(!Array.isArray(remembered)||remembered.length===0){
    showManualEntry();
    return;
  }
  f.username.value='';
  if(rememberBox)rememberBox.checked=true;
  pickerList.innerHTML=remembered.map(u=>
    '<div class="user-chip" data-u="'+esc(u)+'" tabindex="0" role="button" aria-label="Iniciar sesión como '+esc(u)+'">'+
      '<span class="name"><span class="avatar">'+esc(initials(u))+'</span>'+esc(u)+'</span>'+
      '<button type="button" class="forget" title="Olvidar este usuario" aria-label="Olvidar este usuario" data-forget="'+esc(u)+'">&times;</button>'+
    '</div>'
  ).join('');
  pickerList.querySelectorAll('.forget').forEach(b=>b.onclick=(e)=>{
    e.stopPropagation();
    remembered=remembered.filter(x=>x!==b.dataset.forget);
    set(KEY.remembered,remembered);
    renderPicker();
  });
  pickerList.querySelectorAll('.user-chip').forEach(chip=>{
    chip.onclick=()=>showSelected(chip.dataset.u);
    chip.onkeydown=(e)=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();showSelected(chip.dataset.u)}};
  });
  selectedWrap.style.display='none';
  fieldWrap.style.display='none';
  pickerWrap.style.display='';
  const firstChip=pickerList.querySelector('.user-chip');
  if(firstChip)firstChip.focus();
}
renderPicker();
if(useOtherBtn)useOtherBtn.onclick=()=>showManualEntry('');
if(changeUserBtn)changeUserBtn.onclick=()=>showManualEntry('');

let forgotBtn=document.getElementById('forgotPassword');
if(forgotBtn)forgotBtn.onclick=(e)=>{
 e.preventDefault();
 const m=document.getElementById('loginMsg');
 const allUsers=get(KEY.users,[]);
 const isAdmin=x=>isAdminLevelRole(x.role);
 const typed=String(f.username.value||'').trim().toLowerCase();
 const me=typed?allUsers.find(x=>String(x.username).toLowerCase()===typed):null;
 const otherAdmins=allUsers.filter(x=>isAdmin(x)&&(!me||String(x.username).toLowerCase()!==typed)).map(x=>x.username);
 let text;
 if(me&&isAdmin(me)&&otherAdmins.length===0){
  text='Eres el único Administrador registrado. Nadie más puede restablecer tu contraseña desde aquí: contacta a quien administra o instaló el sistema.';
 }else if(otherAdmins.length){
  text='No es posible recuperar la contraseña desde esta pantalla. Pide a un Administrador ('+otherAdmins.join(', ')+') que inicie sesión y te la restablezca en Configuración → Usuarios.';
 }else{
  text='No hay ningún Administrador registrado que pueda restablecer contraseñas. Contacta a quien administra o instaló el sistema.';
 }
 m.textContent=text;m.style.display='block';
};

function logLoginHistory(user){
  try{
    let hist=get(LOGIN_HISTORY_KEY,[]);
    if(!Array.isArray(hist))hist=[];
    hist.push({username:user.username||'',name:user.name||'',role:user.role||'Empleado',at:new Date().toISOString()});
    if(hist.length>LOGIN_HISTORY_MAX)hist=hist.slice(hist.length-LOGIN_HISTORY_MAX);
    set(LOGIN_HISTORY_KEY,hist);
  }catch(e){}
}
f.onsubmit=e=>{
 e.preventDefault();
 let u=f.username.value.trim(),p=f.password.value,m=document.getElementById('loginMsg');
  if(!u){
    m.textContent='Escribe tu usuario.';
    m.style.display='block';
    f.username.focus();
    return;
  }
  if(!p){
    m.textContent='Escribe tu contraseña.';
    m.style.display='block';
    f.password.focus();
    return;
  }
  let uKey=u.toLowerCase();
 let users=get(KEY.users,[]),userIdx=users.findIndex(x=>String(x.username).toLowerCase()===uKey),user=userIdx>-1?users[userIdx]:null;
 if(!user||!verifyPassword(p,user.password)){
   m.textContent='Usuario o contraseña incorrectos.';
   m.style.display='block';
   return;
 }
 if(needsRehash(user.password)){
   /* Migración: esta cuenta todavía tenía la contraseña en texto plano
    * (instalación anterior a este cambio). Se reemplaza por un hash con
    * salt ahora que sabemos que la contraseña ingresada es correcta. */
   user={...user,password:hashPassword(p)};
   users[userIdx]=user;
   set(KEY.users,users);
 }
 set(KEY.user,user);
 logLoginHistory(user);
 let list=get(KEY.remembered,[]);
 if(!Array.isArray(list))list=[];
 list=list.filter(x=>String(x).toLowerCase()!==u.toLowerCase());
 if(rememberBox&&rememberBox.checked){
   list.unshift(u);
   list=list.slice(0,6);
 }
 set(KEY.remembered,list);
 set(KEY.session,{username:u,at:new Date().toISOString(),lastActivity:Date.now()});
 location.href='index.html';
};
let r=document.getElementById('goRegister');
if(r)r.onclick=()=>{location.href='registro.html'}
}
function initProfile(){ensure();let users=get(KEY.users,[]),current=get(KEY.user,users[0]),f=document.getElementById('profileForm'),tb=document.querySelector('#usersTable tbody');function render(){if(!tb)return;tb.innerHTML=users.map((u,i)=>`<tr><td>${esc(u.username)}</td><td>${esc(u.name)}</td><td>${esc(u.document||'')}</td><td>${esc(u.email||'')}</td><td>${esc(u.phone||'')}</td><td>${esc(u.role||'Empleado')}</td><td><button class="btn btn-sm btn-warning editUser" data-i="${i}">Editar</button></td></tr>`).join('')||'<tr><td colspan="7">No hay usuarios registrados.</td></tr>';tb.querySelectorAll('.editUser').forEach(b=>b.onclick=()=>{let u=users[+b.dataset.i];current=u;['username','name','document','email','phone','role'].forEach(k=>{if(f.elements[k])f.elements[k].value=u[k]||''});f.elements.password.value='';f.dataset.i=b.dataset.i;window.scrollTo({top:0,behavior:'smooth'})})}if(f){['username','name','document','email','phone','role'].forEach(k=>{if(f.elements[k])f.elements[k].value=current[k]||''});f.onsubmit=e=>{e.preventDefault();let i=f.dataset.i!==undefined?+f.dataset.i:users.findIndex(u=>u.username===current.username),username=f.username.value.trim(),name=f.name.value.trim();if(!username||!name){fpAlert('Usuario y nombre son obligatorios.');return}if(users.some((u,j)=>j!==i&&String(u.username).toLowerCase()===username.toLowerCase())){fpAlert('Ese nombre de usuario ya está registrado.','error');return}let old=users[i],nu={...old,username,name,document:f.document.value.trim(),email:f.email.value.trim(),phone:f.phone.value.trim(),role:f.role.value.trim()||'Empleado'};if(f.password.value)nu.password=hashPassword(f.password.value);users[i]=nu;set(KEY.users,users);syncRememberedRename(old.username,username);if(get(KEY.user,null)?.username===old.username)set(KEY.user,nu);delete f.dataset.i;f.elements.password.value='';current=nu;render();fpAlert('Usuario actualizado correctamente.')}}render()}
function initServices(){let data=get(KEY.services,defaults.services);data=(Array.isArray(data)?data:defaults.services).map(x=>({...x,fraction:Number(x.fraction??x.minute??0),full12h:Number(x.full12h??(String(x.id)==='5'?20000:String(x.id)==='6'?14000:10000)),monthly:Number(x.monthly||0)}));let tbody=document.querySelector('#servicesTable tbody'),f=document.getElementById('serviceForm');function render(){tbody.innerHTML=data.map((s,i)=>`<tr><td>${esc(s.code)}</td><td>${esc(s.name)}</td><td>${esc(s.description)}</td><td>${money(s.hour)}</td><td>${money(s.fraction)}</td><td>${money(s.full12h)}</td><td>${money(s.monthly)}</td><td>${s.active?'Activo':'Inactivo'}</td><td><button class="btn btn-sm btn-warning editService" data-i="${i}">Editar</button></td></tr>`).join('');tbody.querySelectorAll('.editService').forEach(b=>b.onclick=()=>{let s=data[+b.dataset.i];for(let k of ['id','code','name','description','hour','fraction','full12h','monthly'])if(f.elements[k])f.elements[k].value=s[k]??'';f.elements.active.checked=!!s.active;f.dataset.i=b.dataset.i})}render();f.onsubmit=e=>{e.preventDefault();let s={id:f.id.value||String(Date.now()),code:f.code.value.trim().toUpperCase(),name:f.name.value.trim(),description:f.description.value.trim(),hour:+f.hour.value||0,fraction:+f.fraction.value||0,full12h:+f.full12h.value||0,monthly:+f.monthly.value||0,active:f.active.checked};if(f.dataset.i!==undefined)data[+f.dataset.i]=s;else data.push(s);set(KEY.services,data);delete f.dataset.i;f.reset();f.active.checked=true;render();fpAlert('Servicio guardado.')};document.getElementById('newService').onclick=()=>{delete f.dataset.i;f.reset();f.active.checked=true}}
function initClients(){let data=get(KEY.clients,defaults.clients),tbody=document.querySelector('#clientsTable tbody'),f=document.getElementById('clientForm'),search=document.getElementById('clientSearch');function render(){let q=(search.value||'').toLowerCase();tbody.innerHTML=data.map((c,i)=>({c,i})).filter(x=>JSON.stringify(x.c).toLowerCase().includes(q)).map(x=>`<tr><td>${esc(x.c.document)}</td><td>${esc(x.c.name)}</td><td>${esc(x.c.plate)}</td><td>${esc(x.c.phone)}</td><td>${esc(x.c.email)}</td><td>${x.c.active?'Activo':'Inactivo'}</td><td><button class="btn btn-sm btn-warning editClient" data-i="${x.i}">Editar</button> <button class="btn btn-sm btn-danger delClient" data-i="${x.i}">Eliminar</button></td></tr>`).join('');tbody.querySelectorAll('.editClient').forEach(b=>b.onclick=()=>{let c=data[+b.dataset.i];['document','name','plate','phone','email','address','notes'].forEach(k=>{if(f.elements[k])f.elements[k].value=c[k]||''});f.elements.active.checked=c.active!==false;f.dataset.i=b.dataset.i});tbody.querySelectorAll('.delClient').forEach(b=>b.onclick=()=>{fpConfirm('¿Eliminar este cliente?',()=>{data.splice(+b.dataset.i,1);set(KEY.clients,data);render()},{danger:true,okText:'Eliminar'});})}render();search.oninput=()=>{payPage=1;render()};f.onsubmit=e=>{e.preventDefault();let c={document:f.document.value.trim(),name:f.name.value.trim(),plate:f.plate.value.trim().toUpperCase(),phone:f.phone.value.trim(),email:f.email.value.trim(),address:f.address.value.trim(),notes:f.notes.value.trim(),active:f.active.checked};if(!c.document||!c.name){fpAlert('Documento y nombre son obligatorios.');return}if(f.dataset.i!==undefined)data[+f.dataset.i]=c;else data.push(c);set(KEY.clients,data);delete f.dataset.i;f.reset();f.active.checked=true;render();fpAlert('Cliente guardado.')};document.getElementById('newClient').onclick=()=>{delete f.dataset.i;f.reset();f.active.checked=true}}



function initDashboard(){
 ensure();
 const render=()=>{let db=entries(),open=db.filter(e=>!e.salidaFecha),counts={Carro:0,Moto:0,Cicla:0};
 open.forEach(e=>{let id=String(e.idTarifa),key=id==='5'?'Carro':id==='6'?'Moto':id==='7'?'Cicla':(String(e.tarifaNombre||e.tipoVehiculo||'').toLowerCase().includes('moto')?'Moto':String(e.tarifaNombre||e.tipoVehiculo||'').toLowerCase().includes('cicla')?'Cicla':'Carro');counts[key]++});
 const map={dashCar:'Carro',dashMoto:'Moto',dashCicla:'Cicla'};Object.keys(map).forEach(id=>{let node=document.getElementById(id);if(node)node.textContent=counts[map[id]]||0});
  let today0=new Date();today0.setHours(0,0,0,0);
 // Mensualidades a mostrar en el dashboard: (1) activas en mora dentro de los 3 días de gracia (días<0), que vencen hoy (días=0) o próximas a vencer (1 a 6 días);
 // (2) las ya vencidas más allá de la gracia, que la app desactiva sola: se siguen mostrando con sus días de mora, sin límite de días, hasta que se renueven, se editen o se eliminen.
 activateDueAdvancePeriods();deactivateExpiredMonthlies();
 const monthlyAll=get('fp_monthly',[]).filter(m=>m&&m.end);
 const toDays=m=>{let end=new Date(String(m.end)+'T00:00:00');end.setHours(0,0,0,0);return Math.round((end-today0)/86400000)};
 let soonMonthly=monthlyAll.filter(m=>m.active&&!m.pendingConfirmation&&!m.nextPeriod).map(m=>({m,days:toDays(m)})).filter(x=>!isNaN(x.days)&&x.days<=6);
 // Un registro vencido no cuenta como mora si esa misma placa ya tiene otra mensualidad activa o por confirmar
 // (el cliente volvió y se registró de nuevo); y si una placa tiene varios registros vencidos, se muestra el más reciente.
 const livePlates=new Set(monthlyAll.filter(m=>m.active||m.pendingConfirmation).map(m=>normPlateKey(m.plate)).filter(Boolean));
 const lapsed=new Map();
 monthlyAll.forEach((m,i)=>{if(m.active||m.pendingConfirmation||m.nextPeriod)return;const days=toDays(m);if(isNaN(days)||days>=0)return;const k=normPlateKey(m.plate)||('i'+i);if(livePlates.has(k))return;const prev=lapsed.get(k);if(!prev||days>prev.days)lapsed.set(k,{m,days})});
 soonMonthly=soonMonthly.concat(Array.from(lapsed.values())).sort((a,b)=>a.days-b.days);
 // Color por urgencia: rojo = en mora (cualquier cantidad de días) o vence hoy (días<=0), amarillo = 1 a 3 días, verde = 4 a 6 días.
 function monthlySoonBadge(days){
   if(days<=0) return {bg:'rgba(216,74,58,.14)',fg:'#d84a3a',label:days<0?('Mora ('+Math.abs(days)+' d)'):'Vence hoy'};
   if(days<=3) return {bg:'rgba(255,159,0,.16)',fg:'#c97600',label:days+' día'+(days===1?'':'s')};
   return {bg:'rgba(31,122,77,.14)',fg:'#1f7a4d',label:days+' día'+(days===1?'':'s')};
 }
 let msBody=document.getElementById('dashMonthlySoonBody');if(msBody)msBody.innerHTML=soonMonthly.map(x=>{let b=monthlySoonBadge(x.days);return `<tr style="background:${b.bg} !important"><td>${esc(String(x.m.plate||'').toUpperCase())}</td><td>${esc(x.m.name||'')}</td><td>${esc(x.m.vehicle||'')}</td><td>${esc(fmtDateEs(x.m.end))}</td><td><span style="display:inline-block;padding:3px 10px;border-radius:12px;font-weight:700;font-size:12px;background:${b.bg};color:${b.fg} !important">${esc(b.label)}</span></td></tr>`}).join('')||'<tr><td colspan="5">No hay mensualidades en mora ni próximas a vencer.</td></tr>'};
 render();window.addEventListener('storage',render);if(!window.__fpDashTimer)window.__fpDashTimer=setInterval(()=>{if(!document.hidden)render()},30000);document.addEventListener('visibilitychange',()=>{if(!document.hidden)render()});
}
function initPayments(){
 let f=document.getElementById('salesFilter'),tb=document.querySelector('#paymentsTable tbody'),total=document.getElementById('boxTotal'),pager=document.getElementById('salesPager');let page=1,pageSize=10,allRows=[];
 function paymentType(e){let m=String(e.paymentMethod||e.idTipoPago||'').trim().toLowerCase();if(m==='cash'||m==='efectivo'||m==='2')return 'efectivo';if(m==='nequi'||m==='electronico'||m==='electrónico'||m==='electronic'||m==='3')return 'nequi';if(m==='both'||m==='ambos'||m==='mixto'||m==='mixed')return 'both';return ''}
 
 function render(){
   // Una salida vinculada a mensualidad que aún no se ha confirmado en Pendientes no es
   // todavía una venta: no debe sumar aquí hasta que se confirme el pago.
   // Los pagos de mensualidades tampoco se listan aquí ni suman al total de Ventas:
   // esta página solo muestra ventas de parqueadero (entradas/salidas). Los pagos de
   // mensualidades tienen su propio reporte (ver Mensualidades).
   let db=entriesFull().filter(e=>e.salidaFecha && !e.pendingMonthlyConfirmation && !e.isMonthly);
   let from=f.from.value?new Date(f.from.value+'T00:00:00'):new Date('2000-01-01');
   let to=f.to.value?new Date(f.to.value+'T23:59:59'):new Date('2999-12-31');
   let q=f.payment.value;
   allRows=db.filter(e=>{
     let d=parseFPDate(e.salidaFecha),p=paymentType(e);
     return d&&d>=from&&d<=to&&(!q||p===q);
   }).sort((a,b)=>(parseFPDate(b.salidaFecha)||0)-(parseFPDate(a.salidaFecha)||0));
   let pages=Math.max(1,Math.ceil(allRows.length/pageSize));if(page>pages)page=pages;
   let rows=allRows.slice((page-1)*pageSize,page*pageSize);
   tb.innerHTML=rows.map((e,i)=>`<tr><td>${esc(e.reciboPrefijo||'FA')}${esc(e.reciboNumero||'')}</td><td>${esc(e.placa||e.plate||'')}</td><td>${esc(e.entradaFecha)}</td><td>${esc(e.salidaFecha)}</td><td>${esc(paymentLabel(e))}</td><td${(+e.discountAmount>0)?' style="color:#e53935;font-weight:700" title="Venta con descuento aplicado"':''}>${money(e.total)}</td><td>${money(e.cashAmount||0)}</td><td>${money(e.nequiAmount||0)}</td><td><button type="button" class="btn btn-sm btn-warning printSale" data-i="${i}" title="Imprimir recibo" aria-label="Imprimir recibo"><svg class="fp-print-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9V3h12v6M6 18H4a2 2 0 0 1-2-2v5a2 2 0 0 1 2 2h2M6 14h12v7H6z"/></svg></button><button type="button" class="btn btn-sm editSale" data-i="${i}" title="Editar forma de pago" aria-label="Editar forma de pago"><i class="fa fa-pencil"></i></button></td></tr>`).join('')||'<tr><td colspan="9">Sin movimientos para el filtro seleccionado.</td></tr>';
   total.textContent=money(allRows.reduce((a,e)=>a+(+e.total||0),0));
   tb.querySelectorAll('.printSale').forEach(b=>b.onclick=()=>printSaleReceipt(rows[+b.dataset.i]));
   tb.querySelectorAll('.editSale').forEach(b=>b.onclick=()=>openEditSalePayment(rows[+b.dataset.i]));
   if(pager){
     pager.innerHTML=`<button type="button" class="btn btn-sm btn-default" id="salesPrev" ${page<=1?'disabled':''}>Anterior</button> <span style="display:inline-block;margin:0 12px;line-height:32px">Página ${page} de ${pages} · ${allRows.length} ventas</span> <button type="button" class="btn btn-sm btn-default" id="salesNext" ${page>=pages?'disabled':''}>Siguiente</button>`;
     let pv=document.getElementById('salesPrev'),nx=document.getElementById('salesNext');
     if(pv)pv.onclick=()=>{if(page>1){page--;render()}};
     if(nx)nx.onclick=()=>{if(page<pages){page++;render()}};
   }
   return {rows:allRows,sum:allRows.reduce((a,e)=>a+(+e.total||0),0)}
 }

 function updateEntryPayment(id,pm,cashAmount,nequiAmount){
   const idStr=String(id);
   ['fp_entries',ARCHIVE_KEY].forEach(k=>{
     const arr=get(k,[]);
     if(!Array.isArray(arr)||!arr.length)return;
     let changed=false;
     const updated=arr.map(e=>{
       if(e&&String(e.id)===idStr){
         changed=true;
         return Object.assign({},e,{paymentMethod:pm,idTipoPago:pm,cashAmount:Math.round(cashAmount),nequiAmount:Math.round(nequiAmount)});
       }
       return e;
     });
     if(changed)set(k,updated);
   });
 }

 function openEditSalePayment(entry){
   if(!entry||entry.id==null){fpAlert('No fue posible identificar esta venta.');return;}
   const overlay=document.getElementById('editSaleOverlay');
   if(!overlay){
     const method=prompt('Forma de pago: efectivo, electronico o ambos', paymentType(entry)||'efectivo');
     if(method===null)return;
     const pmIn=method.trim().toLowerCase();
     let pm; if(['efectivo','cash'].includes(pmIn))pm='cash'; else if(['electronico','electrónico','nequi'].includes(pmIn))pm='nequi'; else if(['ambos','both'].includes(pmIn))pm='both'; else {fpAlert('Forma de pago no válida.');return;}
     const totalVal=Number(entry.total)||0;
     let cashAmount=0,nequiAmount=0;
     if(pm==='cash')cashAmount=totalVal; else if(pm==='nequi')nequiAmount=totalVal; else {cashAmount=+(prompt('¿Cuánto en efectivo?','0')||0); if(!Number.isFinite(cashAmount)||cashAmount<0||cashAmount>totalVal){fpAlert('Valor de efectivo no válido.');return;} nequiAmount=totalVal-cashAmount;}
     updateEntryPayment(entry.id,pm,cashAmount,nequiAmount);
     render();
     return;
   }
   const total=Number(entry.total)||0;
   const state={method:paymentType(entry)==='nequi'?'nequi':(paymentType(entry)==='both'?'both':'cash'),cash:Number(entry.cashAmount)||0};
   document.getElementById('editSaleReceipt').textContent=(entry.reciboPrefijo||'FA')+String(entry.reciboNumero||'');
   document.getElementById('editSalePlate').textContent=plateUpper(entry.placa||'');
   document.getElementById('editSaleTotal').textContent=money(total);
   const msg=document.getElementById('editSaleMsg'); msg.style.display='none'; msg.textContent='';
   const cashInput=document.getElementById('editSaleCash'), nequiInput=document.getElementById('editSaleNequi'), amountsBox=document.getElementById('editSaleAmounts');
   const methodBtns=overlay.querySelectorAll('[data-edit-method]');

   function applyMethod(m){
     state.method=m;
     methodBtns.forEach(b=>b.classList.toggle('active',b.dataset.editMethod===m));
     if(m==='cash'){cashInput.value=total;cashInput.readOnly=true;nequiInput.value=0;amountsBox.style.display='';}
     else if(m==='nequi'){cashInput.value=0;cashInput.readOnly=true;nequiInput.value=total;amountsBox.style.display='';}
     else {cashInput.readOnly=false;let c=state.cash>0&&state.cash<=total?state.cash:0;cashInput.value=c;nequiInput.value=Math.max(0,total-c);amountsBox.style.display='';}
   }
   methodBtns.forEach(b=>b.onclick=()=>applyMethod(b.dataset.editMethod));
   cashInput.oninput=()=>{if(state.method!=='both')return;let c=Number(cashInput.value)||0;if(c<0)c=0;if(c>total)c=total;state.cash=c;nequiInput.value=Math.max(0,total-c)};
   applyMethod(state.method);

   function close(){overlay.style.display='none'}
   document.getElementById('editSaleCloseBtn').onclick=close;
   document.getElementById('editSaleCancelBtn').onclick=close;
   document.getElementById('editSaleSaveBtn').onclick=()=>{
     let cashAmount=0,nequiAmount=0;
     if(state.method==='cash')cashAmount=total;
     else if(state.method==='nequi')nequiAmount=total;
     else {
       cashAmount=Number(cashInput.value)||0;
       if(cashAmount<=0||cashAmount>=total){msg.textContent='Ingrese un valor de efectivo válido (mayor a 0 y menor al total).';msg.style.display='block';return;}
       nequiAmount=total-cashAmount;
     }
     updateEntryPayment(entry.id,state.method,cashAmount,nequiAmount);
     close();
     render();
   };
   overlay.style.display='flex';
 }

 if(f)f.onsubmit=e=>{e.preventDefault();page=1;render()};window.addEventListener('storage',()=>render());render()
}

function fpAddMonthsClamped(date,months){
  const d=new Date(date.getTime()), day=d.getDate();
  d.setDate(1); d.setMonth(d.getMonth()+months);
  const last=new Date(d.getFullYear(),d.getMonth()+1,0).getDate();
  d.setDate(Math.min(day,last));
  return d;
}
function fpCalendarElapsed(start,end){
  let months=Math.max(0,(end.getFullYear()-start.getFullYear())*12+(end.getMonth()-start.getMonth()));
  let cursor=fpAddMonthsClamped(start,months);
  if(cursor>end){months=Math.max(0,months-1);cursor=fpAddMonthsClamped(start,months);}
  let ms=Math.max(0,end-cursor);
  const dayMs=86400000,hourMs=3600000,minMs=60000;
  const days=Math.floor(ms/dayMs); ms-=days*dayMs;
  const hours=Math.floor(ms/hourMs); ms-=hours*hourMs;
  const mins=Math.floor(ms/minMs);
  return {months,days,hours,mins};
}
function formatReceiptDuration(r){
  let mes=r.mes,dia=r.dia,hora=r.hora,min=r.min;
  if(mes==null||dia==null||hora==null||min==null){
    const start=parseFPDate(r.entradaFecha), end=parseFPDate(r.salidaFecha)||new Date();
    if(start&&end&&end>=start){const cal=fpCalendarElapsed(start,end); mes=cal.months;dia=cal.days;hora=cal.hours;min=cal.mins;}
    else {mes=mes||0;dia=dia||0;hora=hora||0;min=min||0;}
  }
  const parts=[];
  if(Number(mes||0)) parts.push(`${mes} ${Number(mes)===1?'MES':'MESES'}`);
  if(Number(dia||0)) parts.push(`${dia} ${Number(dia)===1?'DÍA':'DÍAS'}`);
  if(Number(hora||0)) parts.push(`${hora} ${Number(hora)===1?'HORA':'HORAS'}`);
  if(Number(min||0)) parts.push(`${min} MIN`);
  return parts.join(' ')||'0 MIN';
}
function formatReceiptDateTime(v){
  const s=String(v??'').trim();
  if(!s) return '';
  const m=s.match(/^(\d{2})-(\d{2})-(\d{4})[\sT]+(\d{2}):(\d{2})(?::\d{2})?/);
  if(m) return `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}`;
  const iso=s.match(/^(\d{4})-(\d{2})-(\d{2})[T\s](\d{2}):(\d{2})(?::\d{2})?/);
  if(iso) return `${iso[3]}-${iso[2]}-${iso[1]} ${iso[4]}:${iso[5]}`;
  const d=new Date(s);
  if(!isNaN(d.getTime())){
    const pad=n=>String(n).padStart(2,'0');
    return `${pad(d.getDate())}-${pad(d.getMonth()+1)}-${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  // Seguro final: si ninguno de los formatos anteriores hizo match (p.ej. una fecha
  // guardada en un formato inesperado), igual se recortan los segundos antes de
  // imprimir, para que nunca se cuelen "HH:MM:SS" en el recibo de Ventas.
  return s.replace(/(\d{1,2}:\d{2}):\d{2}(\b|$)/, '$1$2');
}
function printSaleReceipt(e){
 try{
  if(!e)return;
  if(e.isMonthly){
    const m={plate:e.plate,value:e.value||e.total,name:e.client||e.clientName||e.customerName||'',document:e.document||'',vehicle:e.vehicle||'',start:e.periodStart||e.start||e.startDate||'',end:e.periodEnd||e.end||e.endDate||''};
    printMonthlyReceipt(m,e); return;
  }
  const c=get(KEY.config,defaults.config)||{};
  const isExit=!!e.salidaFecha;
  const type=isExit?'exit':'entry';
  /* vis()/L() leen exactamente las mismas claves (entryShowX/exitShowX,
   * entryLabelX/exitLabelX) que usa la vista previa de Configuración >
   * Edición completa de recibos (buildReceiptPreviewHTML) y el recibo en
   * vivo de Entradas/Salidas (applyReceiptConfig en ParkApp.html), para
   * que lo impreso desde Ventas coincida siempre con lo configurado. */
  const vis=(key,def=true)=>{const v=c[type+key];return v===undefined?def:!!v};
  const L=(key,def)=>String(c[type+key]??def);
  const business=c.razon_social||c.parkingName||'FACAPARKING', nit=c.receiptNit??c.nit??'', phone=c.receiptPhone??c.telefonos??c.phone??'', address=c.receiptAddress??c.direccion1??c.address??'';
  const receipt='FA'+String(e.reciboNumero||e.receiptNumber||'');
  const plate=plateUpper(e.placa||e.plate||'');
  const total=money(e.total||e.value||0), method=paymentLabel(e), cash=Number(e.cashAmount)||0, nequi=Number(e.nequiAmount)||0;
  const service=e.serviceName||e.nombreTarifa||e.tarifaNombre||e.service||e.servicio||e.descripcionServicio||'';
  const duration=formatReceiptDuration(e);
  const showHours=c.entryShowHours===undefined?true:!!c.entryShowHours;
  const hours=String(c.entryHoursText||'').replace(/^\s*Horario(?:s)? de atención:\s*/i,'').trim()||'Lunes a Miércoles:\n06:30 a 21:30\nJueves a Sábado:\n06:30 a 23:00\nDomingos y Festivos:\n06:30 a 19:00';
  const escP=x=>String(x??'').replace(/[&<>]/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[m]));
  const row=(visible,label,val,cls='')=>visible&&String(val||'').trim()?`<div class="row ${cls}"><b>${escP(label)}</b><span>${escP(val)}</span></div>`:'';
  const free=(text)=>text?`<div class="row" style="justify-content:center"><span style="text-align:center;flex:none">${escP(text)}</span></div>`:'';
  // Seguro adicional: nunca imprimir segundos en Entrada/Salida, sin importar el formato guardado.
  const noSecs=s=>String(s||'').replace(/(\d{1,2}:\d{2}):\d{2}(\b|$)/,'$1$2');
  const customMessage=String(c.customMessage||'').trim(), additionalInfo=String(c.additionalInfo||'').trim();
  let main=row(vis('ShowPlate'),L('LabelPlate','Placa'),plate,'arial')+row(vis('ShowEntry'),L('LabelEntry','Entrada'),noSecs(formatReceiptDateTime(e.entradaFecha)),'arial');
  if(isExit){
    main+=row(vis('ShowExit'),L('LabelExit','Salida'),noSecs(formatReceiptDateTime(e.salidaFecha)),'arial')
        +row(true,'Recibo',receipt,'receiptno arial')
        +row(vis('ShowService'),L('LabelService','Servicio'),service,'arial')
        +row(vis('ShowTime'),L('LabelTime','Tiempo'),duration,'arial')
        +row(vis('ShowTotal'),L('LabelTotal','Total'),total,'total arial')
        +row(vis('ShowPaymentMethod'),L('LabelPaymentMethod','Forma de pago'),method,'arial')
        +(vis('ShowPaymentMethod')&&method==='Efectivo + Electrónico'?row(true,'Efectivo',money(cash),'arial')+row(true,'Electrónico',money(nequi),'arial'):'');
  } else {
    main+=row(true,'Recibo',receipt,'receiptno arial');
  }
  main+=free(customMessage)+free(additionalInfo);
  const businessBlock=vis('ShowBusiness',true)?`<div class="business"><b>${escP(business)}</b>${nit?`<span class="bizinfo">${escP(L('LabelNit','NIT.'))} ${escP(nit)}</span>`:''}${phone?`<span class="bizinfo">${escP(L('LabelPhone','TEL.'))} ${escP(phone)}</span>`:''}${address?`<span class="bizinfo">${escP(L('LabelAddress','DIR.'))} ${escP(address)}</span>`:''}</div><div class="divider"></div>`:'';
  const hoursBlock=showHours?`<div class="divider hours-divider"></div><div class="hours"><div class="hours-title">HORARIOS DE ATENCIÓN</div>${escP(hours)}</div>`:'';
  const html=`<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Recibo ${escP(receipt)}</title><style>@page{size:50mm auto;margin:0}*{box-sizing:border-box}html,body{margin:0!important;padding:0!important;width:50mm;max-width:50mm;background:#fff;color:#000;-webkit-print-color-adjust:exact;print-color-adjust:exact}body{font-family:"Times New Roman",Times,serif;font-size:10.5px;line-height:1.18;font-weight:600}.receipt{width:48mm;max-width:48mm;margin:0 auto;padding:1mm 1.5mm;font-family:"Times New Roman",Times,serif;font-size:10.5px;line-height:1.18;font-weight:600;overflow:visible}.arial span{font-family:Arial,Helvetica,sans-serif!important;font-size:calc(1em - 1px)!important;font-weight:normal!important}.business{line-height:1.3;text-align:center;margin:0 0 4px;font-size:10.5px;font-weight:600;overflow:visible;word-break:normal;overflow-wrap:break-word}.business b{display:block;font-size:14px;font-weight:700;letter-spacing:.3px;margin-bottom:3px}.bizinfo{display:block;font-size:12.5px;font-weight:700;line-height:1.25}.divider{width:100%;border:0;border-top:1px dashed #000;height:0;margin:5px 0}.divider.hours-divider{margin:0 0 3px}.main{line-height:1.3;text-align:left;font-size:14px;font-weight:600}.hours{line-height:1.3;text-align:center;white-space:pre-line;padding:0;font-size:13px;font-weight:600}.hours-title{display:block;font-weight:700;font-size:13px;margin-bottom:3px}.row{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:baseline;width:100%;margin:0 0 2px;gap:1px 4px}.row b{font-weight:600;white-space:nowrap;flex:0 0 auto}.row span{margin-left:auto;text-align:right;white-space:normal;overflow-wrap:break-word;word-break:break-word;flex:1 1 auto;min-width:0}.row.total{margin-top:3px;padding-top:3px;border-top:1px dashed #000;font-size:12.5px}.row.total b,.row.total span{font-weight:700}.row.receiptno{margin-top:3px;padding-top:0;border-top:0}.row.receiptno span{margin-left:auto;flex:1 1 auto;text-align:right}</style></head><body><div class="receipt">${businessBlock}<div class="main">${main}</div>${hoursBlock}</div><script>window.onload=function(){window.print();setTimeout(function(){window.close()},300)};<\/script></body></html>`;
  const w=window.open('','_blank','width=420,height=700'); if(!w){fpAlert('El navegador bloqueó la ventana de impresión. Permita ventanas emergentes para FacaParking.','error');return;}
  w.document.open();w.document.write(html);w.document.close();
 }catch(err){console.error(err);fpAlert('No fue posible preparar el recibo para imprimir.');}
}

function initReports(){
 ensure();
 const fromEl=document.getElementById('reportFrom'), toEl=document.getElementById('reportTo');
 if(!fromEl||!toEl) return;

 function mapMonthly(list){return list.map(e=>({...e,total:Number(e.value)||0,cashAmount:Number(e.cashAmount)||0,nequiAmount:Number(e.nequiAmount)||0}))}
 function rangeDates(){
   const from=fromEl.value?startOfDay(new Date(fromEl.value+'T00:00:00')):null;
   const to=toEl.value?endOfDay(new Date(toEl.value+'T00:00:00')):null;
   return {from,to};
 }
 function within(d,from,to){if(!d)return false;if(from&&d<from)return false;if(to&&d>to)return false;return true}
 function periodLabel(from,to){
   if(!from&&!to) return 'Todo el historial';
   if(from&&to&&dayKey(from)===dayKey(to)) return dayLabel(from)+'/'+from.getFullYear();
   return (from?dayLabel(from)+'/'+from.getFullYear():'…')+' — '+(to?dayLabel(to)+'/'+to.getFullYear():'…');
 }

 function render(){
   const {from,to}=rangeDates();
   const allEntries=entriesFull();
   const vehiculos=allEntries.filter(e=>within(parseFPDate(e.entradaFecha),from,to));
   const parkSales=allEntries.filter(e=>e.salidaFecha&&!e.pendingMonthlyConfirmation&&within(parseFPDate(e.salidaFecha),from,to));
   // Los pagos de mensualidades no se incluyen en el panel general de Reportes (Ingresos,
   // gráfica, formas de pago): tienen su propio reporte en Mensualidades ("Reporte de
   // mensualidades"). Se deja el arreglo vacío en vez de borrar cada uso de "monthly" abajo,
   // para que KPIs, gráfica y desglose de formas de pago queden en cero automáticamente.
   const monthly=[];
   const expensesArr=get('fp_expenses',[]).filter(e=>within(parseFPDate(e.dateTime),from,to));
   const incomesArr=get('fp_incomes',[]).filter(e=>within(parseFPDate(e.dateTime),from,to));
   const closuresArr=get('fp_cash_closings',[]).filter(e=>within(parseFPDate(e.closedAt),from,to)).sort((a,b)=>new Date(a.closedAt)-new Date(b.closedAt));

   const ventasTotal=parkSales.reduce((a,x)=>a+(Number(x.total)||0),0);
   const mensualidadesTotal=monthly.reduce((a,x)=>a+(Number(x.total)||0),0);
   const ingresosManualesTotal=incomesArr.reduce((a,x)=>a+(Number(x.amount)||0),0);
   const ingresos=ventasTotal+mensualidadesTotal+ingresosManualesTotal;
   const egresos=expensesArr.reduce((a,x)=>a+(Number(x.amount)||0),0);
   const ganancia=ingresos-egresos;

   FPView.text('kpiVehicles',vehiculos.length);
   FPView.text('kpiIngresos',money(ingresos));
   FPView.text('kpiEgresos',money(egresos));
   const gEl=document.getElementById('kpiGanancia');
   if(gEl){gEl.textContent=money(ganancia);gEl.style.color=ganancia<0?'#ff6b6b':'';}
   const periodEl=document.getElementById('reportPeriodLabel'); if(periodEl) periodEl.textContent=periodLabel(from,to);

   const allSales=parkSales.concat(monthly);
   let cash=0,electronic=0,unknown=0;
   allSales.forEach(x=>{
     const label=paymentLabel(x), total=Number(x.total)||0;
     if(label==='Efectivo') cash+=total;
     else if(label==='Electrónico') electronic+=total;
     else if(label==='Efectivo + Electrónico'){const c=Number(x.cashAmount)||0;cash+=c;electronic+=Math.max(total-c,0);}
     else unknown+=total;
   });
   const methodTotal=Math.max(cash+electronic+unknown,1);
   const setBar=(id,val)=>{const el=document.getElementById(id); if(el) el.style.width=Math.round(val/methodTotal*100)+'%';};
   FPView.text('paymentCashAmount',money(cash));
   FPView.text('paymentElectronicAmount',money(electronic));
   const unknownRow=document.getElementById('paymentUnknownRow');
   if(unknownRow) unknownRow.style.display=unknown>0?'block':'none';
   FPView.text('paymentUnknownAmount',money(unknown));
   setBar('paymentCashBar',cash); setBar('paymentElectronicBar',electronic); setBar('paymentUnknownBar',unknown);

   // La gráfica se agrupa según el período elegido:
   // Hoy = horas, Semana/Mes = días, Año/Total = meses.
   // Los datos siguen conservando el detalle diario en el snapshot/exportación.
   const selectedMode=window.__fpReportMode||'week';
   const dayMap=new Map();
   function ensureDay(d){const k=dayKey(d); if(!dayMap.has(k)) dayMap.set(k,{date:new Date(d.getFullYear(),d.getMonth(),d.getDate()),ingresos:0,egresos:0,vehiculos:0}); return dayMap.get(k)}
   parkSales.forEach(x=>{const d=parseFPDate(x.salidaFecha); if(d) ensureDay(d).ingresos+=Number(x.total)||0});
   monthly.forEach(x=>{const d=parseFPDate(x.dateTime); if(d) ensureDay(d).ingresos+=Number(x.total)||0});
   incomesArr.forEach(x=>{const d=parseFPDate(x.dateTime); if(d) ensureDay(d).ingresos+=Number(x.amount)||0});
   expensesArr.forEach(x=>{const d=parseFPDate(x.dateTime); if(d) ensureDay(d).egresos+=Number(x.amount)||0});
   vehiculos.forEach(x=>{const d=parseFPDate(x.entradaFecha); if(d) ensureDay(d).vehiculos+=1});

   const rangeSpanDays=(from&&to)?Math.round((startOfDay(to)-startOfDay(from))/86400000)+1:null;
   function makeDays(){
     if(rangeSpanDays!=null&&rangeSpanDays>0&&rangeSpanDays<=3660){
       return Array.from({length:rangeSpanDays},(_,i)=>{
         const d=new Date(from.getFullYear(),from.getMonth(),from.getDate()+i);
         const found=dayMap.get(dayKey(d));
         return found?{...found,date:d}:{date:d,ingresos:0,egresos:0,vehiculos:0};
       });
     }
     const arr=Array.from(dayMap.values()).sort((a,b)=>a.date-b.date);
     if(arr.length) return arr;
     const today=startOfDay(new Date());
     return Array.from({length:7},(_,i)=>{const d=new Date(today);d.setDate(d.getDate()-(6-i));return {date:d,ingresos:0,egresos:0,vehiculos:0}});
   }
   const days=makeDays();

   function hourLabel(h){return pad2(h)+':00';}
   // Hora en la que se abrió la caja para un día concreto: busca entre los cierres de caja
   // (fp_cash_closings) y, si la caja sigue abierta ahora mismo, también en fp_cash_register,
   // y toma la más temprana de las aperturas que ocurrieron ese día. Si no hay ninguna apertura
   // registrada ese día, se usa 00:00 (se muestra el día completo, como antes).
   function dayOpenHour(dayDate){
     if(!dayDate) return 0;
     const key=dayKey(dayDate); let candidates=[];
     (get('fp_cash_closings',[])||[]).forEach(c=>{const d=parseFPDate(c.openedAt); if(d&&dayKey(d)===key) candidates.push(d);});
     const openReg=get('fp_cash_register',null);
     if(openReg){const d=parseFPDate(openReg.openedAt); if(d&&dayKey(d)===key) candidates.push(d);}
     if(!candidates.length) return 0;
     return candidates.reduce((a,b)=>a<b?a:b).getHours();
   }
   function buildHourly(startHour){
     startHour=Math.max(0,Math.min(23,startHour||0));
     const hours=Array.from({length:24-startHour},(_,i)=>{const h=startHour+i;return {hour:h,label:hourLabel(h),ingresos:0,egresos:0,vehiculos:0}});
     const idx=h=>h-startHour;
     parkSales.forEach(x=>{const d=parseFPDate(x.salidaFecha);if(d&&d.getHours()>=startHour)hours[idx(d.getHours())].ingresos+=Number(x.total)||0});
     monthly.forEach(x=>{const d=parseFPDate(x.dateTime);if(d&&d.getHours()>=startHour)hours[idx(d.getHours())].ingresos+=Number(x.total)||0});
     incomesArr.forEach(x=>{const d=parseFPDate(x.dateTime);if(d&&d.getHours()>=startHour)hours[idx(d.getHours())].ingresos+=Number(x.amount)||0});
     expensesArr.forEach(x=>{const d=parseFPDate(x.dateTime);if(d&&d.getHours()>=startHour)hours[idx(d.getHours())].egresos+=Number(x.amount)||0});
     vehiculos.forEach(x=>{const d=parseFPDate(x.entradaFecha);if(d&&d.getHours()>=startHour)hours[idx(d.getHours())].vehiculos+=1});
     return hours;
   }
   function monthKey(d){return d.getFullYear()+'-'+pad2(d.getMonth()+1)}
   function monthLabel(d){return ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'][d.getMonth()]+'/'+String(d.getFullYear()).slice(-2)}
   function buildMonthly(){
     const map=new Map();
     const add=(d,field,val)=>{if(!d)return;const k=monthKey(d);if(!map.has(k))map.set(k,{date:new Date(d.getFullYear(),d.getMonth(),1),ingresos:0,egresos:0,vehiculos:0});map.get(k)[field]+=val};
     parkSales.forEach(x=>{const d=parseFPDate(x.salidaFecha);add(d,'ingresos',Number(x.total)||0)});
     monthly.forEach(x=>{const d=parseFPDate(x.dateTime);add(d,'ingresos',Number(x.total)||0)});
     incomesArr.forEach(x=>{const d=parseFPDate(x.dateTime);add(d,'ingresos',Number(x.amount)||0)});
     expensesArr.forEach(x=>{const d=parseFPDate(x.dateTime);add(d,'egresos',Number(x.amount)||0)});
     vehiculos.forEach(x=>{const d=parseFPDate(x.entradaFecha);add(d,'vehiculos',1)});
     if(from&&to){
       const out=[];let d=new Date(from.getFullYear(),from.getMonth(),1);const last=new Date(to.getFullYear(),to.getMonth(),1);
       while(d<=last){const k=monthKey(d),found=map.get(k);out.push(found?{...found,date:new Date(d)}:{date:new Date(d),ingresos:0,egresos:0,vehiculos:0});d.setMonth(d.getMonth()+1)}
       return out;
     }
     return Array.from(map.values()).sort((a,b)=>a.date-b.date);
   }

   let chartData, labels, chartMode;
   const singleDay=selectedMode==='today' || rangeSpanDays===1;
   if(singleDay){
     const dayForOpen=from||new Date();
     chartData=buildHourly(dayOpenHour(dayForOpen)); labels=chartData.map(x=>x.label); chartMode='hora';
   }else if(selectedMode==='year'||selectedMode==='all'){
     chartData=buildMonthly(); labels=chartData.map(x=>monthLabel(x.date)); chartMode='mes';
   }else{
     chartData=days; labels=chartData.map(x=>dayLabel(x.date)); chartMode='día';
   }

   drawLineChart('reportDailyChart',labels,[
     {name:'Ingresos',color:'#33c17a',values:chartData.map(d=>d.ingresos)},
     {name:'Egresos',color:'#e0554a',values:chartData.map(d=>d.egresos)}
   ],{formatY:v=>'$'+Math.round(v/1000)+'k'});
   drawLineChart('reportVehiclesChart',labels,[
     {name:'Vehículos',color:'#3aa0ff',values:chartData.map(d=>d.vehiculos)}
   ],{formatY:v=>String(Math.round(v))});

   const cfg=get(KEY.config,defaults.config)||{}, rp=cfg.receiptPrefix||'FA';
   const tb=document.querySelector('#reportClosingsTable tbody');
   if(tb){
     tb.innerHTML=closuresArr.slice().reverse().map(c=>`<tr><td>${fmt24(c.openedAt)}</td><td>${fmt24(c.closedAt)}</td><td>${esc(c.closedBy)}</td><td>${money(c.totalSales)}</td><td>${money(c.totalEgresos)}</td><td>${money(c.expectedCash)}</td><td>${money(c.physicalCash)}</td><td>${money(c.difference)}</td><td>${c.receiptStart?rp+c.receiptStart:'—'}</td><td>${c.receiptEnd?rp+c.receiptEnd:'—'}</td><td>${esc(c.status)}</td><td><button type="button" class="btn btn-sm btn-info viewClosing" data-id="${esc(c.id)}">Ver reporte</button> <button type="button" class="btn btn-sm btn-success downloadClosing" data-id="${esc(c.id)}" title="Descargar reporte"><i class="fa fa-download"></i></button></td></tr>`).join('')||'<tr><td colspan="12">No hay cierres en este período.</td></tr>';
     tb.querySelectorAll('.viewClosing').forEach(b=>b.onclick=()=>{const item=closuresArr.find(x=>String(x.id)===String(b.dataset.id)); if(item) showClosingDetail(item)});
     tb.querySelectorAll('.downloadClosing').forEach(b=>b.onclick=()=>{const item=closuresArr.find(x=>String(x.id)===String(b.dataset.id)); if(item) downloadClosingDetail(item)});
   }

   window.__fpReportSnapshot={
     periodLabel:periodLabel(from,to),
     vehicles:vehiculos.length, ingresos, egresos, ganancia, cash, electronic, unknown,
     days:days.map(d=>({label:dayLabel(d.date)+'/'+d.date.getFullYear(),ingresos:d.ingresos,egresos:d.egresos,vehiculos:d.vehiculos})),
     closures:closuresArr
   };
 }

 function setRange(fromDate,toDate,mode){window.__fpReportMode=mode||'custom';fromEl.value=fromDate?ymdInput(fromDate):'';toEl.value=toDate?ymdInput(toDate):'';render()}
 function earliestDate(){
   let min=null;
   const consider=v=>{const d=parseFPDate(v); if(d&&(!min||d<min)) min=d;};
   entriesFull().forEach(e=>{consider(e.entradaFecha); consider(e.salidaFecha);});
   get('fp_monthly_payments',[]).forEach(e=>consider(e.dateTime));
   get('fp_expenses',[]).forEach(e=>consider(e.dateTime));
   get('fp_incomes',[]).forEach(e=>consider(e.dateTime));
   get('fp_cash_closings',[]).forEach(e=>consider(e.closedAt));
   return min;
 }

 const todayBtn=document.getElementById('reportQuickToday'), weekBtn=document.getElementById('reportQuickWeek'), monthBtn=document.getElementById('reportQuickMonth'), yearBtn=document.getElementById('reportQuickYear'), allBtn=document.getElementById('reportQuickAll');
 if(todayBtn) todayBtn.onclick=()=>{const t=new Date(); setRange(t,t,'today')};
 if(weekBtn) weekBtn.onclick=()=>{const t=new Date(); const day=(t.getDay()+6)%7; const monday=new Date(t); monday.setDate(t.getDate()-day); setRange(monday,t,'week')};
 if(monthBtn) monthBtn.onclick=()=>{const t=new Date(); const first=new Date(t.getFullYear(),t.getMonth(),1); setRange(first,t,'month')};
 if(yearBtn) yearBtn.onclick=()=>{const t=new Date(); const first=new Date(t.getFullYear(),0,1); setRange(first,t,'year')};
 if(allBtn) allBtn.onclick=()=>{const t=new Date(); const first=earliestDate()||t; setRange(first,t,'all')};
 /* Al cambiar Desde/Hasta a mano el rango deja de ser el de un botón rápido: se pasa a modo
  * 'custom' para que la gráfica (horas/días/meses) siga el rango elegido y no el botón anterior.
  * Cambiar .value por código (setRange) no dispara 'change', así que no hay bucle. */
 [fromEl,toEl].forEach(el=>{el.addEventListener('change',()=>{window.__fpReportMode='custom';render()})});
 const refreshBtn=document.getElementById('reportRefresh'); if(refreshBtn) refreshBtn.onclick=render;
 const excelBtn=document.getElementById('reportExportExcel'); if(excelBtn) excelBtn.onclick=exportReportExcel;
 const pdfBtn=document.getElementById('reportExportPdf'); if(pdfBtn) pdfBtn.onclick=printReport;
 const printBtn=document.getElementById('reportPrint'); if(printBtn) printBtn.onclick=printReport;

 window.addEventListener('resize',debounceReportRender);
 window.__fpReportRender=render;

 if(!fromEl.value&&!toEl.value&&weekBtn) weekBtn.click(); else render();
}
let __reportResizeTimer=null;
function debounceReportRender(){clearTimeout(__reportResizeTimer);__reportResizeTimer=setTimeout(()=>{if(document.body.dataset.module==='reports'&&window.__fpReportRender) window.__fpReportRender()},200)}
function ymdNow(){const d=new Date(); return d.getFullYear()+pad2(d.getMonth()+1)+pad2(d.getDate())+'_'+pad2(d.getHours())+pad2(d.getMinutes())}
function exportReportExcel(){
 const d=window.__fpReportSnapshot; if(!d){fpAlert('Actualice el reporte antes de exportar.');return}
 const cfg=get(KEY.config,defaults.config)||{}, rp=cfg.receiptPrefix||'FA';
 let html='<html><head><meta charset="utf-8"></head><body>';
 html+='<table border="1"><tr><td colspan="2"><b>Reporte Nexo.app'+(cfg.parkingName||cfg.razon_social?(' - '+esc(cfg.parkingName||cfg.razon_social)):'')+'</b></td></tr>';
 html+='<tr><td>Período</td><td>'+esc(d.periodLabel)+'</td></tr>';
 html+='<tr><td>Vehículos</td><td>'+d.vehicles+'</td></tr>';
 html+='<tr><td>Ingresos</td><td>'+money(d.ingresos)+'</td></tr>';
 html+='<tr><td>Egresos</td><td>'+money(d.egresos)+'</td></tr>';
 html+='<tr><td>Ganancia neta</td><td>'+money(d.ganancia)+'</td></tr>';
 html+='<tr><td>Efectivo</td><td>'+money(d.cash)+'</td></tr>';
 html+='<tr><td>Electrónico</td><td>'+money(d.electronic)+'</td></tr>';
 if(d.unknown>0) html+='<tr><td>Sin método</td><td>'+money(d.unknown)+'</td></tr>';
 html+='</table><br>';
 html+='<table border="1"><tr><th>Día</th><th>Ingresos</th><th>Egresos</th><th>Vehículos</th></tr>';
 d.days.forEach(x=>{html+='<tr><td>'+esc(x.label)+'</td><td>'+x.ingresos+'</td><td>'+x.egresos+'</td><td>'+x.vehiculos+'</td></tr>'});
 html+='</table><br>';
 html+='<table border="1"><tr><th>Apertura</th><th>Cierre</th><th>Usuario</th><th>Ventas</th><th>Egresos</th><th>Esperado</th><th>Contado</th><th>Diferencia</th><th>Recibo inicio</th><th>Recibo final</th><th>Estado</th></tr>';
 d.closures.forEach(c=>{html+='<tr><td>'+esc(fmt24(c.openedAt))+'</td><td>'+esc(fmt24(c.closedAt))+'</td><td>'+esc(c.closedBy)+'</td><td>'+(c.totalSales||0)+'</td><td>'+(c.totalEgresos||0)+'</td><td>'+(c.expectedCash||0)+'</td><td>'+(c.physicalCash||0)+'</td><td>'+(c.difference||0)+'</td><td>'+(c.receiptStart?rp+c.receiptStart:'')+'</td><td>'+(c.receiptEnd?rp+c.receiptEnd:'')+'</td><td>'+esc(c.status)+'</td></tr>'});
 html+='</table></body></html>';
 const blob=new Blob(['\ufeff',html],{type:'application/vnd.ms-excel'});
 const url=URL.createObjectURL(blob);
 const a=document.createElement('a'); a.href=url; a.download='reporte_facaparking_'+ymdNow()+'.xls'; document.body.appendChild(a); a.click();
 setTimeout(()=>{a.remove();URL.revokeObjectURL(url)},1500);
}
function printReport(){
 const d=window.__fpReportSnapshot; if(!d){fpAlert('Actualice el reporte antes de imprimir.');return}
 const cfg=get(KEY.config,defaults.config)||{};
 const dailyCanvas=document.getElementById('reportDailyChart'), vehCanvas=document.getElementById('reportVehiclesChart');
 const dailyImg=dailyCanvas&&dailyCanvas.toDataURL?dailyCanvas.toDataURL('image/png'):'';
 const vehImg=vehCanvas&&vehCanvas.toDataURL?vehCanvas.toDataURL('image/png'):'';
 const rows=d.closures.slice().reverse().map(c=>`<tr><td>${esc(fmt24(c.openedAt))}</td><td>${esc(fmt24(c.closedAt))}</td><td>${esc(c.closedBy)}</td><td>${money(c.totalSales)}</td><td>${money(c.totalEgresos)}</td><td>${money(c.expectedCash)}</td><td>${money(c.physicalCash)}</td><td>${money(c.difference)}</td><td>${esc(c.status)}</td></tr>`).join('')||'<tr><td colspan="9">Sin cierres en este período.</td></tr>';
 const html=`<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Reporte Nexo.app</title>
 <style>
 body{font-family:Arial,sans-serif;padding:24px;color:#222}
 h1{text-align:center;font-size:20px;margin:0 0 4px}
 .sub{text-align:center;color:#666;margin-bottom:18px;font-size:12px}
 .grid{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:18px}
 .box{border:1px solid #ddd;border-radius:6px;padding:10px}
 .box span{display:block;font-size:11px;color:#777}
 .box b{display:block;font-size:16px;margin-top:4px}
 h2{font-size:14px;border-bottom:1px solid #ccc;padding-bottom:4px;margin:20px 0 8px}
 table{width:100%;border-collapse:collapse;font-size:11px}
 th,td{border:1px solid #ddd;padding:5px;text-align:left}
 th{background:#f3f3f3}
 img{max-width:100%;border:1px solid #eee;border-radius:6px}
 </style></head><body>
 <h1>Reporte de operación — ${esc(cfg.parkingName||cfg.razon_social||'Nexo.app')}</h1>
 <div class="sub">Período: ${esc(d.periodLabel)} · Generado ${esc(fmt24(new Date()))}</div>
 <div class="grid">
   <div class="box"><span>Vehículos</span><b>${d.vehicles}</b></div>
   <div class="box"><span>Ingresos</span><b>${money(d.ingresos)}</b></div>
   <div class="box"><span>Egresos</span><b>${money(d.egresos)}</b></div>
   <div class="box"><span>Ganancia neta</span><b>${money(d.ganancia)}</b></div>
 </div>
 ${dailyImg?`<h2>Ingresos y egresos por día</h2><img src="${dailyImg}">`:''}
 ${vehImg?`<h2>Vehículos por día</h2><img src="${vehImg}">`:''}
 <h2>Métodos de pago</h2>
 <table><tr><th>Efectivo</th><th>Electrónico</th>${d.unknown>0?'<th>Sin método</th>':''}</tr><tr><td>${money(d.cash)}</td><td>${money(d.electronic)}</td>${d.unknown>0?'<td>'+money(d.unknown)+'</td>':''}</tr></table>
 <h2>Cierres de caja</h2>
 <table><tr><th>Apertura</th><th>Cierre</th><th>Usuario</th><th>Ventas</th><th>Egresos</th><th>Esperado</th><th>Contado</th><th>Diferencia</th><th>Estado</th></tr>${rows}</table>
 <script>window.onload=function(){window.print();};<\/script>
 </body></html>`;
 const w=window.open('','_blank','width=900,height=750');
 if(!w){fpAlert('El navegador bloqueó la ventana de impresión/PDF. Permita ventanas emergentes para Nexo.app.','error');return}
 w.document.open(); w.document.write(html); w.document.close();
}
function closingDetailData(c){
  const ps=entriesFull().filter(e=>e.salidaFecha && e.registerId===c.registerId);
  const ex=get('fp_expenses',[]).filter(x=>x.registerId===c.registerId);
  const inc=get('fp_incomes',[]).filter(x=>x.registerId===c.registerId);
  const bin=get('fp_base_in',[]).filter(x=>x&&x.registerId===c.registerId);
  const bout=get('fp_base_out',[]).filter(x=>x&&x.registerId===c.registerId);
  const cfg=get(KEY.config,defaults.config)||{};
  return {
    reg:{openedAt:c.openedAt,openedBy:c.openedBy,initialCash:c.initialCash},
    ps,ex,inc,bin,bout,
    baseAdded:c.baseAdded||0,baseRemoved:c.baseRemoved||0,baseFinal:c.baseFinal,
    totalPark:c.totalPark!=null?c.totalPark:ps.reduce((a,x)=>a+(+x.total||0),0),
    totalSales:c.totalSales!=null?c.totalSales:(c.totalPark!=null?c.totalPark:ps.reduce((a,x)=>a+(+x.total||0),0)),
    eg:c.totalEgresos,
    ig:c.totalIngresosManuales||0,
    salesElectronic:c.totalElectronic||0,
    physical:c.physicalCash,expected:c.expectedCash,diff:c.difference,
    receiptStart:c.receiptStart,receiptEnd:c.receiptEnd,receiptCount:c.receiptCount,
    receiptPrefix:cfg.receiptPrefix||'FA',
    closedAt:c.closedAt,closedBy:c.closedBy,
    status:c.status,observation:c.observation
  };
}
function showClosingDetail(c){
  showCashCloseSummary(closingDetailData(c));
}
function downloadClosingDetail(c){
  downloadCashCloseReport(closingDetailData(c));
}
function initConfigUsers(){
 ensure();
 let users=get(KEY.users,[]),f=document.getElementById('configUserForm'),tb=document.querySelector('#configUsersTable tbody');
 if(!f||!tb)return;
 /* Jerarquía de roles: Superadmin > Administrador > Empleado.
  * - El usuario "Felipe" es el Superadmin ORIGINAL / cuenta raíz del sistema:
  *   no se puede eliminar nunca, y solo puede editarse (datos, rol o
  *   contraseña) estando ya autenticado como el propio Felipe. Ningún otro
  *   Superadmin (aunque haya sido creado después) puede tocar esta cuenta.
  * - Solo un usuario con rol Superadmin puede crear OTROS Superadmin, y solo
  *   un Superadmin puede editar o eliminar cuentas que ya tengan ese rol
  *   (aparte de Felipe, que tiene su propio candado de arriba).
  * - Un Administrador solo puede crear/asignar los roles Administrador y
  *   Empleado; no puede crear, ver-editar como igual, ni eliminar cuentas
  *   Superadmin. */
 function role(u){return String((u&&u.role)||'Empleado').trim().toLowerCase()}
 function isFelipe(u){return String((u&&u.username)||'').trim().toLowerCase()==='felipe'}
 function isSuperadminRole(u){return role(u)==='superadmin'}
 function currentUser(){return get(KEY.user,null)||{}}
 function currentUsername(){return String(currentUser().username||'').trim().toLowerCase()}
 function currentIsSuperadmin(){return role(currentUser())==='superadmin'}
 /* Opciones de rol disponibles en el <select> según quién tiene la sesión
  * iniciada: un Administrador nunca ve la opción "Superadmin". */
 const roleSelect=f.elements.role;
 if(roleSelect){
  const wanted=currentIsSuperadmin()?['Superadmin','Administrador','Empleado']:['Administrador','Empleado'];
  const have=Array.from(roleSelect.options).map(o=>o.value||o.textContent);
  if(wanted.join('|')!==have.join('|')){
   const keep=roleSelect.value;
   roleSelect.innerHTML=wanted.map(r=>`<option>${r}</option>`).join('');
   if(wanted.includes(keep))roleSelect.value=keep;
  }
 }
 function canManage(u){
  /* ¿Puede el usuario con sesión iniciada editar/eliminar la cuenta u? */
  if(isFelipe(u))return currentUsername()==='felipe';
  if(isSuperadminRole(u))return currentIsSuperadmin();
  return true;
 }
 function render(){
  /* Un Administrador no debe ni enterarse de que existen cuentas Superadmin
   * (incluida Felipe): esas filas se excluyen por completo de la tabla, no
   * solo se les ocultan los botones de editar/eliminar. */
  const visibleUsers=currentIsSuperadmin()?users:users.filter(u=>!isSuperadminRole(u));
  tb.innerHTML=visibleUsers.map(u=>{
   const i=users.indexOf(u);
   const manageable=canManage(u);
   const canDelete=manageable && !isFelipe(u);
   return `<tr><td>${esc(u.username)}</td><td>${esc(u.name)}</td><td>${esc(u.role||'Empleado')}</td><td>${manageable?`<button type="button" class="btn btn-sm btn-warning editConfigUser" data-i="${i}">Editar</button>`:''} ${canDelete?`<button type="button" class="btn btn-sm btn-danger delConfigUser" data-i="${i}">Eliminar</button>`:''}</td></tr>`;
  }).join('')||'<tr><td colspan="4">No hay usuarios registrados.</td></tr>';
  tb.querySelectorAll('.editConfigUser').forEach(b=>b.onclick=()=>{
   let u=users[+b.dataset.i];
   if(isFelipe(u) && currentUsername()!=='felipe'){fpAlert('El usuario Felipe solo puede editarse iniciando sesión como Felipe.','error');return}
   if(!isFelipe(u) && isSuperadminRole(u) && !currentIsSuperadmin()){fpAlert('Solo un usuario Superadmin puede editar otra cuenta Superadmin.','error');return}
   f.dataset.i=b.dataset.i;
   ['username','name','document','email','phone','role'].forEach(k=>{if(f.elements[k])f.elements[k].value=u[k]||''});
   if(f.elements.password)f.elements.password.value='';
   window.scrollTo({top:f.getBoundingClientRect().top+window.scrollY-70,behavior:'smooth'})
  });
  tb.querySelectorAll('.delConfigUser').forEach(b=>b.onclick=()=>{
   let u=users[+b.dataset.i];
   if(isFelipe(u)){fpAlert('El usuario Felipe no se puede eliminar.','error');return}
   if(isSuperadminRole(u) && !currentIsSuperadmin()){fpAlert('Solo un usuario Superadmin puede eliminar otra cuenta Superadmin.','error');return}
   const idx=+b.dataset.i;
   /* Nadie puede eliminar su propia cuenta con la sesión abierta. */
   if(String(u.username||'').trim().toLowerCase()===currentUsername()){fpAlert('No puedes eliminar tu propia cuenta mientras tienes la sesión iniciada.','error');return}
   /* Siempre debe quedar al menos una cuenta con privilegios de administración. */
   if(isAdminLevelRole(role(u)) && !users.some((x,j)=>j!==idx && isAdminLevelRole(role(x)))){fpAlert('No se puede eliminar la única cuenta de administración del sistema.','error');return}
   fpConfirm('¿Eliminar el usuario "'+u.username+'"? Esta acción no se puede deshacer.',()=>{
    users.splice(idx,1);
    set(KEY.users,users);
    /* Quita el usuario de la lista de "usuarios recordados" del login para no dejar un chip huérfano. */
    try{
     const rem=get(KEY.remembered,[]);
     if(Array.isArray(rem)){
      const next=rem.filter(x=>String(x).trim().toLowerCase()!==String(u.username||'').trim().toLowerCase());
      if(next.length!==rem.length)set(KEY.remembered,next);
     }
    }catch(e){}
    /* f.dataset.i es un índice del arreglo: al eliminar un usuario los índices se corren.
     * Si se estaba editando ese mismo usuario se limpia el formulario; si se estaba
     * editando uno posterior, su índice baja en 1 para no apuntar a otra cuenta. */
    if(f.dataset.i!==undefined){
     const cur=+f.dataset.i;
     if(cur===idx){delete f.dataset.i;f.reset();}
     else if(cur>idx){f.dataset.i=String(cur-1);}
    }
    render();
    fpAlert('Usuario eliminado correctamente.');
   },{danger:true,okText:'Eliminar'});
  });
 }
 render();
 f.onsubmit=e=>{
  e.preventDefault();
  let i=f.dataset.i===undefined?-1:+f.dataset.i,username=f.username.value.trim(),name=f.name.value.trim();
  if(!username||!name){fpAlert('Usuario y nombre son obligatorios.');return}
  if(i>=0 && isFelipe(users[i])){
   if(currentUsername()!=='felipe'){fpAlert('El usuario Felipe solo puede editarse iniciando sesión como Felipe.','error');return}
   if(username.toLowerCase()!=='felipe'){fpAlert('El usuario Felipe no puede cambiar su nombre de usuario.','error');return}
  }
  if(i>=0 && !isFelipe(users[i]) && isSuperadminRole(users[i]) && !currentIsSuperadmin()){
   fpAlert('Solo un usuario Superadmin puede editar otra cuenta Superadmin.','error');return
  }
  if(users.some((u,j)=>j!==i&&String(u.username).toLowerCase()===username.toLowerCase())){fpAlert('Ese nombre de usuario ya está registrado.','error');return}
  if(i<0&&!f.password.value){fpAlert('Debe establecer una contraseña para el usuario nuevo.');return}
  let desiredRole=f.role?f.role.value.trim()||'Empleado':'Empleado';
  /* Un Administrador (no Superadmin) jamás puede crear ni ascender a nadie
   * al rol Superadmin, así el <select> haya sido manipulado. */
  if(desiredRole.toLowerCase()==='superadmin' && !currentIsSuperadmin()){
   fpAlert('Solo un usuario Superadmin puede crear o asignar el rol Superadmin.','error');return
  }
  let base=i>=0?users[i]:{password:'',role:'Empleado'},nu={...base,username,name,document:f.document?f.document.value.trim():'',email:f.email?f.email.value.trim():'',phone:f.phone?f.phone.value.trim():'',role:desiredRole};
  if(isFelipe(base))nu.role='Superadmin';
  if(f.password&&f.password.value)nu.password=hashPassword(f.password.value);
  if(i<0)users.push(nu);else users[i]=nu;
  set(KEY.users,users);
  if(i>=0)syncRememberedRename(base.username,username);
  if(get(KEY.user,null)?.username===base.username)set(KEY.user,nu);
  delete f.dataset.i;f.reset();render();
  fpAlert(i<0?'Usuario creado correctamente.':'Usuario actualizado correctamente.')
 };
 let n=document.getElementById('newConfigUser');
 if(n)n.onclick=()=>{delete f.dataset.i;f.reset();};
}
function nextMonthlyReceipt(){
  const key='facaparking_offline_receipt_monthly_v1'; const cfg=get(KEY.config,defaults.config)||{}; let max=0;
  const readArr=k=>{try{const a=JSON.parse(localStorage.getItem(k)||'[]');return Array.isArray(a)?a:[]}catch(e){return []}};
  readArr('fp_monthly_payments').forEach(x=>{const n=parseInt(x?.receiptNumber,10);if(isFinite(n)&&n>max)max=n;});
  const stored=parseInt(localStorage.getItem(key)||'0',10);if(isFinite(stored)&&stored>max)max=stored;
  const configured=parseInt(cfg.nextReceiptNumberMonthly,10)-1;if(isFinite(configured)&&configured>max)max=configured;
  const n=max+1;localStorage.setItem(key,String(n));cfg.nextReceiptNumberMonthly=n+1;cfg.receiptPrefixMonthly=cfg.receiptPrefixMonthly||'FM';set(KEY.config,cfg);return {prefix:cfg.receiptPrefixMonthly,number:n};
}

function monthlyPaymentLabel(m){return m==='cash'?'Efectivo':m==='nequi'?'Nequi':'Efectivo + Nequi'}
function normHeader(h){return String(h||'').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'')}
function detectCSVDelimiter(text){
  const firstLine=String(text||'').split(/\r\n|\r|\n/,1)[0]||'';
  const commas=(firstLine.match(/,/g)||[]).length, semis=(firstLine.match(/;/g)||[]).length;
  return semis>commas?';':',';
}
function parseCSVText(text,delimiter){
  const delim=delimiter||detectCSVDelimiter(text);
  const rows=[];let field='',row=[],inQuotes=false;
  const s=String(text||'').replace(/^\ufeff/,'').replace(/\r\n/g,'\n').replace(/\r/g,'\n');
  for(let i=0;i<s.length;i++){
    const c=s[i];
    if(inQuotes){ if(c==='"'){ if(s[i+1]==='"'){field+='"';i++;} else inQuotes=false; } else field+=c; }
    else{ if(c==='"')inQuotes=true; else if(c===delim){row.push(field);field='';} else if(c==='\n'){row.push(field);rows.push(row);row=[];field='';} else field+=c; }
  }
  if(field!==''||row.length){row.push(field);rows.push(row);}
  return rows.filter(r=>!(r.length===1&&r[0].trim()===''));
}
/* Fechas: acepta AAAA-MM-DD (formato interno) o DD/MM/AAAA y DD-MM-AAAA
 * (formato en que Excel suele mostrar fechas en Colombia). Devuelve
 * siempre AAAA-MM-DD, o '' si no reconoce el formato. */
function parseFlexibleDate(v){
  const s=String(v||'').trim(); if(!s)return '';
  if(/^\d{4}-\d{2}-\d{2}$/.test(s))return s;
  let m=s.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})$/);
  if(m)return m[3]+'-'+m[2].padStart(2,'0')+'-'+m[1].padStart(2,'0');
  return '';
}
/* Valores: quita separadores de miles ($, espacios, puntos, comas) para
 * que "130.000", "130,000", "$130.000" y "130000" den el mismo número. */
function parseMoneyLoose(v){const digits=String(v??'').replace(/[^0-9]/g,'');return digits?+digits:0}
function addCalendarMonthsDate(dateStr,months){let d=new Date(dateStr+'T00:00:00');let day=d.getDate();d.setDate(1);d.setMonth(d.getMonth()+months);let last=new Date(d.getFullYear(),d.getMonth()+1,0).getDate();d.setDate(Math.min(day,last));return d}
function fmtDateOnly(d){return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0')}
function fmt24(x){const d=x instanceof Date?x:new Date(x);if(isNaN(d))return '';const p=n=>String(n).padStart(2,'0');return p(d.getDate())+'-'+p(d.getMonth()+1)+'-'+d.getFullYear()+' '+p(d.getHours())+':'+p(d.getMinutes())}
function fmtDateEs(s){const d=new Date(String(s||'')+'T00:00:00');if(isNaN(d))return String(s||'');const p=n=>String(n).padStart(2,'0');return p(d.getDate())+'-'+p(d.getMonth()+1)+'-'+d.getFullYear()}
/* Normaliza una placa para compararla: mayúsculas y sin espacios ni guiones (igual que en Entradas). */
function normPlateKey(v){return String(v==null?'':v).trim().toUpperCase().replace(/[\s-]/g,'')}
function monthlyEndWithGrace(m){const end=new Date((m.end||'')+'T00:00:00');if(isNaN(end))return null;end.setHours(23,59,59,999);end.setDate(end.getDate()+3);return end}
/* Estado del plazo de 3 días de gracia respecto a m.end, sin importar si la mensualidad
 * está "pendiente de pago" (nunca se ha pagado), en abono quincenal pendiente, o ya activa.
 * 'ok' = todavía dentro del período vigente; 'grace' = vencida pero dentro de los 3 días de
 * gracia; 'expired' = superó el plazo de 3 días y ya no debe permitir registrar el pago. */
function monthlyGraceState(m){
  const end=new Date((m.end||'')+'T00:00:00'); if(isNaN(end))return 'ok';
  end.setHours(0,0,0,0);
  const today=new Date(); today.setHours(0,0,0,0);
  const grace=new Date(end); grace.setDate(grace.getDate()+3);
  if(today>grace)return 'expired';
  if(today>end)return 'grace';
  return 'ok';
}
function monthlyRenewalDates(m){
  const today=new Date(); today.setHours(0,0,0,0);
  const end=new Date((m.end||'')+'T00:00:00'); end.setHours(0,0,0,0);
  if(isNaN(end))return null;
  const dayBefore=new Date(end);dayBefore.setDate(dayBefore.getDate()-1);
  const graceEnd=new Date(end);graceEnd.setDate(graceEnd.getDate()+3);
  if(today<dayBefore)return {allowed:false,reason:'La renovación se puede hacer un día antes de la fecha de vencimiento.'};
  if(today>graceEnd)return {allowed:false,reason:'La mensualidad superó el plazo de 3 días para confirmar el pago.'};
  const start=new Date(end);
  const nextMonth=addCalendarMonthsDate(fmtDateOnly(start),1);
  return {allowed:true,start:fmtDateOnly(start),end:fmtDateOnly(nextMonth)};
}

function printMonthlyReceipt(m,pay){
  const c=get(KEY.config,defaults.config)||{};
  const L=(k,def)=>String(c[k]??def);
  const showBusiness=c.monthlyShowBusiness===undefined?true:!!c.monthlyShowBusiness;
  const showDocument=c.monthlyShowDocument===undefined?true:!!c.monthlyShowDocument;
  const business=c.razon_social||c.parkingName||'FACAPARKING';
  const nit=c.receiptNit??c.nit??'', phone=c.receiptPhone??c.telefonos??c.phone??'', address=c.receiptAddress??c.direccion1??c.address??'';
  const receipt=String(pay.receiptPrefix||'FM')+String(pay.receiptNumber||'');
  const client=m.name||m.client||m.clientName||m.customerName||'';
  const document=m.document||'', vehicle=m.vehicle||'';
  const plate=String(m.plate||m.placa||'').trim().toUpperCase();
  const total=money(pay.value||m.value||0), method=monthlyPaymentLabel(pay.paymentMethod||'cash');
  const hours=String(c.entryHoursText||'').replace(/^\s*Horario(?:s)? de atención:\s*/i,'').trim()||
    'Lunes a Miércoles:\n06:30 a 21:30\nJueves a Sábado:\n06:30 a 23:00\nDomingos y Festivos:\n06:30 a 19:00';
  const escP=x=>String(x??'').replace(/[&<>]/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[m]));
  const row=(label,val,cls='')=>String(val||'').trim()?`<div class="row ${cls}"><b>${escP(label)}</b><span>${escP(val)}</span></div>`:'';
  const discountAmount=Number(pay.discountAmount||0);
  const discountRows=discountAmount>0?(row('Valor original',money(pay.originalValue||m.value||0),'arial')+row('Descuento','-'+money(discountAmount),'arial')):'';
  const businessBlock=showBusiness?`<div class="business"><b>${escP(business)}</b>${nit?`<span class="bizinfo">${escP(L('monthlyLabelNit','NIT.'))} ${escP(nit)}</span>`:''}${phone?`<span class="bizinfo">${escP(L('monthlyLabelPhone','TEL.'))} ${escP(phone)}</span>`:''}${address?`<span class="bizinfo">${escP(L('monthlyLabelAddress','DIR.'))} ${escP(address)}</span>`:''}</div><div class="divider"></div>`:'';
  const mainRows=`<div class="receipt-type">MENSUALIDAD</div>${row(L('monthlyLabelReceipt','Recibo'),receipt,'arial')}${row(L('monthlyLabelClient','Cliente'),client,'arial')}${showDocument?row(L('monthlyLabelDocument','Documento'),document,'arial'):''}${row(L('monthlyLabelVehicle','Vehículo'),vehicle,'arial')}${row(L('monthlyLabelPlate','Placa'),plate,'arial')}${row(L('monthlyLabelPaymentDate','Fecha de pago'),fmt24(pay.dateTime),'arial')}${row(L('monthlyLabelStart','Inicio'),fmtDateEs(m.start||m.periodStart),'arial')}${row(L('monthlyLabelEnd','Vence'),fmtDateEs(m.end||m.periodEnd),'arial')}${discountRows}${row(L('monthlyLabelValue','Valor'),total,'total arial')}${row(L('monthlyLabelPaymentMethod','Forma de pago'),method,'arial')}`;
  const html=`<!doctype html><html lang="es"><head><meta charset="utf-8"><title>${escP(receipt)}</title><style>@page{size:50mm auto;margin:0}*{box-sizing:border-box}html,body{margin:0!important;padding:0!important;width:50mm;max-width:50mm;background:#fff;color:#000;-webkit-print-color-adjust:exact;print-color-adjust:exact}body{font-family:"Times New Roman",Times,serif;font-size:10.5px;line-height:1.18;font-weight:600;text-rendering:geometricPrecision}.receipt{width:48mm;max-width:48mm;margin:0 auto;padding:1mm 1.5mm;font-family:"Times New Roman",Times,serif;font-size:10.5px;line-height:1.18;font-weight:600;overflow:visible}.arial span{font-family:Arial,Helvetica,sans-serif!important;font-size:calc(1em - 1px)!important;font-weight:normal!important}.business{line-height:1.3;text-align:center;margin:0 0 4px;font-size:10.5px;font-weight:600;overflow:visible;word-break:normal;overflow-wrap:break-word}.business b{display:block;font-size:14px;font-weight:700;letter-spacing:.3px;margin-bottom:3px}.bizinfo{display:block;font-size:12.5px;font-weight:700;line-height:1.25}.divider{width:100%;border:0;border-top:1px dashed #000;height:0;margin:5px 0}.divider.hours-divider{margin:0 0 3px}.main{line-height:1.3;text-align:left;font-size:14px;font-weight:600}.receipt-type{text-align:center;font-size:11.5px;font-weight:700;margin:0 0 4px}.row{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:baseline;width:100%;margin:0 0 2px;gap:1px 4px}.row b{font-weight:600;white-space:nowrap;flex:0 0 auto}.row span{margin-left:auto;text-align:right;white-space:normal;overflow-wrap:break-word;word-break:break-word;flex:1 1 auto;min-width:0}.row.total{margin-top:3px;padding-top:3px;border-top:1px dashed #000;font-size:12.5px}.row.total b,.row.total span{font-weight:700}.hours{line-height:1.3;text-align:center;white-space:pre-line;padding:0;font-size:13px;font-weight:600}.hours-title{display:block;font-weight:700;font-size:13px;margin-bottom:3px}</style></head><body><div class="receipt">${businessBlock}<div class="main">${mainRows}</div><div class="divider hours-divider"></div><div class="hours"><div class="hours-title">HORARIOS DE ATENCIÓN</div>${escP(hours)}</div></div><script>window.onload=function(){window.print();setTimeout(function(){window.close()},300)};<\/script></body></html>`;
  const w=window.open('','_blank','width=420,height=700');
  if(!w){fpAlert('El navegador bloqueó la ventana de impresión. Permita ventanas emergentes para FacaParking.','error');return;}
  w.document.open();w.document.write(html);w.document.close();
}

function showMonthlyReport(rows,filters){
  try{
    filters=filters||{};
    const total=rows.reduce((a,p)=>a+(+p.value||0),0);
    const cashTotal=rows.reduce((a,p)=>a+(String(p.paymentMethod)==='cash'?(+p.value||0):(+p.cashAmount||0)),0);
    const nequiTotal=rows.reduce((a,p)=>a+(String(p.paymentMethod)==='nequi'?(+p.value||0):(+p.nequiAmount||0)),0);
    const rangeLabel=(filters.from||filters.to)?`${filters.from?fmtDateEs(filters.from):'inicio'} — ${filters.to?fmtDateEs(filters.to):'hoy'}`:'Todos los registros';
    const methodLabel=filters.method?monthlyPaymentLabel(filters.method):'Todas';
    const body=rows.slice().sort((a,b)=>new Date(a.dateTime)-new Date(b.dateTime)).map(p=>`<tr><td>${esc((p.receiptPrefix||'FM')+String(p.receiptNumber||''))}</td><td>${esc(String(p.plate||'').toUpperCase())}</td><td>${esc(p.client||'')}</td><td>${esc(fmtDateEs(p.periodStart))}</td><td>${esc(fmtDateEs(p.periodEnd))}</td><td>${money(p.value||0)}</td><td>${esc(monthlyPaymentLabel(p.paymentMethod||'cash'))}</td><td>${money(p.cashAmount||0)}</td><td>${money(p.nequiAmount||0)}</td><td>${esc(fmt24(p.dateTime))}</td><td>${esc(p.user||'')}</td><td>${p.isInstallment?(Number(p.installmentTotal||0)>Number(p.installmentPaid||0)?'Abono 1/2':'Abono 2/2'):'—'}</td></tr>`).join('')||'<tr><td colspan="12">Sin pagos de mensualidades para el filtro seleccionado.</td></tr>';
    const w=window.open('','_blank','width=1000,height=750');
    if(!w){fpAlert('El navegador bloqueó la ventana del reporte. Permita ventanas emergentes para FacaParking.','error');return;}
    w.document.write(`<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Reporte de mensualidades</title><style>body{font-family:Arial,sans-serif;padding:24px;color:#222}h1{text-align:center;font-size:22px;margin:0 0 8px}h2{font-size:16px;margin:20px 0 8px;border-bottom:1px solid #ccc;padding-bottom:5px}.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}.box{border:1px solid #ddd;padding:10px;border-radius:6px}.box b{display:block;font-size:15px;margin-top:4px}table{width:100%;border-collapse:collapse;font-size:11px}th,td{border:1px solid #ddd;padding:6px;text-align:left}th{background:#f3f3f3}.note{margin-top:18px;font-size:12px;color:#666}</style></head><body><h1>REPORTE DE MENSUALIDADES</h1><div class="note">Rango: ${esc(rangeLabel)} · Forma de pago: ${esc(methodLabel)} · Generado: ${esc(fmt24(new Date()))}</div><div class="grid"><div class="box">Pagos incluidos<b>${rows.length}</b></div><div class="box">Total recaudado<b>${money(total)}</b></div><div class="box">Efectivo<b>${money(cashTotal)}</b></div><div class="box">Nequi<b>${money(nequiTotal)}</b></div></div><h2>Detalle de pagos de mensualidades</h2><table><thead><tr><th>Recibo</th><th>Placa</th><th>Cliente</th><th>Inicio</th><th>Fin</th><th>Valor</th><th>Forma de pago</th><th>Efectivo</th><th>Nequi</th><th>Fecha</th><th>Usuario</th><th>Abono</th></tr></thead><tbody>${body}</tbody></table><p class="note">Este reporte incluye únicamente pagos de mensualidades; no incluye ventas de parqueadero.</p></body></html>`);
    w.document.close(); w.focus();
  }catch(err){console.error(err);fpAlert('No fue posible generar el reporte de mensualidades.');}
}
function fpAskAmount(title,hintHtml,suggestion,onConfirm){
  // Electron descarta window.prompt() silenciosamente (sin error, sin diálogo).
  // Por eso el monto del abono quincenal se pide con un modal HTML propio
  // en vez de prompt(). El bloque prompt() de abajo es solo un respaldo por
  // si el HTML de la página aún no incluye el overlay #bwOverlay.
  const overlay=document.getElementById('bwOverlay');
  if(!overlay){
    const raw=prompt(String(hintHtml||'').replace(/<[^>]+>/g,' '),String(suggestion));
    if(raw===null)return;
    onConfirm(Math.round(+String(raw).replace(/[^0-9.-]/g,'')||0));
    return;
  }
  const labelEl=document.getElementById('bwModalLabel'), hintEl=document.getElementById('bwModalHint'), input=document.getElementById('bwAmountInput'), confirmBtn=document.getElementById('bwConfirmBtn'), cancelBtn=document.getElementById('bwCancelBtn'), closeBtn=document.getElementById('bwCloseBtn');
  if(labelEl)labelEl.textContent=title||'';
  if(hintEl)hintEl.innerHTML=hintHtml||'';
  if(input)input.value=String(suggestion);
  overlay.style.display='flex';
  function close(){overlay.style.display='none';if(confirmBtn)confirmBtn.onclick=null;if(cancelBtn)cancelBtn.onclick=null;if(closeBtn)closeBtn.onclick=null;document.removeEventListener('keydown',onKey)}
  function onKey(e){if(e.key==='Escape')close();else if(e.key==='Enter'){e.preventDefault();confirm()}}
  function confirm(){
    const amt=Math.round(+String(input?input.value:'0').replace(/[^0-9.-]/g,'')||0);
    close();
    onConfirm(amt);
  }
  if(confirmBtn)confirmBtn.onclick=confirm;
  if(cancelBtn)cancelBtn.onclick=close;
  if(closeBtn)closeBtn.onclick=close;
  document.addEventListener('keydown',onKey);
  if(input){input.focus();input.select();}
}
function fpOpenPaymentModal(total,label,onConfirm){
  const overlay=document.getElementById('mpOverlay');
  if(!overlay){
    const method=prompt('Forma de pago: efectivo, nequi o ambos','efectivo');
    if(method===null)return;
    const pm=method.trim().toLowerCase();
    if(!['efectivo','nequi','ambos'].includes(pm)){fpAlert('Forma de pago no válida.');return;}
    let cashAmount=0,nequiAmount=0;
    if(pm==='efectivo')cashAmount=total; else if(pm==='nequi')nequiAmount=total; else {cashAmount=+(prompt('¿Cuánto recibe en efectivo?','0')||0); if(!Number.isFinite(cashAmount)||cashAmount<0||cashAmount>total){fpAlert('Valor de efectivo no válido.');return;} nequiAmount=total-cashAmount;}
    onConfirm(pm==='efectivo'?'cash':pm==='nequi'?'nequi':'both',Math.round(cashAmount),Math.round(nequiAmount),total,0);
    return;
  }
  // state.total es el valor a cobrar realmente (puede ser menor al valor de la mensualidad
  // si se digita un descuento en "Valor a cobrar"); "total" (parámetro) es el valor de
  // referencia de la mensualidad/período, usado solo para calcular el descuento.
  const state={method:'cash',cash:0,nequi:0,total:total,discount:0};
  // Evita que un doble clic / doble toque en "Confirmar" dispare onConfirm() dos veces
  // (esto guardaba dos pagos idénticos en fp_monthly_payments y duplicaba el ingreso
  // en Caja/Ventas). Se reinicia cada vez que se abre el modal.
  let confirming=false;
  const labelEl=document.getElementById('mpModalLabel'), valueEl=document.getElementById('mpModalValue');
  if(labelEl) labelEl.textContent=label||'';
  if(valueEl) valueEl.textContent=money(total);
  const chargeInput=document.getElementById('mpChargeAmount');
  const discountSummary=document.getElementById('mpDiscountSummary'), discOriginalEl=document.getElementById('mpDiscountOriginal'), discAppliedEl=document.getElementById('mpDiscountApplied'), discFinalEl=document.getElementById('mpDiscountFinal');
  const cashInput=document.getElementById('mpCashAmount'), nequiInput=document.getElementById('mpNequiAmount');
  const totalPaidEl=document.getElementById('mpTotalPaid'), balanceEl=document.getElementById('mpPaymentBalance');
  const confirmBtn=document.getElementById('mpConfirmBtn'), cancelBtn=document.getElementById('mpCancelBtn'), closeBtn=document.getElementById('mpCloseBtn');
  function syncButtons(){overlay.querySelectorAll('.fp-payment-method').forEach(btn=>btn.classList.toggle('active',btn.getAttribute('data-payment-method')===state.method))}
  function recalcDiscount(){
    let charged=chargeInput?Math.round(Number(chargeInput.value)||0):total;
    charged=Math.max(0,Math.min(total,charged));
    state.total=charged; state.discount=Math.max(0,total-charged);
    if(discountSummary){
      if(state.discount>0){
        discountSummary.style.display='block';
        if(discOriginalEl)discOriginalEl.textContent=money(total);
        if(discAppliedEl)discAppliedEl.textContent='-'+money(state.discount);
        if(discFinalEl)discFinalEl.textContent=money(state.total);
      } else {
        discountSummary.style.display='none';
      }
    }
  }
  function recalc(){
    const t=state.total;
    let cash=0,nequi=0;
    if(state.method==='cash'){cash=t;nequi=0}
    else if(state.method==='nequi'){cash=0;nequi=t}
    else{cash=Math.round(Number(cashInput.value)||0);nequi=Math.max(0,t-cash)}
    if(state.method==='both'&&nequiInput)nequiInput.value=String(nequi);
    state.cash=cash;state.nequi=nequi;
    const paid=state.method==='both'?(cash+nequi):t;
    if(totalPaidEl)totalPaidEl.textContent=money(paid);
    if(balanceEl)balanceEl.textContent=money(Math.max(0,t-paid));
    if(cashInput)cashInput.style.borderColor=(state.method==='both'&&(cash<=0||cash>=t))?'#d9534f':'#d9dde2';
    if(confirmBtn)confirmBtn.disabled=!(t>0?(state.method==='cash'||state.method==='nequi'||(state.method==='both'&&cash>0&&cash<t)):(state.method==='cash'||state.method==='nequi'));
  }
  function render(){
    syncButtons();
    const both=state.method==='both';
    if(cashInput){cashInput.parentElement.style.display=both?'grid':'none';cashInput.value=''}
    if(nequiInput){nequiInput.parentElement.style.display=both?'grid':'none'}
    recalc();
  }
  overlay.querySelectorAll('.fp-payment-method').forEach(btn=>btn.onclick=()=>{state.method=btn.getAttribute('data-payment-method');render()});
  if(cashInput)cashInput.oninput=function(){this.value=String(this.value||'').replace(/[^0-9]/g,'');recalc()};
  if(chargeInput)chargeInput.oninput=function(){this.value=String(this.value||'').replace(/[^0-9]/g,'');recalcDiscount();render()};
  function close(){overlay.style.display='none'}
  if(cancelBtn)cancelBtn.onclick=close;
  if(closeBtn)closeBtn.onclick=close;
  overlay.onclick=e=>{if(e.target===overlay)close()};
  if(confirmBtn)confirmBtn.onclick=()=>{
    if(confirmBtn.disabled||confirming)return;
    confirming=true;
    confirmBtn.disabled=true;
    close();
    onConfirm(state.method,Math.round(state.cash),Math.round(state.nequi),state.total,state.discount);
  };
  state.method='cash';
  if(chargeInput)chargeInput.value=String(total);
  if(discountSummary)discountSummary.style.display='none';
  recalcDiscount();
  overlay.style.display='flex';
  render();
}
function initMonthly(){
  let data=get('fp_monthly',[]), payments=get('fp_monthly_payments',[]), f=document.getElementById('monthlyForm'), tb=document.querySelector('#monthlyTable tbody'), search=document.getElementById('monthlySearch'), searchLegacy=document.getElementById('monthlySearchLegacy'), statusFilter=document.getElementById('monthlyStatusFilter'), payTb=document.querySelector('#monthlyPaymentsTable tbody'), payPager=document.getElementById('monthlyPaymentsPager');
  let payPage=1, payPageSize=10;
  const isAdmin=isAdminLevelRole((get(KEY.user,defaults.user)||{}).role);
  // El Empleado solo puede registrar pagos de mensualidades ya existentes:
  // no crea mensualidades nuevas ni usa la migración masiva por CSV.
  if(!isAdmin){
    const createCard=document.getElementById('monthlyCreateCard'); if(createCard)createCard.style.display='none';
    const migrateCard=document.getElementById('monthlyMigrateCard'); if(migrateCard)migrateCard.style.display='none';
  }
  function syncExpired(){
    // Se relee del almacenamiento antes de calcular: si esta pantalla llevaba mucho tiempo abierta (o hubo
    // cambios desde otra ventana) ya no se sobrescribe lo guardado con una copia vieja. Solo se escribe si algo cambió.
    activateDueAdvancePeriods();
    deactivateExpiredMonthlies();
    data=get('fp_monthly',[]);payments=get('fp_monthly_payments',[]);
  }
  function filteredPayments(){
    const q2=(search?.value||'').trim().toLowerCase(), fromEl=document.getElementById('monthlyFrom'), toEl=document.getElementById('monthlyTo'), methodEl=document.getElementById('monthlyPaymentFilter');
    const fromVal=fromEl?.value||'', toVal=toEl?.value||'', methodVal=methodEl?.value||'';
    return payments.slice().reverse().filter(p=>{
      const hay=JSON.stringify(p).toLowerCase(), day=String(p.dateTime||'').slice(0,10), pm=String(p.paymentMethod||'cash');
      return (!q2||hay.includes(q2))&&(!fromVal||day>=fromVal)&&(!toVal||day<=toVal)&&(!methodVal||pm===methodVal);
    });
  }
  function toggleScheduleFields(){
    const sel=f.elements.schedule, box=document.getElementById('monthlyNightFields');
    if(box) box.style.display=(sel&&sel.value==='night')?'flex':'none';
  }
  if(f.elements.schedule) f.elements.schedule.addEventListener('change',toggleScheduleFields);
  toggleScheduleFields();
  function monthlyScheduleLabel(m){return String(m.schedule||'day').toLowerCase()==='night'?'Noche':'Día'}
  function monthlyScheduleDetail(m){if(String(m.schedule||'day').toLowerCase()!=='night')return 'Día';const en=m.nightEntryLimit||'?',ex=m.nightExitLimit||'?';return 'Noche ('+en+' a '+ex+')'}
  // Antes no filtraba por confirmed!==true, así que un cobro pendiente ya pagado en
  // "Pendientes" (confirmPending lo marca confirmed:true) seguía sumando aquí para
  // siempre, mostrando en Mensualidades un cargo "fuera de horario" que ya se cobró.
  function monthlyExtraChargesTotal(monthlyId){return get('fp_monthly_extra_charges',[]).filter(x=>String(x.monthlyId)===String(monthlyId) && x.confirmed!==true).reduce((a,x)=>a+(+x.amount||0),0)}
  function statusOf(m){
    if(m.pendingConfirmation)return 'Pendiente de confirmar pago';
    if(String(m.paymentStatus||'').toLowerCase()==='pending' && !m.installment){
      const gs=monthlyGraceState(m);
      if(gs==='expired')return 'Vencido — superó el plazo de 3 días sin pagar';
      if(gs==='grace')return 'Pendiente de pago — Gracia 3 días';
      return 'Pendiente de pago';
    }
    if(m.installment){
      const pend=Math.max(0,(+m.installment.total||0)-(+m.installment.paid||0)),gs=monthlyGraceState(m),base='Quincenal: abonado '+money(m.installment.paid||0)+' — pendiente '+money(pend);
      if(gs==='expired')return 'Vencido — '+base;
      if(gs==='grace')return base+' (Gracia 3 días)';
      return base;
    }
    const today=new Date();today.setHours(0,0,0,0);const end=new Date((m.end||'')+'T00:00:00');if(isNaN(end))return 'Sin fecha';end.setHours(0,0,0,0);const grace=new Date(end);grace.setDate(grace.getDate()+3);if(today>end&&today<=grace)return 'Gracia 3 días';if(today>=end){if(today.getTime()===end.getTime())return 'Vence hoy';return 'Vencido'}const before=new Date(end);before.setDate(before.getDate()-1);return today.getTime()===before.getTime()?'Renovación permitida':'Activo'}
  function statusCategory(m){
    if(m.pendingConfirmation)return 'pending';
    if(String(m.paymentStatus||'').toLowerCase()==='pending' || m.installment)return monthlyGraceState(m)==='expired'?'expired':'pending';
    const today=new Date();today.setHours(0,0,0,0);
    const end=new Date((m.end||'')+'T00:00:00');if(isNaN(end))return 'active';
    end.setHours(0,0,0,0);
    if(today>=end)return 'expired';
    const before=new Date(end);before.setDate(before.getDate()-1);
    return today>=before?'expiring':'active';
  }
  // Elegible para "pagar por adelantado" (pago en cola, opción A): la mensualidad está al día
  // (no tiene abono quincenal pendiente, ni pago del período actual pendiente, ni ya tiene un
  // adelanto en cola) y todavía faltan más de 1 día para el vencimiento — es decir, está fuera
  // de la ventana normal de renovación (monthlyRenewalDates), que es para renovar justo a tiempo.
  function monthlyCanPrepay(m){
    if(m.nextPeriod) return false;
    if(m.installment) return false;
    if(String(m.paymentStatus||'').toLowerCase()==='pending') return false;
    if(m.pendingConfirmation) return false;
    const end=new Date((m.end||'')+'T00:00:00'); if(isNaN(end)) return false;
    end.setHours(0,0,0,0);
    const dayBefore=new Date(end); dayBefore.setDate(dayBefore.getDate()-1);
    const today=new Date(); today.setHours(0,0,0,0);
    return today<dayBefore;
  }
  function render(){syncExpired();let q=(searchLegacy?.value||'').toLowerCase(),sf=statusFilter?.value||'';tb.innerHTML=data.map((x,i)=>({x,i})).filter(o=>(!sf||statusCategory(o.x)===sf)&&JSON.stringify(o.x).toLowerCase().includes(q)).map(o=>{let x=o.x,rd=monthlyRenewalDates(x),notExpired=monthlyGraceState(x)!=='expired',pendingPayment=String(x.paymentStatus||'').toLowerCase()==='pending',canPay=!x.pendingConfirmation&&!x.nextPeriod&&(((pendingPayment||x.installment)&&notExpired)||(rd&&rd.allowed)),canPrepay=monthlyCanPrepay(x),extra=monthlyExtraChargesTotal(x.id||('M'+o.i));return `<tr><td>${esc(x.document)}</td><td>${esc(x.name)}</td><td>${esc(String(x.plate||'').toUpperCase())}</td><td>${esc(x.vehicle)}</td><td>${esc(fmtDateEs(x.start))}</td><td>${esc(fmtDateEs(x.end))}${x.nextPeriod?'<br><small style="color:#1f7a4d">Adelanto pagado → vence '+esc(fmtDateEs(x.nextPeriod.end))+'</small>':''}</td><td>${money(x.value)}</td><td>${esc(monthlyScheduleDetail(x))}</td><td>${extra>0?money(extra):'—'}</td><td>${esc(statusOf(x))}</td><td>${isAdmin?`<button type=\"button\" class=\"btn btn-sm btn-warning editMonthly\" data-i=\"${o.i}\">Editar</button>`:''} ${isAdmin&&x.pendingConfirmation?`<button type=\"button\" class=\"btn btn-sm btn-success confirmMigration\" data-i=\"${o.i}\">Confirmar pago</button>`:''} ${canPay?`<button type=\"button\" class=\"btn btn-sm btn-primary renewMonthly\" data-i=\"${o.i}\">${x.installment?'Completar pago quincenal':'Pagar mensualidad'}</button>`:''} ${canPrepay?`<button type=\"button\" class=\"btn btn-sm btn-default payAdvance\" data-i=\"${o.i}\" title=\"Pagar el siguiente período por adelantado; no arranca hasta que venza el actual\">Pagar por adelantado</button>`:''} ${isAdmin?`<button type=\"button\" class=\"btn btn-sm btn-danger delMonthly\" data-i=\"${o.i}\">Eliminar</button>`:''}</td></tr>`}).join('')||'<tr><td colspan="11">No hay mensualidades registradas.</td></tr>';
    tb.querySelectorAll('.confirmMigration').forEach(b=>b.onclick=()=>{if(!isAdmin){fpAlert('Solo el Administrador puede confirmar el pago de una mensualidad migrada.','error');return;}let m=data[+b.dataset.i];fpConfirm('¿Confirmar que la mensualidad de '+String(m.plate||'').toUpperCase()+' ya fue pagada por fuera del sistema?\nQuedará activa hasta '+fmtDateEs(m.end)+'.',()=>{m.pendingConfirmation=false;m.active=true;m.confirmedAt=new Date().toISOString();m.confirmedBy=(get(KEY.user,defaults.user)||{}).name||'Usuario';set('fp_monthly',data);render();fpAlert('Pago confirmado. La mensualidad de '+String(m.plate||'').toUpperCase()+' queda activa.');},{okText:'Confirmar'});});
    tb.querySelectorAll('.editMonthly').forEach(b=>b.onclick=()=>{if(!isAdmin){fpAlert('Solo el Administrador puede modificar mensualidades.','error');return;}let m=data[+b.dataset.i];['document','name','plate','vehicle','value','start','end'].forEach(k=>{if(f.elements[k])f.elements[k].value=m[k]??''});if(f.elements.schedule)f.elements.schedule.value=String(m.schedule||'day').toLowerCase()==='night'?'night':'day';if(f.elements.nightEntryLimit)f.elements.nightEntryLimit.value=m.nightEntryLimit||'';if(f.elements.nightExitLimit)f.elements.nightExitLimit.value=m.nightExitLimit||'';toggleScheduleFields();if(f.elements.active)f.elements.active.checked=m.active!==false;if(f.elements.biweekly)f.elements.biweekly.checked=!!m.biweekly;f.dataset.i=b.dataset.i;window.scrollTo({top:f.getBoundingClientRect().top+window.scrollY-80,behavior:'smooth'});});
    tb.querySelectorAll('.delMonthly').forEach(b=>b.onclick=()=>{if(!isAdmin){fpAlert('Solo el Administrador puede eliminar mensualidades.','error');return;}fpConfirm('¿Eliminar esta mensualidad?',()=>{data.splice(+b.dataset.i,1);set('fp_monthly',data);render()},{danger:true,okText:'Eliminar'});});
    tb.querySelectorAll('.renewMonthly').forEach(b=>b.onclick=()=>payMonthly(+b.dataset.i));
    tb.querySelectorAll('.payAdvance').forEach(b=>b.onclick=()=>payMonthlyAdvance(+b.dataset.i));
    if(payTb){
      const pages=Math.max(1,Math.ceil(filteredPayments().length/payPageSize)); if(payPage>pages)payPage=pages;
      let rows=filteredPayments();
      const pageRows=rows.slice((payPage-1)*payPageSize,payPage*payPageSize);
      payTb.innerHTML=pageRows.map(p=>`<tr><td><strong>${esc(p.receiptPrefix||'FM')}${esc(p.receiptNumber||'')}</strong></td><td><strong>${esc(String(p.plate||'').toUpperCase())}</strong></td><td>${esc(fmtDateEs(p.periodStart))}</td><td>${esc(fmtDateEs(p.periodEnd))}</td><td>${money(p.value)}</td><td>${esc(monthlyPaymentLabel(p.paymentMethod||'cash'))}</td><td>${money(p.cashAmount||0)}</td><td>${money(p.nequiAmount||0)}</td><td>${esc(fmt24(p.dateTime))}</td><td>${esc(p.user||'')}</td><td><button type="button" class="btn btn-sm printMonthlyPayment" data-id="${esc(p.id)}" title="Imprimir recibo"><svg class="fp-print-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9V3h12v6M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2M6 14h12v7H6z"/></svg></button></td></tr>`).join('')||'<tr><td colspan="11">No hay pagos de mensualidades registrados.</td></tr>';
      payTb.querySelectorAll('.printMonthlyPayment').forEach(b=>b.onclick=()=>{let p=payments.find(x=>String(x.id)===String(b.dataset.id));if(!p)return;let m=data.find(x=>String(x.id)===String(p.monthlyId))||{plate:p.plate,name:p.client,document:p.document||'',vehicle:p.vehicle,start:p.periodStart,end:p.periodEnd,value:p.value};printMonthlyReceipt(m,p)});
      if(payPager){let nums='';const maxBtns=5;let start=Math.max(1,payPage-2),end=Math.min(pages,start+maxBtns-1);start=Math.max(1,end-maxBtns+1);for(let n=start;n<=end;n++)nums+=`<button type="button" class="${n===payPage?'active':''}" data-page="${n}">${n}</button>`;payPager.innerHTML=`<button type="button" data-page="prev" ${payPage<=1?'disabled':''}>‹ Anterior</button>${nums}<button type="button" data-page="next" ${payPage>=pages?'disabled':''}>Siguiente ›</button><span class="fp-page-count">Mostrando ${rows.length?((payPage-1)*payPageSize+1):0} a ${Math.min(payPage*payPageSize,rows.length)} de ${rows.length} pagos</span>`;payPager.querySelectorAll('button').forEach(b=>b.onclick=()=>{const v=b.dataset.page;if(v==='prev'&&payPage>1)payPage--;else if(v==='next'&&payPage<pages)payPage++;else if(!isNaN(+v))payPage=+v;render();});}
    }
  }
  function payMonthly(i){
    const m=data[i];
    if(m.nextPeriod){fpAlert('Esta mensualidad ya tiene pagado por adelantado el siguiente período (vence '+fmtDateEs(m.nextPeriod.end)+'). No se puede volver a pagar hasta que ese período inicie.','error');return;}
    const installment=m.installment||null;
    let d;
    const pendingPayment=String(m.paymentStatus||'').toLowerCase()==='pending';
    if(installment){
      if(monthlyGraceState(m)==='expired'){fpAlert('Esta mensualidad superó el plazo de 3 días para completar el segundo abono quincenal. Edite la mensualidad (actualice las fechas) o elimínela y regístrela de nuevo.','error');return;}
      d={start:installment.targetStart,end:installment.targetEnd,allowed:true};
    }
    else if(pendingPayment){
      if(monthlyGraceState(m)==='expired'){fpAlert('Esta mensualidad superó el plazo de 3 días para registrar el primer pago. Edite la mensualidad (actualice las fechas) o elimínela y regístrela de nuevo.','error');return;}
      // Si el pago llega dentro de la ventana de renovación (desde 1 día antes del vencimiento
      // hasta 3 días después), se renueva al período siguiente igual que una mensualidad ya
      // pagada: inicio = vencimiento actual, fin = un mes después. Antes, una mensualidad que
      // seguía como "pendiente" cobraba siempre el período registrado (m.start–m.end), y al
      // pagar el día antes del vencimiento quedaba con fecha fin = hoy ("Vence hoy") y con el
      // botón de pago activo. Pagos en mitad del período siguen cubriendo m.start–m.end.
      const rdp=monthlyRenewalDates(m);
      d=(rdp&&rdp.allowed)?rdp:{start:m.start,end:m.end,allowed:true};
    }
    else{d=monthlyRenewalDates(m); if(!d||!d.allowed){fpAlert(d?.reason||'Esta mensualidad todavía no puede renovarse.');return;}}
    const fullValue=+m.value||0; if(fullValue<=0){fpAlert('La mensualidad no tiene un valor configurado. Edítela antes de registrar el pago.','error');return;}
    const reg=null; // Los pagos de mensualidad van fuera de la caja: no exigen caja abierta ni se asocian a ella.
    const alreadyPaid=installment?(+installment.paid||0):0;
    const remaining=Math.max(0,fullValue-alreadyPaid);
    if(m.biweekly){
      const suggestion=installment?remaining:Math.round(fullValue/2);
      const title='Pago quincenal ('+(installment?'2/2':'1/2')+') — Mensualidad '+String(m.plate||'').toUpperCase();
      const hint=installment
        ?('Saldo pendiente: <strong>'+money(remaining)+'</strong><br>¿Cuánto se abona ahora? (máximo '+money(remaining)+')')
        :('Valor total del período: <strong>'+money(fullValue)+'</strong><br>¿Cuánto se abona ahora? (por defecto la mitad; deje el segundo abono para completar)');
      fpAskAmount(title,hint,suggestion,function(amountNow){
        if(!(amountNow>0)||amountNow>remaining){fpAlert('El monto ingresado no es válido. Debe ser mayor que 0 y no superar '+money(remaining)+'.');return;}
        fpProcessMonthlyPayment(i,m,d,fullValue,alreadyPaid,amountNow,reg,installment);
      });
      return;
    }
    fpProcessMonthlyPayment(i,m,d,fullValue,alreadyPaid,remaining,reg,installment);
  }
  // Pago por adelantado (opción A, "en cola"): el cliente paga el siguiente período mucho antes
  // de que venza el actual. NO se cambia x.start/x.end todavía —el período vigente sigue corriendo
  // tal cual— solo se guarda el pago y se deja anotado en x.nextPeriod. syncExpired() se encarga de
  // "correr" el período automáticamente el día que llegue la fecha de inicio de ese adelanto.
  function payMonthlyAdvance(i){
    const m=data[i];
    if(!monthlyCanPrepay(m)){fpAlert('Esta mensualidad no está disponible para pago por adelantado en este momento.','error');return;}
    const end=new Date((m.end||'')+'T00:00:00'); if(isNaN(end)){fpAlert('Esta mensualidad no tiene una fecha de fin válida.','error');return;}
    const start=fmtDateOnly(end), nextEnd=fmtDateOnly(addCalendarMonthsDate(start,1));
    const fullValue=+m.value||0; if(fullValue<=0){fpAlert('La mensualidad no tiene un valor configurado. Edítela antes de registrar el pago.','error');return;}
    const reg=null; // Los pagos de mensualidad van fuera de la caja: no exigen caja abierta ni se asocian a ella.
    fpOpenPaymentModal(fullValue,'Adelanto mensualidad '+String(m.plate||'').toUpperCase(),function(pm,cashAmount,nequiAmount,chargeAmount,discountAmount){
      const receipt=nextMonthlyReceipt(), paidAt=new Date();
      const charged=chargeAmount!=null?chargeAmount:fullValue, discount=discountAmount||0;
      const payment={id:'MP'+Date.now(),monthlyId:m.id||('M'+i),plate:String(m.plate||'').toUpperCase(),client:m.name||'',document:m.document||'',vehicle:m.vehicle||'',value:charged,originalValue:fullValue,discountAmount:discount,paymentMethod:pm,cashAmount,nequiAmount,dateTime:paidAt.toISOString(),periodStart:start,periodEnd:nextEnd,receiptPrefix:receipt.prefix,receiptNumber:receipt.number,registerId:null,user:(get(KEY.user,defaults.user)||{}).name||'Usuario',advance:true};
      payments.push(payment);
      const nm={...m,nextPeriod:{start,end:nextEnd,paidAt:paidAt.toISOString(),receiptPrefix:receipt.prefix,receiptNumber:receipt.number}};
      data[i]=nm;
      set('fp_monthly',data);set('fp_monthly_payments',payments);render();
      printMonthlyReceipt({...m,start,end:nextEnd},payment);
      fpAlert('Pago por adelantado registrado (recibo '+receipt.prefix+receipt.number+'). El período actual sigue vigente hasta '+fmtDateEs(m.end)+'; el nuevo período ('+fmtDateEs(start)+' a '+fmtDateEs(nextEnd)+') arrancará solo automáticamente en esa fecha.');
    });
  }
  function fpProcessMonthlyPayment(i,m,d,fullValue,alreadyPaid,amountNow,reg,installment){
    fpOpenPaymentModal(amountNow,(installment?'Abono mensualidad ':'Mensualidad ')+String(m.plate||'').toUpperCase(),function(pm,cashAmount,nequiAmount,chargeAmount,discountAmount){
      const receipt=nextMonthlyReceipt(), paidAt=new Date();
      const charged=chargeAmount!=null?chargeAmount:amountNow, discount=discountAmount||0;
      // En modo quincenal, el saldo pendiente se calcula sobre lo realmente cobrado
      // (con descuento aplicado), no sobre el monto nominal solicitado en el prompt.
      // Un pago completo (no quincenal) siempre cubre el período entero, sin importar el descuento.
      const totalPaidNow=m.biweekly?(alreadyPaid+charged):fullValue, isFinal=totalPaidNow>=fullValue;
      const payment={id:'MP'+Date.now(),monthlyId:m.id||('M'+i),plate:String(m.plate||'').toUpperCase(),client:m.name||'',document:m.document||'',vehicle:m.vehicle||'',value:charged,originalValue:amountNow,discountAmount:discount,paymentMethod:pm,cashAmount,nequiAmount,dateTime:paidAt.toISOString(),periodStart:d.start,periodEnd:d.end,receiptPrefix:receipt.prefix,receiptNumber:receipt.number,registerId:null,user:(get(KEY.user,defaults.user)||{}).name||'Usuario',isInstallment:!!m.biweekly,installmentPaid:totalPaidNow,installmentTotal:fullValue};
      payments.push(payment);
      if(isFinal){
        const nm={...m,start:d.start,end:d.end,active:true,paymentStatus:'paid',updatedAt:paidAt.toISOString(),lastPaymentDate:paidAt.toISOString(),lastReceiptPrefix:receipt.prefix,lastReceiptNumber:receipt.number};
        delete nm.installment; data[i]=nm;
        set('fp_monthly',data);set('fp_monthly_payments',payments);
        // Los pendientes de esta placa (fp_monthly_extra_charges) NO se tocan aquí: son cobros
        // que todavía no se han recibido. Se quitan de Pendientes únicamente cuando se confirme
        // el pago de cada uno en esa sección (confirmPending), sin importar si la mensualidad
        // ya se renovó o no.
        render();
        printMonthlyReceipt(nm,payment);
        fpAlert(installment?('Segundo pago registrado. Mensualidad renovada correctamente. Recibo '+receipt.prefix+receipt.number+'.'):('Pago de mensualidad confirmado (fuera de la caja). Se generó el recibo '+receipt.prefix+receipt.number+'.'));
      }else{
        const nm={...m,active:true,paymentStatus:'pending',installment:{targetStart:d.start,targetEnd:d.end,total:fullValue,paid:totalPaidNow}};
        data[i]=nm;
        set('fp_monthly',data);set('fp_monthly_payments',payments);render();
        printMonthlyReceipt({...m,start:d.start,end:d.end},payment);
        fpAlert('Primer pago quincenal registrado (recibo '+receipt.prefix+receipt.number+'). Saldo pendiente: '+money(fullValue-totalPaidNow)+'. Registre el segundo pago para completar la mensualidad.');
      }
    });
  }
  render();search.oninput=()=>{payPage=1;render()};
  if(searchLegacy) searchLegacy.oninput=()=>render();
  if(f.elements.start && f.elements.end){
    f.elements.start.addEventListener('change',()=>{
      f.elements.end.value=f.elements.start.value?fmtDateOnly(addCalendarMonthsDate(f.elements.start.value,1)):'';
    });
  }
  ['monthlyFrom','monthlyTo','monthlyPaymentFilter','monthlyStatusFilter'].forEach(id=>{const el=document.getElementById(id);if(el)el.onchange=()=>{payPage=1;render()}});
  f.onsubmit=e=>{
    e.preventDefault();
    const editing=f.dataset.i!==undefined;
    if(editing&&!isAdmin){fpAlert('Solo el Administrador puede modificar mensualidades existentes.','error');return;}
    const idx=editing?+f.dataset.i:-1;
    const plate=f.plate.value.trim().toUpperCase(), name=f.name.value.trim(), vehicle=f.vehicle.value, value=+f.value.value||0;
    if(!plate||!name){fpAlert('Nombre y placa son obligatorios.');return;}
    if(!editing && value<=0){fpAlert('El valor de la mensualidad debe ser mayor que cero.');return;}
    let start=f.start.value;
    if(!start){fpAlert('La fecha de inicio es obligatoria.');return;}
    let end=f.end.value;
    if(!end) end=fmtDateOnly(addCalendarMonthsDate(start,1));
    if(end<=start){fpAlert('La fecha fin debe ser posterior a la fecha de inicio.');return;}
    if(!editing){
      f.end.value=end;
      const activeSame=data.findIndex(m=>normPlateKey(m.plate)===normPlateKey(plate)&&m.active);
      if(activeSame>=0){fpAlert('La placa '+plate+' ya tiene una mensualidad vigente. Use "Pagar mensualidad" para renovarla.','error');return;}
      // Registrar una mensualidad crea el derecho/registro de servicio, pero NO cobra.
      // El pago se realiza posteriormente desde la lista de mensualidades.
      const clientDocument=f.document.value.trim();
      const schedule=(f.elements.schedule?.value==='night')?'night':'day';
      const nightEntryLimit=schedule==='night'?(f.elements.nightEntryLimit?.value||''):'';
      const nightExitLimit=schedule==='night'?(f.elements.nightExitLimit?.value||''):'';
      if(schedule==='night' && (!nightEntryLimit||!nightExitLimit)){
        fpAlert('Para una mensualidad de noche debe indicar la hora límite de entrada y la hora límite de salida.');return;
      }
      const biweekly=!!(f.elements.biweekly&&f.elements.biweekly.checked);
      const now=new Date();
      const x={
        id:'M'+Date.now(),document:clientDocument,name,plate,vehicle,start,end,value,schedule,
        nightEntryLimit,nightExitLimit,
        active:true,
        paymentStatus:'pending',
        biweekly,
        origen:'registro',
        createdAt:now.toISOString(),
        updatedAt:now.toISOString()
      };
      // No se crea fp_monthly_payments aquí: todavía no existe un pago.
      data.push(x);
      set('fp_monthly',data);
      delete f.dataset.i;
      f.reset();
      f.elements.active.checked=true;
      toggleScheduleFields();
      render();
      fpAlert('Mensualidad registrada. Quedó pendiente de pago y no generó ninguna venta ni movimiento de caja.');
      return;
    }
    const old=data[idx];
    /* Igual que en el alta: una placa no puede tener dos mensualidades vigentes a la vez.
     * Solo aplica si la mensualidad editada queda activa; se ignora a sí misma. */
    if(f.elements.active.checked){
      const dup=data.findIndex((m,j)=>j!==idx&&m&&m.active&&normPlateKey(m.plate)===normPlateKey(plate));
      if(dup>=0){fpAlert('La placa '+plate+' ya tiene otra mensualidad vigente. Desactive o elimine la otra antes de dejar esta activa.','error');return;}
    }
    const editSchedule=(f.elements.schedule?.value==='night')?'night':'day';
    const editNightEntryLimit=editSchedule==='night'?(f.elements.nightEntryLimit?.value||''):'';
    const editNightExitLimit=editSchedule==='night'?(f.elements.nightExitLimit?.value||''):'';
    if(editSchedule==='night' && (!editNightEntryLimit||!editNightExitLimit)){fpAlert('Para una mensualidad de noche debe indicar la hora límite de entrada y la hora límite de salida.');return;}
    // Se parte de {...old} para no perder campos que no están en este formulario
    // (paymentStatus, pendingConfirmation, confirmedAt/confirmedBy, lastPaymentDate,
    // lastReceiptPrefix/Number, etc.). Antes se reconstruía el objeto desde cero y al
    // guardar una edición se perdía paymentStatus:'pending', con lo que una mensualidad
    // pendiente de pago pasaba a verse como "Activo" y el botón "Pagar mensualidad"
    // desaparecía sin que el cliente hubiera pagado.
    const x={...old,document:f.document.value.trim(),name,plate,vehicle,start,end,value,schedule:editSchedule,nightEntryLimit:editNightEntryLimit,nightExitLimit:editNightExitLimit,active:f.elements.active.checked,biweekly:!!(f.elements.biweekly&&f.elements.biweekly.checked),installment:old.installment,origen:old.origen||'registro',createdAt:old.createdAt||new Date().toISOString(),updatedAt:new Date().toISOString()};
    data[idx]=x;set('fp_monthly',data);delete f.dataset.i;f.reset();f.elements.active.checked=true;toggleScheduleFields();render();fpAlert('Mensualidad guardada correctamente.');
  };
  document.getElementById('newMonthly').onclick=()=>{delete f.dataset.i;f.reset();f.elements.active.checked=true;toggleScheduleFields();};
  const reportBtn=document.getElementById('monthlyReportBtn');
  if(reportBtn)reportBtn.onclick=()=>{
    const fromVal=document.getElementById('monthlyFrom')?.value||'', toVal=document.getElementById('monthlyTo')?.value||'', methodVal=document.getElementById('monthlyPaymentFilter')?.value||'';
    showMonthlyReport(filteredPayments(),{from:fromVal,to:toVal,method:methodVal});
  };
  initMonthlyMigration();
  /* -----------------------------------------------------------------
   * Migración de mensualidades ya existentes (parqueaderos que venían
   * llevando el control por fuera antes de usar el sistema). A
   * diferencia del alta normal, estas filas no pasan por Caja: se
   * respeta la fecha de vencimiento real de cada cliente y quedan
   * marcadas con origen:'migracion' para diferenciarlas de las
   * registradas desde el formulario (origen:'registro').
   * ------------------------------------------------------------------- */
  function initMonthlyMigration(){
    const fileInput=document.getElementById('monthlyMigrationFile'), fileNameEl=document.getElementById('monthlyMigrationFileName'), previewBox=document.getElementById('monthlyMigrationPreview'), validCountEl=document.getElementById('monthlyMigrationValidCount'), errorCountEl=document.getElementById('monthlyMigrationErrorCount'), errorsBox=document.getElementById('monthlyMigrationErrors'), importBtn=document.getElementById('monthlyMigrationImportBtn'), templateBtn=document.getElementById('monthlyMigrationTemplate');
    if(!fileInput||!importBtn)return;
    let pendingRows=[];
    if(templateBtn)templateBtn.onclick=()=>{
      const csv='documento,nombre,placa,vehiculo,valor,fecha_vencimiento,fecha_inicio,horario,hora_entrada,hora_salida\n,Juan Perez,ABC123,Carro,130000,2026-10-15,,day,,\n1234567890,Maria Gomez,XYZ987,Moto,80.000,15/10/2026,,night,18:00,06:00\n';
      const blob=new Blob([csv],{type:'text/csv;charset=utf-8'}), a=document.createElement('a');
      a.href=URL.createObjectURL(blob);a.download='plantilla_mensualidades.csv';document.body.appendChild(a);a.click();a.remove();
    };
    fileInput.onchange=()=>{
      const file=fileInput.files&&fileInput.files[0]; if(!file)return;
      fileNameEl.textContent=file.name;
      const reader=new FileReader();
      reader.onload=()=>{
        const rows=parseCSVText(String(reader.result||''));
        if(!rows.length){fpAlert('El archivo está vacío.','error');previewBox.style.display='none';return;}
        const header=rows[0].map(normHeader);
        const col=(name)=>header.indexOf(name);
        const idx={documento:col('documento'),nombre:col('nombre'),placa:col('placa'),vehiculo:col('vehiculo'),valor:col('valor'),vence:col('fecha_vencimiento'),inicio:col('fecha_inicio'),horario:col('horario'),horaEntrada:col('hora_entrada')>=0?col('hora_entrada'):col('hora_entrada_limite'),horaSalida:col('hora_salida')>=0?col('hora_salida'):col('hora_salida_limite')};
        if(idx.nombre<0||idx.placa<0||idx.valor<0||idx.vence<0){fpAlert('El archivo debe tener al menos las columnas: nombre, placa, valor, fecha_vencimiento.','error');previewBox.style.display='none';return;}
        const seenPlates=new Set(data.filter(m=>m.active||m.pendingConfirmation).map(m=>String(m.plate||'').toUpperCase())), csvPlates=new Set(), valid=[], errors=[];
        rows.slice(1).forEach((r,i)=>{
          const line=i+2, g=(k)=>idx[k]>=0?String(r[idx[k]]??'').trim():'';
          const nombre=g('nombre'), placa=g('placa').toUpperCase().replace(/[\s-]/g,''), documento=g('documento'), vehiculo=g('vehiculo')||'Carro', valor=parseMoneyLoose(g('valor')), venceRaw=g('vence'), inicioRaw=g('inicio');
          const horarioRaw=normHeader(g('horario')), schedule=(horarioRaw==='night'||horarioRaw==='noche')?'night':'day', nightEntryLimit=g('horaEntrada'), nightExitLimit=g('horaSalida');
          const vence=parseFlexibleDate(venceRaw);
          if(!nombre){errors.push({line,reason:'falta el nombre'});return}
          if(!placa){errors.push({line,reason:'falta la placa'});return}
          if(!(valor>0)){errors.push({line,reason:'valor inválido'});return}
          if(!vence){errors.push({line,reason:'fecha_vencimiento inválida (use AAAA-MM-DD o DD/MM/AAAA)'});return}
          if(schedule==='night'&&(!nightEntryLimit||!nightExitLimit)){errors.push({line,reason:'horario noche requiere hora_entrada y hora_salida'});return}
          if(seenPlates.has(placa)){errors.push({line,reason:'la placa '+placa+' ya tiene una mensualidad activa o pendiente de confirmar'});return}
          if(csvPlates.has(placa)){errors.push({line,reason:'placa '+placa+' repetida en el archivo'});return}
          csvPlates.add(placa);
          const inicioParsed=parseFlexibleDate(inicioRaw);
          const inicio=inicioParsed||fmtDateOnly(addCalendarMonthsDate(vence,-1));
          valid.push({document:documento,name:nombre,plate:placa,vehicle:vehiculo,value:valor,start:inicio,end:vence,schedule,nightEntryLimit:schedule==='night'?nightEntryLimit:'',nightExitLimit:schedule==='night'?nightExitLimit:''});
        });
        pendingRows=valid;
        validCountEl.textContent=String(valid.length);errorCountEl.textContent=String(errors.length);
        errorsBox.innerHTML=errors.slice(0,20).map(e=>`<div class="fp-migration-error-row">Fila ${e.line}: ${esc(e.reason)}</div>`).join('')+(errors.length>20?`<div class="fp-migration-error-row">y ${errors.length-20} filas más con error…</div>`:'');
        importBtn.disabled=valid.length===0;
        previewBox.style.display='block';
      };
      reader.readAsText(file,'utf-8');
    };
    importBtn.onclick=()=>{
      if(!pendingRows.length)return;
      const now=new Date().toISOString();
      pendingRows.forEach((r,i)=>{data.push({id:'M'+Date.now()+'_'+i,document:r.document,name:r.name,plate:r.plate,vehicle:r.vehicle,start:r.start,end:r.end,value:r.value,schedule:r.schedule||'day',nightEntryLimit:r.nightEntryLimit||'',nightExitLimit:r.nightExitLimit||'',active:false,pendingConfirmation:true,biweekly:false,origen:'migracion',createdAt:now,updatedAt:now})});
      set('fp_monthly',data);
      const n=pendingRows.length; pendingRows=[];previewBox.style.display='none';fileInput.value='';fileNameEl.textContent='';
      render();
      fpAlert(n+' mensualidad'+(n===1?'':'es')+' importada'+(n===1?'':'s')+'. Quedaron pendientes de confirmar pago — use el botón "Confirmar pago" en cada fila para activarlas.');
    };
  }
}

function showCashToast(message,kind){const old=document.getElementById('fp-cash-toast');if(old)old.remove();const t=document.createElement('div');t.id='fp-cash-toast';t.textContent=message;t.style.cssText='position:fixed;top:24px;right:24px;z-index:99999;padding:11px 18px;border-radius:8px;background:'+(kind==='success'?'#0b2748':'#b45309')+';color:#fff;font-weight:600;box-shadow:0 8px 24px rgba(0,0,0,.18);opacity:1;transition:opacity .25s ease';document.body.appendChild(t);setTimeout(()=>{t.style.opacity='0';setTimeout(()=>t.remove(),260)},740)}
/* ---------------------------------------------------------------------
 * Pendientes: cobros que todavía no se han cobrado. Se generan cuando, al
 * dar salida en Entradas a una placa con mensualidad fuera del horario
 * cubierto (ParkApp.html > payMonthlyLinkedExit), NO se cobra ahí: se
 * cierra la entrada (sale del parqueadero) y se guarda como pendiente aquí.
 * El registro en fp_monthly_extra_charges queda con confirmed:false y la
 * entrada original con pendingMonthlyConfirmation:true (sin
 * paymentMethod/cashAmount/nequiAmount/registerId), así que todavía no
 * cuenta como venta en Ventas/Reportes/Caja (ver los filtros
 * !e.pendingMonthlyConfirmation en initPayments/initReports/initCash).
 * Solo cuando se pulsa "Confirmar pago" aquí (confirmPending) se completa
 * la información de pago en la entrada original y recién ahí se convierte
 * en una venta real. No se limpia automáticamente: son cobros
 * independientes que se deben confirmar uno a uno.
 * ------------------------------------------------------------------- */
function initPending(){
  const tb=document.querySelector('#pendingTable tbody'), pager=document.getElementById('pendingPager');
  const fromEl=document.getElementById('pendingFrom'), toEl=document.getElementById('pendingTo'), searchEl=document.getElementById('pendingSearch');
  const totalAmountEl=document.getElementById('pendingTotalAmount'), totalCountEl=document.getElementById('pendingTotalCount');
  let page=1; const pageSize=10;
  function monthlyFor(monthlyId){return get('fp_monthly',[]).find(m=>String(m.id)===String(monthlyId))||null}
  // Reparte un total entero entre varios "pesos" (montos originales) sin perder ni un peso
  // por redondeo: primero reparte por piso proporcional y el resto (unos pocos pesos) se lo
  // lleva quien tenga el residuo más grande.
  function distributeProportional(total,weights){
    total=Math.round(total)||0;
    const sumW=weights.reduce((a,w)=>a+(+w||0),0);
    if(!weights.length)return [];
    if(sumW<=0)return weights.map((_,i)=>i===0?total:0);
    const raw=weights.map(w=>total*(+w||0)/sumW);
    const floors=raw.map(Math.floor);
    let assigned=floors.reduce((a,b)=>a+b,0);
    let remainder=total-assigned;
    const order=raw.map((r,i)=>({i,frac:r-floors[i]})).sort((a,b)=>b.frac-a.frac);
    for(let k=0;k<remainder && k<order.length;k++)floors[order[k].i]++;
    return floors;
  }
  // Agrupa los cobros pendientes por mensualidad (o por placa si no hay monthlyId) para que,
  // si la misma placa vuelve a salir fuera de horario varias veces antes de pagar, no se
  // acumulen filas repetidas: se muestra una sola fila con el total sumado hasta que se
  // confirme el pago (ahí se liquidan todas las salidas incluidas de una vez).
  function groupPending(items){
    const groups=new Map();
    items.forEach(x=>{
      const key=x.monthlyId?('M:'+x.monthlyId):('P:'+String(x.plate||'').toUpperCase());
      if(!groups.has(key))groups.set(key,{key,monthlyId:x.monthlyId,plate:x.plate,clientName:x.clientName,monthlyEnd:x.monthlyEnd,items:[],amount:0,lastDate:null,receiptPrefix:x.receiptPrefix,receiptNumber:x.receiptNumber});
      const g=groups.get(key);
      g.items.push(x); g.amount+=(+x.amount||0);
      const d=parseFPDate(x.dateTime);
      if(!g.lastDate||(d&&d>g.lastDate)){g.lastDate=d;g.receiptPrefix=x.receiptPrefix;g.receiptNumber=x.receiptNumber;}
    });
    return Array.from(groups.values());
  }
  function render(){
    const monthly=get('fp_monthly',[]);
    const from=fromEl.value?new Date(fromEl.value+'T00:00:00'):null, to=toEl.value?new Date(toEl.value+'T23:59:59'):null;
    const q=(searchEl.value||'').trim().toLowerCase();
    let flat=get('fp_monthly_extra_charges',[]).filter(x=>x.confirmed!==true).map(x=>{
      const m=monthlyFor(x.monthlyId);
      return Object.assign({},x,{clientName:m?.name||'',monthlyEnd:m?.end||''});
    }).filter(x=>{
      const d=parseFPDate(x.dateTime);
      if(from&&(!d||d<from))return false;
      if(to&&(!d||d>to))return false;
      if(q&&!(String(x.plate||'').toLowerCase().includes(q)||String(x.clientName||'').toLowerCase().includes(q)))return false;
      return true;
    });
    let rows=groupPending(flat).sort((a,b)=>(b.lastDate||0)-(a.lastDate||0));
    const pages=Math.max(1,Math.ceil(rows.length/pageSize)); if(page>pages)page=pages;
    const pageRows=rows.slice((page-1)*pageSize,page*pageSize);
    tb.innerHTML=pageRows.map(x=>`<tr><td>${esc(x.receiptPrefix||'FA')}${esc(x.receiptNumber||'')}${x.items.length>1?' (+'+(x.items.length-1)+')':''}</td><td>${esc(String(x.plate||'').toUpperCase())}</td><td>${esc(x.clientName||'—')}</td><td>${esc(fmt24(x.lastDate))}${x.items.length>1?'<br><small style="color:#697382">'+x.items.length+' salidas pendientes</small>':''}</td><td>${money(x.amount)}</td><td>${x.monthlyEnd?esc(fmtDateEs(x.monthlyEnd)):'—'}</td><td><button type="button" class="btn btn-sm btn-primary confirmPending" data-key="${esc(x.key)}">Confirmar pago</button> <button type="button" class="btn btn-sm btn-default viewHistory" data-plate="${esc(String(x.plate||'').toUpperCase())}">Historial</button></td></tr>`).join('')||'<tr><td colspan="7">No hay cobros pendientes de confirmar.</td></tr>';
    totalAmountEl.textContent=money(flat.reduce((a,x)=>a+(+x.amount||0),0));
    totalCountEl.textContent=String(rows.length);
    tb.querySelectorAll('.confirmPending').forEach(b=>b.onclick=()=>{
      const group=rows.find(x=>x.key===b.dataset.key);
      if(group) confirmPending(group);
    });
    tb.querySelectorAll('.viewHistory').forEach(b=>b.onclick=()=>showPlateHistory(b.dataset.plate));
    if(pager){
      const maxBtns=5; let start=Math.max(1,page-2),end=Math.min(pages,start+maxBtns-1);start=Math.max(1,end-maxBtns+1);
      let nums=''; for(let n=start;n<=end;n++)nums+=`<button type="button" class="${n===page?'active':''}" data-page="${n}">${n}</button>`;
      pager.innerHTML=`<button type="button" data-page="prev" ${page<=1?'disabled':''}>‹ Anterior</button>${nums}<button type="button" data-page="next" ${page>=pages?'disabled':''}>Siguiente ›</button><span class="fp-page-count">Mostrando ${rows.length?((page-1)*pageSize+1):0} a ${Math.min(page*pageSize,rows.length)} de ${rows.length} pendientes</span>`;
      pager.querySelectorAll('button').forEach(b=>b.onclick=()=>{const v=b.dataset.page;if(v==='prev'&&page>1)page--;else if(v==='next'&&page<pages)page++;else if(!isNaN(+v))page=+v;render()});
    }
  }
  // Historial de una placa: TODOS sus registros (entrada, salida y valor a cobrar/cobrado),
  // vengan de fp_entries o del archivo fp_entries_archive (entriesFull() une ambos).
  function showPlateHistory(plate){
    const wanted=String(plate||'').trim().toUpperCase();
    const overlay=document.getElementById('historyOverlay'), tbody=document.querySelector('#historyTable tbody'), label=document.getElementById('historyPlateLabel');
    if(!overlay||!tbody) return;
    if(label) label.textContent=wanted;
    const rows=entriesFull().filter(e=>String(e.placa||'').trim().toUpperCase()===wanted)
      .sort((a,b)=>(parseFPDate(b.entradaFecha)||0)-(parseFPDate(a.entradaFecha)||0));
    tbody.innerHTML=rows.map(e=>{
      const entrada=parseFPDate(e.entradaFecha), salida=parseFPDate(e.salidaFecha);
      return `<tr><td>${entrada?esc(fmt24(entrada)):'—'}</td><td>${salida?esc(fmt24(salida)):'—'}</td><td>${e.total!=null?money(e.total):'—'}</td></tr>`;
    }).join('')||'<tr><td colspan="3">Esta placa no tiene registros.</td></tr>';
    overlay.style.display='flex';
  }
  const historyOverlay=document.getElementById('historyOverlay');
  if(historyOverlay){
    const closeHistory=()=>{historyOverlay.style.display='none'};
    const hCloseBtn=document.getElementById('historyCloseBtn'), hCancelBtn=document.getElementById('historyCancelBtn');
    if(hCloseBtn) hCloseBtn.onclick=closeHistory;
    if(hCancelBtn) hCancelBtn.onclick=closeHistory;
    historyOverlay.addEventListener('click',e=>{if(e.target===historyOverlay)closeHistory()});
  }
  // Confirma el pago de un GRUPO (una o varias salidas de la misma placa/mensualidad que
  // seguían sin pagarse). El monto, método de pago y descuento elegidos en el modal se
  // reparten proporcionalmente entre cada salida incluida, para dejar cada entrada original
  // (y cada registro de fp_monthly_extra_charges) con su propio valor correcto.
  function confirmPending(group){
    const reg=get('fp_cash_register',null);
    if(!reg){fpAlert('Debe abrir la caja (Cierre de caja) antes de confirmar este pago.');return;}
    const label='Cobro pendiente '+String(group.plate||'').toUpperCase()+(group.items.length>1?' ('+group.items.length+' salidas)':'');
    fpOpenPaymentModal(Number(group.amount)||0,label,function(pm,cashAmount,nequiAmount,chargeAmount,discountAmount){
      const groupTotal=Math.round(chargeAmount!=null?chargeAmount:(Number(group.amount)||0));
      const weights=group.items.map(it=>Number(it.amount)||0);
      const perItemTotal=distributeProportional(groupTotal,weights);
      const perItemCash=distributeProportional(Math.round(cashAmount)||0,perItemTotal);
      const idToTotal=new Map(), idToCash=new Map(), idToNequi=new Map();
      group.items.forEach((it,i)=>{
        idToTotal.set(String(it.entryId),perItemTotal[i]);
        idToCash.set(String(it.entryId),perItemCash[i]);
        idToNequi.set(String(it.entryId),Math.max(0,perItemTotal[i]-perItemCash[i]));
      });
      const pendingIds=new Set(group.items.map(it=>String(it.entryId)));
      let updatedCount=0;
      ['fp_entries',ARCHIVE_KEY].forEach(function(k){
        const arr=get(k,[]);
        if(!Array.isArray(arr)||!arr.length)return;
        let changed=false;
        const next=arr.map(function(e){
          if(e && pendingIds.has(String(e.id))){
            changed=true; updatedCount++;
            const idStr=String(e.id);
            const newTotal=idToTotal.get(idStr)??e.total;
            const extraDiscount=Math.max(0,(Number(e.total)||0)-newTotal);
            const totalDiscount=(Number(e.discountAmount)||0)+extraDiscount;
            return Object.assign({},e,{paymentMethod:pm,idTipoPago:pm,cashAmount:idToCash.get(idStr)??0,nequiAmount:idToNequi.get(idStr)??0,registerId:reg.id,pendingMonthlyConfirmation:false,total:newTotal,discountAmount:totalDiscount,discountType:totalDiscount>0?'charged':(e.discountType||'none'),discountReason:extraDiscount>0?(e.discountReason?e.discountReason+' + descuento al confirmar pago':'Descuento aplicado al confirmar pago'):e.discountReason});
          }
          return e;
        });
        if(changed)set(k,next);
      });
      if(!updatedCount){fpAlert('No se encontraron las entradas originales de esta placa; no fue posible confirmar el pago.');return;}
      const groupIds=new Set(group.items.map(it=>String(it.id)));
      const allExtra=get('fp_monthly_extra_charges',[]).map(function(x){
        if(!groupIds.has(String(x.id)))return x;
        const newAmount=idToTotal.get(String(x.entryId));
        return Object.assign({},x,{confirmed:true,confirmedAt:new Date().toISOString(),amount:newAmount!=null?newAmount:x.amount});
      });
      set('fp_monthly_extra_charges',allExtra);
      fpAlert(group.items.length>1?('Pago confirmado. Se liquidaron las '+group.items.length+' salidas pendientes de '+String(group.plate||'').toUpperCase()+' como venta en Entradas, Ventas y Caja.'):'Pago confirmado. Quedó registrado como venta en Entradas, Ventas y Caja.');
      render();
    });
  }
  [fromEl,toEl].forEach(el=>el.onchange=()=>{page=1;render()});
  searchEl.oninput=()=>{page=1;render()};
  render();
}
function initCash(){
 ensure();
 const R='fp_cash_register', C='fp_cash_closings', E='fp_expenses', I='fp_incomes';
 const f=document.getElementById('cashOpenForm'), cf=document.getElementById('cashCloseForm'), status=document.getElementById('cashStatus');
 const normalizeMoneyInput=(input)=>{if(!input)return; input.addEventListener('focus',()=>{if(input.value==='0')input.value='';}); input.addEventListener('blur',()=>{if(input.value===''){input.value='0';}else{let n=Number(input.value)||0;input.value=String(n);}});};
 if(cf)normalizeMoneyInput(cf.querySelector('[name="physicalCash"]'));
 if(f)normalizeMoneyInput(f.querySelector('[name="initialCash"]'));
 function getReg(){return get(R,null)}
 function parkSales(reg){
   // Igual que en initPayments/initReports: una salida vinculada a mensualidad que todavía
   // no se confirmó en Pendientes no es una venta y no debe sumar aquí. Antes esto "funcionaba"
   // solo porque esas entradas aún no tienen registerId asignado; se filtra explícito por claridad
   // y para no depender de ese detalle implícito.
   return entries().filter(e=>e.salidaFecha && !e.pendingMonthlyConfirmation && (!reg || !reg.id || e.registerId===reg.id));
 }
 // Los pagos de mensualidades NO se muestran ni suman en Cierre de Caja (ni en el resumen que
 // se genera al cerrar): tienen su propio reporte en Mensualidades ("Reporte de mensualidades").
 function expenses(reg){return get(E,[]).filter(x=>!reg || !reg.id || x.registerId===reg.id);}
 function incomes(reg){return get(I,[]).filter(x=>!reg || !reg.id || x.registerId===reg.id);}
 // Movimientos de base (Transacciones > "Base +" / "Base −", en naranja): NO son ingresos ni egresos,
 // solo ajustan la "Base del día". No entran al efectivo esperado ni a Reportes.
 function baseInList(reg){return get('fp_base_in',[]).filter(x=>x && (!reg || !reg.id || x.registerId===reg.id));}
 function baseOutList(reg){return get('fp_base_out',[]).filter(x=>x && (!reg || !reg.id || x.registerId===reg.id));}
 function sumAmt(a){return a.reduce((s,x)=>s+(+x.amount||0),0);}
 let page=1, pageSize=10;
 // El Empleado solo registra el valor total de dinero al cerrar caja: no ve
 // bases, ventas, efectivo esperado, movimientos ni el detalle de ventas.
 const isAdmin=isAdminLevelRole((get(KEY.user,defaults.user)||{}).role);
 const adminInfo=document.getElementById('cashAdminInfo');
 if(adminInfo)adminInfo.style.display=isAdmin?'':'none';
 function render(){
   const reg=getReg();
   if(!reg){
     status.textContent='Caja cerrada. Abra una caja para iniciar el control de ventas.'; status.className='alert alert-warning';
     if(f)f.style.display='flex'; if(cf)cf.style.display='none'; return;
   }
   status.textContent=isAdmin?('Caja abierta desde '+fmt24(reg.openedAt)+' por '+(reg.openedBy||'')):'Caja abierta.'; status.className='alert alert-success';
   if(f)f.style.display='none'; if(cf)cf.style.display='flex';
   if(!isAdmin)return;
   const ps=parkSales(reg), ex=expenses(reg), inc=incomes(reg), sales=[...ps];
   const totalPark=ps.reduce((a,x)=>a+(+x.total||0),0), totalSales=totalPark, eg=ex.reduce((a,x)=>a+(+x.amount||0),0), ig=inc.reduce((a,x)=>a+(+x.amount||0),0);
   const salesCash=sales.reduce((a,x)=>a+cashPart(x),0), salesElectronic=totalSales-salesCash;
   const totalDiscounts=sales.reduce((a,x)=>a+(+x.discountAmount||0),0);
   const expected=salesCash+ig-eg;
   const bIn=sumAmt(baseInList(reg)), bOut=sumAmt(baseOutList(reg)), baseTotal=(+reg.initialCash||0)+bIn-bOut;
   ['cashBase','cashSales','cashElectronic','cashIncomes','cashExpenses','cashExpected'].forEach((id,i)=>{let el=document.getElementById(id); if(el)el.textContent=money([baseTotal,totalSales,salesElectronic,ig,eg,expected][i])});
   const bd=document.getElementById('cashBaseDetail');
   if(bd){ if(bIn||bOut){bd.style.display='block';bd.textContent='Inicial '+money(reg.initialCash||0)+(bIn?' · + '+money(bIn):'')+(bOut?' · − '+money(bOut):'');}else{bd.style.display='none';bd.textContent='';} }
   let discEl=document.getElementById('cashDiscounts');if(discEl)discEl.textContent=money(totalDiscounts);
   let ct=document.getElementById('cashCount');if(ct)ct.textContent=sales.length;
   const cfg0=get(KEY.config,defaults.config)||{};const rp=cfg0.receiptPrefix||'FA';
   let receiptNums=ps.map(x=>parseInt(x.reciboNumero||x.receiptNumber,10)).filter(n=>isFinite(n)).sort((a,b)=>a-b);
   let rs=document.getElementById('cashReceiptStart'),re=document.getElementById('cashReceiptEnd');
   if(rs)rs.textContent=receiptNums.length?rp+receiptNums[0]:'—';if(re)re.textContent=receiptNums.length?rp+receiptNums[receiptNums.length-1]:'—';
   const pages=Math.max(1,Math.ceil(sales.length/pageSize)); if(page>pages)page=pages;
   const rows=sales.slice().sort((a,b)=>(parseFPDate(b.salidaFecha)||0)-(parseFPDate(a.salidaFecha)||0)).slice((page-1)*pageSize,page*pageSize);
   let tb=document.querySelector('#cashSalesTable tbody');
   if(tb)tb.innerHTML=rows.map(e=>`<tr><td>${esc(e.reciboPrefijo||'FA')}${esc(e.reciboNumero||'')}</td><td>${esc(e.placa||e.plate||'')}</td><td>${esc(e.salidaFecha||e.dateTime||'')}</td><td>${esc(paymentLabel(e))}</td><td${(+e.discountAmount>0)?' style="color:#e53935;font-weight:700" title="Venta con descuento aplicado"':''}>${money(e.total||0)}</td><td>${money(e.cashAmount||0)}</td><td>${money(e.nequiAmount||0)}</td></tr>`).join('')||'<tr><td colspan="7">No hay ventas en esta caja.</td></tr>';
   let pager=document.getElementById('cashSalesPager');
   if(!pager){
     const table=document.getElementById('cashSalesTable');
     if(table){pager=document.createElement('div');pager.id='cashSalesPager';pager.className='text-center';pager.style.marginTop='15px';table.parentNode.appendChild(pager);}
   }
   if(pager){
     pager.innerHTML=`<button type="button" class="btn btn-sm btn-default" id="cashPrev" ${page<=1?'disabled':''}>Anterior</button> <span style="display:inline-block;margin:0 12px;line-height:32px">Página ${page} de ${pages} · ${sales.length} ventas</span> <button type="button" class="btn btn-sm btn-default" id="cashNext" ${page>=pages?'disabled':''}>Siguiente</button>`;
     const pv=document.getElementById('cashPrev'),nx=document.getElementById('cashNext');
     if(pv)pv.onclick=()=>{if(page>1){page--;render()}};
     if(nx)nx.onclick=()=>{if(page<pages){page++;render()}};
   }
 }
 if(f)f.onsubmit=e=>{e.preventDefault();if(getReg()){fpAlert('Ya existe una caja abierta.','error');return;}let u=get(KEY.user,defaults.user);let reg={id:'R'+Date.now(),openedAt:new Date().toISOString(),openedBy:u.name||u.username,initialCash:+f.initialCash.value||0,observation:f.observation.value||''};set(R,reg);page=1;render();showCashToast('Caja abierta correctamente.','success')};
 if(cf)cf.onsubmit=e=>{
   e.preventDefault();let reg=getReg();if(!reg){fpAlert('No hay caja abierta.','error');return;}
   let ps=parkSales(reg),ex=expenses(reg),inc=incomes(reg),sales=[...ps],salesCash=sales.reduce((a,x)=>a+cashPart(x),0),totalPark=ps.reduce((a,x)=>a+(+x.total||0),0),totalSales=totalPark,salesElectronic=totalSales-salesCash,eg=ex.reduce((a,x)=>a+(+x.amount||0),0),ig=inc.reduce((a,x)=>a+(+x.amount||0),0),physical=+cf.physicalCash.value||0,expected=salesCash+ig-eg,diff=physical-expected,bInL=baseInList(reg),bOutL=baseOutList(reg),bIn=sumAmt(bInL),bOut=sumAmt(bOutL),baseFinal=(+reg.initialCash||0)+bIn-bOut,u=get(KEY.user,defaults.user),cs=get(C,[]);
   const cfg1=get(KEY.config,defaults.config)||{},receiptPrefix=cfg1.receiptPrefix||'FA';
   const receiptNums=ps.map(x=>parseInt(x.reciboNumero||x.receiptNumber,10)).filter(n=>isFinite(n)).sort((a,b)=>a-b),receiptStart=receiptNums.length?receiptNums[0]:null,receiptEnd=receiptNums.length?receiptNums[receiptNums.length-1]:null;
   const closedAt=new Date().toISOString();
   fpConfirm('¿Está seguro de que desea cerrar la caja?\n\nEste proceso finalizará la caja actual y registrará el cierre.\nSi pulsa Cancelar, el cierre NO se realizará.',()=>{
   cs.push({id:'C'+Date.now(),registerId:reg.id,openedAt:reg.openedAt,closedAt,openedBy:reg.openedBy,closedBy:u.name||u.username,initialCash:+reg.initialCash||0,baseAdded:bIn,baseRemoved:bOut,baseFinal:baseFinal,totalSales:totalSales,totalPark:totalPark,totalElectronic:salesElectronic,totalEgresos:eg,totalIngresosManuales:ig,expectedCash:expected,physicalCash:physical,difference:diff,status:diff===0?'balanced':diff>0?'surplus':'deficit',receiptStart,receiptEnd,receiptCount:receiptNums.length,observation:cf.observation.value||''});
   set(C,cs);localStorage.removeItem(R);cf.reset();page=1;render();
   // El resumen detallado del cierre (bases, ventas, diferencia, etc.) solo se
   // muestra al Administrador; el Empleado únicamente ve la confirmación.
   if(isAdmin)showCashCloseSummary({reg,ps,ex,inc,bin:bInL,bout:bOutL,baseAdded:bIn,baseRemoved:bOut,baseFinal,totalPark,totalSales,salesElectronic,eg,ig,physical,expected,diff,receiptStart,receiptEnd,receiptCount:receiptNums.length,receiptPrefix,closedAt,closedBy:u.name||u.username,status:diff===0?'balanced':diff>0?'surplus':'deficit',observation:cf.observation.value||''});
   showCashToast('Caja cerrada correctamente.','success');
   },{okText:'Cerrar caja'});
 };
 render();window.addEventListener('storage',()=>render());
}
function buildCashCloseHtml(d){
  const fmt=x=>fmt24(x);
  const statusLabel={balanced:'Cuadrada',surplus:'Sobrante',deficit:'Faltante'}[d.status]||(d.status?esc(d.status):'—');
  const allSales=(d.ps||[]).slice().sort((a,b)=>(parseFPDate(a.salidaFecha)||0)-(parseFPDate(b.salidaFecha)||0));
  const rows=allSales.map(x=>`<tr><td>${esc(x.reciboPrefijo||x.receiptPrefix||'FA')}${esc(x.reciboNumero||x.receiptNumber||'')}</td><td>${esc(x.placa||x.plate||'')}</td><td>${esc(paymentLabel(x))}</td><td>${money(x.total||0)}</td><td>${money(x.cashAmount||0)}</td><td>${money(x.nequiAmount||0)}</td><td>${esc(fmt(x.salidaFecha))}</td></tr>`).join('')||'<tr><td colspan="7">Sin ventas de parqueadero.</td></tr>';
  const ex=d.ex.map(x=>`<tr><td>${esc(fmt(x.dateTime))}</td><td>${esc(x.concept)||'—'}</td><td>${money(x.amount||0)}</td><td>${esc(x.user||'')}</td></tr>`).join('')||'<tr><td colspan="4">Sin egresos.</td></tr>';
  const bAdd=+d.baseAdded||0,bRem=+d.baseRemoved||0;
  const baseShown=d.baseFinal!=null?d.baseFinal:(d.reg.initialCash||0);
  const baseNote=(bAdd||bRem)?`<span style="display:block;font-size:10px;color:#e67e00;font-weight:400;margin-top:3px">Inicial ${money(d.reg.initialCash||0)}${bAdd?' · + '+money(bAdd):''}${bRem?' · − '+money(bRem):''}</span>`:'';
  const baseList=[].concat((d.bin||[]).map(x=>({x,s:'+ '})),(d.bout||[]).map(x=>({x,s:'− '}))).sort((a,b)=>(parseFPDate(a.x.dateTime)||0)-(parseFPDate(b.x.dateTime)||0));
  const baseSection=baseList.length?`<h2 style="color:#e67e00;border-bottom-color:#f5b26b">Movimientos de base del día</h2><table><thead><tr><th>Fecha</th><th>Concepto</th><th>Valor</th><th>Usuario</th></tr></thead><tbody>${baseList.map(r=>`<tr style="background:#fff3e0"><td>${esc(fmt(r.x.dateTime))}</td><td>${esc(r.x.concept)||'—'}</td><td>${r.s}${money(r.x.amount||0)}</td><td>${esc(r.x.user||'')}</td></tr>`).join('')}</tbody></table>`:'';
  const incRows=(d.inc||[]).map(x=>`<tr><td>${esc(fmt(x.dateTime))}</td><td>${esc(x.concept)||'—'}</td><td>${money(x.amount||0)}</td><td>${esc(x.user||'')}</td></tr>`).join('')||'<tr><td colspan="4">Sin ingresos manuales.</td></tr>';
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Cierre de caja</title><style>body{font-family:Arial,sans-serif;padding:24px;color:#222}h1{text-align:center;font-size:22px;margin:0 0 8px}h2{font-size:16px;margin:20px 0 8px;border-bottom:1px solid #ccc;padding-bottom:5px}.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}.box{border:1px solid #ddd;padding:10px;border-radius:6px}.box b{display:block;font-size:15px;margin-top:4px}table{width:100%;border-collapse:collapse;font-size:11px}th,td{border:1px solid #ddd;padding:6px;text-align:left}th{background:#f3f3f3}.right{text-align:right}.note{margin-top:18px;font-size:12px;color:#666}.obs{margin-top:14px;border:1px solid #ddd;border-radius:6px;padding:10px;font-size:12px;background:#fafafa}.obs b{display:block;margin-bottom:4px;font-size:12px}</style></head><body><h1>RESUMEN DE CIERRE DE CAJA</h1><div class="note">Apertura: ${esc(fmt(d.reg.openedAt))} · Cierre: ${esc(fmt(d.closedAt))} · Abrió: ${esc(d.reg.openedBy||'')} · Cerró: ${esc(d.closedBy||'')} · Estado: ${statusLabel}</div><div class="grid"><div class="box">Base del día<b>${money(baseShown)}</b>${baseNote}</div><div class="box">Ventas (parqueadero)<b>${money(d.totalSales!=null?d.totalSales:(d.totalPark||0))}</b></div><div class="box">Pagos electrónicos<b>${money(d.salesElectronic)}</b></div><div class="box">Ingresos manuales<b>${money(d.ig||0)}</b></div><div class="box">Egresos<b>${money(d.eg)}</b></div><div class="box">Efectivo esperado<b>${money(d.expected)}</b></div><div class="box">Efectivo físico<b>${money(d.physical)}</b></div><div class="box">Diferencia<b>${money(d.diff)}</b></div><div class="box">Recibo inicial<b>${d.receiptStart?d.receiptPrefix+d.receiptStart:'N/A'}</b></div><div class="box">Recibo final<b>${d.receiptEnd?d.receiptPrefix+d.receiptEnd:'N/A'}</b></div><div class="box">Recibos emitidos<b>${d.receiptCount!=null?d.receiptCount:d.ps.length}</b></div></div>${d.observation?('<div class="obs"><b>Observación del cierre</b>'+esc(d.observation)+'</div>'):''}<h2>Ingresos manuales del día</h2><table><thead><tr><th>Fecha</th><th>Concepto</th><th>Valor</th><th>Usuario</th></tr></thead><tbody>${incRows}</tbody></table><h2>Egresos del día</h2><table><thead><tr><th>Fecha</th><th>Concepto</th><th>Valor</th><th>Usuario</th></tr></thead><tbody>${ex}</tbody></table>${baseSection}<h2>Ventas de parqueadero del día</h2><table><thead><tr><th>Recibo</th><th>Placa</th><th>Forma de pago</th><th>Total</th><th>Efectivo</th><th>Nequi</th><th>Fecha</th></tr></thead><tbody>${rows}</tbody></table><p class="note">Este resumen incluye únicamente las ventas de parqueadero (entradas/salidas), los ingresos manuales y los egresos de esta caja. Los pagos de mensualidades no se incluyen aquí; tienen su propio reporte en Mensualidades ("Reporte de mensualidades").</p></body></html>`;
}
function showCashCloseSummary(d){
  try{
  const html=buildCashCloseHtml(d);
  const w=window.open('','_blank','width=900,height=750');if(!w){fpAlert('El navegador bloqueó la ventana del resumen. Permita ventanas emergentes para FacaParking.','error');return;}
  w.document.write(html);w.document.close();w.focus();}catch(err){console.error(err);fpAlert('La caja se cerró correctamente, pero no fue posible mostrar el resumen.');}
}
function downloadCashCloseReport(d){
  try{
  const html=buildCashCloseHtml(d);
  const blob=new Blob([html],{type:'text/html;charset=utf-8'});
  const url=URL.createObjectURL(blob);
  const stamp=(d.closedAt?new Date(d.closedAt):new Date());
  const name='cierre_caja_'+stamp.getFullYear()+pad2(stamp.getMonth()+1)+pad2(stamp.getDate())+'_'+pad2(stamp.getHours())+pad2(stamp.getMinutes())+'.html';
  const a=document.createElement('a');a.href=url;a.download=name;document.body.appendChild(a);a.click();
  setTimeout(()=>{a.remove();URL.revokeObjectURL(url)},1500);
  }catch(err){console.error(err);fpAlert('No fue posible descargar el reporte.');}
}

/* Fábrica genérica para las dos secciones de Transacciones (Ingresos y Egresos):
 * ambas tienen el mismo formulario/tabla/modal, solo cambian la llave de
 * localStorage, los ids del DOM y los textos. kind='income'|'expense'. */
/* Transacciones: una sola pantalla con todos los movimientos manuales de dinero.
 * Se registran desde un único botón/formulario (tipo, valor y concepto) y se listan juntos en una
 * tabla: en verde los ingresos, en rojo los egresos y en NARANJA los movimientos de base
 * ("Base +" agrega dinero a la base del día, "Base −" lo quita). Por debajo cada tipo sigue guardándose
 * en su propia lista (fp_incomes / fp_expenses / fp_base_in / fp_base_out) porque Caja, el cierre de
 * caja y Reportes las leen por separado. Los movimientos de base NO son ingreso ni egreso: solo
 * modifican la "Base del día" y no afectan el efectivo esperado ni Reportes. */
function initExpenses(){
 ensure();
 const TYPES={
  income:{key:'fp_incomes',prefix:'I',label:'Ingreso',noun:'ingreso',cls:'fp-mov-in',sign:'+ ',saved:'Ingreso registrado.'},
  expense:{key:'fp_expenses',prefix:'E',label:'Egreso',noun:'egreso',cls:'fp-mov-out',sign:'− ',saved:'Egreso registrado.'},
  base_in:{key:'fp_base_in',prefix:'BI',label:'Base +',noun:'movimiento de base',cls:'fp-mov-base',sign:'+ ',saved:'Dinero agregado a la base.',base:true},
  base_out:{key:'fp_base_out',prefix:'BO',label:'Base −',noun:'movimiento de base',cls:'fp-mov-base',sign:'− ',saved:'Dinero quitado de la base.',base:true}
 };
 const tb=document.querySelector('#movementsTable tbody'),overlay=document.getElementById('movementOverlay');
 if(!tb||!overlay)return;
 const $=id=>document.getElementById(id);
 const conceptEl=$('movementConcept'),amountEl=$('movementAmount'),msg=$('movementMsg'),titleEl=$('movementTitle'),saveBtn=$('movementSaveBtn'),baseInfo=$('movementBaseInfo');
 const typeBtns=overlay.querySelectorAll('.fp-mov-toggle button');
 let mode='new',editing=null,curType='';
 const ts=x=>{const t=new Date(x&&x.dateTime).getTime();return isNaN(t)?0:t};
 /* Base de la caja abierta = base inicial + "Base +" − "Base −" de esa caja. */
 const sumAmt=a=>a.reduce((s,x)=>s+(+(x&&x.amount)||0),0);
 function baseValue(reg,ins,outs){const mine=x=>x&&x.registerId===reg.id;return (+reg.initialCash||0)+sumAmt(ins.filter(mine))-sumAmt(outs.filter(mine))}
 function baseNow(reg){return baseValue(reg,get('fp_base_in',[]),get('fp_base_out',[]))}
 /* Base que quedaría si se quita el movimiento (removeType/removeId) y/o se agrega uno nuevo
  * (addType/addAmount): sirve para no permitir que la base quede en negativo. */
 function baseIfChanged(reg,removeType,removeId,addType,addAmount){
  let ins=get('fp_base_in',[]).slice(),outs=get('fp_base_out',[]).slice();
  const notIt=x=>!x||String(x.id)!==String(removeId);
  if(removeType==='base_in')ins=ins.filter(notIt);
  if(removeType==='base_out')outs=outs.filter(notIt);
  if(addType==='base_in')ins.push({amount:addAmount,registerId:reg.id});
  if(addType==='base_out')outs.push({amount:addAmount,registerId:reg.id});
  return baseValue(reg,ins,outs);
 }
 function renderBaseInfo(){
  if(!baseInfo)return;
  const reg=get('fp_cash_register',null);
  if(!reg){baseInfo.textContent='';return}
  baseInfo.textContent='Base actual: '+money(baseNow(reg));
 }
 function render(){
  const rows=[];
  Object.keys(TYPES).forEach(t=>{const a=get(TYPES[t].key,[]);if(Array.isArray(a))a.forEach((x,i)=>{if(x)rows.push({t,x,i})})});
  rows.sort((a,b)=>ts(b.x)-ts(a.x)||b.i-a.i);
  tb.innerHTML=rows.map(r=>{const T=TYPES[r.t],x=r.x,nn=T.noun;return `<tr class="${T.cls}"><td>${fmt24(x.dateTime)}</td><td><span class="fp-mov-badge">${T.label}</span></td><td>${esc(x.concept)||'—'}</td><td class="fp-mov-amount">${T.sign}${money(x.amount)}</td><td>${esc(x.user)}</td><td>${x.registerId?'Asociado':'Sin caja'}</td><td><button type="button" class="btn btn-sm editMovement" data-type="${r.t}" data-id="${esc(x.id)}" title="Editar ${nn}" aria-label="Editar ${nn}"><i class="fa fa-pencil"></i></button><button type="button" class="btn btn-sm btn-danger delMovement" data-type="${r.t}" data-id="${esc(x.id)}" title="Eliminar ${nn}" aria-label="Eliminar ${nn}"><i class="fa fa-trash"></i></button></td></tr>`}).join('')||'<tr><td colspan="7">No hay movimientos registrados.</td></tr>';
  tb.querySelectorAll('.editMovement').forEach(b=>b.onclick=()=>openModal('edit',b.dataset.type,b.dataset.id));
  tb.querySelectorAll('.delMovement').forEach(b=>b.onclick=()=>del(b.dataset.type,b.dataset.id));
  renderBaseInfo();
 }
 function del(t,id){
  const T=TYPES[t];
  if(T.base){
   // Un movimiento de base de una caja ya cerrada quedó registrado en el cierre: no se toca.
   const x=get(T.key,[]).find(i=>i&&String(i.id)===String(id)),reg=get('fp_cash_register',null);
   if(x&&(!reg||x.registerId!==reg.id)){fpAlert('Este movimiento de base pertenece a una caja ya cerrada y no se puede eliminar.','error');return}
   if(x&&baseIfChanged(reg,t,id,'',0)<0){fpAlert('No se puede eliminar: la base quedaría en negativo (base actual '+money(baseNow(reg))+').','error');return}
  }
  fpConfirm('¿Eliminar este '+T.noun+'? Esta acción no se puede deshacer.',()=>{
   set(T.key,get(T.key,[]).filter(x=>!x||String(x.id)!==String(id)));
   render();
  },{danger:true,okText:'Eliminar'});
 }
 function setType(t){curType=t;typeBtns.forEach(b=>b.classList.toggle('active',b.dataset.type===t))}
 typeBtns.forEach(b=>b.onclick=()=>{setType(b.dataset.type);msg.style.display='none'});
 function close(){overlay.style.display='none'}
 function openModal(m,t,id){
  mode=m;editing=null;msg.style.display='none';msg.textContent='';
  if(m==='edit'){
   const x=get(TYPES[t].key,[]).find(i=>i&&String(i.id)===String(id));
   if(!x){fpAlert('No fue posible encontrar el movimiento.');return}
   if(TYPES[t].base){
    const reg=get('fp_cash_register',null);
    if(!reg||x.registerId!==reg.id){fpAlert('Este movimiento de base pertenece a una caja ya cerrada y no se puede editar.','error');return}
   }
   editing={type:t,id:x.id};setType(t);
   conceptEl.value=x.concept||'';amountEl.value=x.amount||'';
   titleEl.textContent='Editar movimiento';saveBtn.textContent='Guardar';
  }else{
   if(!get('fp_cash_register',null)){fpAlert('Debe abrir caja antes de registrar un movimiento.');return}
   setType('');conceptEl.value='';amountEl.value='';
   titleEl.textContent='Registrar nuevo movimiento';saveBtn.textContent='Registrar';
  }
  overlay.style.display='flex';
 }
 function save(){
  const concept=conceptEl.value.trim(),amount=+amountEl.value;
  const fail=t=>{msg.textContent=t;msg.style.display='block'};
  if(!curType){fail('Seleccione el tipo de movimiento.');return}
  if(!Number.isFinite(amount)||amount<=0){fail('Ingrese un valor válido mayor a 0.');return}
  const T=TYPES[curType],reg=get('fp_cash_register',null);
  if(mode==='new'){
   if(!reg){fail('Debe abrir caja antes de registrar un movimiento.');return}
   if(curType==='base_out'&&amount>baseNow(reg)){fail('No puede quitar más de la base actual ('+money(baseNow(reg))+').');return}
   const u=get(KEY.user,defaults.user),a=get(T.key,[]);
   a.push({id:T.prefix+Date.now(),concept,amount,observation:'',dateTime:new Date().toISOString(),user:u.name||u.username,registerId:reg.id});
   set(T.key,a);close();render();fpAlert(T.saved);
   return;
  }
  const from=TYPES[editing.type],src=get(from.key,[]),idx=src.findIndex(i=>i&&String(i.id)===String(editing.id));
  if(idx<0){close();render();return}
  if(from.base||T.base){
   // Cualquier cambio que toque la base solo se permite dentro de la caja abierta a la que pertenece
   // el movimiento, y sin dejar la base en negativo.
   if(!reg||src[idx].registerId!==reg.id){fail('Este movimiento pertenece a una caja ya cerrada y no se puede cambiar hacia/desde la base.');return}
   if(baseIfChanged(reg,from.base?editing.type:'',editing.id,T.base?curType:'',amount)<0){fail('La base no puede quedar en negativo (base actual '+money(baseNow(reg))+').');return}
  }
  if(curType===editing.type){
   src[idx]=Object.assign({},src[idx],{concept,amount});
   set(from.key,src);
  }else{
   // Cambio de tipo: el registro pasa a la otra lista conservando fecha, usuario y caja.
   // Primero se agrega al destino y luego se quita del origen, para no perderlo si algo falla.
   const dst=get(T.key,[]);
   let nid=T.prefix+String(src[idx].id).replace(/^(BI|BO|I|E)/,'');
   if(dst.some(i=>i&&String(i.id)===nid))nid=T.prefix+Date.now();
   dst.push(Object.assign({},src[idx],{id:nid,concept,amount}));
   set(T.key,dst);
   src.splice(idx,1);
   set(from.key,src);
  }
  close();render();
 }
 $('newMovementBtn').onclick=()=>openModal('new');
 $('movementCloseBtn').onclick=close;
 $('movementCancelBtn').onclick=close;
 saveBtn.onclick=save;
 [conceptEl,amountEl].forEach(el=>el.onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();save()}});
 render();
 window.addEventListener('storage',render);
}
/* Pestañas de tipo de recibo (Entrada/Salida/Mensualidad) dentro de
 * Configuración > Edición completa de recibos. */
function initReceiptTabs(rf){
  const tabs=rf.querySelectorAll('#receiptTabs .fp-tab-btn'),panels=rf.querySelectorAll('.fp-tab-panel');
  tabs.forEach(btn=>btn.onclick=()=>{
    tabs.forEach(b=>b.classList.remove('active'));
    panels.forEach(p=>p.classList.remove('active'));
    btn.classList.add('active');
    const panel=rf.querySelector(`.fp-tab-panel[data-panel="${btn.dataset.tab}"]`);
    if(panel)panel.classList.add('active');
  });
}
/* Construye el HTML de la vista previa de un recibo (entrada, salida o
 * mensualidad) a partir de los VALORES ACTUALES del formulario (aunque
 * todavía no se hayan guardado), con datos de ejemplo. Usa exactamente
 * la misma información (etiquetas, casillas de mostrar/ocultar) que
 * después se guarda en la configuración y que aplican applyReceiptConfig()
 * (ParkApp.html) y printMonthlyReceipt() (este archivo), para que lo que
 * se ve aquí coincida con el recibo impreso real. */
function buildReceiptPreviewHTML(type,rf,pf){
  const val=(name)=>{const el=rf.elements[name];if(!el)return '';return el.type==='checkbox'?el.checked:el.value};
  const biz={name:(pf.elements.razon_social.value||'').trim()||'NOMBRE DEL NEGOCIO',nit:(rf.elements.receiptNit?.value||pf.elements.nit.value||'').trim(),phone:(rf.elements.receiptPhone?.value||pf.elements.telefonos.value||'').trim(),address:(rf.elements.receiptAddress?.value||pf.elements.direccion1.value||'').trim()};
  const row=(show,label,value,strong,arial)=>show?`<div class="fp-r-row${strong?' fp-r-total':''}${arial?' fp-r-arial':''}"><span class="fp-r-label">${esc(label)}</span><span class="fp-r-value">${esc(value)}</span></div>`:'';
  const free=(text)=>text?`<div class="fp-r-free">${esc(text)}</div>`:'';
  const businessBlock=(prefix,showKey)=>{
    if(!val(showKey))return '';
    let h=`<div class="fp-r-business"><span class="fp-r-bizname">${esc(biz.name)}</span>`;
    if(biz.nit)h+=`<span class="fp-r-bizline">${esc(val(prefix+'LabelNit')||'NIT.')} ${esc(biz.nit)}</span>`;
    if(biz.phone)h+=`<span class="fp-r-bizline">${esc(val(prefix+'LabelPhone')||'TEL.')} ${esc(biz.phone)}</span>`;
    if(biz.address)h+=`<span class="fp-r-bizline">${esc(val(prefix+'LabelAddress')||'DIR.')} ${esc(biz.address)}</span>`;
    h+=`</div><div class="fp-r-divider"></div>`;
    return h;
  };
  if(type==='entry'||type==='exit'){
    const p=type;
    let h=businessBlock(p,p+'ShowBusiness');
    h+=row(val(p+'ShowPlate'),val(p+'LabelPlate')||'Placa','ABC123',false,true);
    h+=row(val(p+'ShowEntry'),val(p+'LabelEntry')||'Entrada','12-09-2026 08:30',false,true);
    if(type==='exit'){
      h+=row(val('exitShowExit'),val('exitLabelExit')||'Salida','12-09-2026 10:15',false,true);
      h+=row(val('exitShowService'),val('exitLabelService')||'Servicio','Carro',false,true);
      h+=row(val('exitShowTime'),val('exitLabelTime')||'Tiempo','1 HORA 45 MIN',false,true);
      h+=row(val('exitShowTotal'),val('exitLabelTotal')||'Total','$3.300',true,true);
      h+=row(val('exitShowPaymentMethod'),val('exitLabelPaymentMethod')||'Forma de pago','Efectivo',false,true);
    }
    h+=row(true,'Recibo',(rf.elements.receiptPrefix.value||'FA')+(rf.elements.nextReceiptNumber.value||'1'),false,true);
    h+=free((rf.elements.customMessage.value||'').trim());
    h+=free((rf.elements.additionalInfo.value||'').trim());
    if(val('entryShowHours')){
      h+=`<div class="fp-r-divider"></div><div class="fp-r-hours-title">HORARIOS DE ATENCIÓN</div><div class="fp-r-hours">${esc(rf.elements.entryHoursText.value||'')}</div>`;
    }
    return h;
  }
  if(type==='monthly'){
    let h=businessBlock('monthly','monthlyShowBusiness');
    h+=row(true,val('monthlyLabelReceipt')||'Consecutivo','FM1',false,true);
    h+=row(true,val('monthlyLabelClient')||'Cliente','Juan Pérez',false,true);
    h+=row(val('monthlyShowDocument'),val('monthlyLabelDocument')||'Documento','1234567890',false,true);
    h+=row(true,val('monthlyLabelVehicle')||'Vehículo','Mazda 3',false,true);
    h+=row(true,val('monthlyLabelPlate')||'Placa','ABC123',false,true);
    h+=row(true,val('monthlyLabelPaymentDate')||'Fecha de pago','12-09-2026 09:00',false,true);
    h+=row(true,val('monthlyLabelStart')||'Inicio','12-09-2026',false,true);
    h+=row(true,val('monthlyLabelEnd')||'Vence','12-10-2026',false,true);
    h+=row(true,val('monthlyLabelValue')||'Valor','$130.000',true,true);
    h+=row(true,val('monthlyLabelPaymentMethod')||'Forma de pago','Efectivo',false,true);
    h+=`<div class="fp-r-divider"></div><div class="fp-r-hours-title">HORARIOS DE ATENCIÓN</div><div class="fp-r-hours">${esc(rf.elements.entryHoursText.value||'')}</div>`;
    return h;
  }
  return '';
}
function wireReceiptPreview(rf,pf){
  function refreshAll(){
    ['entry','exit','monthly'].forEach(type=>{
      const box=document.getElementById('preview'+type.charAt(0).toUpperCase()+type.slice(1));
      if(box)box.innerHTML=buildReceiptPreviewHTML(type,rf,pf)||'<div class="fp-receipt-empty">Sin contenido para mostrar.</div>';
    });
  }
  rf.addEventListener('input',refreshAll);
  rf.addEventListener('change',refreshAll);
  pf.addEventListener('input',refreshAll);
  pf.addEventListener('change',refreshAll);
  refreshAll();
}
function initConfig(){ensure();const s=get(KEY.services,defaults.services),f=document.getElementById('ratesForm'),rf=document.getElementById('receiptConfigForm'),pf=document.getElementById('parkingConfigForm');function fill(){let by=(id)=>s.find(x=>String(x.id)===id)||{};let a=by('5'),m=by('6'),b=by('7');[['car',a],['moto',m],['bike',b]].forEach(([p,x])=>{f.elements[p+'_fraction'].value=x.fraction??x.minute??0;f.elements[p+'_hour'].value=x.hour??x.valorHora??0;f.elements[p+'_full12h'].value=x.full12h??0;f.elements[p+'_monthly'].value=x.monthly??x.mensualidad??0});let c=get(KEY.config,defaults.config);rf.elements.receiptPrefix.value=c.receiptPrefix||'FA';rf.elements.nextReceiptNumber.value=c.nextReceiptNumber||1;rf.elements.customMessage.value=c.customMessage||'';rf.elements.additionalInfo.value=c.additionalInfo||'';if(rf.elements.receiptNit)rf.elements.receiptNit.value=c.receiptNit??c.nit??'';if(rf.elements.receiptPhone)rf.elements.receiptPhone.value=c.receiptPhone??c.telefonos??c.phone??'';if(rf.elements.receiptAddress)rf.elements.receiptAddress.value=c.receiptAddress??c.direccion1??c.address??'';
const receiptChecks={entryShowBusiness:true,entryShowPlate:true,entryShowEntry:true,entryShowHours:true,exitShowBusiness:true,exitShowPlate:true,exitShowEntry:true,exitShowExit:true,exitShowService:true,exitShowTime:true,exitShowTotal:true,exitShowPaymentMethod:true,monthlyShowBusiness:true,monthlyShowDocument:true};Object.keys(receiptChecks).forEach(k=>{if(rf.elements[k])rf.elements[k].checked=c[k]===undefined?receiptChecks[k]:!!c[k]});
const receiptLabels={entryLabelNit:'NIT.',entryLabelPhone:'TEL.',entryLabelAddress:'DIR.',entryLabelPlate:'Placa',entryLabelEntry:'Entrada',exitLabelNit:'NIT.',exitLabelPhone:'TEL.',exitLabelAddress:'DIR.',exitLabelPlate:'Placa',exitLabelEntry:'Entrada',exitLabelExit:'Salida',exitLabelService:'Servicio',exitLabelTime:'Tiempo',exitLabelTotal:'Total',exitLabelPaymentMethod:'Forma de pago',monthlyLabelReceipt:'Consecutivo',monthlyLabelPlate:'Placa',monthlyLabelClient:'Cliente',monthlyLabelDocument:'Documento',monthlyLabelVehicle:'Vehículo',monthlyLabelPaymentDate:'Fecha de pago',monthlyLabelStart:'Inicio',monthlyLabelEnd:'Vence',monthlyLabelValue:'Valor',monthlyLabelPaymentMethod:'Forma de pago',monthlyLabelNit:'NIT.',monthlyLabelPhone:'TEL.',monthlyLabelAddress:'DIR.'};Object.keys(receiptLabels).forEach(k=>{if(rf.elements[k])rf.elements[k].value=c[k]??receiptLabels[k]});if(rf.elements.entryHoursText)rf.elements.entryHoursText.value=c.entryHoursText||'Lunes a Miércoles:\n06:30 a 21:30\nJueves a Sábado:\n06:30 a 23:00\nDomingos y Festivos:\n06:30 a 19:00';pf.elements.razon_social.value=c.razon_social||c.parkingName||'';pf.elements.nit.value=c.nit||'';pf.elements.direccion1.value=c.direccion1||c.address||'';pf.elements.telefonos.value=c.telefonos||c.phone||'';pf.elements.propietario.value=c.propietario||'';pf.elements.email.value=c.email||'';pf.elements.limiteVehiculos.value=c.limiteVehiculos||c.capacity||0;pf.elements.parkingAdditionalInfo.value=c.parkingAdditionalInfo||''}; f.onsubmit=e=>{e.preventDefault();[['5','car'],['6','moto'],['7','bike']].forEach(([id,p])=>{let x=s.find(z=>String(z.id)===id)||{id};x.fraction=+f.elements[p+'_fraction'].value||0;x.hour=+f.elements[p+'_hour'].value||0;x.full12h=+f.elements[p+'_full12h'].value||0;x.monthly=+f.elements[p+'_monthly'].value||0;if(!s.includes(x))s.push(x)});set(KEY.services,s);fpAlert('Tarifas guardadas.');}; rf.onsubmit=e=>{e.preventDefault();let c=get(KEY.config,defaults.config);c={...c,receiptPrefix:rf.elements.receiptPrefix.value,nextReceiptNumber:+rf.elements.nextReceiptNumber.value||1,customMessage:rf.elements.customMessage.value,additionalInfo:rf.elements.additionalInfo.value,receiptNit:rf.elements.receiptNit?rf.elements.receiptNit.value.trim():'',receiptPhone:rf.elements.receiptPhone?rf.elements.receiptPhone.value.trim():'',receiptAddress:rf.elements.receiptAddress?rf.elements.receiptAddress.value.trim():''};['entryShowBusiness','entryShowPlate','entryShowEntry','entryShowHours','exitShowBusiness','exitShowPlate','exitShowEntry','exitShowExit','exitShowService','exitShowTime','exitShowTotal','exitShowPaymentMethod','monthlyShowBusiness','monthlyShowDocument'].forEach(k=>{if(rf.elements[k])c[k]=!!rf.elements[k].checked});['entryLabelNit','entryLabelPhone','entryLabelAddress','entryLabelPlate','entryLabelEntry','exitLabelNit','exitLabelPhone','exitLabelAddress','exitLabelPlate','exitLabelEntry','exitLabelExit','exitLabelService','exitLabelTime','exitLabelTotal','exitLabelPaymentMethod','monthlyLabelReceipt','monthlyLabelPlate','monthlyLabelClient','monthlyLabelDocument','monthlyLabelVehicle','monthlyLabelPaymentDate','monthlyLabelStart','monthlyLabelEnd','monthlyLabelValue','monthlyLabelPaymentMethod','monthlyLabelNit','monthlyLabelPhone','monthlyLabelAddress'].forEach(k=>{if(rf.elements[k])c[k]=rf.elements[k].value.trim()});c.entryHoursText=rf.elements.entryHoursText?rf.elements.entryHoursText.value:'';set(KEY.config,c);localStorage.setItem('facaparking_offline_receipt_v4',String((+c.nextReceiptNumber||1)-1));fpAlert('Información de recibos guardada.');}; pf.onsubmit=e=>{e.preventDefault();let c=get(KEY.config,defaults.config);c={...c,parkingName:pf.elements.razon_social.value,nit:pf.elements.nit.value,direccion1:pf.elements.direccion1.value,address:pf.elements.direccion1.value,telefonos:pf.elements.telefonos.value,phone:pf.elements.telefonos.value,propietario:pf.elements.propietario.value,email:pf.elements.email.value,limiteVehiculos:pf.elements.limiteVehiculos.value,capacity:+pf.elements.limiteVehiculos.value||0,parkingAdditionalInfo:pf.elements.parkingAdditionalInfo.value};set(KEY.config,c);fpAlert('Información del local guardada.');}; fill(); initReceiptTabs(rf); wireReceiptPreview(rf,pf); initWipeSection(); initLoginHistory()}
function initLoginHistory(){
  const section=document.getElementById('fpLoginHistorySection');
  if(!section) return;
  /* El historial de ingresos (quién entró y cuándo) es información sensible
   * de auditoría: solo una cuenta con rol Superadmin puede verlo (no solo
   * Felipe), igual que la Zona de peligro. */
  const isSuperAdmin=String((get(KEY.user,null)||{}).role||'').trim().toLowerCase()==='superadmin';
  if(!isSuperAdmin){ section.style.display='none'; return; }
  section.style.display='block';
  const tb=document.querySelector('#loginHistoryTable tbody'), search=document.getElementById('loginHistorySearch'), clearBtn=document.getElementById('loginHistoryClearBtn'), pager=document.getElementById('loginHistoryPager');
  let page=1, pageSize=10;
  function render(){
    let hist=get(LOGIN_HISTORY_KEY,[]);
    if(!Array.isArray(hist))hist=[];
    const q=(search?.value||'').trim().toLowerCase();
    const rows=hist.slice().reverse().filter(h=>!q||(String(h.username||'')+' '+String(h.name||'')).toLowerCase().includes(q));
    const pages=Math.max(1,Math.ceil(rows.length/pageSize)); if(page>pages)page=pages;
    const pageRows=rows.slice((page-1)*pageSize,page*pageSize);
    tb.innerHTML=pageRows.map(h=>`<tr><td>${esc(h.username)}</td><td>${esc(h.name)}</td><td>${esc(h.role||'Empleado')}</td><td>${esc(fmt24(h.at))}</td></tr>`).join('')||'<tr><td colspan="4">No hay ingresos registrados.</td></tr>';
    if(pager){
      pager.innerHTML=`<button type="button" class="btn btn-sm btn-default" id="loginHistoryPrev" ${page<=1?'disabled':''}>Anterior</button> <span style="display:inline-block;margin:0 12px;line-height:32px">Página ${page} de ${pages} · ${rows.length} ingresos</span> <button type="button" class="btn btn-sm btn-default" id="loginHistoryNext" ${page>=pages?'disabled':''}>Siguiente</button>`;
      const pv=document.getElementById('loginHistoryPrev'), nx=document.getElementById('loginHistoryNext');
      if(pv)pv.onclick=()=>{if(page>1){page--;render()}};
      if(nx)nx.onclick=()=>{if(page<pages){page++;render()}};
    }
  }
  render();
  if(search)search.oninput=()=>{page=1;render()};
  if(clearBtn)clearBtn.onclick=()=>{
    if(String((get(KEY.user,null)||{}).role||'').trim().toLowerCase()!=='superadmin'){fpAlert('Solo un usuario Superadmin puede limpiar el historial de ingresos.','error');return;}
    fpConfirm('¿Borrar todo el historial de ingresos? Esta acción no se puede deshacer.',()=>{set(LOGIN_HISTORY_KEY,[]);page=1;render();},{danger:true,okText:'Borrar'});
  };
}
function initWipeSection(){
  const btn=document.getElementById('fpWipeAllBtn');
  if(!btn) return;
  /* La Zona de peligro (borrar todos los datos) es una acción destructiva
   * pero se permite a cualquier cuenta con rol Superadmin (no solo Felipe).
   * Cualquier otro usuario (Administrador o Empleado) ni siquiera ve la
   * sección. */
  const isSuperAdmin=String((get(KEY.user,null)||{}).role||'').trim().toLowerCase()==='superadmin';
  const section=document.getElementById('fpDangerZoneSection');
  if(!isSuperAdmin){
    if(section) section.style.display='none';
    return;
  }
  if(section) section.style.display='block';
  btn.onclick=()=>{
    if(String((get(KEY.user,null)||{}).role||'').trim().toLowerCase()!=='superadmin'){
      fpAlert('Solo un usuario Superadmin puede borrar todos los datos.','error');
      return;
    }
    fpConfirm('¿Borrar TODOS los datos de la aplicación?\n\nSe eliminarán vehículos, ventas, mensualidades, ingresos y egresos, cierres de caja, tarifas, clientes y configuración guardados en este equipo.\n\nLos usuarios volverán a los valores de fábrica.\n\nEsta acción NO se puede deshacer.',()=>{fpPrompt('Para confirmar, escriba BORRAR (en mayúsculas):',typed=>{
    if(String(typed||'').trim()!=='BORRAR'){ fpAlert('Operación cancelada. No se borró ningún dato.'); return; }
    try{
      localStorage.clear();
      ensure();
    }catch(err){
      console.error(err);
      fpAlert('No fue posible borrar los datos.','error');
      return;
    }
    localStorage.removeItem(KEY.session);
    fpAlert('Todos los datos fueron borrados. Los usuarios quedaron en los valores de fábrica.');
    setTimeout(()=>{ location.replace('login.html'); },900);
    },{okText:'Borrar todo',danger:true});
    },{okText:'Continuar',danger:true});
  };
}
// Límite de localStorage MEDIDO en el .exe (Electron 31.7.7): ~99,98 MB = ~52,4 millones de
// caracteres (UTF-16, 2 bytes por carácter). Debe coincidir con ESTIMATED_LIMIT_MB (100)
// del diagnóstico en configuracion.html. Solo aplica al .exe: un navegador (.bat) tiene su propio tope.
const FP_STORAGE_LIMIT_CHARS=52428800;
const FP_STORAGE_WARN_RATIO=0.8;
function fpCheckStorage(){
  try{
    if(sessionStorage.getItem('fp_storage_warned')==='1')return;
    let chars=0;
    for(let i=0;i<localStorage.length;i++){const k=localStorage.key(i);chars+=k.length+(localStorage.getItem(k)||'').length}
    if(chars>=FP_STORAGE_LIMIT_CHARS*FP_STORAGE_WARN_RATIO){
      sessionStorage.setItem('fp_storage_warned','1');
      fpAlert('El almacenamiento del equipo está casi lleno (aprox. '+Math.round(chars*100/FP_STORAGE_LIMIT_CHARS)+'%). Si llega al límite la app deja de guardar. Avise al administrador.','error');
    }
  }catch(e){}
}
function init(){if(!auth())return;nav();startSessionWatch();fpCheckStorage();
 document.querySelectorAll('input[name*=\"placa\" i],input[id*=\"placa\" i],input[name*=\"plate\" i],input[id*=\"plate\" i]').forEach(function(inp){inp.style.textTransform='uppercase';inp.addEventListener('input',function(){this.value=String(this.value||'').toUpperCase()});inp.value=String(inp.value||'').toUpperCase()});
let p=document.body.dataset.module;({dashboard:initDashboard,entries:function(){},monthly:initMonthly,pending:initPending,cash:initCash,transactions:initExpenses,reports:initReports,config:initConfig,payments:initPayments}[p]||function(){})();if(p==='config')initConfigUsers();}

window.FP={get,set,KEY,money,ensure,activateDueAdvancePeriods};document.addEventListener('DOMContentLoaded',()=>{let p=document.body.dataset.module;if(p==='registro')initRegistration();else if(p==='login')initLogin();else init()});
})(window);

// v63 visual fixes
(function(){const st=document.createElement('style');st.textContent='.fp-print-icon{width:18px!important;height:18px!important;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}.fp-arrow-btn{width:34px!important;height:30px!important;padding:0!important;display:inline-flex!important;align-items:center!important;justify-content:center!important;background:#0b2748!important;color:#fff!important;border-color:#0b2748!important}.fp-arrow-btn svg{width:15px;height:15px;fill:none;stroke:#fff;stroke-width:2.5;stroke-linecap:round;stroke-linejoin:round}';document.head&&document.head.appendChild(st)})();
