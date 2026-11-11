const authService = require('../services/auth.service');
const { security } = require('../config/security');

function refreshCookieOptions() {
  return {
    httpOnly: true,
    secure: security.cookieSecure,
    sameSite: 'strict',
    path: security.refreshCookiePath,
    maxAge: security.sessionMaxHours * 60 * 60 * 1000,
  };
}

function clearRefreshCookie(res) {
  const { maxAge, ...options } = refreshCookieOptions();
  res.clearCookie(security.refreshCookieName, options);
}

// POST /api/auth/login  { username, password }
async function login(req, res) {
  const { accessToken, refreshToken, user, session } = await authService.login(req.body ?? {}, req);
  res.cookie(security.refreshCookieName, refreshToken, refreshCookieOptions());
  res.json({ ok: true, data: { accessToken, user, session } });
}

// POST /api/auth/refresh  (usa la cookie httpOnly)
async function refresh(req, res) {
  try {
    const data = await authService.refresh(req.cookies?.[security.refreshCookieName], req);
    res.json({ ok: true, data });
  } catch (err) {
    if (err.status === 401) clearRefreshCookie(res);
    throw err;
  }
}

// POST /api/auth/logout
async function logout(req, res) {
  await authService.logout(req.cookies?.[security.refreshCookieName], req);
  clearRefreshCookie(res);
  res.json({ ok: true });
}

// GET /api/auth/me
async function me(req, res) {
  const user = await authService.getProfile(req.user.id);
  res.json({ ok: true, data: { user, session: authService.sessionInfo(req.user.role, req.user.sessionExpiresAt) } });
}

// PUT /api/auth/password  { currentPassword, newPassword }
async function changePassword(req, res) {
  await authService.changeOwnPassword(req.user, req.body ?? {}, req);
  res.json({ ok: true });
}

module.exports = { login, refresh, logout, me, changePassword };
