const sitesService = require('../services/sites.service');

// GET /api/sites → sedes (con zonas) visibles para el usuario
async function listSites(req, res) {
  const data = await sitesService.listSitesWithZones(req.user);
  res.json({ ok: true, data });
}

// GET /api/sites/:siteId
async function getSite(req, res) {
  const data = await sitesService.getSiteWithZones(Number.parseInt(req.params.siteId, 10));
  res.json({ ok: true, data });
}

module.exports = { listSites, getSite };
