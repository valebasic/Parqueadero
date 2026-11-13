// NexoIA (asistente). Exige sesión (se monta después de authenticate). El rol y las sedes salen de
// la sesión; el cuerpo solo trae la pregunta y el historial de texto.
const { Router } = require('express');
const { createRateLimiter } = require('../middlewares/rateLimit');
const agent = require('../ai/agent');
const config = require('../ai/config');

const router = Router();
const ok = (res, data, status = 200) => res.status(status).json({ ok: true, data });

// Límite por usuario (no por IP: varias cajas pueden compartir la misma conexión)
const askLimiter = createRateLimiter({
  limit: config.rateLimit.limit,
  windowMs: config.rateLimit.windowMs,
  message: 'Hiciste muchas preguntas a NexoIA seguidas.',
  keyGenerator: (req) => `ai-user:${req.user.id}`,
});

// ¿Está configurado? (el widget lo usa para mostrar "no disponible")
router.get('/status', (req, res) => ok(res, agent.status()));
router.post('/ask', askLimiter, async (req, res) => ok(res, await agent.ask(req, req.body)));
router.post('/proposals/:id/resolve', async (req, res) => ok(res, await agent.resolveProposal(req, req.params.id, req.body)));

module.exports = router;
