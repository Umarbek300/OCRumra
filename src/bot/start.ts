import { bot } from './bot.js';

bot.start({
  onStart: (info) => {
    console.log(`Telegram bot started as @${info.username} (long polling)`);
  },
}).catch((error: unknown) => {
  // Only `.name`/`.message` are logged here, never the error object
  // itself. grammY's own GrammyError/HttpError (node_modules/grammy/out/core/error.js)
  // never put the bot token or request URL in `.message` -- but HttpError
  // also carries the ORIGINAL caught error on its own `.error` property,
  // which can contain a token-bearing request URL (e.g. inside a Node
  // fetch failure's own `.cause`). Printing the error object directly
  // risks Node's console formatting surfacing that nested property, so
  // this never does that.
  const name = error instanceof Error ? error.name : 'UnknownError';
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[bot] bot.start() failed -- Telegram long polling could not start: ${name}: ${message}`);
  // Without this, a caught rejection here no longer crashes the process
  // via Node's default unhandled-rejection path, but the process may
  // still exit shortly after (once nothing else keeps the event loop
  // alive) -- WITH exit code 0, which a process manager (PM2/systemd)
  // reads as a clean, intentional stop, not a failure to restart/alert
  // on. Setting (not forcing via process.exit()) the exit code preserves
  // this console.error's own stdout flush while still reporting failure.
  process.exitCode = 1;
});
