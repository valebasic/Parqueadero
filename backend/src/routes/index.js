// Enrutador principal: cada módulo se monta bajo /api/<recurso>.
//
// SEGURIDAD: solo /health y /auth quedan antes de `authenticate`. Todo lo que se monte DESPUÉS
// exige sesión automáticamente, así una ruta nueva no puede quedar abierta por olvido.
// La autorización por rol y sede (403) va en cada módulo (requireRole, requireSiteParam, servicios).
const { Router } = require('express');
const authenticate = require('../middlewares/authenticate');
const healthRoutes = require('./health.routes');
const authRoutes = require('./auth.routes');
const syncRoutes = require('./sync.routes');
const sitesRoutes = require('./sites.routes');
const usersRoutes = require('./users.routes');
const adminRoutes = require('./admin.routes');
const aiRoutes = require('./ai.routes');
const { mapsRouter, spacesRouter } = require('./maps.routes');
const { shiftsRouter, entriesRouter, salesRouter, pendingRouter } = require('./operation.routes');
const { monthlyRouter, movementsRouter, reportsRouter, configRouter, backupsRouter } = require('./management.routes');

const router = Router();

// --- Públicas ---
router.use('/health', healthRoutes);
router.use('/auth', authRoutes);
// Con su propia autenticación (acepta el token de sincronización sin conexión)
router.use('/sync', syncRoutes);

// --- Protegidas ---
router.use(authenticate);
router.use('/sites', sitesRoutes);
router.use('/users', usersRoutes);
router.use('/shifts', shiftsRouter);
router.use('/entries', entriesRouter);
router.use('/sales', salesRouter);
router.use('/pending-charges', pendingRouter);
router.use('/monthly', monthlyRouter);
router.use('/cash-movements', movementsRouter);
router.use('/reports', reportsRouter);
router.use('/config', configRouter);
router.use('/backups', backupsRouter);
router.use('/admin', adminRoutes);
router.use('/ai', aiRoutes);
router.use('/maps', mapsRouter);
router.use('/spaces', spacesRouter);

module.exports = router;
