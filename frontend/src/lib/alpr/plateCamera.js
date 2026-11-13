// Lectura de placas por cámara en el navegador (motor Tesseract, todo en el equipo: no se envía video ni imágenes).
// Viene de mvc/plate-reader.js de la v1.0 web. Flujo: cámara -> busca la placa amarilla -> recorta las letras ->
// OCR -> corrige al formato colombiano -> votación entre fotogramas -> onPlate(placa).
//
// Archivos de Tesseract: los copia `npm install` (scripts/setup-tesseract.mjs) a public/tesseract/.
// La cámara solo funciona en https:// o en http://localhost.
import { PlateVoter, classify, locateLetterBand, locateYellowPlate, normalizeTessConf, pickPlateFromTess } from './plateLogic.js';

const DEFAULTS = { camera: { width: 1280, height: 720 } };

function isObj(x) { return x && typeof x === 'object' && !Array.isArray(x); }
function merge(a, b) {
  var out = {}, k;
  for (k in a) out[k] = isObj(a[k]) ? merge(a[k], {}) : a[k];
  for (k in (b || {})) out[k] = (isObj(a[k]) && isObj(b[k])) ? merge(a[k], b[k]) : b[k];
  return out;
}

function loadScript(src) {
  return new Promise(function (res, rej) {
    var s = document.createElement('script');
    s.src = src; s.onload = res; s.onerror = function () { rej(new Error('NO_FILE: ' + src)); };
    document.head.appendChild(s);
  });
}

/* Convierte un error en un mensaje claro para el operador. */
function explain(e) {
  var m = String((e && e.message) || e || '');
  var n = e && e.name;
  if (/NO_FILE/.test(m)) return 'Faltan archivos de lectura de placas (' + m.replace(/^.*NO_FILE:\s*/, '') + '). En la carpeta frontend ejecute: npm install (copia los archivos a public/tesseract/).';
  if (n === 'NotAllowedError' || n === 'SecurityError') return 'No hay permiso para usar la cámara. Autorícela en el navegador o en la configuración de privacidad de Windows.';
  if (n === 'NotFoundError' || n === 'OverconstrainedError') return 'No se encontró la cámara seleccionada.';
  if (n === 'NotReadableError') return 'La cámara está ocupada por otro programa.';
  if (m === 'NO_CAMERA_API') return 'La cámara solo funciona con HTTPS o abriendo la app en http://localhost.';
  return 'No se pudo iniciar la lectura: ' + m;
}

var TESS = {
  base: '/tesseract/',
  roi: { x: 0.2, y: 0.30, w: 0.6, h: 0.40 }, /* recuadro de respaldo/guía (fracción del cuadro) para cuando no se ve una placa amarilla */
  targetW: 560, minConf: 0.4,
  /* Vehículos en movimiento: se vigila el cuadro con frecuencia (scanMs, solo busca la placa amarilla: es barato) y, mientras
   * hay una placa a la vista, se lee sin pausa (un fotograma tras otro). Sin placa amarilla, el recuadro de respaldo se lee
   * solo cada 1000/idleFps ms. fps/idleAfterMs se conservan por compatibilidad. */
  fps: 8, idleFps: 1.5, idleAfterMs: 8000, scanMs: 90,
  vote: { window: 7, min: 3, maxAgeMs: 3000, releaseMs: 4000 } /* 3 lecturas iguales en 3 s: con el registro automático es peor registrar una placa mal leída que esperar ~0,3 s más (simulado: con 2 lecturas hubo placas erróneas, con 3 ninguna) */
};

function exists(url) {
  return new Promise(function (res, rej) {
    var x = new XMLHttpRequest();
    x.open('HEAD', url);
    /* El servidor de la SPA responde index.html (200, text/html) a cualquier ruta que no exista: eso cuenta como "falta". */
    x.onload = function () { (x.status === 200 && !/text\/html/.test(x.getResponseHeader('Content-Type') || '')) ? res() : rej(new Error('NO_FILE: ' + url)); };
    x.onerror = function () { rej(new Error('NO_FILE: ' + url)); };
    x.send();
  });
}

export function createPlateCamera(opts) {
  var cfg = merge(merge(DEFAULTS, { tess: TESS }), opts.config || {});
  var t = cfg.tess, video = opts.video;
  var st = { worker: null, stream: null, timer: null, busy: false, running: false, deviceId: null, n: 0, errs: 0, lastHit: 0, psm: '7' };
  var voter = new PlateVoter(t.vote);
  var wk = document.createElement('canvas'), wkCtx = wk.getContext('2d', { willReadFrequently: true });
  var lc = document.createElement('canvas'), lcCtx = lc.getContext('2d', { willReadFrequently: true });
  function status(state, msg, fatal) { if (opts.onStatus) opts.onStatus({ state: state, msg: msg || '', fatal: !!fatal }); }
  function isFatal(e) { return /NO_FILE|NO_CAMERA_API|NotAllowed|Security/.test(String((e && (e.message || e.name)) || e)); }

  function loadTess() {
    if (st.worker) return Promise.resolve();
    status('loading', 'Cargando lector de placas…');
    var base = new URL(t.base, location.href).href;
    return Promise.all([exists(base + 'worker.min.js'), exists(base + 'lang/eng.traineddata.gz')]).then(function () {
      return window.Tesseract ? null : loadScript(t.base + 'tesseract.min.js');
    }).then(function () {
      return window.Tesseract.createWorker('eng', 1, {
        workerPath: base + 'worker.min.js', corePath: base + 'core/', langPath: base + 'lang/',
        workerBlobURL: false, cacheMethod: 'none', gzip: true
      });
    }).then(function (w) {
      st.worker = w;
      return w.setParameters({ tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', tessedit_pageseg_mode: '7' }).then(function () { st.psm = '7'; });
    }).catch(function (e) {
      if (/NO_FILE/.test(String((e && e.message) || e))) throw e;
      throw new Error('NO_FILE: no se pudo iniciar Tesseract (' + String((e && e.message) || e) + ')');
    });
  }

  function stopStream() {
    if (st.stream) { st.stream.getTracks().forEach(function (tr) { tr.stop(); }); st.stream = null; }
    try { video.srcObject = null; } catch (e) { }
  }
  function openCamera(deviceId) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return Promise.reject(new Error('NO_CAMERA_API'));
    stopStream();
    var v = { width: { ideal: cfg.camera.width }, height: { ideal: cfg.camera.height }, frameRate: { ideal: cfg.camera.frameRate || 30 } };
    if (deviceId) v.deviceId = { exact: deviceId };
    return navigator.mediaDevices.getUserMedia({ video: v, audio: false }).catch(function (e) {
      /* La cámara elegida antes (p. ej. OBS Virtual Camera apagada) ya no sirve: se olvida y se usa la predeterminada. */
      if (deviceId && /NotReadable|NotFound|Overconstrained/.test(String((e && e.name) || e))) {
        st.deviceId = null; if (opts.onCameraReset) opts.onCameraReset();
        return openCamera(null);
      }
      throw e;
    }).then(function (stream) {
      stream.getVideoTracks().forEach(function (tr) { tr.onended = function () { if (st.running) { stop(); status('error', 'La cámara se desconectó.', false); } }; });
      st.stream = stream; video.srcObject = stream; video.muted = true; video.playsInline = true;
      fastShutter(stream);
      return video.play();
    });
  }

  /* Opcional (config.camera.exposureMs): obturador rápido para que el carro en movimiento no salga movido.
   * Solo funciona si la cámara deja controlar la exposición; con poca luz la imagen sale más oscura. Si falla, se ignora. */
  function fastShutter(stream) {
    var ms = cfg.camera.exposureMs; if (!ms) return;
    try {
      var tr = stream.getVideoTracks()[0], cap = tr.getCapabilities ? tr.getCapabilities() : {};
      if (!cap.exposureTime || !cap.exposureMode || cap.exposureMode.indexOf('manual') < 0) return;
      var val = Math.max(cap.exposureTime.min, Math.min(cap.exposureTime.max, ms * 10)); /* exposureTime va en unidades de 100 µs */
      tr.applyConstraints({ advanced: [{ exposureMode: 'manual', exposureTime: val }] }).catch(function () { });
    } catch (e) { }
  }

  function schedule(t0, fast) {
    if (!st.running) return;
    var now = performance.now();
    st.timer = setTimeout(tick, fast ? t.scanMs : Math.max(0, 1000 / t.fps - (now - (t0 || now))));
  }

  /* Recorta el recuadro, lo escala y lo prepara. modo 0: contraste estirado (grises); modo 1: blanco y negro por Otsu. */
  function prepare(mode, box) { /* box: rectángulo del cuadro de video a leer */
    var sw = box.x2 - box.x1, sh = box.y2 - box.y1, k = t.targetW / sw, pad = 12;
    var cw = Math.max(1, Math.round(sw * k)), ch = Math.max(1, Math.round(sh * k));
    wk.width = cw + 2 * pad; wk.height = ch + 2 * pad;
    wkCtx.fillStyle = '#fff'; wkCtx.fillRect(0, 0, wk.width, wk.height);
    wkCtx.drawImage(video, box.x1, box.y1, sw, sh, pad, pad, cw, ch);
    var im = wkCtx.getImageData(0, 0, wk.width, wk.height), d = im.data, n = wk.width * wk.height;
    var g = new Uint8Array(n), hist = new Uint32Array(256), i, y;
    for (i = 0; i < n; i++) { y = Math.round(0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2]); g[i] = y; hist[y]++; }
    if (mode === 0) {
      var lo = 0, hi = 255, acc = 0;
      for (i = 0; i < 256; i++) { acc += hist[i]; if (acc >= n * 0.02) { lo = i; break; } }
      acc = 0; for (i = 255; i >= 0; i--) { acc += hist[i]; if (acc >= n * 0.02) { hi = i; break; } }
      var span = Math.max(1, hi - lo);
      for (i = 0; i < n; i++) g[i] = Math.max(0, Math.min(255, Math.round((g[i] - lo) * 255 / span)));
    } else {
      var sum = 0, sumB = 0, wB = 0, best = 0, th = 127;
      for (i = 0; i < 256; i++) sum += i * hist[i];
      for (i = 0; i < 256; i++) {
        wB += hist[i]; if (!wB) continue;
        var wF = n - wB; if (!wF) break;
        sumB += i * hist[i];
        var mB = sumB / wB, mF = (sum - sumB) / wF, v = wB * wF * (mB - mF) * (mB - mF);
        if (v > best) { best = v; th = i; }
      }
      for (i = 0; i < n; i++) g[i] = g[i] > th ? 255 : 0;
    }
    for (i = 0; i < n; i++) { d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = g[i]; d[i * 4 + 3] = 255; }
    wkCtx.putImageData(im, 0, 0);
    return wk;
  }

  /* Busca una placa amarilla en el cuadro. Devuelve el rectángulo de sus LETRAS (sin la franja "COLOMBIA" de arriba) o null. */
  function locate(W, H) {
    var k = W / 320, h = Math.max(1, Math.round(320 * H / W));
    if (lc.width !== 320) lc.width = 320;
    if (lc.height !== h) lc.height = h;
    lcCtx.drawImage(video, 0, 0, 320, h);
    var data = lcCtx.getImageData(0, 0, 320, h).data, bb = locateYellowPlate(data, 320, h);
    if (!bb) return null;
    var w = (bb.x2 - bb.x1) * k, ht = (bb.y2 - bb.y1) * k, x1 = bb.x1 * k, y1 = bb.y1 * k;
    /* Recorte de las letras: por la banda de tinta más alta; si no se distingue, fracciones fijas del recuadro amarillo. */
    var lb = locateLetterBand(data, 320, h, bb);
    var text = lb ? { x1: Math.max(0, Math.round(lb.x1 * k)), y1: Math.max(0, Math.round(lb.y1 * k)), x2: Math.min(W, Math.round(lb.x2 * k)), y2: Math.min(H, Math.round(lb.y2 * k)) }
                  : { x1: Math.max(0, Math.round(x1 - 0.04 * w)), y1: Math.round(y1 + 0.27 * ht), x2: Math.min(W, Math.round(x1 + 1.04 * w)), y2: Math.round(y1 + 0.96 * ht) };
    return { plate: { x1: x1, y1: y1, x2: x1 + w, y2: y1 + ht }, text: text };
  }
  function setPsm(psm) {
    if (st.psm === psm) return Promise.resolve();
    st.psm = psm;
    return st.worker.setParameters({ tessedit_pageseg_mode: psm });
  }

  function tick() {
    if (!st.running) return;
    var t0 = performance.now();
    if (st.busy || document.hidden || video.readyState < 2 || !video.videoWidth) { schedule(t0); return; }
    st.busy = true;
    var W = video.videoWidth, H = video.videoHeight, r = t.roi, failed = false, text = null, skipped = false;
    var fallback = { x1: Math.round(W * r.x), y1: Math.round(H * r.y), x2: Math.round(W * (r.x + r.w)), y2: Math.round(H * (r.y + r.h)) };
    var loc = null, box = fallback;
    Promise.resolve().then(function () {
      loc = locate(W, H); /* barato (cuadro de 320 px): se hace en cada vuelta para ver llegar el carro */
      /* Vehículo en movimiento: con placa amarilla a la vista se lee sin pausa; sin ella, el recuadro de respaldo solo cada 1000/idleFps ms. */
      var now = performance.now();
      if (!loc && now - (st.lastOcr || 0) < 1000 / t.idleFps) { skipped = true; return null; }
      st.lastOcr = now;
      /* Con placa amarilla a la vista se alternan letras (contraste) y letras (blanco y negro), y de vez en cuando el recuadro de respaldo.
       * Sin ella, solo el recuadro de respaldo (así también se leen placas blancas), alternando contraste / blanco y negro. */
      var step = st.n++, useLoc = !!loc && step % 4 !== 3, mode = loc ? (step % 4 === 1 ? 1 : 0) : step % 2;
      box = useLoc ? loc.text : fallback;
      return setPsm(useLoc ? '7' : '6').then(function () { return st.worker.recognize(prepare(mode, box)); });
    }).then(function (res) {
      if (skipped) { text = st.lastText || null; return; }
      var d = (res && res.data) || {};
      text = String(d.text || '').trim(); st.lastText = text;
      var norm = pickPlateFromTess(d), conf = normalizeTessConf(d.confidence);
      if (norm && conf >= t.minConf) {
        st.lastHit = performance.now();
        var hit = voter.push(norm.plate, conf);
        if (hit && opts.onPlate) opts.onPlate({ plate: hit.plate, type: classify(hit.plate), confidence: hit.confidence, votes: hit.votes });
      } else voter.push(null);
    }).catch(function (e) {
      failed = true;
      if (++st.errs >= 3) { stop(); status('error', explain(e), isFatal(e)); } else status('error', explain(e), false);
    }).then(function () {
      if (!failed) st.errs = 0;
      if (loc) st.lastHit = Math.max(st.lastHit, performance.now() - t.idleAfterMs + 2000); /* placa a la vista: no bajar el ritmo */
      if (opts.onFrame) opts.onFrame({ width: W, height: H, box: loc ? loc.plate : fallback, text: text, found: !!loc, failed: failed });
      st.busy = false; schedule(t0, true);
    });
  }

  function start() {
    if (st.running) return Promise.resolve();
    return loadTess().then(function () { status('loading', 'Abriendo cámara…'); return openCamera(st.deviceId); }).then(function () {
      st.running = true; st.lastHit = performance.now(); voter.reset(); status('running', 'Leyendo… apunte la cámara a la placa (si no la marca, deje la placa dentro del recuadro verde).'); schedule();
    }).catch(function (e) { stop(); status('error', explain(e), isFatal(e)); throw e; });
  }
  function stop() { st.running = false; clearTimeout(st.timer); stopStream(); status('stopped', ''); }
  function setCamera(id) {
    st.deviceId = id || null;
    if (!st.running) return Promise.resolve();
    return openCamera(st.deviceId).catch(function (e) { stop(); status('error', explain(e), isFatal(e)); });
  }
  function listCameras() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return Promise.resolve([]);
    return navigator.mediaDevices.enumerateDevices().then(function (ds) {
      return ds.filter(function (dv) { return dv.kind === 'videoinput'; }).map(function (dv, i) { return { id: dv.deviceId, label: dv.label || ('Cámara ' + (i + 1)) }; });
    });
  }
  return { start: start, stop: stop, reset: function () { voter.reset(); }, setCamera: setCamera, listCameras: listCameras, isRunning: function () { return st.running; } };
}
