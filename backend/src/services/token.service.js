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

function generateRefreshToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function hashRefreshToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

module.exports = { signAccessToken, verifyAccessToken, generateRefreshToken, hashRefreshToken };
