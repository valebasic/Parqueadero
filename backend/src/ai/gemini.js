// Cliente mínimo de Gemini (generateContent con function calling). Las pruebas lo reemplazan con
// jest.spyOn(gemini, 'generate'); por eso el resto del código siempre llama gemini.generate(...).
const config = require('./config');

class AiUnavailableError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function isConfigured() {
  return Boolean(config.apiKey());
}

/**
 * @param {{ system: string, contents: object[], tools: object[], maxTokens: number, temperature: number }} input
 * @returns {Promise<{ parts: object[] }>} partes del primer candidato (texto y/o functionCall)
 */
async function generate({ system, contents, tools, maxTokens, temperature }) {
  const key = config.apiKey();
  if (!key) throw new AiUnavailableError('AI_NO_KEY', 'NexoIA no está configurado (falta GEMINI_API_KEY)');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  let res;
  try {
    res = await fetch(`${config.endpoint}/${encodeURIComponent(config.model())}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents,
        tools: tools.length ? [{ functionDeclarations: tools }] : undefined,
        generationConfig: { temperature, maxOutputTokens: maxTokens },
      }),
      signal: controller.signal,
    });
  } catch (err) {
    const why = err.name === 'AbortError' ? 'tiempo agotado' : err.message;
    throw new AiUnavailableError('AI_NETWORK', `No se pudo contactar a Gemini: ${why}`);
  } finally {
    clearTimeout(timer);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new AiUnavailableError('AI_PROVIDER_ERROR', body?.error?.message || `Gemini respondió ${res.status}`);
  return { parts: body?.candidates?.[0]?.content?.parts ?? [] };
}

module.exports = { generate, isConfigured, AiUnavailableError };
