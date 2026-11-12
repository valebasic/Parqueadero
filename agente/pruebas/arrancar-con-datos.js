/* Lanzador de PRUEBAS: abre Nexo.app con un perfil aislado (no toca tus datos reales)
 * y carga los datos de datos-prueba.js la primera vez.
 *   npm run pruebas
 * Para empezar de cero: cierra la app y borra la carpeta  %APPDATA%\nexoapp-pruebas */
const { app } = require('electron');
const path = require('path');
const fs = require('fs');

app.setPath('userData', path.join(app.getPath('appData'), 'nexoapp-pruebas'));
const semilla = fs.readFileSync(path.join(__dirname, 'datos-prueba.js'), 'utf8');

app.on('browser-window-created', (_e, win) => {
  win.webContents.on('did-finish-load', () => {
    win.webContents.executeJavaScript(semilla).catch(err => console.error('[seed] ', err.message));
  });
});

require('../../main.js');
