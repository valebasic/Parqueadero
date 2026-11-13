// Construye la aplicación Express sin abrir el puerto, para poder probarla con Supertest.
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const env = require('./config/env');
const apiRoutes = require('./routes');
const notFound = require('./middlewares/notFound');
const errorHandler = require('./middlewares/errorHandler');

function createApp() {
  const app = express();

  app.disable('x-powered-by');
  // Detrás de un proxy inverso (nginx, balanceador) req.ip debe salir de X-Forwarded-For
  if (env.trustProxy) app.set('trust proxy', env.trustProxy);
  // Si este mismo servidor entrega la web (SERVE_FRONTEND=1, p. ej. en Render), se quita el "upgrade-insecure-requests"
  // de la política de seguridad: en HTTP local rompería la carga de los archivos; en HTTPS no cambia nada.
  app.use(
    process.env.SERVE_FRONTEND === '1'
      ? helmet({ contentSecurityPolicy: { useDefaults: true, directives: { 'upgrade-insecure-requests': null } } })
      : helmet(),
  );
  app.use(cors({ origin: env.corsOrigin, credentials: true }));
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());

  app.use('/api', apiRoutes);

  app.use('/api', notFound);

  // Opcional: el mismo servidor entrega la web ya compilada (frontend/dist). Pensado para plataformas con un
  // solo servicio (Render). Con nginx/Caddy delante (ver deploy/) no se usa. Cualquier ruta que no sea
  // /api ni /socket.io devuelve index.html para que funcione el enrutador de React.
  if (process.env.SERVE_FRONTEND === '1') {
    const dist = path.resolve(__dirname, '../../frontend/dist');
    const noCache = (res, file) => {
      if (/(^|[\\/])(index\.html|sw\.js|manifest\.webmanifest)$/.test(file)) res.setHeader('Cache-Control', 'no-cache');
    };
    app.use(express.static(dist, { index: false, setHeaders: noCache }));
    // Los archivos que no existen (/assets/x.js) deben dar 404, no index.html: por eso se excluyen las rutas con extensión
    app.get(/^\/(?!api(\/|$)|socket\.io(\/|$))(?!.*\.[A-Za-z0-9]+$).*/, (req, res) => {
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(path.join(dist, 'index.html'));
    });
  }

  app.use(errorHandler);

  return app;
}

module.exports = { createApp };
