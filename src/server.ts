import express from 'express';
import { getDebugSnapshot } from './admin/debug.js';
import { env } from './config/env.js';
import { getHealthStatus } from './health/health.service.js';

const app = express();

app.get('/health', async (_req, res) => {
  const result = await getHealthStatus();
  res.status(result.status === 'ok' ? 200 : 503).json(result);
});

// Unauthenticated debug view of Telegram group/agent linkage — foundation
// stage only, see Stage 2 approval notes before this is exposed publicly.
app.get('/admin/debug', async (_req, res) => {
  const snapshot = await getDebugSnapshot();
  res.json(snapshot);
});

app.listen(env.PORT, () => {
  console.log(`OCRumra foundation server listening on port ${env.PORT}`);
});
