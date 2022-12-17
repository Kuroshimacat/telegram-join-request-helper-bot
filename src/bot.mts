import { Bot } from 'grammy';

import { config } from './config.mjs';

export const bot = new Bot(config.botToken);

await bot.init();
