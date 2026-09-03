/* Real PostgreSQL (PGlite), isolated in memory. No production data or credentials.
 * Run: PGLITE_PATH=<installed @electric-sql/pglite> node tools/reposition-orders-sql.test.js
 * Supabase platform auth/storage schemas and pgcrypto hashing are test shims only.
 */
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
let PGlite;
try{({PGlite}=require(process.env.PGLITE_PATH||'@electric-sql/pglite'));}catch(error){if(error.code!=='MODULE_NOT_FOUND'||process.env.PGLITE_PATH)throw error;console.log('SKIP PostgreSQL integration: install @electric-sql/pglite or set PGLITE_PATH.');process.exit(0);}
const root=path.resolve(__dirname,'..');
async function createDatabase(){
 const db=new PGlite();
 await db.exec(`create role anon;create role authenticated;create role service_role;create schema auth;create schema storage;create schema extensions;
 create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb default '{}');
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 create function auth.role() returns text language sql stable as $$select current_user::text$$;
 create function auth.jwt() returns jsonb language sql stable as $$select '{}'::jsonb$$;
 create function public.digest(text,text) returns bytea language sql immutable as $$select sha256(convert_to($1,'UTF8'))$$;
 create function public.gen_random_bytes(integer) returns bytea language sql volatile as $$select substring(sha256(convert_to(gen_random_uuid()::text,'UTF8')) from 1 for $1)$$;
 create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
 create table storage.objects(id uuid primary key,name text,bucket_id text,owner_id text);
 create function storage.foldername(text) returns text[] language sql immutable as $$select string_to_array($1,'/')$$;
 create publication supabase_realtime;`);
 const files=['supabase/staging/000_transferapp_base.sql',...fs.readdirSync(path.join(root,'supabase/migrations')).filter(n=>n.endsWith('.sql')).sort().map(n=>'supabase/migrations/'+n)];
 for(const f of files){
   const sql=fs.readFileSync(path.join(root,f),'utf8').replace(/create extension if not exists pgcrypto(?: with schema extensions)?;/gi,'');
   try{await db.exec(sql);}catch(e){console.error('Migration failed:',f,e.message);throw e;}
 }
 console.log('All production schema migrations parsed and executed in isolated PostgreSQL.');

 return db;
}
module.exports={createDatabase};

