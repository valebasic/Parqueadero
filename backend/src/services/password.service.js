// Hash y política de contraseñas (bcrypt, costo 12).
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const { security } = require('../config/security');

async function hashPassword(plain) {
  return bcrypt.hash(plain, security.bcryptCost);
}

async function verifyPassword(plain, hash) {
  if (typeof plain !== 'string' || typeof hash !== 'string') return false;
  return bcrypt.compare(plain, hash);
}

// Hash de relleno: cuando el usuario no existe se compara igual contra él, para que la respuesta
// tarde lo mismo y no delate qué usuarios existen.
let dummyHashPromise = null;
async function burnPasswordCheck(plain) {
  dummyHashPromise ??= bcrypt.hash('nexo-usuario-inexistente', security.bcryptCost);
  await bcrypt.compare(String(plain ?? ''), await dummyHashPromise);
}

// ---------------------------------------------------------------------------
// Contraseñas importadas de la v1.0 (mvc/model.js): "<salt_hex_32>:<sha256_hex_64>", donde el hash es
// SHA-256 (UTF-8) de salt + ':' + contraseña. Solo se usan para verificar el primer inicio de sesión;
// después se re-hashean con bcrypt y se borran.
// ---------------------------------------------------------------------------
const LEGACY_V1_RE = /^[0-9a-f]{32}:[0-9a-f]{64}$/;

function legacyV1Hash(plain, salt = crypto.randomBytes(16).toString('hex')) {
  const digest = crypto.createHash('sha256').update(`${salt}:${String(plain ?? '')}`, 'utf8').digest('hex');
  return `${salt}:${digest}`;
}

function isLegacyV1Hash(stored) {
  return typeof stored === 'string' && LEGACY_V1_RE.test(stored);
}

function verifyLegacyV1(plain, stored) {
  if (typeof plain !== 'string' || !isLegacyV1Hash(stored)) return false;
  const expected = Buffer.from(stored, 'utf8');
  const actual = Buffer.from(legacyV1Hash(plain, stored.slice(0, 32)), 'utf8');
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

/**
 * Verifica la contraseña de un usuario (fila con password_hash y legacy_password_hash).
 * Devuelve { ok, legacy }: legacy = true si coincidió con el formato de la v1.0 y hay que re-hashear.
 */
async function verifyUserPassword(plain, user) {
  if (user?.password_hash) return { ok: await verifyPassword(plain, user.password_hash), legacy: false };
  if (user?.legacy_password_hash) {
    // SHA-256 es instantáneo: se gasta igual el tiempo de bcrypt para no delatar cuentas importadas
    await burnPasswordCheck(plain);
    return { ok: verifyLegacyV1(String(plain ?? ''), user.legacy_password_hash), legacy: true };
  }
  await burnPasswordCheck(plain);
  return { ok: false, legacy: false };
}

/** Re-hashea con bcrypt una contraseña de la v1.0 ya verificada y borra el legacy (auditado). */
async function upgradeLegacyPassword(client, userId, plain, auditFn) {
  const hash = await hashPassword(plain);
  await client.query(
    'UPDATE users SET password_hash = $2, legacy_password_hash = NULL WHERE id = $1 AND legacy_password_hash IS NOT NULL',
    [userId, hash],
  );
  if (auditFn) await auditFn('PASSWORD_REHASHED', { from: 'v1-sha256', to: 'bcrypt' });
}

// Devuelve el motivo si la contraseña no cumple la política, o null si es válida.
function passwordPolicyError(plain) {
  if (typeof plain !== 'string' || plain.length < security.passwordMinLength) {
    return `La contraseña debe tener al menos ${security.passwordMinLength} caracteres`;
  }
  if (Buffer.byteLength(plain, 'utf8') > security.passwordMaxLength) {
    return `La contraseña no puede superar ${security.passwordMaxLength} caracteres`;
  }
  if (!/[A-Za-zÁÉÍÓÚÑáéíóúñ]/.test(plain) || !/\d/.test(plain)) {
    return 'La contraseña debe tener letras y números';
  }
  return null;
}

module.exports = {
  hashPassword,
  verifyPassword,
  burnPasswordCheck,
  passwordPolicyError,
  legacyV1Hash,
  isLegacyV1Hash,
  verifyLegacyV1,
  verifyUserPassword,
  upgradeLegacyPassword,
};
