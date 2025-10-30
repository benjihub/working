#!/usr/bin/env node
// Utility to list users and create/reset the Owner account password
const path = require('path');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');

const dbPath = path.join(__dirname, '..', 'database', 'chats.db');
const db = new Database(dbPath);

db.pragma('journal_mode = WAL');

type = process.argv[2] || '--help';

function listUsers() {
  const rows = db.prepare('SELECT id, email, role FROM users ORDER BY id').all();
  console.log(JSON.stringify(rows, null, 2));
}

function setOwner(email, password) {
  if (!email || !password) {
    console.error('Usage: owner-reset.js --set <email> <password>');
    process.exit(1);
  }
  const row = db.prepare('SELECT id, email, role FROM users WHERE email = ?').get(String(email).trim());
  const hash = bcrypt.hashSync(String(password), 10);
  if (row) {
    db.prepare("UPDATE users SET password_hash = ?, role = 'owner' WHERE id = ?").run(hash, row.id);
    console.log(`Updated existing user ${email} -> role=owner, password reset.`);
  } else {
    const ins = db.prepare("INSERT INTO users (email, password_hash, role, permissions) VALUES (?, ?, 'owner', '{}')");
    const info = ins.run(String(email).trim(), hash);
    console.log(`Created owner user ${email} with id ${info.lastInsertRowid}.`);
  }
  listUsers();
}

switch (type) {
  case '--list':
    listUsers();
    break;
  case '--set':
    setOwner(process.argv[3], process.argv[4]);
    break;
  default:
    console.log('Usage:');
    console.log('  node scripts/owner-reset.js --list');
    console.log('  node scripts/owner-reset.js --set <email> <password>');
    process.exit(0);
}
