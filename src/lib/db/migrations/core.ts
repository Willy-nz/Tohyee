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
  {
    version: "0013",
    name: "sales_roles",
    sql: `
-- CRM-only roles (decision 491, #216): sales reps and sales managers use the
-- CRM and nothing of the books.
alter table organisation_members drop constraint organisation_members_role_check;
alter table organisation_members add constraint organisation_members_role_check
  check (role in ('owner', 'admin', 'bookkeeper', 'viewer', 'report_viewer', 'sales_manager', 'sales_rep'));
`,
  },
  {
    version: "0014",
    name: "farm_app_keys",
    sql: `
-- Keys for people's own farm apps (#249 stage 5; examples FA1-FA8, decision
-- 561). Like AI keys: one person, one organisation, only the SHA-256 kept,
-- revoked rather than deleted. Scopes say what the app may do; recording
-- also needs the owner's role (bookkeeper or higher) each time it's used.
create table farm_app_keys (
  id bigserial primary key,
  user_id uuid not null references users(id) on delete cascade,
  organisation_id text not null references organisations(id) on delete cascade,
  name text not null check (length(name) between 1 and 100),
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  token_prefix text not null check (length(token_prefix) = 8),
  scopes text[] not null check (cardinality(scopes) between 1 and 5 and scopes <@ array['read_farm', 'read_soil', 'read_pasture', 'record_soil_samples', 'record_pasture']::text[]),
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_by_email text not null
);
create index farm_app_keys_owner_idx on farm_app_keys (organisation_id, user_id);
`,
  },
  {
    version: "0015",
    name: "group_membership_dates",
    sql: `
-- Group workspace (#200, decisions 640-643; Codex, delegated by owner, 20
-- October 2026). Each stay of an organisation in a group is a row with the
-- day it joined and the last day it was in (null: from the start, still in
-- it), so a member can leave and come back and reports know who was in the
-- group on a date. The steward is the member organisation whose own
-- database holds the group's new business records (customer links, stage
-- mappings, saved reports); the core database only says which one it is.
alter table consolidation_group_members drop constraint consolidation_group_members_pkey;
alter table consolidation_group_members add column id bigserial primary key;
alter table consolidation_group_members add column effective_from date;
alter table consolidation_group_members add column effective_to date;
alter table consolidation_group_members add column ended_by_email text;
alter table consolidation_group_members add column ended_at timestamptz;
alter table consolidation_group_members add constraint consolidation_group_members_dates
  check (effective_from is null or effective_to is null or effective_to >= effective_from);
create unique index consolidation_group_members_open on consolidation_group_members (group_id, organisation_id) where effective_to is null;
create index consolidation_group_members_group on consolidation_group_members (group_id);
alter table consolidation_groups add column steward_organisation_id text references organisations(id);
`,
  },
  {
    version: "0016",
    name: "backup_evidence",
    sql: `
-- Backups and recovery (#389, decisions 730-739, docs/BACKUP-RECOVERY.md).
-- Each backup file's SHA-256 when it was made and checked, so a later check
-- can tell the file was changed or replaced since.
alter table backup_runs add column sha256 text check (sha256 is null or sha256 ~ '^[0-9a-f]{64}$');

-- Checks done on backups after they were made: reading each database's
-- newest file back and checking it again (integrity), restoring one into a
-- scratch database that's dropped afterwards (test_restore), and restores
-- into a new organisation (restore, so one cut off by a restart can be
-- cleaned up). Written by the code doing the work, never typed in by a person.
create table backup_checks (
  id bigserial primary key,
  kind text not null check (kind in ('integrity', 'test_restore', 'restore')),
  organisation_id text,
  status text not null default 'running' check (status in ('running', 'ok', 'failed')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  file_name text,
  details jsonb not null default '{}'::jsonb,
  error text,
  requested_by_email text
);
create index backup_checks_kind_idx on backup_checks (kind, started_at desc);

-- A restored copy starts with its automatic jobs (email sending, feeds,
-- mailbox checks, repeating invoices, analytics loads) paused, so it can't
-- send or import the same things as the original while both exist. A server
-- admin turns them on.
alter table organisations add column jobs_paused_at timestamptz;
alter table organisations add column jobs_paused_reason text;
`,
  },
  {
    version: "0017",
    name: "google_sign_in",
    sql: `
-- Sign in with Google for invited people (#424, decisions 800-809). A login
-- is linked to one Google account by Google's own account ID ("sub"), never
-- by email address alone, so a changed or reused Gmail address can't move it
-- to someone else. The address is kept only to show which account it is.
create table user_google_identities (
  user_id uuid primary key references users(id) on delete cascade,
  google_sub text not null check (google_sub ~ '^[A-Za-z0-9._-]{1,255}$'),
  email text not null check (length(email) <= 254),
  linked_at timestamptz not null default now(),
  last_used_at timestamptz
);
create unique index user_google_identities_sub on user_google_identities (google_sub);

-- A login set up with Google from its setup link has no password anyone
-- knows. Server admins always keep a password (checked in code).
alter table users add column google_only boolean not null default false;

-- How a session was signed in: a Google sign-in relies on Google's own
-- checks and doesn't ask for Tohyee's authenticator code.
alter table sessions add column sign_in_method text not null default 'password' check (sign_in_method in ('password', 'google'));

-- One row per trip to Google's sign-in page: only hashes of the state and of
-- the browser's cookie are kept; the PKCE verifier and nonce are random and
-- used once, within 10 minutes.
create table google_sign_in_states (
  state_hash text primary key check (state_hash ~ '^[0-9a-f]{64}$'),
  browser_hash text not null check (browser_hash ~ '^[0-9a-f]{64}$'),
  purpose text not null check (purpose in ('sign_in', 'setup', 'link')),
  code_verifier text not null check (length(code_verifier) between 43 and 128),
  nonce text not null check (length(nonce) between 16 and 128),
  redirect_uri text not null check (length(redirect_uri) <= 500),
  next_path text check (next_path is null or length(next_path) <= 200),
  user_id uuid references users(id) on delete cascade,
  session_id text check (session_id is null or session_id ~ '^[0-9a-f]{64}$'),
  setup_token_hash text check (setup_token_hash is null or setup_token_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  used_at timestamptz,
  check ((purpose = 'link') = (user_id is not null and session_id is not null)),
  check ((purpose = 'setup') = (setup_token_hash is not null))
);
create index google_sign_in_states_created on google_sign_in_states (created_at);

alter table sign_in_events drop constraint sign_in_events_step_check;
alter table sign_in_events add constraint sign_in_events_step_check
  check (step in ('password', 'code', 'backup_code', 'setup_link', 'reset_link', 'first_admin', 'google'));
`,
  },
  {
    version: "0018",
    name: "ai_connections_oauth",
    sql: `
-- AI apps that connect by signing in (#427, decisions 810-829): Claude.ai,
-- ChatGPT and other MCP clients sign in to Tohyee with OAuth 2.1, as the MCP
-- authorisation specification says, instead of being given a key. A
-- connection is a row in ai_access_tokens (kind 'connection') so it has the
-- same level, role ceiling, history name, private-mail scope and endings as
-- a key; it just has no key of its own. Only hashes of codes and tokens are
-- kept.

-- The AI apps Tohyee knows: ones that registered themselves (RFC 7591) and
-- ones whose details were read from their own https address (a client ID
-- metadata document), kept for a while.
create table oauth_clients (
  client_id text primary key check (length(client_id) between 1 and 500),
  source text not null check (source in ('registered', 'metadata_document')),
  client_name text not null check (length(client_name) between 1 and 100),
  redirect_uris jsonb not null check (jsonb_typeof(redirect_uris) = 'array'),
  created_at timestamptz not null default now(),
  fetched_at timestamptz,
  expires_at timestamptz,
  last_used_at timestamptz,
  check ((source = 'metadata_document') = (fetched_at is not null and expires_at is not null))
);
create index oauth_clients_unused on oauth_clients (created_at) where last_used_at is null;

alter table ai_access_tokens add column kind text not null default 'key' check (kind in ('key', 'connection'));
alter table ai_access_tokens alter column token_hash drop not null;
alter table ai_access_tokens alter column token_prefix drop not null;
alter table ai_access_tokens add column oauth_client_id text check (oauth_client_id is null or length(oauth_client_id) <= 500);
alter table ai_access_tokens add column redirect_uri text check (redirect_uri is null or length(redirect_uri) <= 500);
alter table ai_access_tokens add column resource text check (resource is null or length(resource) <= 500);
alter table ai_access_tokens add constraint ai_access_tokens_kind_shape check (
  (kind = 'key' and token_hash is not null and token_prefix is not null and oauth_client_id is null and redirect_uri is null and resource is null)
  or (kind = 'connection' and token_hash is null and token_prefix is null and oauth_client_id is not null and redirect_uri is not null and resource is not null)
);

-- One row per sign-in an AI app starts: what it asked for, tied to the
-- browser that started it by the hash of a random cookie. Used once, within
-- 10 minutes.
create table oauth_authorization_requests (
  handle_hash text primary key check (handle_hash ~ '^[0-9a-f]{64}$'),
  browser_hash text not null check (browser_hash ~ '^[0-9a-f]{64}$'),
  client_id text not null check (length(client_id) <= 500),
  client_name text not null check (length(client_name) between 1 and 100),
  redirect_uri text not null check (length(redirect_uri) <= 500),
  state text check (state is null or length(state) <= 500),
  code_challenge text not null check (code_challenge ~ '^[A-Za-z0-9._~-]{43,128}$'),
  resource text not null check (length(resource) <= 500),
  created_at timestamptz not null default now(),
  used_at timestamptz
);
create index oauth_authorization_requests_created on oauth_authorization_requests (created_at);

-- The one-time code handed back to the app after the person allows it,
-- with what they chose. Used once, within 5 minutes, with the PKCE verifier.
create table oauth_authorization_codes (
  code_hash text primary key check (code_hash ~ '^[0-9a-f]{64}$'),
  user_id uuid not null references users(id) on delete cascade,
  organisation_id text not null references organisations(id) on delete cascade,
  client_id text not null check (length(client_id) <= 500),
  client_name text not null check (length(client_name) between 1 and 100),
  redirect_uri text not null check (length(redirect_uri) <= 500),
  code_challenge text not null check (code_challenge ~ '^[A-Za-z0-9._~-]{43,128}$'),
  resource text not null check (length(resource) <= 500),
  access_level text not null check (access_level in ('read', 'draft', 'post', 'full')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz,
  connection_id bigint references ai_access_tokens(id) on delete cascade
);
create index oauth_authorization_codes_user on oauth_authorization_codes (user_id);
create index oauth_authorization_codes_created on oauth_authorization_codes (created_at);

-- Access tokens (an hour) and refresh tokens (60 days, replaced each time
-- they're used) for a connection. A refresh token used twice ends the
-- connection.
create table oauth_tokens (
  token_hash text primary key check (token_hash ~ '^[0-9a-f]{64}$'),
  connection_id bigint not null references ai_access_tokens(id) on delete cascade,
  kind text not null check (kind in ('access', 'refresh')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz
);
create index oauth_tokens_connection on oauth_tokens (connection_id);
`,
  },
  {
    version: "0019",
    name: "office_addin_connections",
    sql: `
-- The PowerPoint add-in for Analytics (#429, decisions 830-849). It signs in
-- with the same OAuth as AI apps, but its tokens are for a different
-- address (<remote>/api/office), only read Analytics, and belong to the
-- person rather than one organisation (it lists all of theirs). A
-- connection of kind 'office' is a row like an AI app's, with no
-- organisation, always the read level; the MCP endpoint only accepts kind
-- 'connection', and the Analytics API for Office only kind 'office'.
alter table ai_access_tokens drop constraint ai_access_tokens_kind_check;
alter table ai_access_tokens add constraint ai_access_tokens_kind_check check (kind in ('key', 'connection', 'office'));
alter table ai_access_tokens drop constraint ai_access_tokens_kind_shape;
alter table ai_access_tokens add constraint ai_access_tokens_kind_shape check (
  (kind = 'key' and token_hash is not null and token_prefix is not null and oauth_client_id is null and redirect_uri is null and resource is null)
  or (kind in ('connection', 'office') and token_hash is null and token_prefix is null and oauth_client_id is not null and redirect_uri is not null and resource is not null)
);
alter table ai_access_tokens alter column organisation_id drop not null;
alter table ai_access_tokens add constraint ai_access_tokens_office_shape check (
  (kind = 'office') = (organisation_id is null) and (kind <> 'office' or access_level = 'read')
);
create index ai_access_tokens_office_owner on ai_access_tokens (user_id) where kind = 'office';

-- A code for the add-in has no organisation: the person picks one in PowerPoint.
alter table oauth_authorization_codes add column kind text not null default 'connection' check (kind in ('connection', 'office'));
alter table oauth_authorization_codes alter column organisation_id drop not null;
alter table oauth_authorization_codes add constraint oauth_authorization_codes_office_shape check (
  (kind = 'office') = (organisation_id is null) and (kind <> 'office' or access_level = 'read')
);
`,
  },
  {
    version: "0020",
    name: "demo_farm",
    sql: `
-- The demo farm (#437, decisions 855-869): a made-up organisation a person
-- adds for themselves, like Xero's demo company. One each; it goes when they
-- do. While it's being made (a background job) it isn't in their list yet,
-- and the build's progress is kept here so the page can show it. To take the
-- demo farm out later, a migration drops these columns (docs/DEMO-FARM.md).
alter table organisations add column demo_for_user_id uuid references users(id) on delete cascade;
alter table organisations add column demo_status text check (demo_status in ('building', 'ready', 'failed'));
alter table organisations add column demo_step text check (length(demo_step) <= 200);
alter table organisations add column demo_percent integer check (demo_percent between 0 and 100);
alter table organisations add column demo_error text check (length(demo_error) <= 2000);
alter table organisations add column demo_started_at timestamptz;
alter table organisations add column demo_updated_at timestamptz;
alter table organisations add column demo_build_ms integer;
alter table organisations add constraint organisations_demo_shape check ((demo_for_user_id is null) = (demo_status is null));
create unique index organisations_one_demo_each on organisations (demo_for_user_id) where demo_for_user_id is not null;
`,
  },
  {
    version: "0022",
    name: "organisation_invitations",
    sql: `
-- Inviting people from People and roles (#441, decisions 870-879). A row
-- here means the membership came with a login this invitation made. It shows
-- as "Invited" until that login is first signed in to; Cancel can then take
-- the login away too, if nothing else uses it. It goes with the membership.
create table organisation_invitations (
  organisation_id text not null,
  user_id uuid not null,
  invited_by_user_id uuid references users(id) on delete set null,
  invited_by_email text not null check (length(invited_by_email) <= 320),
  invited_at timestamptz not null default now(),
  last_sent_at timestamptz not null default now(),
  primary key (organisation_id, user_id),
  foreign key (organisation_id, user_id) references organisation_members (organisation_id, user_id) on delete cascade
);
create index organisation_invitations_user_id_idx on organisation_invitations (user_id);
`,
  },
];
