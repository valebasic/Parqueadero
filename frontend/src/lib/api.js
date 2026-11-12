// Cliente de la API. Rutas relativas (/api/...): en desarrollo las atiende el proxy de Vite y en
// producción el mismo servidor que entrega el frontend.
//
// Sesión:
//   - El JWT de acceso vive SOLO en memoria (nunca en localStorage).
//   - El refresh token viaja en una cookie httpOnly que el navegador manda solo a /api/auth.
//   - Si el JWT venció (TOKEN_EXPIRED), se renueva una vez con /auth/refresh y se repite la petición.
//   - Cualquier otro 401 significa que la sesión terminó: se avisa con onSessionLost.

export class ApiError extends Error {
  constructor(status, message, { code, details } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

let accessToken = null;
let sessionLostHandler = null;
let refreshInFlight = null;
let lastServerActivity = 0;
let networkListener = null;

// Avisa si el servidor responde o no (lo usa el modo sin conexión)
export function onNetworkChange(handler) {
  networkListener = handler;
}

export function setAccessToken(token) {
  accessToken = token;
}

export function onSessionLost(handler) {
  sessionLostHandler = handler;
}

// Momento de la última petición que el servidor contó como actividad del usuario
export function getLastServerActivity() {
  return lastServerActivity;
}

async function rawRequest(method, path, { body, background = false, signal } = {}) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  if (background) headers['X-Nexo-Background'] = '1';

  let res;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin',
      signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    networkListener?.(false);
    throw new ApiError(0, 'No se pudo conectar con el servidor. Revise su conexión.', { code: 'NETWORK' });
  }

  const data = await res.json().catch(() => null);
  // Un proxy sin servidor detrás (502/504, o 503 sin respuesta de la API) también es "sin conexión"
  if ([502, 504].includes(res.status) || (res.status === 503 && !data)) {
    networkListener?.(false);
    throw new ApiError(0, 'No se pudo conectar con el servidor. Revise su conexión.', { code: 'NETWORK' });
  }
  networkListener?.(true);
  if (!res.ok || data?.ok === false) {
    throw new ApiError(res.status, data?.error || `Error ${res.status} del servidor`, {
      code: data?.code,
      details: data?.details,
    });
  }
  if (!background) lastServerActivity = Date.now();
  return data;
}

// Renueva el JWT con la cookie de sesión. Varias llamadas simultáneas comparten la misma petición.
export function refreshSession() {
  refreshInFlight ??= rawRequest('POST', '/auth/refresh')
    .then((res) => {
      setAccessToken(res.data.accessToken);
      return res.data;
    })
    .finally(() => {
      refreshInFlight = null;
    });
  return refreshInFlight;
}

export async function apiRequest(method, path, options = {}) {
  try {
    const res = await rawRequest(method, path, options);
    return res && 'data' in res ? res.data : res;
  } catch (err) {
    if (err.status === 401 && err.code === 'TOKEN_EXPIRED') {
      try {
        await refreshSession();
      } catch (refreshErr) {
        sessionLostHandler?.(refreshErr.code);
        throw refreshErr;
      }
      const res = await rawRequest(method, path, options);
      return res && 'data' in res ? res.data : res;
    }
    if (err.status === 401 && !path.startsWith('/auth/')) sessionLostHandler?.(err.code);
    throw err;
  }
}

export const apiGet = (path, options) => apiRequest('GET', path, options);
export const apiPost = (path, body, options) => apiRequest('POST', path, { ...options, body });
export const apiPatch = (path, body, options) => apiRequest('PATCH', path, { ...options, body });
export const apiPut = (path, body, options) => apiRequest('PUT', path, { ...options, body });

// --- Autenticación ---
export async function loginRequest(username, password) {
  const res = await rawRequest('POST', '/auth/login', { body: { username, password } });
  setAccessToken(res.data.accessToken);
  return res.data;
}

export async function logoutRequest() {
  try {
    await rawRequest('POST', '/auth/logout');
  } finally {
    setAccessToken(null);
  }
}

export const apiDelete = (path, options) => apiRequest('DELETE', path, options);

// Descarga un archivo de la API (Excel, PDF, CSV, respaldo) con la sesión actual
export async function apiDownload(path, fallbackName) {
  const doFetch = () =>
    fetch(`/api${path}`, {
      headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
      credentials: 'same-origin',
    });
  let res = await doFetch();
  if (res.status === 401) {
    await refreshSession();
    res = await doFetch();
  }
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new ApiError(res.status, body?.error || `Error ${res.status} al descargar`, { code: body?.code });
  }
  const blob = await res.blob();
  const name = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') || '')?.[1] || fallbackName;
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Token actual (lo usa la conexión de tiempo real)
export function getAccessToken() {
  return accessToken;
}
