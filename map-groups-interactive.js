// Interactive script to map groups to LiveChat Group IDs
const Database = require('better-sqlite3');
const readline = require('readline');
const path = require('path');

const dbPath = path.join(__dirname, 'database', 'chats.db');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function question(query) {
  return new Promise(resolve => rl.question(query, resolve));
}

async function main() {
  let db;
  
  try {
    db = new Database(dbPath);
    
    console.log('\n🔧 ===== GROUP MAPPING HELPER =====\n');
    console.log('This tool will help you configure LiveChat Group IDs for your groups.\n');
    
    // Get unmapped groups
    const groups = db.prepare(`
      SELECT 
        g.id,
        g.name,
        gc.brand_name,
        gc.livechat_group_id,
        gc.livechat_license,
        gc.livechat_client_id
      FROM groups g
      LEFT JOIN groups_config gc ON gc.group_id = g.id
      WHERE gc.livechat_group_id IS NULL OR gc.livechat_group_id = ''
      ORDER BY g.id
    `).all();
    
    if (groups.length === 0) {
      console.log('✅ All groups are already configured!');
      console.log('   Run "node check-group-mapping.js" to see current configuration.\n');
      rl.close();
      if (db) db.close();
      return;
    }
    
    console.log(`Found ${groups.length} group(s) that need configuration:\n`);
    groups.forEach((g, i) => {
      console.log(`${i + 1}. Group ${g.id} "${g.name}"`);
    });
    
    console.log('\n💡 TIP: Go to https://my.livechatinc.com → Settings → Groups');
    console.log('         Note the numeric ID for each LiveChat group (0, 1, 42, etc.)\n');
    
    const shouldContinue = await question('Would you like to configure these groups now? (y/n): ');
    
    if (shouldContinue.toLowerCase() !== 'y') {
      console.log('\n✋ Configuration cancelled. Run this script again when ready.\n');
      rl.close();
      if (db) db.close();
      return;
    }
    
    // Default values (can be customized)
    const defaultLicense = '7100151';
    const defaultClientId = '04a41b66b3b44ea01c47784051ed8081';
    const defaultWidgetSrc = '//cdn.livechatinc.com/tracking.js';
    
    console.log('\n📝 Default values:');
    console.log(`   LiveChat License: ${defaultLicense}`);
    console.log(`   LiveChat Client ID: ${defaultClientId}`);
    console.log(`   Widget Source: ${defaultWidgetSrc}\n`);
    
    const useDefaults = await question('Use these defaults for all groups? (y/n): ');
    
    let license = defaultLicense;
    let clientId = defaultClientId;
    
    if (useDefaults.toLowerCase() !== 'y') {
      license = await question('Enter LiveChat License: ');
      clientId = await question('Enter LiveChat Client ID: ');
    }
    
    console.log('\n');
    
    // Configure each group
    for (const group of groups) {
      console.log(`\n🎯 Configuring Group ${group.id} "${group.name}"`);
      console.log('─'.repeat(50));
      
      const lcGroupId = await question(`Enter LiveChat Group ID for "${group.name}": `);
      
      if (!lcGroupId || lcGroupId.trim() === '') {
        console.log('⏭️  Skipping (no ID provided)');
        continue;
      }
      
      const brandName = group.name; // Use group name as brand name
      
      try {
        // Insert or update configuration
        db.prepare(`
          INSERT INTO groups_config (
            group_id, 
            brand_name, 
            livechat_group_id, 
            livechat_license, 
            livechat_client_id,
            livechat_widget_src,
            ai_settings,
            rtp_link
          ) VALUES (?, ?, ?, ?, ?, ?, '{}', NULL)
          ON CONFLICT(group_id) DO UPDATE SET
            brand_name = excluded.brand_name,
            livechat_group_id = excluded.livechat_group_id,
            livechat_license = excluded.livechat_license,
            livechat_client_id = excluded.livechat_client_id,
            livechat_widget_src = excluded.livechat_widget_src
        `).run(
          group.id,
          brandName,
          lcGroupId.trim(),
          license.trim(),
          clientId.trim(),
          defaultWidgetSrc
        );
        
        console.log(`✅ Configured! LiveChat Group ${lcGroupId} → Internal Group ${group.id}`);
        
      } catch (error) {
        console.log(`❌ Error: ${error.message}`);
      }
    }
    
    console.log('\n\n✨ ===== CONFIGURATION COMPLETE =====\n');
    console.log('Next steps:');
    console.log('1. Run "node check-group-mapping.js" to verify configuration');
    console.log('2. Restart your server if it\'s running');
    console.log('3. Test with real chats to verify mapping works\n');
    
  } catch (error) {
    console.error('\n❌ Error:', error.message);
    console.error('\nMake sure the database exists and is accessible.\n');
  } finally {
    rl.close();
    if (db) db.close();
  }
}

main().catch(console.error);
