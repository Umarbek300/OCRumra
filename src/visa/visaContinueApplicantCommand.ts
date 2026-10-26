import { findGroupByTelegramChatId } from '../db/repositories/groups.repo.js';
import { findApplicantGroupId } from '../db/repositories/visaSubmissionQueue.repo.js';

export type VisaContinueApplicantCommandOutcome =
  | { kind: 'UNAUTHORIZED' }
  | { kind: 'GROUP_NOT_FOUND' }
  /** Same never-leaking outcome as visaStopApplicantCommand.ts: unknown id or a different group's applicant. */
  | { kind: 'APPLICANT_NOT_FOUND' }
  /** The ONLY possible non-error outcome today -- see this module's own doc comment. */
  | { kind: 'NOT_READY' };

export interface VisaContinueApplicantCommandInput {
  telegramChatId: number;
  authorStatus: string;
  visaBatchApplicantId: string;
}

export interface VisaContinueApplicantCommandDependencies {
  findGroup: typeof findGroupByTelegramChatId;
  findApplicantGroupId: typeof findApplicantGroupId;
}

const defaultDependencies: VisaContinueApplicantCommandDependencies = {
  findGroup: findGroupByTelegramChatId,
  findApplicantGroupId,
};

/**
 * The "DAVOM ETISH" (CONTINUE) operator action's command-core. There is
 * NO portal-automation implementation yet (visitSaudiAutomation.ts is a
 * CONTRACT ONLY -- no Playwright, no browser, no network call to
 * visa.visitsaudi.com anywhere in this codebase). This function therefore
 * NEVER proceeds past its own authorization/ownership checks: it always
 * reports NOT_READY, deliberately and permanently, until a real
 * portal-automation step exists to call instead -- that is a SEPARATE,
 * future, not-yet-authorized change, never silently added here.
 *
 * Still performs the SAME authorization + group-ownership re-verification
 * as visaStopApplicantCommand.ts / visaCheckAmbiguousCommand.ts (never
 * trusting a caller-supplied applicant id without checking it belongs to
 * the requesting operator's own group) -- so pressing this button is
 * exactly as safely checked as the other two, even though its only
 * possible successful outcome today is "not ready".
 */
export async function visaContinueApplicantCommand(
  input: VisaContinueApplicantCommandInput,
  deps: VisaContinueApplicantCommandDependencies = defaultDependencies,
): Promise<VisaContinueApplicantCommandOutcome> {
  if (input.authorStatus !== 'creator' && input.authorStatus !== 'administrator') {
    return { kind: 'UNAUTHORIZED' };
  }

  const group = await deps.findGroup(input.telegramChatId);
  if (!group) {
    return { kind: 'GROUP_NOT_FOUND' };
  }

  const applicantGroupId = await deps.findApplicantGroupId(input.visaBatchApplicantId);
  if (!applicantGroupId || applicantGroupId !== group.id) {
    return { kind: 'APPLICANT_NOT_FOUND' };
  }

  return { kind: 'NOT_READY' };
}
