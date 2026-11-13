// Arranca la v2.0 en local: backend (http://localhost:3000) + frontend (http://localhost:5173).
// Uso: npm start   (desde la carpeta raíz). Ctrl+C detiene los dos.
const { spawn } = require('child_process');
const path = require('path');

const raiz = path.join(__dirname, '..');
const procesos = [];

function lanzar(nombre, carpeta, args = '') {
  const p = spawn(`npm run dev${args}`, { cwd: path.join(raiz, carpeta), shell: true, stdio: 'inherit' });
  p.on('exit', (code) => {
    console.log(`[${nombre}] terminó (código ${code})`);
    apagar();
  });
  procesos.push(p);
}

let cerrando = false;
function apagar() {
  if (cerrando) return;
  cerrando = true;
  for (const p of procesos) {
    try {
      if (process.platform === 'win32') spawn('taskkill', ['/pid', String(p.pid), '/T', '/F']);
      else p.kill('SIGTERM');
    } catch (_) { /* ya cerrado */ }
  }
  setTimeout(() => process.exit(0), 500);
}
process.on('SIGINT', apagar);
process.on('SIGTERM', apagar);

console.log('Nexo v2.0 → abre http://localhost:5173');
lanzar('backend', 'backend');
// --host: el frontend también se abre desde otros equipos de la misma red (celular, compañero)
lanzar('frontend', 'frontend', ' -- --host');
