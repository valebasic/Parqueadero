// Gestión de usuarios (RF05-RF06).
// Reglas:
//   - AG: gestiona a todos (AG, AS, OP).
//   - AS: solo operadores (OP) que trabajan en alguna de sus sedes, y solo les asigna sus sedes.
//   - Nadie se desactiva a sí mismo ni se cambia su propio rol.
//   - No se puede desactivar ni quitarle el rol al último AG activo.
//   - Los usuarios no se borran: se desactivan.
const { query, withTransaction } = require('../db/pool');
const HttpError = require('../middlewares/httpError');
const { deny } = require('../middlewares/authorize');
const { recordAudit } = require('./audit.service');
const { hashPassword, passwordPolicyError } = require('./password.service');
const { revokeUserSessions } = require('./auth.service');

const ROLES = ['AG', 'AS', 'OP'];
const USERNAME_RE = /^[A-Za-z0-9._-]{3,40}$/;
const FULL_NAME_RE = /^[A-Za-zÁÉÍÓÚÜÑáéíóúüñ' .-]{2,80}$/;
const UPDATABLE_FIELDS = ['fullName', 'role', 'siteIds', 'isActive', 'password'];

const USER_SELECT = `
  SELECT u.id, u.username, u.full_name, u.role, u.is_active, u.last_login_at, u.created_at,
         (u.locked_until IS NOT NULL AND u.locked_until > now()) AS is_locked,
         COALESCE((
           SELECT json_agg(json_build_object('id', s.id, 'code', s.code, 'name', s.name) ORDER BY s.name)
             FROM user_sites us JOIN sites s ON s.id = us.site_id
            WHERE us.user_id = u.id
         ), '[]') AS sites
    FROM users u`;

function toDto(row) {
  return {
    id: row.id,
    username: row.username,
    fullName: row.full_name,
    role: row.role,
    isActive: row.is_active,
    isLocked: row.is_locked,
    sites: row.sites,
    lastLoginAt: row.last_login_at,
    createdAt: row.created_at,
  };
}

// ¿El actor puede gestionar a este usuario?
function canManage(actor, target) {
  if (actor.role === 'AG') return true;
  if (actor.role === 'AS') {
    return target.role === 'OP' && target.siteIds.some((id) => actor.siteIds.includes(id));
  }
  return false;
}

// ---------------------------------------------------------------------------
// Validación
// ---------------------------------------------------------------------------

function validationError(details) {
  const first = Object.values(details)[0];
  return new HttpError(400, first, { code: 'VALIDATION_ERROR', details });
}

function parseId(value) {
  const id = Number.parseInt(value, 10);
  if (!Number.isInteger(id) || id <= 0 || String(id) !== String(value)) {
    throw new HttpError(400, 'Identificador inválido', { code: 'VALIDATION_ERROR' });
  }
  return id;
}

function normalizeSiteIds(value) {
  if (!Array.isArray(value) || !value.every((v) => Number.isInteger(v) && v > 0)) return null;
  return [...new Set(value)].sort((a, b) => a - b);
}

function validateFields(body, { creating }) {
  const errors = {};
  const out = {};

  if (creating || body.username !== undefined) {
    if (typeof body.username !== 'string' || !USERNAME_RE.test(body.username.trim())) {
      errors.username = 'El usuario debe tener de 3 a 40 caracteres: letras, números, punto, guion o guion bajo';
    } else out.username = body.username.trim();
  }
  if (creating || body.fullName !== undefined) {
    const name = typeof body.fullName === 'string' ? body.fullName.trim().replace(/\s+/g, ' ') : '';
    if (!FULL_NAME_RE.test(name)) errors.fullName = 'El nombre debe tener de 2 a 80 letras';
    else out.fullName = name;
  }
  if (creating || body.password !== undefined) {
    const policy = passwordPolicyError(body.password);
    if (policy) errors.password = policy;
    else out.password = body.password;
  }
  if (creating || body.role !== undefined) {
    if (!ROLES.includes(body.role)) errors.role = 'Rol inválido (AG, AS u OP)';
    else out.role = body.role;
  }
  if (creating || body.siteIds !== undefined) {
    const ids = normalizeSiteIds(body.siteIds ?? []);
    if (!ids) errors.siteIds = 'Las sedes deben ser una lista de identificadores';
    else out.siteIds = ids;
  }
  if (body.isActive !== undefined) {
    if (typeof body.isActive !== 'boolean') errors.isActive = 'isActive debe ser verdadero o falso';
    else out.isActive = body.isActive;
  }

  if (Object.keys(errors).length) throw validationError(errors);
  return out;
}

async function assertSitesExist(client, siteIds) {
  if (!siteIds.length) return;
  const { rows } = await client.query('SELECT id FROM sites WHERE id = ANY($1::int[]) AND is_active', [siteIds]);
  if (rows.length !== siteIds.length) {
    throw validationError({ siteIds: 'Alguna de las sedes no existe o está inactiva' });
  }
}

// ---------------------------------------------------------------------------
// Consultas
// ---------------------------------------------------------------------------

async function findUserDto(id) {
  const { rows } = await query(`${USER_SELECT} WHERE u.id = $1`, [id]);
  return rows[0] ? toDto(rows[0]) : null;
}

async function listUsers(req) {
  const actor = req.user;
  const { rows } =
    actor.role === 'AG'
      ? await query(`${USER_SELECT} ORDER BY u.is_active DESC, lower(u.username)`)
      : await query(
          `${USER_SELECT}
            WHERE u.role = 'OP'
              AND EXISTS (SELECT 1 FROM user_sites us WHERE us.user_id = u.id AND us.site_id = ANY($1::int[]))
            ORDER BY u.is_active DESC, lower(u.username)`,
          [actor.siteIds],
        );
  return rows.map(toDto);
}

async function getUser(req, rawId) {
  const id = parseId(rawId);
  const user = await findUserDto(id);
  if (!user) throw new HttpError(404, 'Usuario no encontrado', { code: 'NOT_FOUND' });
  if (!canManage(req.user, { role: user.role, siteIds: user.sites.map((s) => s.id) })) {
    throw await deny(req, 'No puede ver este usuario', 'FORBIDDEN_USER', { targetUserId: id });
  }
  return user;
}

// ---------------------------------------------------------------------------
// Crear
// ---------------------------------------------------------------------------

async function createUser(req, body) {
  const actor = req.user;
  const input = validateFields(body ?? {}, { creating: true });

  if (actor.role === 'AS') {
    if (input.role !== 'OP') {
      throw await deny(req, 'Un administrador de sede solo puede crear operadores', 'FORBIDDEN_ROLE', {
        requestedRole: input.role,
      });
    }
    if (input.siteIds.some((id) => !actor.siteIds.includes(id))) {
      throw await deny(req, 'Solo puede asignar sus propias sedes', 'FORBIDDEN_SITE', { siteIds: input.siteIds });
    }
  }
  if (input.role === 'AG' && input.siteIds.length) {
    throw validationError({ siteIds: 'El administrador general tiene acceso a todas las sedes; no se le asignan' });
  }
  if (input.role !== 'AG' && !input.siteIds.length) {
    throw validationError({ siteIds: 'Asigne al menos una sede' });
  }

  const passwordHash = await hashPassword(input.password);

  const id = await withTransaction(async (client) => {
    await assertSitesExist(client, input.siteIds);
    let inserted;
    try {
      inserted = await client.query(
        `INSERT INTO users (username, full_name, password_hash, role, created_by)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [input.username, input.fullName, passwordHash, input.role, actor.id],
      );
    } catch (err) {
      if (err.code === '23505') {
        throw new HttpError(409, `El usuario "${input.username}" ya existe`, { code: 'USERNAME_TAKEN' });
      }
      throw err;
    }
    const newId = inserted.rows[0].id;
    if (input.siteIds.length) {
      await client.query('INSERT INTO user_sites (user_id, site_id) SELECT $1, unnest($2::int[])', [
        newId,
        input.siteIds,
      ]);
    }
    await recordAudit(
      {
        req,
        userId: actor.id,
        action: 'USER_CREATED',
        entityType: 'user',
        entityId: newId,
        details: { username: input.username, role: input.role, siteIds: input.siteIds },
      },
      client,
    );
    return newId;
  });

  return findUserDto(id);
}

// ---------------------------------------------------------------------------
// Editar (incluye desactivar/activar y restablecer contraseña)
// ---------------------------------------------------------------------------

async function updateUser(req, rawId, body) {
  const actor = req.user;
  const id = parseId(rawId);
  const payload = body ?? {};

  const unknown = Object.keys(payload).filter((k) => !UPDATABLE_FIELDS.includes(k));
  if (unknown.length) throw validationError({ [unknown[0]]: `Campo no permitido: ${unknown.join(', ')}` });
  if (!Object.keys(payload).length) throw validationError({ body: 'No hay cambios para guardar' });

  const input = validateFields(payload, { creating: false });
  const passwordHash = input.password ? await hashPassword(input.password) : null;

  await withTransaction(async (client) => {
    // Si el afectado es un AG, se bloquean TODOS los AG en orden de id antes de seguir: así dos AG que
    // se desactivan entre sí al mismo tiempo no se cruzan (ni deadlock ni quedarse sin AG).
    const peek = await client.query('SELECT role FROM users WHERE id = $1', [id]);
    if (peek.rows[0]?.role === 'AG') {
      await client.query("SELECT id FROM users WHERE role = 'AG' ORDER BY id FOR NO KEY UPDATE");
    }
    // FOR NO KEY UPDATE: bloquea la fila sin impedir inserciones que la referencian (auditoría)
    const { rows } = await client.query(
      'SELECT id, username, full_name, role, is_active FROM users WHERE id = $1 FOR NO KEY UPDATE',
      [id],
    );
    const target = rows[0];
    if (!target) throw new HttpError(404, 'Usuario no encontrado', { code: 'NOT_FOUND' });
    const currentSites = (
      await client.query('SELECT site_id FROM user_sites WHERE user_id = $1 ORDER BY site_id', [id])
    ).rows.map((r) => r.site_id);

    if (!canManage(actor, { role: target.role, siteIds: currentSites })) {
      throw await deny(req, 'No puede modificar este usuario', 'FORBIDDEN_USER', { targetUserId: id });
    }

    const isSelf = target.id === actor.id;
    const newRole = input.role ?? target.role;
    const newActive = input.isActive ?? target.is_active;

    if (isSelf && newActive === false) {
      throw new HttpError(409, 'No puede desactivar su propia cuenta', { code: 'SELF_DEACTIVATION' });
    }
    if (isSelf && newRole !== target.role) {
      throw new HttpError(409, 'No puede cambiar su propio rol', { code: 'SELF_ROLE_CHANGE' });
    }
    if (actor.role === 'AS' && newRole !== 'OP') {
      throw await deny(req, 'Un administrador de sede solo gestiona operadores', 'FORBIDDEN_ROLE', {
        requestedRole: newRole,
      });
    }

    // Sedes: el AS solo toca sus sedes; las demás sedes del operador se conservan
    let newSites = currentSites;
    if (input.siteIds !== undefined) {
      if (actor.role === 'AS') {
        if (input.siteIds.some((s) => !actor.siteIds.includes(s))) {
          throw await deny(req, 'Solo puede asignar sus propias sedes', 'FORBIDDEN_SITE', { siteIds: input.siteIds });
        }
        const outsideScope = currentSites.filter((s) => !actor.siteIds.includes(s));
        newSites = [...new Set([...outsideScope, ...input.siteIds])].sort((a, b) => a - b);
      } else {
        newSites = input.siteIds;
      }
    }
    if (newRole === 'AG') {
      if (input.siteIds?.length) {
        throw validationError({ siteIds: 'El administrador general tiene acceso a todas las sedes; no se le asignan' });
      }
      newSites = [];
    } else if (!newSites.length) {
      throw validationError({ siteIds: 'Asigne al menos una sede' });
    }
    await assertSitesExist(client, newSites.filter((s) => !currentSites.includes(s)));

    // Último AG activo
    if (target.role === 'AG' && target.is_active && (newRole !== 'AG' || !newActive)) {
      const others = await client.query(
        "SELECT id FROM users WHERE role = 'AG' AND is_active AND id <> $1",
        [id],
      );
      if (others.rowCount === 0) {
        throw new HttpError(409, 'No se puede desactivar ni cambiar el rol del último administrador general', {
          code: 'LAST_ADMIN',
        });
      }
    }

    const activated = !target.is_active && newActive;
    await client.query(
      `UPDATE users
          SET full_name = $2, role = $3, is_active = $4,
              password_hash = COALESCE($5, password_hash),
              legacy_password_hash = CASE WHEN $5 IS NULL THEN legacy_password_hash ELSE NULL END,
              password_changed_at = CASE WHEN $5 IS NULL THEN password_changed_at ELSE now() END,
              failed_login_count = CASE WHEN $5 IS NOT NULL OR $6 THEN 0 ELSE failed_login_count END,
              locked_until = CASE WHEN $5 IS NOT NULL OR $6 THEN NULL ELSE locked_until END
        WHERE id = $1`,
      [id, input.fullName ?? target.full_name, newRole, newActive, passwordHash, activated],
    );

    const sitesChanged = newSites.join(',') !== currentSites.join(',');
    if (sitesChanged) {
      await client.query('DELETE FROM user_sites WHERE user_id = $1', [id]);
      if (newSites.length) {
        await client.query('INSERT INTO user_sites (user_id, site_id) SELECT $1, unnest($2::int[])', [id, newSites]);
      }
    }

    // Sesiones: desactivar o restablecer la contraseña saca al usuario de inmediato
    if (target.is_active && !newActive) await revokeUserSessions(id, 'USER_DEACTIVATED', client);
    if (passwordHash) await revokeUserSessions(id, 'PASSWORD_RESET', client);

    // Auditoría: una fila por tipo de cambio
    const audit = (action, details) =>
      recordAudit({ req, userId: actor.id, action, entityType: 'user', entityId: id, details }, client);

    const changes = {};
    if (input.fullName !== undefined && input.fullName !== target.full_name) {
      changes.fullName = { from: target.full_name, to: input.fullName };
    }
    if (newRole !== target.role) changes.role = { from: target.role, to: newRole };
    if (sitesChanged) changes.siteIds = { from: currentSites, to: newSites };
    if (Object.keys(changes).length) await audit('USER_UPDATED', { username: target.username, changes });
    if (target.is_active && !newActive) await audit('USER_DEACTIVATED', { username: target.username });
    if (activated) await audit('USER_ACTIVATED', { username: target.username });
    if (passwordHash) await audit('USER_PASSWORD_RESET', { username: target.username });
  });

  return findUserDto(id);
}

module.exports = { listUsers, getUser, createUser, updateUser, canManage };
