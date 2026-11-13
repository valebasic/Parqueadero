// Autenticación (RF01-RF06): login con bloqueo, sesiones con cierre por inactividad, logout y
// cambio de contraseña propia.
const { query, withTransaction } = require('../db/pool');
const HttpError = require('../middlewares/httpError');
const { security, idleTimeoutSecondsFor } = require('../config/security');
const { recordAudit, requestMeta } = require('./audit.service');
const {
  hashPassword,
  burnPasswordCheck,
  passwordPolicyError,
  verifyUserPassword,
  upgradeLegacyPassword,
} = require('./password.service');
const { signAccessToken, signOfflineToken, generateRefreshToken, hashRefreshToken } = require('./token.service');
const { sessionEnded } = require('../realtime/bus');

const INVALID_CREDENTIALS = 'Usuario o contraseña incorrectos';

// ---------------------------------------------------------------------------
// Sesiones
// ---------------------------------------------------------------------------

const SESSION_SELECT = `
  SELECT s.id AS session_id, s.revoked_at, s.expires_at,
         (s.expires_at <= now()) AS expired,
         extract(epoch FROM now() - s.last_activity_at)::float8 AS idle_seconds,
         u.id AS user_id, u.username, u.full_name, u.role, u.is_active,
         COALESCE(array_agg(us.site_id ORDER BY us.site_id) FILTER (WHERE us.site_id IS NOT NULL), '{}') AS site_ids
    FROM user_sessions s
    JOIN users u ON u.id = s.user_id
    LEFT JOIN user_sites us ON us.user_id = u.id`;

async function revokeSession(sessionId, reason, client) {
  const run = client ? client.query.bind(client) : query;
  await run(
    `UPDATE user_sessions SET revoked_at = now(), revoked_reason = $2
      WHERE id = $1 AND revoked_at IS NULL`,
    [sessionId, reason],
  );
  sessionEnded(sessionId, reason); // desconecta sus sockets de tiempo real
}

async function revokeUserSessions(userId, reason, client, { exceptSessionId = null } = {}) {
  const run = client ? client.query.bind(client) : query;
  const { rows } = await run(
    `UPDATE user_sessions SET revoked_at = now(), revoked_reason = $2
      WHERE user_id = $1 AND revoked_at IS NULL AND ($3::uuid IS NULL OR id <> $3::uuid)
      RETURNING id`,
    [userId, reason, exceptSessionId],
  );
  rows.forEach((r) => sessionEnded(r.id, reason));
}

// Revisa que la sesión siga viva; si no, la revoca (cuando corresponde) y lanza 401.
async function assertSessionAlive(row, req) {
  if (!row || row.revoked_at) {
    throw new HttpError(401, 'La sesión ya no es válida. Inicie sesión de nuevo.', { code: 'SESSION_REVOKED' });
  }
  if (!row.is_active) {
    await revokeSession(row.session_id, 'USER_DEACTIVATED');
    throw new HttpError(401, 'El usuario está desactivado', { code: 'USER_INACTIVE' });
  }
  if (row.expired) {
    await revokeSession(row.session_id, 'EXPIRED');
    throw new HttpError(401, 'La sesión venció. Inicie sesión de nuevo.', { code: 'SESSION_EXPIRED' });
  }
  if (row.idle_seconds > idleTimeoutSecondsFor(row.role)) {
    await revokeSession(row.session_id, 'IDLE');
    await recordAudit({
      req,
      userId: row.user_id,
      action: 'SESSION_IDLE_TIMEOUT',
      entityType: 'session',
      entityId: row.session_id,
      details: { idleMinutes: Math.floor(row.idle_seconds / 60) },
    });
    throw new HttpError(401, 'La sesión se cerró por inactividad', { code: 'SESSION_IDLE' });
  }
}

function toAuthUser(row) {
  return {
    id: row.user_id,
    username: row.username,
    fullName: row.full_name,
    role: row.role,
    siteIds: row.site_ids,
    sessionId: row.session_id,
    sessionExpiresAt: row.expires_at,
  };
}

// Marca actividad en la sesión (como máximo una escritura cada `activityTouchSeconds`)
async function touchSession(sessionId, { force = false } = {}) {
  await query(
    `UPDATE user_sessions SET last_activity_at = now()
      WHERE id = $1 AND ($2 OR last_activity_at < now() - make_interval(secs => $3))`,
    [sessionId, force, security.activityTouchSeconds],
  );
}

// Sesión para sincronizar lo hecho sin conexión: debe existir, no estar revocada y el usuario activo.
// No se exige la inactividad ni la duración máxima: el token de sincronización ya vence a las 8 h.
async function resolveOfflineSession({ userId, sessionId }) {
  const { rows } = await query(`${SESSION_SELECT} WHERE s.id = $1 AND s.user_id = $2 GROUP BY s.id, u.id`, [
    sessionId,
    userId,
  ]);
  const row = rows[0];
  if (!row || row.revoked_at) throw new HttpError(401, 'La sesión ya no es válida. Inicie sesión de nuevo.', { code: 'SESSION_REVOKED' });
  if (!row.is_active) throw new HttpError(401, 'El usuario está desactivado', { code: 'USER_INACTIVE' });
  return toAuthUser(row);
}

// Usado por el middleware authenticate en cada petición
async function resolveSession({ userId, sessionId }, req, { countsAsActivity = true } = {}) {
  const { rows } = await query(`${SESSION_SELECT} WHERE s.id = $1 AND s.user_id = $2 GROUP BY s.id, u.id`, [
    sessionId,
    userId,
  ]);
  await assertSessionAlive(rows[0], req);
  if (countsAsActivity) await touchSession(sessionId);
  return toAuthUser(rows[0]);
}

// ---------------------------------------------------------------------------
// Perfil que se entrega al frontend
// ---------------------------------------------------------------------------

async function getProfile(userId) {
  const { rows } = await query(
    `SELECT u.id, u.username, u.full_name, u.role, u.last_login_at,
            COALESCE((
              SELECT json_agg(json_build_object('id', s.id, 'code', s.code, 'name', s.name) ORDER BY s.name)
                FROM sites s
               WHERE s.is_active
                 AND (u.role = 'AG' OR s.id IN (SELECT site_id FROM user_sites WHERE user_id = u.id))
            ), '[]') AS sites
       FROM users u WHERE u.id = $1`,
    [userId],
  );
  const u = rows[0];
  return {
    id: u.id,
    username: u.username,
    fullName: u.full_name,
    role: u.role,
    allSites: u.role === 'AG',
    sites: u.sites,
    lastLoginAt: u.last_login_at,
  };
}

function sessionInfo(role, expiresAt) {
  return {
    idleTimeoutSeconds: idleTimeoutSecondsFor(role),
    accessTokenTtlSeconds: security.accessTokenTtlSeconds,
    expiresAt,
  };
}

async function createSession(client, userId, req) {
  const refreshToken = generateRefreshToken();
  const { ipAddress, userAgent } = requestMeta(req);
  const { rows } = await client.query(
    `INSERT INTO user_sessions (user_id, refresh_token_hash, expires_at, ip_address, user_agent)
     VALUES ($1, $2, now() + make_interval(hours => $3), $4, $5)
     RETURNING id, expires_at`,
    [userId, hashRefreshToken(refreshToken), security.sessionMaxHours, ipAddress, userAgent],
  );
  return { sessionId: rows[0].id, expiresAt: rows[0].expires_at, refreshToken };
}

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------

async function login({ username, password }, req) {
  if (typeof username !== 'string' || !username.trim() || typeof password !== 'string' || !password) {
    throw new HttpError(400, 'Escriba el usuario y la contraseña', { code: 'VALIDATION_ERROR' });
  }
  const cleanUsername = username.trim();

  // La transacción siempre se confirma (para guardar intentos fallidos y auditoría);
  // el error, si lo hay, se lanza después.
  const outcome = await withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT id, username, role, is_active, password_hash, legacy_password_hash, failed_login_count,
              (locked_until IS NOT NULL AND locked_until > now()) AS is_locked,
              ceil(extract(epoch FROM locked_until - now()))::int AS lock_seconds_left
         FROM users WHERE lower(username) = lower($1)
         FOR NO KEY UPDATE`,
      [cleanUsername],
    );
    const user = rows[0];

    if (!user) {
      await burnPasswordCheck(password);
      await recordAudit(
        { req, action: 'LOGIN_FAILED', entityType: 'user', details: { username: cleanUsername, reason: 'UNKNOWN_USER' } },
        client,
      );
      return { error: new HttpError(401, INVALID_CREDENTIALS, { code: 'INVALID_CREDENTIALS' }) };
    }

    const audit = (action, details = {}) =>
      recordAudit({ req, userId: user.id, action, entityType: 'user', entityId: user.id, details }, client);

    if (user.is_locked) {
      await audit('LOGIN_BLOCKED', { secondsLeft: user.lock_seconds_left });
      return { error: lockedError(user.lock_seconds_left) };
    }

    const check = await verifyUserPassword(password, user);
    if (!check.ok) {
      const attempts = user.failed_login_count + 1;
      if (attempts >= security.maxFailedLogins) {
        await client.query(
          `UPDATE users SET failed_login_count = 0, locked_until = now() + make_interval(mins => $2) WHERE id = $1`,
          [user.id, security.lockMinutes],
        );
        await audit('ACCOUNT_LOCKED', { attempts, lockMinutes: security.lockMinutes });
        return { error: lockedError(security.lockMinutes * 60) };
      }
      await client.query('UPDATE users SET failed_login_count = $2 WHERE id = $1', [user.id, attempts]);
      await audit('LOGIN_FAILED', { reason: 'WRONG_PASSWORD', attempts });
      return { error: new HttpError(401, INVALID_CREDENTIALS, { code: 'INVALID_CREDENTIALS' }) };
    }

    if (!user.is_active) {
      await audit('LOGIN_FAILED', { reason: 'USER_INACTIVE' });
      return { error: new HttpError(403, 'El usuario está desactivado. Consulte con un administrador.', { code: 'USER_INACTIVE' }) };
    }

    await client.query(
      'UPDATE users SET failed_login_count = 0, locked_until = NULL, last_login_at = now() WHERE id = $1',
      [user.id],
    );
    // Contraseña importada de la v1.0: primer login correcto → bcrypt y se borra el legacy
    if (check.legacy) await upgradeLegacyPassword(client, user.id, password, audit);
    const session = await createSession(client, user.id, req);
    await audit('LOGIN_SUCCESS', { sessionId: session.sessionId });
    return { user, session };
  });

  if (outcome.error) throw outcome.error;

  const { user, session } = outcome;
  return {
    accessToken: signAccessToken({ userId: user.id, sessionId: session.sessionId }),
    offlineToken: signOfflineToken({ userId: user.id, sessionId: session.sessionId }),
    refreshToken: session.refreshToken,
    user: await getProfile(user.id),
    session: sessionInfo(user.role, session.expiresAt),
  };
}

// Confirma la identidad de un usuario con su contraseña dentro de una operación (p. ej. entrega de
// turno: firma quien entrega y quien recibe). Aplica las mismas reglas que el login: los fallos
// suman al contador y bloquean la cuenta a los 5. Responde 400 (no 401) para no cerrar la sesión
// de quien está operando. Devuelve { id, username, fullName, role, siteIds }.
async function confirmUserPassword({ userId, username }, password, req, purpose) {
  const outcome = await withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT u.id, u.username, u.full_name, u.role, u.is_active, u.password_hash, u.legacy_password_hash, u.failed_login_count,
              (u.locked_until IS NOT NULL AND u.locked_until > now()) AS is_locked,
              ceil(extract(epoch FROM u.locked_until - now()))::int AS lock_seconds_left,
              COALESCE((SELECT array_agg(site_id) FROM user_sites WHERE user_id = u.id), '{}') AS site_ids
         FROM users u
        WHERE ($1::int IS NOT NULL AND u.id = $1) OR ($1::int IS NULL AND lower(u.username) = lower($2))
        FOR NO KEY UPDATE OF u`,
      [userId ?? null, String(username ?? '').trim()],
    );
    const user = rows[0];
    const label = user?.username || String(username ?? '').trim() || 'el usuario';
    const failed = new HttpError(400, `Usuario o contraseña incorrectos (${label})`, {
      code: 'CONFIRMATION_FAILED',
      details: { username: label },
    });
    if (!user) {
      await burnPasswordCheck(password);
      return { error: failed };
    }
    const audit = (action, details = {}) =>
      recordAudit({ req, userId: user.id, action, entityType: 'user', entityId: user.id, details: { purpose, ...details } }, client);

    if (!user.is_active) return { error: new HttpError(400, `El usuario ${label} está desactivado`, { code: 'USER_INACTIVE' }) };
    if (user.is_locked) return { error: lockedError(user.lock_seconds_left) };

    const check = await verifyUserPassword(String(password ?? ''), user);
    if (!check.ok) {
      const attempts = user.failed_login_count + 1;
      if (attempts >= security.maxFailedLogins) {
        await client.query(
          'UPDATE users SET failed_login_count = 0, locked_until = now() + make_interval(mins => $2) WHERE id = $1',
          [user.id, security.lockMinutes],
        );
        await audit('ACCOUNT_LOCKED', { attempts });
        return { error: lockedError(security.lockMinutes * 60) };
      }
      await client.query('UPDATE users SET failed_login_count = $2 WHERE id = $1', [user.id, attempts]);
      await audit('CONFIRMATION_FAILED', { attempts });
      return { error: failed };
    }
    await client.query('UPDATE users SET failed_login_count = 0 WHERE id = $1 AND failed_login_count > 0', [user.id]);
    if (check.legacy) await upgradeLegacyPassword(client, user.id, String(password), audit);
    return {
      user: { id: user.id, username: user.username, fullName: user.full_name, role: user.role, siteIds: user.site_ids },
    };
  });
  if (outcome.error) throw outcome.error;
  return outcome.user;
}

function lockedError(secondsLeft) {
  const minutes = Math.max(1, Math.ceil(secondsLeft / 60));
  return new HttpError(
    423,
    `Cuenta bloqueada por intentos fallidos. Intente de nuevo en ${minutes} ${minutes === 1 ? 'minuto' : 'minutos'}.`,
    { code: 'ACCOUNT_LOCKED', details: { retryAfterSeconds: Math.max(1, secondsLeft) } },
  );
}

// ---------------------------------------------------------------------------
// Renovación, cierre y perfil
// ---------------------------------------------------------------------------

// Renueva el JWT de acceso usando el refresh token de la cookie. Cuenta como actividad.
async function refresh(refreshToken, req) {
  if (!refreshToken) {
    throw new HttpError(401, 'No hay una sesión activa', { code: 'AUTH_REQUIRED' });
  }
  const { rows } = await query(`${SESSION_SELECT} WHERE s.refresh_token_hash = $1 GROUP BY s.id, u.id`, [
    hashRefreshToken(refreshToken),
  ]);
  const row = rows[0];
  await assertSessionAlive(row, req);
  await touchSession(row.session_id, { force: true });
  return {
    accessToken: signAccessToken({ userId: row.user_id, sessionId: row.session_id }),
    offlineToken: signOfflineToken({ userId: row.user_id, sessionId: row.session_id }),
    user: await getProfile(row.user_id),
    session: sessionInfo(row.role, row.expires_at),
  };
}

async function logout(refreshToken, req) {
  if (!refreshToken) return;
  const { rows } = await query(
    `UPDATE user_sessions SET revoked_at = now(), revoked_reason = 'LOGOUT'
      WHERE refresh_token_hash = $1 AND revoked_at IS NULL
      RETURNING id, user_id`,
    [hashRefreshToken(refreshToken)],
  );
  if (rows[0]) {
    sessionEnded(rows[0].id, 'LOGOUT');
    await recordAudit({
      req,
      userId: rows[0].user_id,
      action: 'LOGOUT',
      entityType: 'session',
      entityId: rows[0].id,
    });
  }
}

// Cambio de la contraseña propia: exige la actual y cierra las demás sesiones del usuario.
async function changeOwnPassword(authUser, { currentPassword, newPassword }, req) {
  const policyError = passwordPolicyError(newPassword);
  if (policyError) throw new HttpError(400, policyError, { code: 'VALIDATION_ERROR' });
  if (currentPassword === newPassword) {
    throw new HttpError(400, 'La contraseña nueva debe ser distinta de la actual', { code: 'VALIDATION_ERROR' });
  }

  const { rows } = await query('SELECT password_hash, legacy_password_hash FROM users WHERE id = $1', [authUser.id]);
  if (!(await verifyUserPassword(currentPassword, rows[0])).ok) {
    await recordAudit({ req, userId: authUser.id, action: 'PASSWORD_CHANGE_FAILED', entityType: 'user', entityId: authUser.id });
    throw new HttpError(400, 'La contraseña actual no es correcta', { code: 'WRONG_PASSWORD' });
  }

  const newHash = await hashPassword(newPassword);
  await withTransaction(async (client) => {
    await client.query('UPDATE users SET password_hash = $2, legacy_password_hash = NULL, password_changed_at = now() WHERE id = $1', [
      authUser.id,
      newHash,
    ]);
    await revokeUserSessions(authUser.id, 'PASSWORD_CHANGED', client, { exceptSessionId: authUser.sessionId });
    await recordAudit(
      { req, userId: authUser.id, action: 'PASSWORD_CHANGED', entityType: 'user', entityId: authUser.id },
      client,
    );
  });
}

module.exports = {
  login,
  refresh,
  logout,
  changeOwnPassword,
  confirmUserPassword,
  resolveSession,
  resolveOfflineSession,
  getProfile,
  sessionInfo,
  revokeUserSessions,
};
