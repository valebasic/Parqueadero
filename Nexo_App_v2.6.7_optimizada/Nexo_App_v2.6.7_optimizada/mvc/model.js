/* FacaParking MVC - MODELO
 * Capa de datos: localStorage y reglas de acceso a datos.
 */
(function(window){
  'use strict';
  const KEY={user:'fp_user',users:'fp_users',session:'fp_session',services:'fp_services',clients:'fp_clients',config:'fp_config',db:'fp_entries',closures:'fp_closures',registered:'fp_registered',remembered:'fp_remembered_users'};
  const defaults={user:{username:'Felipe',name:'Felipe',document:'',email:'',phone:'',role:'Superadmin',password:'259148637'},services:[{id:'5',code:'CARRO',name:'Carro',description:'Servicio parqueadero carro',hour:3300,fraction:1800,full12h:20000,monthly:130000,active:true},{id:'6',code:'MOTO',name:'Moto',description:'Servicio parqueadero moto',hour:2200,fraction:1500,full12h:14000,monthly:80000,active:true},{id:'7',code:'CICLA',name:'Cicla',description:'Servicio parqueadero cicla',hour:0,fraction:0,full12h:10000,monthly:0,active:false}],clients:[],config:{parkingName:'PARKAPP',nit:'35529806-9',phone:'3137139757',address:'CARRERA 3 # 7 -132',parkingNumber:'1',capacity:'100',receiptPrefix:'FA',currency:'COP',autoPrint:false},closures:[]};
  function get(k,d){try{const v=localStorage.getItem(k);return v?JSON.parse(v):d}catch(e){return d}}
  function set(k,v){
    try{localStorage.setItem(k,JSON.stringify(v))}
    catch(e){
      // Almacenamiento lleno (QuotaExceededError) o no disponible: se avisa de forma visible y se relanza
      // el error (mismo comportamiento de antes, pero ahora el usuario ve el motivo).
      try{if(window.fpAlert)window.fpAlert('No se pudo guardar: el almacenamiento del equipo está lleno o no responde. Avise al administrador antes de seguir operando.','error')}catch(_){}
      throw e;
    }
  }
  /* -----------------------------------------------------------------
   * Migración V131: unificar el almacenamiento de entradas/salidas.
   * Antes cada entrada se guardaba duplicada en dos claves distintas
   * ('fp_entries' y 'facaparking_offline_entries_v4'), doblando el
   * espacio usado en localStorage por cada vehículo registrado. Ahora
   * solo se usa 'fp_entries'. Esta migración corre una sola vez (queda
   * marcada con MIGRATE_V131_KEY), fusiona lo que hubiera en la clave
   * vieja hacia la nueva (por id, sin duplicar) y borra la clave vieja
   * para liberar el espacio que ya estaba ocupado en instalaciones
   * existentes. Se ejecuta aquí, al cargar mvc/model.js, porque este
   * archivo se incluye en todas las pantallas antes de que cualquier
   * otro script lea o escriba entradas.
   * ----------------------------------------------------------------- */
  const MIGRATE_V131_KEY='fp_migrated_single_entries_v131';
  const LEGACY_ENTRIES_KEY='facaparking_offline_entries_v4';
  (function migrateDuplicateEntries(){
    try{
      if(localStorage.getItem(MIGRATE_V131_KEY)==='1')return;
      const legacyRaw=localStorage.getItem(LEGACY_ENTRIES_KEY);
      if(legacyRaw!=null){
        let legacy=[];try{legacy=JSON.parse(legacyRaw)}catch(e){legacy=[]}
        let main=[];try{main=JSON.parse(localStorage.getItem(KEY.db)||'[]')}catch(e){main=[]}
        if(!Array.isArray(legacy))legacy=[];
        if(!Array.isArray(main))main=[];
        const m=new Map();
        legacy.forEach(e=>{if(e&&e.id!=null)m.set(String(e.id),e)});
        main.forEach(e=>{if(e&&e.id!=null)m.set(String(e.id),e)}); // 'main' gana si un id está en ambas
        localStorage.setItem(KEY.db,JSON.stringify(Array.from(m.values())));
        localStorage.removeItem(LEGACY_ENTRIES_KEY);
      }
      localStorage.setItem(MIGRATE_V131_KEY,'1');
    }catch(e){/* si falla, no se pierde nada: se reintenta en la próxima carga */}
  })();

  function entries(){return get(KEY.db,[])}
  function normalizePaymentMethod(method){const p=String(method??'').trim().toLowerCase();if(p==='cash'||p==='efectivo'||p==='2')return 'cash';if(p==='nequi'||p==='electronico'||p==='electrónico'||p==='electronic'||p==='3')return 'nequi';if(p==='both'||p==='ambos'||p==='mixto'||p==='mixed')return 'both';return ''}
  function paymentLabel(e){const p=normalizePaymentMethod(e.paymentMethod||e.idTipoPago);return {'cash':'Efectivo','nequi':'Electrónico','both':'Efectivo + Electrónico'}[p]||'Sin método'}
  function cashPart(e){const p=normalizePaymentMethod(e.paymentMethod||e.idTipoPago);if(p==='both')return Number(e.cashAmount)||0;return p==='cash'?Number(e.total)||0:0}
  function plateUpper(v){return String(v??'').trim().toUpperCase()}

  /* -----------------------------------------------------------------
   * Hash de contraseñas (SHA-256 + salt, síncrono).
   * Antes las contraseñas se guardaban y comparaban en texto plano
   * dentro de localStorage (fp_users). Esto guarda un hash con salt
   * aleatorio por usuario en vez del texto plano. Se hace de forma
   * síncrona (implementación de SHA-256 en JS puro) para no tener que
   * convertir todo el flujo de login/registro a async solo por usar
   * crypto.subtle.digest.
   * Formato guardado: "<salt_hex_32>:<sha256_hex_64>"
   * ----------------------------------------------------------------- */
  function sha256Hex(message){
    function rrot(x,n){return (x>>>n)|(x<<(32-n))}
    const K=[
      0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
      0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
      0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
      0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
      0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
      0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
      0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
      0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
    let H=[0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
    const bytes=[];
    const utf8=unescape(encodeURIComponent(message));
    for(let i=0;i<utf8.length;i++)bytes.push(utf8.charCodeAt(i)&0xff);
    const bitLen=bytes.length*8;
    bytes.push(0x80);
    while(bytes.length%64!==56)bytes.push(0);
    for(let i=7;i>=0;i--)bytes.push((bitLen/Math.pow(2,i*8))&0xff);
    for(let chunkStart=0;chunkStart<bytes.length;chunkStart+=64){
      const w=new Array(64).fill(0);
      for(let i=0;i<16;i++){
        w[i]=(bytes[chunkStart+i*4]<<24)|(bytes[chunkStart+i*4+1]<<16)|(bytes[chunkStart+i*4+2]<<8)|(bytes[chunkStart+i*4+3]);
        w[i]=w[i]>>>0;
      }
      for(let i=16;i<64;i++){
        const s0=rrot(w[i-15],7)^rrot(w[i-15],18)^(w[i-15]>>>3);
        const s1=rrot(w[i-2],17)^rrot(w[i-2],19)^(w[i-2]>>>10);
        w[i]=(w[i-16]+s0+w[i-7]+s1)>>>0;
      }
      let [a,b,c,d,e,f,g,h]=H;
      for(let i=0;i<64;i++){
        const S1=rrot(e,6)^rrot(e,11)^rrot(e,25);
        const ch=(e&f)^((~e)&g);
        const temp1=(h+S1+ch+K[i]+w[i])>>>0;
        const S0=rrot(a,2)^rrot(a,13)^rrot(a,22);
        const maj=(a&b)^(a&c)^(b&c);
        const temp2=(S0+maj)>>>0;
        h=g;g=f;f=e;e=(d+temp1)>>>0;d=c;c=b;b=a;a=(temp1+temp2)>>>0;
      }
      H=[(H[0]+a)>>>0,(H[1]+b)>>>0,(H[2]+c)>>>0,(H[3]+d)>>>0,(H[4]+e)>>>0,(H[5]+f)>>>0,(H[6]+g)>>>0,(H[7]+h)>>>0];
    }
    return H.map(x=>x.toString(16).padStart(8,'0')).join('');
  }
  function randomSaltHex(){
    let arr;
    try{
      arr=new Uint8Array(16);
      (window.crypto||window.msCrypto).getRandomValues(arr);
    }catch(e){
      arr=[];for(let i=0;i<16;i++)arr.push(Math.floor(Math.random()*256));
    }
    return Array.from(arr).map(b=>b.toString(16).padStart(2,'0')).join('');
  }
  function isHashedPassword(stored){return typeof stored==='string' && /^[0-9a-f]{32}:[0-9a-f]{64}$/i.test(stored)}
  function hashPassword(password,salt){
    salt=salt||randomSaltHex();
    return salt+':'+sha256Hex(salt+':'+String(password??''));
  }
  function verifyPassword(password,stored){
    if(stored==null)return false;
    if(isHashedPassword(stored)){
      const salt=String(stored).split(':')[0];
      return hashPassword(password,salt)===stored;
    }
    /* Compatibilidad con instalaciones anteriores que guardaron la
     * contraseña en texto plano: se compara tal cual una única vez.
     * initLogin() se encarga de migrar el registro a hash tras un
     * inicio de sesión exitoso, para que deje de estar en texto plano. */
    return String(password)===String(stored);
  }
  function needsRehash(stored){return !isHashedPassword(stored)}

  window.FPModel={KEY,defaults,get,set,entries,paymentLabel,cashPart,plateUpper,hashPassword,verifyPassword,needsRehash,isHashedPassword};
})(window);
