-- Estructura formal para registrar recepción por línea (incluye sustituciones)
create table if not exists public.pedido_recepcion_lineas (
  id uuid primary key default gen_random_uuid(),
  pedido_id uuid not null references public.pedidos(id) on delete cascade,
  linea_index integer not null,
  producto_solicitado_codigo text,
  producto_solicitado_nombre text not null,
  cantidad_solicitada numeric(12,2) not null default 0,
  producto_recibido_codigo text,
  producto_recibido_nombre text,
  cantidad_recibida numeric(12,2) not null default 0,
  diferencia numeric(12,2) not null default 0,
  estado text not null check (estado in ('CORRECTO','DIFERENCIA_CANTIDAD','NO_RECIBIDO','SUSTITUIDO')),
  motivo text,
  observaciones text,
  recepcion_usuario_id uuid,
  recepcion_usuario_nombre text,
  recepcion_fecha timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(pedido_id, linea_index)
);

create index if not exists idx_prl_pedido on public.pedido_recepcion_lineas(pedido_id);
create index if not exists idx_prl_estado on public.pedido_recepcion_lineas(estado);
create index if not exists idx_prl_solicitado on public.pedido_recepcion_lineas(producto_solicitado_codigo, producto_solicitado_nombre);
create index if not exists idx_prl_recibido on public.pedido_recepcion_lineas(producto_recibido_codigo, producto_recibido_nombre);
create index if not exists idx_prl_recepcion_fecha on public.pedido_recepcion_lineas(recepcion_fecha);

create or replace function public.set_updated_at_pedido_recepcion_lineas()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_set_updated_at_prl on public.pedido_recepcion_lineas;
create trigger trg_set_updated_at_prl
before update on public.pedido_recepcion_lineas
for each row execute function public.set_updated_at_pedido_recepcion_lineas();

-- Vista para auditoría/exportación comparativa
create or replace view public.v_pedido_recepcion_auditoria as
select
  p.id as pedido_id,
  p.created_at as pedido_fecha,
  p.origen_local,
  p.destino_local,
  l.linea_index,
  l.producto_solicitado_codigo,
  l.producto_solicitado_nombre,
  l.cantidad_solicitada,
  l.producto_recibido_codigo,
  l.producto_recibido_nombre,
  l.cantidad_recibida,
  l.diferencia,
  l.estado,
  l.motivo,
  l.observaciones,
  l.recepcion_usuario_id,
  l.recepcion_usuario_nombre,
  l.recepcion_fecha
from public.pedido_recepcion_lineas l
join public.pedidos p on p.id = l.pedido_id;
