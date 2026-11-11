const { Router } = require('express');
const sitesController = require('../controllers/sites.controller');

const router = Router();

// PENDIENTE FASE 3: exigir sesión (JWT) y rol AG. Hasta entonces este endpoint está abierto,
// por eso solo expone datos públicos de la sede (nombre, dirección, zonas), nunca de usuarios.
router.get('/', sitesController.listSites);

module.exports = router;
