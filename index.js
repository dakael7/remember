import 'dotenv/config';
import { Bot, InlineKeyboard } from 'grammy';
import cron from 'node-cron';
import Database from 'better-sqlite3';
import express from 'express';
import { GoogleGenAI, Type } from '@google/genai';

// 1. Servidor web básico (exigido por Render para mantener la app activa)
const app = express();
const PORT = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('Remember Bot activo y operativo 🚀'));
app.listen(PORT, () => console.log(`Servidor escuchando en el puerto ${PORT}`));

// 2. Inicialización de servicios
const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN);
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const db = new Database('reminders.db');

// Crear tabla si no existe
db.exec(`
  CREATE TABLE IF NOT EXISTS reminders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id INTEGER NOT NULL,
    task TEXT NOT NULL,
    remind_at INTEGER NOT NULL,
    status TEXT DEFAULT 'pending'
  )
`);

// 3. Extracción inteligente con Gemini 2.5 Flash
async function parseReminder(userInput, audioBuffer = null, mimeType = null) {
  const now = new Date().toLocaleString('es-VE', { timeZone: 'America/Caracas' });

  const prompt = `
    Eres el asistente personal de gestión de tareas para "Remember".
    La fecha y hora actual es: ${now} (Zona horaria: America/Caracas, UTC-4).
    Analiza el mensaje y extrae la tarea y la fecha/hora exacta en formato ISO.
    Si no especifica hora, asume las 09:00 AM.
    Si no es un recordatorio, marca is_reminder como false.
  `;

  const contents = [prompt];
  if (userInput) contents.push(userInput);
  if (audioBuffer) {
    contents.push({
      inlineData: {
        data: audioBuffer.toString('base64'),
        mimeType: mimeType
      }
    });
  }

  const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: contents,
    config: {
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          is_reminder: { type: Type.BOOLEAN },
          task: { type: Type.STRING, description: 'Descripción clara de la tarea' },
          remind_at_iso: { type: Type.STRING, description: 'Fecha y hora en ISO 8601 con offset, ej: 2026-11-13T16:00:00-04:00' },
          friendly_confirmation: { type: Type.STRING, description: 'Respuesta corta confirmando el recordatorio' }
        },
        required: ['is_reminder', 'task', 'remind_at_iso', 'friendly_confirmation']
      }
    }
  });

  return JSON.parse(response.text);
}

// 4. Manejadores de mensajes en Telegram
bot.on('message:text', async (ctx) => {
  await ctx.replyWithChatAction('typing');
  try {
    const result = await parseReminder(ctx.message.text);
    await handleAIResponse(ctx, result);
  } catch (e) {
    console.error(e);
    await ctx.reply('Ocurrió un error procesando tu solicitud.');
  }
});

bot.on('message:voice', async (ctx) => {
  await ctx.replyWithChatAction('typing');
  try {
    const file = await ctx.getFile();
    const fileUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
    const res = await fetch(fileUrl);
    const arrayBuffer = await res.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    const result = await parseReminder(null, buffer, 'audio/ogg');
    await handleAIResponse(ctx, result);
  } catch (e) {
    console.error(e);
    await ctx.reply('No pude procesar la nota de voz.');
  }
});

async function handleAIResponse(ctx, result) {
  if (!result.is_reminder) {
    return ctx.reply('Dime qué tarea deseas agendar y cuándo.');
  }

  const timestamp = new Date(result.remind_at_iso).getTime();
  if (isNaN(timestamp)) {
    return ctx.reply('No entendí bien la fecha. ¿Podrías indicarla de nuevo?');
  }

  db.prepare('INSERT INTO reminders (chat_id, task, remind_at) VALUES (?, ?, ?)').run(ctx.chat.id, result.task, timestamp);
  await ctx.reply(`✅ ${result.friendly_confirmation}`);
}

// Interacción con botones (Completar o Posponer)
bot.on('callback_query:data', async (ctx) => {
  const [action, id] = ctx.callbackQuery.data.split('_');
  if (action === 'done') {
    db.prepare("UPDATE reminders SET status = 'completed' WHERE id = ?").run(id);
    await ctx.editMessageText(`${ctx.callbackQuery.message.text}\n\n✔️ *Completado*`, { parse_mode: 'Markdown' });
  } else if (action === 'snooze') {
    const newTime = Date.now() + 15 * 60 * 1000;
    db.prepare("UPDATE reminders SET remind_at = ?, status = 'pending' WHERE id = ?").run(newTime, id);
    await ctx.editMessageText(`${ctx.callbackQuery.message.text}\n\n💤 *Pospuesto 15 minutos*`, { parse_mode: 'Markdown' });
  }
  await ctx.answerCallbackQuery();
});

// 5. Planificador (Cron Job) que revisa cada minuto los recordatorios vencidos
cron.schedule('* * * * *', async () => {
  const now = Date.now();
  const dueReminders = db.prepare("SELECT * FROM reminders WHERE status = 'pending' AND remind_at <= ?").all(now);

  for (const rem of dueReminders) {
    const keyboard = new InlineKeyboard()
      .text('✅ Listo', `done_${rem.id}`)
      .text('💤 +15 min', `snooze_${rem.id}`);

    try {
      await bot.api.sendMessage(rem.chat_id, `⏰ *Recordatorio (Remember):*\n${rem.task}`, {
        parse_mode: 'Markdown',
        reply_markup: keyboard
      });
      db.prepare("UPDATE reminders SET status = 'sent' WHERE id = ?").run(rem.id);
    } catch (err) {
      console.error('Error enviando recordatorio:', err);
    }
  }
});

// Arrancar el bot
bot.start();
console.log('Bot Remember iniciado correctamente.');