// Exige un JWT de acceso válido Y una sesión viva en la base (no revocada, no vencida, sin exceder
// el tiempo de inactividad del rol). Deja el usuario en req.user:
//   { id, username, fullName, role, siteIds, sessionId, sessionExpiresAt }
// El rol y las sedes se leen de la base en cada petición: un cambio de permisos rige de inmediato.
const HttpError = require('./httpError');
const { verifyAccessToken } = require('../services/token.service');
const { resolveSession } = require('../services/auth.service');

// Peticiones automáticas (sondeos, tiempo real) que no deben contar como actividad del usuario
const BACKGROUND_HEADER = 'x-nexo-background';

async function authenticate(req, res, next) {
  const header = req.get('authorization') || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) {
    throw new HttpError(401, 'Debe iniciar sesión', { code: 'AUTH_REQUIRED' });
  }

  let claims;
  try {
    claims = verifyAccessToken(token);
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      throw new HttpError(401, 'El token de acceso venció', { code: 'TOKEN_EXPIRED' });
    }
    throw new HttpError(401, 'Token de acceso inválido', { code: 'TOKEN_INVALID' });
  }

  req.user = await resolveSession(claims, req, { countsAsActivity: req.get(BACKGROUND_HEADER) !== '1' });
  next();
}

module.exports = authenticate;
