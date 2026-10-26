export type VisaActionCallbackAction = 'continue' | 'stop' | 'check';

export interface ParsedVisaActionCallback {
  action: VisaActionCallbackAction;
  visaBatchApplicantId: string;
}

const PREFIX_BY_ACTION: Record<VisaActionCallbackAction, string> = {
  continue: 'visa_continue:',
  stop: 'visa_stop:',
  check: 'visa_check:',
};

// Deliberately a plain regex, not a cryptographic/anti-replay token: the
// safety this feature needs comes from re-verifying EVERYTHING server-side
// against live DB state on every callback (group ownership, operator
// permission, current applicant/queue status), not from the callback_data
// string itself being trusted or hard to forge. See
// visaStopApplicantCommand.ts / visaCheckAmbiguousCommand.ts /
// visaContinueApplicantCommand.ts -- each already re-checks group
// ownership independently of whatever this id came from.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Builds one button's callback_data -- well under Telegram's 64-byte limit for every action prefix + a UUID. */
export function buildVisaActionCallbackData(action: VisaActionCallbackAction, visaBatchApplicantId: string): string {
  return `${PREFIX_BY_ACTION[action]}${visaBatchApplicantId}`;
}

/**
 * Parses one callback_data string back into {action, visaBatchApplicantId}.
 * Returns null for anything that doesn't match a known action prefix
 * followed by a syntactically valid UUID -- malformed, truncated, or
 * forged callback_data is rejected HERE, before any DB lookup or
 * authorization check even runs. A well-formed but non-existent
 * (or no-longer-owned) id is a SEPARATE, later failure mode -- handled by
 * the command-core functions themselves (APPLICANT_NOT_FOUND), not here.
 */
export function parseVisaActionCallbackData(data: string): ParsedVisaActionCallback | null {
  for (const action of Object.keys(PREFIX_BY_ACTION) as VisaActionCallbackAction[]) {
    const prefix = PREFIX_BY_ACTION[action];
    if (data.startsWith(prefix)) {
      const visaBatchApplicantId = data.slice(prefix.length);
      if (!UUID_RE.test(visaBatchApplicantId)) {
        return null;
      }
      return { action, visaBatchApplicantId };
    }
  }
  return null;
}
