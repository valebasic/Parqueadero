// Lectura de placas por cámara (VA2 / RF35-RF37), lógica pura: no usa el navegador y se prueba con
// `npm run test:placas`. Viene de mvc/plate-reader.js de la v1.0 web (motor Tesseract); las reglas no cambiaron.
//
// Placas colombianas: carro ABC123, moto ABC12D. El OCR confunde letras y números (O/0, B/8, S/5...): se
// corrigen según la posición. Se exige que 3 lecturas iguales coincidan antes de confirmar una placa.

/* Placas colombianas: carro ABC123, moto ABC12D                       */
/* ------------------------------------------------------------------ */
var TO_LETTER = { '0': 'O', '1': 'I', '2': 'Z', '4': 'A', '5': 'S', '6': 'G', '8': 'B' };
var TO_DIGIT = { O: '0', Q: '0', D: '0', I: '1', L: '1', Z: '2', A: '4', S: '5', G: '6', B: '8', T: '7' };

export function cleanText(s) { return String(s == null ? '' : s).toUpperCase().replace(/[^A-Z0-9]/g, ''); }

/* Ajusta una ventana de 6 caracteres: posiciones 1-3 letras, 4-5 números, 6 número (carro) o letra (moto). */
function fixWindow(w) {
  var out = '', fixes = 0;
  for (var i = 0; i < 6; i++) {
    var c = w.charAt(i);
    if (i < 3) {
      if (/[0-9]/.test(c)) { if (!TO_LETTER[c]) return null; c = TO_LETTER[c]; fixes++; }
    } else if (i < 5) {
      if (/[A-Z]/.test(c)) { if (!TO_DIGIT[c]) return null; c = TO_DIGIT[c]; fixes++; }
    }
    out += c;
  }
  return { plate: out, fixes: fixes };
}

export function classify(plate) {
  if (/^[A-Z]{3}[0-9]{3}$/.test(plate)) return 'carro';
  if (/^[A-Z]{3}[0-9]{2}[A-Z]$/.test(plate)) return 'moto';
  return null;
}

/* Devuelve {plate, type, fixes} o null si el texto no puede ser una placa colombiana de carro/moto. */
export function normalizePlate(raw) {
  var s = cleanText(raw);
  if (s.length < 6 || s.length > 8) return null;
  var best = null;
  for (var i = 0; i + 6 <= s.length; i++) {
    var r = fixWindow(s.substr(i, 6));
    if (r && classify(r.plate) && (!best || r.fixes < best.fixes)) best = r;
  }
  if (!best) return null;
  return { plate: best.plate, type: classify(best.plate), fixes: best.fixes };
}

function hamming1(a, b) {
  if (a.length !== b.length) return false;
  var d = 0;
  for (var i = 0; i < a.length; i++) if (a.charAt(i) !== b.charAt(i) && ++d > 1) return false;
  return true;
}

/* ------------------------------------------------------------------ */
/* Votación entre fotogramas                                           */
/* ------------------------------------------------------------------ */
export function PlateVoter(o) {
  o = o || {};
  this.win = o.window || 5; this.min = o.min || 3;
  this.maxAge = o.maxAgeMs || 3000; this.release = o.releaseMs || 4000;
  this.reset();
}
PlateVoter.prototype.reset = function () { this.reads = []; this.locked = null; this.lastSeen = 0; };
/* plate: texto normalizado o null (no se vio placa). Devuelve {plate,confidence,votes} cuando una placa se confirma. */
PlateVoter.prototype.push = function (plate, conf, now) {
  now = now == null ? Date.now() : now;
  if (plate) this.reads.push({ plate: plate, conf: conf == null ? 1 : conf, t: now });
  var maxAge = this.maxAge;
  this.reads = this.reads.filter(function (r) { return now - r.t <= maxAge; }).slice(-this.win);

  if (this.locked) {
    if (plate && (plate === this.locked || hamming1(plate, this.locked))) this.lastSeen = now; /* misma placa (o error de 1 carácter) */
    else if (now - this.lastSeen > this.release) this.locked = null;
  }
  var tally = {}, best = null;
  this.reads.forEach(function (r) {
    var t = tally[r.plate] || (tally[r.plate] = { plate: r.plate, n: 0, sum: 0 });
    t.n++; t.sum += r.conf;
  });
  for (var k in tally) if (!best || tally[k].n > best.n || (tally[k].n === best.n && tally[k].sum > best.sum)) best = tally[k];
  if (!best || best.n < this.min) return null;
  if (this.locked && (best.plate === this.locked || (hamming1(best.plate, this.locked) && now - this.lastSeen <= this.release))) return null;
  this.locked = best.plate; this.lastSeen = now;
  return { plate: best.plate, confidence: best.sum / best.n, votes: best.n };
};

/* Las placas colombianas traen impresa la palabra "COLOMBIA": el OCR la lee seguido y, con las correcciones de
 * letra/número, puede parecer una placa. Se descarta cualquier palabra que se le parezca (5+ letras en su sitio). */
export function looksLikeCountry(tok) {
  var c = cleanText(tok).replace(/0/g, 'O').replace(/1/g, 'I').replace(/5/g, 'S').replace(/8/g, 'B'), W = 'COLOMBIA';
  if (c.length < 5 || c.length > 9) return false;
  for (var off = -(c.length - 1); off <= W.length - 1; off++) {
    var m = 0;
    for (var i = 0; i < c.length; i++) { var j = i + off; if (j >= 0 && j < W.length && c.charAt(i) === W.charAt(j)) m++; }
    if (m >= 5) return true;
  }
  return false;
}

/* Motor Tesseract: de la respuesta del OCR ({text, words}) saca la mejor placa válida, o null.
 * Prueba el texto completo, cada palabra y uniones de 2-3 palabras vecinas (la placa puede salir partida: "ABC 123"). */
export function pickPlateFromTess(d) {
  d = d || {};
  var toks = (d.words && d.words.length ? d.words.map(function (w) { return w && w.text ? String(w.text) : ''; }) : String(d.text || '').split(/\s+/))
    .filter(function (x) { return cleanText(x) && !looksLikeCountry(x); });
  var texts = [toks.join('')], best = null;
  for (var i = 0; i < toks.length; i++) {
    texts.push(toks[i]);
    if (i + 1 < toks.length) texts.push(toks[i] + toks[i + 1]);
    if (i + 2 < toks.length) texts.push(toks[i] + toks[i + 1] + toks[i + 2]);
  }
  texts.forEach(function (t) {
    var n = normalizePlate(t);
    if (n && (!best || n.fixes < best.fixes)) best = n;
  });
  return best;
}

/* Confianza del OCR de Tesseract como fracción 0-1. Según la versión/modo, tesseract.js la entrega en 0-100, en 0-1 o en 0
 * (con la lista de caracteres permitidos y lectura de una línea es común que llegue 0 aunque el texto esté bien). Un 0 o un valor
 * ausente significa "desconocida" y NO descarta la lectura: el filtro real es la votación (3 lecturas iguales) y el formato de placa. */
export function normalizeTessConf(raw) {
  var n = Number(raw);
  if (!isFinite(n) || n <= 0) return 0.5;
  return n > 1 ? Math.min(1, n / 100) : n;
}

/* Localizador de placas amarillas (sin modelos): busca en el cuadro el bloque amarillo más grande con forma de placa.
 * d: datos RGBA del cuadro (ImageData.data), W x H. Devuelve {x1,y1,x2,y2,fill,area} o null (no hay placa amarilla a la vista).
 * Las placas blancas no se detectan aquí: el motor usa entonces el recuadro guía. Función pura, se prueba con node. */
export function locateYellowPlate(d, W, H, o) {
  o = o || {};
  var step = Math.max(1, Math.round(W / (o.gridW || 320))), gw = Math.floor(W / step), gh = Math.floor(H / step);
  var N = gw * gh, mask = new Uint8Array(N), seen = new Uint8Array(N), stack = new Int32Array(N), best = null, x, y, i, p;
  for (y = 0; y < gh; y++) for (x = 0; x < gw; x++) {
    p = ((y * step) * W + x * step) * 4;
    var r = d[p], g = d[p + 1], b = d[p + 2], mn = r < g ? r : g, mx = r > g ? r : g;
    if (mx >= 70 && b < 0.5 * mn && r >= g * 0.8 && r <= g * 1.6) mask[y * gw + x] = 1;
  }
  for (i = 0; i < N; i++) {
    if (!mask[i] || seen[i]) continue;
    var sp = 0, area = 0, minx = gw, maxx = 0, miny = gh, maxy = 0;
    stack[sp++] = i; seen[i] = 1;
    while (sp) {
      var c = stack[--sp], cx = c % gw, cy = (c - cx) / gw;
      area++; if (cx < minx) minx = cx; if (cx > maxx) maxx = cx; if (cy < miny) miny = cy; if (cy > maxy) maxy = cy;
      if (cx > 0 && mask[c - 1] && !seen[c - 1]) { seen[c - 1] = 1; stack[sp++] = c - 1; }
      if (cx < gw - 1 && mask[c + 1] && !seen[c + 1]) { seen[c + 1] = 1; stack[sp++] = c + 1; }
      if (cy > 0 && mask[c - gw] && !seen[c - gw]) { seen[c - gw] = 1; stack[sp++] = c - gw; }
      if (cy < gh - 1 && mask[c + gw] && !seen[c + gw]) { seen[c + gw] = 1; stack[sp++] = c + gw; }
    }
    var bw = maxx - minx + 1, bh = maxy - miny + 1, fill = area / (bw * bh), asp = bw / bh;
    if (area >= N * 0.004 && area <= N * 0.6 && asp >= 1.1 && asp <= 4.2 && fill >= 0.5 && (!best || area > best.area))
      best = { x1: minx * step, y1: miny * step, x2: Math.min(W, (maxx + 1) * step), y2: Math.min(H, (maxy + 1) * step), fill: fill, area: area };
  }
  return best;
}


/* Ubica las LETRAS dentro de una placa amarilla ya encontrada (bb, en el mismo sistema de coordenadas que d/W/H).
 * En vez de recortar por fracciones fijas (que cortaban la parte de arriba de las letras y dejaban entrar la línea
 * de la ciudad o la franja COLOMBIA), mide las filas oscuras: la banda más alta de tinta es la de las letras grandes.
 * Solo cuenta la tinta que está ENTRE los píxeles amarillos de cada fila: así los rincones de fondo que quedan dentro
 * del rectángulo cuando la placa va inclinada (o el marco negro) no se confunden con letras.
 * Devuelve {x1,y1,x2,y2} o null (si no se distingue, el llamador usa las fracciones fijas). Función pura. */
export function locateLetterBand(d, W, H, bb) {
  if (!bb) return null;
  var bx1 = Math.max(0, bb.x1), by1 = Math.max(0, bb.y1), bx2 = Math.min(W, bb.x2), by2 = Math.min(H, bb.y2);
  var bw = bx2 - bx1, bh = by2 - by1, x, y, p, i;
  if (bw < 20 || bh < 10) return null;
  var lum = new Uint8Array(bw * bh), yel = new Uint8Array(bw * bh), hist = new Uint32Array(256), nY = 0;
  for (y = 0; y < bh; y++) for (x = 0; x < bw; x++) {
    p = ((by1 + y) * W + (bx1 + x)) * 4;
    var r = d[p], g = d[p + 1], b = d[p + 2], mn = r < g ? r : g, mxv = r > g ? r : g;
    var l = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
    lum[y * bw + x] = l;
    if (mxv >= 70 && b < 0.5 * mn && r >= g * 0.8 && r <= g * 1.6) { yel[y * bw + x] = 1; hist[l]++; nY++; }
  }
  if (nY < bw * bh * 0.15) return null;
  var acc = 0, ref = 255;
  for (i = 0; i < 256; i++) { acc += hist[i]; if (acc >= nY * 0.5) { ref = i; break; } } /* brillo típico del amarillo */
  var thr = ref * 0.5, rows = new Float32Array(bh), ext = new Int32Array(bh * 2), mx = 0;
  for (y = 0; y < bh; y++) {
    var xa = -1, xb = -1;
    for (x = 0; x < bw; x++) if (yel[y * bw + x]) { if (xa < 0) xa = x; xb = x; }
    ext[y * 2] = xa; ext[y * 2 + 1] = xb;
    if (xa < 0 || xb - xa < bw * 0.2) continue;
    var c = 0;
    for (x = xa; x <= xb; x++) if (!yel[y * bw + x] && lum[y * bw + x] < thr) c++;
    rows[y] = c / (xb - xa + 1); if (rows[y] > mx) mx = rows[y];
  }
  if (mx < 0.05) return null;
  var cut = mx * 0.4, bestA = -1, bestB = -1, runA = -1, runB = -1, gap = 0, maxGap = Math.max(2, Math.round(bh * 0.015));
  for (y = 0; y <= bh; y++) {
    var on = y < bh && rows[y] >= cut;
    if (on) { if (runA < 0) runA = y; gap = 0; runB = y; }
    else if (runA >= 0) {
      gap++;
      if (gap > maxGap || y === bh) { if (bestA < 0 || runB - runA > bestB - bestA) { bestA = runA; bestB = runB; } runA = -1; gap = 0; }
    }
  }
  if (bestA < 0) return null;
  var hh = bestB - bestA + 1;
  if (hh < bh * 0.2 || hh > bh * 0.92) return null;
  var cx1 = -1, cx2 = -1;
  for (x = 0; x < bw; x++) {
    var cc = 0, tot = 0;
    for (y = bestA; y <= bestB; y++) if (ext[y * 2] >= 0 && x >= ext[y * 2] && x <= ext[y * 2 + 1]) { tot++; if (!yel[y * bw + x] && lum[y * bw + x] < thr) cc++; }
    if (tot > hh * 0.5 && cc / tot >= 0.08) { if (cx1 < 0) cx1 = x; cx2 = x; }
  }
  if (cx1 < 0 || cx2 - cx1 < bw * 0.3) return null;
  var padY = Math.round(hh * 0.06), padX = Math.round((cx2 - cx1) * 0.03);
  return { x1: Math.max(0, bx1 + cx1 - padX), y1: Math.max(0, by1 + bestA - padY), x2: Math.min(W, bx1 + cx2 + 1 + padX), y2: Math.min(H, by1 + bestB + 1 + padY) };
}
