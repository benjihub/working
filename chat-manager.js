// chat-manager.js
// Utility to list active LiveChat conversations and send messages
require('dotenv').config({ override: true });
const axios = require('axios');
const readline = require('readline');
const { getHeaderVariants } = require('./livechatAuth');
const { sendMessage } = require('./livechatApi');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

// Ask a question and get the answer
function question(prompt) {
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => resolve(answer.trim()));
  });
}

// List active chats using LiveChat API
async function listActiveChats() {
  console.log('📋 Fetching active chats...');
  
  const headerVariants = getHeaderVariants();
  if (!headerVariants || headerVariants.length === 0) {
    throw new Error('LiveChat credentials not set (LIVECHAT_USERNAME/PASSWORD, LIVECHAT_PAT, or LIVECHAT_ACCESS_TOKEN)');
  }
  
  // Try different API versions and authentication methods
  for (const version of ['v3.6', 'v3.5']) {
    for (const headers of headerVariants) {
      try {
        const { data } = await axios.get(`https://api.livechatinc.com/${version}/agent/action/list_chats`, {
          headers: { ...headers, Accept: 'application/json' },
          params: { limit: 10, sort_order: 'desc' },
          timeout: 10000
        });
        
        if (data && Array.isArray(data.chats)) {
          console.log(`✅ Found ${data.chats.length} active chats`);
          return data.chats;
        }
      } catch (err) {
        const status = err.response?.status;
        if (status === 401 || status === 403 || status === 404) {
          // Continue to next variant
          continue;
        }
        throw err;
      }
    }
  }
  
  return [];
}

// Get active chats from local database
async function getLocalChats() {
  try {
    const { getDb } = require('./db-utils');
    const db = await getDb();
    
    // Get recent chats from the database
    const chats = db.prepare(`
      SELECT chat_id, MAX(timestamp) as last_activity 
      FROM messages 
      GROUP BY chat_id 
      ORDER BY last_activity DESC 
      LIMIT 10
    `).all();
    
    console.log(`📊 Found ${chats.length} recent chats in local database`);
    return chats.map(c => ({ id: c.chat_id, last_activity: c.last_activity }));
  } catch (err) {
    console.warn('❌ Could not fetch local chats:', err.message);
    return [];
  }
}

// Send an AI-generated message to a chat
async function sendAiMessage(chatId) {
  try {
    const { getCustomerServiceResponse } = require('./newtest3');
    
    console.log('🤖 Generating AI response...');
    const response = await getCustomerServiceResponse(chatId, "[system: generate welcome message]", `${chatId}_test_${Date.now()}`);
    
    if (!response) {
      throw new Error('AI generated an empty response');
    }
    
    console.log('📝 AI message:', response);
    const proceed = await question('Send this message? (y/n): ');
    
    if (proceed.toLowerCase() === 'y') {
      await sendMessage(chatId, response);
      console.log('✅ Message sent successfully!');
      return true;
    } else {
      console.log('⏺️ Message sending cancelled');
      return false;
    }
  } catch (err) {
    console.error('❌ Failed to generate or send AI message:', err.message);
    return false;
  }
}

// Main function
async function main() {
  try {
    console.log('🌟 LiveChat Message Manager');
    console.log('==========================');
    
    // Get both API and local chats
    let allChats = [];
    
    try {
      const apiChats = await listActiveChats();
      allChats = allChats.concat(apiChats.map(c => ({
        id: c.id,
        source: 'API',
        users: c.users?.filter(u => u.type === 'customer').map(u => u.name || 'Unknown'),
        lastActivity: new Date(c.last_event_created_at || Date.now()).toLocaleString()
      })));
    } catch (err) {
      console.warn('⚠️ Could not fetch chats from LiveChat API:', err.message);
    }
    
    try {
      const localChats = await getLocalChats();
      // Only add local chats that aren't already in the list
      for (const chat of localChats) {
        if (!allChats.some(c => c.id === chat.id)) {
          allChats.push({
            id: chat.id,
            source: 'Local DB',
            users: ['Unknown'],
            lastActivity: new Date(chat.last_activity || Date.now()).toLocaleString()
          });
        }
      }
    } catch (err) {
      console.warn('⚠️ Could not fetch local chats:', err.message);
    }
    
    if (allChats.length === 0) {
      console.log('ℹ️ No active chats found. You can manually enter a chat ID.');
      const manualChatId = await question('Enter chat ID or press Enter to exit: ');
      
      if (!manualChatId) {
        console.log('👋 Exiting...');
        return;
      }
      
      allChats.push({
        id: manualChatId,
        source: 'Manual',
        users: ['Unknown'],
        lastActivity: 'N/A'
      });
    }
    
    // Display available chats
    console.log('\n📋 Available Chats:');
    allChats.forEach((chat, index) => {
      const customerNames = chat.users && chat.users.length ? chat.users.join(', ') : 'Unknown';
      console.log(`${index + 1}. Chat ID: ${chat.id}`);
      console.log(`   Customer: ${customerNames}`);
      console.log(`   Last activity: ${chat.lastActivity}`);
      console.log(`   Source: ${chat.source}`);
      console.log('');
    });
    
    // Ask which chat to use
    const chatIndex = parseInt(await question(`Select chat (1-${allChats.length}) or enter chat ID: `), 10);
    let selectedChat;
    
    if (isNaN(chatIndex)) {
      // User entered a chat ID directly
      selectedChat = { id: chatIndex };
    } else if (chatIndex >= 1 && chatIndex <= allChats.length) {
      selectedChat = allChats[chatIndex - 1];
    } else {
      console.error('❌ Invalid selection');
      return;
    }
    
    console.log(`\n🔄 Selected chat: ${selectedChat.id}`);
    
    // Ask for message type
    console.log('\nMessage Options:');
    console.log('1. Send AI-generated message');
    console.log('2. Send custom message');
    
    const messageType = await question('Select option (1-2): ');
    
    if (messageType === '1') {
      await sendAiMessage(selectedChat.id);
    } else if (messageType === '2') {
      const messageText = await question('Enter your message: ');
      if (messageText) {
        await sendMessage(selectedChat.id, messageText);
        console.log('✅ Message sent successfully!');
      } else {
        console.log('❌ Message cannot be empty');
      }
    } else {
      console.log('❌ Invalid option');
    }
    
  } catch (err) {
    console.error('❌ Error:', err.message);
  } finally {
    rl.close();
  }
}

main();