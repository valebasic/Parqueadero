// Cliente mínimo de la API. Todas las rutas son relativas (/api/...): en desarrollo las atiende
// el proxy de Vite y en producción el mismo servidor que entrega el frontend.
export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

export async function apiGet(path, { signal } = {}) {
  let res;
  try {
    res = await fetch(`/api${path}`, { headers: { Accept: 'application/json' }, signal });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new ApiError(0, 'No se pudo conectar con el servidor. Revise su conexión.');
  }

  const body = await res.json().catch(() => null);
  if (!res.ok || body?.ok === false) {
    throw new ApiError(res.status, body?.error || `Error ${res.status} del servidor`);
  }
  return body?.data ?? body;
}
