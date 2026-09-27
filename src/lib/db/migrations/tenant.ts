import type { Migration } from "@/lib/db/migrations/types";

/**
 * Migrations applied to every organisation's own database. Each organisation
 * is a separate PostgreSQL database, so these tables never contain another
 * organisation's rows and can be backed up, restored or moved on their own.
 *
 * Integrity rules the database enforces itself (not just the app):
 * - every journal balances, checked at commit (deferred constraint triggers);
 * - posted history (journals, lines, stock movements, revaluations, audit) is
 *   append-only; corrections are new rows;
 * - stock on hand and carrying value can't go negative;
 * - contacts are archived, never deleted, and active contact names are unique
 *   ignoring case;
 * - approved sales invoices and their lines can't be edited or deleted, only
 *   voided, and invoice numbers only move forward one at a time;
 * - customer payments can't be edited or deleted, only voided once; they're
 *   only against approved invoices, never add up to more than the invoice's
 *   total, and an invoice with active payments can't be voided;
 * - approved bills and their lines can't be edited or deleted, only voided,
 *   and a supplier can't have two bills that aren't voided with the same
 *   invoice number, ignoring case and spaces;
 * - supplier payments can't be edited or deleted, only voided once; they're
 *   only against approved bills, never add up to more than the bill's total,
 *   and a bill with active payments can't be voided;
 * - approved sales credit notes and their lines can't be edited or deleted,
 *   only voided (not while credit is applied or refunded), and credit note
 *   numbers only move forward one at a time;
 * - credit note applications can only be removed once and refunds only
 *   voided once; an invoice's active payments and applied credit never add
 *   up to more than its total, a credit note's applied and refunded credit
 *   never more than its total, and an invoice with credit applied can't be
 *   voided.
 */
export const tenantMigrations: readonly Migration[] = [
  {
    version: "0001",
    name: "tenant_baseline",
    sql: `
create function toeyee_forbid_mutation() returns trigger
language plpgsql as $$
begin
  raise exception '% is append-only', tg_table_name using errcode = 'P0001';
end;
$$;

create table organisation_settings (
  id boolean primary key default true check (id),
  organisation_id text not null,
  display_name text not null check (length(display_name) between 1 and 150),
  base_currency text not null check (base_currency ~ '^[A-Z]{3}$'),
  financial_year_end_month smallint not null default 3
    check (financial_year_end_month between 1 and 12),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table audit_events (
  id bigserial primary key,
  event_type text not null,
  entity_type text not null,
  entity_id text not null,
  actor_user_id uuid,
  actor_email text,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table accounting_period_controls (
  id boolean primary key default true check (id),
  lock_date date,
  unlock_start date,
  unlock_end date,
  updated_at timestamptz not null default now(),
  check (
    (unlock_start is null and unlock_end is null)
    or (unlock_start is not null and unlock_end is not null and unlock_start <= unlock_end)
  )
);
insert into accounting_period_controls (id) values (true);

create table accounts (
  id bigserial primary key,
  code text not null check (code ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,19}$'),
  name text not null check (length(name) between 1 and 150),
  account_class text not null
    check (account_class in ('asset', 'liability', 'equity', 'revenue', 'expense')),
  account_type text not null,
  description text,
  currency_code text check (currency_code is null or currency_code ~ '^[A-Z]{3}$'),
  system_key text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index accounts_code_key on accounts (lower(code));
create unique index accounts_system_key_key on accounts (system_key) where system_key is not null;

create table ledger_journals (
  id bigserial primary key,
  command_source text not null,
  idempotency_key text not null,
  request_hash text not null,
  origin text not null default 'manual'
    check (origin in ('manual', 'correction', 'inventory', 'fx_revaluation')),
  posting_date date not null,
  reference text not null,
  description text,
  currency_code text not null check (currency_code ~ '^[A-Z]{3}$'),
  total_debit numeric not null check (total_debit > 0),
  total_credit numeric not null check (total_credit > 0),
  related_journal_id bigint references ledger_journals(id),
  correction_kind text,
  created_by_user_id uuid,
  created_by_email text,
  created_at timestamptz not null default now(),
  unique (command_source, idempotency_key),
  check (total_debit = total_credit),
  check (
    (related_journal_id is null and correction_kind is null)
    or (related_journal_id is not null and correction_kind is not null)
  ),
  check (correction_kind is null or correction_kind in ('reversal', 'replacement')),
  unique (related_journal_id, correction_kind)
);
create index ledger_journals_posting_date_idx on ledger_journals (posting_date, id);

create table ledger_journal_lines (
  id bigserial primary key,
  journal_id bigint not null references ledger_journals(id),
  line_order integer not null check (line_order > 0),
  account_id bigint not null references accounts(id),
  description text,
  debit_amount numeric not null default 0 check (debit_amount >= 0),
  credit_amount numeric not null default 0 check (credit_amount >= 0),
  unique (journal_id, line_order),
  check (
    (debit_amount > 0 and credit_amount = 0)
    or (credit_amount > 0 and debit_amount = 0)
  )
);
create index ledger_journal_lines_account_idx on ledger_journal_lines (account_id);

create function toeyee_assert_journal_balanced(target_journal_id bigint) returns void
language plpgsql as $$
declare
  header record;
  line_debits numeric;
  line_credits numeric;
  line_count integer;
begin
  select total_debit, total_credit into header from ledger_journals where id = target_journal_id;
  if not found then
    return;
  end if;
  select coalesce(sum(debit_amount), 0), coalesce(sum(credit_amount), 0), count(*)
    into line_debits, line_credits, line_count
    from ledger_journal_lines
   where journal_id = target_journal_id;
  if line_count < 2 then
    raise exception 'Journal % needs at least two lines.', target_journal_id
      using errcode = '23514';
  end if;
  if line_debits <> line_credits
     or line_debits <> header.total_debit
     or line_credits <> header.total_credit then
    raise exception 'Journal % does not balance (debits %, credits %).',
      target_journal_id, line_debits, line_credits
      using errcode = '23514';
  end if;
end;
$$;

create function toeyee_check_journal_header() returns trigger
language plpgsql as $$
begin
  perform toeyee_assert_journal_balanced(new.id);
  return null;
end;
$$;

create function toeyee_check_journal_line() returns trigger
language plpgsql as $$
begin
  perform toeyee_assert_journal_balanced(new.journal_id);
  return null;
end;
$$;

create constraint trigger ledger_journals_balanced
  after insert on ledger_journals
  deferrable initially deferred
  for each row execute function toeyee_check_journal_header();

create constraint trigger ledger_journal_lines_balanced
  after insert on ledger_journal_lines
  deferrable initially deferred
  for each row execute function toeyee_check_journal_line();

create table ledger_fx_revaluation_runs (
  id bigserial primary key,
  command_source text not null,
  idempotency_key text not null,
  request_hash text not null,
  operator_user_id uuid,
  operator_email text not null,
  reference text not null,
  description text,
  base_currency text not null,
  revaluation_date date not null,
  reversal_posting_date date not null,
  rate_date date not null,
  rate_source text not null,
  unrealised_gain_account_id bigint not null references accounts(id),
  unrealised_loss_account_id bigint not null references accounts(id),
  revaluation_journal_id bigint not null references ledger_journals(id),
  reversal_journal_id bigint not null references ledger_journals(id),
  created_at timestamptz not null default now(),
  unique (command_source, idempotency_key),
  check (reversal_posting_date > revaluation_date)
);

create table ledger_fx_revaluation_run_items (
  id bigserial primary key,
  run_id bigint not null references ledger_fx_revaluation_runs(id),
  line_order integer not null,
  account_id bigint not null references accounts(id),
  balance_type text not null check (balance_type in ('asset', 'liability')),
  currency_code text not null,
  foreign_amount numeric not null check (foreign_amount > 0),
  carrying_amount numeric not null,
  revalued_amount numeric not null,
  closing_rate numeric not null check (closing_rate > 0),
  delta_amount numeric not null,
  description text,
  revaluation_date date not null,
  unique (run_id, line_order),
  unique (account_id, revaluation_date)
);

create table inventory_item_balances (
  item_code text primary key,
  on_hand_quantity numeric not null default 0 check (on_hand_quantity >= 0),
  carrying_value numeric not null default 0 check (carrying_value >= 0),
  last_movement_date date,
  updated_at timestamptz not null default now()
);

create table inventory_movements (
  id bigserial primary key,
  command_source text not null,
  idempotency_key text not null,
  request_hash text not null,
  movement_type text not null check (
    movement_type in ('receipt', 'issue', 'adjustment', 'customer_return', 'supplier_return', 'landed_cost')
  ),
  movement_date date not null,
  item_code text not null,
  quantity_delta numeric not null,
  unit_cost numeric,
  value_delta numeric not null,
  quantity_after numeric not null check (quantity_after >= 0),
  value_after numeric not null check (value_after >= 0),
  reference text not null,
  description text,
  inventory_account_id bigint not null references accounts(id),
  offset_account_id bigint not null references accounts(id),
  original_movement_id bigint references inventory_movements(id),
  ledger_journal_id bigint not null references ledger_journals(id),
  created_by_user_id uuid,
  created_by_email text,
  created_at timestamptz not null default now(),
  unique (command_source, idempotency_key)
);
create index inventory_movements_item_idx on inventory_movements (item_code, movement_date, id);
create index inventory_movements_original_idx on inventory_movements (original_movement_id);

create table tax_codes (
  id bigserial primary key,
  command_source text not null,
  idempotency_key text not null,
  request_hash text not null,
  code text not null check (code ~ '^[A-Z0-9][A-Z0-9_-]{0,19}$'),
  label text not null,
  category text not null check (category in ('standard', 'zero_rated', 'exempt', 'out_of_scope')),
  rate numeric not null check (rate >= 0 and rate <= 1),
  is_active boolean not null default true,
  effective_from date not null,
  effective_to date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (command_source, idempotency_key),
  unique (code),
  check (effective_to is null or effective_to >= effective_from)
);

-- Posted history is append-only. Corrections are new rows.
create trigger audit_events_append_only
  before update or delete on audit_events
  for each row execute function toeyee_forbid_mutation();
create trigger ledger_journals_append_only
  before update or delete on ledger_journals
  for each row execute function toeyee_forbid_mutation();
create trigger ledger_journal_lines_append_only
  before update or delete on ledger_journal_lines
  for each row execute function toeyee_forbid_mutation();
create trigger ledger_fx_revaluation_runs_append_only
  before update or delete on ledger_fx_revaluation_runs
  for each row execute function toeyee_forbid_mutation();
create trigger ledger_fx_revaluation_run_items_append_only
  before update or delete on ledger_fx_revaluation_run_items
  for each row execute function toeyee_forbid_mutation();
create trigger inventory_movements_append_only
  before update or delete on inventory_movements
  for each row execute function toeyee_forbid_mutation();

create trigger audit_events_no_truncate
  before truncate on audit_events
  for each statement execute function toeyee_forbid_mutation();
create trigger ledger_journals_no_truncate
  before truncate on ledger_journals
  for each statement execute function toeyee_forbid_mutation();
create trigger ledger_journal_lines_no_truncate
  before truncate on ledger_journal_lines
  for each statement execute function toeyee_forbid_mutation();
create trigger inventory_movements_no_truncate
  before truncate on inventory_movements
  for each statement execute function toeyee_forbid_mutation();
create trigger ledger_fx_revaluation_runs_no_truncate
  before truncate on ledger_fx_revaluation_runs
  for each statement execute function toeyee_forbid_mutation();
create trigger ledger_fx_revaluation_run_items_no_truncate
  before truncate on ledger_fx_revaluation_run_items
  for each statement execute function toeyee_forbid_mutation();
`,
  },
  {
    version: "0002",
    name: "contacts",
    sql: `
create function toeyee_forbid_delete() returns trigger
language plpgsql as $$
begin
  raise exception '% can''t be deleted; archive them instead', tg_table_name using errcode = 'P0001';
end;
$$;

-- Customers and suppliers. Contacts are archived, never deleted.
create table contacts (
  id bigserial primary key,
  command_source text not null,
  idempotency_key text not null,
  request_hash text not null,
  name text not null check (length(name) between 1 and 150),
  is_customer boolean not null default false,
  is_supplier boolean not null default false,
  email text,
  phone text,
  postal_address text,
  gst_number text check (gst_number is null or gst_number ~ '^[0-9]{8,9}$'),
  is_archived boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (command_source, idempotency_key),
  check (is_customer or is_supplier)
);
create unique index contacts_active_name_key on contacts (lower(name)) where not is_archived;

create trigger contacts_no_delete
  before delete on contacts
  for each row execute function toeyee_forbid_delete();
create trigger contacts_no_truncate
  before truncate on contacts
  for each statement execute function toeyee_forbid_delete();
`,
  },
  {
    version: "0003",
    name: "sales_invoices",
    sql: `
-- How GST returns will be worked out. Stored now; the GST return uses it later.
alter table organisation_settings
  add column gst_basis text not null default 'invoice'
    check (gst_basis in ('invoice', 'payments', 'hybrid'));

-- Journals posted by approving or voiding a sales invoice.
alter table ledger_journals drop constraint ledger_journals_origin_check;
alter table ledger_journals add constraint ledger_journals_origin_check
  check (origin in ('manual', 'correction', 'inventory', 'fx_revaluation', 'invoice'));

-- Invoices post to accounts receivable and GST, found by role so re-coding
-- them doesn't break posting (and they can't be archived). New organisations
-- get these from the default chart; existing ones get them here if they
-- still have the default accounts.
update accounts set system_key = 'accounts_receivable', updated_at = now()
 where lower(code) = '1100' and account_class = 'asset' and system_key is null
   and not exists (select 1 from accounts where system_key = 'accounts_receivable');
update accounts set system_key = 'gst', updated_at = now()
 where lower(code) = '2100' and account_class = 'liability' and system_key is null
   and not exists (select 1 from accounts where system_key = 'gst');

-- Invoice numbers are taken on approval from this counter. The row stays
-- locked until the approval commits, and a refused or failed approval rolls
-- the counter back, so numbers have no gaps.
create table sales_invoice_numbering (
  id boolean primary key default true check (id),
  last_number integer not null default 0 check (last_number >= 0)
);
insert into sales_invoice_numbering (id) values (true);

create function toeyee_guard_invoice_numbering() returns trigger
language plpgsql as $$
begin
  if tg_op = 'UPDATE' then
    if new.last_number = old.last_number + 1 then
      return new;
    end if;
  end if;
  raise exception 'Invoice numbers only move forward one at a time' using errcode = 'P0001';
end;
$$;

create trigger sales_invoice_numbering_guard
  before update or delete on sales_invoice_numbering
  for each row execute function toeyee_guard_invoice_numbering();
create trigger sales_invoice_numbering_no_truncate
  before truncate on sales_invoice_numbering
  for each statement execute function toeyee_guard_invoice_numbering();

create table sales_invoices (
  id bigserial primary key,
  command_source text not null,
  idempotency_key text not null,
  request_hash text not null,
  status text not null default 'draft' check (status in ('draft', 'approved', 'voided')),
  contact_id bigint not null references contacts(id),
  invoice_date date not null,
  due_date date not null,
  reference text check (reference is null or length(reference) between 1 and 100),
  amounts_mode text not null check (amounts_mode in ('exclusive', 'inclusive', 'no_tax')),
  currency_code text not null check (currency_code ~ '^[A-Z]{3}$'),
  subtotal numeric not null check (subtotal >= 0),
  tax_total numeric not null check (tax_total >= 0),
  total numeric not null check (total > 0),
  invoice_sequence integer unique check (invoice_sequence > 0),
  invoice_number text unique,
  approval_journal_id bigint unique references ledger_journals(id),
  approve_command_source text,
  approve_idempotency_key text,
  approve_request_hash text,
  approved_by_user_id uuid,
  approved_by_email text,
  approved_at timestamptz,
  void_date date,
  void_journal_id bigint unique references ledger_journals(id),
  void_command_source text,
  void_idempotency_key text,
  void_request_hash text,
  voided_by_user_id uuid,
  voided_by_email text,
  voided_at timestamptz,
  created_by_user_id uuid,
  created_by_email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (command_source, idempotency_key),
  unique (approve_command_source, approve_idempotency_key),
  unique (void_command_source, void_idempotency_key),
  check (due_date >= invoice_date),
  check (void_date is null or void_date >= invoice_date),
  check (total = subtotal + tax_total),
  check (
    invoice_number is null
    or invoice_number = 'INV-' || lpad(invoice_sequence::text, greatest(4, length(invoice_sequence::text)), '0')
  ),
  check (
    (status = 'draft'
      and invoice_sequence is null and invoice_number is null and approval_journal_id is null
      and approve_command_source is null and approve_idempotency_key is null
      and approve_request_hash is null and approved_at is null
      and void_date is null and void_journal_id is null and void_command_source is null
      and void_idempotency_key is null and void_request_hash is null and voided_at is null)
    or (status = 'approved'
      and invoice_sequence is not null and invoice_number is not null and approval_journal_id is not null
      and approve_command_source is not null and approve_idempotency_key is not null
      and approve_request_hash is not null and approved_at is not null
      and void_date is null and void_journal_id is null and void_command_source is null
      and void_idempotency_key is null and void_request_hash is null and voided_at is null)
    or (status = 'voided'
      and invoice_sequence is not null and invoice_number is not null and approval_journal_id is not null
      and approve_command_source is not null and approve_idempotency_key is not null
      and approve_request_hash is not null and approved_at is not null
      and void_date is not null and void_journal_id is not null and void_command_source is not null
      and void_idempotency_key is not null and void_request_hash is not null and voided_at is not null)
  )
);
create index sales_invoices_status_idx on sales_invoices (status, id);
create index sales_invoices_contact_idx on sales_invoices (contact_id);

create table sales_invoice_lines (
  id bigserial primary key,
  invoice_id bigint not null references sales_invoices(id),
  line_order integer not null check (line_order > 0),
  description text not null check (length(description) between 1 and 500),
  quantity numeric not null check (quantity > 0),
  unit_price numeric not null check (unit_price > 0),
  account_id bigint not null references accounts(id),
  tax_code_id bigint references tax_codes(id),
  tax_rate numeric not null default 0 check (tax_rate >= 0 and tax_rate <= 1),
  line_amount numeric not null check (line_amount > 0),
  net_amount numeric not null check (net_amount >= 0),
  tax_amount numeric not null check (tax_amount >= 0),
  unique (invoice_id, line_order),
  check (tax_code_id is not null or tax_rate = 0),
  check (net_amount = line_amount or net_amount + tax_amount = line_amount)
);
create index sales_invoice_lines_account_idx on sales_invoice_lines (account_id);

-- Drafts can be edited and deleted. Once approved, an invoice can only be
-- voided: nothing but its status and void details may change, and it can't
-- be deleted. Its lines are frozen with it.
create function toeyee_guard_sales_invoice() returns trigger
language plpgsql as $$
begin
  if tg_op = 'TRUNCATE' then
    raise exception 'sales_invoices can''t be truncated' using errcode = 'P0001';
  end if;
  if old.status = 'draft' then
    if tg_op = 'DELETE' then
      return old;
    end if;
    return new;
  end if;
  if tg_op = 'DELETE' then
    raise exception 'Invoice % is %, so it can''t be deleted', old.invoice_number, old.status
      using errcode = 'P0001';
  end if;
  if old.status = 'approved' and new.status = 'voided'
     and (to_jsonb(new) - array['status', 'void_date', 'void_journal_id', 'void_command_source',
            'void_idempotency_key', 'void_request_hash', 'voided_by_user_id', 'voided_by_email',
            'voided_at', 'updated_at'])
       = (to_jsonb(old) - array['status', 'void_date', 'void_journal_id', 'void_command_source',
            'void_idempotency_key', 'void_request_hash', 'voided_by_user_id', 'voided_by_email',
            'voided_at', 'updated_at']) then
    return new;
  end if;
  raise exception 'Invoice % is %, so it can''t be changed', old.invoice_number, old.status
    using errcode = 'P0001';
end;
$$;

create function toeyee_guard_sales_invoice_line() returns trigger
language plpgsql as $$
declare
  parent_status text;
begin
  if tg_op = 'TRUNCATE' then
    raise exception 'sales_invoice_lines can''t be truncated' using errcode = 'P0001';
  end if;
  if tg_op in ('UPDATE', 'DELETE') then
    select status into parent_status from sales_invoices where id = old.invoice_id for share;
    if parent_status <> 'draft' then
      raise exception 'Lines of an approved or voided invoice can''t be changed' using errcode = 'P0001';
    end if;
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    select status into parent_status from sales_invoices where id = new.invoice_id for share;
    if parent_status <> 'draft' then
      raise exception 'Lines can only be added to a draft invoice' using errcode = 'P0001';
    end if;
    return new;
  end if;
  return old;
end;
$$;

create trigger sales_invoices_guard
  before update or delete on sales_invoices
  for each row execute function toeyee_guard_sales_invoice();
create trigger sales_invoices_no_truncate
  before truncate on sales_invoices
  for each statement execute function toeyee_guard_sales_invoice();
create trigger sales_invoice_lines_guard
  before insert or update or delete on sales_invoice_lines
  for each row execute function toeyee_guard_sales_invoice_line();
create trigger sales_invoice_lines_no_truncate
  before truncate on sales_invoice_lines
  for each statement execute function toeyee_guard_sales_invoice_line();
`,
  },
  {
    version: "0004",
    name: "customer_payments",
    sql: `
-- Journals posted by recording or voiding a customer payment.
alter table ledger_journals drop constraint ledger_journals_origin_check;
alter table ledger_journals add constraint ledger_journals_origin_check
  check (origin in ('manual', 'correction', 'inventory', 'fx_revaluation', 'invoice', 'customer_payment'));

-- Money received against one approved sales invoice. Recording it posts
-- Dr the bank account / Cr accounts receivable; voiding it posts the exact
-- reversal. An invoice's amount due is its total less its active payments,
-- worked out whenever it's read and never stored.
create table customer_payments (
  id bigserial primary key,
  command_source text not null,
  idempotency_key text not null,
  request_hash text not null,
  status text not null default 'active' check (status in ('active', 'voided')),
  invoice_id bigint not null references sales_invoices(id),
  payment_date date not null,
  amount numeric not null check (amount > 0),
  currency_code text not null check (currency_code ~ '^[A-Z]{3}$'),
  bank_account_id bigint not null references accounts(id),
  reference text check (reference is null or length(reference) between 1 and 100),
  journal_id bigint not null unique references ledger_journals(id),
  created_by_user_id uuid,
  created_by_email text,
  created_at timestamptz not null default now(),
  void_date date,
  void_journal_id bigint unique references ledger_journals(id),
  void_command_source text,
  void_idempotency_key text,
  void_request_hash text,
  voided_by_user_id uuid,
  voided_by_email text,
  voided_at timestamptz,
  unique (command_source, idempotency_key),
  unique (void_command_source, void_idempotency_key),
  check (void_date is null or void_date >= payment_date),
  check (
    (status = 'active'
      and void_date is null and void_journal_id is null and void_command_source is null
      and void_idempotency_key is null and void_request_hash is null and voided_at is null)
    or (status = 'voided'
      and void_date is not null and void_journal_id is not null and void_command_source is not null
      and void_idempotency_key is not null and void_request_hash is not null and voided_at is not null)
  )
);
create index customer_payments_invoice_idx on customer_payments (invoice_id, id);
create index customer_payments_bank_account_idx on customer_payments (bank_account_id);

-- A payment is recorded as active, against an approved invoice, in the
-- invoice's currency and dated on or after it, and an invoice's active
-- payments can't add up to more than its total (no overpayments yet). The
-- invoice stays locked until the transaction ends, so two payments can't
-- both take what's left.
create function toeyee_check_customer_payment() returns trigger
language plpgsql as $$
declare
  invoice record;
  paid numeric;
begin
  if new.status <> 'active' then
    raise exception 'A payment is recorded as active and voided afterwards' using errcode = 'P0001';
  end if;
  select status, invoice_number, invoice_date, currency_code, total into invoice
    from sales_invoices where id = new.invoice_id for update;
  if not found then
    -- The foreign key refuses it.
    return new;
  end if;
  if invoice.status <> 'approved' then
    raise exception 'Payments can only be recorded against approved invoices' using errcode = 'P0001';
  end if;
  if new.currency_code <> invoice.currency_code then
    raise exception 'A payment must be in its invoice''s currency' using errcode = 'P0001';
  end if;
  if new.payment_date < invoice.invoice_date then
    raise exception 'A payment can''t be dated before its invoice' using errcode = 'P0001';
  end if;
  select coalesce(sum(amount), 0) into paid
    from customer_payments where invoice_id = new.invoice_id and status = 'active';
  if paid + new.amount > invoice.total then
    raise exception 'Payments against invoice % can''t add up to more than its total', invoice.invoice_number
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;

-- Payments can't be edited or deleted. Voiding one, once, only fills in its
-- void details.
create function toeyee_guard_customer_payment() returns trigger
language plpgsql as $$
begin
  if tg_op = 'TRUNCATE' then
    raise exception 'customer_payments can''t be truncated' using errcode = 'P0001';
  end if;
  if tg_op = 'DELETE' then
    raise exception 'Customer payments can''t be deleted; void them instead' using errcode = 'P0001';
  end if;
  if old.status = 'active' and new.status = 'voided'
     and (to_jsonb(new) - array['status', 'void_date', 'void_journal_id', 'void_command_source',
            'void_idempotency_key', 'void_request_hash', 'voided_by_user_id', 'voided_by_email', 'voided_at'])
       = (to_jsonb(old) - array['status', 'void_date', 'void_journal_id', 'void_command_source',
            'void_idempotency_key', 'void_request_hash', 'voided_by_user_id', 'voided_by_email', 'voided_at']) then
    return new;
  end if;
  raise exception 'Customer payments can''t be changed, only voided once' using errcode = 'P0001';
end;
$$;

-- An invoice with active payments can't be voided; its payments are voided first.
create function toeyee_guard_paid_invoice_void() returns trigger
language plpgsql as $$
begin
  if old.status <> 'voided' and new.status = 'voided'
     and exists (select 1 from customer_payments where invoice_id = new.id and status = 'active') then
    raise exception 'Invoice % has payments against it, so it can''t be voided. Void its payments first',
      old.invoice_number using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create trigger customer_payments_check
  before insert on customer_payments
  for each row execute function toeyee_check_customer_payment();
create trigger customer_payments_guard
  before update or delete on customer_payments
  for each row execute function toeyee_guard_customer_payment();
create trigger customer_payments_no_truncate
  before truncate on customer_payments
  for each statement execute function toeyee_guard_customer_payment();
create trigger sales_invoices_payments_guard
  before update on sales_invoices
  for each row execute function toeyee_guard_paid_invoice_void();
`,
  },
  {
    version: "0005",
    name: "bills",
    sql: `
-- Journals posted by approving or voiding a bill.
alter table ledger_journals drop constraint ledger_journals_origin_check;
alter table ledger_journals add constraint ledger_journals_origin_check
  check (origin in ('manual', 'correction', 'inventory', 'fx_revaluation', 'invoice', 'customer_payment', 'bill'));

-- Bills post to accounts payable, found by role like accounts receivable.
-- New organisations get it from the default chart; existing ones get it here
-- if they still have the default account.
update accounts set system_key = 'accounts_payable', updated_at = now()
 where lower(code) = '2000' and account_class = 'liability' and system_key is null
   and not exists (select 1 from accounts where system_key = 'accounts_payable');

-- Bills from suppliers. A draft can be edited and deleted and posts nothing.
-- Approving posts Dr each line's account and GST / Cr accounts payable; after
-- that a bill can't change, only be voided, which posts the exact reversal.
-- The supplier's own invoice number is kept as it was typed.
create table bills (
  id bigserial primary key,
  command_source text not null,
  idempotency_key text not null,
  request_hash text not null,
  status text not null default 'draft' check (status in ('draft', 'approved', 'voided')),
  contact_id bigint not null references contacts(id),
  bill_date date not null,
  due_date date not null,
  supplier_invoice_number text not null
    check (length(supplier_invoice_number) between 1 and 100 and supplier_invoice_number ~ '[^[:space:]]'),
  amounts_mode text not null check (amounts_mode in ('exclusive', 'inclusive', 'no_tax')),
  currency_code text not null check (currency_code ~ '^[A-Z]{3}$'),
  subtotal numeric not null check (subtotal >= 0),
  tax_total numeric not null check (tax_total >= 0),
  total numeric not null check (total > 0),
  approval_journal_id bigint unique references ledger_journals(id),
  approve_command_source text,
  approve_idempotency_key text,
  approve_request_hash text,
  approved_by_user_id uuid,
  approved_by_email text,
  approved_at timestamptz,
  void_date date,
  void_journal_id bigint unique references ledger_journals(id),
  void_command_source text,
  void_idempotency_key text,
  void_request_hash text,
  voided_by_user_id uuid,
  voided_by_email text,
  voided_at timestamptz,
  created_by_user_id uuid,
  created_by_email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (command_source, idempotency_key),
  unique (approve_command_source, approve_idempotency_key),
  unique (void_command_source, void_idempotency_key),
  check (due_date >= bill_date),
  check (void_date is null or void_date >= bill_date),
  check (total = subtotal + tax_total),
  check (
    (status = 'draft'
      and approval_journal_id is null
      and approve_command_source is null and approve_idempotency_key is null
      and approve_request_hash is null and approved_at is null
      and void_date is null and void_journal_id is null and void_command_source is null
      and void_idempotency_key is null and void_request_hash is null and voided_at is null)
    or (status = 'approved'
      and approval_journal_id is not null
      and approve_command_source is not null and approve_idempotency_key is not null
      and approve_request_hash is not null and approved_at is not null
      and void_date is null and void_journal_id is null and void_command_source is null
      and void_idempotency_key is null and void_request_hash is null and voided_at is null)
    or (status = 'voided'
      and approval_journal_id is not null
      and approve_command_source is not null and approve_idempotency_key is not null
      and approve_request_hash is not null and approved_at is not null
      and void_date is not null and void_journal_id is not null and void_command_source is not null
      and void_idempotency_key is not null and void_request_hash is not null and voided_at is not null)
  )
);
create index bills_status_idx on bills (status, id);
create index bills_contact_idx on bills (contact_id);
-- A supplier can't have two bills that aren't voided (drafts included) with
-- the same invoice number, ignoring case and spaces: "inv 42" is "INV42".
create unique index bills_supplier_invoice_number_key
  on bills (contact_id, lower(regexp_replace(supplier_invoice_number, '[[:space:]]', '', 'g')))
  where status <> 'voided';

create table bill_lines (
  id bigserial primary key,
  bill_id bigint not null references bills(id),
  line_order integer not null check (line_order > 0),
  description text not null check (length(description) between 1 and 500),
  quantity numeric not null check (quantity > 0 and scale(quantity) <= 4),
  unit_price numeric not null check (unit_price > 0 and scale(unit_price) <= 4),
  account_id bigint not null references accounts(id),
  tax_code_id bigint references tax_codes(id),
  tax_rate numeric not null default 0 check (tax_rate >= 0 and tax_rate <= 1),
  line_amount numeric not null check (line_amount > 0),
  net_amount numeric not null check (net_amount >= 0),
  tax_amount numeric not null check (tax_amount >= 0),
  unique (bill_id, line_order),
  check (tax_code_id is not null or tax_rate = 0),
  check (net_amount = line_amount or net_amount + tax_amount = line_amount)
);
create index bill_lines_account_idx on bill_lines (account_id);

-- Drafts can be edited and deleted, but a draft is never voided (it's
-- deleted instead). Once approved, a bill can only be voided: nothing but its
-- status and void details may change, and it can't be deleted. Its lines are
-- frozen with it.
create function tohyee_guard_bill() returns trigger
language plpgsql as $$
begin
  if tg_op = 'TRUNCATE' then
    raise exception 'bills can''t be truncated' using errcode = 'P0001';
  end if;
  if old.status = 'draft' then
    if tg_op = 'DELETE' then
      return old;
    end if;
    if new.status = 'voided' then
      raise exception 'Bill #% is a draft, so it can''t be voided; delete it instead', old.id
        using errcode = 'P0001';
    end if;
    return new;
  end if;
  if tg_op = 'DELETE' then
    raise exception 'Bill #% is %, so it can''t be deleted', old.id, old.status using errcode = 'P0001';
  end if;
  if old.status = 'approved' and new.status = 'voided'
     and (to_jsonb(new) - array['status', 'void_date', 'void_journal_id', 'void_command_source',
            'void_idempotency_key', 'void_request_hash', 'voided_by_user_id', 'voided_by_email',
            'voided_at', 'updated_at'])
       = (to_jsonb(old) - array['status', 'void_date', 'void_journal_id', 'void_command_source',
            'void_idempotency_key', 'void_request_hash', 'voided_by_user_id', 'voided_by_email',
            'voided_at', 'updated_at']) then
    return new;
  end if;
  raise exception 'Bill #% is %, so it can''t be changed', old.id, old.status using errcode = 'P0001';
end;
$$;

create function tohyee_guard_bill_line() returns trigger
language plpgsql as $$
declare
  parent_status text;
begin
  if tg_op = 'TRUNCATE' then
    raise exception 'bill_lines can''t be truncated' using errcode = 'P0001';
  end if;
  if tg_op in ('UPDATE', 'DELETE') then
    select status into parent_status from bills where id = old.bill_id for share;
    if parent_status <> 'draft' then
      raise exception 'Lines of an approved or voided bill can''t be changed' using errcode = 'P0001';
    end if;
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    select status into parent_status from bills where id = new.bill_id for share;
    if parent_status <> 'draft' then
      raise exception 'Lines can only be added to a draft bill' using errcode = 'P0001';
    end if;
    return new;
  end if;
  return old;
end;
$$;

create trigger bills_guard
  before update or delete on bills
  for each row execute function tohyee_guard_bill();
create trigger bills_no_truncate
  before truncate on bills
  for each statement execute function tohyee_guard_bill();
create trigger bill_lines_guard
  before insert or update or delete on bill_lines
  for each row execute function tohyee_guard_bill_line();
create trigger bill_lines_no_truncate
  before truncate on bill_lines
  for each statement execute function tohyee_guard_bill_line();
`,
  },
  {
    version: "0006",
    name: "supplier_payments",
    sql: `
-- Journals posted by recording or voiding a supplier payment.
alter table ledger_journals drop constraint ledger_journals_origin_check;
alter table ledger_journals add constraint ledger_journals_origin_check
  check (origin in ('manual', 'correction', 'inventory', 'fx_revaluation', 'invoice', 'customer_payment', 'bill',
                    'supplier_payment'));

-- Money paid against one approved bill. Recording it posts Dr accounts
-- payable / Cr the bank account; voiding it posts the exact reversal. A
-- bill's amount due is its total less its active payments, worked out
-- whenever it's read and never stored.
create table supplier_payments (
  id bigserial primary key,
  command_source text not null,
  idempotency_key text not null,
  request_hash text not null,
  status text not null default 'active' check (status in ('active', 'voided')),
  bill_id bigint not null references bills(id),
  payment_date date not null,
  amount numeric not null check (amount > 0),
  currency_code text not null check (currency_code ~ '^[A-Z]{3}$'),
  bank_account_id bigint not null references accounts(id),
  reference text check (reference is null or length(reference) between 1 and 100),
  journal_id bigint not null unique references ledger_journals(id),
  created_by_user_id uuid,
  created_by_email text,
  created_at timestamptz not null default now(),
  void_date date,
  void_journal_id bigint unique references ledger_journals(id),
  void_command_source text,
  void_idempotency_key text,
  void_request_hash text,
  voided_by_user_id uuid,
  voided_by_email text,
  voided_at timestamptz,
  unique (command_source, idempotency_key),
  unique (void_command_source, void_idempotency_key),
  check (void_date is null or void_date >= payment_date),
  check (
    (status = 'active'
      and void_date is null and void_journal_id is null and void_command_source is null
      and void_idempotency_key is null and void_request_hash is null and voided_at is null)
    or (status = 'voided'
      and void_date is not null and void_journal_id is not null and void_command_source is not null
      and void_idempotency_key is not null and void_request_hash is not null and voided_at is not null)
  )
);
create index supplier_payments_bill_idx on supplier_payments (bill_id, id);
create index supplier_payments_bank_account_idx on supplier_payments (bank_account_id);

-- A payment is recorded as active, against an approved bill, in the bill's
-- currency and dated on or after it, and a bill's active payments can't add
-- up to more than its total (no overpayments yet). The bill stays locked
-- until the transaction ends, so two payments can't both take what's left.
create function tohyee_check_supplier_payment() returns trigger
language plpgsql as $$
declare
  bill record;
  paid numeric;
begin
  if new.status <> 'active' then
    raise exception 'A payment is recorded as active and voided afterwards' using errcode = 'P0001';
  end if;
  select id, status, bill_date, currency_code, total into bill
    from bills where id = new.bill_id for update;
  if not found then
    -- The foreign key refuses it.
    return new;
  end if;
  if bill.status <> 'approved' then
    raise exception 'Payments can only be recorded against approved bills' using errcode = 'P0001';
  end if;
  if new.currency_code <> bill.currency_code then
    raise exception 'A payment must be in its bill''s currency' using errcode = 'P0001';
  end if;
  if new.payment_date < bill.bill_date then
    raise exception 'A payment can''t be dated before its bill' using errcode = 'P0001';
  end if;
  select coalesce(sum(amount), 0) into paid
    from supplier_payments where bill_id = new.bill_id and status = 'active';
  if paid + new.amount > bill.total then
    raise exception 'Payments against bill #% can''t add up to more than its total', bill.id
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;

-- Payments can't be edited or deleted. Voiding one, once, only fills in its
-- void details.
create function tohyee_guard_supplier_payment() returns trigger
language plpgsql as $$
begin
  if tg_op = 'TRUNCATE' then
    raise exception 'supplier_payments can''t be truncated' using errcode = 'P0001';
  end if;
  if tg_op = 'DELETE' then
    raise exception 'Supplier payments can''t be deleted; void them instead' using errcode = 'P0001';
  end if;
  if old.status = 'active' and new.status = 'voided'
     and (to_jsonb(new) - array['status', 'void_date', 'void_journal_id', 'void_command_source',
            'void_idempotency_key', 'void_request_hash', 'voided_by_user_id', 'voided_by_email', 'voided_at'])
       = (to_jsonb(old) - array['status', 'void_date', 'void_journal_id', 'void_command_source',
            'void_idempotency_key', 'void_request_hash', 'voided_by_user_id', 'voided_by_email', 'voided_at']) then
    return new;
  end if;
  raise exception 'Supplier payments can''t be changed, only voided once' using errcode = 'P0001';
end;
$$;

-- A bill with active payments can't be voided; its payments are voided first.
create function tohyee_guard_paid_bill_void() returns trigger
language plpgsql as $$
begin
  if old.status <> 'voided' and new.status = 'voided'
     and exists (select 1 from supplier_payments where bill_id = new.id and status = 'active') then
    raise exception 'Bill #% has payments against it, so it can''t be voided. Void its payments first',
      old.id using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create trigger supplier_payments_check
  before insert on supplier_payments
  for each row execute function tohyee_check_supplier_payment();
create trigger supplier_payments_guard
  before update or delete on supplier_payments
  for each row execute function tohyee_guard_supplier_payment();
create trigger supplier_payments_no_truncate
  before truncate on supplier_payments
  for each statement execute function tohyee_guard_supplier_payment();
create trigger bills_payments_guard
  before update on bills
  for each row execute function tohyee_guard_paid_bill_void();
`,
  },
  {
    version: "0007",
    name: "sales_credit_notes",
    sql: `
-- Journals posted by approving or voiding a sales credit note, and by
-- refunding a credit note's remaining credit or voiding that refund.
alter table ledger_journals drop constraint ledger_journals_origin_check;
alter table ledger_journals add constraint ledger_journals_origin_check
  check (origin in ('manual', 'correction', 'inventory', 'fx_revaluation', 'invoice', 'customer_payment', 'bill',
                    'supplier_payment', 'sales_credit_note', 'sales_credit_note_refund'));

-- Credit note numbers (CN-0001, ...) are taken on approval from their own
-- counter, separate from invoice numbers. The row stays locked until the
-- approval commits, and a refused or failed approval rolls it back, so
-- numbers have no gaps.
create table sales_credit_note_numbering (
  id boolean primary key default true check (id),
  last_number integer not null default 0 check (last_number >= 0)
);
insert into sales_credit_note_numbering (id) values (true);

create function tohyee_guard_credit_note_numbering() returns trigger
language plpgsql as $$
begin
  if tg_op = 'UPDATE' then
    if new.last_number = old.last_number + 1 then
      return new;
    end if;
  end if;
  raise exception 'Credit note numbers only move forward one at a time' using errcode = 'P0001';
end;
$$;

create trigger sales_credit_note_numbering_guard
  before update or delete on sales_credit_note_numbering
  for each row execute function tohyee_guard_credit_note_numbering();
create trigger sales_credit_note_numbering_no_truncate
  before truncate on sales_credit_note_numbering
  for each statement execute function tohyee_guard_credit_note_numbering();

-- Sales credit notes to customers. A draft can be edited and deleted and
-- posts nothing. Approving numbers it and posts Dr each line's account and
-- GST / Cr accounts receivable; after that it can't change, only be voided,
-- which posts the exact reversal. What's been applied, refunded and is left
-- is worked out from its applications and refunds whenever it's read.
create table sales_credit_notes (
  id bigserial primary key,
  command_source text not null,
  idempotency_key text not null,
  request_hash text not null,
  status text not null default 'draft' check (status in ('draft', 'approved', 'voided')),
  contact_id bigint not null references contacts(id),
  credit_note_date date not null,
  reference text check (reference is null or length(reference) between 1 and 100),
  amounts_mode text not null check (amounts_mode in ('exclusive', 'inclusive', 'no_tax')),
  currency_code text not null check (currency_code ~ '^[A-Z]{3}$'),
  subtotal numeric not null check (subtotal >= 0),
  tax_total numeric not null check (tax_total >= 0),
  total numeric not null check (total > 0),
  credit_note_sequence integer unique check (credit_note_sequence > 0),
  credit_note_number text unique,
  approval_journal_id bigint unique references ledger_journals(id),
  approve_command_source text,
  approve_idempotency_key text,
  approve_request_hash text,
  approved_by_user_id uuid,
  approved_by_email text,
  approved_at timestamptz,
  void_date date,
  void_journal_id bigint unique references ledger_journals(id),
  void_command_source text,
  void_idempotency_key text,
  void_request_hash text,
  voided_by_user_id uuid,
  voided_by_email text,
  voided_at timestamptz,
  created_by_user_id uuid,
  created_by_email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (command_source, idempotency_key),
  unique (approve_command_source, approve_idempotency_key),
  unique (void_command_source, void_idempotency_key),
  check (void_date is null or void_date >= credit_note_date),
  check (total = subtotal + tax_total),
  check (
    credit_note_number is null
    or credit_note_number = 'CN-' || lpad(credit_note_sequence::text, greatest(4, length(credit_note_sequence::text)), '0')
  ),
  check (
    (status = 'draft'
      and credit_note_sequence is null and credit_note_number is null and approval_journal_id is null
      and approve_command_source is null and approve_idempotency_key is null
      and approve_request_hash is null and approved_at is null
      and void_date is null and void_journal_id is null and void_command_source is null
      and void_idempotency_key is null and void_request_hash is null and voided_at is null)
    or (status = 'approved'
      and credit_note_sequence is not null and credit_note_number is not null and approval_journal_id is not null
      and approve_command_source is not null and approve_idempotency_key is not null
      and approve_request_hash is not null and approved_at is not null
      and void_date is null and void_journal_id is null and void_command_source is null
      and void_idempotency_key is null and void_request_hash is null and voided_at is null)
    or (status = 'voided'
      and credit_note_sequence is not null and credit_note_number is not null and approval_journal_id is not null
      and approve_command_source is not null and approve_idempotency_key is not null
      and approve_request_hash is not null and approved_at is not null
      and void_date is not null and void_journal_id is not null and void_command_source is not null
      and void_idempotency_key is not null and void_request_hash is not null and voided_at is not null)
  )
);
create index sales_credit_notes_status_idx on sales_credit_notes (status, id);
create index sales_credit_notes_contact_idx on sales_credit_notes (contact_id);

create table sales_credit_note_lines (
  id bigserial primary key,
  credit_note_id bigint not null references sales_credit_notes(id),
  line_order integer not null check (line_order > 0),
  description text not null check (length(description) between 1 and 500),
  quantity numeric not null check (quantity > 0 and scale(quantity) <= 4),
  unit_price numeric not null check (unit_price > 0 and scale(unit_price) <= 4),
  account_id bigint not null references accounts(id),
  tax_code_id bigint references tax_codes(id),
  tax_rate numeric not null default 0 check (tax_rate >= 0 and tax_rate <= 1),
  line_amount numeric not null check (line_amount > 0),
  net_amount numeric not null check (net_amount >= 0),
  tax_amount numeric not null check (tax_amount >= 0),
  unique (credit_note_id, line_order),
  check (tax_code_id is not null or tax_rate = 0),
  check (net_amount = line_amount or net_amount + tax_amount = line_amount)
);
create index sales_credit_note_lines_account_idx on sales_credit_note_lines (account_id);

-- Approved credit applied to an approved invoice of the same customer and
-- currency. Applying posts no journal (both sides are accounts receivable);
-- it only lowers the invoice's amount due and the credit note's remaining
-- credit. One command can apply credit to several invoices, so its
-- idempotency key is shared by those rows, once per invoice. Removing an
-- application, once, fills in its removal details; rows are never deleted.
create table sales_credit_note_applications (
  id bigserial primary key,
  command_source text not null,
  idempotency_key text not null,
  request_hash text not null,
  status text not null default 'active' check (status in ('active', 'removed')),
  credit_note_id bigint not null references sales_credit_notes(id),
  invoice_id bigint not null references sales_invoices(id),
  application_date date not null,
  amount numeric not null check (amount > 0),
  currency_code text not null check (currency_code ~ '^[A-Z]{3}$'),
  created_by_user_id uuid,
  created_by_email text,
  created_at timestamptz not null default now(),
  removal_date date,
  removal_command_source text,
  removal_idempotency_key text,
  removal_request_hash text,
  removed_by_user_id uuid,
  removed_by_email text,
  removed_at timestamptz,
  unique (command_source, idempotency_key, invoice_id),
  unique (removal_command_source, removal_idempotency_key),
  check (removal_date is null or removal_date >= application_date),
  check (
    (status = 'active'
      and removal_date is null and removal_command_source is null and removal_idempotency_key is null
      and removal_request_hash is null and removed_at is null)
    or (status = 'removed'
      and removal_date is not null and removal_command_source is not null and removal_idempotency_key is not null
      and removal_request_hash is not null and removed_at is not null)
  )
);
create index sales_credit_note_applications_credit_note_idx on sales_credit_note_applications (credit_note_id, id);
create index sales_credit_note_applications_invoice_idx on sales_credit_note_applications (invoice_id, id);

-- Remaining credit paid back to the customer. Recording a refund posts
-- Dr accounts receivable / Cr the bank account; voiding it posts the exact
-- reversal.
create table sales_credit_note_refunds (
  id bigserial primary key,
  command_source text not null,
  idempotency_key text not null,
  request_hash text not null,
  status text not null default 'active' check (status in ('active', 'voided')),
  credit_note_id bigint not null references sales_credit_notes(id),
  refund_date date not null,
  amount numeric not null check (amount > 0),
  currency_code text not null check (currency_code ~ '^[A-Z]{3}$'),
  bank_account_id bigint not null references accounts(id),
  reference text check (reference is null or length(reference) between 1 and 100),
  journal_id bigint not null unique references ledger_journals(id),
  created_by_user_id uuid,
  created_by_email text,
  created_at timestamptz not null default now(),
  void_date date,
  void_journal_id bigint unique references ledger_journals(id),
  void_command_source text,
  void_idempotency_key text,
  void_request_hash text,
  voided_by_user_id uuid,
  voided_by_email text,
  voided_at timestamptz,
  unique (command_source, idempotency_key),
  unique (void_command_source, void_idempotency_key),
  check (void_date is null or void_date >= refund_date),
  check (
    (status = 'active'
      and void_date is null and void_journal_id is null and void_command_source is null
      and void_idempotency_key is null and void_request_hash is null and voided_at is null)
    or (status = 'voided'
      and void_date is not null and void_journal_id is not null and void_command_source is not null
      and void_idempotency_key is not null and void_request_hash is not null and voided_at is not null)
  )
);
create index sales_credit_note_refunds_credit_note_idx on sales_credit_note_refunds (credit_note_id, id);
create index sales_credit_note_refunds_bank_account_idx on sales_credit_note_refunds (bank_account_id);

-- Drafts can be edited and deleted, but a draft is never voided (it's
-- deleted instead). Once approved, a credit note can only be voided: nothing
-- but its status and void details may change, and it can't be deleted. Its
-- lines are frozen with it.
create function tohyee_guard_sales_credit_note() returns trigger
language plpgsql as $$
begin
  if tg_op = 'TRUNCATE' then
    raise exception 'sales_credit_notes can''t be truncated' using errcode = 'P0001';
  end if;
  if old.status = 'draft' then
    if tg_op = 'DELETE' then
      return old;
    end if;
    if new.status = 'voided' then
      raise exception 'Credit note #% is a draft, so it can''t be voided; delete it instead', old.id
        using errcode = 'P0001';
    end if;
    return new;
  end if;
  if tg_op = 'DELETE' then
    raise exception 'Credit note % is %, so it can''t be deleted', old.credit_note_number, old.status
      using errcode = 'P0001';
  end if;
  if old.status = 'approved' and new.status = 'voided'
     and (to_jsonb(new) - array['status', 'void_date', 'void_journal_id', 'void_command_source',
            'void_idempotency_key', 'void_request_hash', 'voided_by_user_id', 'voided_by_email',
            'voided_at', 'updated_at'])
       = (to_jsonb(old) - array['status', 'void_date', 'void_journal_id', 'void_command_source',
            'void_idempotency_key', 'void_request_hash', 'voided_by_user_id', 'voided_by_email',
            'voided_at', 'updated_at']) then
    if exists (select 1 from sales_credit_note_applications where credit_note_id = old.id and status = 'active')
       or exists (select 1 from sales_credit_note_refunds where credit_note_id = old.id and status = 'active') then
      raise exception 'Credit note % has credit applied or refunded, so it can''t be voided. Remove its applications and refunds first',
        old.credit_note_number using errcode = 'P0001';
    end if;
    return new;
  end if;
  raise exception 'Credit note % is %, so it can''t be changed', old.credit_note_number, old.status
    using errcode = 'P0001';
end;
$$;

create function tohyee_guard_sales_credit_note_line() returns trigger
language plpgsql as $$
declare
  parent_status text;
begin
  if tg_op = 'TRUNCATE' then
    raise exception 'sales_credit_note_lines can''t be truncated' using errcode = 'P0001';
  end if;
  if tg_op in ('UPDATE', 'DELETE') then
    select status into parent_status from sales_credit_notes where id = old.credit_note_id for share;
    if parent_status <> 'draft' then
      raise exception 'Lines of an approved or voided credit note can''t be changed' using errcode = 'P0001';
    end if;
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    select status into parent_status from sales_credit_notes where id = new.credit_note_id for share;
    if parent_status <> 'draft' then
      raise exception 'Lines can only be added to a draft credit note' using errcode = 'P0001';
    end if;
    return new;
  end if;
  return old;
end;
$$;

-- An application is recorded as active, from an approved credit note to an
-- approved invoice of the same customer and currency, dated on or after
-- both. The invoice's active payments and applications can't add up to more
-- than its total, and the credit note's active applications and refunds
-- can't add up to more than its total. Both rows stay locked until the
-- transaction ends, so two commands can't both take what's left.
create function tohyee_check_credit_note_application() returns trigger
language plpgsql as $$
declare
  credit_note record;
  invoice record;
  used numeric;
begin
  if new.status <> 'active' then
    raise exception 'An application is recorded as active and removed afterwards' using errcode = 'P0001';
  end if;
  select status, credit_note_number, contact_id, credit_note_date, currency_code, total into credit_note
    from sales_credit_notes where id = new.credit_note_id for update;
  if not found then
    -- The foreign key refuses it.
    return new;
  end if;
  select status, invoice_number, contact_id, invoice_date, currency_code, total into invoice
    from sales_invoices where id = new.invoice_id for update;
  if not found then
    return new;
  end if;
  if credit_note.status <> 'approved' then
    raise exception 'Only approved credit notes can be applied' using errcode = 'P0001';
  end if;
  if invoice.status <> 'approved' then
    raise exception 'Credit can only be applied to approved invoices' using errcode = 'P0001';
  end if;
  if invoice.contact_id <> credit_note.contact_id then
    raise exception 'Credit can only be applied to invoices of the same customer' using errcode = 'P0001';
  end if;
  if new.currency_code <> credit_note.currency_code or new.currency_code <> invoice.currency_code then
    raise exception 'Credit can only be applied in the credit note''s and invoice''s currency' using errcode = 'P0001';
  end if;
  if new.application_date < credit_note.credit_note_date or new.application_date < invoice.invoice_date then
    raise exception 'An application can''t be dated before its credit note or invoice' using errcode = 'P0001';
  end if;
  select coalesce((select sum(amount) from customer_payments where invoice_id = new.invoice_id and status = 'active'), 0)
       + coalesce((select sum(amount) from sales_credit_note_applications
                    where invoice_id = new.invoice_id and status = 'active'), 0)
    into used;
  if used + new.amount > invoice.total then
    raise exception 'Payments and credit applied to invoice % can''t add up to more than its total', invoice.invoice_number
      using errcode = 'P0001';
  end if;
  select coalesce((select sum(amount) from sales_credit_note_applications
                    where credit_note_id = new.credit_note_id and status = 'active'), 0)
       + coalesce((select sum(amount) from sales_credit_note_refunds
                    where credit_note_id = new.credit_note_id and status = 'active'), 0)
    into used;
  if used + new.amount > credit_note.total then
    raise exception 'Credit applied and refunded from credit note % can''t add up to more than its total',
      credit_note.credit_note_number using errcode = 'P0001';
  end if;
  return new;
end;
$$;

-- Applications can't be edited or deleted. Removing one, once, only fills in
-- its removal details.
create function tohyee_guard_credit_note_application() returns trigger
language plpgsql as $$
begin
  if tg_op = 'TRUNCATE' then
    raise exception 'sales_credit_note_applications can''t be truncated' using errcode = 'P0001';
  end if;
  if tg_op = 'DELETE' then
    raise exception 'Credit note applications can''t be deleted; remove them instead' using errcode = 'P0001';
  end if;
  if old.status = 'active' and new.status = 'removed'
     and (to_jsonb(new) - array['status', 'removal_date', 'removal_command_source', 'removal_idempotency_key',
            'removal_request_hash', 'removed_by_user_id', 'removed_by_email', 'removed_at'])
       = (to_jsonb(old) - array['status', 'removal_date', 'removal_command_source', 'removal_idempotency_key',
            'removal_request_hash', 'removed_by_user_id', 'removed_by_email', 'removed_at']) then
    return new;
  end if;
  raise exception 'Credit note applications can''t be changed, only removed once' using errcode = 'P0001';
end;
$$;

-- A refund is recorded as active, from an approved credit note, in its
-- currency and dated on or after it, and the credit note's active
-- applications and refunds can't add up to more than its total.
create function tohyee_check_credit_note_refund() returns trigger
language plpgsql as $$
declare
  credit_note record;
  used numeric;
begin
  if new.status <> 'active' then
    raise exception 'A refund is recorded as active and voided afterwards' using errcode = 'P0001';
  end if;
  select status, credit_note_number, credit_note_date, currency_code, total into credit_note
    from sales_credit_notes where id = new.credit_note_id for update;
  if not found then
    return new;
  end if;
  if credit_note.status <> 'approved' then
    raise exception 'Refunds can only be made from approved credit notes' using errcode = 'P0001';
  end if;
  if new.currency_code <> credit_note.currency_code then
    raise exception 'A refund must be in its credit note''s currency' using errcode = 'P0001';
  end if;
  if new.refund_date < credit_note.credit_note_date then
    raise exception 'A refund can''t be dated before its credit note' using errcode = 'P0001';
  end if;
  select coalesce((select sum(amount) from sales_credit_note_applications
                    where credit_note_id = new.credit_note_id and status = 'active'), 0)
       + coalesce((select sum(amount) from sales_credit_note_refunds
                    where credit_note_id = new.credit_note_id and status = 'active'), 0)
    into used;
  if used + new.amount > credit_note.total then
    raise exception 'Credit applied and refunded from credit note % can''t add up to more than its total',
      credit_note.credit_note_number using errcode = 'P0001';
  end if;
  return new;
end;
$$;

-- Refunds can't be edited or deleted. Voiding one, once, only fills in its
-- void details.
create function tohyee_guard_credit_note_refund() returns trigger
language plpgsql as $$
begin
  if tg_op = 'TRUNCATE' then
    raise exception 'sales_credit_note_refunds can''t be truncated' using errcode = 'P0001';
  end if;
  if tg_op = 'DELETE' then
    raise exception 'Credit note refunds can''t be deleted; void them instead' using errcode = 'P0001';
  end if;
  if old.status = 'active' and new.status = 'voided'
     and (to_jsonb(new) - array['status', 'void_date', 'void_journal_id', 'void_command_source',
            'void_idempotency_key', 'void_request_hash', 'voided_by_user_id', 'voided_by_email', 'voided_at'])
       = (to_jsonb(old) - array['status', 'void_date', 'void_journal_id', 'void_command_source',
            'void_idempotency_key', 'void_request_hash', 'voided_by_user_id', 'voided_by_email', 'voided_at']) then
    return new;
  end if;
  raise exception 'Credit note refunds can''t be changed, only voided once' using errcode = 'P0001';
end;
$$;

-- An invoice with active credit applied can't be voided; its credit is
-- removed first.
create function tohyee_guard_credited_invoice_void() returns trigger
language plpgsql as $$
begin
  if old.status <> 'voided' and new.status = 'voided'
     and exists (select 1 from sales_credit_note_applications where invoice_id = new.id and status = 'active') then
    raise exception 'Invoice % has credit applied to it, so it can''t be voided. Remove its credit first',
      old.invoice_number using errcode = 'P0001';
  end if;
  return new;
end;
$$;

-- A payment can't take an invoice's active payments and applied credit to
-- more than its total.
create or replace function toeyee_check_customer_payment() returns trigger
language plpgsql as $$
declare
  invoice record;
  paid numeric;
begin
  if new.status <> 'active' then
    raise exception 'A payment is recorded as active and voided afterwards' using errcode = 'P0001';
  end if;
  select status, invoice_number, invoice_date, currency_code, total into invoice
    from sales_invoices where id = new.invoice_id for update;
  if not found then
    -- The foreign key refuses it.
    return new;
  end if;
  if invoice.status <> 'approved' then
    raise exception 'Payments can only be recorded against approved invoices' using errcode = 'P0001';
  end if;
  if new.currency_code <> invoice.currency_code then
    raise exception 'A payment must be in its invoice''s currency' using errcode = 'P0001';
  end if;
  if new.payment_date < invoice.invoice_date then
    raise exception 'A payment can''t be dated before its invoice' using errcode = 'P0001';
  end if;
  select coalesce((select sum(amount) from customer_payments where invoice_id = new.invoice_id and status = 'active'), 0)
       + coalesce((select sum(amount) from sales_credit_note_applications
                    where invoice_id = new.invoice_id and status = 'active'), 0)
    into paid;
  if paid + new.amount > invoice.total then
    raise exception 'Payments against invoice % can''t add up to more than its total', invoice.invoice_number
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create trigger sales_credit_notes_guard
  before update or delete on sales_credit_notes
  for each row execute function tohyee_guard_sales_credit_note();
create trigger sales_credit_notes_no_truncate
  before truncate on sales_credit_notes
  for each statement execute function tohyee_guard_sales_credit_note();
create trigger sales_credit_note_lines_guard
  before insert or update or delete on sales_credit_note_lines
  for each row execute function tohyee_guard_sales_credit_note_line();
create trigger sales_credit_note_lines_no_truncate
  before truncate on sales_credit_note_lines
  for each statement execute function tohyee_guard_sales_credit_note_line();
create trigger sales_credit_note_applications_check
  before insert on sales_credit_note_applications
  for each row execute function tohyee_check_credit_note_application();
create trigger sales_credit_note_applications_guard
  before update or delete on sales_credit_note_applications
  for each row execute function tohyee_guard_credit_note_application();
create trigger sales_credit_note_applications_no_truncate
  before truncate on sales_credit_note_applications
  for each statement execute function tohyee_guard_credit_note_application();
create trigger sales_credit_note_refunds_check
  before insert on sales_credit_note_refunds
  for each row execute function tohyee_check_credit_note_refund();
create trigger sales_credit_note_refunds_guard
  before update or delete on sales_credit_note_refunds
  for each row execute function tohyee_guard_credit_note_refund();
create trigger sales_credit_note_refunds_no_truncate
  before truncate on sales_credit_note_refunds
  for each statement execute function tohyee_guard_credit_note_refund();
create trigger sales_invoices_credit_guard
  before update on sales_invoices
  for each row execute function tohyee_guard_credited_invoice_void();
`,
  },
];
