-- El listado busca texto sin acentos. En Supabase la extensión vive en
-- `extensions`, por lo que la función debe incluir ese esquema explícitamente.

alter function public.op_reserva_listar(jsonb,text)
  set search_path = public, extensions, pg_temp;
