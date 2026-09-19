import { spawn } from 'node:child_process';

const MRZ_CHAR_WHITELIST = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789<';
const MAX_STDERR_LENGTH = 300;

export interface RunTesseractOptions {
  /** Injectable for tests — defaults to the real `tesseract` binary on PATH. */
  binaryPath?: string;
}

/**
 * Runs the local Tesseract OCR binary against an image buffer entirely via
 * stdin/stdout pipes — no temp file, nothing written to disk, nothing
 * leaves this process. `--psm 6` (uniform block of text) plus a whitelist
 * restricted to the MRZ alphabet measurably improves recognition of MRZ's
 * monospace OCR-B-style text with only the standard `eng` trained data.
 */
export function runTesseractOcr(imageBuffer: Buffer, options: RunTesseractOptions = {}): Promise<string> {
  const binaryPath = options.binaryPath ?? 'tesseract';

  return new Promise((resolve, reject) => {
    const child = spawn(binaryPath, ['-', 'stdout', '--psm', '6', '-c', `tessedit_char_whitelist=${MRZ_CHAR_WHITELIST}`], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

    child.on('error', (error) => {
      reject(new Error(`Failed to start local OCR (tesseract): ${error.message}`));
    });

    child.on('close', (code) => {
      if (code !== 0) {
        // tesseract's own stderr only ever describes the binary/engine
        // state (missing trained data, bad image format, etc.) — never
        // document content — but bounded anyway as defense in depth.
        const stderr = Buffer.concat(stderrChunks).toString('utf8').trim().slice(0, MAX_STDERR_LENGTH);
        reject(new Error(`Local OCR (tesseract) exited with code ${code}${stderr ? `: ${stderr}` : ''}`));
        return;
      }
      resolve(Buffer.concat(stdoutChunks).toString('utf8'));
    });

    child.stdin.on('error', () => {
      // Handled via the 'close'/'error' events above; swallow here so an
      // EPIPE from an already-dead process doesn't crash as an unhandled
      // stream error.
    });
    child.stdin.end(imageBuffer);
  });
}
