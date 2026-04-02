const { initDB } = require('./db');
const { startBot } = require('./bot');
const { startWeeklyReport } = require('./weeklyReport');

async function start() {
  await initDB();
  console.log('Database initialized');

  const bot = startBot();
  startWeeklyReport(bot);

  console.log('Elite Edge Bot running (standalone worker)');
}

start().catch(console.error);
