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

// Serves one applicant's personal photo OR cropped portrait from the
// private GCS bucket — see applicantPhotoRoute.ts for the full
// access-control/design rationale. :token is the dedicated, cryptographically
// random personal_photo_token or personal_portrait_token (see
// generateApplicantPhotoToken.ts / applicantPhotoUrl.ts) — NEVER the
// telegram_message_id, passport number, or name. The SAME handler serves
// both /visa-photos/ and /visa-portraits/: handleApplicantPhotoRequest's own
// DB lookup (findPassportOcrResultByPersonalPhotoToken) already matches
// EITHER token column and picks the matching object, so a single route
// registration per URL prefix is all that's needed — the two prefixes stay
// visually distinct in the Sheet/UI even though they share one handler.
// Wrapped (rather than passed directly) because handleApplicantPhotoRequest
// is typed against its own minimal, dependency-light request/response
// interfaces (so it's testable without real Express) — an Express
// Request/Response each structurally satisfy those interfaces, but
// Express's own overload resolution for app.get needs an explicit
// RequestHandler-shaped function here.
app.get('/visa-photos/:token', (req, res) => {
  void handleApplicantPhotoRequest(req, res);
});
app.get('/visa-portraits/:token', (req, res) => {
  void handleApplicantPhotoRequest(req, res);
});

app.listen(env.PORT, () => {
  console.log(`OCRumra foundation server listening on port ${env.PORT}`);
});
