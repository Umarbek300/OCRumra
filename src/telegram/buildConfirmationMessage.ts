import type { Agent } from '../db/repositories/agents.repo.js';
import type { PassportOcrResultRecord } from '../db/repositories/passportOcrResult.repo.js';
import { genderLabel } from '../sheets/buildSheetRow.js';

export interface ConfirmationMessageInput {
  ocrResult: Pick<
    PassportOcrResultRecord,
    'firstName' | 'surname' | 'passportNumber' | 'dateOfBirth' | 'passportIssueDate' | 'passportExpiryDate' | 'gender'
  >;
  agent: Pick<Agent, 'name'> | null;
  /** Already-formatted display strings from parsePackageDeposit.ts, or '' when nothing was reliably parsed from the caption. */
  packageText: string;
  depositText: string;
  balanceText: string;
  /** The 1-based row this job was written to in the Google Sheet. */
  sheetRowNumber: number;
}

/**
 * Builds the short post-sync Telegram confirmation text. Every line that
 * depends on a field the pipeline could not confidently determine is
 * rendered as an explicit "⚠️ ... topilmadi/kiritilmagan" warning instead of
 * being silently dropped or left blank — per the product requirement that a
 * missing value must never be hidden. Never invents a value: every warning
 * line corresponds 1:1 to a field that really is null/''/unresolved.
 *
 * Deliberately pure (no I/O, no Telegram/DB access) so it can be unit tested
 * without a bot token or a database.
 */
export function buildConfirmationMessage(input: ConfirmationMessageInput): string {
  const { ocrResult, agent, packageText, depositText, balanceText, sheetRowNumber } = input;

  const fullName = [ocrResult.firstName.value, ocrResult.surname.value].filter((part) => part !== null).join(' ');
  const nameLine =
    ocrResult.firstName.value !== null && ocrResult.surname.value !== null
      ? `👤 Ism Familiya: ${fullName}`
      : '⚠️ Ism yoki familiya topilmadi';

  const passportNumberLine =
    ocrResult.passportNumber.value !== null
      ? `🛂 Passport №: ${ocrResult.passportNumber.value}`
      : '⚠️ Passport raqami topilmadi';

  const dateOfBirthLine =
    ocrResult.dateOfBirth.value !== null
      ? `📅 Tug'ilgan sana: ${ocrResult.dateOfBirth.value}`
      : "⚠️ Tug'ilgan sana topilmadi";

  const issueDateLine =
    ocrResult.passportIssueDate.value !== null
      ? `📅 Berilgan sana: ${ocrResult.passportIssueDate.value}`
      : '⚠️ Berilgan sana topilmadi';

  const expiryDateLine =
    ocrResult.passportExpiryDate.value !== null
      ? `📅 Amal qilish sanasi: ${ocrResult.passportExpiryDate.value}`
      : '⚠️ Amal qilish sanasi topilmadi';

  const gender = genderLabel(ocrResult.gender);
  const genderLine = gender !== '' ? `⚧ Jins: ${gender}` : '⚠️ Jins aniqlanmadi';

  // No agent linked is an expected, normal state elsewhere in this pipeline
  // (see buildSheetRow.ts) -- not a data-quality problem, so no warning here.
  const agentLine = `👨‍💼 Agent: ${agent?.name ?? '—'}`;

  const packageLine = packageText !== '' ? `📦 Paket: ${packageText}` : '⚠️ Paket kiritilmagan';
  const depositLine = depositText !== '' ? `💵 Depozit: ${depositText}` : '⚠️ Depozit kiritilmagan';
  const balanceLine = balanceText !== '' ? `💰 Qoldiq: ${balanceText}` : '⚠️ Qoldiq hisoblanmadi';

  return [
    '✅ Passport qabul qilindi',
    '',
    nameLine,
    passportNumberLine,
    dateOfBirthLine,
    issueDateLine,
    expiryDateLine,
    genderLine,
    agentLine,
    packageLine,
    depositLine,
    balanceLine,
    '',
    `Google Sheet: qator №${sheetRowNumber}`,
  ].join('\n');
}
