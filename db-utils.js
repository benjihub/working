const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs').promises;

const dbPath = path.join(__dirname, 'database', 'chats.db');
let dbInstance = null;

// Ensure database directory exists and initialize database
async function initDb() {
  if (dbInstance) return dbInstance;
  
  try {
    await fs.mkdir(path.dirname(dbPath), { recursive: true });
    
    // Initialize the database with better-sqlite3
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    
    // Enable foreign key constraints
    db.pragma('foreign_keys = ON');
    
    // Create tables if they don't exist
  db.exec(`
      CREATE TABLE IF NOT EXISTS chats (
        id TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        last_activity INTEGER NOT NULL,
        created_at INTEGER DEFAULT (strftime('%s', 'now'))
      );
      
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        timestamp INTEGER DEFAULT (strftime('%s', 'now')),
        FOREIGN KEY (chat_id) REFERENCES chats (id) ON DELETE CASCADE
      );
      
      CREATE INDEX IF NOT EXISTS idx_chat_id ON messages(chat_id);
      CREATE INDEX IF NOT EXISTS idx_last_activity ON chats(last_activity);

      -- Users table (owner, master, agent)
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('owner','master','agent')),
        permissions TEXT DEFAULT '{}',
        created_at INTEGER DEFAULT (strftime('%s', 'now'))
      );

      -- Groups table
      CREATE TABLE IF NOT EXISTS groups (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE NOT NULL,
        livechat_group_id TEXT
      );

      -- Agent to Groups mapping (which groups an agent can access)
      CREATE TABLE IF NOT EXISTS agent_groups (
        user_id INTEGER NOT NULL,
        group_id INTEGER NOT NULL,
        PRIMARY KEY (user_id, group_id),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE
      );

      -- Master to Groups mapping (which groups a master can access)
      CREATE TABLE IF NOT EXISTS master_groups (
        user_id INTEGER NOT NULL,
        group_id INTEGER NOT NULL,
        PRIMARY KEY (user_id, group_id),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE
      );

      -- Agent activity logs
      CREATE TABLE IF NOT EXISTS agent_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        chat_id TEXT,
        action TEXT NOT NULL,
        details TEXT,
        timestamp INTEGER DEFAULT (strftime('%s', 'now')),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );

      -- Mapping from LiveChat chat_id to a group (optional)
      CREATE TABLE IF NOT EXISTS chat_groups (
        chat_id TEXT PRIMARY KEY,
        group_id INTEGER NOT NULL,
        FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE
      );

      -- LiveChat metadata for each chat (stores original LiveChat Group ID from widget)
      CREATE TABLE IF NOT EXISTS chat_livechat_metadata (
        chat_id TEXT PRIMARY KEY,
        livechat_group_id TEXT,
        livechat_license TEXT,
        access_group_ids TEXT,
        webhook_action TEXT,
        captured_at INTEGER DEFAULT (strftime('%s', 'now')),
        payload_snapshot TEXT
      );

      -- Per-group AI configuration (brand, settings)
      CREATE TABLE IF NOT EXISTS groups_config (
        group_id INTEGER PRIMARY KEY,
        brand_name TEXT NOT NULL,
        ai_settings TEXT DEFAULT '{}',
        rtp_link TEXT,
        livechat_license TEXT,
        livechat_group_id TEXT,
        livechat_widget_src TEXT,
        livechat_client_id TEXT,
  livechat_webhook_secret TEXT,
  requirements TEXT,
        FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE
      );

      -- Per-group promotions
      CREATE TABLE IF NOT EXISTS group_promotions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        group_id INTEGER NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        discount REAL,
        code TEXT,
        timeLimit TEXT,
        terms TEXT,
  howToClaim TEXT,
        eligibleItems TEXT,
        eligibleGames TEXT,
        endDate TEXT,
        FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE
      );
      
      -- AI usage accounting (owner-only metrics)
      CREATE TABLE IF NOT EXISTS ai_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER DEFAULT (strftime('%s','now')),
        chat_id TEXT,
        group_id INTEGER,
        model TEXT,
        prompt_tokens INTEGER,
        completion_tokens INTEGER,
        total_tokens INTEGER,
        source TEXT,
        FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE SET NULL
      );

      CREATE TABLE IF NOT EXISTS global_settings (
        key TEXT PRIMARY KEY,
        value TEXT,
        updated_at INTEGER DEFAULT (strftime('%s','now'))
      );

      -- API Tools system for custom integrations
      CREATE TABLE IF NOT EXISTS api_tools (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE NOT NULL,
        description TEXT NOT NULL,
        webhook_address TEXT NOT NULL,
        max_tool_calls INTEGER DEFAULT 30,
        api_key_bearer TEXT,
        is_active BOOLEAN DEFAULT 0,
        created_by INTEGER,
        created_at INTEGER DEFAULT (strftime('%s', 'now')),
        updated_at INTEGER DEFAULT (strftime('%s', 'now')),
        FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
      );

      -- Input fields configuration for each API tool
      CREATE TABLE IF NOT EXISTS api_tool_fields (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tool_id INTEGER NOT NULL,
        field_name TEXT NOT NULL,
        field_type TEXT NOT NULL CHECK(field_type IN ('text','number','boolean','phone')),
        description TEXT NOT NULL,
        is_required BOOLEAN DEFAULT 0,
        enum_values TEXT, -- JSON array for enum options
        default_value TEXT,
        FOREIGN KEY (tool_id) REFERENCES api_tools(id) ON DELETE CASCADE,
        UNIQUE(tool_id, field_name)
      );

      -- Additional payload fields for API tools
      CREATE TABLE IF NOT EXISTS api_tool_payload (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tool_id INTEGER NOT NULL,
        key_name TEXT NOT NULL,
        value_type TEXT DEFAULT 'static', -- 'static', 'phone_number', 'user_data'
        static_value TEXT,
        FOREIGN KEY (tool_id) REFERENCES api_tools(id) ON DELETE CASCADE,
        UNIQUE(tool_id, key_name)
      );

      -- API tool usage logs
      CREATE TABLE IF NOT EXISTS api_tool_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tool_id INTEGER NOT NULL,
        chat_id TEXT,
        input_data TEXT, -- JSON of input parameters
        response_data TEXT, -- JSON of API response
        success BOOLEAN DEFAULT 0,
        error_message TEXT,
        execution_time_ms INTEGER,
        timestamp INTEGER DEFAULT (strftime('%s', 'now')),
        FOREIGN KEY (tool_id) REFERENCES api_tools(id) ON DELETE CASCADE
      );
    `);
    
    dbInstance = db;
    // --- Lightweight migration: ensure users.role allows 'owner'
    try {
      const row = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='users'`).get();
      const ddl = row && row.sql ? String(row.sql) : '';
      if (ddl.includes("CHECK(role IN ('master','agent'))")) {
        // Migrate to include 'owner'
        db.exec(`
          BEGIN TRANSACTION;
          CREATE TABLE IF NOT EXISTS users_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            email TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            role TEXT NOT NULL CHECK(role IN ('owner','master','agent')),
            permissions TEXT DEFAULT '{}',
            created_at INTEGER DEFAULT (strftime('%s', 'now'))
          );
          INSERT OR IGNORE INTO users_new (id, email, password_hash, role, permissions, created_at)
            SELECT id, email, password_hash, role, permissions, created_at FROM users;
          DROP TABLE users;
          ALTER TABLE users_new RENAME TO users;
          COMMIT;
        `);
      }
    } catch (migrErr) {
      console.warn('Users table migration (owner role) skipped/failed:', migrErr?.message || migrErr);
    }
    // --- Lightweight migration: ensure groups table has livechat_group_id column
    try {
      const groupCols = db.prepare(`PRAGMA table_info(groups)`).all();
      const hasLivechatGroup = Array.isArray(groupCols) && groupCols.some(c => String(c.name).toLowerCase() === 'livechat_group_id');
      if (!hasLivechatGroup) {
        db.exec(`ALTER TABLE groups ADD COLUMN livechat_group_id TEXT`);
      }
    } catch (e) {
      console.warn('Migration for groups.livechat_group_id skipped/failed:', e?.message || e);
    }

    // --- Lightweight migration: add rtp_link to groups_config if missing
    try {
      const cols = db.prepare(`PRAGMA table_info(groups_config)`).all();
      const hasRtp = Array.isArray(cols) && cols.some(c => String(c.name).toLowerCase() === 'rtp_link');
      if (!hasRtp) {
        db.exec(`ALTER TABLE groups_config ADD COLUMN rtp_link TEXT`);
      }
      const ensureCol = (name)=>{
        if (!Array.isArray(cols) || !cols.some(c => String(c.name).toLowerCase() === name.toLowerCase())) {
          db.exec(`ALTER TABLE groups_config ADD COLUMN ${name} TEXT`);
        }
      };
      ensureCol('livechat_license');
      ensureCol('livechat_group_id');
      ensureCol('livechat_widget_src');
      ensureCol('livechat_client_id');
  ensureCol('livechat__secret');
  ensureCol('requirements');
    } catch (e) {
      console.warn('Migration for groups_config.rtp_link skipped/failed:', e?.message || e);
    }
    // --- Ensure global_auto_ai table exists (for Global Auto AI feature)
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS global_auto_ai (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          group_id INTEGER UNIQUE,
          enabled INTEGER NOT NULL DEFAULT 0,
          locked_by_user_id INTEGER,
          locked_by_email TEXT,
          locked_by_role TEXT,
          locked_at INTEGER,
          created_at INTEGER DEFAULT (strftime('%s','now')),
          FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE,
          FOREIGN KEY (locked_by_user_id) REFERENCES users(id) ON DELETE SET NULL
        )
      `);
    } catch (e) {
      console.warn('Migration for global_auto_ai skipped/failed:', e?.message || e);
    }
    // --- Lightweight migration: add howToClaim to group_promotions if missing
    try {
      const cols2 = db.prepare(`PRAGMA table_info(group_promotions)`).all();
      const hasHow = Array.isArray(cols2) && cols2.some(c => String(c.name).toLowerCase() === 'howtoclaim');
      if (!hasHow) {
        db.exec(`ALTER TABLE group_promotions ADD COLUMN howToClaim TEXT`);
      }
    } catch (e) {
      console.warn('Migration for group_promotions.howToClaim skipped/failed:', e?.message || e);
    }
    // --- Lightweight migration: ensure ai_usage exists with all columns
    try {
      db.exec(`CREATE TABLE IF NOT EXISTS ai_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER DEFAULT (strftime('%s','now')),
        chat_id TEXT,
        group_id INTEGER,
        model TEXT,
        prompt_tokens INTEGER,
        completion_tokens INTEGER,
        total_tokens INTEGER,
        source TEXT,
        FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE SET NULL
      )`);
      // Add columns if missing
      const cols3 = db.prepare(`PRAGMA table_info(ai_usage)`).all();
      const ensureCol3 = (name, ddl) => { if (!cols3.some(c => String(c.name).toLowerCase() === name.toLowerCase())) { db.exec(`ALTER TABLE ai_usage ADD COLUMN ${ddl}`); } };
      ensureCol3('source', 'source TEXT');
      ensureCol3('group_id', 'group_id INTEGER');
    } catch (e) {
      console.warn('Migration for ai_usage skipped/failed:', e?.message || e);
    }
    // --- Lightweight migration: ensure chats table has last_customer_event_id
    try {
      const chatCols = db.prepare(`PRAGMA table_info(chats)`).all();
      const hasLastEvent = Array.isArray(chatCols) && chatCols.some(c => String(c.name).toLowerCase() === 'last_customer_event_id');
      if (!hasLastEvent) {
        db.exec(`ALTER TABLE chats ADD COLUMN last_customer_event_id TEXT`);
      }
    } catch (e) {
      console.warn('Migration for chats.last_customer_event_id skipped/failed:', e?.message || e);
    }
    // --- Lightweight migration: ensure global_settings table exists (for older installs)
    try {
      db.exec(`CREATE TABLE IF NOT EXISTS global_settings (
        key TEXT PRIMARY KEY,
        value TEXT,
        updated_at INTEGER DEFAULT (strftime('%s','now'))
      )`);
    } catch (e) {
      console.warn('Migration for global_settings skipped/failed:', e?.message || e);
    }
    return db;
  } catch (error) {
    console.error('Error initializing database:', error);
    throw error;
  }
}

// Get or create chat state
async function getChatState(db, chatId) {
  try {
    const stmt = db.prepare('SELECT state FROM chats WHERE id = ?');
    const row = stmt.get(chatId);
    return row ? JSON.parse(row.state) : null;
  } catch (error) {
    console.error('Error getting chat state:', error);
    throw error;
  }
}

// Update chat state
async function updateChatState(db, chatId, state) {
  try {
    const now = Math.floor(Date.now() / 1000);
    const stmt = db.prepare(`
      INSERT INTO chats (id, state, last_activity) 
      VALUES (?, ?, ?) 
      ON CONFLICT(id) DO UPDATE SET 
        state = excluded.state,
        last_activity = excluded.last_activity
    `);
    
    stmt.run(chatId, JSON.stringify(state), now);
  } catch (error) {
    console.error('Error updating chat state:', error);
    throw error;
  }
}

// Add message to chat
async function addMessage(db, chatId, role, content) {
  try {
    const stmt = db.prepare(
      'INSERT INTO messages (chat_id, role, content) VALUES (?, ?, ?)'
    );
    const info = stmt.run(chatId, role, content);
    return info.lastInsertRowid;
  } catch (error) {
    console.error('Error adding message:', error);
    throw error;
  }
}

// Get chat messages
async function getChatMessages(db, chatId, limit = 50) {
  try {
    const stmt = db.prepare(
      'SELECT role, content FROM messages WHERE chat_id = ? ORDER BY timestamp DESC LIMIT ?'
    );
    return stmt.all(chatId, limit) || [];
  } catch (error) {
    console.error('Error getting chat messages:', error);
    throw error;
  }
}

// Clean up old chats (older than 48 hours)
async function cleanupOldChats() {
  try {
    const db = await getDb();
    const twoDaysAgo = Math.floor(Date.now() / 1000) - (48 * 60 * 60);
    
    const stmt = db.prepare('DELETE FROM chats WHERE last_activity < ?');
    const result = stmt.run(twoDaysAgo);
    return result.changes;
  } catch (error) {
    console.error('Error cleaning up old chats:', error);
    throw error;
  }
}

// Get the database instance
async function getDb() {
  if (!dbInstance) {
    await initDb();
  }
  return dbInstance;
}

// Top-level Global Auto AI helpers (use after DB initialized)
async function getGlobalAutoAi(groupId) {
  const db = await getDb();
  const row = db.prepare('SELECT id, group_id, enabled, locked_by_user_id, locked_by_email, locked_by_role, locked_at, created_at FROM global_auto_ai WHERE group_id = ?').get(Number(groupId));
  if (!row) return null;
  return {
    id: row.id,
    groupId: row.group_id,
    enabled: !!row.enabled,
    lockedByUserId: row.locked_by_user_id || null,
    lockedByEmail: row.locked_by_email || null,
    lockedByRole: row.locked_by_role || null,
    lockedAt: row.locked_at ? new Date(row.locked_at * 1000).toISOString() : null,
    createdAt: row.created_at ? new Date(row.created_at * 1000).toISOString() : null
  };
}

async function upsertGlobalAutoAi(groupId, { enabled = null, lockedByUserId = null, lockedByEmail = null, lockedByRole = null, lockedAt = null } = {}) {
  const db = await getDb();
  // Try to insert or update
  const exists = db.prepare('SELECT id FROM global_auto_ai WHERE group_id = ?').get(Number(groupId));
  if (!exists) {
    const stmt = db.prepare(`INSERT INTO global_auto_ai (group_id, enabled, locked_by_user_id, locked_by_email, locked_by_role, locked_at) VALUES (?, ?, ?, ?, ?, ?)`);
    stmt.run(Number(groupId), enabled != null ? (enabled ? 1 : 0) : 0, lockedByUserId ? Number(lockedByUserId) : null, lockedByEmail || null, lockedByRole || null, lockedAt ? Math.floor(new Date(lockedAt).getTime() / 1000) : null);
  } else {
    const stmt = db.prepare(`UPDATE global_auto_ai SET
      enabled = COALESCE(?, enabled),
      locked_by_user_id = COALESCE(?, locked_by_user_id),
      locked_by_email = COALESCE(?, locked_by_email),
      locked_by_role = COALESCE(?, locked_by_role),
      locked_at = COALESCE(?, locked_at)
      WHERE group_id = ?`);
    stmt.run(
      enabled != null ? (enabled ? 1 : 0) : null,
      lockedByUserId ? Number(lockedByUserId) : null,
      lockedByEmail || null,
      lockedByRole || null,
      lockedAt ? Math.floor(new Date(lockedAt).getTime() / 1000) : null,
      Number(groupId)
    );
  }
  return await getGlobalAutoAi(groupId);
}

// --- Chat group helpers ---
async function setChatGroup(chatId, groupId) {
  const db = await getDb();
  const normalizedChatId = chatId == null ? null : String(chatId).trim();
  const stmt = db.prepare('INSERT OR REPLACE INTO chat_groups (chat_id, group_id) VALUES (?, ?)');
  stmt.run(normalizedChatId, Number(groupId));
}

async function getChatGroup(chatId) {
  const db = await getDb();
  const normalizedChatId = chatId == null ? null : String(chatId).trim();
  const stmt = db.prepare('SELECT group_id FROM chat_groups WHERE chat_id = ?');
  return stmt.get(normalizedChatId) || null;
}

async function getChatGroupMap(chatIds = []) {
  const db = await getDb();
  if (!Array.isArray(chatIds) || chatIds.length === 0) return {};
  const normalizedIds = chatIds.map(id => (id == null ? null : String(id).trim()));
  const placeholders = normalizedIds.map(() => '?').join(',');
  const sql = `SELECT chat_id, group_id FROM chat_groups WHERE chat_id IN (${placeholders})`;
  const rows = db.prepare(sql).all(...normalizedIds);
  return rows.reduce((acc, r) => { acc[r.chat_id] = r.group_id; return acc; }, {});
}

async function setGroupLivechatGroupId(groupId, livechatGroupId) {
  if (groupId == null) return;
  const db = await getDb();
  const normalized = livechatGroupId != null ? String(livechatGroupId).trim() : null;
  const stmt = db.prepare('UPDATE groups SET livechat_group_id = ? WHERE id = ?');
  stmt.run(normalized || null, Number(groupId));

  // Keep groups_config.livechat_group_id in sync when present
  try {
    // If groups_config exists for this group, update its livechat id.
    const cfgRow = db.prepare('SELECT group_id FROM groups_config WHERE group_id = ?').get(Number(groupId));
    if (cfgRow) {
      const upd = db.prepare('UPDATE groups_config SET livechat_group_id = ? WHERE group_id = ?');
      upd.run(normalized || null, Number(groupId));
    } else if (normalized) {
      // If no config row exists, create one so the mapping is persisted for advanced setups
      try {
        // Use the upsert helper to create a minimal config (brand_name default handled by upsertGroupConfig)
        if (typeof upsertGroupConfig === 'function') {
          await upsertGroupConfig(Number(groupId), { livechatGroupId: normalized });
        } else {
          const ins = db.prepare('INSERT INTO groups_config (group_id, brand_name, livechat_group_id) VALUES (?, ?, ?)');
          ins.run(Number(groupId), 'GoodCasino', normalized);
        }
      } catch (err2) {
        console.warn('Failed creating groups_config for livechat mapping', err2?.message || err2);
      }
    }
  } catch (err) {
    console.warn('Failed syncing groups_config livechat_group_id', err?.message || err);
  }
}

async function clearGroupLivechatGroupId(groupId) {
  if (groupId == null) return;
  const db = await getDb();
  db.prepare('UPDATE groups SET livechat_group_id = NULL WHERE id = ?').run(Number(groupId));
  try {
    db.prepare('UPDATE groups_config SET livechat_group_id = NULL WHERE group_id = ?').run(Number(groupId));
  } catch (_) {
    // optional
  }
}

async function findGroupByLivechatGroupId(livechatGroupId) {
  if (livechatGroupId == null) return null;
  const normalized = String(livechatGroupId).trim();
  if (!normalized) return null;
  const db = await getDb();
  const row = db.prepare(`
    SELECT 
      g.id AS group_id,
      g.name AS group_name,
      g.livechat_group_id AS group_livechat_id,
      gc.brand_name,
      gc.livechat_license,
      gc.livechat_widget_src,
      gc.livechat_client_id,
      gc.livechat_group_id AS config_livechat_id
    FROM groups g
    LEFT JOIN groups_config gc ON gc.group_id = g.id
    WHERE g.livechat_group_id = ? OR gc.livechat_group_id = ?
    LIMIT 1
  `).get(normalized, normalized);
  if (!row) return null;
  return {
    id: row.group_id,
    name: row.group_name,
    livechatGroupId: row.group_livechat_id || row.config_livechat_id || null,
    brandName: row.brand_name || null,
    livechatLicense: row.livechat_license || null,
    livechatWidgetSrc: row.livechat_widget_src || null,
    livechatClientId: row.livechat_client_id || null
  };
}

async function listGroupLivechatMappings() {
  const db = await getDb();
  const rows = db.prepare(`
    SELECT g.id AS group_id, g.name, g.livechat_group_id, gc.livechat_group_id AS config_livechat_id
    FROM groups g
    LEFT JOIN groups_config gc ON gc.group_id = g.id
    ORDER BY g.name
  `).all();
  return rows.map((row) => ({
    id: row.group_id,
    name: row.name,
    livechatGroupId: row.livechat_group_id || row.config_livechat_id || null
  }));
}

async function getGroupLivechatGroupId(groupId) {
  if (groupId == null) return null;
  const db = await getDb();
  const row = db.prepare('SELECT livechat_group_id FROM groups WHERE id = ?').get(Number(groupId));
  if (row && row.livechat_group_id) return row.livechat_group_id;
  const cfg = db.prepare('SELECT livechat_group_id FROM groups_config WHERE group_id = ?').get(Number(groupId));
  return cfg ? cfg.livechat_group_id || null : null;
}

module.exports = {
  initDb,
  getDb,
  getChatState,
  updateChatState,
  addMessage,
  getChatMessages,
  cleanupOldChats
  , setChatGroup
  , getChatGroup
  , getChatGroupMap
  , setGroupLivechatGroupId
  , clearGroupLivechatGroupId
  , findGroupByLivechatGroupId
  , listGroupLivechatMappings
  , getGroupLivechatGroupId
  ,
  // Chat status helpers (persisted in chats.state under ticket_status)
  async setChatStatus(chatId, status) {
    const db = await getDb();
    const allowed = new Set(['in_progress','completed','needs_human']);
    const s = allowed.has(String(status)) ? String(status) : 'in_progress';
    let state = await getChatState(db, String(chatId));
    if (!state || typeof state !== 'object') state = {};
    state.ticket_status = s;
    await updateChatState(db, String(chatId), state);
    
    // Broadcast chat status change via SSE if function is available
    try {
      if (global.broadcastSSE && typeof global.broadcastSSE === 'function') {
        global.broadcastSSE('chat_status_change', {
          chatId: String(chatId),
          status: s,
          timestamp: new Date().toISOString()
        });
      }
    } catch (e) {
      // Silently ignore SSE broadcast errors
    }
    
    return s;
  },
  async getChatStatus(chatId) {
    const db = await getDb();
    const state = await getChatState(db, String(chatId));
    const s = state && state.ticket_status ? String(state.ticket_status) : null;
    return s || 'in_progress';
  },
  async getChatStatusMap(chatIds = []) {
    const db = await getDb();
    const map = {};
    if (!Array.isArray(chatIds) || chatIds.length === 0) return map;
    for (const id of chatIds) {
      try {
        const st = await module.exports.getChatStatus(String(id));
        map[String(id)] = st;
      } catch (_) {
        map[String(id)] = 'in_progress';
      }
    }
    return map;
  },
  // AI usage helpers
  recordAiUsage: async function({ chatId = null, groupId = null, model = null, promptTokens = 0, completionTokens = 0, totalTokens = null, source = null } = {}) {
    const db = await getDb();
    const stmt = db.prepare(`INSERT INTO ai_usage (chat_id, group_id, model, prompt_tokens, completion_tokens, total_tokens, source)
                             VALUES (?, ?, ?, ?, ?, ?, ?)`);
    const total = (totalTokens != null) ? Number(totalTokens) : (Number(promptTokens||0) + Number(completionTokens||0));
    stmt.run(chatId ? String(chatId) : null, groupId != null ? Number(groupId) : null, model || null, Number(promptTokens||0), Number(completionTokens||0), total, source || null);
  },
  async getGlobalAutoAiState() {
    const db = await getDb();
    const row = db.prepare('SELECT value FROM global_settings WHERE key = ?').get('auto_ai_global');
    if (!row || !row.value) {
      // Default: enabled=true (always ON)
      return {
        enabled: true,
        lockedByUserId: null,
        lockedByEmail: null,
        lockedByRole: null,
        lockedScope: null,
        lockedAt: null
      };
    }
    try {
      const parsed = JSON.parse(row.value);
      return Object.assign({
        enabled: true,  // Default: always ON
        lockedByUserId: null,
        lockedByEmail: null,
        lockedByRole: null,
        lockedScope: null,
        lockedAt: null
      }, parsed);
    } catch (_) {
      return {
        enabled: true,  // Default: always ON
        lockedByUserId: null,
        lockedByEmail: null,
        lockedByRole: null,
        lockedScope: null,
        lockedAt: null
      };
    }
  },
  getGlobalAutoAi,
  upsertGlobalAutoAi,
  async setGlobalAutoAiState(state = {}) {
    const db = await getDb();
    const payload = Object.assign({
      enabled: true,  // Default: always ON
      lockedByUserId: null,
      lockedByEmail: null,
      lockedByRole: null,
      lockedScope: null,
      lockedAt: null
    }, state || {});
    const stmt = db.prepare(`INSERT INTO global_settings (key, value, updated_at) VALUES (?, ?, strftime('%s','now'))
                             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`);
    stmt.run('auto_ai_global', JSON.stringify(payload));
    return payload;
  },
  async getLastCustomerEventId(chatId) {
    if (!chatId) return null;
    const db = await getDb();
    const row = db.prepare('SELECT last_customer_event_id FROM chats WHERE id = ?').get(String(chatId));
    return row ? row.last_customer_event_id || null : null;
  },
  async updateLastCustomerEventId(chatId, eventId) {
    if (!chatId) return;
    const db = await getDb();
    const value = eventId ? String(eventId) : null;
    db.prepare('UPDATE chats SET last_customer_event_id = ? WHERE id = ?').run(value, String(chatId));
  },
  getAiUsageTotals: async function({ since = null, groupId = null } = {}) {
    const db = await getDb();
    let sql = 'SELECT COALESCE(SUM(prompt_tokens),0) AS promptTokens, COALESCE(SUM(completion_tokens),0) AS completionTokens, COALESCE(SUM(total_tokens),0) AS totalTokens FROM ai_usage';
    const conds = [];
    const args = [];
    if (since != null) { conds.push('timestamp >= ?'); args.push(Number(Math.floor(Number(since)/1000))); }
    if (groupId != null) { conds.push('group_id = ?'); args.push(Number(groupId)); }
    if (conds.length) sql += ' WHERE ' + conds.join(' AND ');
    const row = db.prepare(sql).get(...args) || { promptTokens:0, completionTokens:0, totalTokens:0 };
    return { promptTokens: row.promptTokens || 0, completionTokens: row.completionTokens || 0, totalTokens: row.totalTokens || 0 };
  },
  // Group AI config helpers
  async upsertGroupConfig(groupId, { brandName, aiSettings = {}, rtpLink = null, livechatLicense = null, livechatGroupId = null, livechatWidgetSrc = null, livechatClientId = null, livechatWebhookSecret = null, requirements = null } = {}) {
    const db = await getDb();
    const brand = (brandName && String(brandName).trim()) || 'GoodCasino';
    const ai = JSON.stringify(aiSettings || {});
    // Ensure the groups table has a row for this groupId to satisfy FK constraint
    try {
      db.prepare('INSERT OR IGNORE INTO groups (id, name) VALUES (?, ?)').run(Number(groupId), brand);
    } catch (_) {}
    const stmt = db.prepare(`INSERT INTO groups_config (group_id, brand_name, ai_settings, rtp_link, livechat_license, livechat_group_id, livechat_widget_src, livechat_client_id, livechat_webhook_secret, requirements)
                             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                             ON CONFLICT(group_id) DO UPDATE SET 
                               brand_name=excluded.brand_name,
                               ai_settings=excluded.ai_settings,
                               rtp_link=excluded.rtp_link,
                               livechat_license=excluded.livechat_license,
                               livechat_group_id=excluded.livechat_group_id,
                               livechat_widget_src=excluded.livechat_widget_src,
                               livechat_client_id=excluded.livechat_client_id,
                               livechat_webhook_secret=excluded.livechat_webhook_secret,
                               requirements=excluded.requirements`);
    stmt.run(
      Number(groupId),
      brand,
      ai,
      rtpLink ? String(rtpLink).trim() : null,
      livechatLicense ? String(livechatLicense).trim() : null,
      livechatGroupId ? String(livechatGroupId).trim() : null,
      livechatWidgetSrc ? String(livechatWidgetSrc).trim() : null,
      livechatClientId ? String(livechatClientId).trim() : null,
  livechatWebhookSecret ? String(livechatWebhookSecret).trim() : null,
  requirements ? String(requirements).trim() : null
    );
    return {
      groupId: Number(groupId),
      brandName: brand,
      aiSettings: JSON.parse(ai),
      rtpLink: rtpLink ? String(rtpLink).trim() : null,
      livechatLicense: livechatLicense ? String(livechatLicense).trim() : null,
      livechatGroupId: livechatGroupId ? String(livechatGroupId).trim() : null,
      livechatWidgetSrc: livechatWidgetSrc ? String(livechatWidgetSrc).trim() : null,
      livechatClientId: livechatClientId ? String(livechatClientId).trim() : null,
  livechatWebhookSecret: livechatWebhookSecret ? String(livechatWebhookSecret).trim() : null,
  requirements: requirements ? String(requirements).trim() : null,
    };
  },
  async getGroupConfig(groupId) {
    const db = await getDb();
  const row = db.prepare('SELECT group_id, brand_name, ai_settings, rtp_link, livechat_license, livechat_group_id, livechat_widget_src, livechat_client_id, livechat_webhook_secret, requirements FROM groups_config WHERE group_id = ?').get(Number(groupId));
    if (!row) return null;
    let ai = {};
    try { ai = JSON.parse(row.ai_settings || '{}'); } catch (_) { ai = {}; }
    return {
      groupId: row.group_id,
      brandName: row.brand_name,
      aiSettings: ai,
      rtpLink: row.rtp_link || null,
      livechatLicense: row.livechat_license || null,
      livechatGroupId: row.livechat_group_id || null,
      livechatWidgetSrc: row.livechat_widget_src || null,
      livechatClientId: row.livechat_client_id || null,
  livechatWebhookSecret: row.livechat_webhook_secret || null,
  requirements: row.requirements || null
    };
  },
  // Group promotions helpers
  async listGroupPromotions(groupId) {
    const db = await getDb();
    const rows = db.prepare('SELECT * FROM group_promotions WHERE group_id = ? ORDER BY id DESC').all(Number(groupId));
    return rows.map(r => ({
      id: r.id,
      title: r.title,
      description: r.description,
      discount: r.discount,
      code: r.code,
      timeLimit: (()=>{ try { return JSON.parse(r.timeLimit || 'null'); } catch(_) { return null; } })(),
      terms: (()=>{ try { const t = JSON.parse(r.terms || 'null'); return Array.isArray(t) ? t : t ? [t] : null; } catch(_) { return null; } })(),
  howToClaim: (()=>{ try { const h = JSON.parse(r.howToClaim || 'null'); return Array.isArray(h) ? h : h ? [h] : null; } catch(_) { return null; } })(),
      eligibleItems: (()=>{ try { const v = JSON.parse(r.eligibleItems || '[]'); return Array.isArray(v) ? v : []; } catch(_) { return []; } })(),
      eligibleGames: (()=>{ try { const v = JSON.parse(r.eligibleGames || '[]'); return Array.isArray(v) ? v : []; } catch(_) { return []; } })(),
      endDate: r.endDate || null
    }));
  },
  async addGroupPromotion(groupId, promo) {
    const db = await getDb();
    const stmt = db.prepare(`INSERT INTO group_promotions
  (group_id, title, description, discount, code, timeLimit, terms, howToClaim, eligibleItems, eligibleGames, endDate)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const info = stmt.run(
      Number(groupId),
      String(promo.title),
      String(promo.description),
      promo.discount != null ? Number(promo.discount) : null,
      promo.code || null,
      promo.timeLimit ? JSON.stringify(promo.timeLimit) : null,
  promo.terms ? JSON.stringify(promo.terms) : null,
  promo.howToClaim ? JSON.stringify(promo.howToClaim) : null,
      Array.isArray(promo.eligibleItems) ? JSON.stringify(promo.eligibleItems) : '[]',
      Array.isArray(promo.eligibleGames) ? JSON.stringify(promo.eligibleGames) : '[]',
      promo.endDate || null
    );
    return { id: info.lastInsertRowid, ...promo };
  },
  async updateGroupPromotion(groupId, promoId, updates = {}) {
    const db = await getDb();
    const existing = db.prepare('SELECT * FROM group_promotions WHERE id = ? AND group_id = ?').get(Number(promoId), Number(groupId));
    if (!existing) return null;
    const merged = {
      title: updates.title != null ? String(updates.title) : existing.title,
      description: updates.description != null ? String(updates.description) : existing.description,
      discount: updates.discount != null ? Number(updates.discount) : existing.discount,
      code: updates.code != null ? updates.code : existing.code,
      timeLimit: updates.timeLimit != null ? updates.timeLimit : (existing.timeLimit ? JSON.parse(existing.timeLimit) : null),
      terms: updates.terms != null ? updates.terms : (existing.terms ? JSON.parse(existing.terms) : null),
  howToClaim: updates.howToClaim != null ? updates.howToClaim : (existing.howToClaim ? JSON.parse(existing.howToClaim) : null),
      eligibleItems: updates.eligibleItems != null ? updates.eligibleItems : (existing.eligibleItems ? JSON.parse(existing.eligibleItems) : []),
      eligibleGames: updates.eligibleGames != null ? updates.eligibleGames : (existing.eligibleGames ? JSON.parse(existing.eligibleGames) : []),
      endDate: updates.endDate != null ? updates.endDate : existing.endDate
    };
    const upd = db.prepare(`UPDATE group_promotions SET
  title = ?, description = ?, discount = ?, code = ?, timeLimit = ?, terms = ?, howToClaim = ?, eligibleItems = ?, eligibleGames = ?, endDate = ?
      WHERE id = ? AND group_id = ?`);
    upd.run(
      merged.title,
      merged.description,
      merged.discount,
      merged.code,
      merged.timeLimit ? JSON.stringify(merged.timeLimit) : null,
      merged.terms ? JSON.stringify(merged.terms) : null,
  merged.howToClaim ? JSON.stringify(merged.howToClaim) : null,
      JSON.stringify(Array.isArray(merged.eligibleItems) ? merged.eligibleItems : []),
      JSON.stringify(Array.isArray(merged.eligibleGames) ? merged.eligibleGames : []),
      merged.endDate || null,
      Number(promoId),
      Number(groupId)
    );
    return { id: Number(promoId), ...merged };
  },
  async deleteGroupPromotion(groupId, promoId) {
    const db = await getDb();
    const del = db.prepare('DELETE FROM group_promotions WHERE id = ? AND group_id = ?');
    const info = del.run(Number(promoId), Number(groupId));
    return info.changes > 0;
  },
  
  // LiveChat metadata functions
  async saveChatLivechatMetadata(chatId, metadata = {}) {
    const db = await getDb();
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO chat_livechat_metadata 
      (chat_id, livechat_group_id, livechat_license, access_group_ids, webhook_action, payload_snapshot, captured_at)
      VALUES (?, ?, ?, ?, ?, ?, strftime('%s', 'now'))
    `);
    stmt.run(
      String(chatId),
      metadata.livechat_group_id || null,
      metadata.livechat_license || null,
      metadata.access_group_ids ? JSON.stringify(metadata.access_group_ids) : null,
      metadata.webhook_action || null,
      metadata.payload_snapshot ? JSON.stringify(metadata.payload_snapshot) : null
    );
  },
  
  async getChatLivechatMetadata(chatId) {
    const db = await getDb();
    const row = db.prepare('SELECT * FROM chat_livechat_metadata WHERE chat_id = ?').get(String(chatId));
    if (!row) return null;
    return {
      ...row,
      access_group_ids: row.access_group_ids ? JSON.parse(row.access_group_ids) : null,
      payload_snapshot: row.payload_snapshot ? JSON.parse(row.payload_snapshot) : null
    };
  },

  // API Tools management functions
  async createApiTool(toolData, userId) {
    const db = await getDb();
    const stmt = db.prepare(`
      INSERT INTO api_tools (name, description, webhook_address, max_tool_calls, api_key_bearer, created_by)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const info = stmt.run(
      String(toolData.name),
      String(toolData.description),
      String(toolData.webhook_address),
      Number(toolData.max_tool_calls || 30),
      toolData.api_key_bearer || null,
      userId || null
    );
    return { id: info.lastInsertRowid, ...toolData };
  },

  async updateApiTool(toolId, updates) {
    const db = await getDb();
    const stmt = db.prepare(`
      UPDATE api_tools SET 
        name = COALESCE(?, name),
        description = COALESCE(?, description),
        webhook_address = COALESCE(?, webhook_address),
        max_tool_calls = COALESCE(?, max_tool_calls),
        api_key_bearer = COALESCE(?, api_key_bearer),
        is_active = COALESCE(?, is_active),
        updated_at = strftime('%s', 'now')
      WHERE id = ?
    `);
    const info = stmt.run(
      updates.name || null,
      updates.description || null,
      updates.webhook_address || null,
      updates.max_tool_calls || null,
      updates.api_key_bearer || null,
      updates.is_active !== undefined ? (updates.is_active ? 1 : 0) : null,
      Number(toolId)
    );
    return info.changes > 0;
  },

  async getApiTool(toolId) {
    const db = await getDb();
    const tool = db.prepare('SELECT * FROM api_tools WHERE id = ?').get(Number(toolId));
    if (!tool) return null;
    
    // Get fields and payload
    const fields = db.prepare('SELECT * FROM api_tool_fields WHERE tool_id = ? ORDER BY id').all(Number(toolId));
    const payload = db.prepare('SELECT * FROM api_tool_payload WHERE tool_id = ? ORDER BY id').all(Number(toolId));
    
    return {
      ...tool,
      is_active: Boolean(tool.is_active),
      fields: fields.map(f => ({
        ...f,
        is_required: Boolean(f.is_required),
        enum_values: f.enum_values ? JSON.parse(f.enum_values) : null
      })),
      payload: payload
    };
  },

  async getAllApiTools(activeOnly = false) {
    const db = await getDb();
    const query = activeOnly 
      ? 'SELECT * FROM api_tools WHERE is_active = 1 ORDER BY name'
      : 'SELECT * FROM api_tools ORDER BY name';
    const tools = db.prepare(query).all();
    
    return tools.map(tool => ({
      ...tool,
      is_active: Boolean(tool.is_active)
    }));
  },

  async deleteApiTool(toolId) {
    const db = await getDb();
    const stmt = db.prepare('DELETE FROM api_tools WHERE id = ?');
    const info = stmt.run(Number(toolId));
    return info.changes > 0;
  },

  async addApiToolField(toolId, fieldData) {
    const db = await getDb();
    const stmt = db.prepare(`
      INSERT INTO api_tool_fields (tool_id, field_name, field_type, description, is_required, enum_values, default_value)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const info = stmt.run(
      Number(toolId),
      String(fieldData.field_name),
      String(fieldData.field_type),
      String(fieldData.description),
      fieldData.is_required ? 1 : 0,
      fieldData.enum_values ? JSON.stringify(fieldData.enum_values) : null,
      fieldData.default_value || null
    );
    return { id: info.lastInsertRowid, ...fieldData };
  },

  async updateApiToolField(fieldId, updates) {
    const db = await getDb();
    const stmt = db.prepare(`
      UPDATE api_tool_fields SET
        field_name = COALESCE(?, field_name),
        field_type = COALESCE(?, field_type),
        description = COALESCE(?, description),
        is_required = COALESCE(?, is_required),
        enum_values = COALESCE(?, enum_values),
        default_value = COALESCE(?, default_value)
      WHERE id = ?
    `);
    const info = stmt.run(
      updates.field_name || null,
      updates.field_type || null,
      updates.description || null,
      updates.is_required !== undefined ? (updates.is_required ? 1 : 0) : null,
      updates.enum_values ? JSON.stringify(updates.enum_values) : null,
      updates.default_value !== undefined ? updates.default_value : null,
      Number(fieldId)
    );
    return info.changes > 0;
  },

  async deleteApiToolField(fieldId) {
    const db = await getDb();
    const stmt = db.prepare('DELETE FROM api_tool_fields WHERE id = ?');
    const info = stmt.run(Number(fieldId));
    return info.changes > 0;
  },

  async addApiToolPayload(toolId, payloadData) {
    const db = await getDb();
    const stmt = db.prepare(`
      INSERT INTO api_tool_payload (tool_id, key_name, value_type, static_value)
      VALUES (?, ?, ?, ?)
    `);
    const info = stmt.run(
      Number(toolId),
      String(payloadData.key_name),
      String(payloadData.value_type || 'static'),
      payloadData.static_value || null
    );
    return { id: info.lastInsertRowid, ...payloadData };
  },

  async updateApiToolPayload(payloadId, updates) {
    const db = await getDb();
    const stmt = db.prepare(`
      UPDATE api_tool_payload SET
        key_name = COALESCE(?, key_name),
        value_type = COALESCE(?, value_type),
        static_value = COALESCE(?, static_value)
      WHERE id = ?
    `);
    const info = stmt.run(
      updates.key_name || null,
      updates.value_type || null,
      updates.static_value !== undefined ? updates.static_value : null,
      Number(payloadId)
    );
    return info.changes > 0;
  },

  async deleteApiToolPayload(payloadId) {
    const db = await getDb();
    const stmt = db.prepare('DELETE FROM api_tool_payload WHERE id = ?');
    const info = stmt.run(Number(payloadId));
    return info.changes > 0;
  },

  async logApiToolUsage(toolId, chatId, inputData, responseData, success, errorMessage, executionTime) {
    const db = await getDb();
    const stmt = db.prepare(`
      INSERT INTO api_tool_usage (tool_id, chat_id, input_data, response_data, success, error_message, execution_time_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const info = stmt.run(
      Number(toolId),
      chatId || null,
      inputData ? JSON.stringify(inputData) : null,
      responseData ? JSON.stringify(responseData) : null,
      success ? 1 : 0,
      errorMessage || null,
      Number(executionTime || 0)
    );
    return { id: info.lastInsertRowid };
  },

  async getApiToolUsageStats(toolId, days = 30) {
    const db = await getDb();
    const stmt = db.prepare(`
      SELECT 
        COUNT(*) as total_calls,
        SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) as successful_calls,
        AVG(execution_time_ms) as avg_execution_time,
        MAX(timestamp) as last_used
      FROM api_tool_usage 
      WHERE tool_id = ? AND timestamp > strftime('%s', 'now', '-' || ? || ' days')
    `);
    return stmt.get(Number(toolId), Number(days));
  }
};
