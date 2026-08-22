# Sucaneitor Web

Aplicación web unificada para:

- inventarios colaborativos;
- preparación de reposiciones desde XLS;
- pedidos de clientes entre locales.

Los tres módulos comparten autenticación, locales y un único padrón en Supabase.

## Integración de reposiciones y pedidos

Al crear una reposición se incorporan de forma atómica los pedidos aceptados de la misma ruta. Para un mismo SKU, la cantidad física es el máximo entre la reposición automática y los pedidos de clientes. Al exportar, los clientes tienen prioridad y ninguna unidad se repite entre los dos remitos.

Los pedidos urgentes aceptados después de iniciar la preparación requieren aprobación de un supervisor. Al confirmar la salida se generan las asignaciones por cliente, los pedidos con unidades pasan a tránsito y los que no pudieron cubrirse quedan aceptados para una preparación futura.

## Base de datos

La migración aditiva está en `supabase/migrations/20260822010000_sucaneitor_operaciones.sql`. Debe validarse primero en un proyecto de pruebas y después aplicarse al proyecto activo.

## Pruebas

```powershell
node operaciones/tests/search-engine.test.js
node operaciones/tests/reposition-engine.test.js
node operaciones/tests/reposition-export.test.js
node operaciones/tests/ui-dialogs.test.js
node tools/integration-volume-test.js 12000 100000
node tools/volume-test.js 100000
```

## Publicación

El proyecto es estático y está preparado para Vercel. La cámara requiere HTTPS (o localhost durante desarrollo). `operaciones/cloud-config.js` contiene únicamente la URL y la clave pública de Supabase; los permisos efectivos se controlan con Auth y RLS.
