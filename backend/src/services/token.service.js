// Tokens: JWT de acceso (corto) y refresh token opaco (aleatorio; en la base solo su hash).
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { security } = require('../config/security');

function signAccessToken({ userId, sessionId }) {
  return jwt.sign({ sid: sessionId }, security.jwtSecret, {
    algorithm: 'HS256',
    subject: String(userId),
    issuer: security.jwtIssuer,
    audience: security.jwtAudience,
    expiresIn: security.accessTokenTtlSeconds,
  });
}

// Lanza TokenExpiredError / JsonWebTokenError si no es válido
function verifyAccessToken(token) {
  const payload = jwt.verify(token, security.jwtSecret, {
    algorithms: ['HS256'],
    issuer: security.jwtIssuer,
    audience: security.jwtAudience,
  });
  return { userId: Number.parseInt(payload.sub, 10), sessionId: payload.sid };
}

// Token para sincronizar operaciones hechas sin conexión (RF60): solo sirve en /api/sync, dura 8 h
// y no depende de la inactividad (el operador estuvo sin internet, con bloqueo local).
const OFFLINE_AUDIENCE = 'nexo-offline';
const OFFLINE_TTL_SECONDS = 8 * 60 * 60;

function signOfflineToken({ userId, sessionId }) {
  return jwt.sign({ sid: sessionId, scope: 'offline-sync' }, security.jwtSecret, {
    algorithm: 'HS256',
    subject: String(userId),
    issuer: security.jwtIssuer,
    audience: OFFLINE_AUDIENCE,
    expiresIn: OFFLINE_TTL_SECONDS,
  });
}

function verifyOfflineToken(token) {
  const payload = jwt.verify(token, security.jwtSecret, {
    algorithms: ['HS256'],
    issuer: security.jwtIssuer,
    audience: OFFLINE_AUDIENCE,
  });
  if (payload.scope !== 'offline-sync') throw new jwt.JsonWebTokenError('scope');
  return { userId: Number.parseInt(payload.sub, 10), sessionId: payload.sid, exp: payload.exp };
}

function generateRefreshToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function hashRefreshToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

module.exports = {
  signAccessToken,
  verifyAccessToken,
  signOfflineToken,
  verifyOfflineToken,
  OFFLINE_TTL_SECONDS,
  generateRefreshToken,
  hashRefreshToken,
};
