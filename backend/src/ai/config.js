// Configuración de NexoIA (asistente con Gemini). La clave y el modelo vienen del .env; nunca del
// cliente ni del código.
module.exports = {
  // Modelo de la v1.0 (agente/index.js) salvo que el .env diga otro
  model: () => process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite',
  apiKey: () => (process.env.GEMINI_API_KEY || '').trim(),
  endpoint: process.env.GEMINI_ENDPOINT || 'https://generativelanguage.googleapis.com/v1beta/models',
  timeoutMs: Number.parseInt(process.env.GEMINI_TIMEOUT_MS, 10) || 20000,
  // Ciclos pregunta → herramientas → respuesta (igual que la v1.0)
  maxRounds: 6,
  maxQuestion: 500,
  maxHistory: 6,
  maxHistoryText: 2000,
  maxToolResult: 40000,
  // Límite de preguntas por usuario
  rateLimit: {
    limit: Number.parseInt(process.env.AI_RATE_LIMIT_MAX, 10) || 30,
    windowMs: (Number.parseInt(process.env.AI_RATE_LIMIT_WINDOW_MIN, 10) || 15) * 60 * 1000,
  },
  // Una acción propuesta vence si no se confirma en este tiempo
  proposalMinutes: 30,
};
