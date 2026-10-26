import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * Package 5.27: downloads a URL's bytes to a fresh file in a new, unique
 * OS temp directory, returning its local path. No existing helper in this
 * codebase does this (applicantPhotoUrl.ts/uploadApplicantPhoto.ts only
 * ever build URLs or upload TO storage, never fetch FROM one) -- this is
 * needed specifically because Playwright's file-upload mechanism
 * (uploadApplicantPortrait, visitSaudiPageActions.ts) requires a local
 * file path, while VisitSaudiApplicationDraft.personalPortraitUrl is a
 * plain, unauthenticated HTTP URL (applicantPortraitRoute.ts serves it
 * with no signing/credentials needed -- confirmed by reading
 * applicantPhotoUrl.ts's own doc comment).
 *
 * Uses Node's global `fetch` (no new dependency). Throws with the exact
 * HTTP status on a non-2xx response rather than silently writing an
 * error page's body as if it were image bytes.
 */
export async function downloadUrlToTempFile(url: string, filename: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`downloadUrlToTempFile: GET ${url} returned ${response.status} ${response.statusText}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  const dir = await mkdtemp(path.join(tmpdir(), 'visa-download-'));
  const filePath = path.join(dir, filename);
  await writeFile(filePath, buffer);
  return filePath;
}

/** Best-effort cleanup of a file downloadUrlToTempFile produced -- removes its WHOLE containing temp directory, never throws (a cleanup failure must never mask the caller's own real outcome). */
export async function cleanupDownloadedTempFile(filePath: string): Promise<void> {
  try {
    await rm(path.dirname(filePath), { recursive: true, force: true });
  } catch {
    // Best-effort only -- an OS temp dir left behind is not a correctness issue.
  }
}
