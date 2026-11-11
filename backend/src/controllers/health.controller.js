const healthService = require('../services/health.service');

// GET /api/health
function getHealth(req, res) {
  res.json(healthService.getHealth());
}

module.exports = { getHealth };
