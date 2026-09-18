import express from 'express';
import { env } from './config/env.js';
import { getHealthStatus } from './health/health.service.js';

const app = express();

app.get('/health', async (_req, res) => {
  const result = await getHealthStatus();
  res.status(result.status === 'ok' ? 200 : 503).json(result);
});

app.listen(env.PORT, () => {
  console.log(`OCRumra foundation server listening on port ${env.PORT}`);
});
