// Enrutador principal: cada módulo se monta bajo /api/<recurso>.
const { Router } = require('express');
const healthRoutes = require('./health.routes');

const router = Router();

router.use('/health', healthRoutes);

module.exports = router;
