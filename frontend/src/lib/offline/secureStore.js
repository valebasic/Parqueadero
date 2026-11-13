// Almacén local para trabajar sin conexión (RF60, RNF12), en IndexedDB:
//   meta  → datos NO sensibles en claro: id del dispositivo, contadores, datos para desbloquear
//           (sal y verificador PBKDF2; nunca la contraseña) y cuántas operaciones hay en cola.
//   queue → operaciones pendientes de sincronizar, CIFRADAS con AES-GCM.
//   cache → copia de tarifas, mensualidades vigentes y entradas abiertas, CIFRADA.
//
// La clave AES se deriva de la contraseña con PBKDF2-SHA256 al iniciar sesión (o al desbloquear) y
// solo vive en memoria y en sessionStorage de la pestaña (sobrevive a recargar, no a cerrar el
// navegador). Al volver a abrir el navegador hay que escribir la contraseña para descifrar.
const DB_NAME = 'nexo-offline';
const DB_VERSION = 1;
const PBKDF2_ITERATIONS = 310000;
const SESSION_KEY = 'nexo_offline_key';
const OFFLINE_HOURS = 8;

let dbPromise = null;
let aesKey = null; // CryptoKey
let keyUserId = null;

// ---------------------------------------------------------------------------
// IndexedDB mínima
// ---------------------------------------------------------------------------

function openDb() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('queue')) {
        const q = db.createObjectStore('queue', { keyPath: 'id' });
        q.createIndex('byUser', ['userId', 'seq']);
      }
      if (!db.objectStoreNames.contains('cache')) db.createObjectStore('cache', { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function tx(store, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let result;
    Promise.resolve(fn(s)).then((r) => {
      result = r;
    });
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

const reqP = (r) => new Promise((resolve, reject) => {
  r.onsuccess = () => resolve(r.result);
  r.onerror = () => reject(r.error);
});

export async function getMeta(key, fallback = null) {
  const row = await tx('meta', 'readonly', (s) => reqP(s.get(key)));
  return row ? row.value : fallback;
}

export async function setMeta(key, value) {
  await tx('meta', 'readwrite', (s) => reqP(s.put({ key, value })));
}

// ---------------------------------------------------------------------------
// Criptografía (WebCrypto)
// ---------------------------------------------------------------------------

const enc = new TextEncoder();
const dec = new TextDecoder();
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function pbkdf2Bits(password, salt, label) {
  const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  return crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(`${label}:${salt}`), iterations: PBKDF2_ITERATIONS },
    base,
    256,
  );
}

// Clave AES y verificador salen de derivaciones distintas: el verificador no revela la clave
async function deriveAll(password, salt) {
  const [keyBits, verifierBits] = await Promise.all([pbkdf2Bits(password, salt, 'key'), pbkdf2Bits(password, salt, 'verifier')]);
  return { keyBits, verifier: b64(verifierBits) };
}

async function importAes(raw) {
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function encryptJson(value) {
  if (!aesKey) throw new Error('LOCKED');
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, enc.encode(JSON.stringify(value)));
  return { iv: b64(iv), data: b64(data) };
}

export async function decryptJson(box) {
  if (!aesKey) throw new Error('LOCKED');
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(box.iv) }, aesKey, unb64(box.data));
  return JSON.parse(dec.decode(plain));
}

// Comparación en tiempo constante
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ---------------------------------------------------------------------------
// Acceso sin conexión ("grant") por usuario
// ---------------------------------------------------------------------------

/**
 * Al iniciar sesión en línea: deriva la clave con la contraseña y guarda lo necesario para seguir
 * trabajando y desbloquear sin conexión hasta 8 h. Nunca guarda la contraseña.
 */
export async function prepareOffline(user, password, offlineToken) {
  const existing = await getMeta(`grant:${user.id}`);
  const salt = existing?.salt ?? b64(crypto.getRandomValues(new Uint8Array(16)));
  const { keyBits, verifier } = await deriveAll(password, salt);
  aesKey = await importAes(keyBits);
  keyUserId = user.id;
  try {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify({ userId: user.id, raw: b64(keyBits) }));
  } catch {
    /* sin sessionStorage: la clave queda solo en memoria */
  }
  // Si cambió la contraseña, la cola anterior (cifrada con la clave vieja) no se podría leer: se avisa
  const passwordChanged = Boolean(existing && existing.verifier !== verifier);
  await setMeta(`grant:${user.id}`, {
    userId: user.id,
    username: user.username,
    fullName: user.fullName,
    role: user.role,
    sites: user.sites,
    salt,
    verifier,
    active: true,
    offlineUntil: Date.now() + OFFLINE_HOURS * 3600 * 1000,
    token: offlineToken ? await encryptJson(offlineToken) : existing?.token ?? null,
  });
  await setMeta('lastUserId', user.id);
  return { passwordChanged };
}

// Cada renovación en línea extiende la ventana de 8 h y guarda el token de sincronización nuevo
export async function refreshOfflineGrant(userId, offlineToken) {
  const grant = await getMeta(`grant:${userId}`);
  if (!grant || !aesKey || keyUserId !== userId) return;
  await setMeta(`grant:${userId}`, {
    ...grant,
    active: true,
    offlineUntil: Date.now() + OFFLINE_HOURS * 3600 * 1000,
    token: offlineToken ? await encryptJson(offlineToken) : grant.token,
  });
}

// Recupera la clave de esta pestaña (tras recargar la página)
export async function restoreKeyFromSession(userId) {
  try {
    const saved = JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null');
    if (!saved || saved.userId !== userId) return false;
    aesKey = await importAes(unb64(saved.raw));
    keyUserId = userId;
    return true;
  } catch {
    return false;
  }
}

/** Desbloqueo local: verifica la contraseña contra el verificador PBKDF2 y recupera la clave. */
export async function unlockWithPassword(userId, password) {
  const grant = await getMeta(`grant:${userId}`);
  if (!grant) return false;
  const { keyBits, verifier } = await deriveAll(password, grant.salt);
  if (!safeEqual(verifier, grant.verifier)) return false;
  aesKey = await importAes(keyBits);
  keyUserId = userId;
  try {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify({ userId, raw: b64(keyBits) }));
  } catch {
    /* sin efecto */
  }
  return true;
}

export function lockKey() {
  aesKey = null;
  keyUserId = null;
  try {
    sessionStorage.removeItem(SESSION_KEY);
  } catch {
    /* sin efecto */
  }
}

export const hasKey = (userId) => Boolean(aesKey) && (userId == null || keyUserId === userId);

// Grant vigente del último usuario (para seguir trabajando si no hay internet al abrir)
export async function activeOfflineGrant() {
  const userId = await getMeta('lastUserId');
  if (!userId) return null;
  const grant = await getMeta(`grant:${userId}`);
  if (!grant?.active || grant.offlineUntil < Date.now()) return null;
  return grant;
}

export async function grantFor(userId) {
  return getMeta(`grant:${userId}`);
}

// Al cerrar sesión: ya no se puede continuar sin conexión (la cola, si hay, se conserva cifrada)
export async function endOfflineGrant(userId) {
  const grant = await getMeta(`grant:${userId}`);
  if (grant) await setMeta(`grant:${userId}`, { ...grant, active: false, token: null });
  lockKey();
}

export async function decryptOfflineToken(userId) {
  const grant = await getMeta(`grant:${userId}`);
  if (!grant?.token || !hasKey(userId)) return null;
  return decryptJson(grant.token);
}

// ---------------------------------------------------------------------------
// Dispositivo y consecutivos
// ---------------------------------------------------------------------------

export async function deviceId() {
  let id = await getMeta('deviceId');
  if (!id) {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    id = Array.from(crypto.getRandomValues(new Uint8Array(6)), (n) => alphabet[n % alphabet.length]).join('');
    await setMeta('deviceId', id);
  }
  return id;
}

// Contador persistente (no se repite aunque se cierre el navegador)
export async function nextCounter(name) {
  const n = (await getMeta(`counter:${name}`, 0)) + 1;
  await setMeta(`counter:${name}`, n);
  return n;
}

// ---------------------------------------------------------------------------
// Cola cifrada
// ---------------------------------------------------------------------------

export async function enqueue(userId, op) {
  const box = await encryptJson(op);
  await tx('queue', 'readwrite', (s) => reqP(s.put({ id: op.id, seq: op.seq, userId, createdAt: Date.now(), enc: box })));
}

// Cantidad sin descifrar (para el indicador, aun con la app bloqueada)
export async function queueCount(userId) {
  return tx('queue', 'readonly', async (s) => {
    const all = await reqP(s.getAll());
    return all.filter((r) => userId == null || r.userId === userId).length;
  });
}

export async function readQueue(userId) {
  const rows = await tx('queue', 'readonly', (s) => reqP(s.getAll()));
  const mine = rows.filter((r) => r.userId === userId).sort((a, b) => a.seq - b.seq);
  return Promise.all(mine.map((r) => decryptJson(r.enc)));
}

export async function removeFromQueue(ids) {
  await tx('queue', 'readwrite', (s) => Promise.all(ids.map((id) => reqP(s.delete(id)))));
}

// ---------------------------------------------------------------------------
// Copia local (cifrada)
// ---------------------------------------------------------------------------

export async function saveCache(key, value) {
  const box = await encryptJson({ value, savedAt: Date.now() });
  await tx('cache', 'readwrite', (s) => reqP(s.put({ key, enc: box })));
}

export async function loadCache(key) {
  const row = await tx('cache', 'readonly', (s) => reqP(s.get(key)));
  if (!row) return null;
  try {
    return await decryptJson(row.enc);
  } catch {
    return null;
  }
}
