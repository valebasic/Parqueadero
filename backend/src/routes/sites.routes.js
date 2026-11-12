// Sedes y zonas (RF26, RF27). Todas las rutas exigen sesión (authenticate se aplica en routes/index.js).
const { Router } = require('express');
const sites = require('../services/sites.service');
const { requireSiteParam, requireRole } = require('../middlewares/authorize');

const router = Router();
const ok = (res, data, status = 200) => res.status(status).json({ ok: true, data });

// AG: todas las sedes; AS y OP: solo las asignadas. ?includeInactive=1 también las desactivadas.
router.get('/', async (req, res) =>
  ok(res, await sites.listSitesWithZones(req.user, { includeInactive: req.query.includeInactive === '1' })));
// 403 si la sede no es del usuario
router.get('/:siteId', requireSiteParam('siteId'), async (req, res) =>
  ok(res, await sites.getSiteWithZones(Number.parseInt(req.params.siteId, 10))));

// Crear y editar sedes (incluye activar/desactivar): solo AG
router.post('/', requireRole('AG'), async (req, res) => ok(res, await sites.createSite(req, req.body), 201));
router.patch('/:siteId', requireRole('AG'), async (req, res) => ok(res, await sites.updateSite(req, req.params.siteId, req.body)));

// Zonas: AG y el AS de la sede
router.post('/:siteId/zones', requireRole('AG', 'AS'), requireSiteParam('siteId'), async (req, res) =>
  ok(res, await sites.createZone(req, req.params.siteId, req.body), 201));
router.patch('/:siteId/zones/:zoneId', requireRole('AG', 'AS'), requireSiteParam('siteId'), async (req, res) =>
  ok(res, await sites.updateZone(req, req.params.siteId, req.params.zoneId, req.body)));

module.exports = router;
