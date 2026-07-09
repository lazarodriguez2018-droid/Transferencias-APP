# Seguridad y salida a produccion

Esta app usa Supabase desde el navegador. La clave `publishable` puede ser publica; la seguridad real depende de Row Level Security (RLS), politicas y Auth en Supabase.

## Imprescindible antes de publicar

1. Activar RLS en todas las tablas de datos.
2. Confirmar que usuarios locales solo leen pedidos donde su local es origen o destino.
3. Confirmar que solo admins pueden crear/editar/borrar locales, transportes, productos, usuarios y pedidos.
4. Bloquear lectura directa de `empresa_config` si guarda claves en texto plano.
5. Mover la validacion de clave de empresa a una funcion RPC con hash o, mejor, reemplazarla por invitaciones/aprobacion de usuarios.
6. Revisar Supabase Auth: email confirmation activo, password minimo 8 caracteres y rate limit de signup/login.
7. Publicar con HTTPS y mantener el Content Security Policy.
8. Probar con dos usuarios reales: uno admin y uno local, intentando leer/editar datos fuera de su local.

## Consultas manuales de verificacion

En Supabase SQL editor, revisa:

```sql
select schemaname, tablename, rowsecurity
from pg_tables
where schemaname = 'public'
order by tablename;

select schemaname, tablename, policyname, cmd, roles
from pg_policies
where schemaname = 'public'
order by tablename, policyname;
```

## Riesgo principal detectado

La pantalla de "clave de empresa" consulta `empresa_config` desde el cliente. Si esa tabla permite `select` al rol anon/authenticated, un atacante puede intentar fuerza bruta o enumerar datos. Para produccion conviene no guardar claves en texto plano y no exponer lectura directa de esa tabla.

## Archivo SQL sugerido

Usa `supabase-rls-hardening.sql` como base. Aplicalo primero en una copia/staging, porque las politicas exactas dependen de tus columnas reales y de los roles que ya tengas cargados.
