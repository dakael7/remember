# Remember Bot

## Configuración en Render

Configura estas variables de entorno en el servicio:

- `TELEGRAM_BOT_TOKEN`: token del bot de Telegram.
- `GEMINI_API_KEY`: clave de Gemini.
- `SUPABASE_URL`: URL del proyecto Supabase.
- `SUPABASE_SERVICE_ROLE_KEY`: clave secreta de servidor de Supabase. Guárdala solo en las variables de entorno de Render; nunca la publiques ni la pongas en código.
- `TELEGRAM_MODE=webhook`: recomendado para Render. Render define automáticamente `RENDER_EXTERNAL_URL`.
- `TELEGRAM_WEBHOOK_SECRET`: secreto aleatorio para validar que los webhooks vienen de Telegram.
- `GEMINI_MODEL` (opcional): modelo principal; por defecto, `gemini-3.5-flash-lite` para respuestas más rápidas.
- `GEMINI_FALLBACK_MODEL` (opcional): modelo alternativo; por defecto, `gemini-3.6-flash`.

En Render, configura `TELEGRAM_MODE` como `webhook` y crea `TELEGRAM_WEBHOOK_SECRET` con un valor aleatorio hexadecimal (puedes generarlo localmente con `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`). Añade el resultado directamente en Render; no lo compartas ni lo subas al repositorio. El bot registrará su URL automáticamente y los logs deben mostrar `Webhook de Telegram activo`. En desarrollo local, el modo predeterminado es long polling.

El webhook evita depender de una conexión saliente permanente de long polling y puede despertar el servicio gratuito al llegar un mensaje. Render puede tardar alrededor de un minuto en iniciar un servicio dormido; Telegram reintentará entregas si el endpoint aún no responde. Para disponibilidad inmediata se requiere una instancia de Render siempre activa.

Las solicitudes a Gemini tienen un tiempo límite de 15 segundos y no hacen reintentos automáticos ocultos; ante un error temporal (como `503 UNAVAILABLE`), se prueba una vez el modelo alternativo. Los saludos simples se responden sin esperar a Gemini. Si ambos modelos siguen indisponibles, Telegram informa que el servicio está temporalmente saturado para que se pueda volver a intentar. Los recordatorios vencidos se revisan cada 10 segundos.

El bot también puede responder preguntas generales y mantener el contexto de la conversación para hacer preguntas aclaratorias antes de guardar recordatorios. Conserva como máximo los 12 mensajes más recientes de cada chat en Supabase.

## Gestión personal de documentos y finanzas

- Envía un PDF o una imagen JPG, PNG o WEBP (máximo 20 MB). Remember extrae título, tipo, contraparte, monto/moneda y fechas visibles; muestra los datos y solicita confirmación antes de activar el registro.
- Los documentos se guardan en el bucket privado `remember-documents`. Para analizarlos, el archivo se envía a Gemini; no subas documentos que no quieras compartir con ese proveedor.
- Registra compromisos con mensajes como “Tengo que cobrarle a Ana 300 USD el viernes” o “Debo pagar 120 EUR de internet”. Remember confirma el tipo, monto y moneda antes de guardar.
- Usa `/finanzas` para consultar compromisos. Los botones los marcan como cubiertos; `/abono ID MONTO` registra un pago parcial.
- Usa `/documentos` para consultar tus documentos mediante enlaces privados temporales.
- Los avisos de vencimiento se envían una vez: tres días antes para compromisos financieros y siete días antes para documentos.
- Remember solo registra y recuerda: no inicia transferencias ni realiza pagos. Los datos se aíslan por chat privado de Telegram; el bot no admite gestión de registros en grupos.

## Configuración de Supabase

1. En el SQL Editor del proyecto Supabase, ejecuta el contenido actualizado de [`supabase/schema.sql`](./supabase/schema.sql) para crear las tablas, índices y bucket privado para archivos.
2. En la configuración del servicio de Render, añade `SUPABASE_URL` y `SUPABASE_SERVICE_ROLE_KEY`. La clave de servicio solo debe existir en el backend de Render: no uses una clave `anon`/publishable y no la compartas en el chat.
3. Configura las variables de Telegram indicadas arriba y despliega. El esquema puede volver a ejecutarse para añadir las tablas nuevas a un proyecto donde ya existan las tablas anteriores.
