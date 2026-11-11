// Sedes. Todas las rutas exigen sesión (authenticate se aplica en routes/index.js).
const { Router } = require('express');
const sitesController = require('../controllers/sites.controller');
const { requireSiteParam } = require('../middlewares/authorize');

const router = Router();

// AG: todas las sedes; AS y OP: solo las asignadas
router.get('/', sitesController.listSites);
// 403 si la sede no es del usuario
router.get('/:siteId', requireSiteParam('siteId'), sitesController.getSite);

module.exports = router;
