-- Creates (or updates) Tohyee's two everyday database logins (issue #152).
-- Run by configure-tohyee.ps1 as the PostgreSQL superuser, in the postgres
-- database. Safe to run again: it only sets the logins' rights and passwords.
--
--   admin login  NOSUPERUSER CREATEDB: creates and owns the organisation
--                databases and runs migrations (DATABASE_ADMIN_URL)
--   app login    plain login, data access only (DATABASE_URL)
--
-- The superuser made by initdb is then only used while installing.
--
-- Names and passwords come in as settings so they never appear on a command
-- line or in the server log, e.g. through PGOPTIONS:
--   -c tohyee.admin_role=tohyee_admin -c tohyee.admin_password=...
--   -c tohyee.app_role=tohyee_app     -c tohyee.app_password=...

do $$
declare
  admin_role text := current_setting('tohyee.admin_role');
  admin_password text := current_setting('tohyee.admin_password');
  app_role text := current_setting('tohyee.app_role');
  app_password text := current_setting('tohyee.app_password');
begin
  if admin_role = app_role or admin_role = current_user or app_role = current_user then
    raise exception 'The admin and app logins must be two different logins, and neither can be %.', current_user;
  end if;
  if length(admin_password) < 24 or length(app_password) < 24 then
    raise exception 'The database login passwords must be at least 24 characters.';
  end if;

  if not exists (select from pg_roles where rolname = admin_role) then
    execute format('create role %I', admin_role);
  end if;
  if not exists (select from pg_roles where rolname = app_role) then
    execute format('create role %I', app_role);
  end if;

  execute format(
    'alter role %I with login nosuperuser createdb nocreaterole noreplication nobypassrls password %L',
    admin_role, admin_password);
  execute format(
    'alter role %I with login nosuperuser nocreatedb nocreaterole noreplication nobypassrls password %L',
    app_role, app_password);
end
$$;
