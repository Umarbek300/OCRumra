import { chromium, type Browser, type Page } from 'playwright';
import { isAnchorVisible } from './visitSaudiPageActions.js';

/**
 * ============================================================================
 * Package 5.43 -- THE one piece of Phase 2e deliberately NOT implemented.
 * ============================================================================
 *
 * A direct audit (grep -rl "chromium|playwright|BrowserContext" src/)
 * confirms no browser/session lifecycle manager and no authentication
 * mechanism exists anywhere in this codebase. This engagement's own
 * standing rule has always been "the user performs portal login
 * manually" -- there is no stored credential, no automated login flow,
 * and no existing bridge for handing a human's manually-opened, already-
 * logged-in VisitSaudi browser Page to this long-running bot process.
 * Inventing either a credential-based login or a session-handoff
 * mechanism would be exactly the kind of new, security-sensitive
 * architecture this package was explicitly told not to build
 * unilaterally.
 *
 * This default implementation ALWAYS resolves to null, by design.
 * visaStartSubmissionCommand.ts treats that as NO_ACTIVE_SESSION -- a
 * safe, clearly-worded stop, never a guess, never a fabricated session,
 * never a silent skip of the check. Deliberately kept in its own,
 * dependency-free file (no DB, no env, no browser-launch code at all) so
 * this one safety guarantee -- "the default always, unconditionally
 * returns null" -- can be verified directly, without a database.
 *
 * A real implementation (a future, separately-approved decision for how
 * an operator's live, authenticated browser session reaches this
 * process) can be injected through VisaStartSubmissionCommandDependencies's
 * own `getActiveSession` slot with no other change anywhere.
 *
 * Package 5.45 (Phase 2e / B-bosqich): the return shape grew from a bare
 * `Page | null` to VisitSaudiSessionAvailability (below) so an
 * unavailable session can carry a human-readable REASON -- not
 * configured, tunnel/Chrome unreachable, expected tab not found, or
 * several candidate tabs found -- each one is operationally different
 * and the operator needs to know WHICH one happened, never just "no
 * session". This function's own job is unchanged: always, unconditionally
 * unavailable, by design.
 */
export type VisitSaudiSessionAvailability =
  | { available: true; page: Page; release: () => Promise<void> }
  | { available: false; reason: string };

export async function getNoActiveVisitSaudiSession(): Promise<VisitSaudiSessionAvailability> {
  return { available: false, reason: 'No VisitSaudi browser session is configured for this deployment.' };
}

/**
 * ============================================================================
 * Phase 2e / A-bosqich (Package 5.44) -- the LOCAL, portal-free mechanism
 * underneath a future real getActiveSession implementation.
 * ============================================================================
 *
 * Attaches to an ALREADY-RUNNING Chromium instance over the Chrome
 * DevTools Protocol (chromium.connectOverCDP) and locates the one page
 * whose visible text matches `anchorText` (via isAnchorVisible,
 * visitSaudiPageActions.ts's own already-tested helper -- never a new
 * matching mechanism invented here). This function NEVER launches,
 * logs into, navigates, or closes/quits a browser of its own -- it only
 * CONNECTS to one that is already running and already on the expected
 * page, exactly matching every other function in this codebase's own
 * "the operator does this by hand" convention
 * (startVisitSaudiBatchSubmission.ts's own doc comment).
 *
 * This function reads NOTHING beyond visible page TEXT (via
 * isAnchorVisible, the same mechanism ensureAnchorVisible already uses
 * throughout visitSaudiPageActions.ts) -- it never calls
 * `context.cookies()`, `context.storageState()`, or any other API that
 * would expose a cookie, token, or credential, and never logs the given
 * `cdpEndpoint` or anything about the connected browser's own state.
 *
 * Deliberately NEVER guesses:
 *   - If the CDP connection itself fails (nothing listening, tunnel
 *     down, wrong endpoint, timeout) -> 'connection-failed'.
 *   - If the connection succeeds but NO open page (across every open
 *     context) matches `anchorText` -> 'page-not-found'.
 *   - If MORE THAN ONE page matches -> 'multiple-pages-found' (which one
 *     is "the real" one is never guessed -- the caller must resolve the
 *     ambiguity, e.g. by asking the operator to close extra tabs).
 *   - Only when EXACTLY ONE page matches is it ever returned.
 *
 * Resource handling: on 'connection-failed', there is nothing to release.
 * On 'page-not-found'/'multiple-pages-found', this function calls
 * `browser.close()` on the CDP-connected Browser object before
 * returning -- per Playwright's own documented behavior, for a browser
 * obtained via connectOverCDP this "clears all created contexts
 * belonging to this browser and disconnects from the browser server" (it
 * does NOT close the remote application or any of its PRE-EXISTING pages
 * -- that distinction is Playwright's own documented contract, not an
 * assumption made here), so this never risks closing the operator's own
 * browser or tabs. On 'connected', the connection is deliberately left
 * OPEN (the caller still needs the live page) -- lifecycle ownership
 * passes to the caller EXPLICITLY, via the returned `release` callback
 * (Package 5.45): the caller decides when it is done with the page (e.g.
 * after a batch submission run completes, success or failure) and calls
 * `release()` itself, which disconnects THIS connection only -- same
 * "clears created contexts, disconnects, never touches the operator's
 * own browser" guarantee as the auto-released branches above. `release`
 * never throws (best-effort, swallows its own failure) -- a failed
 * disconnect is not a reason to fail whatever already happened with the
 * page. This function itself creates no new context or page of its own
 * in the 'connected' branch either -- only the operator's own,
 * pre-existing page is ever returned.
 */
export type ConnectToVisitSaudiSessionResult =
  | { outcome: 'connected'; page: Page; release: () => Promise<void> }
  | { outcome: 'connection-failed' }
  | { outcome: 'page-not-found' }
  | { outcome: 'multiple-pages-found'; count: number };

export interface ConnectToVisitSaudiSessionOptions {
  /** Passed straight through to chromium.connectOverCDP's own timeout. Default 5000ms. */
  connectTimeoutMs?: number;
  /** Passed straight through to isAnchorVisible's own timeout, per candidate page. Default 1000ms. */
  pageTimeoutMs?: number;
}

export async function connectToVisitSaudiSessionOverCdp(
  cdpEndpoint: string,
  anchorText: string | readonly string[],
  options: ConnectToVisitSaudiSessionOptions = {},
): Promise<ConnectToVisitSaudiSessionResult> {
  let browser: Browser;
  try {
    browser = await chromium.connectOverCDP(cdpEndpoint, { timeout: options.connectTimeoutMs ?? 5000 });
  } catch {
    return { outcome: 'connection-failed' };
  }

  // Package 5.46: `anchorText` may be several candidate strings (always
  // ALREADY-CONFIRMED anchors from elsewhere in this codebase, never a
  // newly-invented one) -- a page matches if it visibly shows ANY ONE of
  // them. A single string behaves exactly as before. See
  // visaStartSubmissionCommand.ts's own doc comment for why a RESUMED run
  // needs more than one candidate (the operator's tab is no longer on the
  // dashboard by then).
  const anchorCandidates = Array.isArray(anchorText) ? anchorText : [anchorText];

  const matches: Page[] = [];
  for (const context of browser.contexts()) {
    for (const candidatePage of context.pages()) {
      let matchedThisPage = false;
      for (const candidateAnchor of anchorCandidates) {
        if (await isAnchorVisible(candidatePage, candidateAnchor, options.pageTimeoutMs ?? 1000)) {
          matchedThisPage = true;
          break;
        }
      }
      if (matchedThisPage) {
        matches.push(candidatePage);
      }
    }
  }

  if (matches.length === 1) {
    return {
      outcome: 'connected',
      page: matches[0]!,
      release: async () => {
        await browser.close().catch(() => undefined);
      },
    };
  }

  // Neither branch below hands a page back to the caller, so the
  // connection is released here -- see this function's own doc comment
  // for why this is safe against the operator's pre-existing browser/tabs.
  await browser.close().catch(() => undefined);

  if (matches.length === 0) {
    return { outcome: 'page-not-found' };
  }
  return { outcome: 'multiple-pages-found', count: matches.length };
}

/**
 * Package 5.45 (Phase 2e / B-bosqich) -- maps connectToVisitSaudiSessionOverCdp's
 * own diagnostic outcome onto VisitSaudiSessionAvailability, with a
 * specific, human-readable `reason` per unavailable case (never a single
 * generic "no session" message) -- this is the piece
 * visaStartSubmissionCommand.ts's own real `getActiveSession` dependency
 * wraps. Takes `cdpEndpoint` as a plain parameter (never reads `env`
 * itself) so this file stays fully dependency-free and directly testable
 * without a database -- the ONE env read (VISITSAUDI_CDP_ENDPOINT) lives
 * at visaStartSubmissionCommand.ts's own wiring edge, not here.
 */
export async function getVisitSaudiSessionOverCdp(
  cdpEndpoint: string | undefined,
  anchorText: string | readonly string[],
  options: ConnectToVisitSaudiSessionOptions = {},
): Promise<VisitSaudiSessionAvailability> {
  if (!cdpEndpoint) {
    return { available: false, reason: 'VISITSAUDI_CDP_ENDPOINT is not configured -- no active VisitSaudi browser session is available.' };
  }

  const result = await connectToVisitSaudiSessionOverCdp(cdpEndpoint, anchorText, options);
  const anchorDescription = Array.isArray(anchorText) ? anchorText.map((text) => `"${text}"`).join(' / ') : `"${anchorText}"`;
  switch (result.outcome) {
    case 'connected':
      return { available: true, page: result.page, release: result.release };
    case 'connection-failed':
      return {
        available: false,
        reason: 'Could not connect to the configured VisitSaudi browser session -- the tunnel or Chrome may be down.',
      };
    case 'page-not-found':
      return {
        available: false,
        reason: `Connected, but no open browser tab currently shows ${anchorDescription} -- make sure Chrome is on the right VisitSaudi page for this batch.`,
      };
    case 'multiple-pages-found':
      return {
        available: false,
        reason: `Connected, but ${result.count} open tabs currently show ${anchorDescription} -- close the extra tabs so only one remains.`,
      };
  }
}
