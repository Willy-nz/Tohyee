-- Hands one database, and everything in it the current (installing) login
-- owns, to Tohyee's admin login (issue #152). Run by configure-tohyee.ps1 as
-- the PostgreSQL superuser, connected to each Tohyee database in turn.
--
-- Installs made before issue #152 had the superuser own the core database, every
-- organisation database and all their tables and functions. REASSIGN OWNED
-- can't be used, because initdb's superuser also owns PostgreSQL's own
-- objects, so each object is moved one by one. Safe to run again: anything
-- already moved is skipped.
--
-- The admin login's name comes in as a setting:
--   -c tohyee.admin_role=tohyee_admin
-- The runtime login's rights are granted by Tohyee itself when it starts
-- (src/lib/db/grants.ts), once the admin login owns the tables.

do $$
declare
  new_owner text := current_setting('tohyee.admin_role');
  old_owner oid := (select oid from pg_roles where rolname = current_user);
  r record;
begin
  if new_owner = current_user then
    raise exception 'The admin login can''t be %.', current_user;
  end if;

  execute format('alter database %I owner to %I', current_database(), new_owner);

  for r in
    select n.nspname
      from pg_namespace n
     where n.nspowner = old_owner
       and n.nspname not like 'pg\_%'
       and n.nspname not in ('information_schema', 'public')
  loop
    execute format('alter schema %I owner to %I', r.nspname, new_owner);
  end loop;

  -- Tables (with their indexes and the sequences their columns own), views,
  -- materialised views and foreign tables.
  for r in
    select c.oid::regclass as name, c.relkind
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where c.relowner = old_owner
       and c.relkind in ('r', 'p', 'v', 'm', 'f')
       and n.nspname not like 'pg\_%'
       and n.nspname <> 'information_schema'
  loop
    execute format('alter %s %s owner to %I',
      case r.relkind
        when 'v' then 'view'
        when 'm' then 'materialized view'
        when 'f' then 'foreign table'
        else 'table'
      end,
      r.name, new_owner);
  end loop;

  -- Sequences not owned by a column (those moved with their table above).
  for r in
    select c.oid::regclass as name
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where c.relowner = old_owner
       and c.relkind = 'S'
       and n.nspname not like 'pg\_%'
       and n.nspname <> 'information_schema'
  loop
    execute format('alter sequence %s owner to %I', r.name, new_owner);
  end loop;

  -- Functions (including trigger functions), procedures and aggregates.
  for r in
    select p.oid::regprocedure as name, p.prokind
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where p.proowner = old_owner
       and n.nspname not like 'pg\_%'
       and n.nspname <> 'information_schema'
  loop
    execute format('alter %s %s owner to %I',
      case r.prokind when 'p' then 'procedure' when 'a' then 'aggregate' else 'function' end,
      r.name, new_owner);
  end loop;

  -- Enums, domains, ranges and standalone composite types (a table's own
  -- row type and array types move with it).
  for r in
    select t.oid::regtype as name, t.typtype
      from pg_type t
      join pg_namespace n on n.oid = t.typnamespace
     where t.typowner = old_owner
       and t.typtype in ('e', 'd', 'r', 'c')
       and (t.typtype <> 'c' or exists (select from pg_class c where c.oid = t.typrelid and c.relkind = 'c'))
       and n.nspname not like 'pg\_%'
       and n.nspname <> 'information_schema'
  loop
    execute format('alter %s %s owner to %I',
      case r.typtype when 'd' then 'domain' else 'type' end,
      r.name, new_owner);
  end loop;
end
$$;
