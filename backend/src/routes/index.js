// Enrutador principal: cada módulo se monta bajo /api/<recurso>.
//
// SEGURIDAD: solo /health y /auth quedan antes de `authenticate`. Todo lo que se monte DESPUÉS
// exige sesión automáticamente, así una ruta nueva no puede quedar abierta por olvido.
// La autorización por rol y sede (403) va en cada módulo (requireRole, requireSiteParam, servicios).
const { Router } = require('express');
const authenticate = require('../middlewares/authenticate');
const healthRoutes = require('./health.routes');
const authRoutes = require('./auth.routes');
const sitesRoutes = require('./sites.routes');
const usersRoutes = require('./users.routes');

const router = Router();

// --- Públicas ---
router.use('/health', healthRoutes);
router.use('/auth', authRoutes);

// --- Protegidas ---
router.use(authenticate);
router.use('/sites', sitesRoutes);
router.use('/users', usersRoutes);

module.exports = router;
