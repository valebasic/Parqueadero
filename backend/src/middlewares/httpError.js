// Error HTTP con código de estado, para lanzarlo desde servicios y controladores.
// Ejemplo: throw new HttpError(403, 'No tiene permiso sobre esta sede')
class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.details = details;
  }
}

module.exports = HttpError;
