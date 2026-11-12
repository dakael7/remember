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

// 3. Asistente conversacional y creación de recordatorios
const CONVERSATION_HISTORY_LIMIT = 12;

async function getConversationHistory(chatId) {
  const { data, error } = await supabase
    .from('conversation_messages')
    .select('role, content')
    .eq('chat_id', chatId)
    .order('id', { ascending: false })
    .limit(CONVERSATION_HISTORY_LIMIT);

  if (error) throw error;
  return data.reverse();
}

async function saveConversationTurn(chatId, userMessage, assistantMessage) {
  const { error: insertError } = await supabase.from('conversation_messages').insert([
    { chat_id: chatId, role: 'user', content: userMessage },
    { chat_id: chatId, role: 'assistant', content: assistantMessage }
  ]);
  if (insertError) throw insertError;

  const { data: recentMessages, error: historyError } = await supabase
    .from('conversation_messages')
    .select('id')
    .eq('chat_id', chatId)
    .order('id', { ascending: false })
    .limit(CONVERSATION_HISTORY_LIMIT);
  if (historyError) throw historyError;

  const oldestKeptId = recentMessages.at(-1)?.id;
  if (oldestKeptId !== undefined) {
    const { error: cleanupError } = await supabase
      .from('conversation_messages')
      .delete()
      .eq('chat_id', chatId)
      .lt('id', oldestKeptId);
    if (cleanupError) throw cleanupError;
  }
}

async function getAssistantResponse(chatId, userMessage, audioBuffer = null, mimeType = null) {
  const history = await getConversationHistory(chatId);
  const now = new Date().toLocaleString('es-VE', { timeZone: 'America/Caracas' });
  const contents = history.map(({ role, content }) => ({
    role: role === 'assistant' ? 'model' : 'user',
    parts: [{ text: content }]
  }));
  const currentParts = [];
  if (userMessage) currentParts.push({ text: userMessage });
  if (audioBuffer) {
    currentParts.push({
      inlineData: {
        data: audioBuffer.toString('base64'),
        mimeType
      }
    });
  }
  contents.push({ role: 'user', parts: currentParts });

  const response = await generateContentWithFallback(contents, {
    systemInstruction: `Eres Remember, un asistente personal amable que conversa en español.
La fecha y hora actual es ${now}, en la zona horaria America/Caracas (UTC-4).
Responde preguntas generales de forma directa y natural. No conviertas cada mensaje en un recordatorio.
Usa intent "chat" para conversación, saludos, preguntas y respuestas que no sean para agendar.
Usa intent "clarify" cuando el usuario quiere un recordatorio pero falta información importante, como la tarea o cuándo debe ocurrir. Haz una pregunta concreta y breve; no inventes fechas ni asumas las 09:00.
Usa intent "reminder" solo cuando la tarea y el momento estén suficientemente claros. Interpreta mensajes cortos usando el contexto reciente, especialmente cuando el usuario responde a una pregunta de aclaración. Devuelve la fecha en ISO 8601 con offset de Caracas (-04:00).
En "reply" escribe la respuesta que verá el usuario. En "task" pon una descripción clara solo para intent reminder. En "remind_at_iso" pon una fecha ISO solo para intent reminder; para los demás intents deja ambos campos vacíos. En "user_message_summary" resume fielmente el mensaje actual del usuario, transcribiendo la nota de voz si la hay.`,
    responseMimeType: 'application/json',
    responseSchema: {
      type: Type.OBJECT,
      properties: {
        intent: { type: Type.STRING, enum: ['chat', 'clarify', 'reminder'] },
        reply: { type: Type.STRING, description: 'Respuesta natural que se enviará al usuario' },
        task: { type: Type.STRING, description: 'Descripción de la tarea, solo para un recordatorio confirmado' },
        remind_at_iso: { type: Type.STRING, description: 'Fecha ISO 8601 con offset; vacío si no es un recordatorio confirmado' },
        user_message_summary: { type: Type.STRING, description: 'Resumen del mensaje del usuario para conservar el contexto conversacional' }
      },
      required: ['intent', 'reply', 'task', 'remind_at_iso', 'user_message_summary']
    }
  });

  return JSON.parse(response.text);
}

async function handleUserMessage(ctx, userMessage, audioBuffer = null, mimeType = null) {
  const result = await getAssistantResponse(ctx.chat.id, userMessage, audioBuffer, mimeType);

  if (result.intent === 'reminder') {
    const timestamp = new Date(result.remind_at_iso).getTime();
    if (!result.task || !Number.isFinite(timestamp)) {
      throw new Error('Gemini devolvió un recordatorio sin tarea o con fecha inválida.');
    }

    const { error } = await supabase.from('reminders').insert({
      chat_id: ctx.chat.id,
      task: result.task,
      remind_at: timestamp
    });
    if (error) throw error;
  }

  const savedUserMessage = audioBuffer ? result.user_message_summary : userMessage;
  await saveConversationTurn(ctx.chat.id, savedUserMessage, result.reply);
  await ctx.reply(result.reply);
}

// 4. Manejadores de mensajes en Telegram
const usageMessage = `¡Hola! Soy Remember y puedo conversar contigo y agendar recordatorios por texto o nota de voz.

Por ejemplo: "Recuérdame mañana a las 9 llamar al médico". Si falta algún dato, te preguntaré.
Usa /help para ver estas instrucciones.`;

bot.command('start', async (ctx) => {
  await ctx.reply(usageMessage);
});

bot.command('help', async (ctx) => {
  await ctx.reply(usageMessage);
});

bot.on('message:text', async (ctx) => {
  const message = ctx.message.text.trim();
  if (message.startsWith('/')) {
    return ctx.reply('No reconozco ese comando. Usa /start para ver cómo puedo ayudarte.');
  }

  await ctx.replyWithChatAction('typing');
  try {
    await handleUserMessage(ctx, message);
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
    if (!res.ok) throw new Error(`Telegram devolvió ${res.status} al descargar la nota de voz.`);
    const buffer = Buffer.from(await res.arrayBuffer());

    await handleUserMessage(ctx, '[Nota de voz]', buffer, 'audio/ogg');
  } catch (e) {
    console.error(e);
    await ctx.reply(processingErrorMessage(e, 'No pude procesar la nota de voz.'));
  }
});

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