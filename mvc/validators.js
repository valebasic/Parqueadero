/* Validaciones compartidas (placas, montos, teléfono, nombre).
 * Se carga antes de model.js en todas las pantallas. Dos capas:
 *  1) Máscaras en vivo, por delegación de eventos (también funcionan en filas/modales creados después).
 *  2) Funciones FPValidate.* que los controladores llaman al guardar, para que un dato inválido nunca
 *     llegue al almacenamiento aunque se salte la máscara (pegado, autocompletado, etc.). */
(function(root){
  'use strict';
  var MAX_MONEY=10000000;                 // tope de cualquier monto/tarifa: $ 10.000.000
  var PLATE_MAXLEN=7;                     // 6 caracteres + guion opcional
  var PHONE_MAXLEN=10;                    // celular colombiano
  var NAME_MAXLEN=60;

  /* Tipos: id de servicio ('5','6','7' = Carro, Moto, Cicla) igual que en tarifas. */
  var TYPE_ID={Carro:'5',Moto:'6',Cicla:'7'};

  function normalizePlate(v){ return String(v==null?'':v).toUpperCase().replace(/[\s-]/g,''); }

  /* Devuelve 'Carro' | 'Moto' | 'Cicla' | '' (no reconocida). Formatos admitidos:
   *  - Carro: ABC123 (JMV-025)        - Moto: ABC12D (JHB-02C)
   *  - Cicla: CICLA (y alias históricos BICI, PATIN, + 0/1 para varias; PTELEC/PTELE0/PTELE1)
   *  - Moto eléctrica histórica: MTELEC/MTELE0/MTELE1 */
  function detectPlateType(v){
    var p=normalizePlate(v); if(!p) return '';
    if(/^(CICLA|BICI|PATIN)[01]?$/.test(p) || /^PTELE[C01]$/.test(p)) return 'Cicla';
    if(/^[A-Z]{3}\d{2}[A-Z]$/.test(p) || /^MTELE[C01]$/.test(p)) return 'Moto';
    if(/^[A-Z]{3}\d{3}$/.test(p)) return 'Carro';
    return '';
  }
  function isValidPlate(v){ return detectPlateType(v)!==''; }
  function plateError(v){
    var p=normalizePlate(v);
    if(!p) return 'Ingrese la placa.';
    if(!isValidPlate(p)) return 'Placa inválida. Use el formato de carro (ABC-123), de moto (ABC-12D) o la palabra CICLA.';
    return '';
  }

  /* Monto entero positivo (o cero si allowZero) y no mayor al tope. Acepta número o texto. */
  function parseMoney(v){
    var s=String(v==null?'':v).trim();
    return /^\d+$/.test(s)?Number(s):NaN;
  }
  function moneyError(v,label,opts){
    opts=opts||{}; var max=opts.max||MAX_MONEY, n=parseMoney(v);
    label=label||'El valor';
    if(isNaN(n)) return label+' debe ser un número entero, sin decimales ni notación científica.';
    if(n<(opts.allowZero?0:1)) return label+' debe ser '+(opts.allowZero?'cero o mayor':'mayor que cero')+'.';
    if(n>max) return label+' no puede superar $ '+max.toLocaleString('es-CO')+'.';
    return '';
  }

  function phoneError(v,required){
    var s=String(v==null?'':v).trim();
    if(!s) return required?'Ingrese el número telefónico.':'';
    if(!/^\d{7}$|^\d{10}$/.test(s)) return 'El teléfono debe tener 7 dígitos (fijo) o 10 dígitos (celular), solo números.';
    return '';
  }
  var NAME_RE=/^[A-Za-zÁÉÍÓÚÜÑáéíóúüñ][A-Za-zÁÉÍÓÚÜÑáéíóúüñ .'-]*$/;
  function nameError(v,required){
    var s=String(v==null?'':v).trim().replace(/\s+/g,' ');
    if(!s) return required?'Ingrese el nombre.':'';
    if(s.length<2) return 'El nombre es demasiado corto.';
    if(s.length>NAME_MAXLEN) return 'El nombre no puede superar '+NAME_MAXLEN+' caracteres.';
    if(!NAME_RE.test(s)) return 'El nombre solo puede contener letras y espacios.';
    return '';
  }

  /* Selecciona en un <select> la opción que corresponde al tipo ('Carro'|'Moto'|'Cicla').
   * Sirve tanto para selects con texto "Carro" como para servicios con id 5/6/7 ("parqueadero Carro"). */
  function selectVehicleType(sel,type){
    if(!sel||!type) return false;
    var id=TYPE_ID[type], t=type.toLowerCase(), opts=Array.prototype.slice.call(sel.options), hit=null;
    opts.forEach(function(o){ if(!hit && (String(o.value)===id || String(o.text).toLowerCase().indexOf(t)>=0 || String(o.value).toLowerCase()===t)) hit=o; });
    if(!hit) return false;
    if(sel.value!==hit.value){ sel.value=hit.value; try{ sel.dispatchEvent(new Event('change',{bubbles:true})); }catch(e){} }
    return true;
  }

  /* ---------- Máscaras en vivo (delegación) ---------- */
  var PLATE_SEL='#placa,#manualPlaca,input[name="plate"],input[data-fp-plate]';
  var PHONE_SEL='input[type="tel"],input[name="phone"],input[data-fp-phone]';
  var NAME_SEL='input[name="name"]:not([type="hidden"]),input[data-fp-name]';
  var MONEY_SEL='input[type="number"]:not([data-fp-nomoney])';
  var MAX_BY_NAME={nextReceiptNumber:99999999,limiteVehiculos:100000};

  function matches(el,sel){ return el && el.matches && el.matches(sel); }
  function moneyMax(el){
    var byName=MAX_BY_NAME[el.name]; if(byName) return byName;
    var m=parseFloat(el.getAttribute('max')); return (m>0&&m<MAX_MONEY)?m:MAX_MONEY;
  }

  function sanitizePlate(raw){
    var s=String(raw).toUpperCase().replace(/[^A-Z0-9-]/g,'');
    var hy=s.indexOf('-');
    if(hy>=0) s=s.slice(0,hy+1)+s.slice(hy+1).replace(/-/g,'');
    return s.slice(0,PLATE_MAXLEN);
  }
  function hintFor(el){
    var id='fpPlateHint_'+(el.id||el.name||'x'), h=document.getElementById(id);
    if(!h){
      h=document.createElement('div'); h.id=id; h.setAttribute('data-fp-hint','1');
      h.style.cssText='font-size:12px;margin-top:2px;min-height:15px';
      if(el.parentNode) el.parentNode.insertBefore(h,el.nextSibling);
    }
    return h;
  }
  function paintPlate(el,final){
    var p=normalizePlate(el.value), type=detectPlateType(p), h=hintFor(el);
    var bad=p.length>0 && !type && (final || p.length>=6);   // mientras escribe no se marca error hasta completar 6 caracteres
    el.setCustomValidity(p.length===0||type?'':plateError(p));
    el.style.borderColor=bad?'#d84a3a':'';
    h.style.color=bad?'#d84a3a':'#1f7a4d';
    h.textContent=type?('Vehículo detectado: '+type):(bad?'Formato de placa inválido':'');
  }
  function applyVehicle(el){
    var type=detectPlateType(el.value); if(!type) return;
    var scope=el.closest('form')||document;   // Entradas (#idTarifa) lo maneja ParkApp.html: respeta la entrada abierta
    var sel=scope.querySelector('select[name="vehicle"],#manualTarifa');
    if(sel) selectVehicleType(sel,type);
  }

  document.addEventListener('keydown',function(ev){
    var el=ev.target;
    if(matches(el,MONEY_SEL)){
      if(ev.ctrlKey||ev.metaKey||ev.altKey) return;
      if(/^[eE+\-.,]$/.test(ev.key)) ev.preventDefault();               // sin notación científica, signos ni decimales
    }else if(matches(el,PHONE_SEL)){
      if(ev.key.length===1 && !ev.ctrlKey && !ev.metaKey && !/\d/.test(ev.key)) ev.preventDefault();
    }
  },true);

  document.addEventListener('paste',function(ev){
    var el=ev.target; if(!matches(el,MONEY_SEL)) return;
    var t=(ev.clipboardData&&ev.clipboardData.getData('text')||'').trim();
    if(/^\d{1,3}([.,]\d{3})+$/.test(t)) t=t.replace(/[.,]/g,'');       // 10.000 -> 10000
    if(!/^\d+$/.test(t)||Number(t)>moneyMax(el)) ev.preventDefault();
  },true);

  document.addEventListener('input',function(ev){
    var el=ev.target;
    if(matches(el,MONEY_SEL)){
      var v=el.value;
      if(v===''){ el.dataset.fpLast=''; return; }
      if(!/^\d+$/.test(v)||Number(v)>moneyMax(el)){ el.value=el.dataset.fpLast||''; return; }   // vuelve al último valor válido
      if(v.length>1 && v.charAt(0)==='0'){ v=String(Number(v)); el.value=v; }
      el.dataset.fpLast=v;
    }else if(matches(el,PLATE_SEL)){
      var clean=sanitizePlate(el.value); if(clean!==el.value) el.value=clean;
      paintPlate(el,false); applyVehicle(el);
    }else if(matches(el,PHONE_SEL)){
      var d=el.value.replace(/\D/g,'').slice(0,PHONE_MAXLEN); if(d!==el.value) el.value=d;
    }else if(matches(el,NAME_SEL)){
      var n=el.value.replace(/[^A-Za-zÁÉÍÓÚÜÑáéíóúüñ .'-]/g,'').replace(/^[\s.'-]+/,'').replace(/\s{2,}/g,' ').slice(0,NAME_MAXLEN);
      if(n!==el.value) el.value=n;
    }
  },true);

  /* Al salir de la placa se deja normalizada (sin guion ni espacios), que es como se guarda. */
  document.addEventListener('focusout',function(ev){
    var el=ev.target; if(!matches(el,PLATE_SEL)) return;
    var p=normalizePlate(el.value); if(p!==el.value) el.value=p;
    paintPlate(el,true);
  },true);

  function init(){
    document.querySelectorAll(PLATE_SEL).forEach(function(el){
      el.maxLength=PLATE_MAXLEN; el.style.textTransform='uppercase'; el.setAttribute('autocapitalize','characters');
      if(el.value) el.value=sanitizePlate(el.value);
    });
    document.querySelectorAll(PHONE_SEL).forEach(function(el){ el.maxLength=PHONE_MAXLEN; el.setAttribute('inputmode','numeric'); });
    document.querySelectorAll(NAME_SEL).forEach(function(el){ el.maxLength=NAME_MAXLEN; });
    document.querySelectorAll(MONEY_SEL).forEach(function(el){
      el.setAttribute('step','1'); el.setAttribute('inputmode','numeric');
      el.setAttribute('max',String(moneyMax(el)));
      if(!el.hasAttribute('min')) el.setAttribute('min','0');
    });
  }
  /* Los teléfonos de Mensualidades se crean por código: el atributo maxlength se les pone al enfocarlos. */
  document.addEventListener('focusin',function(ev){
    var el=ev.target;
    if(matches(el,PHONE_SEL)&&el.maxLength!==PHONE_MAXLEN){ el.maxLength=PHONE_MAXLEN; el.setAttribute('inputmode','numeric'); }
  },true);
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',init); else init();

  root.FPValidate={
    MAX_MONEY:MAX_MONEY, normalizePlate:normalizePlate, detectPlateType:detectPlateType, isValidPlate:isValidPlate,
    plateServiceId:function(v){ return TYPE_ID[detectPlateType(v)]||''; },
    plateError:plateError, moneyError:moneyError, parseMoney:parseMoney, phoneError:phoneError, nameError:nameError,
    selectVehicleType:selectVehicleType
  };
})(window);
