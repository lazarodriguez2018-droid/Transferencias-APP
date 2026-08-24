# Correo de confirmación de Sucaneitor

Plantilla de producción para **Authentication → Email Templates → Confirm signup** en el proyecto Supabase `Transfeapp`.

- Asunto: `Confirmá tu cuenta de Sucaneitor`
- Cuerpo: copiar íntegramente `confirm-signup.html`.
- Conserva las variables `{{ .ConfirmationURL }}`, `{{ .Token }}` y `{{ .Email }}` para ofrecer enlace y código en el mismo mensaje.

La aplicación verifica el código con Supabase y mantiene el enlace como alternativa. La plantilla alojada en Supabase debe actualizarse desde el panel o la API de administración; un despliegue de Vercel no cambia por sí solo los correos de Authentication.
