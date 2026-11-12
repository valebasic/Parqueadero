// Mapa de espacios (RF47-RF52). Todas exigen sesión; la sede se valida en cada servicio.
//   Editor e indicadores: AG y AS de la sede · Vista en vivo, sugerencia y bloqueo: todos los roles.
const { Router } = require('express');
const { requireRole } = require('../middlewares/authorize');
const maps = require('../services/maps.service');
const spaces = require('../services/spaces.service');

const ok = (res, data, status = 200) => res.status(status).json({ ok: true, data });
const admins = requireRole('AG', 'AS');

const mapsRouter = Router();
mapsRouter.get('/sites/:siteId', async (req, res) => ok(res, await maps.siteMaps(req, req.params.siteId)));
mapsRouter.get('/indicators', admins, async (req, res) => ok(res, await maps.indicators(req, req.query)));
mapsRouter.get('/zones/:zoneId/live', async (req, res) => ok(res, await maps.liveZone(req, req.params.zoneId)));
mapsRouter.get('/zones/:zoneId', admins, async (req, res) => ok(res, await maps.zoneMaps(req, req.params.zoneId)));
mapsRouter.put('/zones/:zoneId/draft', admins, async (req, res) => ok(res, await maps.saveDraft(req, req.params.zoneId, req.body)));
mapsRouter.delete('/zones/:zoneId/draft', admins, async (req, res) => ok(res, await maps.discardDraft(req, req.params.zoneId)));
mapsRouter.post('/zones/:zoneId/copy', admins, async (req, res) => ok(res, await maps.copyFrom(req, req.params.zoneId, req.body)));
mapsRouter.post('/zones/:zoneId/publish', admins, async (req, res) => ok(res, await maps.publishDraft(req, req.params.zoneId)));
mapsRouter.get('/zones/:zoneId/history', admins, async (req, res) => ok(res, await maps.hourlyHistory(req, req.params.zoneId, req.query)));
mapsRouter.get('/zones/:zoneId/heatmap', admins, async (req, res) => ok(res, await maps.heatmap(req, req.params.zoneId, req.query)));

const spacesRouter = Router();
spacesRouter.get('/suggest', async (req, res) => ok(res, await spaces.suggest(req, req.query)));
spacesRouter.post('/:id/block', async (req, res) => ok(res, await spaces.blockSpace(req, req.params.id, req.body)));
spacesRouter.post('/:id/unblock', async (req, res) => ok(res, await spaces.unblockSpace(req, req.params.id, req.body)));
spacesRouter.put('/:id/reservation', admins, async (req, res) => ok(res, await spaces.reserveSpace(req, req.params.id, req.body)));
// Mover un vehículo de puesto (RF51)
spacesRouter.post('/move/:entryId', async (req, res) => ok(res, await spaces.moveEntry(req, req.params.entryId, req.body)));

module.exports = { mapsRouter, spacesRouter };
