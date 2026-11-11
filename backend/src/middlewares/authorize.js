// Autorización por rol y por sede (403). Se usa después de authenticate.
const HttpError = require('./httpError');
const { recordAudit } = require('../services/audit.service');

// ¿El usuario puede operar sobre esta sede? El AG, sobre todas; AS y OP, solo sobre las asignadas.
function canAccessSite(user, siteId) {
  if (!user) return false;
  if (user.role === 'AG') return true;
  return user.siteIds.includes(Number(siteId));
}

async function deny(req, message, code, details) {
  await recordAudit({
    req,
    userId: req.user?.id,
    action: 'ACCESS_DENIED',
    details: { method: req.method, path: req.originalUrl, code, ...details },
  });
  return new HttpError(403, message, { code });
}

// Middleware: solo deja pasar a los roles indicados. Ej.: requireRole('AG', 'AS')
function requireRole(...roles) {
  return async function roleGuard(req, res, next) {
    if (!req.user || !roles.includes(req.user.role)) {
      throw await deny(req, 'Su rol no tiene permiso para esta acción', 'FORBIDDEN_ROLE', { role: req.user?.role });
    }
    next();
  };
}

// Para usar dentro de controladores/servicios cuando la sede sale del cuerpo o de la base
async function assertSiteAccess(req, siteId) {
  if (!canAccessSite(req.user, siteId)) {
    throw await deny(req, 'No tiene acceso a esta sede', 'FORBIDDEN_SITE', { siteId: Number(siteId) });
  }
}

// Middleware: valida la sede que viene en la URL. Ej.: requireSiteParam('siteId')
function requireSiteParam(paramName = 'siteId') {
  return async function siteGuard(req, res, next) {
    const siteId = Number.parseInt(req.params[paramName], 10);
    if (!Number.isInteger(siteId) || siteId <= 0) {
      throw new HttpError(400, 'Sede inválida', { code: 'VALIDATION_ERROR' });
    }
    await assertSiteAccess(req, siteId);
    next();
  };
}

module.exports = { canAccessSite, requireRole, assertSiteAccess, requireSiteParam, deny };
