#!/usr/bin/env bash
# TEMPORARY ONE-OFF DIAGNOSTIC (read-only) -- checks for a production
# runtime/source mismatch on the Google Sheets sync path.
#
# Never writes to Google Sheets, the database, or the filesystem (other
# than this file's own presence). Never restarts/stops/enables/reloads any
# service. Never runs `git reset`, `git clean`, `git checkout --`,
# `git commit`, or `git push` -- only read-only git commands (status, log,
# diff --stat). Never invokes Node/tsx/npm against the actual application
# code, so it cannot touch Sheets/DB even indirectly -- this is pure
# systemd/process/filesystem/git introspection.
#
# Purpose: on 2026-09-28, a read-only application-level diagnostic
# (tmp-diagnostic-sheets-technical-id-wide-scan.ts) confirmed on real
# production data that all 14 synced sheet_sync_queue jobs' Google Sheet
# rows are only 9 columns wide (header only A:L, no M at all) and that
# none of the 14 telegram_message_ids exist anywhere in the sheet. Since
# upsertRowInSheet.ts's source (as committed) unconditionally writes
# telegram_message_id into column M on every single write, this points at
# either an older/different file actually running in production, or the
# service running from a location/build other than the expected
# /opt/OCRumra TypeScript source. This script checks that directly.
set -euo pipefail

REPO=/opt/OCRumra
SERVICE=ocrumra-sheets-sync.service

echo "=== 1) systemd unit: exact ExecStart ==="
systemctl show "$SERVICE" -p ExecStart --no-pager 2>&1 || echo "(systemctl show failed or unit not found)"
echo
echo "--- full unit file (systemctl cat) ---"
systemctl cat "$SERVICE" --no-pager 2>&1 || echo "(systemctl cat failed)"

echo
echo "=== 2) running process: PID, cmdline, cwd ==="
MAIN_PID="$(systemctl show "$SERVICE" -p MainPID --value 2>/dev/null || echo '')"
echo "MainPID reported by systemd: ${MAIN_PID:-unknown}"
if [ -n "${MAIN_PID:-}" ] && [ "$MAIN_PID" != "0" ]; then
  echo "--- /proc/$MAIN_PID/cmdline (the exact command actually running) ---"
  tr '\0' ' ' < "/proc/$MAIN_PID/cmdline" 2>/dev/null && echo || echo "(pid not found in /proc -- process may have exited)"
  echo "--- /proc/$MAIN_PID/cwd (resolved working directory of the running process) ---"
  readlink -f "/proc/$MAIN_PID/cwd" 2>/dev/null || echo "(cwd not readable)"
  echo "--- open .ts/.js files this process actually has loaded (via /proc/$MAIN_PID/maps + lsof, best-effort) ---"
  (lsof -p "$MAIN_PID" 2>/dev/null | grep -E "sheets|OCRumra" || echo "(lsof unavailable or no matching open files)")
else
  echo "(no MainPID from systemd -- searching via ps instead)"
  ps aux | grep -i "sheets\|OCRumra" | grep -v grep || echo "(no matching process found via ps)"
fi

echo
echo "=== 3) source file hashes currently on disk at $REPO ==="
for f in src/sheets/upsertRowInSheet.ts src/sheets/buildSheetRow.ts src/sheets/sheetLayout.ts; do
  if [ -f "$REPO/$f" ]; then
    sha256sum "$REPO/$f"
    wc -l "$REPO/$f"
  else
    echo "$REPO/$f: FILE NOT FOUND"
  fi
  echo
done

echo "--- expected hashes (as committed at 635edd6, the production base commit) ---"
echo "upsertRowInSheet.ts expected: 17ae96adcce72046af62c9d747d25e6979d73dfba54d9fd6cdb4d22e6e6a0075 (146 lines)"
echo "buildSheetRow.ts   expected: 8e06e5d15e870aa3b0f93feeae7491c8316bd7c765bfaa2813f88e12264b52b0 (61 lines, no packageText/depositText/balanceText -- Part 2 not yet deployed)"
echo "sheetLayout.ts      expected: 9039e16e6e607fc269ea2c068dc59ec10f1b7976deec0951be913caace1c269b (65 lines)"

echo
echo "=== 4) git state for these 3 files (READ-ONLY: status/log/diff --stat only) ==="
cd "$REPO"
git status --porcelain=v1 -- src/sheets/upsertRowInSheet.ts src/sheets/buildSheetRow.ts src/sheets/sheetLayout.ts
echo "--- last commits touching these files ---"
git log --oneline -3 -- src/sheets/upsertRowInSheet.ts src/sheets/buildSheetRow.ts src/sheets/sheetLayout.ts
echo "--- uncommitted diff stat (if any) ---"
git diff --stat -- src/sheets/upsertRowInSheet.ts src/sheets/buildSheetRow.ts src/sheets/sheetLayout.ts || true
echo "--- current HEAD ---"
git rev-parse HEAD
git log --oneline -1

echo
echo "=== 5) does upsertRowInSheet.ts on disk actually write column M (telegram_message_id) and J/K/L? ==="
echo "--- occurrences of telegramMessageId ---"
grep -n "telegramMessageId" "$REPO/src/sheets/upsertRowInSheet.ts" || echo "(NO MATCH -- telegramMessageId not referenced at all in this file)"
echo "--- occurrences of TECHNICAL_ID / append / update logic ---"
grep -n "TECHNICAL_ID\|appendFullRow\|updateVisibleRow\|fullValues\|valuesFromColumnB" "$REPO/src/sheets/upsertRowInSheet.ts" || echo "(NO MATCH)"

echo
echo "=== 6) buildSheetRow.ts on disk: column count and J/K/L (package/deposit/balance) presence ==="
grep -n "packageText\|depositText\|balanceText\|SHEET_ROW_COLUMN_COUNT" "$REPO/src/sheets/buildSheetRow.ts" || echo "(NO MATCH -- no package/deposit/balance fields in this file)"
echo "--- buildSheetRow function body (full, for direct inspection) ---"
grep -n -A 25 "^export function buildSheetRow" "$REPO/src/sheets/buildSheetRow.ts" || echo "(function buildSheetRow not found by this exact signature)"

echo
echo "=== 7) is there a compiled dist/ output, or is this running TypeScript source directly? ==="
ls -la "$REPO/dist" 2>/dev/null || echo "(no dist/ directory present)"
ls -la "$REPO/dist/sheets" 2>/dev/null || echo "(no dist/sheets/ directory present)"
find "$REPO" -maxdepth 2 -iname "*.js" -path "*sheets*" 2>/dev/null | grep -v node_modules || echo "(no compiled .js sheets files found outside node_modules)"

echo
echo "=== 8) full content of upsertRowInSheet.ts on disk (for exact diffing against the expected source) ==="
cat -n "$REPO/src/sheets/upsertRowInSheet.ts"

echo
echo "=== 9) full content of buildSheetRow.ts on disk (for exact diffing against the expected source) ==="
cat -n "$REPO/src/sheets/buildSheetRow.ts"

echo
echo "=== DONE -- read-only: no writes to Sheets, DB, git, or the filesystem; no service restarted/stopped/enabled/reloaded; no git reset/clean/checkout/commit/push. ==="
