// index.js
require('dotenv').config();
const { Telegraf } = require('telegraf');
const fs = require('fs');
const path = require('path');
const { OpenAI } = require('openai');
const fetch = require('node-fetch');    // простая синхронная require-версия

// 1) проверяем токены
if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.OPENAI_API_KEY) {
  console.error('❌ TELEGRAM_BOT_TOKEN или OPENAI_API_KEY не заданы');
  process.exit(1);
}

// 2) инициализация
const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// 3) TEXT → GPT-4
bot.on('text', async (ctx) => {
  try {
    const resp = await openai.chat.completions.create({
      model: 'gpt-4',
      messages: [{ role: 'user', content: ctx.message.text }]
    });
    await ctx.reply(resp.choices[0].message.content);
  } catch (err) {
    console.error(err);
    await ctx.reply('Ошибка GPT: ' + err.message);
  }
});

// 4) PHOTO → GPT-4o Vision
bot.on('photo', async (ctx) => {
  try {
    const photos = ctx.message.photo;
    const fid = photos[photos.length - 1].file_id;
    const f    = await ctx.telegram.getFile(fid);
    const url  = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${f.file_path}`;
    const resp = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        { role: 'user', content: [
          { type: 'text', text: 'Опиши, что на изображении:' },
          { type: 'image_url', image_url: { url } }
        ] }
      ]
    });
    await ctx.reply(resp.choices[0].message.content);
  } catch (err) {
    console.error(err);
    await ctx.reply('Ошибка изображения: ' + err.message);
  }
});

// 5) запуск polling
(async () => {
  await bot.telegram.deleteWebhook().catch(() => {});
  await bot.launch({ dropPendingUpdates: true });
  console.log('✅ Бот запущен');
})();

process.once('SIGINT', () => bot.stop());
process.once('SIGTERM', () => bot.stop());
