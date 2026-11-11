// Error HTTP con código de estado, para lanzarlo desde servicios y controladores.
// Ejemplo: throw new HttpError(403, 'No tiene acceso a esta sede', { code: 'FORBIDDEN_SITE' })
//   code    → identificador estable que el frontend puede usar (el mensaje puede cambiar)
//   details → datos extra (p. ej. errores de validación por campo)
class HttpError extends Error {
  constructor(status, message, { code, details } = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

module.exports = HttpError;
