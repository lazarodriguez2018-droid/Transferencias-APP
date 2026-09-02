-- Private copies only. Source remitos/reports are never changed or made public.
begin;

insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
values ('op-archivos-compartidos', 'op-archivos-compartidos', false, 52428800, array['application/octet-stream'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create or replace function public.can_share_ops_files()
returns boolean language sql stable security definer set search_path = public
as $$ select exists(select 1 from public.perfiles where id = auth.uid() and approved = true) $$;
revoke all on function public.can_share_ops_files() from public, anon;
grant execute on function public.can_share_ops_files() to authenticated;

drop policy if exists op_shared_files_insert on storage.objects;
create policy op_shared_files_insert on storage.objects for insert to authenticated
with check (
  bucket_id = 'op-archivos-compartidos'
  and (storage.foldername(name))[1] = auth.uid()::text
  and public.can_share_ops_files()
);

drop policy if exists op_shared_files_read on storage.objects;
create policy op_shared_files_read on storage.objects for select to authenticated
using (
  bucket_id = 'op-archivos-compartidos'
  and owner_id = auth.uid()::text
  and (storage.foldername(name))[1] = auth.uid()::text
  and public.can_share_ops_files()
);

drop policy if exists op_shared_files_delete on storage.objects;
create policy op_shared_files_delete on storage.objects for delete to authenticated
using (
  bucket_id = 'op-archivos-compartidos'
  and owner_id = auth.uid()::text
  and (storage.foldername(name))[1] = auth.uid()::text
  and public.can_share_ops_files()
);

-- No public/anonymous listing or writes; no overwrites. Recipients only receive
-- a Storage-signed download URL, expiring in seven days. Physical retention and
-- cleanup must use the Storage API, never DELETE against storage.objects.
commit;
