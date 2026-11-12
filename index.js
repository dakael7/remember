import 'dotenv/config';
import { Bot, InlineKeyboard } from 'grammy';
import cron from 'node-cron';
import express from 'express';
import { GoogleGenAI, Type } from '@google/genai';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseUrl || !supabaseServiceRoleKey) {
  throw new Error('Faltan SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY en las variables de entorno.');
}

const supabase = createClient(supabaseUrl, supabaseServiceRoleKey);

// 1. Servidor web básico (exigido por Render para mantener la app activa)
const app = express();
const PORT = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('Remember Bot activo y operativo 🚀'));
app.listen(PORT, () => console.log(`Servidor escuchando en el puerto ${PORT}`));

// 2. Inicialización de servicios
const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN);
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
const GEMINI_FALLBACK_MODEL = process.env.GEMINI_FALLBACK_MODEL || 'gemini-3.6-flash';

function isTransientGeminiError(error) {
  const status = Number(error?.status ?? error?.error?.code);
  return [429, 500, 502, 503, 504].includes(status);
}

async function generateContentWithFallback(contents, config) {
  const models = [...new Set([GEMINI_MODEL, GEMINI_FALLBACK_MODEL])];
  let lastError;

  for (const model of models) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await ai.models.generateContent({ model, contents, config });
      } catch (error) {
        if (!isTransientGeminiError(error)) throw error;
        lastError = error;
        console.warn(`Gemini ${model} no disponible (${error.status}); intento ${attempt + 1}/2.`);
        if (attempt === 0) {
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      }
    }
  }

  throw lastError;
}

function processingErrorMessage(error, fallbackMessage) {
  if (isTransientGeminiError(error)) {
    return 'El servicio de IA está temporalmente saturado. Inténtalo de nuevo en unos segundos.';
  }
  return fallbackMessage;
}

// 3. Extracción inteligente con Gemini
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

  const response = await generateContentWithFallback(contents, {
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
    await ctx.reply(processingErrorMessage(e, 'Ocurrió un error procesando tu solicitud.'));
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
    await ctx.reply(processingErrorMessage(e, 'No pude procesar la nota de voz.'));
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

  const { error } = await supabase.from('reminders').insert({
    chat_id: ctx.chat.id,
    task: result.task,
    remind_at: timestamp
  });
  if (error) throw error;

  await ctx.reply(`✅ ${result.friendly_confirmation}`);
}

// Interacción con botones (Completar o Posponer)
bot.on('callback_query:data', async (ctx) => {
  const [action, id] = ctx.callbackQuery.data.split('_');
  if (action === 'done') {
    const { error } = await supabase
      .from('reminders')
      .update({ status: 'completed' })
      .eq('id', id);
    if (error) throw error;

    await ctx.editMessageText(`${ctx.callbackQuery.message.text}\n\n✔️ *Completado*`, { parse_mode: 'Markdown' });
  } else if (action === 'snooze') {
    const newTime = Date.now() + 15 * 60 * 1000;
    const { error } = await supabase
      .from('reminders')
      .update({ remind_at: newTime, status: 'pending' })
      .eq('id', id);
    if (error) throw error;

    await ctx.editMessageText(`${ctx.callbackQuery.message.text}\n\n💤 *Pospuesto 15 minutos*`, { parse_mode: 'Markdown' });
  }
  await ctx.answerCallbackQuery();
});

// 5. Planificador (Cron Job) que revisa cada minuto los recordatorios vencidos
cron.schedule('* * * * *', async () => {
  const now = Date.now();
  const { data: dueReminders, error } = await supabase
    .from('reminders')
    .select('id, chat_id, task')
    .eq('status', 'pending')
    .lte('remind_at', now);

  if (error) {
    console.error('Error consultando recordatorios vencidos:', error);
    return;
  }

  for (const rem of dueReminders) {
    const keyboard = new InlineKeyboard()
      .text('✅ Listo', `done_${rem.id}`)
      .text('💤 +15 min', `snooze_${rem.id}`);

    try {
      await bot.api.sendMessage(rem.chat_id, `⏰ *Recordatorio (Remember):*\n${rem.task}`, {
        parse_mode: 'Markdown',
        reply_markup: keyboard
      });

      const { error: updateError } = await supabase
        .from('reminders')
        .update({ status: 'sent' })
        .eq('id', rem.id);
      if (updateError) {
        console.error(`Error marcando el recordatorio ${rem.id} como enviado:`, updateError);
      }
    } catch (err) {
      console.error('Error enviando recordatorio:', err);
    }
  }
});

// Arrancar el bot
bot.start();
console.log('Bot Remember iniciado correctamente.');