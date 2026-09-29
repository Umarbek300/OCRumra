/**
 * Parses package/deposit amounts out of a Telegram message's own caption
 * text -- deliberately never from OCR/passport data (see buildSheetRow.ts's
 * own doc comment: Paket/Depozit were, until now, always written blank by
 * this pipeline; passport photos carry no package/deposit information at
 * all). Pure, side-effect-free, and conservative: only the small set of
 * explicitly-supported formats below are recognized; anything else (no
 * caption, an unrelated caption, or genuinely ambiguous text) resolves to
 * null rather than guessing at a number.
 *
 * Supported formats (case-insensitive, English or Uzbek keyword):
 *   "Package: Standard $1400"   -> amount=1400, currency='$'
 *   "Paket: 1400"               -> amount=1400, currency=null
 *   "Deposit: $200"             -> amount=200,  currency='$'
 *   "Depozit: $200"             -> amount=200,  currency='$'
 *   "1400 package, 200 deposit" -> package amount=1400, deposit amount=200
 *   "standard $1259 Deposit: $350" -> package amount=1259 (currency='$'),
 *                                      via the tier-word fallback below --
 *                                      real captions sometimes name a
 *                                      package tier directly, with no
 *                                      literal "package"/"paket" keyword at
 *                                      all. Only recognized when a currency
 *                                      symbol immediately follows the tier
 *                                      word (PACKAGE_TIER_WORDS below) --
 *                                      a bare number with no currency sign
 *                                      is too weak a signal on its own and
 *                                      is deliberately left unmatched
 *                                      rather than guessed at.
 */

export interface ParsedMoneyAmount {
  amount: number;
  /** '$', '€', or '£' -- verbatim as printed. Null when the caption gave no currency symbol at all (never invented). */
  currency: string | null;
}

export interface ParsedPackageDeposit {
  packageAmount: ParsedMoneyAmount | null;
  depositAmount: ParsedMoneyAmount | null;
}

const PACKAGE_KEYWORDS = 'package|paket';
const DEPOSIT_KEYWORDS = 'deposit|depozit';
/** Common package-tier names seen in real captions with no literal "package"/"paket" keyword at all -- see parseAmount's tier-word fallback. */
const PACKAGE_TIER_WORDS = 'standard|premium|vip|business|economy|econom|deluxe|basic';
const CURRENCY_SYMBOLS = String.raw`[$€£]`;
const MONEY_NUMBER = String.raw`\d[\d,]*(?:\.\d{1,2})?`;

function buildKeywordFirstPattern(keywords: string): RegExp {
  // keyword [:]  [one optional descriptor word, e.g. "Standard"]  [currency]  amount
  return new RegExp(`\\b(?:${keywords})\\b\\s*:?\\s*(?:[A-Za-z]+\\s+)?(${CURRENCY_SYMBOLS})?\\s*(${MONEY_NUMBER})`, 'i');
}

function buildValueFirstPattern(keywords: string): RegExp {
  // [currency] amount keyword, e.g. "1400 package" or "$1400 package"
  return new RegExp(`(${CURRENCY_SYMBOLS})?\\s*(${MONEY_NUMBER})\\s*(?:${keywords})\\b`, 'i');
}

/**
 * "standard $1259" with no "package"/"paket" keyword anywhere. Only matches
 * when a currency symbol directly follows the tier word -- a tier word
 * followed by a bare number with no currency sign is too weak a signal
 * (could just as easily be unrelated text) and is deliberately left
 * unmatched rather than guessed at.
 */
function buildTierWordPattern(): RegExp {
  return new RegExp(`\\b(?:${PACKAGE_TIER_WORDS})\\b\\s*:?\\s*(${CURRENCY_SYMBOLS})(${MONEY_NUMBER})`, 'i');
}

function parseAmount(text: string, keywords: string, tierWordFallback: boolean): ParsedMoneyAmount | null {
  const match =
    text.match(buildKeywordFirstPattern(keywords)) ??
    text.match(buildValueFirstPattern(keywords)) ??
    (tierWordFallback ? text.match(buildTierWordPattern()) : null);
  if (!match) return null;

  const [, currency, rawNumber] = match;
  const amount = Number(rawNumber!.replace(/,/g, ''));
  if (!Number.isFinite(amount) || amount <= 0) return null;

  return { amount, currency: currency ?? null };
}

/**
 * captionText === null (no caption at all) always yields { packageAmount:
 * null, depositAmount: null } -- never an error, never a guess.
 */
export function parsePackageAndDeposit(captionText: string | null): ParsedPackageDeposit {
  if (!captionText) {
    return { packageAmount: null, depositAmount: null };
  }
  return {
    packageAmount: parseAmount(captionText, PACKAGE_KEYWORDS, true),
    depositAmount: parseAmount(captionText, DEPOSIT_KEYWORDS, false),
  };
}

export interface CalculatedBalance {
  amount: number;
  currency: string | null;
}

/**
 * package price - deposit, but ONLY when both amounts were reliably parsed
 * AND their currencies agree (including both being null/unspecified) --
 * subtracting two amounts in different, explicitly-stated currencies would
 * be a silent unit error, not a real balance, so that case returns null
 * rather than a misleading number.
 */
export function calculateBalance(
  packageAmount: ParsedMoneyAmount | null,
  depositAmount: ParsedMoneyAmount | null,
): CalculatedBalance | null {
  if (!packageAmount || !depositAmount) return null;
  if (packageAmount.currency !== depositAmount.currency) return null;
  return { amount: packageAmount.amount - depositAmount.amount, currency: packageAmount.currency };
}

/** Renders a parsed/calculated money value for a Sheet cell -- never reformats the currency, just prefixes it back onto the number. */
export function formatMoneyForSheet(value: ParsedMoneyAmount | CalculatedBalance): string {
  const numberText = Number.isInteger(value.amount) ? String(value.amount) : value.amount.toFixed(2);
  return value.currency ? `${value.currency}${numberText}` : numberText;
}
