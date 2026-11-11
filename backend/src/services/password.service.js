// Hash y política de contraseñas (bcrypt, costo 12).
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

module.exports = { hashPassword, verifyPassword, burnPasswordCheck, passwordPolicyError };
