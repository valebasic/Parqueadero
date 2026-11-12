const { app, BrowserWindow, Menu, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');

/* ---- Asistente IA (Gemini) ----
 * La API key vive solo en el proceso principal (archivo en userData, o variable
 * de entorno GEMINI_API_KEY); nunca llega al HTML. Solo se envían datos agregados. */
// Carga .env (junto a main.js o en userData) sin dependencias; no pisa variables ya definidas.
[path.join(__dirname, '.env'), path.join(app.getPath('userData'), '.env')].forEach(f => {
  try {
    fs.readFileSync(f, 'utf8').split(/\r?\n/).forEach(l => {
      const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    });
  } catch (e) {}
});
const agente = require('./agente');
const keyFile = () => path.join(app.getPath('userData'), 'ai-key.txt');
function readKey() {
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY.trim();
  try { return fs.readFileSync(keyFile(), 'utf8').trim(); } catch (e) { return ''; }
}
ipcMain.handle('nexo-ai:has-key', () => !!readKey());
ipcMain.handle('nexo-ai:set-key', (_e, key) => {
  try { fs.writeFileSync(keyFile(), String(key || '').trim(), 'utf8'); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
});
const memoria = require('./agente/memoria');
memoria.init(app.getPath('userData'));
// Preferencias del administrador (memoria del agente). Solo el rol administrador puede leerlas o cambiarlas.
ipcMain.handle('nexo-ai:get-prefs', (_e, role) => agente.normalizarRol(role) === 'administrador' ? { ok: true, preferencias: memoria.leer() } : { ok: false, error: 'SIN_PERMISO' });
ipcMain.handle('nexo-ai:set-prefs', (_e, { role, text } = {}) => agente.normalizarRol(role) === 'administrador' ? memoria.guardar(text) : { ok: false, error: 'SIN_PERMISO' });
// Auditoria de acciones del agente.
ipcMain.handle('nexo-ai:audit', (_e, evento) => memoria.auditar(evento));
// Informes generados por el agente: se guardan en Documentos\Nexo informes (PDF o Excel/CSV).
const carpetaInformes = () => path.join(app.getPath('documents'), 'Nexo informes');
ipcMain.handle('nexo-ai:guardar-informe', async (_e, { nombre, formato, contenido } = {}) => {
  try {
    const base = String(nombre || 'informe').replace(/[^a-z0-9_-]/gi, '_').slice(0, 80) || 'informe';
    const dir = carpetaInformes(); fs.mkdirSync(dir, { recursive: true });
    const sello = new Date().toISOString().slice(11, 19).replace(/:/g, '');
    if (formato === 'excel') {
      const archivo = path.join(dir, base + '_' + sello + '.csv');
      fs.writeFileSync(archivo, '﻿' + String(contenido || ''), 'utf8'); // BOM: Excel abre bien tildes
      return { ok: true, archivo };
    }
    if (formato === 'pdf') {
      const w = new BrowserWindow({ show: false, webPreferences: { javascript: false } });
      try {
        await w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(String(contenido || '')));
        const pdf = await w.webContents.printToPDF({ printBackground: true, pageSize: 'Letter' });
        const archivo = path.join(dir, base + '_' + sello + '.pdf');
        fs.writeFileSync(archivo, pdf);
        return { ok: true, archivo };
      } finally { w.destroy(); }
    }
    return { ok: false, error: 'Formato no valido' };
  } catch (e) { return { ok: false, error: e.message }; }
});
// Abre un informe generado (solo archivos dentro de la carpeta de informes).
ipcMain.handle('nexo-ai:abrir-informe', async (_e, archivo) => {
  const dir = path.resolve(carpetaInformes()), f = path.resolve(String(archivo || ''));
  if (!f.startsWith(dir + path.sep) || !fs.existsSync(f)) return { ok: false, error: 'Archivo no valido' };
  const err = await shell.openPath(f);
  return err ? { ok: false, error: err } : { ok: true };
});
ipcMain.handle('nexo-ai:ask', async (_e, { question, history, role, extra } = {}) => {
  const key = readKey();
  if (!key) return { ok: false, error: 'NO_KEY' };
  const v = agente.ENTRADA.validar(question);
  if (!v.ok) return { ok: false, error: v.error };
  // El rol se normaliza aqui (menor privilegio): define que herramientas puede pedir la IA.
  const rol = agente.normalizarRol(role);
  const system = agente.construirInstruccion(rol, rol === 'administrador' ? memoria.leer() : '');
  const salida = agente.salida(rol);
  let pasos;
  try { pasos = agente.sanitizarPasos(extra, rol); } catch (e) { return { ok: false, error: e.message }; }
  const contents = (Array.isArray(history) ? history.slice(-agente.ENTRADA.maxHistorial) : []).map(h => ({ role: h.role === 'user' ? 'user' : 'model', parts: [{ text: String(h.text || '').slice(0, 2000) }] }));
  contents.push({ role: 'user', parts: [{ text: v.pregunta }] }, ...pasos);
  const declaraciones = agente.herramientasDe(rol);
  try {
    const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models/' + agente.MODELO + ':generateContent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents, tools: [{ functionDeclarations: declaraciones }], generationConfig: { temperature: salida.temperatura, maxOutputTokens: salida.maxTokens } })
    });
    const j = await res.json();
    if (!res.ok) return { ok: false, error: (j.error && j.error.message) || ('HTTP ' + res.status) };
    const contenido = j.candidates && j.candidates[0] && j.candidates[0].content;
    const parts = (contenido && contenido.parts) || [];
    const llamadas = parts.filter(p => p.functionCall).map(p => ({ nombre: p.functionCall.name, args: p.functionCall.args || {} }));
    if (llamadas.length) {
      if (pasos.length >= agente.MAX_RONDAS * 2) return { ok: false, error: 'La consulta necesitó demasiados pasos. Intenta una pregunta más concreta.' };
      const permitidas = agente.nombresDe(rol);
      if (llamadas.some(c => !permitidas.includes(c.nombre))) return { ok: false, error: 'La IA pidió una herramienta que tu rol no puede usar.' };
      return { ok: true, tipo: 'herramientas', contenido: { role: 'model', parts }, llamadas };
    }
    const text = parts.filter(p => p.text && !p.thought).map(p => p.text).join('');
    return text ? { ok: true, tipo: 'texto', text } : { ok: false, error: 'Respuesta vacía del modelo' };
  } catch (e) { return { ok: false, error: 'Sin conexión o error de red: ' + e.message }; }
});

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1024,
    minHeight: 700,
    title: 'Nexo.app',
    icon: path.join(__dirname, 'icon.ico'),
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  win.loadFile(path.join(__dirname, 'login.html'));
}

// Quita por completo la barra de menú (Archivo/Edición/Ver/Ventana/Ayuda)
// para que se vea como una app de escritorio y no como un navegador.
Menu.setApplicationMenu(null);

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
