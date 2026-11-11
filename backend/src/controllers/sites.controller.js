const sitesService = require('../services/sites.service');

// GET /api/sites → { ok, data: [sede con zonas] }
async function listSites(req, res) {
  const data = await sitesService.listSitesWithZones();
  res.json({ ok: true, data });
}

module.exports = { listSites };
