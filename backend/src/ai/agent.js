// NexoIA: ciclo pregunta → herramientas → respuesta, en el servidor.
//
//   - El rol y las sedes salen de la SESIÓN (req.user), nunca del cliente.
//   - La IA solo ve las herramientas de su rol; si aun así pide otra, NO se ejecuta: se le responde
//     con un error y queda AI_TOOL_DENIED en auditoría.
//   - Todo lo que sale hacia la IA pasa por el redactor de privacidad (ai/privacy.js); los códigos de
//     empleado (E12) se cambian por nombres en la respuesta, aquí, después de recibirla.
//   - Las acciones solo se proponen (ai_proposals). El frontend muestra la tarjeta y, al confirmar,
//     llama al endpoint normal; luego informa el resultado (resolveProposal) para la auditoría.
const { query } = require('../db/pool');
const HttpError = require('../middlewares/httpError');
const { recordAudit } = require('../services/audit.service');
const { sitesInScope } = require('../services/admin/scope');
const gemini = require('./gemini');
const config = require('./config');
const { roleOf, systemInstruction, ROLES } = require('./prompts');
const tools = require('./tools');
const { buildPrivacy, resolveEmployeeCodes } = require('./privacy');

function status() {
  return { available: gemini.isConfigured(), model: config.model() };
}

function validateQuestion(raw) {
  const q = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (!q) throw new HttpError(400, 'Escribe una pregunta.', { code: 'VALIDATION_ERROR' });
  if (q.length > config.maxQuestion) {
    throw new HttpError(400, `La pregunta es muy larga (máximo ${config.maxQuestion} caracteres).`, { code: 'VALIDATION_ERROR' });
  }
  return q;
}

// Historial que reenvía la pantalla: solo texto, recortado
function validateHistory(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .slice(-config.maxHistory)
    .filter((h) => h && typeof h.text === 'string' && h.text.trim())
    .map((h) => ({ role: h.role === 'user' ? 'user' : 'model', text: h.text.slice(0, config.maxHistoryText) }));
}

// Sedes de la persona: AS/AG con el alcance del panel; OP, sus sedes activas asignadas
async function sitesFor(req) {
  if (req.user.role === 'AG' || req.user.role === 'AS') return sitesInScope(req);
  const { rows } = await query('SELECT id, code, name FROM sites WHERE is_active AND id = ANY($1) ORDER BY name', [req.user.siteIds]);
  return rows;
}

async function ask(req, body) {
  if (!gemini.isConfigured()) {
    throw new HttpError(503, 'NexoIA no está disponible: falta configurar la clave de Gemini.', { code: 'AI_NO_KEY' });
  }
  const question = validateQuestion(body?.question);
  const history = validateHistory(body?.history);
  const role = roleOf(req.user);
  const allowed = tools.namesFor(role);
  const sites = await sitesFor(req);
  const { rows: shift } = await query('SELECT site_id FROM shifts WHERE user_id = $1 AND closed_at IS NULL', [req.user.id]);
  const privacy = await buildPrivacy(req.user, sites.map((s) => s.id));
  const ctx = { req, user: req.user, role, sites, shiftSiteId: shift[0]?.site_id ?? null, privacy, proposals: [] };

  const system = systemInstruction(role, { today: new Date(Date.now() - 5 * 3600000).toISOString().slice(0, 10), sites });
  const contents = history.map((h) => ({ role: h.role, parts: [{ text: privacy.redact(h.text) }] }));
  contents.push({ role: 'user', parts: [{ text: privacy.redact(question) }] });
  const declarations = tools.declarationsFor(role);

  const used = [];
  const denied = [];
  let text = null;
  for (let round = 0; round < config.maxRounds && text === null; round += 1) {
    let reply;
    try {
      reply = await gemini.generate({ system, contents, tools: declarations, maxTokens: ROLES[role].maxTokens, temperature: 0.2 });
    } catch (err) {
      if (err instanceof gemini.AiUnavailableError) {
        throw new HttpError(503, `NexoIA no está disponible en este momento. ${err.message}`, { code: 'AI_UNAVAILABLE' });
      }
      throw err;
    }
    const parts = reply.parts ?? [];
    const calls = parts.filter((p) => p.functionCall);
    if (!calls.length) {
      text = parts.filter((p) => p.text && !p.thought).map((p) => p.text).join('').trim();
      break;
    }
    contents.push({ role: 'model', parts });
    const responses = [];
    for (const { functionCall } of calls) {
      const name = String(functionCall.name ?? '');
      let result;
      if (!allowed.includes(name)) {
        // La IA pidió algo que el rol no tiene: no se ejecuta (auditado)
        denied.push(name);
        result = { error: 'Herramienta no permitida para tu rol. Responde: "Tu rol no tiene acceso a esos datos."' };
        await recordAudit({ req, userId: req.user.id, action: 'AI_TOOL_DENIED', entityType: 'ai', details: { tool: name, role } });
      } else {
        used.push(name);
        result = privacy.redactDeep(await tools.execute(ctx, name, functionCall.args ?? {}));
        if (JSON.stringify(result).length > config.maxToolResult) result = { error: 'Resultado demasiado grande; pide un rango menor.' };
      }
      responses.push({ functionResponse: { name, response: { resultado: result } } });
    }
    contents.push({ role: 'user', parts: responses });
  }

  for (const p of ctx.proposals) {
    await recordAudit({
      req,
      userId: req.user.id,
      siteId: p.site?.id ?? null,
      action: 'AI_PROPOSAL_CREATED',
      entityType: 'ai_proposal',
      entityId: p.id,
      details: { kind: p.kind, title: p.title, request: p.request },
    });
  }
  await recordAudit({
    req,
    userId: req.user.id,
    action: 'AI_ASK',
    entityType: 'ai',
    // Sin el texto de la pregunta (puede traer datos personales): solo qué se usó
    details: { role, questionLength: question.length, tools: used, denied, proposals: ctx.proposals.length },
  });

  if (!text) {
    if (ctx.proposals.length) text = 'Te dejé la acción lista para confirmar.';
    else throw new HttpError(502, 'NexoIA no pudo responder: la consulta necesitó demasiados pasos. Intenta una pregunta más concreta.', { code: 'AI_TOO_MANY_STEPS' });
  }
  return {
    // Para mostrar: con los nombres de los empleados resueltos aquí (nunca se enviaron a la IA)
    text: role === 'administrador' ? resolveEmployeeCodes(text, privacy.employees) : text,
    // Para el historial que reenvía la pantalla: tal como lo escribió la IA (con códigos)
    rawText: text,
    proposals: ctx.proposals.map((p) => ({ id: p.id, kind: p.kind, title: p.title, risk: p.risk, details: p.details, request: p.request, needsConsent: p.needsConsent ?? false, comparison: p.comparison ?? null })),
    tools: used,
    denied,
  };
}

// La pantalla informa qué pasó con una propuesta (confirmada y ejecutada, cancelada o fallida)
async function resolveProposal(req, rawId, body) {
  const outcome = body?.outcome;
  if (!['CONFIRMED', 'CANCELLED', 'FAILED'].includes(outcome)) {
    throw new HttpError(400, 'Resultado inválido', { code: 'VALIDATION_ERROR' });
  }
  if (!/^[0-9a-f-]{36}$/i.test(String(rawId))) throw new HttpError(404, 'Propuesta no encontrada', { code: 'NOT_FOUND' });
  const { rows } = await query('SELECT * FROM ai_proposals WHERE id = $1', [rawId]);
  const p = rows[0];
  // Solo quien la recibió puede resolverla
  if (!p || p.user_id !== req.user.id) throw new HttpError(404, 'Propuesta no encontrada', { code: 'NOT_FOUND' });
  if (p.status !== 'PROPOSED') throw new HttpError(409, 'Esta acción ya fue resuelta', { code: 'ALREADY_RESOLVED' });
  if (outcome === 'CONFIRMED' && new Date(p.expires_at) < new Date()) {
    await query("UPDATE ai_proposals SET status = 'EXPIRED', resolved_at = now() WHERE id = $1", [p.id]);
    throw new HttpError(409, 'La acción propuesta venció; pídela de nuevo.', { code: 'PROPOSAL_EXPIRED' });
  }
  const error = outcome === 'FAILED' ? String(body?.error ?? '').slice(0, 300) || 'Error' : null;
  await query('UPDATE ai_proposals SET status = $2, error = $3, resolved_at = now() WHERE id = $1', [p.id, outcome, error]);
  await recordAudit({
    req,
    userId: req.user.id,
    siteId: p.site_id,
    action: `AI_PROPOSAL_${outcome}`,
    entityType: 'ai_proposal',
    entityId: p.id,
    details: { kind: p.kind, title: p.title, error },
  });
  return { id: p.id, status: outcome };
}

module.exports = { ask, status, resolveProposal };
