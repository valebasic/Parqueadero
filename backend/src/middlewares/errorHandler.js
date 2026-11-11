const env = require('../config/env');

// Manejador central de errores: siempre responde JSON y no expone detalles internos en producción.
// Express 5 envía aquí también los errores de los controladores async (no hace falta try/catch).
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  // Errores de body-parser (JSON mal formado, cuerpo demasiado grande) traen su propio status
  const status = err.status || err.statusCode || 500;
  const isServerError = status >= 500;

  if (isServerError && !env.isTest) {
    console.error(err);
  }

  const body = {
    ok: false,
    error: isServerError && env.isProduction ? 'Error interno del servidor' : err.message,
  };
  if (err.details) body.details = err.details;

  res.status(status).json(body);
}

module.exports = errorHandler;
