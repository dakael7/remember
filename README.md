# Remember Bot

## Configuración en Render

Configura estas variables de entorno en el servicio:

- `TELEGRAM_BOT_TOKEN`: token del bot de Telegram.
- `GEMINI_API_KEY`: clave de Gemini.
- `SUPABASE_URL`: URL del proyecto Supabase.
- `SUPABASE_SERVICE_ROLE_KEY`: clave secreta de servidor de Supabase. Guárdala solo en las variables de entorno de Render; nunca la publiques ni la pongas en código.
- `GEMINI_MODEL` (opcional): modelo principal; por defecto, `gemini-3.8-flash`.
- `GEMINI_FALLBACK_MODEL` (opcional): modelo alternativo; por defecto, `gemini-3.6-flash`.

Ante errores temporales de Gemini (como `503 UNAVAILABLE`), el bot reintenta la solicitud y luego prueba el modelo alternativo. Si ambos modelos siguen indisponibles, Telegram informa que el servicio está temporalmente saturado para que se pueda volver a intentar.

El bot también puede responder preguntas generales y mantener el contexto de la conversación para hacer preguntas aclaratorias antes de guardar recordatorios. Conserva como máximo los 12 mensajes más recientes de cada chat en Supabase.

## Configuración de Supabase

1. En el SQL Editor del proyecto Supabase, ejecuta el contenido actualizado de [`supabase/schema.sql`](./supabase/schema.sql) para crear las tablas e índices de recordatorios y conversación.
2. En la configuración del servicio de Render, añade `SUPABASE_URL` y `SUPABASE_SERVICE_ROLE_KEY`. La clave de servicio solo debe existir en el backend de Render: no uses una clave `anon`/publishable y no la compartas en el chat.
3. Despliega de nuevo el servicio. El historial de conversación habilita respuestas contextuales y aclaraciones de seguimiento.
