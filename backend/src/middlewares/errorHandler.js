const env = require('../config/env');

// Manejador central de errores: siempre responde JSON y no expone detalles internos en producción.
// Express 5 envía aquí también los errores de los controladores async (no hace falta try/catch).
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  // Errores de body-parser (JSON mal formado, cuerpo demasiado grande) traen su propio status
  let status = err.status || err.statusCode || 500;
  // PostgreSQL apagado o inalcanzable → 503 en vez de 500
  const dbUnavailable = ['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', '57P03'].includes(err.code);
  if (dbUnavailable) status = 503;
  const isServerError = status >= 500;

  if (isServerError && !env.isTest) {
    console.error(err);
  }

  const body = {
    ok: false,
    error: dbUnavailable
      ? 'Base de datos no disponible'
      : isServerError && env.isProduction
        ? 'Error interno del servidor'
        : err.message,
  };
  if (err.details) body.details = err.details;

  res.status(status).json(body);
}

module.exports = errorHandler;
