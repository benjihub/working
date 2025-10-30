const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { getDb, setGroupLivechatGroupId } = require('./db-utils');

const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret_change_me';
const JWT_EXPIRES_IN = '7d';

async function findUserByEmail(email) {
  const db = await getDb();
  const stmt = db.prepare('SELECT * FROM users WHERE email = ?');
  return stmt.get(email) || null;
}

async function findUserById(id) {
  const db = await getDb();
  const stmt = db.prepare('SELECT * FROM users WHERE id = ?');
  return stmt.get(id) || null;
}

async function createInitialMasterIfNone(email, password) {
  const db = await getDb();
  const count = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
  if (count > 0) return null;
  const hash = bcrypt.hashSync(password, 10);
  const ins = db.prepare('INSERT INTO users (email, password_hash, role, permissions) VALUES (?, ?, ?, ?)');
  const info = ins.run(email, hash, 'owner', JSON.stringify({}));
  return { id: info.lastInsertRowid, email, role: 'owner' };
}

async function registerAgent(email, password, permissions = {}, groupIds = []) {
  const db = await getDb();
  const hash = bcrypt.hashSync(password, 10);
  const ins = db.prepare('INSERT INTO users (email, password_hash, role, permissions) VALUES (?, ?, ?, ?)');
  const info = ins.run(email, hash, 'agent', JSON.stringify(permissions || {}));
  // map groups
  if (Array.isArray(groupIds)) {
    const mapIns = db.prepare('INSERT OR IGNORE INTO agent_groups (user_id, group_id) VALUES (?, ?)');
    groupIds.forEach(gid => mapIns.run(info.lastInsertRowid, gid));
  }
  return info.lastInsertRowid;
}

function signToken(user) {
  return jwt.sign({ sub: user.id, role: user.role }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}

function authMiddleware(requireRole = null) {
  return async (req, res, next) => {
    try {
      const hdr = req.headers['authorization'] || '';
      const token = hdr.startsWith('Bearer ') ? hdr.slice(7) : null;
      if (!token) return res.status(401).json({ success: false, error: 'Unauthorized' });
      const payload = jwt.verify(token, JWT_SECRET);
      const user = await findUserById(payload.sub);
      if (!user) return res.status(401).json({ success: false, error: 'Unauthorized' });
  if (requireRole && user.role !== requireRole) {
        return res.status(403).json({ success: false, error: 'Forbidden' });
      }
      // Attach user and parsed permissions for convenience
      req.user = user;
      try { req.user.permissionsObj = JSON.parse(user.permissions || '{}'); } catch(_) { req.user.permissionsObj = {}; }
      next();
    } catch (e) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
  };
}

function hasPermission(user, key) {
  if (!user) return false;
  if (user.role === 'owner') return true;
  if (user.role === 'master') {
    try {
      const obj = JSON.parse(user.permissions || '{}') || {};
      return obj.hasOwnProperty(key) ? !!obj[key] : true; // default allow
    } catch (_) { return true; }
  }
  let perms = {};
  try { perms = JSON.parse(user.permissions || '{}'); } catch (_) {}
  return !!perms[key];
}

async function listGroups() {
  const db = await getDb();
  return db.prepare('SELECT * FROM groups ORDER BY name').all();
}

async function createGroup(name, options = {}) {
  const db = await getDb();
  const normalizedName = String(name).trim();
  const livechatGroupId = options && options.livechatGroupId != null
    ? String(options.livechatGroupId).trim()
    : null;

  const stmt = db.prepare('INSERT OR IGNORE INTO groups (name, livechat_group_id) VALUES (?, ?)');
  const info = stmt.run(normalizedName, livechatGroupId || null);

  if (info.changes === 0) {
    const existing = db.prepare('SELECT id FROM groups WHERE name = ?').get(normalizedName);
    if (existing && livechatGroupId) {
      await setGroupLivechatGroupId(existing.id, livechatGroupId);
    }
    return existing ? existing.id : null;
  }

  if (livechatGroupId) {
    await setGroupLivechatGroupId(info.lastInsertRowid, livechatGroupId);
  }

  return info.lastInsertRowid;
}

async function setAgentGroups(userId, groupIds = []) {
  const db = await getDb();
  const del = db.prepare('DELETE FROM agent_groups WHERE user_id = ?');
  del.run(userId);
  const ins = db.prepare('INSERT OR IGNORE INTO agent_groups (user_id, group_id) VALUES (?, ?)');
  groupIds.forEach(gid => ins.run(userId, gid));
}

// Master group mapping (which groups a master can access; owner can manage)
async function setMasterGroups(userId, groupIds = []) {
  const db = await getDb();
  const del = db.prepare('DELETE FROM master_groups WHERE user_id = ?');
  del.run(userId);
  const ins = db.prepare('INSERT OR IGNORE INTO master_groups (user_id, group_id) VALUES (?, ?)');
  groupIds.forEach(gid => ins.run(userId, gid));
}

async function getMasterGroups(userId) {
  const db = await getDb();
  const sql = `SELECT g.* FROM groups g INNER JOIN master_groups mg ON mg.group_id = g.id WHERE mg.user_id = ? ORDER BY g.name`;
  return db.prepare(sql).all(userId);
}

async function getAgentGroups(userId) {
  const db = await getDb();
  const sql = `SELECT g.* FROM groups g INNER JOIN agent_groups ag ON ag.group_id = g.id WHERE ag.user_id = ? ORDER BY g.name`;
  return db.prepare(sql).all(userId);
}

async function logAgentAction(userId, action, details = {}, chatId = null) {
  const db = await getDb();
  const stmt = db.prepare('INSERT INTO agent_logs (user_id, chat_id, action, details) VALUES (?, ?, ?, ?)');
  stmt.run(userId, chatId, action, JSON.stringify(details || {}));
}

async function listAgentLogs(userId) {
  const db = await getDb();
  const stmt = db.prepare('SELECT * FROM agent_logs WHERE user_id = ? ORDER BY timestamp DESC LIMIT 200');
  return stmt.all(userId);
}

module.exports = {
  findUserByEmail,
  findUserById,
  createInitialMasterIfNone,
  registerAgent,
  signToken,
  authMiddleware,
  hasPermission,
  listGroups,
  createGroup,
  setAgentGroups,
  setMasterGroups,
  getAgentGroups,
  getMasterGroups,
  logAgentAction,
  listAgentLogs
};