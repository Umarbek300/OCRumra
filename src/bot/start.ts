import { bot } from './bot.js';

bot.start({
  onStart: (info) => {
    console.log(`Telegram bot started as @${info.username} (long polling)`);
  },
});
