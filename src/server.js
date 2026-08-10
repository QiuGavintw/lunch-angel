import dotenv from 'dotenv';

dotenv.config({ path: '.env' });
console.log('[env] ACCESS TOKEN:', process.env.LINE_CHANNEL_ACCESS_TOKEN ? '已載入' : '未載入');
console.log('[env] CHANNEL SECRET:', process.env.LINE_CHANNEL_SECRET ? '已載入' : '未載入');

import express from 'express';
import { SignatureValidationFailed } from '@line/bot-sdk';
import { registerWebhook } from './line/webhook.js';
import { startLunchScheduler, stopLunchScheduler } from './lunch/scheduler.js';

const app = express();
const port = Number(process.env.PORT) || 3000;

app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  })
);

app.get('/', (req, res) => {
  res.status(200).send('👼 午餐小天使 Backend 正常運作！');
});

app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    service: 'lunch-angel',
  });
});

registerWebhook(app);

app.use((req, res) => {
  res.status(404).json({ error: 'Not Found' });
});

app.use((err, req, res, next) => {
  if (err instanceof SignatureValidationFailed) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  console.error(`[server] unhandled error: ${err.message}`);
  return res.status(500).json({ error: 'Internal Server Error' });
});

const server = app.listen(port, () => {
  console.log(`🍱 午餐小天使 Backend 啟動於 http://localhost:${port}`);
  startLunchScheduler();
});

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[server] received ${signal}, graceful shutdown...`);
  stopLunchScheduler().finally(() => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 4000).unref();
  });
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
