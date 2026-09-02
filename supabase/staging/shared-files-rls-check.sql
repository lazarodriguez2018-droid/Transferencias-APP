-- Run as database owner after the shared-files migration.
-- Uses two existing approved identities without reading names or other personal
-- data. Synthetic metadata is transaction-local; no files or account changes.
begin;
do $$
declare
  actors uuid[];
  test_path text;
  seen integer;
  denied boolean;
begin
  select array_agg(id) into actors from (select id from public.perfiles where approved = true order by id limit 2) p;
  if coalesce(array_length(actors, 1), 0) < 2 then raise exception 'Need two approved profiles'; end if;
  test_path := actors[1]::text || '/qa-' || gen_random_uuid()::text || '/archivo.csv';
  perform set_config('request.jwt.claim.sub', actors[1]::text, true);
  execute 'set local role authenticated';
  insert into storage.objects(bucket_id, name, owner_id)
    values ('op-archivos-compartidos', test_path, actors[1]::text);
  select count(*) into seen from storage.objects where bucket_id = 'op-archivos-compartidos' and name = test_path;
  if seen <> 1 then raise exception 'Owner cannot read own file'; end if;

  perform set_config('request.jwt.claim.sub', actors[2]::text, true);
  select count(*) into seen from storage.objects where bucket_id = 'op-archivos-compartidos' and name = test_path;
  if seen <> 0 then raise exception 'Another user can read the file'; end if;
  denied := false;
  begin
    insert into storage.objects(bucket_id, name, owner_id)
      values ('op-archivos-compartidos', test_path || '-forbidden', actors[2]::text);
  exception when insufficient_privilege then denied := true;
  end;
  if not denied then raise exception 'Another user can upload to the owner folder'; end if;

  perform set_config('request.jwt.claim.sub', gen_random_uuid()::text, true);
  denied := false;
  begin
    insert into storage.objects(bucket_id, name, owner_id)
      values ('op-archivos-compartidos', auth.uid()::text || '/qa-unapproved.csv', auth.uid()::text);
  exception when insufficient_privilege then denied := true;
  end;
  if not denied then raise exception 'Unapproved identity can upload'; end if;

  execute 'set local role anon';
  select count(*) into seen from storage.objects where bucket_id = 'op-archivos-compartidos';
  if seen <> 0 then raise exception 'Anonymous caller can list files'; end if;
  denied := false;
  begin
    insert into storage.objects(bucket_id, name) values ('op-archivos-compartidos', 'qa-anonymous.csv');
  exception when insufficient_privilege then denied := true;
  end;
  if not denied then raise exception 'Anonymous caller can upload'; end if;
  execute 'reset role';
end $$;
rollback;
select 'PASS: owner read/write, other owner denied, unapproved denied, anonymous denied; all test data rolled back' as verification;
