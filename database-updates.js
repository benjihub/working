/**
 * Database-Based Real-time Updates
 * Most reliable approach - no WebSockets, no complex networking
 * Just check the database for new records
 */

const { getDb } = require('./db-utils');

class DatabaseUpdater {
  constructor(interval = 2000) {
    this.interval = interval;
    this.isRunning = false;
    this.lastCheck = Date.now();
    this.callbacks = {};
  }
  
  // Start monitoring database for changes
  start() {
    if (this.isRunning) return;
    
    this.isRunning = true;
    console.log(`🗄️ Started database updater (${this.interval}ms intervals)`);
    
    this.checkDatabase();
    this.intervalId = setInterval(() => {
      this.checkDatabase();
    }, this.interval);
  }
  
  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.isRunning = false;
    console.log('⏹️ Stopped database updater');
  }
  
  // Register callback for updates
  on(eventType, callback) {
    if (!this.callbacks[eventType]) {
      this.callbacks[eventType] = [];
    }
    this.callbacks[eventType].push(callback);
  }
  
  // Check database for new records
  async checkDatabase() {
    try {
      const db = await getDb();
      const now = Date.now();
      
      // Check for new messages
      await this.checkNewMessages(db);
      
      // Check for chat status changes
      await this.checkStatusChanges(db);
      
      // Check for support tickets
      await this.checkSupportTickets(db);
      
      this.lastCheck = now;
      
    } catch (error) {
      console.error('❌ Database check failed:', error.message);
    }
  }
  
  // Check for new messages since last check
  async checkNewMessages(db) {
    try {
      const newMessages = db.prepare(`
        SELECT * FROM messages 
        WHERE created_at > datetime(?, 'unixepoch', 'localtime')
        ORDER BY created_at DESC
        LIMIT 20
      `).all(this.lastCheck / 1000);
      
      if (newMessages.length > 0) {
        console.log(`💬 Found ${newMessages.length} new messages`);
        
        newMessages.forEach(msg => {
          this.triggerCallback('new_message', {
            id: msg.id,
            chatId: msg.chat_id,
            role: msg.role,
            content: msg.content,
            timestamp: msg.created_at
          });
        });
      }
    } catch (error) {
      console.error('Error checking messages:', error.message);
    }
  }
  
  // Check for chat status changes
  async checkStatusChanges(db) {
    try {
      // Check the chat_status table for recent changes
      const statusChanges = db.prepare(`
        SELECT * FROM chat_status 
        WHERE updated_at > datetime(?, 'unixepoch', 'localtime')
        ORDER BY updated_at DESC
      `).all(this.lastCheck / 1000);
      
      if (statusChanges.length > 0) {
        console.log(`📊 Found ${statusChanges.length} status changes`);
        
        statusChanges.forEach(change => {
          this.triggerCallback('status_change', {
            chatId: change.chat_id,
            status: change.status,
            timestamp: change.updated_at
          });
        });
      }
    } catch (error) {
      console.error('Error checking status changes:', error.message);
    }
  }
  
  // Check for new support tickets/escalations
  async checkSupportTickets(db) {
    try {
      // This would check your support ping system
      // Adapt based on your support ticket storage
      
      // Example: Check for recent escalations in messages
      const escalations = db.prepare(`
        SELECT * FROM messages 
        WHERE content LIKE '%escalat%' OR content LIKE '%transfer%' OR content LIKE '%support%'
        AND created_at > datetime(?, 'unixepoch', 'localtime')
        AND role = 'assistant'
        ORDER BY created_at DESC
        LIMIT 10
      `).all(this.lastCheck / 1000);
      
      if (escalations.length > 0) {
        console.log(`🆘 Found ${escalations.length} potential escalations`);
        
        escalations.forEach(escalation => {
          this.triggerCallback('support_escalation', {
            chatId: escalation.chat_id,
            content: escalation.content,
            timestamp: escalation.created_at
          });
        });
      }
    } catch (error) {
      console.error('Error checking support tickets:', error.message);
    }
  }
  
  // Trigger callbacks
  triggerCallback(eventType, data) {
    // Specific callbacks
    if (this.callbacks[eventType]) {
      this.callbacks[eventType].forEach(callback => {
        try {
          callback(data);
        } catch (error) {
          console.error(`Error in ${eventType} callback:`, error);
        }
      });
    }
    
    // General callbacks
    if (this.callbacks['*']) {
      this.callbacks['*'].forEach(callback => {
        try {
          callback({ type: eventType, data });
        } catch (error) {
          console.error('Error in general callback:', error);
        }
      });
    }
  }
}

// Simple endpoint to get database updates
function setupDatabaseUpdates(app) {
  app.get('/api/db-updates', async (req, res) => {
    try {
      const since = parseInt(req.query.since) || (Date.now() - 30000); // Default: last 30 seconds
      const db = await getDb();
      
      // Get recent messages
      const messages = db.prepare(`
        SELECT m.*, 'message' as type FROM messages m
        WHERE m.created_at > datetime(?, 'unixepoch', 'localtime')
        ORDER BY m.created_at DESC
        LIMIT 20
      `).all(since / 1000);
      
      // Get recent status changes
      const statusChanges = db.prepare(`
        SELECT cs.*, 'status_change' as type FROM chat_status cs
        WHERE cs.updated_at > datetime(?, 'unixepoch', 'localtime')
        ORDER BY cs.updated_at DESC
        LIMIT 10
      `).all(since / 1000);
      
      const updates = [
        ...messages.map(m => ({
          type: 'new_message',
          data: {
            id: m.id,
            chatId: m.chat_id,
            role: m.role,
            content: m.content,
            timestamp: m.created_at
          },
          timestamp: new Date(m.created_at).getTime()
        })),
        ...statusChanges.map(s => ({
          type: 'status_change',
          data: {
            chatId: s.chat_id,
            status: s.status,
            timestamp: s.updated_at
          },
          timestamp: new Date(s.updated_at).getTime()
        }))
      ].sort((a, b) => b.timestamp - a.timestamp);
      
      res.json({
        success: true,
        updates,
        timestamp: Date.now(),
        count: updates.length
      });
      
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  });
}

module.exports = {
  DatabaseUpdater,
  setupDatabaseUpdates
};