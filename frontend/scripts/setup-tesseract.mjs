// Copia a public/tesseract/ los archivos que necesita la lectura de placas por cámara (motor Tesseract, WASM).
// Corre solo después de `npm install` (postinstall). A mano: npm run setup:placas
// Vienen de los paquetes tesseract.js y @tesseract.js-data/eng; public/tesseract/ no se sube a git.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const nm = path.join(root, 'node_modules');
const dst = path.join(root, 'public', 'tesseract');
const kb = (f) => `${Math.round(fs.statSync(f).size / 1024)} KB`;
let ok = true;

function copy(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
  console.log(`  ✓ ${path.relative(root, to)} (${kb(to)})`);
}
function find(dir, name, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) find(p, name, out);
    else if (e.name === name) out.push(p);
  }
  return out;
}

console.log('Lectura de placas: preparando public/tesseract/');
const dist = path.join(nm, 'tesseract.js', 'dist');
const core = path.join(nm, 'tesseract.js-core');
if (!fs.existsSync(dist)) {
  console.log('  ✗ Falta el paquete tesseract.js (npm install)');
  ok = false;
} else {
  for (const f of ['tesseract.min.js', 'worker.min.js']) {
    if (fs.existsSync(path.join(dist, f))) copy(path.join(dist, f), path.join(dst, f));
    else { console.log(`  ✗ No está ${f} en tesseract.js/dist`); ok = false; }
  }
  const cores = fs.existsSync(core) ? fs.readdirSync(core).filter((f) => /^tesseract-core.*\.(js|wasm)$/.test(f)) : [];
  if (!cores.length) { console.log('  ✗ No se encontró tesseract.js-core'); ok = false; }
  cores.forEach((f) => copy(path.join(core, f), path.join(dst, 'core', f)));
  const langs = find(path.join(nm, '@tesseract.js-data', 'eng'), 'eng.traineddata.gz');
  const pick = langs.find((p) => /best_int/.test(p)) || langs[0]; // "best_int" lee mejor
  if (!pick) { console.log('  ✗ No se encontró eng.traineddata.gz (@tesseract.js-data/eng)'); ok = false; }
  else copy(pick, path.join(dst, 'lang', 'eng.traineddata.gz'));
}

// No se corta la instalación si algo falla: la app funciona igual y la cámara muestra el aviso de archivos faltantes.
console.log(ok ? 'Listo.' : 'Faltan archivos: la lectura por cámara mostrará un aviso hasta que estén.');
