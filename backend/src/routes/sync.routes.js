// Sincronización sin conexión (RF60, RF62).
//   POST /api/sync/operations  acepta el JWT de acceso normal o el token de sincronización (8 h),
//   para que lo hecho sin internet se pueda subir aunque la sesión haya quedado inactiva.
//   GET  /api/sync/snapshot    copia local (tarifas, mensualidades vigentes, entradas abiertas).
const { Router } = require('express');
const HttpError = require('../middlewares/httpError');
const authenticate = require('../middlewares/authenticate');
const { verifyOfflineToken } = require('../services/token.service');
const { resolveOfflineSession } = require('../services/auth.service');
const sync = require('../services/sync.service');

// Autenticación de la sincronización: token de acceso (sesión completa) o de sincronización
async function authenticateSync(req, res, next) {
  const [scheme, token] = (req.get('authorization') || '').split(' ');
  if (scheme !== 'Bearer' || !token) throw new HttpError(401, 'Debe iniciar sesión', { code: 'AUTH_REQUIRED' });
  let claims = null;
  try {
    claims = verifyOfflineToken(token);
  } catch {
    // No es de sincronización: se valida como token de acceso normal
    return authenticate(req, res, next);
  }
  req.user = await resolveOfflineSession(claims);
  req.syncWithOfflineToken = true;
  return next();
}

const router = Router();
router.post('/operations', authenticateSync, async (req, res) => {
  res.json({ ok: true, data: await sync.syncBatch(req, req.body) });
});
router.get('/snapshot', authenticate, async (req, res) => {
  res.json({ ok: true, data: await sync.snapshot(req, req.query.siteId) });
});

module.exports = router;
