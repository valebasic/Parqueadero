// Parámetros de seguridad (RF01-RF06). Los secretos salen de .env; las reglas de negocio viven aquí.
const env = require('./env');

const MIN_SECRET_LENGTH = 32;

const security = {
  bcryptCost: 12,

  // JWT de acceso: corto, viaja en el encabezado Authorization y vive solo en memoria del navegador
  jwtSecret: process.env.JWT_SECRET || '',
  jwtIssuer: 'nexo-api',
  jwtAudience: 'nexo-web',
  accessTokenTtlSeconds: 5 * 60,

  // Sesión (refresh token en cookie httpOnly)
  refreshCookieName: 'nexo_rt',
  refreshCookiePath: '/api/auth',
  sessionMaxHours: Number.parseInt(process.env.SESSION_MAX_HOURS, 10) || 12,
  // Las cookies solo viajan por HTTPS en producción (COOKIE_SECURE=false lo desactiva, p. ej. en una LAN sin TLS)
  cookieSecure: process.env.COOKIE_SECURE ? process.env.COOKIE_SECURE === 'true' : env.isProduction,

  // Cierre por inactividad según el rol
  idleTimeoutMinutes: { OP: 15, AS: 30, AG: 30 },
  // Cada cuánto como mínimo se actualiza last_activity_at (evita una escritura por petición)
  activityTouchSeconds: 30,

  // Bloqueo por intentos fallidos
  maxFailedLogins: 5,
  lockMinutes: 5,

  // Política de contraseñas
  passwordMinLength: 8,
  passwordMaxLength: 72, // bcrypt ignora lo que pase de 72 bytes
};

function idleTimeoutSecondsFor(role) {
  return (security.idleTimeoutMinutes[role] || security.idleTimeoutMinutes.OP) * 60;
}

// Se llama al arrancar el servidor: sin un secreto JWT fuerte la API no debe iniciar
function assertSecurityConfig() {
  if (security.jwtSecret.length < MIN_SECRET_LENGTH) {
    throw new Error(
      `JWT_SECRET debe estar en backend/.env y tener al menos ${MIN_SECRET_LENGTH} caracteres ` +
        "(genere uno con: node -e \"console.log(require('crypto').randomBytes(48).toString('base64url'))\")",
    );
  }
}

module.exports = { security, idleTimeoutSecondsFor, assertSecurityConfig };
