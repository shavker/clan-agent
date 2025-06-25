// index.js
//─────────────────────────────────────────────────────────────────────────────
// 1) Загружаем .env
require('dotenv').config();

// 2) Полифилл fetch и импорты
global.fetch = (...args) =>
  import('node-fetch').then(({ default: fetch }) => fetch(...args));
const { Telegraf }   = require('telegraf');
const { exec }       = require('child_process');
const fs             = require('fs');
const path           = require('path');
const { OpenAI }     = require('openai');
const pdfParse       = require('pdf-parse');
const mammoth        = require('mammoth');

//─────────────────────────────────────────────────────────────────────────────
// 3) Проверяем обязательные переменные
if (!process.env.TELEGRAM_BOT_TOKEN) {
  console.error('❌ TELEGRAM_BOT_TOKEN не задан в .env');
  process.exit(1);
}
if (!process.env.OPENAI_API_KEY) {
  console.error('❌ OPENAI_API_KEY не задан в .env');
  process.exit(1);
}

//─────────────────────────────────────────────────────────────────────────────
// 4) Инициализируем бота и OpenAI
const bot    = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

//─────────────────────────────────────────────────────────────────────────────
// 5) Опционально: системное сообщение (для фото)
const BASE_SYSTEM = {
  role: 'system',
  content: 'Ты — помощник, описывающий содержание изображений. ' +
           'Не называй людей по именам и не разглашай личные данные.'
};

//─────────────────────────────────────────────────────────────────────────────
// 6) Работа с историей в history.json
const HISTORY_PATH = path.join(__dirname, 'history.json');
let chatHistory = {};
try {
  chatHistory = JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf-8'));
} catch {
  console.log('ℹ️ history.json не найден — будет создан при первом сообщении');
}
function addToHistory(userId, role, content) {
  if (!chatHistory[userId]) chatHistory[userId] = [];
  chatHistory[userId].push({ role, content });
  if (chatHistory[userId].length > 20)
    chatHistory[userId] = chatHistory[userId].slice(-20);
  fs.writeFileSync(HISTORY_PATH, JSON.stringify(chatHistory, null, 2));
}

//─────────────────────────────────────────────────────────────────────────────
// 7) Обработка текстовых сообщений → GPT-4
bot.on('text', async (ctx) => {
  const uid   = String(ctx.from.id);
  const text  = ctx.message.text;
  addToHistory(uid, 'user', text);

  try {
    const resp = await openai.chat.completions.create({
      model: 'gpt-4',               // ← добавили model
      messages: chatHistory[uid],
    });
    const reply = resp.choices[0].message.content;
    await ctx.reply(reply);
    addToHistory(uid, 'assistant', reply);

  } catch (err) {
    console.error('❌ GPT error:', err);
    await ctx.reply('Ошибка GPT: ' + err.message);
  }
});

//─────────────────────────────────────────────────────────────────────────────
// 8) Обработка голосовых сообщений → Whisper → GPT-4
bot.on('voice', async (ctx) => {
  if (process.env.VOICE_TO_TEXT_ENABLED !== 'true') return;
  const uid = String(ctx.from.id);

  try {
    // 8.1 Скачиваем ogg
    const fileId = ctx.message.voice.file_id;
    const link   = await ctx.telegram.getFileLink(fileId);
    const ogg    = `/tmp/${fileId}.ogg`;
    const wav    = `/tmp/${fileId}.wav`;
    const fetchRes = await fetch(link.href);
    fs.writeFileSync(ogg, Buffer.from(await fetchRes.arrayBuffer()));

    // 8.2 Конвертируем в wav
    await new Promise((resol, rej) =>
      exec(`ffmpeg -i ${ogg} -ar 16000 -ac 1 ${wav}`, (e) => e ? rej(e) : resol())
    );

    // 8.3 Транскрибируем Whisper
    const transcription = await openai.audio.transcriptions.create({
      model: 'whisper-1',           // ← добавили model
      file: fs.createReadStream(wav),
      response_format: 'text',
      language: process.env.LANGUAGE || 'ru',
    });
    const userText = transcription.trim();
    addToHistory(uid, 'user', userText);

    // 8.4 Шлём в GPT-4
    const resp = await openai.chat.completions.create({
      model: 'gpt-4',               // ← добавили model
      messages: chatHistory[uid],
    });
    const reply = resp.choices[0].message.content;
    await ctx.reply(reply);
    addToHistory(uid, 'assistant', reply);

  } catch (err) {
    console.error('❌ Voice error:', err);
    await ctx.reply('Ошибка голоса: ' + err.message);
  }
});

//─────────────────────────────────────────────────────────────────────────────
// 9) Обработка фотографий → GPT-4o Vision
bot.on('photo', async (ctx) => {
  const uid    = String(ctx.from.id);
  const photos = ctx.message.photo;
  const fileId = photos[photos.length - 1].file_id;
  const file   = await ctx.telegram.getFile(fileId);
  const url    = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;

  try {
    const resp = await openai.chat.completions.create({
      model: process.env.GPT_IMAGE_MODEL || 'gpt-4o',  // ← model тоже
      messages: [
        BASE_SYSTEM,
        {
          role: 'user',
          content: [
            { type: 'text',      text: 'Опиши, что на этом изображении:' },
            { type: 'image_url', image_url: { url } }
          ]
        }
      ],
      max_tokens: 1000,
    });
    await ctx.reply(resp.choices[0].message.content);

  } catch (err) {
    console.error('❌ Image error:', err);
    await ctx.reply('Ошибка изображения: ' + err.message);
  }
});

//─────────────────────────────────────────────────────────────────────────────
// 10) Обработка документов PDF/DOCX → GPT-4
bot.on('document', async (ctx) => {
  const uid  = String(ctx.from.id);
  const doc  = ctx.message.document;
  const link = await ctx.telegram.getFileLink(doc.file_id);
  const tmp  = `/tmp/${doc.file_id}${path.extname(doc.file_name)}`;

  try {
    // скачиваем
    const fetchRes = await fetch(link.href);
    fs.writeFileSync(tmp, Buffer.from(await fetchRes.arrayBuffer()));

    // извлекаем текст
    let text = '';
    if (doc.mime_type === 'application/pdf') {
      const data = fs.readFileSync(tmp);
      const pdf  = await pdfParse(data);
      text       = pdf.text;
    } else {
      const res = await mammoth.extractRawText({ path: tmp });
      text       = res.value;
    }

    // шлём первые 2000 символов в GPT-4
    addToHistory(uid, 'user', text.slice(0, 2000));
    const resp = await openai.chat.completions.create({
      model: 'gpt-4',               // ← model
      messages: chatHistory[uid],
    });
    const out = resp.choices[0].message.content;
    await ctx.reply(out);
    addToHistory(uid, 'assistant', out);

  } catch (err) {
    console.error('❌ Doc error:', err);
    await ctx.reply('Ошибка документа: ' + err.message);
  }
});

//─────────────────────────────────────────────────────────────────────────────
// 11) Удаляем старый webhook и запускаем polling
;(async () => {
  try {
    await bot.telegram.deleteWebhook().catch(() => {});
    console.log('ℹ️ Webhook удалён');

    await bot.launch({ dropPendingUpdates: true });
    console.log('✅ Бот запущен (Polling, pending updates сброшены)');
  } catch (err) {
    console.error('❌ Launch error:', err);
    process.exit(1);
  }
})();

// graceful shutdown
process.once('SIGINT',  () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
