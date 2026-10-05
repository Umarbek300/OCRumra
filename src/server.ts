import express from 'express';
import { getDebugSnapshot } from './admin/debug.js';
import { env } from './config/env.js';
import { getHealthStatus } from './health/health.service.js';
import { handleApplicantPhotoRequest } from './visa/applicantPhotoRoute.js';

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

// Serves one applicant's personal photo from the private GCS bucket — see
// applicantPhotoRoute.ts for the full access-control/design rationale.
// :token is the telegram_message_id, never the passport number or name.
// Wrapped (rather than passed directly) because handleApplicantPhotoRequest
// is typed against its own minimal, dependency-light request/response
// interfaces (so it's testable without real Express) — an Express
// Request/Response each structurally satisfy those interfaces, but
// Express's own overload resolution for app.get needs an explicit
// RequestHandler-shaped function here.
app.get('/visa-photos/:token', (req, res) => {
  void handleApplicantPhotoRequest(req, res);
});

app.listen(env.PORT, () => {
  console.log(`OCRumra foundation server listening on port ${env.PORT}`);
});
