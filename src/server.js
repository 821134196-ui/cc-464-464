import { createApp } from './app.js';

const PORT = Number(process.env.TD_PORT || 5173);
const RESET = process.env.TD_RESET === '1' || process.argv.includes('--reset');

const app = await createApp({
  reset: RESET,
  scheduler: process.env.TD_SCHEDULER !== '0',
});

await app.listen(PORT);
console.log('🚗 试驾车预约与车况交接平台已启动');
console.log(`   本地地址:   http://localhost:${PORT}`);
console.log(`   数据库:     ${process.env.TD_DB_PATH || 'data/app.db (SQLite)'}`);
console.log(`   照片目录:   ${process.env.TD_PHOTO_DIR || 'data/photos/'}`);
console.log('   已内置冲突、迟到、低油、超时、事故、留观与清洁样例（每 10 秒执行一次定时任务）');

const shutdown = () => { app.close(); process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
