(async () => {
  try {
    const aiClient = require('./utils/aiClient');
    const payload = {
      chat_id: 'T41VNV7UED',
      thread_id: 'T41WTLFCIQ',
      event: {
        id: 'T41WTLFCIQ_7',
        custom_id: 'u5a24012q9',
        visibility: 'all',
        created_at: '2025-10-29T17:18:40.604000Z',
        author_id: '09d507ef-48e3-4694-9e2a-ee33a53815dc',
        properties: { source: { type: 'chat', client_id: null } },
        type: 'message',
        text: 'Which website is this'
      }
    };

  console.log('\n=== Calling aiClient.mapTicket with sample payload ===\n');
  console.log('aiClient.isEnabled() =', aiClient.isEnabled());
  console.log('ENV USE_OPENAI, OPENAI_API_KEY present:', process.env.USE_OPENAI, !!process.env.OPENAI_API_KEY);
  const result = await aiClient.mapTicket(payload);
    console.log('\n=== RESULT ===');
    console.log(JSON.stringify(result, null, 2));
    process.exit(0);
  } catch (e) {
    console.error('Error running mapTicket test:', e && e.message ? e.message : e);
    process.exit(2);
  }
})();
