// Enrutador principal: cada módulo se monta bajo /api/<recurso>.
const { Router } = require('express');
const healthRoutes = require('./health.routes');
const sitesRoutes = require('./sites.routes');

const router = Router();

router.use('/health', healthRoutes);
router.use('/sites', sitesRoutes);

module.exports = router;
