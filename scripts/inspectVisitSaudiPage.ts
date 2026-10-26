import { chromium, type Page } from 'playwright';
import { writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * ============================================================================
 * Package 5.35 -- READ-ONLY VisitSaudi UI-inspection tool.
 * ============================================================================
 * Run this YOURSELF, on your own computer, with real network access --
 * never in an automated/CI/sandboxed session, and never by me. It opens a
 * brand-new, empty Chromium window (NOT your regular browser, NOT
 * logged in to anything) and waits. You log in to VisitSaudi and
 * navigate to whichever page you want captured INSIDE that same window,
 * by hand -- the same way you always do. When the target page is on
 * screen, press Enter in this terminal to capture it.
 *
 * This script NEVER clicks, fills, checks, selects, or submits anything
 * on the page. It only reads what is already rendered, twice:
 *   1. A DOM pass: for every label/input/select/textarea/button/[role]
 *      element, its tag, `type`, `role`, `aria-label`, `aria-labelledby`
 *      resolved to the referenced element's own text, its associated
 *      <label> text, `placeholder`, and -- for <select> or a
 *      radio/checkbox group -- each option's own label text.
 *   2. Playwright's own built-in accessibility tree
 *      (page.accessibility.snapshot()), IF that API exists in the
 *      installed Playwright version -- checked at runtime below, never
 *      assumed. Its value/checked/pressed/selected/valuetext fields are
 *      always stripped before anything is written out.
 *
 * NEVER captured, anywhere in this file: any field's current value or
 * checked state, cookies, localStorage/sessionStorage, auth tokens, or
 * credentials -- this script never calls any API that would read them.
 * Any element whose type/name/id/label/placeholder/role looks like a
 * password or OTP/verification control is dropped from the output
 * entirely (see SENSITIVE_PATTERN below), not merely redacted.
 *
 * Usage:
 *   npx tsx scripts/inspectVisitSaudiPage.ts
 *
 * Output: ./visitsaudi-evidence.json (repository root, gitignored --
 * never committed, never pushed, never read by anything automated).
 */

const SENSITIVE_PATTERN = /password|otp|\bpin\b|verification|2fa|security\s*code/i;

function isSensitiveText(...parts: (string | null | undefined)[]): boolean {
  return parts.some((part) => typeof part === 'string' && SENSITIVE_PATTERN.test(part));
}

interface CapturedDomElement {
  tag: string;
  type: string | null;
  role: string | null;
  ariaLabel: string | null;
  ariaLabelledByText: string | null;
  associatedLabelText: string | null;
  placeholder: string | null;
  options: string[] | null;
}

/**
 * Recursively strips every field that could reveal entered content
 * (value/valuetext/checked/pressed/selected) from one Playwright
 * accessibility-tree node, and drops the node entirely if its own
 * role/name looks like a password/OTP/verification control. Never
 * returns or inspects a node's live value.
 */
function sanitizeAccessibilityNode(node: unknown): Record<string, unknown> | null {
  if (!node || typeof node !== 'object') return null;
  const n = node as Record<string, unknown>;
  if (isSensitiveText(typeof n.name === 'string' ? n.name : null, typeof n.role === 'string' ? n.role : null)) {
    return null;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- deliberately destructured out, never forwarded.
  const { value, valuetext, checked, pressed, selected, children, ...safe } = n;
  const sanitizedChildren = Array.isArray(children)
    ? (children.map(sanitizeAccessibilityNode).filter((c): c is Record<string, unknown> => c !== null))
    : undefined;

  return sanitizedChildren ? { ...safe, children: sanitizedChildren } : safe;
}

/**
 * Runs entirely inside the browser (page.evaluate) -- this project's own
 * tsconfig has no "dom" lib (see every other test file's own identical
 * comment), so DOM access here goes through `globalThis as any`, exactly
 * matching this codebase's established convention, rather than assuming
 * DOM types are available.
 */
async function captureDomElements(page: Page): Promise<CapturedDomElement[]> {
  return page.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- runs in the browser; this project's own tsconfig has no "dom" lib.
    const doc = (globalThis as any).document;
    const SENSITIVE = /password|otp|\bpin\b|verification|2fa|security\s*code/i;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    function resolveAriaLabelledBy(el: any): string | null {
      const ids = el.getAttribute('aria-labelledby');
      if (!ids) return null;
      const texts = ids
        .split(/\s+/)
        .map((id: string) => doc.getElementById(id)?.textContent?.trim() ?? '')
        .filter((t: string) => t.length > 0);
      return texts.length > 0 ? texts.join(' ') : null;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    function resolveAssociatedLabel(el: any): string | null {
      const id = el.getAttribute('id');
      if (id) {
        const forLabel = doc.querySelector(`label[for="${id}"]`);
        if (forLabel?.textContent) return forLabel.textContent.trim();
      }
      const wrapping = el.closest ? el.closest('label') : null;
      if (wrapping?.textContent) return wrapping.textContent.trim();
      return null;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    function optionsFor(el: any): string[] | null {
      if (el.tagName === 'SELECT') {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return Array.from(el.options as any[]).map((o: any) => String(o.text).trim());
      }
      const type = el.type;
      const name = el.getAttribute('name');
      if ((type === 'radio' || type === 'checkbox') && name) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const group = Array.from(doc.querySelectorAll(`input[name="${name}"]`)) as any[];
        return group
          .map((input: any) => {
            const id = input.getAttribute('id');
            const forLabel = id ? doc.querySelector(`label[for="${id}"]`) : null;
            const wrapping = input.closest ? input.closest('label') : null;
            return (forLabel ?? wrapping)?.textContent?.trim() ?? null;
          })
          .filter((t: string | null): t is string => !!t);
      }
      return null;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const elements = Array.from(doc.querySelectorAll('label, input, select, textarea, button, [role]')) as any[];
    const results: CapturedDomElement[] = [];

    for (const el of elements) {
      const type = el.getAttribute('type');
      const ariaLabel = el.getAttribute('aria-label');
      const ariaLabelledByText = resolveAriaLabelledBy(el);
      const associatedLabelText = resolveAssociatedLabel(el);
      const placeholder = el.getAttribute('placeholder');
      const role = el.getAttribute('role');
      const name = el.getAttribute('name');
      const id = el.getAttribute('id');
      const ownText = el.tagName === 'LABEL' || el.tagName === 'BUTTON' ? (el.textContent?.trim() ?? null) : null;

      if (
        SENSITIVE.test(
          [type, ariaLabel, ariaLabelledByText, associatedLabelText, placeholder, name, id, ownText]
            .filter((v): v is string => !!v)
            .join(' '),
        )
      ) {
        continue; // dropped entirely -- never written out, not even redacted.
      }

      results.push({
        tag: el.tagName,
        type: type ?? null,
        role: role ?? null,
        ariaLabel: ariaLabel ?? null,
        ariaLabelledByText,
        associatedLabelText: associatedLabelText ?? ownText,
        placeholder: placeholder ?? null,
        options: optionsFor(el),
      });
    }

    return results;
  });
}

interface Capture {
  capturedAt: string;
  pageUrl: string;
  accessibilityApiAvailable: boolean;
  domElements: CapturedDomElement[];
  accessibilityTree: Record<string, unknown> | null;
}

async function captureOnce(page: Page): Promise<Capture> {
  const domElements = await captureDomElements(page);

  // Verified against the installed Playwright version's own type
  // definitions before writing this script (node_modules/playwright-core
  // confirms `accessibility.snapshot()` exists in 1.56.1) -- still
  // checked again at runtime here rather than assumed, so this script
  // keeps working even if a future Playwright upgrade removes it.
  const accessibilityApiAvailable = typeof (page as unknown as { accessibility?: { snapshot?: unknown } }).accessibility?.snapshot === 'function';

  let accessibilityTree: Record<string, unknown> | null = null;
  if (accessibilityApiAvailable) {
    const raw = await page.accessibility.snapshot({ interestingOnly: true });
    accessibilityTree = sanitizeAccessibilityNode(raw);
  }

  return {
    capturedAt: new Date().toISOString(),
    pageUrl: page.url(),
    accessibilityApiAvailable,
    domElements,
    accessibilityTree,
  };
}

async function main(): Promise<void> {
  const outputPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'visitsaudi-evidence.json');

  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage();
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  console.log('A new, empty Chromium window just opened. It is NOT your regular browser and is not logged in to anything.');
  console.log('Log in to VisitSaudi and navigate to the page you want captured INSIDE that same window, by hand.');
  console.log('This script never clicks, fills, checks, or submits anything -- it only reads what is already on screen.\n');

  const captures: Capture[] = [];

  // eslint-disable-next-line no-constant-condition
  while (true) {
    await rl.question('Once the target page is visible, press Enter here to capture it...');
    const capture = await captureOnce(page);
    captures.push(capture);
    await writeFile(outputPath, JSON.stringify(captures, null, 2), 'utf8');
    console.log(`Captured ${capture.domElements.length} element(s) from ${capture.pageUrl}. Saved to ${outputPath}.\n`);

    const again = await rl.question('Capture another page before finishing? (y/N) ');
    if (again.trim().toLowerCase() !== 'y') break;
  }

  rl.close();
  console.log('Done. Close the browser window whenever you are ready -- nothing further runs automatically.');
  await browser.close();
}

main().catch((error) => {
  console.error('inspectVisitSaudiPage failed:', error);
  process.exitCode = 1;
});
