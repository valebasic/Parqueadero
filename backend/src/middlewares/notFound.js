const HttpError = require('./httpError');

// Rutas de la API que no existen → 404 en JSON
function notFound(req, res, next) {
  next(new HttpError(404, `Ruta no encontrada: ${req.method} ${req.originalUrl}`));
}

module.exports = notFound;
