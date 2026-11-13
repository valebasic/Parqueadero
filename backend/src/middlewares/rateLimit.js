// Límite de peticiones por IP (express-rate-limit), reutilizable para cualquier ruta pública
// sensible: login de operadores y, más adelante, el portal del cliente (RF57).
//
// Ojo: el contador vive en memoria del proceso. Con varias instancias de la API detrás de un
// balanceador hay que usar un store compartido (p. ej. Redis) para que el límite sea global.
// Detrás de un proxy inverso, configurar TRUST_PROXY para que la IP sea la del cliente real.
const { rateLimit } = require('express-rate-limit');

function minutesText(ms) {
  const minutes = Math.max(1, Math.ceil(ms / 60000));
  return `${minutes} ${minutes === 1 ? 'minuto' : 'minutos'}`;
}

/**
 * Crea un limitador por IP que responde 429 en el formato de error de la API.
 * @param {object} options
 * @param {number} options.limit       intentos permitidos por ventana
 * @param {number} options.windowMs    duración de la ventana en ms
 * @param {string} [options.message]   texto antes de "Intente de nuevo en N minutos."
 * @param {boolean} [options.skipSuccessfulRequests]  no contar las respuestas 2xx (p. ej. logins correctos)
 * @param {(req) => string} [options.keyGenerator]  clave del contador (por defecto la IP)
 */
function createRateLimiter({
  limit,
  windowMs,
  message = 'Demasiados intentos desde esta conexión.',
  skipSuccessfulRequests = false,
  keyGenerator,
}) {
  return rateLimit({
    limit,
    windowMs,
    skipSuccessfulRequests,
    // Por defecto por IP; p. ej. NexoIA limita por usuario: keyGenerator: (req) => `user:${req.user.id}`
    ...(keyGenerator ? { keyGenerator } : {}),
    standardHeaders: 'draft-7', // encabezado RateLimit con cupo y reinicio
    legacyHeaders: false,
    handler(req, res, next, options) {
      const resetMs = req.rateLimit?.resetTime ? req.rateLimit.resetTime.getTime() - Date.now() : options.windowMs;
      res.status(429).json({
        ok: false,
        error: `${message} Intente de nuevo en ${minutesText(resetMs)}.`,
        code: 'RATE_LIMITED',
        details: { retryAfterSeconds: Math.max(1, Math.ceil(resetMs / 1000)) },
      });
    },
  });
}

// Login de operadores y administradores: por defecto 20 intentos cada 15 minutos por IP.
// Complementa el bloqueo por usuario (5 intentos) frente a quien prueba muchos usuarios distintos.
const loginRateLimiter = createRateLimiter({
  limit: Number.parseInt(process.env.LOGIN_RATE_LIMIT_MAX, 10) || 20,
  windowMs: (Number.parseInt(process.env.LOGIN_RATE_LIMIT_WINDOW_MIN, 10) || 15) * 60 * 1000,
  message: 'Demasiados intentos de inicio de sesión desde esta conexión.',
});

module.exports = { createRateLimiter, loginRateLimiter };
