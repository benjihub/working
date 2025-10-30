// Simple helper to dump aiSettings from DB
const path = require('path');
const dbUtils = require(path.join(__dirname, '..', 'db-utils'));

async function main() {
  const arg = process.argv[2];
  if (arg) {
    const gid = Number(arg);
    if (Number.isNaN(gid)) {
      console.error('Invalid groupId:', arg);
      process.exit(2);
    }
    const cfg = await dbUtils.getGroupConfig(gid);
    console.log(JSON.stringify(cfg, null, 2));
    return;
  }
  const db = await dbUtils.getDb();
  const rows = db.prepare('SELECT group_id, brand_name, ai_settings FROM groups_config ORDER BY group_id').all();
  const out = rows.map(r => ({
    groupId: r.group_id,
    brandName: r.brand_name,
    aiSettings: (() => {
      try { return JSON.parse(r.ai_settings || '{}'); } catch (e) { return r.ai_settings || null; }
    })()
  }));
  console.log(JSON.stringify(out, null, 2));
}

main().catch(e => { console.error('Error:', e && e.message ? e.message : e); process.exit(1); });
