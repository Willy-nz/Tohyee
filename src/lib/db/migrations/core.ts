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
  {
    version: "0003",
    name: "backup_runs",
    sql: `
-- Every backup the server makes (on its schedule, or when a server admin asks),
-- one row per database: an organisation's, or the server's own (organisation_id
-- null). Written by the backup code as it works, never typed in by a person.
create table backup_runs (
  id bigserial primary key,
  organisation_id text,
  trigger text not null check (trigger in ('schedule', 'manual')),
  status text not null default 'running' check (status in ('running', 'ok', 'failed')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  file_path text,
  size_bytes bigint,
  error text,
  requested_by_email text
);
create index backup_runs_target_idx on backup_runs (organisation_id, started_at desc);
`,
  },
  {
    version: "0004",
    name: "server_starts_and_update_backups",
    sql: `
-- The backups the server app makes just before installing an update
-- (decision 329) are marked as such.
alter table backup_runs drop constraint backup_runs_trigger_check;
alter table backup_runs add constraint backup_runs_trigger_check check (trigger in ('schedule', 'manual', 'update'));

-- Each time the server starts: its version, the version that ran before it,
-- and what the start-up database upgrades did (decision 330). Written by the
-- server as it starts, never typed in by a person. After an update, this is
-- how the server app knows the new version is running and which
-- organisations, if any, couldn't be upgraded and are blocked.
create table server_starts (
  id bigserial primary key,
  version text not null,
  previous_version text,
  started_at timestamptz not null default now(),
  core_applied text[] not null default '{}',
  organisations_checked integer not null,
  organisations_upgraded integer not null,
  -- [{ "organisationId": "...", "error": "..." }]
  organisations_blocked jsonb not null default '[]'::jsonb
);
create index server_starts_started_at_idx on server_starts (started_at desc);
create trigger server_starts_append_only before update or delete on server_starts
  for each row execute function toeyee_forbid_mutation();
`,
  },
  {
    version: "0005",
    name: "ai_access_tokens",
    sql: `
-- Personal keys for connecting someone's own AI (Claude, ChatGPT and others)
-- to one organisation's books over MCP (decisions 339-348). Each key has an
-- access level chosen when it's made (read, draft or post), capped by its
-- owner's role when it's used; no level deletes anything. Only the SHA-256
-- of the key is kept; the key itself is shown once when it's made. Revoked,
-- never deleted, so the list shows what was made and when.
create table ai_access_tokens (
  id bigserial primary key,
  user_id uuid not null references users(id) on delete cascade,
  organisation_id text not null references organisations(id) on delete cascade,
  name text not null check (length(name) between 1 and 100),
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  token_prefix text not null check (length(token_prefix) = 8),
  access_level text not null default 'read' check (access_level in ('read', 'draft', 'post')),
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_by_email text not null
);
create index ai_access_tokens_owner_idx on ai_access_tokens (organisation_id, user_id);
`,
  },
  {
    version: "0006",
    name: "report_viewer_role",
    sql: `
-- Report viewers (decision 360): someone, such as a client, who signs in and
-- sees only the Analytics dashboards shared with them, nothing of the books.
alter table organisation_members drop constraint organisation_members_role_check;
alter table organisation_members add constraint organisation_members_role_check
  check (role in ('owner', 'admin', 'bookkeeper', 'viewer', 'report_viewer'));
`,
  },
  {
    version: "0007",
    name: "consolidation_groups",
    sql: `
-- Consolidation (CO1-CO11, decisions 437-445): groups of organisations on
-- this server reported together in the parent's currency. Only what belongs
-- to the group lives here: no accounting data, which stays in each
-- organisation's own database and is read from there for each report.
create table consolidation_groups (
  id bigserial primary key,
  name text not null check (length(name) between 1 and 100 and name = btrim(name)),
  parent_organisation_id text not null references organisations(id),
  version integer not null default 1 check (version > 0),
  archived_at timestamptz,
  created_by_user_id uuid references users(id) on delete set null,
  created_by_email text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index consolidation_groups_name_key on consolidation_groups (lower(name)) where archived_at is null;

create table consolidation_group_members (
  group_id bigint not null references consolidation_groups(id),
  organisation_id text not null references organisations(id),
  added_by_email text not null,
  added_at timestamptz not null default now(),
  primary key (group_id, organisation_id)
);

-- A month's consolidation rate an admin changed (NetSuite's edited
-- consolidated rates); every other rate is worked out from the parent's
-- exchange rates list each time.
create table consolidation_rate_overrides (
  group_id bigint not null references consolidation_groups(id),
  currency_code text not null check (currency_code ~ '^[A-Z]{3}$'),
  month date not null check (extract(day from month) = 1),
  kind text not null check (kind in ('current', 'average', 'historical')),
  rate numeric not null check (rate > 0 and scale(rate) <= 8),
  reason text not null check (length(reason) between 1 and 200),
  changed_by_email text not null,
  changed_at timestamptz not null default now(),
  primary key (group_id, currency_code, month, kind)
);

-- Budget exchange rates (CO11): one a month per member currency, typed.
create table consolidation_budget_rates (
  group_id bigint not null references consolidation_groups(id),
  currency_code text not null check (currency_code ~ '^[A-Z]{3}$'),
  month date not null check (extract(day from month) = 1),
  rate numeric not null check (rate > 0 and scale(rate) <= 8),
  changed_by_email text not null,
  changed_at timestamptz not null default now(),
  primary key (group_id, currency_code, month)
);

-- Elimination adjustments (CO7), in the group's currency, posted nowhere else.
create table consolidation_adjustments (
  id bigserial primary key,
  group_id bigint not null references consolidation_groups(id),
  adjustment_date date not null,
  description text not null check (length(description) between 1 and 200),
  removed_at timestamptz,
  removed_by_email text,
  created_by_email text not null,
  created_at timestamptz not null default now(),
  check ((removed_at is null) = (removed_by_email is null))
);
create table consolidation_adjustment_lines (
  id bigserial primary key,
  adjustment_id bigint not null references consolidation_adjustments(id),
  line_order integer not null check (line_order > 0),
  organisation_id text not null references organisations(id),
  account_code text not null check (length(account_code) between 1 and 20),
  debit numeric not null default 0 check (debit >= 0),
  credit numeric not null default 0 check (credit >= 0),
  check ((debit = 0) <> (credit = 0)),
  unique (adjustment_id, line_order)
);
`,
  },
  {
    version: "0008",
    name: "consolidation_commentaries",
    sql: `
-- AI commentary on consolidated reports (decision 446), as on the cash flow
-- forecast, kept with the group.
create table consolidation_commentaries (
  id bigserial primary key,
  group_id bigint not null references consolidation_groups(id),
  report text not null check (report in ('consolidated_profit_and_loss', 'consolidated_balance_sheet')),
  period_label text not null check (length(period_label) between 1 and 200),
  body text not null check (length(body) between 1 and 5000),
  status text not null check (status in ('suggested', 'accepted')),
  -- The person whose AI key wrote it, and the key ('AI key "Claude"'); null via for one a person wrote.
  written_by_email text not null,
  written_via text,
  accepted_by_email text,
  accepted_at timestamptz,
  removed_by_email text,
  removed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((status = 'accepted') = (accepted_at is not null)),
  check ((removed_at is null) = (removed_by_email is null))
);
`,
  },
  {
    version: "0009",
    name: "user_setup_links",
    sql: `
-- One-time links for setting up a login (#208 item 2, Jess 9 Oct 2026): the
-- person chooses their own password and sets up two-step sign-in through it,
-- from anywhere. With two-step sign-in on, a password alone no longer starts
-- setting two-step up, so a stolen password can't register someone else's
-- authenticator. Only a hash of the link's code is kept.
create table user_setup_links (
  token_hash text primary key check (token_hash ~ '^[0-9a-f]{64}$'),
  user_id uuid not null references users(id) on delete cascade,
  created_by_email text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz
);
create index user_setup_links_user on user_setup_links (user_id) where used_at is null;
`,
  },
  {
    version: "0010",
    name: "organisation_handovers",
    sql: `
-- "Hand over this organisation" (#208, Jess 9 Oct 2026): a server admin
-- makes someone else an owner of an organisation whose owners can't (died,
-- left, won't answer). It takes effect after a 7-day wait, during which the
-- organisation's owners and admins are told and any of them can cancel it.
-- A server admin can't hand an organisation to themselves.
create table organisation_handovers (
  id bigserial primary key,
  organisation_id text not null references organisations(id) on delete cascade,
  to_user_id uuid not null references users(id) on delete cascade,
  reason text not null check (length(reason) between 5 and 500),
  requested_by_user_id uuid references users(id) on delete set null,
  requested_by_email text not null,
  status text not null default 'waiting' check (status in ('waiting', 'done', 'cancelled')),
  takes_effect_at timestamptz not null,
  created_at timestamptz not null default now(),
  cancelled_at timestamptz,
  cancelled_by_email text,
  completed_at timestamptz,
  check ((status = 'cancelled') = (cancelled_at is not null)),
  check ((status = 'done') = (completed_at is not null)),
  check (to_user_id is distinct from requested_by_user_id)
);
create unique index organisation_handovers_one_waiting on organisation_handovers (organisation_id) where status = 'waiting';
`,
  },
  {
    version: "0011",
    name: "sign_in_events",
    sql: `
-- The sign-in monitor (#208 item 1, Jess 9 Oct 2026: no country lookup;
-- suspicious sign-ins are reported, not blocked). Every sign-in attempt, with
-- the address a proxy saw, the browser, whether it came through remote
-- access, and why it was flagged, if it was. Kept for a year.
create table sign_in_events (
  id bigserial primary key,
  at timestamptz not null default now(),
  email text not null check (length(email) <= 254),
  user_id uuid references users(id) on delete set null,
  step text not null check (step in ('password', 'code', 'backup_code', 'setup_link', 'reset_link', 'first_admin')),
  outcome text not null check (outcome in ('signed_in', 'password_ok', 'failed', 'locked', 'refused')),
  detail text check (detail is null or length(detail) <= 300),
  address text check (address is null or length(address) <= 100),
  user_agent text check (user_agent is null or length(user_agent) <= 500),
  remote boolean not null default false,
  flag text check (flag is null or length(flag) <= 300)
);
create index sign_in_events_at on sign_in_events (at);
create index sign_in_events_user on sign_in_events (user_id, at);
create index sign_in_events_email on sign_in_events (email, at);
create index sign_in_events_address on sign_in_events (address, at);
create index sign_in_events_flagged on sign_in_events (at) where flag is not null;
`,
  },
  {
    version: "0012",
    name: "ai_full_access",
    sql: `
-- A fourth AI key level, "Full access" (decision 488, #205): it also
-- reconciles bank statement lines and makes and edits bank rules. Only
-- Owners make one; it works as "post" when its owner isn't an Owner.
alter table ai_access_tokens drop constraint ai_access_tokens_access_level_check;
alter table ai_access_tokens add constraint ai_access_tokens_access_level_check
  check (access_level in ('read', 'draft', 'post', 'full'));
`,
  },
];
