import type { Migration } from "@/lib/db/migrations/types";

/**
 * Migrations for the core (control-plane) database named in DATABASE_URL.
 * It holds the organisation registry, users (with their two-step sign-in),
 * sessions, memberships and server settings (email sending, remote access)
 * only.
 * No accounting data ever lives here; that belongs to each organisation's own
 * database (see tenant.ts).
 */
export const coreMigrations: readonly Migration[] = [
  {
    version: "0001",
    name: "core_baseline",
    sql: `
create function toeyee_forbid_mutation() returns trigger
language plpgsql as $$
begin
  raise exception '% is append-only', tg_table_name using errcode = 'P0001';
end;
$$;

create table users (
  id uuid primary key default gen_random_uuid(),
  email text not null check (email = lower(email) and length(email) between 3 and 254 and position('@' in email) > 1),
  display_name text not null check (length(display_name) between 1 and 100),
  password_hash text not null,
  is_server_admin boolean not null default false,
  is_active boolean not null default true,
  failed_login_count integer not null default 0,
  locked_until timestamptz,
  password_changed_at timestamptz not null default now(),
  last_login_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index users_email_key on users (email);

create table sessions (
  -- SHA-256 of the cookie token. The token itself is never stored.
  id text primary key check (id ~ '^[0-9a-f]{64}$'),
  user_id uuid not null references users(id) on delete cascade,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at timestamptz not null,
  user_agent text,
  ip_address text
);
create index sessions_user_id_idx on sessions (user_id);
create index sessions_expires_at_idx on sessions (expires_at);

create table organisations (
  id text primary key check (id ~ '^[a-z0-9][a-z0-9-]{0,31}$'),
  display_name text not null check (length(display_name) between 1 and 150),
  database_name text not null unique check (database_name ~ '^[a-z][a-z0-9_]{0,62}$'),
  base_currency text not null check (base_currency ~ '^[A-Z]{3}$'),
  is_active boolean not null default true,
  provisioning_status text not null default 'pending'
    check (provisioning_status in ('pending', 'ready', 'failed')),
  provisioning_error text,
  schema_version text,
  migration_status text not null default 'pending'
    check (migration_status in ('pending', 'current', 'failed')),
  migration_error text,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table organisation_members (
  organisation_id text not null references organisations(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  role text not null check (role in ('owner', 'admin', 'bookkeeper', 'viewer')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organisation_id, user_id)
);
create index organisation_members_user_id_idx on organisation_members (user_id);

create table admin_audit_events (
  id bigserial primary key,
  event_type text not null,
  entity_type text not null,
  entity_id text not null,
  actor_user_id uuid,
  actor_email text,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create trigger admin_audit_events_append_only
  before update or delete on admin_audit_events
  for each row execute function toeyee_forbid_mutation();
create trigger admin_audit_events_no_truncate
  before truncate on admin_audit_events
  for each statement execute function toeyee_forbid_mutation();
`,
  },
  {
    version: "0002",
    name: "two_step_sign_in_and_server_settings",
    sql: `
-- Two-step sign-in (authenticator app, RFC 6238). The secret is encrypted with
-- the server's TOHYEE_SECRET_KEY. totp_last_step stops a code being used twice.
-- A pending secret is one shown as a QR code but not confirmed yet.
alter table users
  add column totp_secret_ciphertext text,
  add column totp_enabled_at timestamptz,
  add column totp_last_step bigint,
  add column totp_pending_ciphertext text,
  add column two_step_failed_count integer not null default 0,
  add constraint users_totp_enabled_check check ((totp_enabled_at is null) = (totp_secret_ciphertext is null));

-- One-use backup codes (scrypt hashes, like passwords).
create table user_backup_codes (
  id bigserial primary key,
  user_id uuid not null references users(id) on delete cascade,
  code_hash text not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);
create index user_backup_codes_user_idx on user_backup_codes (user_id) where used_at is null;

-- A session is "pending" between the password and the second step. Pending
-- sessions last 10 minutes and can only finish signing in.
alter table sessions
  add column two_step_pending boolean not null default false,
  add column two_step_failures integer not null default 0;

-- Emailed links for resetting two-step sign-in when the phone is lost.
create table two_step_reset_tokens (
  token_hash text primary key check (token_hash ~ '^[0-9a-f]{64}$'),
  user_id uuid not null references users(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz
);

-- Server-wide settings set by server admins (email sending, remote access).
-- Passwords and tokens are encrypted with TOHYEE_SECRET_KEY and never sent to
-- the browser. No accounting data lives here.
create table server_settings (
  key text primary key check (key ~ '^[a-z][a-z0-9_]{0,62}$'),
  value jsonb not null default '{}'::jsonb,
  secret_ciphertext text,
  updated_by_email text,
  updated_at timestamptz not null default now()
);
`,
  },
];
