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
 *   only against approved invoices, the part that pays the invoice never
 *   takes it past its total (the rest is an overpayment), and an invoice
 *   with active payments can't be voided;
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
 *   voided;
 * - approved supplier credit notes and their lines can't be edited or
 *   deleted, only voided (not while credit is applied or refunded), and a
 *   supplier can't have two that aren't voided with the same number,
 *   ignoring case and spaces;
 * - supplier credit note applications can only be removed once and refunds
 *   only voided once; a bill's active payments and applied credit never add
 *   up to more than its total, a supplier credit note's applied and refunded
 *   credit never more than its total, and a bill with credit applied can't
 *   be voided;
 * - an overpayment is exactly what a payment paid beyond its invoice's
 *   amount due; overpayment applications can only be removed once and
 *   refunds only voided once; applied and refunded overpayment never adds up
 *   to more than the overpayment, a payment whose overpayment is used can't
 *   be voided, and an invoice with overpayment credit applied can't be
 *   voided;
 * - statement lines on bank and credit card accounts can't be changed or
 *   deleted, only reconciled, excluded or deleted with their import; an
 *   active reconciliation adds up to its line and only uses journal lines on
 *   the line's account, each once; a reconciled journal can't be reversed;
 *   bank transactions and transfers can't be edited or deleted, only voided
 *   once;
 * - filed GST returns, their adjustments and their snapshot lines can't be
 *   changed, deleted or truncated, their boxes add up (checked at commit),
 *   and no two filed returns cover the same day.
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
  {
    version: "0008",
    name: "supplier_credit_notes",
    sql: `
-- Journals posted by approving or voiding a supplier credit note, and by
-- recording a refund received from the supplier or voiding that refund.
alter table ledger_journals drop constraint ledger_journals_origin_check;
alter table ledger_journals add constraint ledger_journals_origin_check
  check (origin in ('manual', 'correction', 'inventory', 'fx_revaluation', 'invoice', 'customer_payment', 'bill',
                    'supplier_payment', 'sales_credit_note', 'sales_credit_note_refund',
                    'supplier_credit_note', 'supplier_credit_note_refund'));

-- Credit notes from suppliers. A draft can be edited and deleted and posts
-- nothing. Approving posts Dr accounts payable / Cr each line's account and
-- GST; after that it can't change, only be voided, which posts the exact
-- reversal. The supplier's own credit note number is kept as it was typed.
-- What's been applied, refunded and is left is worked out from its
-- applications and refunds whenever it's read.
create table supplier_credit_notes (
  id bigserial primary key,
  command_source text not null,
  idempotency_key text not null,
  request_hash text not null,
  status text not null default 'draft' check (status in ('draft', 'approved', 'voided')),
  contact_id bigint not null references contacts(id),
  credit_note_date date not null,
  supplier_credit_note_number text not null
    check (length(supplier_credit_note_number) between 1 and 100 and supplier_credit_note_number ~ '[^[:space:]]'),
  reference text check (reference is null or length(reference) between 1 and 100),
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
  check (void_date is null or void_date >= credit_note_date),
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
create index supplier_credit_notes_status_idx on supplier_credit_notes (status, id);
create index supplier_credit_notes_contact_idx on supplier_credit_notes (contact_id);
-- A supplier can't have two credit notes that aren't voided (drafts
-- included) with the same number, ignoring case and spaces: "cr 7" is "CR7".
-- Bill numbers are separate.
create unique index supplier_credit_notes_number_key
  on supplier_credit_notes (contact_id, lower(regexp_replace(supplier_credit_note_number, '[[:space:]]', '', 'g')))
  where status <> 'voided';

create table supplier_credit_note_lines (
  id bigserial primary key,
  credit_note_id bigint not null references supplier_credit_notes(id),
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
create index supplier_credit_note_lines_account_idx on supplier_credit_note_lines (account_id);

-- Approved credit applied to an approved bill of the same supplier and
-- currency. Applying posts no journal (both sides are accounts payable); it
-- only lowers the bill's amount due and the credit note's remaining credit.
-- One command can apply credit to several bills, so its idempotency key is
-- shared by those rows, once per bill. Removing an application, once, fills
-- in its removal details; rows are never deleted.
create table supplier_credit_note_applications (
  id bigserial primary key,
  command_source text not null,
  idempotency_key text not null,
  request_hash text not null,
  status text not null default 'active' check (status in ('active', 'removed')),
  credit_note_id bigint not null references supplier_credit_notes(id),
  bill_id bigint not null references bills(id),
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
  unique (command_source, idempotency_key, bill_id),
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
create index supplier_credit_note_applications_credit_note_idx on supplier_credit_note_applications (credit_note_id, id);
create index supplier_credit_note_applications_bill_idx on supplier_credit_note_applications (bill_id, id);

-- Remaining credit paid back by the supplier. Recording a refund posts
-- Dr the bank account / Cr accounts payable; voiding it posts the exact
-- reversal.
create table supplier_credit_note_refunds (
  id bigserial primary key,
  command_source text not null,
  idempotency_key text not null,
  request_hash text not null,
  status text not null default 'active' check (status in ('active', 'voided')),
  credit_note_id bigint not null references supplier_credit_notes(id),
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
create index supplier_credit_note_refunds_credit_note_idx on supplier_credit_note_refunds (credit_note_id, id);
create index supplier_credit_note_refunds_bank_account_idx on supplier_credit_note_refunds (bank_account_id);

-- Drafts can be edited and deleted, but a draft is never voided (it's
-- deleted instead). Once approved, a credit note can only be voided: nothing
-- but its status and void details may change, and it can't be deleted. Its
-- lines are frozen with it.
create function tohyee_guard_supplier_credit_note() returns trigger
language plpgsql as $$
begin
  if tg_op = 'TRUNCATE' then
    raise exception 'supplier_credit_notes can''t be truncated' using errcode = 'P0001';
  end if;
  if old.status = 'draft' then
    if tg_op = 'DELETE' then
      return old;
    end if;
    if new.status = 'voided' then
      raise exception 'Supplier credit note #% is a draft, so it can''t be voided; delete it instead', old.id
        using errcode = 'P0001';
    end if;
    return new;
  end if;
  if tg_op = 'DELETE' then
    raise exception 'Supplier credit note #% is %, so it can''t be deleted', old.id, old.status
      using errcode = 'P0001';
  end if;
  if old.status = 'approved' and new.status = 'voided'
     and (to_jsonb(new) - array['status', 'void_date', 'void_journal_id', 'void_command_source',
            'void_idempotency_key', 'void_request_hash', 'voided_by_user_id', 'voided_by_email',
            'voided_at', 'updated_at'])
       = (to_jsonb(old) - array['status', 'void_date', 'void_journal_id', 'void_command_source',
            'void_idempotency_key', 'void_request_hash', 'voided_by_user_id', 'voided_by_email',
            'voided_at', 'updated_at']) then
    if exists (select 1 from supplier_credit_note_applications where credit_note_id = old.id and status = 'active')
       or exists (select 1 from supplier_credit_note_refunds where credit_note_id = old.id and status = 'active') then
      raise exception 'Supplier credit note #% has credit applied or refunded, so it can''t be voided. Remove its applications and refunds first',
        old.id using errcode = 'P0001';
    end if;
    return new;
  end if;
  raise exception 'Supplier credit note #% is %, so it can''t be changed', old.id, old.status
    using errcode = 'P0001';
end;
$$;

create function tohyee_guard_supplier_credit_note_line() returns trigger
language plpgsql as $$
declare
  parent_status text;
begin
  if tg_op = 'TRUNCATE' then
    raise exception 'supplier_credit_note_lines can''t be truncated' using errcode = 'P0001';
  end if;
  if tg_op in ('UPDATE', 'DELETE') then
    select status into parent_status from supplier_credit_notes where id = old.credit_note_id for share;
    if parent_status <> 'draft' then
      raise exception 'Lines of an approved or voided supplier credit note can''t be changed' using errcode = 'P0001';
    end if;
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    select status into parent_status from supplier_credit_notes where id = new.credit_note_id for share;
    if parent_status <> 'draft' then
      raise exception 'Lines can only be added to a draft supplier credit note' using errcode = 'P0001';
    end if;
    return new;
  end if;
  return old;
end;
$$;

-- An application is recorded as active, from an approved supplier credit
-- note to an approved bill of the same supplier and currency, dated on or
-- after both. The bill's active payments and applications can't add up to
-- more than its total, and the credit note's active applications and refunds
-- can't add up to more than its total. Both rows stay locked until the
-- transaction ends, so two commands can't both take what's left.
create function tohyee_check_supplier_credit_note_application() returns trigger
language plpgsql as $$
declare
  credit_note record;
  bill record;
  used numeric;
begin
  if new.status <> 'active' then
    raise exception 'An application is recorded as active and removed afterwards' using errcode = 'P0001';
  end if;
  select id, status, contact_id, credit_note_date, currency_code, total into credit_note
    from supplier_credit_notes where id = new.credit_note_id for update;
  if not found then
    -- The foreign key refuses it.
    return new;
  end if;
  select id, status, contact_id, bill_date, currency_code, total into bill
    from bills where id = new.bill_id for update;
  if not found then
    return new;
  end if;
  if credit_note.status <> 'approved' then
    raise exception 'Only approved supplier credit notes can be applied' using errcode = 'P0001';
  end if;
  if bill.status <> 'approved' then
    raise exception 'Credit can only be applied to approved bills' using errcode = 'P0001';
  end if;
  if bill.contact_id <> credit_note.contact_id then
    raise exception 'Credit can only be applied to bills of the same supplier' using errcode = 'P0001';
  end if;
  if new.currency_code <> credit_note.currency_code or new.currency_code <> bill.currency_code then
    raise exception 'Credit can only be applied in the credit note''s and bill''s currency' using errcode = 'P0001';
  end if;
  if new.application_date < credit_note.credit_note_date or new.application_date < bill.bill_date then
    raise exception 'An application can''t be dated before its credit note or bill' using errcode = 'P0001';
  end if;
  select coalesce((select sum(amount) from supplier_payments where bill_id = new.bill_id and status = 'active'), 0)
       + coalesce((select sum(amount) from supplier_credit_note_applications
                    where bill_id = new.bill_id and status = 'active'), 0)
    into used;
  if used + new.amount > bill.total then
    raise exception 'Payments and credit applied to bill #% can''t add up to more than its total', bill.id
      using errcode = 'P0001';
  end if;
  select coalesce((select sum(amount) from supplier_credit_note_applications
                    where credit_note_id = new.credit_note_id and status = 'active'), 0)
       + coalesce((select sum(amount) from supplier_credit_note_refunds
                    where credit_note_id = new.credit_note_id and status = 'active'), 0)
    into used;
  if used + new.amount > credit_note.total then
    raise exception 'Credit applied and refunded from supplier credit note #% can''t add up to more than its total',
      credit_note.id using errcode = 'P0001';
  end if;
  return new;
end;
$$;

-- Applications can't be edited or deleted. Removing one, once, only fills in
-- its removal details.
create function tohyee_guard_supplier_credit_note_application() returns trigger
language plpgsql as $$
begin
  if tg_op = 'TRUNCATE' then
    raise exception 'supplier_credit_note_applications can''t be truncated' using errcode = 'P0001';
  end if;
  if tg_op = 'DELETE' then
    raise exception 'Supplier credit note applications can''t be deleted; remove them instead' using errcode = 'P0001';
  end if;
  if old.status = 'active' and new.status = 'removed'
     and (to_jsonb(new) - array['status', 'removal_date', 'removal_command_source', 'removal_idempotency_key',
            'removal_request_hash', 'removed_by_user_id', 'removed_by_email', 'removed_at'])
       = (to_jsonb(old) - array['status', 'removal_date', 'removal_command_source', 'removal_idempotency_key',
            'removal_request_hash', 'removed_by_user_id', 'removed_by_email', 'removed_at']) then
    return new;
  end if;
  raise exception 'Supplier credit note applications can''t be changed, only removed once' using errcode = 'P0001';
end;
$$;

-- A refund is recorded as active, from an approved supplier credit note, in
-- its currency and dated on or after it, and the credit note's active
-- applications and refunds can't add up to more than its total.
create function tohyee_check_supplier_credit_note_refund() returns trigger
language plpgsql as $$
declare
  credit_note record;
  used numeric;
begin
  if new.status <> 'active' then
    raise exception 'A refund is recorded as active and voided afterwards' using errcode = 'P0001';
  end if;
  select id, status, credit_note_date, currency_code, total into credit_note
    from supplier_credit_notes where id = new.credit_note_id for update;
  if not found then
    return new;
  end if;
  if credit_note.status <> 'approved' then
    raise exception 'Refunds can only be received for approved supplier credit notes' using errcode = 'P0001';
  end if;
  if new.currency_code <> credit_note.currency_code then
    raise exception 'A refund must be in its credit note''s currency' using errcode = 'P0001';
  end if;
  if new.refund_date < credit_note.credit_note_date then
    raise exception 'A refund can''t be dated before its credit note' using errcode = 'P0001';
  end if;
  select coalesce((select sum(amount) from supplier_credit_note_applications
                    where credit_note_id = new.credit_note_id and status = 'active'), 0)
       + coalesce((select sum(amount) from supplier_credit_note_refunds
                    where credit_note_id = new.credit_note_id and status = 'active'), 0)
    into used;
  if used + new.amount > credit_note.total then
    raise exception 'Credit applied and refunded from supplier credit note #% can''t add up to more than its total',
      credit_note.id using errcode = 'P0001';
  end if;
  return new;
end;
$$;

-- Refunds can't be edited or deleted. Voiding one, once, only fills in its
-- void details.
create function tohyee_guard_supplier_credit_note_refund() returns trigger
language plpgsql as $$
begin
  if tg_op = 'TRUNCATE' then
    raise exception 'supplier_credit_note_refunds can''t be truncated' using errcode = 'P0001';
  end if;
  if tg_op = 'DELETE' then
    raise exception 'Supplier credit note refunds can''t be deleted; void them instead' using errcode = 'P0001';
  end if;
  if old.status = 'active' and new.status = 'voided'
     and (to_jsonb(new) - array['status', 'void_date', 'void_journal_id', 'void_command_source',
            'void_idempotency_key', 'void_request_hash', 'voided_by_user_id', 'voided_by_email', 'voided_at'])
       = (to_jsonb(old) - array['status', 'void_date', 'void_journal_id', 'void_command_source',
            'void_idempotency_key', 'void_request_hash', 'voided_by_user_id', 'voided_by_email', 'voided_at']) then
    return new;
  end if;
  raise exception 'Supplier credit note refunds can''t be changed, only voided once' using errcode = 'P0001';
end;
$$;

-- A bill with active credit applied can't be voided; its credit is removed
-- first.
create function tohyee_guard_credited_bill_void() returns trigger
language plpgsql as $$
begin
  if old.status <> 'voided' and new.status = 'voided'
     and exists (select 1 from supplier_credit_note_applications where bill_id = new.id and status = 'active') then
    raise exception 'Bill #% has credit applied to it, so it can''t be voided. Remove its credit first',
      old.id using errcode = 'P0001';
  end if;
  return new;
end;
$$;

-- A payment can't take a bill's active payments and applied credit to more
-- than its total.
create or replace function tohyee_check_supplier_payment() returns trigger
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
  select coalesce((select sum(amount) from supplier_payments where bill_id = new.bill_id and status = 'active'), 0)
       + coalesce((select sum(amount) from supplier_credit_note_applications
                    where bill_id = new.bill_id and status = 'active'), 0)
    into paid;
  if paid + new.amount > bill.total then
    raise exception 'Payments against bill #% can''t add up to more than its total', bill.id
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create trigger supplier_credit_notes_guard
  before update or delete on supplier_credit_notes
  for each row execute function tohyee_guard_supplier_credit_note();
create trigger supplier_credit_notes_no_truncate
  before truncate on supplier_credit_notes
  for each statement execute function tohyee_guard_supplier_credit_note();
create trigger supplier_credit_note_lines_guard
  before insert or update or delete on supplier_credit_note_lines
  for each row execute function tohyee_guard_supplier_credit_note_line();
create trigger supplier_credit_note_lines_no_truncate
  before truncate on supplier_credit_note_lines
  for each statement execute function tohyee_guard_supplier_credit_note_line();
create trigger supplier_credit_note_applications_check
  before insert on supplier_credit_note_applications
  for each row execute function tohyee_check_supplier_credit_note_application();
create trigger supplier_credit_note_applications_guard
  before update or delete on supplier_credit_note_applications
  for each row execute function tohyee_guard_supplier_credit_note_application();
create trigger supplier_credit_note_applications_no_truncate
  before truncate on supplier_credit_note_applications
  for each statement execute function tohyee_guard_supplier_credit_note_application();
create trigger supplier_credit_note_refunds_check
  before insert on supplier_credit_note_refunds
  for each row execute function tohyee_check_supplier_credit_note_refund();
create trigger supplier_credit_note_refunds_guard
  before update or delete on supplier_credit_note_refunds
  for each row execute function tohyee_guard_supplier_credit_note_refund();
create trigger supplier_credit_note_refunds_no_truncate
  before truncate on supplier_credit_note_refunds
  for each statement execute function tohyee_guard_supplier_credit_note_refund();
create trigger bills_credit_guard
  before update on bills
  for each row execute function tohyee_guard_credited_bill_void();
`,
  },
  {
    version: "0009",
    name: "gst_returns",
    sql: `
-- GST returns (NZ GST101A, boxes 5-15) marked as filed. The figures are
-- worked out from approved documents when the return is filed and stored
-- as they were, with the Box 9 and Box 13 adjustments and every counted line,
-- so later approvals or voids dated in the period don't change what was
-- filed. Rows are only ever added: a filed return can't be changed or
-- deleted, and two filed returns can't cover the same day.
create table gst_returns (
  id bigserial primary key,
  command_source text not null,
  idempotency_key text not null,
  request_hash text not null,
  period_start date not null,
  period_end date not null,
  gst_basis text not null check (gst_basis in ('invoice', 'payments', 'hybrid')),
  currency_code text not null check (currency_code ~ '^[A-Z]{3}$'),
  box5 numeric not null,
  box6 numeric not null,
  box7 numeric not null,
  box8 numeric not null,
  box9 numeric not null check (box9 >= 0),
  box10 numeric not null,
  box11 numeric not null,
  box12 numeric not null,
  box13 numeric not null check (box13 >= 0),
  box14 numeric not null,
  box15 numeric not null,
  sales_gst numeric not null,
  purchases_gst numeric not null,
  adjustment_count integer not null check (adjustment_count >= 0),
  line_count integer not null check (line_count >= 0),
  filed_by_user_id uuid,
  filed_by_email text not null,
  filed_at timestamptz not null default now(),
  unique (command_source, idempotency_key),
  -- 1, 2 or 6 whole calendar months: from the 1st to the last day of a month.
  check (extract(day from period_start) = 1),
  check (extract(day from period_end + 1) = 1),
  check ((extract(year from period_end) * 12 + extract(month from period_end))
         - (extract(year from period_start) * 12 + extract(month from period_start)) + 1 in (1, 2, 6)),
  check (box7 = box5 - box6),
  check (box8 = round(box7 * 3 / 23, 2)),
  check (box10 = box8 + box9),
  check (box12 = round(box11 * 3 / 23, 2)),
  check (box14 = box12 + box13),
  check (box15 = box10 - box14),
  constraint gst_returns_no_overlap exclude using gist (daterange(period_start, period_end, '[]') with &&)
);

-- Box 9 (debit) and Box 13 (credit) adjustments: GST amounts typed in, each
-- with what it's for.
create table gst_return_adjustments (
  id bigserial primary key,
  gst_return_id bigint not null references gst_returns(id),
  line_order integer not null check (line_order > 0),
  box text not null check (box in ('9', '13')),
  description text not null check (length(description) between 1 and 200),
  amount numeric not null check (amount > 0 and scale(amount) <= 2),
  unique (gst_return_id, line_order)
);

-- The document lines counted in the return, as they were when it was filed.
-- Amounts include GST and are negative for credit notes and voids.
create table gst_return_lines (
  id bigserial primary key,
  gst_return_id bigint not null references gst_returns(id),
  line_order integer not null check (line_order > 0),
  side text not null check (side in ('sales', 'purchases')),
  event_type text not null check (event_type in ('invoice_approved', 'invoice_voided', 'credit_note_approved',
    'credit_note_voided', 'bill_approved', 'bill_voided', 'supplier_credit_note_approved',
    'supplier_credit_note_voided')),
  event_date date not null,
  document_type text not null check (document_type in ('sales_invoice', 'sales_credit_note', 'bill',
    'supplier_credit_note')),
  document_id bigint not null,
  document_number text not null,
  reference text,
  contact_id bigint not null references contacts(id),
  contact_name text not null,
  document_line_order integer not null,
  description text not null,
  tax_code text,
  category text not null check (category in ('standard', 'zero_rated', 'exempt', 'out_of_scope')),
  tax_rate numeric not null,
  amount numeric not null,
  gst_amount numeric not null,
  boxes text[] not null check (cardinality(boxes) > 0 and boxes <@ array['5', '6', '11']),
  unique (gst_return_id, line_order)
);

-- Filed returns can't be changed, deleted or truncated.
create function tohyee_guard_gst_return() returns trigger
language plpgsql as $$
begin
  if tg_op = 'TRUNCATE' then
    raise exception '% can''t be truncated: filed GST returns are kept as they were filed', tg_table_name
      using errcode = 'P0001';
  end if;
  raise exception 'Filed GST return #% can''t be changed or deleted', old.id using errcode = 'P0001';
end;
$$;

-- Adjustments and lines are added only while their return is being filed:
-- each fills one of the return's numbered slots (adjustment_count or
-- line_count), so once they're all filled nothing more can be added. After
-- that they can't be changed, deleted or truncated.
create function tohyee_guard_gst_return_detail() returns trigger
language plpgsql as $$
declare
  slots integer;
begin
  if tg_op = 'TRUNCATE' then
    raise exception '% can''t be truncated: filed GST returns are kept as they were filed', tg_table_name
      using errcode = 'P0001';
  end if;
  if tg_op in ('UPDATE', 'DELETE') then
    raise exception 'Filed GST return #% can''t be changed or deleted', old.gst_return_id using errcode = 'P0001';
  end if;
  if tg_table_name = 'gst_return_adjustments' then
    select adjustment_count into slots from gst_returns where id = new.gst_return_id;
  else
    select line_count into slots from gst_returns where id = new.gst_return_id;
  end if;
  if slots is not null and new.line_order > slots then
    raise exception 'Filed GST return #% can''t be changed', new.gst_return_id using errcode = 'P0001';
  end if;
  return new;
end;
$$;

-- At commit, a filed return has all its adjustments and lines, and its boxes
-- are what they add up to.
create function tohyee_check_gst_return() returns trigger
language plpgsql as $$
declare
  lines record;
  adjustments record;
begin
  select count(*)::integer as line_count,
         coalesce(sum(amount) filter (where '5' = any(boxes)), 0) as box5,
         coalesce(sum(amount) filter (where '6' = any(boxes)), 0) as box6,
         coalesce(sum(amount) filter (where '11' = any(boxes)), 0) as box11,
         coalesce(sum(gst_amount) filter (where side = 'sales'), 0) as sales_gst,
         coalesce(sum(gst_amount) filter (where side = 'purchases'), 0) as purchases_gst
    into lines
    from gst_return_lines where gst_return_id = new.id;
  select count(*)::integer as adjustment_count,
         coalesce(sum(amount) filter (where box = '9'), 0) as box9,
         coalesce(sum(amount) filter (where box = '13'), 0) as box13
    into adjustments
    from gst_return_adjustments where gst_return_id = new.id;
  if lines.line_count <> new.line_count or adjustments.adjustment_count <> new.adjustment_count then
    raise exception 'GST return #% is missing some of its lines or adjustments', new.id using errcode = '23514';
  end if;
  if lines.box5 <> new.box5 or lines.box6 <> new.box6 or lines.box11 <> new.box11
     or lines.sales_gst <> new.sales_gst or lines.purchases_gst <> new.purchases_gst
     or adjustments.box9 <> new.box9 or adjustments.box13 <> new.box13 then
    raise exception 'GST return #% boxes don''t add up to its lines and adjustments', new.id using errcode = '23514';
  end if;
  return null;
end;
$$;

create trigger gst_returns_guard
  before update or delete on gst_returns
  for each row execute function tohyee_guard_gst_return();
create trigger gst_returns_no_truncate
  before truncate on gst_returns
  for each statement execute function tohyee_guard_gst_return();
create constraint trigger gst_returns_add_up
  after insert on gst_returns
  deferrable initially deferred
  for each row execute function tohyee_check_gst_return();
create trigger gst_return_adjustments_guard
  before insert or update or delete on gst_return_adjustments
  for each row execute function tohyee_guard_gst_return_detail();
create trigger gst_return_adjustments_no_truncate
  before truncate on gst_return_adjustments
  for each statement execute function tohyee_guard_gst_return_detail();
create trigger gst_return_lines_guard
  before insert or update or delete on gst_return_lines
  for each row execute function tohyee_guard_gst_return_detail();
create trigger gst_return_lines_no_truncate
  before truncate on gst_return_lines
  for each statement execute function tohyee_guard_gst_return_detail();
`,
  },
  {
    version: "0010",
    name: "customer_overpayments",
    sql: `
-- Journals posted by refunding an overpayment or voiding that refund.
alter table ledger_journals drop constraint ledger_journals_origin_check;
alter table ledger_journals add constraint ledger_journals_origin_check
  check (origin in ('manual', 'correction', 'inventory', 'fx_revaluation', 'invoice', 'customer_payment', 'bill',
                    'supplier_payment', 'sales_credit_note', 'sales_credit_note_refund',
                    'supplier_credit_note', 'supplier_credit_note_refund', 'customer_overpayment_refund'));

-- The part of a payment that was more than its invoice's amount due when it
-- was recorded (examples OP1-OP4). The rest of the payment pays the invoice.
-- It's fixed when the payment is recorded; earlier payments were never more
-- than the amount due, so theirs is 0. The whole payment still posts one
-- journal, Dr the bank account / Cr accounts receivable, so the overpayment
-- sits in accounts receivable as credit for the customer.
alter table customer_payments
  add column overpayment_amount numeric not null default 0
    check (overpayment_amount >= 0 and overpayment_amount <= amount);

-- Overpayment credit applied to another approved invoice of the same
-- customer and currency. Like credit note applications, applying posts no
-- journal (both sides are accounts receivable), one command can cover
-- several invoices, and removing one, once, fills in its removal details.
create table customer_overpayment_applications (
  id bigserial primary key,
  command_source text not null,
  idempotency_key text not null,
  request_hash text not null,
  status text not null default 'active' check (status in ('active', 'removed')),
  payment_id bigint not null references customer_payments(id),
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
create index customer_overpayment_applications_payment_idx on customer_overpayment_applications (payment_id, id);
create index customer_overpayment_applications_invoice_idx on customer_overpayment_applications (invoice_id, id);

-- Remaining overpayment paid back to the customer. Recording a refund posts
-- Dr accounts receivable / Cr the bank account; voiding it posts the exact
-- reversal.
create table customer_overpayment_refunds (
  id bigserial primary key,
  command_source text not null,
  idempotency_key text not null,
  request_hash text not null,
  status text not null default 'active' check (status in ('active', 'voided')),
  payment_id bigint not null references customer_payments(id),
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
create index customer_overpayment_refunds_payment_idx on customer_overpayment_refunds (payment_id, id);
create index customer_overpayment_refunds_bank_account_idx on customer_overpayment_refunds (bank_account_id);

-- What's been settled on an invoice: the invoice part of its active payments
-- (the payment less its overpayment), its active credit note credit and its
-- active overpayment credit.
create function tohyee_invoice_settled(invoice bigint) returns numeric
language sql stable as $$
  select coalesce((select sum(amount - overpayment_amount) from customer_payments
                    where invoice_id = invoice and status = 'active'), 0)
       + coalesce((select sum(amount) from sales_credit_note_applications
                    where invoice_id = invoice and status = 'active'), 0)
       + coalesce((select sum(amount) from customer_overpayment_applications
                    where invoice_id = invoice and status = 'active'), 0)
$$;

-- What's been used of a payment's overpayment: its active applications and
-- active refunds.
create function tohyee_overpayment_used(payment bigint) returns numeric
language sql stable as $$
  select coalesce((select sum(amount) from customer_overpayment_applications
                    where payment_id = payment and status = 'active'), 0)
       + coalesce((select sum(amount) from customer_overpayment_refunds
                    where payment_id = payment and status = 'active'), 0)
$$;

-- A payment is recorded as active, against an approved invoice, in the
-- invoice's currency and dated on or after it. Its overpayment must be
-- exactly what it pays beyond the invoice's amount due at that moment (all of
-- it if the invoice is already paid), so what's settled on an invoice never goes over its total. The
-- invoice stays locked until the transaction ends, so two payments can't both
-- take what's left.
create or replace function toeyee_check_customer_payment() returns trigger
language plpgsql as $$
declare
  invoice record;
  due numeric;
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
  due := invoice.total - tohyee_invoice_settled(new.invoice_id);
  if new.overpayment_amount <> greatest(new.amount - due, 0) then
    raise exception 'The overpayment on a payment against invoice % must be what it pays beyond the amount due (%)',
      invoice.invoice_number, due using errcode = 'P0001';
  end if;
  return new;
end;
$$;

-- Payments can't be edited or deleted. Voiding one, once, only fills in its
-- void details, and not while any of its overpayment is applied or refunded.
create or replace function toeyee_guard_customer_payment() returns trigger
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
    if tohyee_overpayment_used(old.id) > 0 then
      raise exception 'This payment''s overpayment has been applied or refunded, so it can''t be voided. Remove its applications and refunds first'
        using errcode = 'P0001';
    end if;
    return new;
  end if;
  raise exception 'Customer payments can''t be changed, only voided once' using errcode = 'P0001';
end;
$$;

-- Credit note applications also count overpayment credit applied to the
-- invoice (replaces the 0007 check; otherwise the same).
create or replace function tohyee_check_credit_note_application() returns trigger
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
  if tohyee_invoice_settled(new.invoice_id) + new.amount > invoice.total then
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

-- An overpayment application is recorded as active, from an active payment
-- with an overpayment to another approved invoice of the same customer and
-- currency, dated on or after both the payment and the invoice. The invoice's
-- settled amount can't go over its total, and the overpayment's applications
-- and refunds can't add up to more than the overpayment. The payment and
-- then the invoice stay locked until the transaction ends.
create function tohyee_check_overpayment_application() returns trigger
language plpgsql as $$
declare
  payment record;
  invoice record;
begin
  if new.status <> 'active' then
    raise exception 'An application is recorded as active and removed afterwards' using errcode = 'P0001';
  end if;
  select p.status, p.invoice_id, p.payment_date, p.currency_code, p.overpayment_amount, i.contact_id into payment
    from customer_payments p join sales_invoices i on i.id = p.invoice_id
   where p.id = new.payment_id for update of p;
  if not found then
    -- The foreign key refuses it.
    return new;
  end if;
  select status, invoice_number, contact_id, invoice_date, currency_code, total into invoice
    from sales_invoices where id = new.invoice_id for update;
  if not found then
    return new;
  end if;
  if payment.status <> 'active' then
    raise exception 'Overpayments can only be applied from active payments' using errcode = 'P0001';
  end if;
  if new.invoice_id = payment.invoice_id then
    raise exception 'An overpayment can''t be applied to the invoice it overpaid' using errcode = 'P0001';
  end if;
  if invoice.status <> 'approved' then
    raise exception 'Credit can only be applied to approved invoices' using errcode = 'P0001';
  end if;
  if invoice.contact_id <> payment.contact_id then
    raise exception 'Credit can only be applied to invoices of the same customer' using errcode = 'P0001';
  end if;
  if new.currency_code <> payment.currency_code or new.currency_code <> invoice.currency_code then
    raise exception 'Credit can only be applied in the payment''s and invoice''s currency' using errcode = 'P0001';
  end if;
  if new.application_date < payment.payment_date or new.application_date < invoice.invoice_date then
    raise exception 'An application can''t be dated before its payment or invoice' using errcode = 'P0001';
  end if;
  if tohyee_invoice_settled(new.invoice_id) + new.amount > invoice.total then
    raise exception 'Payments and credit applied to invoice % can''t add up to more than its total', invoice.invoice_number
      using errcode = 'P0001';
  end if;
  if tohyee_overpayment_used(new.payment_id) + new.amount > payment.overpayment_amount then
    raise exception 'Overpayment applied and refunded can''t add up to more than the overpayment' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

-- Overpayment applications can't be edited or deleted. Removing one, once,
-- only fills in its removal details.
create function tohyee_guard_overpayment_application() returns trigger
language plpgsql as $$
begin
  if tg_op = 'TRUNCATE' then
    raise exception 'customer_overpayment_applications can''t be truncated' using errcode = 'P0001';
  end if;
  if tg_op = 'DELETE' then
    raise exception 'Overpayment applications can''t be deleted; remove them instead' using errcode = 'P0001';
  end if;
  if old.status = 'active' and new.status = 'removed'
     and (to_jsonb(new) - array['status', 'removal_date', 'removal_command_source', 'removal_idempotency_key',
            'removal_request_hash', 'removed_by_user_id', 'removed_by_email', 'removed_at'])
       = (to_jsonb(old) - array['status', 'removal_date', 'removal_command_source', 'removal_idempotency_key',
            'removal_request_hash', 'removed_by_user_id', 'removed_by_email', 'removed_at']) then
    return new;
  end if;
  raise exception 'Overpayment applications can''t be changed, only removed once' using errcode = 'P0001';
end;
$$;

-- An overpayment refund is recorded as active, from an active payment, in its
-- currency and dated on or after it, and the overpayment's applications and
-- refunds can't add up to more than the overpayment.
create function tohyee_check_overpayment_refund() returns trigger
language plpgsql as $$
declare
  payment record;
begin
  if new.status <> 'active' then
    raise exception 'A refund is recorded as active and voided afterwards' using errcode = 'P0001';
  end if;
  select status, payment_date, currency_code, overpayment_amount into payment
    from customer_payments where id = new.payment_id for update;
  if not found then
    return new;
  end if;
  if payment.status <> 'active' then
    raise exception 'Overpayments can only be refunded from active payments' using errcode = 'P0001';
  end if;
  if new.currency_code <> payment.currency_code then
    raise exception 'A refund must be in its payment''s currency' using errcode = 'P0001';
  end if;
  if new.refund_date < payment.payment_date then
    raise exception 'A refund can''t be dated before its payment' using errcode = 'P0001';
  end if;
  if tohyee_overpayment_used(new.payment_id) + new.amount > payment.overpayment_amount then
    raise exception 'Overpayment applied and refunded can''t add up to more than the overpayment' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

-- Overpayment refunds can't be edited or deleted. Voiding one, once, only
-- fills in its void details.
create function tohyee_guard_overpayment_refund() returns trigger
language plpgsql as $$
begin
  if tg_op = 'TRUNCATE' then
    raise exception 'customer_overpayment_refunds can''t be truncated' using errcode = 'P0001';
  end if;
  if tg_op = 'DELETE' then
    raise exception 'Overpayment refunds can''t be deleted; void them instead' using errcode = 'P0001';
  end if;
  if old.status = 'active' and new.status = 'voided'
     and (to_jsonb(new) - array['status', 'void_date', 'void_journal_id', 'void_command_source',
            'void_idempotency_key', 'void_request_hash', 'voided_by_user_id', 'voided_by_email', 'voided_at'])
       = (to_jsonb(old) - array['status', 'void_date', 'void_journal_id', 'void_command_source',
            'void_idempotency_key', 'void_request_hash', 'voided_by_user_id', 'voided_by_email', 'voided_at']) then
    return new;
  end if;
  raise exception 'Overpayment refunds can''t be changed, only voided once' using errcode = 'P0001';
end;
$$;

-- An invoice with active overpayment credit applied can't be voided; its
-- credit is removed first.
create function tohyee_guard_overpaid_credit_invoice_void() returns trigger
language plpgsql as $$
begin
  if old.status <> 'voided' and new.status = 'voided'
     and exists (select 1 from customer_overpayment_applications where invoice_id = new.id and status = 'active') then
    raise exception 'Invoice % has credit applied to it, so it can''t be voided. Remove its credit first',
      old.invoice_number using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create trigger customer_overpayment_applications_check
  before insert on customer_overpayment_applications
  for each row execute function tohyee_check_overpayment_application();
create trigger customer_overpayment_applications_guard
  before update or delete on customer_overpayment_applications
  for each row execute function tohyee_guard_overpayment_application();
create trigger customer_overpayment_applications_no_truncate
  before truncate on customer_overpayment_applications
  for each statement execute function tohyee_guard_overpayment_application();
create trigger customer_overpayment_refunds_check
  before insert on customer_overpayment_refunds
  for each row execute function tohyee_check_overpayment_refund();
create trigger customer_overpayment_refunds_guard
  before update or delete on customer_overpayment_refunds
  for each row execute function tohyee_guard_overpayment_refund();
create trigger customer_overpayment_refunds_no_truncate
  before truncate on customer_overpayment_refunds
  for each statement execute function tohyee_guard_overpayment_refund();
create trigger sales_invoices_overpayment_credit_guard
  before update on sales_invoices
  for each row execute function tohyee_guard_overpaid_credit_invoice_void();
`,
  },
  {
    version: "0011",
    name: "bank_accounts_and_reconciliation",
    sql: `
-- Journals posted by bank transactions (spend and receive money) and by
-- transfers between bank and credit card accounts.
alter table ledger_journals drop constraint ledger_journals_origin_check;
alter table ledger_journals add constraint ledger_journals_origin_check
  check (origin in ('manual', 'correction', 'inventory', 'fx_revaluation', 'invoice', 'customer_payment', 'bill',
                    'supplier_payment', 'sales_credit_note', 'sales_credit_note_refund',
                    'supplier_credit_note', 'supplier_credit_note_refund', 'customer_overpayment_refund',
                    'bank_transaction', 'bank_transfer'));

-- Credit cards get their own account type (a liability) so they can hold
-- statement lines. The starting chart's "Credit card" account becomes one.
update accounts set account_type = 'credit_card', updated_at = now()
 where lower(code) = '2400' and account_class = 'liability' and account_type = 'current_liability'
   and name = 'Credit card';

-- Per bank or credit card account: the saved CSV/Excel layout and the Akahu
-- bank feed link. The Akahu account id can only be linked once.
create table bank_account_settings (
  account_id bigint primary key references accounts(id),
  import_layout jsonb,
  akahu_account_id text unique check (akahu_account_id is null or akahu_account_id ~ '^acc_[A-Za-z0-9]+$'),
  akahu_account_name text,
  akahu_connection_name text,
  feed_start_date date,
  feed_active boolean not null default false,
  last_synced_at timestamptz,
  last_sync_status text not null default 'never' check (last_sync_status in ('never', 'ok', 'failed')),
  last_sync_error text,
  statement_balance numeric,
  statement_balance_at timestamptz,
  updated_at timestamptz not null default now(),
  check (not feed_active or (akahu_account_id is not null and feed_start_date is not null))
);

-- The organisation's own Akahu personal app (bank feeds, BK15): its App ID
-- token and user token, encrypted with the server's TOHYEE_SECRET_KEY. Each
-- organisation sets up its own, so feeds only ever reach its own bank logins.
-- Saving new tokens removes the old row; only one row is active at a time.
create table akahu_connections (
  id bigserial primary key,
  app_token_ciphertext text not null,
  user_token_ciphertext text not null,
  app_token_hint text not null check (length(app_token_hint) between 1 and 40),
  sync_every_hours integer not null default 6 check (sync_every_hours between 1 and 24),
  status text not null default 'active' check (status in ('active', 'removed')),
  created_by_email text,
  created_at timestamptz not null default now(),
  removed_at timestamptz,
  removed_by_email text,
  check ((status = 'active') = (removed_at is null))
);
create unique index akahu_connections_one_active on akahu_connections ((true)) where status = 'active';

-- A file import or a bank feed sync. Deleting an import (only while none of
-- its lines is reconciled) marks it and its lines deleted.
create table bank_statement_imports (
  id bigserial primary key,
  command_source text not null,
  idempotency_key text not null,
  request_hash text not null,
  account_id bigint not null references accounts(id),
  source text not null check (source in ('file', 'akahu')),
  file_name text check (file_name is null or length(file_name) between 1 and 255),
  file_format text not null check (file_format in ('csv', 'xlsx', 'ofx', 'qif', 'camt053', 'mt940', 'akahu')),
  line_count integer not null check (line_count >= 0),
  duplicate_count integer not null check (duplicate_count >= 0),
  possible_duplicate_count integer not null check (possible_duplicate_count >= 0),
  status text not null default 'active' check (status in ('active', 'deleted')),
  created_by_user_id uuid,
  created_by_email text,
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  deleted_by_email text,
  unique (command_source, idempotency_key),
  check ((status = 'active' and deleted_at is null) or (status = 'deleted' and deleted_at is not null))
);
create index bank_statement_imports_account_idx on bank_statement_imports (account_id, id);

-- What the bank says happened. Money in is positive, money out negative, from
-- the account holder's point of view. Lines aren't ledger entries: only their
-- status changes after they're added, and they're never deleted.
create table bank_statement_lines (
  id bigserial primary key,
  account_id bigint not null references accounts(id),
  import_id bigint not null references bank_statement_imports(id),
  line_date date not null,
  amount numeric not null check (amount <> 0 and scale(amount) <= 2),
  description text not null check (length(description) between 1 and 500),
  payee text check (payee is null or length(payee) <= 200),
  particulars text check (particulars is null or length(particulars) <= 100),
  code text check (code is null or length(code) <= 100),
  reference text check (reference is null or length(reference) <= 200),
  balance numeric,
  external_id text check (external_id is null or length(external_id) between 1 and 200),
  match_key text not null,
  possible_duplicate_of bigint references bank_statement_lines(id),
  status text not null default 'unreconciled' check (status in ('unreconciled', 'reconciled', 'excluded', 'deleted')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index bank_statement_lines_external_id_key
  on bank_statement_lines (account_id, external_id) where external_id is not null and status <> 'deleted';
create index bank_statement_lines_account_status_idx on bank_statement_lines (account_id, status, line_date, id);
create index bank_statement_lines_match_key_idx on bank_statement_lines (account_id, match_key) where status <> 'deleted';
create index bank_statement_lines_import_idx on bank_statement_lines (import_id);

create function tohyee_guard_statement_line() returns trigger
language plpgsql as $$
begin
  if tg_op = 'TRUNCATE' then
    raise exception 'bank_statement_lines can''t be truncated' using errcode = 'P0001';
  end if;
  if tg_op = 'DELETE' then
    raise exception 'Statement lines can''t be deleted; delete their import instead' using errcode = 'P0001';
  end if;
  if (to_jsonb(new) - array['status', 'updated_at']) <> (to_jsonb(old) - array['status', 'updated_at']) then
    raise exception 'Statement lines can''t be changed, only reconciled, excluded or deleted' using errcode = 'P0001';
  end if;
  if old.status = 'deleted' then
    raise exception 'A deleted statement line can''t change' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger bank_statement_lines_guard
  before update or delete on bank_statement_lines
  for each row execute function tohyee_guard_statement_line();
create trigger bank_statement_lines_no_truncate
  before truncate on bank_statement_lines
  for each statement execute function tohyee_guard_statement_line();

-- A statement line reconciled against journal lines on the same account. At
-- most one active reconciliation per statement line, and a journal line is in
-- at most one active reconciliation. Removing one, once, fills in its removal
-- details; rows are never deleted.
create table bank_reconciliations (
  id bigserial primary key,
  command_source text not null,
  idempotency_key text not null,
  request_hash text not null,
  statement_line_id bigint not null references bank_statement_lines(id),
  kind text not null check (kind in ('match', 'payments', 'bank_transaction', 'transfer')),
  status text not null default 'active' check (status in ('active', 'removed')),
  created_by_user_id uuid,
  created_by_email text,
  created_at timestamptz not null default now(),
  removal_command_source text,
  removal_idempotency_key text,
  removal_request_hash text,
  removed_by_user_id uuid,
  removed_by_email text,
  removed_at timestamptz,
  unique (command_source, idempotency_key),
  unique (removal_command_source, removal_idempotency_key),
  check (
    (status = 'active' and removal_command_source is null and removal_idempotency_key is null
      and removal_request_hash is null and removed_at is null)
    or (status = 'removed' and removal_command_source is not null and removal_idempotency_key is not null
      and removal_request_hash is not null and removed_at is not null)
  )
);
create unique index bank_reconciliations_active_line_key
  on bank_reconciliations (statement_line_id) where status = 'active';

create table bank_reconciliation_items (
  id bigserial primary key,
  reconciliation_id bigint not null references bank_reconciliations(id),
  journal_line_id bigint not null references ledger_journal_lines(id),
  -- Signed like the statement line: the journal line's debit less its credit.
  amount numeric not null check (amount <> 0),
  active boolean not null default true,
  unique (reconciliation_id, journal_line_id)
);
create unique index bank_reconciliation_items_active_journal_line_key
  on bank_reconciliation_items (journal_line_id) where active;

-- Reconciliations and their items can't be edited or deleted; removing a
-- reconciliation only fills in its removal details and deactivates its items.
create function tohyee_guard_reconciliation() returns trigger
language plpgsql as $$
begin
  if tg_op = 'TRUNCATE' then
    raise exception '% can''t be truncated', tg_table_name using errcode = 'P0001';
  end if;
  if tg_op = 'DELETE' then
    raise exception 'Reconciliations can''t be deleted; unreconcile instead' using errcode = 'P0001';
  end if;
  if tg_table_name = 'bank_reconciliations' then
    if old.status = 'active' and new.status = 'removed'
       and (to_jsonb(new) - array['status', 'removal_command_source', 'removal_idempotency_key',
              'removal_request_hash', 'removed_by_user_id', 'removed_by_email', 'removed_at'])
         = (to_jsonb(old) - array['status', 'removal_command_source', 'removal_idempotency_key',
              'removal_request_hash', 'removed_by_user_id', 'removed_by_email', 'removed_at']) then
      update bank_reconciliation_items set active = false where reconciliation_id = old.id;
      return new;
    end if;
    raise exception 'Reconciliations can''t be changed, only removed once' using errcode = 'P0001';
  end if;
  if old.active and not new.active and (to_jsonb(new) - 'active') = (to_jsonb(old) - 'active') then
    return new;
  end if;
  raise exception 'Reconciliation items can''t be changed' using errcode = 'P0001';
end;
$$;
create trigger bank_reconciliations_guard
  before update or delete on bank_reconciliations
  for each row execute function tohyee_guard_reconciliation();
create trigger bank_reconciliations_no_truncate
  before truncate on bank_reconciliations
  for each statement execute function tohyee_guard_reconciliation();
create trigger bank_reconciliation_items_guard
  before update or delete on bank_reconciliation_items
  for each row execute function tohyee_guard_reconciliation();
create trigger bank_reconciliation_items_no_truncate
  before truncate on bank_reconciliation_items
  for each statement execute function tohyee_guard_reconciliation();

-- Checked at commit: an active reconciliation's items are on the statement
-- line's account, signed the same way as their journal lines, and add up to
-- the line's amount; a statement line is reconciled exactly when it has an
-- active reconciliation.
create function tohyee_check_reconciliation(target bigint) returns void
language plpgsql as $$
declare
  rec record;
  line record;
  total numeric;
  wrong integer;
begin
  select * into rec from bank_reconciliations where id = target;
  if not found then
    return;
  end if;
  select * into line from bank_statement_lines where id = rec.statement_line_id;
  if rec.status = 'active' then
    if line.status <> 'reconciled' then
      raise exception 'Statement line % has a reconciliation but isn''t marked reconciled', line.id using errcode = '23514';
    end if;
    select coalesce(sum(i.amount), 0),
           count(*) filter (where j.account_id <> line.account_id or i.amount <> j.debit_amount - j.credit_amount)
      into total, wrong
      from bank_reconciliation_items i join ledger_journal_lines j on j.id = i.journal_line_id
     where i.reconciliation_id = rec.id;
    if wrong > 0 then
      raise exception 'Statement line % is reconciled against journal lines on another account or with other amounts', line.id
        using errcode = '23514';
    end if;
    if total <> line.amount then
      raise exception 'Statement line % (%) is reconciled against journal lines adding up to %', line.id, line.amount, total
        using errcode = '23514';
    end if;
  elsif line.status = 'reconciled'
        and not exists (select 1 from bank_reconciliations where statement_line_id = line.id and status = 'active') then
    raise exception 'Statement line % is marked reconciled without a reconciliation', line.id using errcode = '23514';
  end if;
end;
$$;

create function tohyee_check_reconciliation_trigger() returns trigger
language plpgsql as $$
begin
  if tg_table_name = 'bank_reconciliation_items' then
    perform tohyee_check_reconciliation(new.reconciliation_id);
  elsif tg_table_name = 'bank_statement_lines' then
    if new.status = 'reconciled' or old.status = 'reconciled' then
      perform tohyee_check_reconciliation(r.id) from bank_reconciliations r where r.statement_line_id = new.id;
      if new.status = 'reconciled'
         and not exists (select 1 from bank_reconciliations where statement_line_id = new.id and status = 'active') then
        raise exception 'Statement line % is marked reconciled without a reconciliation', new.id using errcode = '23514';
      end if;
    end if;
  else
    perform tohyee_check_reconciliation(new.id);
  end if;
  return null;
end;
$$;
create constraint trigger bank_reconciliations_consistent
  after insert or update on bank_reconciliations
  deferrable initially deferred
  for each row execute function tohyee_check_reconciliation_trigger();
create constraint trigger bank_reconciliation_items_consistent
  after insert on bank_reconciliation_items
  deferrable initially deferred
  for each row execute function tohyee_check_reconciliation_trigger();
create constraint trigger bank_statement_lines_consistent
  after update on bank_statement_lines
  deferrable initially deferred
  for each row execute function tohyee_check_reconciliation_trigger();

-- A journal with a reconciled line on a bank or credit card account can't be
-- reversed (voiding a payment, refund, bank transaction or transfer, or
-- correcting a journal): unreconcile it first.
create function tohyee_guard_reconciled_reversal() returns trigger
language plpgsql as $$
begin
  if new.correction_kind = 'reversal' and exists (
       select 1 from bank_reconciliation_items i join ledger_journal_lines j on j.id = i.journal_line_id
        where i.active and j.journal_id = new.related_journal_id) then
    raise exception 'This is reconciled with a bank statement line (journal %), so it can''t be voided or reversed. Unreconcile it first',
      new.related_journal_id using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger ledger_journals_reconciled_reversal_guard
  before insert on ledger_journals
  for each row execute function tohyee_guard_reconciled_reversal();

-- Spend money (out of a bank or credit card account) and receive money (in),
-- with invoice-style lines. Posting is immediate; after that a bank
-- transaction can only be voided, which posts the exact reversal.
create table bank_transactions (
  id bigserial primary key,
  command_source text not null,
  idempotency_key text not null,
  request_hash text not null,
  kind text not null check (kind in ('spend', 'receive')),
  status text not null default 'posted' check (status in ('posted', 'voided')),
  account_id bigint not null references accounts(id),
  contact_id bigint not null references contacts(id),
  transaction_date date not null,
  reference text check (reference is null or length(reference) between 1 and 100),
  amounts_mode text not null check (amounts_mode in ('exclusive', 'inclusive', 'no_tax')),
  currency_code text not null check (currency_code ~ '^[A-Z]{3}$'),
  subtotal numeric not null check (subtotal >= 0),
  tax_total numeric not null check (tax_total >= 0),
  total numeric not null check (total > 0),
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
  check (total = subtotal + tax_total),
  check (void_date is null or void_date >= transaction_date),
  check (
    (status = 'posted' and void_date is null and void_journal_id is null and void_command_source is null
      and void_idempotency_key is null and void_request_hash is null and voided_at is null)
    or (status = 'voided' and void_date is not null and void_journal_id is not null and void_command_source is not null
      and void_idempotency_key is not null and void_request_hash is not null and voided_at is not null)
  )
);
create index bank_transactions_account_idx on bank_transactions (account_id, transaction_date);
create index bank_transactions_contact_idx on bank_transactions (contact_id);

create table bank_transaction_lines (
  id bigserial primary key,
  bank_transaction_id bigint not null references bank_transactions(id),
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
  unique (bank_transaction_id, line_order),
  check (tax_code_id is not null or tax_rate = 0),
  check (net_amount = line_amount or net_amount + tax_amount = line_amount)
);

-- Money moved between two of the organisation's bank or credit card accounts.
create table bank_transfers (
  id bigserial primary key,
  command_source text not null,
  idempotency_key text not null,
  request_hash text not null,
  status text not null default 'posted' check (status in ('posted', 'voided')),
  from_account_id bigint not null references accounts(id),
  to_account_id bigint not null references accounts(id),
  transfer_date date not null,
  amount numeric not null check (amount > 0),
  currency_code text not null check (currency_code ~ '^[A-Z]{3}$'),
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
  check (from_account_id <> to_account_id),
  check (void_date is null or void_date >= transfer_date),
  check (
    (status = 'posted' and void_date is null and void_journal_id is null and void_command_source is null
      and void_idempotency_key is null and void_request_hash is null and voided_at is null)
    or (status = 'voided' and void_date is not null and void_journal_id is not null and void_command_source is not null
      and void_idempotency_key is not null and void_request_hash is not null and voided_at is not null)
  )
);

-- Bank transactions and transfers can't be edited or deleted, only voided once.
create function tohyee_guard_bank_document() returns trigger
language plpgsql as $$
begin
  if tg_op = 'TRUNCATE' then
    raise exception '% can''t be truncated', tg_table_name using errcode = 'P0001';
  end if;
  if tg_op = 'DELETE' then
    raise exception '% rows can''t be deleted; void them instead', tg_table_name using errcode = 'P0001';
  end if;
  if tg_table_name = 'bank_transaction_lines' then
    raise exception 'Bank transaction lines can''t be changed' using errcode = 'P0001';
  end if;
  if old.status = 'posted' and new.status = 'voided'
     and (to_jsonb(new) - array['status', 'void_date', 'void_journal_id', 'void_command_source',
            'void_idempotency_key', 'void_request_hash', 'voided_by_user_id', 'voided_by_email', 'voided_at'])
       = (to_jsonb(old) - array['status', 'void_date', 'void_journal_id', 'void_command_source',
            'void_idempotency_key', 'void_request_hash', 'voided_by_user_id', 'voided_by_email', 'voided_at']) then
    return new;
  end if;
  raise exception '% can''t be changed, only voided once', tg_table_name using errcode = 'P0001';
end;
$$;
create trigger bank_transactions_guard
  before update or delete on bank_transactions
  for each row execute function tohyee_guard_bank_document();
create trigger bank_transactions_no_truncate
  before truncate on bank_transactions
  for each statement execute function tohyee_guard_bank_document();
create trigger bank_transaction_lines_guard
  before update or delete on bank_transaction_lines
  for each row execute function tohyee_guard_bank_document();
create trigger bank_transaction_lines_no_truncate
  before truncate on bank_transaction_lines
  for each statement execute function tohyee_guard_bank_document();
create trigger bank_transfers_guard
  before update or delete on bank_transfers
  for each row execute function tohyee_guard_bank_document();
create trigger bank_transfers_no_truncate
  before truncate on bank_transfers
  for each statement execute function tohyee_guard_bank_document();

-- Bank rules suggest a bank transaction for matching statement lines. They're
-- settings, not history, so they can be edited and deleted.
create table bank_rules (
  id bigserial primary key,
  name text not null check (length(name) between 1 and 100),
  is_active boolean not null default true,
  priority integer not null default 100,
  account_id bigint references accounts(id),
  direction text not null default 'any' check (direction in ('any', 'in', 'out')),
  match_field text not null default 'any'
    check (match_field in ('any', 'description', 'payee', 'particulars', 'code', 'reference')),
  match_text text not null check (length(match_text) between 1 and 200),
  contact_id bigint not null references contacts(id),
  target_account_id bigint not null references accounts(id),
  tax_code_id bigint references tax_codes(id),
  amounts_mode text not null default 'inclusive' check (amounts_mode in ('exclusive', 'inclusive', 'no_tax')),
  line_description text check (line_description is null or length(line_description) between 1 and 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- The GST return counts bank transactions: spend money like a bill, receive
-- money like an invoice.
alter table gst_return_lines drop constraint gst_return_lines_event_type_check;
alter table gst_return_lines add constraint gst_return_lines_event_type_check
  check (event_type in ('invoice_approved', 'invoice_voided', 'credit_note_approved', 'credit_note_voided',
                        'bill_approved', 'bill_voided', 'supplier_credit_note_approved', 'supplier_credit_note_voided',
                        'bank_transaction_posted', 'bank_transaction_voided'));
alter table gst_return_lines drop constraint gst_return_lines_document_type_check;
alter table gst_return_lines add constraint gst_return_lines_document_type_check
  check (document_type in ('sales_invoice', 'sales_credit_note', 'bill', 'supplier_credit_note', 'bank_transaction'));
`,
  },
  {
    version: "0012",
    name: "gst_payments_and_hybrid_bases",
    sql: `
-- On the payments and hybrid bases a document counts when it's settled: paid,
-- credited or refunded (examples G10-G19). Each settlement counts the
-- document's lines in proportion, and the filed line keeps the amount settled
-- and the document's total it was worked out from.
alter table gst_return_lines drop constraint gst_return_lines_event_type_check;
alter table gst_return_lines add constraint gst_return_lines_event_type_check
  check (event_type in ('invoice_approved', 'invoice_voided', 'credit_note_approved', 'credit_note_voided',
                        'bill_approved', 'bill_voided', 'supplier_credit_note_approved', 'supplier_credit_note_voided',
                        'bank_transaction_posted', 'bank_transaction_voided',
                        'customer_payment', 'customer_payment_voided',
                        'credit_note_applied', 'credit_note_application_removed',
                        'credit_note_refunded', 'credit_note_refund_voided',
                        'overpayment_applied', 'overpayment_application_removed',
                        'supplier_payment', 'supplier_payment_voided',
                        'supplier_credit_note_applied', 'supplier_credit_note_application_removed',
                        'supplier_credit_note_refunded', 'supplier_credit_note_refund_voided'));
alter table gst_return_lines
  add column settled_amount numeric check (settled_amount > 0),
  add column document_total numeric check (document_total > 0),
  add constraint gst_return_lines_settlement_check check ((settled_amount is null) = (document_total is null));
`,
  },
  {
    version: "0013",
    name: "record_notes_and_attachments",
    sql: `
-- Notes and files on journals, sales invoices, bills, sales credit notes,
-- supplier credit notes and contacts (examples NF1-NF14). They post nothing.
-- A note keeps its current text; every add, edit and delete is also written
-- to audit_events with the text before and after, so the history keeps it.
create table record_notes (
  id bigserial primary key,
  command_source text not null,
  idempotency_key text not null,
  request_hash text not null,
  record_type text not null check (record_type in ('ledger_journal', 'sales_invoice', 'bill', 'sales_credit_note',
                                                   'supplier_credit_note', 'contact')),
  record_id bigint not null,
  body text not null check (length(body) between 1 and 5000),
  version integer not null default 1 check (version > 0),
  created_by_user_id uuid,
  created_by_email text not null,
  created_at timestamptz not null default now(),
  updated_by_email text,
  updated_at timestamptz,
  deleted_by_email text,
  deleted_at timestamptz,
  unique (command_source, idempotency_key),
  check ((deleted_at is null) = (deleted_by_email is null))
);
create index record_notes_record_idx on record_notes (record_type, record_id, id);

-- Files, stored in the organisation's own database so its backup includes
-- them. Removing a file deletes its contents but keeps the row (name, size,
-- who added and removed it) for the history.
create table record_attachments (
  id bigserial primary key,
  command_source text not null,
  idempotency_key text not null,
  request_hash text not null,
  record_type text not null check (record_type in ('ledger_journal', 'sales_invoice', 'bill', 'sales_credit_note',
                                                   'supplier_credit_note', 'contact')),
  record_id bigint not null,
  file_name text not null check (length(file_name) between 1 and 255),
  content_type text not null check (content_type in (
    'application/pdf', 'image/jpeg', 'image/png', 'image/heic', 'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'text/csv')),
  byte_size integer not null check (byte_size between 1 and 10485760),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  content bytea,
  created_by_user_id uuid,
  created_by_email text not null,
  created_at timestamptz not null default now(),
  removed_by_email text,
  removed_at timestamptz,
  unique (command_source, idempotency_key),
  check ((removed_at is null) = (removed_by_email is null)),
  check ((removed_at is null) = (content is not null)),
  check (content is null or octet_length(content) = byte_size)
);
create index record_attachments_record_idx on record_attachments (record_type, record_id, id);

-- A removed file stays removed, and only its removal details and contents
-- can change; rows are never deleted.
create function tohyee_guard_record_attachment() returns trigger
language plpgsql as $$
begin
  if tg_op = 'TRUNCATE' then
    raise exception 'record_attachments can''t be truncated' using errcode = 'P0001';
  end if;
  if tg_op = 'DELETE' then
    raise exception 'Files can''t be deleted, only removed' using errcode = 'P0001';
  end if;
  if old.removed_at is null and new.removed_at is not null and new.content is null
     and (to_jsonb(new) - array['content', 'removed_by_email', 'removed_at'])
       = (to_jsonb(old) - array['content', 'removed_by_email', 'removed_at']) then
    return new;
  end if;
  raise exception 'Files can''t be changed, only removed once' using errcode = 'P0001';
end;
$$;
create trigger record_attachments_guard
  before update or delete on record_attachments
  for each row execute function tohyee_guard_record_attachment();
create trigger record_attachments_no_truncate
  before truncate on record_attachments
  for each statement execute function tohyee_guard_record_attachment();

-- Deleted notes stay deleted; rows are never removed.
create function tohyee_guard_record_note() returns trigger
language plpgsql as $$
begin
  if tg_op = 'TRUNCATE' then
    raise exception 'record_notes can''t be truncated' using errcode = 'P0001';
  end if;
  if tg_op = 'DELETE' then
    raise exception 'Notes can''t be removed from the database; delete them instead' using errcode = 'P0001';
  end if;
  if old.deleted_at is not null then
    raise exception 'A deleted note can''t be changed' using errcode = 'P0001';
  end if;
  if (to_jsonb(new) - array['body', 'version', 'updated_by_email', 'updated_at', 'deleted_by_email', 'deleted_at'])
     <> (to_jsonb(old) - array['body', 'version', 'updated_by_email', 'updated_at', 'deleted_by_email', 'deleted_at'])
     or new.version <> old.version + 1 then
    raise exception 'Only a note''s text can change' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger record_notes_guard
  before update or delete on record_notes
  for each row execute function tohyee_guard_record_note();
create trigger record_notes_no_truncate
  before truncate on record_notes
  for each statement execute function tohyee_guard_record_note();

-- The history of a record reads its audit events.
create index audit_events_entity_idx on audit_events (entity_type, entity_id, id);
`,
  },
  {
    version: "0014",
    name: "payments_for_several_documents",
    sql: `
-- One amount received from a customer (or paid to a supplier) for several of
-- their invoices (bills), examples MP1-MP10 and SMP1-SMP6. It posts one
-- journal with one line on the bank account for the whole amount. Each
-- invoice's (bill's) part is an ordinary customer (supplier) payment with
-- batch_id set, sharing that journal, so amounts due, overpayments and the
-- GST return work as before. The batch is voided as a whole, with one
-- reversal journal shared the same way.
alter table ledger_journals drop constraint ledger_journals_origin_check;
alter table ledger_journals add constraint ledger_journals_origin_check
  check (origin in ('manual', 'correction', 'inventory', 'fx_revaluation', 'invoice', 'customer_payment', 'bill',
                    'supplier_payment', 'sales_credit_note', 'sales_credit_note_refund',
                    'supplier_credit_note', 'supplier_credit_note_refund', 'customer_overpayment_refund',
                    'bank_transaction', 'bank_transfer', 'customer_payment_batch', 'supplier_payment_batch'));

create table customer_payment_batches (
  id bigserial primary key,
  command_source text not null,
  idempotency_key text not null,
  request_hash text not null,
  status text not null default 'active' check (status in ('active', 'voided')),
  contact_id bigint not null references contacts(id),
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
create index customer_payment_batches_contact_idx on customer_payment_batches (contact_id, payment_date desc, id desc);

create table supplier_payment_batches (like customer_payment_batches including defaults including constraints);
alter table supplier_payment_batches
  add primary key (id),
  add unique (journal_id),
  add unique (void_journal_id),
  add unique (command_source, idempotency_key),
  add unique (void_command_source, void_idempotency_key),
  add foreign key (contact_id) references contacts(id),
  add foreign key (bank_account_id) references accounts(id),
  add foreign key (journal_id) references ledger_journals(id),
  add foreign key (void_journal_id) references ledger_journals(id);
create sequence supplier_payment_batches_id_seq owned by supplier_payment_batches.id;
alter table supplier_payment_batches alter column id set default nextval('supplier_payment_batches_id_seq');
create index supplier_payment_batches_contact_idx on supplier_payment_batches (contact_id, payment_date desc, id desc);

-- A payment's journal is its own, unless it's part of a batch, whose parts share the batch's journals.
alter table customer_payments
  add column batch_id bigint references customer_payment_batches(id),
  drop constraint customer_payments_journal_id_key,
  drop constraint customer_payments_void_journal_id_key;
create unique index customer_payments_journal_idx on customer_payments (journal_id) where batch_id is null;
create unique index customer_payments_void_journal_idx on customer_payments (void_journal_id) where batch_id is null;
create index customer_payments_batch_idx on customer_payments (batch_id) where batch_id is not null;
alter table supplier_payments
  add column batch_id bigint references supplier_payment_batches(id),
  drop constraint supplier_payments_journal_id_key,
  drop constraint supplier_payments_void_journal_id_key;
create unique index supplier_payments_journal_idx on supplier_payments (journal_id) where batch_id is null;
create unique index supplier_payments_void_journal_idx on supplier_payments (void_journal_id) where batch_id is null;
create index supplier_payments_batch_idx on supplier_payments (batch_id) where batch_id is not null;

-- A batch is recorded as active and only ever voided once (void details only).
create function tohyee_guard_payment_batch() returns trigger
language plpgsql as $$
begin
  if tg_op = 'TRUNCATE' then
    raise exception '% can''t be truncated', tg_table_name using errcode = 'P0001';
  end if;
  if tg_op = 'DELETE' then
    raise exception 'Payments can''t be deleted; void them instead' using errcode = 'P0001';
  end if;
  if tg_op = 'INSERT' then
    if new.status <> 'active' then
      raise exception 'A payment is recorded as active and voided afterwards' using errcode = 'P0001';
    end if;
    return new;
  end if;
  if old.status = 'active' and new.status = 'voided'
     and (to_jsonb(new) - array['status', 'void_date', 'void_journal_id', 'void_command_source',
            'void_idempotency_key', 'void_request_hash', 'voided_by_user_id', 'voided_by_email', 'voided_at'])
       = (to_jsonb(old) - array['status', 'void_date', 'void_journal_id', 'void_command_source',
            'void_idempotency_key', 'void_request_hash', 'voided_by_user_id', 'voided_by_email', 'voided_at']) then
    return new;
  end if;
  raise exception 'Payments can''t be changed, only voided once' using errcode = 'P0001';
end;
$$;
create trigger customer_payment_batches_guard
  before insert or update or delete on customer_payment_batches
  for each row execute function tohyee_guard_payment_batch();
create trigger customer_payment_batches_no_truncate
  before truncate on customer_payment_batches
  for each statement execute function tohyee_guard_payment_batch();
create trigger supplier_payment_batches_guard
  before insert or update or delete on supplier_payment_batches
  for each row execute function tohyee_guard_payment_batch();
create trigger supplier_payment_batches_no_truncate
  before truncate on supplier_payment_batches
  for each statement execute function tohyee_guard_payment_batch();

-- At the end of the transaction a batch's parts are all there and agree with
-- it: the same customer (supplier), date, bank account, currency, journals and
-- status, adding up to the amount received (paid), each invoice (bill) once.
create function tohyee_check_payment_batch_parts() returns trigger
language plpgsql as $$
declare
  batch record;
  parts record;
begin
  if tg_table_name = 'customer_payment_batches' then
    select * into batch from customer_payment_batches where id = new.id;
    select count(*) as n, count(distinct p.invoice_id) as documents, coalesce(sum(p.amount), 0) as total,
           bool_and(i.contact_id = batch.contact_id and p.payment_date = batch.payment_date
                    and p.bank_account_id = batch.bank_account_id and p.currency_code = batch.currency_code
                    and p.journal_id = batch.journal_id and p.status = batch.status
                    and p.void_journal_id is not distinct from batch.void_journal_id) as agree
      into parts
      from customer_payments p join sales_invoices i on i.id = p.invoice_id
     where p.batch_id = new.id;
  else
    select * into batch from supplier_payment_batches where id = new.id;
    select count(*) as n, count(distinct p.bill_id) as documents, coalesce(sum(p.amount), 0) as total,
           bool_and(b.contact_id = batch.contact_id and p.payment_date = batch.payment_date
                    and p.bank_account_id = batch.bank_account_id and p.currency_code = batch.currency_code
                    and p.journal_id = batch.journal_id and p.status = batch.status
                    and p.void_journal_id is not distinct from batch.void_journal_id) as agree
      into parts
      from supplier_payments p join bills b on b.id = p.bill_id
     where p.batch_id = new.id;
  end if;
  if parts.n = 0 or parts.documents <> parts.n or parts.total <> batch.amount or not parts.agree then
    raise exception 'A payment for several documents must be made of one part for each, adding up to the amount paid'
      using errcode = 'P0001';
  end if;
  return null;
end;
$$;
create constraint trigger customer_payment_batches_parts
  after insert or update on customer_payment_batches
  deferrable initially deferred
  for each row execute function tohyee_check_payment_batch_parts();
create constraint trigger supplier_payment_batches_parts
  after insert or update on supplier_payment_batches
  deferrable initially deferred
  for each row execute function tohyee_check_payment_batch_parts();

-- One part of a batch can't be voided on its own: the batch is voided first,
-- in the same transaction, then its parts (examples MP5 and SMP4).
create function tohyee_guard_payment_batch_part() returns trigger
language plpgsql as $$
declare
  batch_status text;
begin
  if tg_op = 'UPDATE' and old.batch_id is not null and old.status = 'active' and new.status = 'voided' then
    if tg_table_name = 'customer_payments' then
      select status into batch_status from customer_payment_batches where id = old.batch_id;
    else
      select status into batch_status from supplier_payment_batches where id = old.batch_id;
    end if;
    if batch_status <> 'voided' then
      raise exception 'This is part of a payment for several documents: void the whole payment' using errcode = 'P0001';
    end if;
  end if;
  if tg_op = 'UPDATE' and new.batch_id is distinct from old.batch_id then
    raise exception 'Payments can''t be changed, only voided once' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger customer_payments_batch_guard
  before update on customer_payments
  for each row execute function tohyee_guard_payment_batch_part();
create trigger supplier_payments_batch_guard
  before update on supplier_payments
  for each row execute function tohyee_guard_payment_batch_part();
`,
  },
  {
    version: "0015",
    name: "custom_reports",
    sql: `
-- Custom reports (examples CR1-CR10): a standard report's rows and columns
-- that can be changed. A draft's layout is edited; publishing keeps a frozen
-- copy (its layout and the figures worked out at that moment) that never
-- changes. Drafts and published copies can be archived and brought back;
-- only drafts can be deleted. Nothing here touches the ledger.
create table custom_reports (
  id bigserial primary key,
  kind text not null check (kind in ('draft', 'published')),
  base text not null check (base in ('profit_and_loss', 'balance_sheet')),
  title text not null check (length(title) between 1 and 200),
  layout jsonb not null,
  version integer not null default 1,
  command_source text,
  idempotency_key text,
  request_hash text,
  published_from_id bigint,
  snapshot jsonb,
  published_by_email text,
  published_at timestamptz,
  archived_by_email text,
  archived_at timestamptz,
  created_by_user_id uuid,
  created_by_email text,
  created_at timestamptz not null default now(),
  updated_by_email text,
  updated_at timestamptz not null default now(),
  unique (command_source, idempotency_key),
  check ((command_source is null) = (idempotency_key is null) and (idempotency_key is null) = (request_hash is null)),
  check (
    (kind = 'draft' and snapshot is null and published_at is null and published_from_id is null)
    or (kind = 'published' and snapshot is not null and published_at is not null)
  ),
  check (archived_by_email is null or archived_at is not null)
);
create index custom_reports_list_idx on custom_reports (kind, (archived_at is null), updated_at desc);

-- A published copy only ever gets archived or brought back, and is never
-- deleted. A draft can be changed (its kind and base can't) or deleted.
create function tohyee_guard_custom_report() returns trigger
language plpgsql as $$
begin
  if tg_op = 'TRUNCATE' then
    raise exception 'custom_reports can''t be truncated' using errcode = 'P0001';
  end if;
  if tg_op = 'DELETE' then
    if old.kind = 'published' then
      raise exception 'A published report can''t be deleted; archive it instead' using errcode = 'P0001';
    end if;
    return old;
  end if;
  if new.kind <> old.kind or new.base <> old.base or new.id <> old.id then
    raise exception 'A custom report''s kind and starting report can''t change' using errcode = 'P0001';
  end if;
  if old.kind = 'published'
     and (to_jsonb(new) - array['archived_by_email', 'archived_at'])
         <> (to_jsonb(old) - array['archived_by_email', 'archived_at']) then
    raise exception 'A published report can''t be changed' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger custom_reports_guard
  before update or delete on custom_reports
  for each row execute function tohyee_guard_custom_report();
create trigger custom_reports_no_truncate
  before truncate on custom_reports
  for each statement execute function tohyee_guard_custom_report();
`,
  },
  {
    version: "0016",
    name: "tracking_categories",
    sql: `
-- Advanced (ERP) features and tracking categories (examples TC1-TC10):
-- Department, Class and Location, each a tree of values. Document lines and
-- posted journal lines carry one value per category in a jsonb map
-- {"<category id>": "<value id>"}; tags never change amounts or accounts.
alter table organisation_settings add column advanced_features boolean not null default false;

create table tracking_categories (
  id bigserial primary key,
  kind text not null check (kind in ('department', 'class', 'location', 'custom')),
  name text not null check (length(name) between 1 and 60),
  is_required boolean not null default false,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index tracking_categories_name_idx on tracking_categories (lower(name));
create unique index tracking_categories_kind_idx on tracking_categories (kind) where kind <> 'custom';
insert into tracking_categories (kind, name, sort_order) values
  ('department', 'Department', 1), ('class', 'Class', 2), ('location', 'Location', 3);

create table tracking_values (
  id bigserial primary key,
  category_id bigint not null references tracking_categories(id),
  parent_id bigint references tracking_values(id),
  name text not null check (length(name) between 1 and 100),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (parent_id is null or parent_id <> id)
);
create unique index tracking_values_sibling_name_idx on tracking_values (category_id, coalesce(parent_id, 0), lower(name));
create index tracking_values_parent_idx on tracking_values (parent_id);

-- A value's parent is in the same category and never one of its own
-- children; values are archived, never deleted.
create function tohyee_guard_tracking_value() returns trigger
language plpgsql as $$
declare
  parent record;
  cursor_id bigint;
  steps integer := 0;
begin
  if tg_op = 'TRUNCATE' then
    raise exception 'tracking_values can''t be truncated' using errcode = 'P0001';
  end if;
  if tg_op = 'DELETE' then
    raise exception 'Tracking values can''t be deleted; archive them instead' using errcode = 'P0001';
  end if;
  if tg_op = 'UPDATE' and new.category_id <> old.category_id then
    raise exception 'A tracking value can''t move to another category' using errcode = 'P0001';
  end if;
  if new.parent_id is not null then
    select category_id into parent from tracking_values where id = new.parent_id;
    if parent.category_id is distinct from new.category_id then
      raise exception 'A tracking value''s parent must be in the same category' using errcode = 'P0001';
    end if;
    cursor_id := new.parent_id;
    while cursor_id is not null loop
      if cursor_id = new.id then
        raise exception 'A tracking value can''t be under itself or its own children' using errcode = 'P0001';
      end if;
      steps := steps + 1;
      if steps > 50 then
        raise exception 'Tracking values can be at most 50 levels deep' using errcode = 'P0001';
      end if;
      select parent_id into cursor_id from tracking_values where id = cursor_id;
    end loop;
  end if;
  return new;
end;
$$;
create trigger tracking_values_guard
  before insert or update or delete on tracking_values
  for each row execute function tohyee_guard_tracking_value();
create trigger tracking_values_no_truncate
  before truncate on tracking_values
  for each statement execute function tohyee_guard_tracking_value();

create function tohyee_guard_tracking_category() returns trigger
language plpgsql as $$
begin
  if tg_op = 'TRUNCATE' then
    raise exception 'tracking_categories can''t be truncated' using errcode = 'P0001';
  end if;
  if tg_op = 'DELETE' then
    raise exception 'Tracking categories can''t be deleted' using errcode = 'P0001';
  end if;
  if new.kind <> old.kind then
    raise exception 'A tracking category''s kind can''t change' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger tracking_categories_guard
  before update or delete on tracking_categories
  for each row execute function tohyee_guard_tracking_category();
create trigger tracking_categories_no_truncate
  before truncate on tracking_categories
  for each statement execute function tohyee_guard_tracking_category();

-- Tags on a line: an object of category id -> value id, each value in its category.
create function tohyee_valid_tracking(tags jsonb) returns boolean
language plpgsql stable as $$
declare
  entry record;
begin
  if jsonb_typeof(tags) <> 'object' then
    return false;
  end if;
  for entry in select key, value from jsonb_each(tags) loop
    if jsonb_typeof(entry.value) <> 'string' or entry.key !~ '^[1-9][0-9]{0,17}$' or (entry.value #>> '{}') !~ '^[1-9][0-9]{0,17}$' then
      return false;
    end if;
    if not exists (
      select 1 from tracking_values v where v.id = (entry.value #>> '{}')::bigint and v.category_id = entry.key::bigint
    ) then
      return false;
    end if;
  end loop;
  return true;
end;
$$;

create function tohyee_check_line_tracking() returns trigger
language plpgsql as $$
begin
  if tg_op = 'UPDATE' and new.tracking = old.tracking then
    return new;
  end if;
  if not tohyee_valid_tracking(new.tracking) then
    raise exception 'A line''s tracking tags must each be a value of its category' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

alter table ledger_journal_lines add column tracking jsonb not null default '{}'::jsonb;
alter table sales_invoice_lines add column tracking jsonb not null default '{}'::jsonb;
alter table bill_lines add column tracking jsonb not null default '{}'::jsonb;
alter table sales_credit_note_lines add column tracking jsonb not null default '{}'::jsonb;
alter table supplier_credit_note_lines add column tracking jsonb not null default '{}'::jsonb;
alter table bank_transaction_lines add column tracking jsonb not null default '{}'::jsonb;
create trigger ledger_journal_lines_tracking before insert on ledger_journal_lines
  for each row when (new.tracking <> '{}'::jsonb) execute function tohyee_check_line_tracking();
create trigger sales_invoice_lines_tracking before insert or update on sales_invoice_lines
  for each row when (new.tracking <> '{}'::jsonb) execute function tohyee_check_line_tracking();
create trigger bill_lines_tracking before insert or update on bill_lines
  for each row when (new.tracking <> '{}'::jsonb) execute function tohyee_check_line_tracking();
create trigger sales_credit_note_lines_tracking before insert or update on sales_credit_note_lines
  for each row when (new.tracking <> '{}'::jsonb) execute function tohyee_check_line_tracking();
create trigger supplier_credit_note_lines_tracking before insert or update on supplier_credit_note_lines
  for each row when (new.tracking <> '{}'::jsonb) execute function tohyee_check_line_tracking();
create trigger bank_transaction_lines_tracking before insert or update on bank_transaction_lines
  for each row when (new.tracking <> '{}'::jsonb) execute function tohyee_check_line_tracking();
create index ledger_journal_lines_tracking_idx on ledger_journal_lines using gin (tracking);
`,
  },
  {
    version: "0017",
    name: "custom_fields",
    sql: `
-- Custom segments and custom fields (examples CS1-CS3, CF1-CF10). A custom
-- segment is a tracking category of kind 'custom'; any of those can be
-- archived (hidden from new lines). Custom fields hold extra information on
-- contacts, documents and lines that never reaches the ledger. Values are a
-- jsonb map {"<field id>": value}.
alter table tracking_categories add column is_active boolean not null default true;

create or replace function tohyee_guard_tracking_category() returns trigger
language plpgsql as $$
begin
  if tg_op = 'TRUNCATE' then
    raise exception 'tracking_categories can''t be truncated' using errcode = 'P0001';
  end if;
  if tg_op = 'DELETE' then
    raise exception 'Tracking categories can''t be deleted' using errcode = 'P0001';
  end if;
  if new.kind <> old.kind then
    raise exception 'A tracking category''s kind can''t change' using errcode = 'P0001';
  end if;
  if new.kind <> 'custom' and not new.is_active then
    raise exception 'Department, Class and Location can''t be archived' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create table custom_fields (
  id bigserial primary key,
  record text not null check (record in ('contact', 'document', 'line')),
  label text not null check (length(label) between 1 and 60),
  help text check (help is null or length(help) between 1 and 300),
  field_type text not null check (field_type in ('text', 'long_text', 'integer', 'decimal', 'money', 'percent', 'date',
    'checkbox', 'list', 'multi_select', 'email', 'phone', 'url')),
  used_on text[] not null check (cardinality(used_on) >= 1),
  is_required boolean not null default false,
  default_value jsonb,
  show_in_list boolean not null default false,
  is_active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (not (is_required and field_type = 'checkbox')),
  check (
    (record = 'contact' and used_on <@ array['customer', 'supplier'])
    or (record <> 'contact' and used_on <@ array['invoice', 'bill', 'credit_note', 'supplier_credit_note', 'spend', 'receive', 'journal'])
  )
);
create unique index custom_fields_label_idx on custom_fields (record, lower(label));

create table custom_field_options (
  id bigserial primary key,
  field_id bigint not null references custom_fields(id),
  name text not null check (length(name) between 1 and 100),
  is_active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index custom_field_options_name_idx on custom_field_options (field_id, lower(name));

-- Fields and options are archived, never deleted; a field's type and what
-- it's on never change.
create function tohyee_guard_custom_field() returns trigger
language plpgsql as $$
begin
  if tg_op = 'TRUNCATE' then
    raise exception '% can''t be truncated', tg_table_name using errcode = 'P0001';
  end if;
  if tg_op = 'DELETE' then
    raise exception 'Custom fields and their options can''t be deleted; archive them instead' using errcode = 'P0001';
  end if;
  if tg_table_name = 'custom_fields' then
    if new.record <> old.record or new.field_type <> old.field_type then
      raise exception 'A custom field''s type and what it''s on can''t change' using errcode = 'P0001';
    end if;
  elsif new.field_id <> old.field_id then
    raise exception 'An option can''t move to another field' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger custom_fields_guard before update or delete on custom_fields
  for each row execute function tohyee_guard_custom_field();
create trigger custom_fields_no_truncate before truncate on custom_fields
  for each statement execute function tohyee_guard_custom_field();
create trigger custom_field_options_guard before update or delete on custom_field_options
  for each row execute function tohyee_guard_custom_field();
create trigger custom_field_options_no_truncate before truncate on custom_field_options
  for each statement execute function tohyee_guard_custom_field();

-- Values: an object whose keys are fields for this kind of record.
create function tohyee_check_custom_values() returns trigger
language plpgsql as $$
declare
  entry record;
  wanted text := tg_argv[0];
begin
  if tg_op = 'UPDATE' and new.custom_fields = old.custom_fields then
    return new;
  end if;
  if jsonb_typeof(new.custom_fields) <> 'object' then
    raise exception 'Custom field values must be an object' using errcode = 'P0001';
  end if;
  for entry in select key, value from jsonb_each(new.custom_fields) loop
    if entry.key !~ '^[1-9][0-9]{0,17}$'
       or jsonb_typeof(entry.value) not in ('string', 'boolean', 'array')
       or not exists (select 1 from custom_fields f where f.id = entry.key::bigint and f.record = wanted) then
      raise exception 'Custom field values must each belong to a % field', wanted using errcode = 'P0001';
    end if;
  end loop;
  return new;
end;
$$;

alter table contacts add column custom_fields jsonb not null default '{}'::jsonb;
alter table sales_invoices add column custom_fields jsonb not null default '{}'::jsonb;
alter table bills add column custom_fields jsonb not null default '{}'::jsonb;
alter table sales_credit_notes add column custom_fields jsonb not null default '{}'::jsonb;
alter table supplier_credit_notes add column custom_fields jsonb not null default '{}'::jsonb;
alter table bank_transactions add column custom_fields jsonb not null default '{}'::jsonb;
alter table ledger_journals add column custom_fields jsonb not null default '{}'::jsonb;
alter table sales_invoice_lines add column custom_fields jsonb not null default '{}'::jsonb;
alter table bill_lines add column custom_fields jsonb not null default '{}'::jsonb;
alter table sales_credit_note_lines add column custom_fields jsonb not null default '{}'::jsonb;
alter table supplier_credit_note_lines add column custom_fields jsonb not null default '{}'::jsonb;
alter table bank_transaction_lines add column custom_fields jsonb not null default '{}'::jsonb;
alter table ledger_journal_lines add column custom_fields jsonb not null default '{}'::jsonb;

create trigger contacts_custom_fields before insert or update on contacts
  for each row when (new.custom_fields <> '{}'::jsonb) execute function tohyee_check_custom_values('contact');
create trigger sales_invoices_custom_fields before insert or update on sales_invoices
  for each row when (new.custom_fields <> '{}'::jsonb) execute function tohyee_check_custom_values('document');
create trigger bills_custom_fields before insert or update on bills
  for each row when (new.custom_fields <> '{}'::jsonb) execute function tohyee_check_custom_values('document');
create trigger sales_credit_notes_custom_fields before insert or update on sales_credit_notes
  for each row when (new.custom_fields <> '{}'::jsonb) execute function tohyee_check_custom_values('document');
create trigger supplier_credit_notes_custom_fields before insert or update on supplier_credit_notes
  for each row when (new.custom_fields <> '{}'::jsonb) execute function tohyee_check_custom_values('document');
create trigger bank_transactions_custom_fields before insert or update on bank_transactions
  for each row when (new.custom_fields <> '{}'::jsonb) execute function tohyee_check_custom_values('document');
create trigger ledger_journals_custom_fields before insert on ledger_journals
  for each row when (new.custom_fields <> '{}'::jsonb) execute function tohyee_check_custom_values('document');
create trigger sales_invoice_lines_custom_fields before insert or update on sales_invoice_lines
  for each row when (new.custom_fields <> '{}'::jsonb) execute function tohyee_check_custom_values('line');
create trigger bill_lines_custom_fields before insert or update on bill_lines
  for each row when (new.custom_fields <> '{}'::jsonb) execute function tohyee_check_custom_values('line');
create trigger sales_credit_note_lines_custom_fields before insert or update on sales_credit_note_lines
  for each row when (new.custom_fields <> '{}'::jsonb) execute function tohyee_check_custom_values('line');
create trigger supplier_credit_note_lines_custom_fields before insert or update on supplier_credit_note_lines
  for each row when (new.custom_fields <> '{}'::jsonb) execute function tohyee_check_custom_values('line');
create trigger bank_transaction_lines_custom_fields before insert or update on bank_transaction_lines
  for each row when (new.custom_fields <> '{}'::jsonb) execute function tohyee_check_custom_values('line');
create trigger ledger_journal_lines_custom_fields before insert on ledger_journal_lines
  for each row when (new.custom_fields <> '{}'::jsonb) execute function tohyee_check_custom_values('line');
`,
  },
  {
    version: "0018",
    name: "salespeople",
    sql: `
-- Salespeople (examples SR1-SR8): a customer's default salesperson, and one
-- salesperson on each sales invoice and sales credit note. Never changes an
-- amount; archived, never deleted.
create table salespeople (
  id bigserial primary key,
  name text not null check (length(name) between 1 and 100),
  email text check (email is null or length(email) between 3 and 254),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index salespeople_name_idx on salespeople (lower(name));

create function tohyee_guard_salesperson() returns trigger
language plpgsql as $$
begin
  if tg_op = 'TRUNCATE' then
    raise exception 'salespeople can''t be truncated' using errcode = 'P0001';
  end if;
  raise exception 'Salespeople can''t be deleted; archive them instead' using errcode = 'P0001';
end;
$$;
create trigger salespeople_guard before delete on salespeople
  for each row execute function tohyee_guard_salesperson();
create trigger salespeople_no_truncate before truncate on salespeople
  for each statement execute function tohyee_guard_salesperson();

alter table contacts add column default_salesperson_id bigint references salespeople(id);
alter table sales_invoices add column salesperson_id bigint references salespeople(id);
alter table sales_credit_notes add column salesperson_id bigint references salespeople(id);
create index sales_invoices_salesperson_idx on sales_invoices (salesperson_id);
create index sales_credit_notes_salesperson_idx on sales_credit_notes (salesperson_id);
`,
  },
  {
    version: "0019",
    name: "crm",
    sql: `
-- The CRM module (examples MOD1, CRM1-CRM9), after Twenty's companies,
-- people, opportunities, tasks and notes. Companies are contacts; a contact
-- can now be a prospect as well as (or instead of) a customer or supplier.
alter table organisation_settings add column crm_enabled boolean not null default false;

do $$
declare
  name text;
begin
  select conname into name from pg_constraint
   where conrelid = 'contacts'::regclass and contype = 'c'
     and pg_get_constraintdef(oid) ilike '%is_customer OR is_supplier%';
  if name is not null then
    execute format('alter table contacts drop constraint %I', name);
  end if;
end;
$$;
alter table contacts add column is_prospect boolean not null default false;
alter table contacts add constraint contacts_kind_check check (is_customer or is_supplier or is_prospect);

create table crm_people (
  id bigserial primary key,
  contact_id bigint references contacts(id),
  first_name text not null check (length(first_name) between 1 and 100),
  last_name text check (last_name is null or length(last_name) between 1 and 100),
  job_title text check (job_title is null or length(job_title) between 1 and 100),
  email text check (email is null or length(email) between 3 and 254),
  phone text check (phone is null or length(phone) between 1 and 50),
  is_archived boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index crm_people_contact_idx on crm_people (contact_id);
create index crm_people_email_idx on crm_people (lower(email));

create table crm_opportunities (
  id bigserial primary key,
  name text not null check (length(name) between 1 and 200),
  contact_id bigint not null references contacts(id),
  point_of_contact_id bigint references crm_people(id),
  owner_user_id text,
  amount numeric(20, 2) not null default 0 check (amount >= 0),
  close_date date,
  stage text not null default 'new' check (stage in ('new', 'screening', 'meeting', 'proposal', 'won', 'lost')),
  position integer not null default 0,
  invoice_id bigint references sales_invoices(id),
  created_by_email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (invoice_id is null or stage = 'won')
);
create index crm_opportunities_contact_idx on crm_opportunities (contact_id);
create unique index crm_opportunities_invoice_idx on crm_opportunities (invoice_id) where invoice_id is not null;

create table crm_tasks (
  id bigserial primary key,
  title text not null check (length(title) between 1 and 200),
  body text check (body is null or length(body) <= 4000),
  due_date date,
  status text not null default 'todo' check (status in ('todo', 'in_progress', 'done')),
  assignee_user_id text,
  contact_id bigint references contacts(id),
  person_id bigint references crm_people(id),
  opportunity_id bigint references crm_opportunities(id),
  created_by_email text,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index crm_tasks_contact_idx on crm_tasks (contact_id);
create index crm_tasks_open_idx on crm_tasks (due_date) where status <> 'done';

create table crm_activities (
  id bigserial primary key,
  kind text not null check (kind in ('call', 'meeting', 'note')),
  happened_at timestamptz not null,
  subject text not null check (length(subject) between 1 and 200),
  body text check (body is null or length(body) <= 10000),
  contact_id bigint references contacts(id),
  person_id bigint references crm_people(id),
  opportunity_id bigint references crm_opportunities(id),
  created_by_email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (contact_id is not null or person_id is not null or opportunity_id is not null)
);
create index crm_activities_contact_idx on crm_activities (contact_id);

-- People, opportunities, tasks and activities are never deleted.
create trigger crm_people_no_delete before delete on crm_people for each row execute function toeyee_forbid_delete();
create trigger crm_people_no_truncate before truncate on crm_people for each statement execute function toeyee_forbid_delete();
create trigger crm_opportunities_no_delete before delete on crm_opportunities for each row execute function toeyee_forbid_delete();
create trigger crm_opportunities_no_truncate before truncate on crm_opportunities for each statement execute function toeyee_forbid_delete();
create trigger crm_tasks_no_delete before delete on crm_tasks for each row execute function toeyee_forbid_delete();
create trigger crm_tasks_no_truncate before truncate on crm_tasks for each statement execute function toeyee_forbid_delete();
create trigger crm_activities_no_delete before delete on crm_activities for each row execute function toeyee_forbid_delete();
create trigger crm_activities_no_truncate before truncate on crm_activities for each statement execute function toeyee_forbid_delete();

-- Once an opportunity has made an invoice it stays won with that invoice.
create function tohyee_guard_crm_opportunity() returns trigger
language plpgsql as $$
begin
  if old.invoice_id is not null and (new.invoice_id is distinct from old.invoice_id or new.stage <> 'won') then
    raise exception 'This opportunity has made an invoice, so its stage can''t change' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger crm_opportunities_guard before update on crm_opportunities
  for each row execute function tohyee_guard_crm_opportunity();
`,
  },
  {
    version: "0020",
    name: "crm_mail",
    sql: `
-- CRM email and calendar sync (examples MAIL1-MAIL9). The organisation's own
-- Google and Microsoft app, each member's connected mailbox, and the emails
-- and meetings kept because a known person or company took part.
create table crm_mail_settings (
  id boolean primary key default true check (id),
  google_client_id text,
  google_client_secret_ciphertext text,
  microsoft_client_id text,
  microsoft_client_secret_ciphertext text,
  microsoft_tenant text not null default 'common',
  updated_at timestamptz not null default now()
);
insert into crm_mail_settings (id) values (true);

create table crm_oauth_states (
  state text primary key,
  user_id text not null,
  provider text not null check (provider in ('google', 'microsoft')),
  created_at timestamptz not null default now(),
  used_at timestamptz
);

create table crm_connected_accounts (
  id bigserial primary key,
  user_id text not null,
  provider text not null check (provider in ('google', 'microsoft')),
  email text not null,
  refresh_token_ciphertext text not null,
  access_token_ciphertext text,
  access_token_expires_at timestamptz,
  visibility text not null default 'subject' check (visibility in ('subject', 'metadata')),
  status text not null default 'active' check (status in ('active', 'paused')),
  messages_synced_until timestamptz,
  calendar_synced_at timestamptz,
  last_sync_at timestamptz,
  last_error text,
  failures integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index crm_connected_accounts_email_idx on crm_connected_accounts (provider, lower(email));

create table crm_messages (
  id bigserial primary key,
  account_id bigint not null references crm_connected_accounts(id) on delete cascade,
  external_id text not null,
  thread_id text,
  direction text not null check (direction in ('sent', 'received')),
  sent_at timestamptz not null,
  from_email text not null,
  from_name text,
  to_emails text[] not null default '{}',
  subject text,
  preview text check (preview is null or length(preview) <= 300),
  created_at timestamptz not null default now(),
  unique (account_id, external_id)
);

create table crm_calendar_events (
  id bigserial primary key,
  account_id bigint not null references crm_connected_accounts(id) on delete cascade,
  external_id text not null,
  title text,
  starts_at timestamptz not null,
  ends_at timestamptz,
  location text,
  attendee_emails text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (account_id, external_id)
);

-- Who each email or meeting was with: a CRM person and/or a company.
create table crm_participant_links (
  id bigserial primary key,
  message_id bigint references crm_messages(id) on delete cascade,
  event_id bigint references crm_calendar_events(id) on delete cascade,
  person_id bigint references crm_people(id),
  contact_id bigint references contacts(id),
  check ((message_id is null) <> (event_id is null)),
  check (person_id is not null or contact_id is not null)
);
create index crm_participant_links_contact_idx on crm_participant_links (contact_id);
create index crm_participant_links_person_idx on crm_participant_links (person_id);
create index crm_participant_links_message_idx on crm_participant_links (message_id);
create index crm_participant_links_event_idx on crm_participant_links (event_id);
`,
  },
  {
    version: "0021",
    name: "richer_customers",
    sql: `
-- Richer customers (examples RC1-RC12), NetSuite's customer detail.
-- Payment terms are for every organisation (like Xero's); the rest shows
-- while Advanced reporting is on. Lists are archived, never deleted.

-- Payment terms (RC1, RC2): N days after the invoice date, N days after the
-- end of the invoice's month, or day N of the following month.
create table payment_terms (
  id bigserial primary key,
  name text not null check (length(name) between 1 and 100),
  kind text not null check (kind in ('days_after_invoice', 'days_after_month_end', 'day_of_next_month')),
  days integer not null check (days between 0 and 365),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (kind <> 'day_of_next_month' or days between 1 and 31)
);
create unique index payment_terms_name_idx on payment_terms (lower(name));
create trigger payment_terms_no_delete before delete on payment_terms for each row execute function toeyee_forbid_delete();
create trigger payment_terms_no_truncate before truncate on payment_terms for each statement execute function toeyee_forbid_delete();
insert into payment_terms (name, kind, days) values
  ('Due on receipt', 'days_after_invoice', 0),
  ('7 days', 'days_after_invoice', 7),
  ('14 days', 'days_after_invoice', 14),
  ('30 days', 'days_after_invoice', 30),
  ('20th of the following month', 'day_of_next_month', 20),
  ('30 days after the end of the month', 'days_after_month_end', 30);

-- Customer groups (RC7), like NetSuite's customer categories.
create table customer_groups (
  id bigserial primary key,
  name text not null check (length(name) between 1 and 100),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index customer_groups_name_idx on customer_groups (lower(name));
create trigger customer_groups_no_delete before delete on customer_groups for each row execute function toeyee_forbid_delete();
create trigger customer_groups_no_truncate before truncate on customer_groups for each statement execute function toeyee_forbid_delete();

-- Price levels (RC7), like NetSuite's: a percent off (negative) or on
-- (positive) the base price. Item prices come with items; nothing uses the
-- percent yet.
create table price_levels (
  id bigserial primary key,
  name text not null check (length(name) between 1 and 100),
  markup_percent numeric not null check (markup_percent > -100 and markup_percent <= 1000),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index price_levels_name_idx on price_levels (lower(name));
create trigger price_levels_no_delete before delete on price_levels for each row execute function toeyee_forbid_delete();
create trigger price_levels_no_truncate before truncate on price_levels for each statement execute function toeyee_forbid_delete();

-- The existing postal address is the billing address (RC6).
comment on column contacts.postal_address is 'The billing address (RC6)';
alter table contacts
  add column delivery_address text check (delivery_address is null or length(delivery_address) between 1 and 500),
  add column payment_term_id bigint references payment_terms(id),
  add column credit_limit numeric check (credit_limit is null or credit_limit >= 0),
  add column customer_group_id bigint references customer_groups(id),
  add column price_level_id bigint references price_levels(id),
  add column parent_contact_id bigint references contacts(id),
  add constraint contacts_not_own_parent check (parent_contact_id is null or parent_contact_id <> id);
create index contacts_parent_idx on contacts (parent_contact_id) where parent_contact_id is not null;

-- Parent and sub-customers (RC8): both must be customers, no loops, and at
-- most 4 levels from the top customer down.
create function tohyee_check_customer_hierarchy() returns trigger
language plpgsql as $$
declare
  cursor_id bigint;
  parent_is_customer boolean;
  above integer := 0;
  below integer;
begin
  if new.parent_contact_id is not null then
    if not new.is_customer then
      raise exception 'Only a customer can have a parent customer' using errcode = 'P0001';
    end if;
    select is_customer into parent_is_customer from contacts where id = new.parent_contact_id;
    if not coalesce(parent_is_customer, false) then
      raise exception 'A parent customer must be a customer' using errcode = 'P0001';
    end if;
    cursor_id := new.parent_contact_id;
    while cursor_id is not null loop
      if cursor_id = new.id then
        raise exception 'A customer can''t be under one of its own sub-customers' using errcode = 'P0001';
      end if;
      above := above + 1;
      exit when above > 10;
      select parent_contact_id into cursor_id from contacts where id = cursor_id;
    end loop;
    with recursive sub(id, depth) as (
      select id, 1 from contacts where parent_contact_id = new.id
      union all
      select c.id, s.depth + 1 from contacts c join sub s on c.parent_contact_id = s.id where s.depth < 10
    )
    select coalesce(max(depth), 0) into below from sub;
    if above + 1 + below > 4 then
      raise exception 'A customer hierarchy can be at most 4 levels deep' using errcode = 'P0001';
    end if;
  end if;
  if tg_op = 'UPDATE' and old.is_customer and not new.is_customer
     and exists (select 1 from contacts where parent_contact_id = new.id) then
    raise exception 'A customer with sub-customers must stay a customer' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger contacts_customer_hierarchy before insert or update of parent_contact_id, is_customer on contacts
  for each row execute function tohyee_check_customer_hierarchy();

-- Credit limits (RC3-RC5): warn (approve and say so) or block.
alter table organisation_settings
  add column credit_limit_action text not null default 'warn' check (credit_limit_action in ('warn', 'block'));

-- Contact people are the CRM's people (RC6); one per company can be the
-- primary contact for invoices.
alter table crm_people add column is_primary boolean not null default false;
alter table crm_people add constraint crm_people_primary_check check (not is_primary or (contact_id is not null and not is_archived));
create unique index crm_people_primary_idx on crm_people (contact_id) where is_primary;
`,
  },
  {
    version: "0022",
    name: "items",
    sql: `
-- Products and services (examples IT1-IT9), like Xero's items with
-- NetSuite's extras. Every organisation has the item list (service,
-- non-stock and stock items); units of measure, price levels, supplier
-- prices and kits are set while Advanced reporting is on. Items and their
-- units are archived, never deleted. In this step a stock item only records
-- its type: nothing moves stock or posts cost of sales yet.
create table items (
  id bigserial primary key,
  command_source text not null,
  idempotency_key text not null,
  request_hash text not null,
  code text not null check (code ~ '^[A-Za-z0-9][A-Za-z0-9._/-]{0,49}$'),
  name text not null check (length(name) between 1 and 150),
  description text check (description is null or length(description) between 1 and 500),
  item_type text not null check (item_type in ('service', 'non_stock', 'stock', 'kit')),
  base_unit text not null default 'each' check (length(base_unit) between 1 and 30),
  sale_price numeric check (sale_price is null or (sale_price > 0 and scale(sale_price) <= 4)),
  purchase_price numeric check (purchase_price is null or (purchase_price > 0 and scale(purchase_price) <= 4)),
  income_account_id bigint references accounts(id),
  purchase_account_id bigint references accounts(id),
  sales_tax_code_id bigint references tax_codes(id),
  purchase_tax_code_id bigint references tax_codes(id),
  sale_unit_id bigint,
  purchase_unit_id bigint,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (command_source, idempotency_key)
);
-- Codes are unique ignoring case, archived items included.
create unique index items_code_idx on items (lower(code));
create trigger items_no_delete before delete on items for each row execute function toeyee_forbid_delete();
create trigger items_no_truncate before truncate on items for each statement execute function toeyee_forbid_delete();

-- Units of measure (IT5): a fixed multiple of the item's base unit, e.g.
-- "Box of 12" = 12 each. The multiple never changes (add a new unit instead),
-- so lines already saved keep their meaning.
create table item_units (
  id bigserial primary key,
  item_id bigint not null references items(id),
  name text not null check (length(name) between 1 and 30),
  factor numeric not null check (factor > 0 and scale(factor) <= 4),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (item_id, id)
);
create unique index item_units_name_idx on item_units (item_id, lower(name));
create function tohyee_guard_item_unit() returns trigger
language plpgsql as $$
begin
  if tg_op = 'TRUNCATE' then
    raise exception 'item_units can''t be truncated' using errcode = 'P0001';
  end if;
  if tg_op = 'DELETE' then
    raise exception 'Units can''t be deleted; archive them instead' using errcode = 'P0001';
  end if;
  if new.factor <> old.factor or new.item_id <> old.item_id then
    raise exception 'A unit''s size can''t change; archive it and add a new unit' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger item_units_guard before update or delete on item_units for each row execute function tohyee_guard_item_unit();
create trigger item_units_no_truncate before truncate on item_units for each statement execute function tohyee_guard_item_unit();
alter table items add constraint items_sale_unit_fk foreign key (id, sale_unit_id) references item_units (item_id, id);
alter table items add constraint items_purchase_unit_fk foreign key (id, purchase_unit_id) references item_units (item_id, id);

-- Prices for price levels (IT4): an explicit price overrides the level's
-- percent for this item.
create table item_level_prices (
  item_id bigint not null references items(id),
  price_level_id bigint not null references price_levels(id),
  price numeric not null check (price > 0 and scale(price) <= 4),
  primary key (item_id, price_level_id)
);

-- Supplier prices (IT6): each supplier's price and their code for the item;
-- at most one preferred supplier per item.
create table item_suppliers (
  item_id bigint not null references items(id),
  contact_id bigint not null references contacts(id),
  price numeric check (price is null or (price > 0 and scale(price) <= 4)),
  supplier_item_code text check (supplier_item_code is null or length(supplier_item_code) between 1 and 50),
  is_preferred boolean not null default false,
  primary key (item_id, contact_id)
);
create unique index item_suppliers_preferred_idx on item_suppliers (item_id) where is_preferred;

-- Kits (IT7): a bundle of other items. No kits inside kits.
create table kit_components (
  kit_item_id bigint not null references items(id),
  component_item_id bigint not null references items(id),
  quantity numeric not null check (quantity > 0 and scale(quantity) <= 4),
  primary key (kit_item_id, component_item_id),
  check (kit_item_id <> component_item_id)
);
create index kit_components_component_idx on kit_components (component_item_id);

create function tohyee_check_kit_component() returns trigger
language plpgsql as $$
begin
  if (select item_type from items where id = new.kit_item_id) <> 'kit' then
    raise exception 'Only a kit can have components' using errcode = 'P0001';
  end if;
  if (select item_type from items where id = new.component_item_id) = 'kit' then
    raise exception 'A kit can''t be inside another kit' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger kit_components_check before insert or update on kit_components
  for each row execute function tohyee_check_kit_component();

create function tohyee_check_item_kind() returns trigger
language plpgsql as $$
begin
  if new.item_type = 'kit' and exists (select 1 from kit_components where component_item_id = new.id) then
    raise exception 'This item is part of a kit, so it can''t be a kit itself' using errcode = 'P0001';
  end if;
  if new.item_type <> 'kit' and exists (select 1 from kit_components where kit_item_id = new.id) then
    raise exception 'A kit with components can''t change type; remove its components first' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger items_kind_check before update of item_type on items
  for each row execute function tohyee_check_item_kind();

-- Lines of documents can name an item and the unit used; the quantity in
-- the item's base unit is worked out exactly and kept with the line.
alter table sales_invoice_lines
  add column item_id bigint references items(id),
  add column unit_id bigint references item_units(id),
  add column base_quantity numeric,
  add constraint sales_invoice_lines_item_check check ((item_id is null) = (base_quantity is null) and (unit_id is null or item_id is not null));
alter table bill_lines
  add column item_id bigint references items(id),
  add column unit_id bigint references item_units(id),
  add column base_quantity numeric,
  add constraint bill_lines_item_check check ((item_id is null) = (base_quantity is null) and (unit_id is null or item_id is not null));
alter table sales_credit_note_lines
  add column item_id bigint references items(id),
  add column unit_id bigint references item_units(id),
  add column base_quantity numeric,
  add constraint sales_credit_note_lines_item_check check ((item_id is null) = (base_quantity is null) and (unit_id is null or item_id is not null));
alter table supplier_credit_note_lines
  add column item_id bigint references items(id),
  add column unit_id bigint references item_units(id),
  add column base_quantity numeric,
  add constraint supplier_credit_note_lines_item_check check ((item_id is null) = (base_quantity is null) and (unit_id is null or item_id is not null));

-- A line's unit belongs to its item, and its base quantity is exactly the
-- quantity times the unit's size (1 for the base unit).
create function tohyee_check_line_item() returns trigger
language plpgsql as $$
declare
  unit_item bigint;
  unit_factor numeric := 1;
begin
  if new.item_id is null then
    return new;
  end if;
  if new.unit_id is not null then
    select item_id, factor into unit_item, unit_factor from item_units where id = new.unit_id;
    if unit_item is distinct from new.item_id then
      raise exception 'A line''s unit must be one of its item''s units' using errcode = 'P0001';
    end if;
  end if;
  if new.base_quantity <> new.quantity * unit_factor then
    raise exception 'A line''s base quantity must be its quantity times its unit' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger sales_invoice_lines_item before insert or update on sales_invoice_lines
  for each row execute function tohyee_check_line_item();
create trigger bill_lines_item before insert or update on bill_lines
  for each row execute function tohyee_check_line_item();
create trigger sales_credit_note_lines_item before insert or update on sales_credit_note_lines
  for each row execute function tohyee_check_line_item();
create trigger supplier_credit_note_lines_item before insert or update on supplier_credit_note_lines
  for each row execute function tohyee_check_line_item();
`,
  },
  {
    version: "0023",
    name: "stock_tracking",
    sql: `
-- Stock tracking (examples ST1-ST12): weighted average per item and
-- location. A location is a value of the Location tracking category; with
-- none, an item has one default pool (location null). Stock items on bills,
-- invoices and credit notes move stock in the same transaction as their
-- journal. Stock can go below zero only while the organisation allows it.

alter table organisation_settings add column allow_negative_stock boolean not null default false;

-- Balances: one per item code and location.
alter table inventory_item_balances drop constraint inventory_item_balances_pkey;
alter table inventory_item_balances drop constraint if exists inventory_item_balances_on_hand_quantity_check;
alter table inventory_item_balances drop constraint if exists inventory_item_balances_carrying_value_check;
alter table inventory_item_balances
  add column id bigserial primary key,
  add column location_value_id bigint references tracking_values(id),
  add constraint inventory_item_balances_key unique nulls not distinct (item_code, location_value_id),
  add constraint inventory_item_balances_zero_check check (on_hand_quantity <> 0 or carrying_value = 0);

alter table inventory_movements drop constraint if exists inventory_movements_quantity_after_check;
alter table inventory_movements drop constraint if exists inventory_movements_value_after_check;
alter table inventory_movements drop constraint if exists inventory_movements_movement_type_check;
alter table inventory_movements
  add constraint inventory_movements_movement_type_check check (
    movement_type in ('receipt', 'issue', 'adjustment', 'customer_return', 'supplier_return', 'landed_cost', 'reversal')
  ),
  add column item_id bigint references items(id),
  add column location_value_id bigint references tracking_values(id),
  -- ST10: a receipt into negative stock; what the filled units cost less
  -- the value they went out at, posted to cost of sales.
  add column cost_adjustment numeric not null default 0,
  -- The document that moved the stock (null for movements entered directly).
  add column source_type text check (source_type is null or source_type in (
    'invoice', 'invoice_void', 'bill', 'bill_void', 'credit_note', 'credit_note_void',
    'supplier_credit_note', 'supplier_credit_note_void')),
  add column source_id bigint,
  add column reversal_of_movement_id bigint unique references inventory_movements(id),
  add constraint inventory_movements_zero_check check (quantity_after <> 0 or value_after = 0),
  add constraint inventory_movements_reversal_check check ((movement_type = 'reversal') = (reversal_of_movement_id is not null)),
  add constraint inventory_movements_source_check check ((source_type is null) = (source_id is null));
create index inventory_movements_balance_idx on inventory_movements (item_code, location_value_id, id);
create index inventory_movements_source_idx on inventory_movements (source_type, source_id);

-- Below zero only while the organisation allows negative stock (ST9, ST10).
create function tohyee_check_negative_stock() returns trigger
language plpgsql as $$
declare
  allowed boolean;
  below boolean;
begin
  if tg_table_name = 'inventory_movements' then
    below := new.quantity_after < 0 or new.value_after < 0;
  else
    below := new.on_hand_quantity < 0 or new.carrying_value < 0;
  end if;
  if below then
    select allow_negative_stock into allowed from organisation_settings where id = true;
    if not coalesce(allowed, false) then
      raise exception 'Stock can''t go negative' using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$;
create trigger inventory_movements_negative before insert on inventory_movements
  for each row execute function tohyee_check_negative_stock();
create trigger inventory_item_balances_negative before insert or update on inventory_item_balances
  for each row execute function tohyee_check_negative_stock();

-- ST12: negative stock can't be turned off while anything is below zero.
create function tohyee_check_negative_stock_setting() returns trigger
language plpgsql as $$
begin
  if old.allow_negative_stock and not new.allow_negative_stock
     and exists (select 1 from inventory_item_balances where on_hand_quantity < 0 or carrying_value < 0) then
    raise exception 'Some stock is below zero, so negative stock can''t be turned off' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger organisation_settings_negative_stock before update of allow_negative_stock on organisation_settings
  for each row execute function tohyee_check_negative_stock_setting();

-- ST5: a credit note returning stock names the invoice it was sold on, so
-- it's restocked at that sale's cost.
alter table sales_credit_notes add column return_invoice_id bigint references sales_invoices(id);
`,
  },
  {
    version: "0024",
    name: "sales_documents",
    sql: `
-- Quotes (examples QT1-QT8), repeating invoices (RI1-RI10) and what printed
-- documents show about the organisation (PD1-PD8). Quotes and templates
-- post nothing; only the invoices they make ever reach the ledger.

-- What printed invoices, credit notes and quotes show (PD1). The GST number
-- is stored as digits, like contacts'.
alter table organisation_settings
  add column postal_address text check (postal_address is null or length(postal_address) between 1 and 500),
  add column gst_number text check (gst_number is null or gst_number ~ '^[0-9]{8,9}$'),
  add column payment_details text check (payment_details is null or length(payment_details) between 1 and 1000);

-- Quote numbers are taken when a quote is finalised, from their own counter
-- that only moves forward by one, so QU- numbers have no gaps (QT2).
create table quote_numbering (
  id boolean primary key default true check (id),
  last_number integer not null default 0 check (last_number >= 0)
);
insert into quote_numbering (id) values (true);
create trigger quote_numbering_guard
  before update or delete on quote_numbering
  for each row execute function toeyee_guard_invoice_numbering();
create trigger quote_numbering_no_truncate
  before truncate on quote_numbering
  for each statement execute function toeyee_guard_invoice_numbering();

create table quotes (
  id bigserial primary key,
  command_source text not null,
  idempotency_key text not null,
  request_hash text not null,
  status text not null default 'draft' check (status in ('draft', 'finalised', 'accepted', 'declined')),
  contact_id bigint not null references contacts(id),
  quote_date date not null,
  expiry_date date,
  reference text check (reference is null or length(reference) between 1 and 100),
  terms text check (terms is null or length(terms) between 1 and 2000),
  amounts_mode text not null check (amounts_mode in ('exclusive', 'inclusive', 'no_tax')),
  currency_code text not null check (currency_code ~ '^[A-Z]{3}$'),
  subtotal numeric not null check (subtotal >= 0),
  tax_total numeric not null check (tax_total >= 0),
  total numeric not null check (total > 0),
  custom_fields jsonb not null default '{}'::jsonb,
  salesperson_id bigint references salespeople(id),
  copied_from_quote_id bigint references quotes(id),
  quote_sequence integer unique check (quote_sequence > 0),
  quote_number text unique,
  finalise_command_source text,
  finalise_idempotency_key text,
  finalise_request_hash text,
  finalised_by_user_id uuid,
  finalised_by_email text,
  finalised_at timestamptz,
  -- Accepting makes a draft invoice carrying the quote's lines (QT3).
  invoice_id bigint unique references sales_invoices(id),
  close_command_source text,
  close_idempotency_key text,
  close_request_hash text,
  closed_by_user_id uuid,
  closed_by_email text,
  closed_at timestamptz,
  created_by_user_id uuid,
  created_by_email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (command_source, idempotency_key),
  unique (finalise_command_source, finalise_idempotency_key),
  unique (close_command_source, close_idempotency_key),
  check (expiry_date is null or expiry_date >= quote_date),
  check (total = subtotal + tax_total),
  check (quote_number is null or quote_number = 'QU-' || lpad(quote_sequence::text, greatest(4, length(quote_sequence::text)), '0')),
  check ((status = 'draft') = (quote_number is null)),
  check ((status = 'draft') = (finalised_at is null)),
  check ((status in ('draft', 'finalised')) = (closed_at is null)),
  check ((status = 'accepted') = (invoice_id is not null))
);
create index quotes_status_idx on quotes (status, id);
create index quotes_contact_idx on quotes (contact_id);

create table quote_lines (
  id bigserial primary key,
  quote_id bigint not null references quotes(id),
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
  tracking jsonb not null default '{}'::jsonb,
  custom_fields jsonb not null default '{}'::jsonb,
  item_id bigint references items(id),
  unit_id bigint references item_units(id),
  base_quantity numeric,
  unique (quote_id, line_order),
  check (tax_code_id is not null or tax_rate = 0),
  check (net_amount = line_amount or net_amount + tax_amount = line_amount),
  check ((item_id is null) = (base_quantity is null) and (unit_id is null or item_id is not null))
);

-- A draft can be edited and deleted. A finalised quote is locked: it can
-- only become accepted (with its invoice) or declined, once. Its lines are
-- frozen with it (QT2, QT3, QT4).
create function tohyee_guard_quote() returns trigger
language plpgsql as $$
begin
  if tg_op = 'TRUNCATE' then
    raise exception 'quotes can''t be truncated' using errcode = 'P0001';
  end if;
  if old.status = 'draft' then
    if tg_op = 'DELETE' then
      return old;
    end if;
    return new;
  end if;
  if tg_op = 'DELETE' then
    raise exception 'Quote % is %, so it can''t be deleted', old.quote_number, old.status using errcode = 'P0001';
  end if;
  if old.status = 'finalised' and new.status in ('accepted', 'declined')
     and (to_jsonb(new) - array['status', 'invoice_id', 'close_command_source', 'close_idempotency_key',
            'close_request_hash', 'closed_by_user_id', 'closed_by_email', 'closed_at', 'updated_at'])
       = (to_jsonb(old) - array['status', 'invoice_id', 'close_command_source', 'close_idempotency_key',
            'close_request_hash', 'closed_by_user_id', 'closed_by_email', 'closed_at', 'updated_at']) then
    return new;
  end if;
  raise exception 'Quote % is %, so it can''t be changed', old.quote_number, old.status using errcode = 'P0001';
end;
$$;
create trigger quotes_guard before update or delete on quotes
  for each row execute function tohyee_guard_quote();
create trigger quotes_no_truncate before truncate on quotes
  for each statement execute function tohyee_guard_quote();

create function tohyee_guard_quote_line() returns trigger
language plpgsql as $$
declare
  parent_status text;
begin
  if tg_op = 'TRUNCATE' then
    raise exception 'quote_lines can''t be truncated' using errcode = 'P0001';
  end if;
  select status into parent_status from quotes
   where id = case when tg_op = 'DELETE' then old.quote_id else new.quote_id end for share;
  if parent_status <> 'draft' then
    raise exception 'Lines of a finalised quote can''t be changed' using errcode = 'P0001';
  end if;
  if tg_op = 'UPDATE' and old.quote_id <> new.quote_id then
    raise exception 'A quote line can''t move to another quote' using errcode = 'P0001';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;
create trigger quote_lines_guard before insert or update or delete on quote_lines
  for each row execute function tohyee_guard_quote_line();
create trigger quote_lines_no_truncate before truncate on quote_lines
  for each statement execute function tohyee_guard_quote_line();
create trigger quote_lines_item before insert or update on quote_lines
  for each row execute function tohyee_check_line_item();
create trigger quote_lines_tracking before insert or update on quote_lines
  for each row when (new.tracking <> '{}'::jsonb) execute function tohyee_check_line_tracking();
create trigger quotes_custom_fields before insert or update on quotes
  for each row when (new.custom_fields <> '{}'::jsonb) execute function tohyee_check_custom_values('document');
create trigger quote_lines_custom_fields before insert or update on quote_lines
  for each row when (new.custom_fields <> '{}'::jsonb) execute function tohyee_check_custom_values('line');

-- Repeating invoice templates (RI1-RI10). Every N weeks or months from the
-- start date (the day is kept, or the month's last day when it's shorter),
-- until the end date if there is one. Templates are ended, never deleted.
create table repeating_invoices (
  id bigserial primary key,
  command_source text not null,
  idempotency_key text not null,
  request_hash text not null,
  status text not null default 'active' check (status in ('active', 'paused', 'ended')),
  contact_id bigint not null references contacts(id),
  reference text check (reference is null or length(reference) between 1 and 100),
  amounts_mode text not null check (amounts_mode in ('exclusive', 'inclusive', 'no_tax')),
  currency_code text not null check (currency_code ~ '^[A-Z]{3}$'),
  subtotal numeric not null check (subtotal >= 0),
  tax_total numeric not null check (tax_total >= 0),
  total numeric not null check (total > 0),
  custom_fields jsonb not null default '{}'::jsonb,
  salesperson_id bigint references salespeople(id),
  period text not null check (period in ('week', 'month')),
  every integer not null check (every between 1 and 99),
  start_date date not null,
  end_date date,
  due_rule text not null check (due_rule in ('terms', 'days_after')),
  due_days integer check (due_days between 0 and 365),
  save_as text not null check (save_as in ('draft', 'approve')),
  -- RI7: dates before a resume aren't made.
  resumed_from date,
  -- RI9: why the last run stopped (cleared by the next good one).
  last_error text,
  last_error_at timestamptz,
  created_by_user_id uuid,
  created_by_email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (command_source, idempotency_key),
  check (end_date is null or end_date >= start_date),
  check ((due_rule = 'days_after') = (due_days is not null)),
  check (total = subtotal + tax_total)
);
create trigger repeating_invoices_no_delete before delete on repeating_invoices
  for each row execute function toeyee_forbid_delete();
create trigger repeating_invoices_no_truncate before truncate on repeating_invoices
  for each statement execute function toeyee_forbid_delete();

-- An ended template can't change or start again (RI7).
create function tohyee_guard_repeating_invoice() returns trigger
language plpgsql as $$
begin
  if old.status = 'ended' then
    raise exception 'This repeating invoice has ended, so it can''t be changed' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger repeating_invoices_guard before update on repeating_invoices
  for each row execute function tohyee_guard_repeating_invoice();

create table repeating_invoice_lines (
  id bigserial primary key,
  repeating_invoice_id bigint not null references repeating_invoices(id),
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
  tracking jsonb not null default '{}'::jsonb,
  custom_fields jsonb not null default '{}'::jsonb,
  item_id bigint references items(id),
  unit_id bigint references item_units(id),
  base_quantity numeric,
  unique (repeating_invoice_id, line_order),
  check (tax_code_id is not null or tax_rate = 0),
  check (net_amount = line_amount or net_amount + tax_amount = line_amount),
  check ((item_id is null) = (base_quantity is null) and (unit_id is null or item_id is not null))
);
create function tohyee_guard_repeating_invoice_line() returns trigger
language plpgsql as $$
begin
  if tg_op = 'TRUNCATE' then
    raise exception 'repeating_invoice_lines can''t be truncated' using errcode = 'P0001';
  end if;
  if (select status from repeating_invoices
       where id = case when tg_op = 'DELETE' then old.repeating_invoice_id else new.repeating_invoice_id end) = 'ended' then
    raise exception 'Lines of an ended repeating invoice can''t be changed' using errcode = 'P0001';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;
create trigger repeating_invoice_lines_guard before insert or update or delete on repeating_invoice_lines
  for each row execute function tohyee_guard_repeating_invoice_line();
create trigger repeating_invoice_lines_no_truncate before truncate on repeating_invoice_lines
  for each statement execute function tohyee_guard_repeating_invoice_line();
create trigger repeating_invoice_lines_item before insert or update on repeating_invoice_lines
  for each row execute function tohyee_check_line_item();
create trigger repeating_invoice_lines_tracking before insert or update on repeating_invoice_lines
  for each row when (new.tracking <> '{}'::jsonb) execute function tohyee_check_line_tracking();
create trigger repeating_invoices_custom_fields before insert or update on repeating_invoices
  for each row when (new.custom_fields <> '{}'::jsonb) execute function tohyee_check_custom_values('document');
create trigger repeating_invoice_lines_custom_fields before insert or update on repeating_invoice_lines
  for each row when (new.custom_fields <> '{}'::jsonb) execute function tohyee_check_custom_values('line');

-- One row per scheduled date that made an invoice: the unique key is what
-- stops a date being made twice, however often the job runs (RI3). Rows
-- are never changed or deleted, except that deleting the draft invoice
-- clears its link (RI10), so the date isn't made again.
create table repeating_invoice_runs (
  id bigserial primary key,
  repeating_invoice_id bigint not null references repeating_invoices(id),
  scheduled_date date not null,
  invoice_id bigint unique references sales_invoices(id) on delete set null,
  invoice_deleted boolean not null default false,
  outcome text not null check (outcome in ('draft', 'approved', 'approval_refused')),
  message text check (message is null or length(message) between 1 and 1000),
  created_by_email text,
  created_at timestamptz not null default now(),
  unique (repeating_invoice_id, scheduled_date),
  check (outcome <> 'approval_refused' or message is not null),
  check (outcome <> 'draft' or message is null)
);
create function tohyee_guard_repeating_invoice_run() returns trigger
language plpgsql as $$
begin
  if tg_op = 'TRUNCATE' then
    raise exception 'repeating_invoice_runs can''t be truncated' using errcode = 'P0001';
  end if;
  if tg_op = 'DELETE' then
    raise exception 'A repeating invoice''s history can''t be deleted' using errcode = 'P0001';
  end if;
  if old.invoice_id is not null and new.invoice_id is null
     and (to_jsonb(new) - array['invoice_id', 'invoice_deleted']) = (to_jsonb(old) - array['invoice_id', 'invoice_deleted']) then
    new.invoice_deleted := true;
    return new;
  end if;
  raise exception 'A repeating invoice''s history can''t be changed' using errcode = 'P0001';
end;
$$;
create trigger repeating_invoice_runs_guard before update or delete on repeating_invoice_runs
  for each row execute function tohyee_guard_repeating_invoice_run();
create trigger repeating_invoice_runs_no_truncate before truncate on repeating_invoice_runs
  for each statement execute function tohyee_guard_repeating_invoice_run();
`,
  },
  {
    version: "0025",
    name: "purchase_orders",
    sql: `
-- Purchase orders (examples PO1-PO9). A draft can be edited and deleted;
-- approving numbers it (PO-0001, no gaps) and locks it. Purchase orders post
-- nothing. "Copy to bill" makes a draft bill whose lines point back to the
-- purchase order's lines; what's billed is worked out from those bills, never
-- stored. An approved purchase order with no bills can be cancelled.

create table purchase_order_numbering (
  id boolean primary key default true check (id),
  last_number integer not null default 0 check (last_number >= 0)
);
insert into purchase_order_numbering (id) values (true);
create trigger purchase_order_numbering_guard
  before update or delete on purchase_order_numbering
  for each row execute function toeyee_guard_invoice_numbering();
create trigger purchase_order_numbering_no_truncate
  before truncate on purchase_order_numbering
  for each statement execute function toeyee_guard_invoice_numbering();

create table purchase_orders (
  id bigserial primary key,
  command_source text not null,
  idempotency_key text not null,
  request_hash text not null,
  status text not null default 'draft' check (status in ('draft', 'approved', 'cancelled')),
  contact_id bigint not null references contacts(id),
  order_date date not null,
  delivery_date date,
  delivery_address text check (delivery_address is null or length(delivery_address) between 1 and 500),
  delivery_instructions text check (delivery_instructions is null or length(delivery_instructions) between 1 and 1000),
  reference text check (reference is null or length(reference) between 1 and 100),
  amounts_mode text not null check (amounts_mode in ('exclusive', 'inclusive', 'no_tax')),
  currency_code text not null check (currency_code ~ '^[A-Z]{3}$'),
  subtotal numeric not null check (subtotal >= 0),
  tax_total numeric not null check (tax_total >= 0),
  total numeric not null check (total > 0),
  custom_fields jsonb not null default '{}'::jsonb,
  po_sequence integer unique check (po_sequence > 0),
  po_number text unique,
  approve_command_source text,
  approve_idempotency_key text,
  approve_request_hash text,
  approved_by_user_id uuid,
  approved_by_email text,
  approved_at timestamptz,
  cancel_command_source text,
  cancel_idempotency_key text,
  cancel_request_hash text,
  cancelled_by_user_id uuid,
  cancelled_by_email text,
  cancelled_at timestamptz,
  created_by_user_id uuid,
  created_by_email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (command_source, idempotency_key),
  unique (approve_command_source, approve_idempotency_key),
  unique (cancel_command_source, cancel_idempotency_key),
  check (delivery_date is null or delivery_date >= order_date),
  check (total = subtotal + tax_total),
  check (po_number is null or po_number = 'PO-' || lpad(po_sequence::text, greatest(4, length(po_sequence::text)), '0')),
  check ((status = 'draft') = (po_number is null)),
  check ((status = 'draft') = (approved_at is null)),
  check ((status = 'cancelled') = (cancelled_at is not null))
);
create index purchase_orders_status_idx on purchase_orders (status, id);
create index purchase_orders_contact_idx on purchase_orders (contact_id);

create table purchase_order_lines (
  id bigserial primary key,
  purchase_order_id bigint not null references purchase_orders(id),
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
  tracking jsonb not null default '{}'::jsonb,
  custom_fields jsonb not null default '{}'::jsonb,
  item_id bigint references items(id),
  unit_id bigint references item_units(id),
  base_quantity numeric,
  unique (purchase_order_id, line_order),
  check (tax_code_id is not null or tax_rate = 0),
  check (net_amount = line_amount or net_amount + tax_amount = line_amount),
  check ((item_id is null) = (base_quantity is null) and (unit_id is null or item_id is not null))
);

-- A draft can be edited and deleted. An approved purchase order is locked:
-- it can only be cancelled, once, and only while it has no bills that
-- aren't voided (PO2, PO7). Its lines are frozen with it.
create function tohyee_guard_purchase_order() returns trigger
language plpgsql as $$
declare
  cancel_columns text[] := array['status', 'cancel_command_source', 'cancel_idempotency_key', 'cancel_request_hash',
    'cancelled_by_user_id', 'cancelled_by_email', 'cancelled_at', 'updated_at'];
begin
  if tg_op = 'TRUNCATE' then
    raise exception 'purchase_orders can''t be truncated' using errcode = 'P0001';
  end if;
  if old.status = 'draft' then
    if tg_op = 'DELETE' then
      return old;
    end if;
    if new.status = 'cancelled' then
      raise exception 'A draft purchase order can''t be cancelled; delete it instead' using errcode = 'P0001';
    end if;
    return new;
  end if;
  if tg_op = 'DELETE' then
    raise exception 'Purchase order % is %, so it can''t be deleted', old.po_number, old.status using errcode = 'P0001';
  end if;
  if old.status = 'approved' and new.status = 'cancelled'
     and (to_jsonb(new) - cancel_columns) = (to_jsonb(old) - cancel_columns) then
    if exists (select 1 from bills where purchase_order_id = old.id and status <> 'voided') then
      raise exception 'Purchase order % has bills, so it can''t be cancelled', old.po_number using errcode = 'P0001';
    end if;
    return new;
  end if;
  raise exception 'Purchase order % is %, so it can''t be changed', old.po_number, old.status using errcode = 'P0001';
end;
$$;
create trigger purchase_orders_guard before update or delete on purchase_orders
  for each row execute function tohyee_guard_purchase_order();
create trigger purchase_orders_no_truncate before truncate on purchase_orders
  for each statement execute function tohyee_guard_purchase_order();

create function tohyee_guard_purchase_order_line() returns trigger
language plpgsql as $$
declare
  parent_status text;
begin
  if tg_op = 'TRUNCATE' then
    raise exception 'purchase_order_lines can''t be truncated' using errcode = 'P0001';
  end if;
  select status into parent_status from purchase_orders
   where id = case when tg_op = 'DELETE' then old.purchase_order_id else new.purchase_order_id end for share;
  if parent_status <> 'draft' then
    raise exception 'Lines of an approved purchase order can''t be changed' using errcode = 'P0001';
  end if;
  if tg_op = 'UPDATE' and old.purchase_order_id <> new.purchase_order_id then
    raise exception 'A purchase order line can''t move to another purchase order' using errcode = 'P0001';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;
create trigger purchase_order_lines_guard before insert or update or delete on purchase_order_lines
  for each row execute function tohyee_guard_purchase_order_line();
create trigger purchase_order_lines_no_truncate before truncate on purchase_order_lines
  for each statement execute function tohyee_guard_purchase_order_line();
create trigger purchase_order_lines_item before insert or update on purchase_order_lines
  for each row execute function tohyee_check_line_item();
create trigger purchase_order_lines_tracking before insert or update on purchase_order_lines
  for each row when (new.tracking <> '{}'::jsonb) execute function tohyee_check_line_tracking();
create trigger purchase_orders_custom_fields before insert or update on purchase_orders
  for each row when (new.custom_fields <> '{}'::jsonb) execute function tohyee_check_custom_values('document');
create trigger purchase_order_lines_custom_fields before insert or update on purchase_order_lines
  for each row when (new.custom_fields <> '{}'::jsonb) execute function tohyee_check_custom_values('line');

-- Bills made from a purchase order (PO3-PO6). The bill names it, and each
-- of its lines that came from it names that line.
alter table bills add column purchase_order_id bigint references purchase_orders(id);
create index bills_purchase_order_idx on bills (purchase_order_id) where purchase_order_id is not null;
alter table bill_lines add column purchase_order_line_id bigint references purchase_order_lines(id);
create index bill_lines_purchase_order_line_idx on bill_lines (purchase_order_line_id) where purchase_order_line_id is not null;

-- A bill's purchase order is an approved one from the same supplier, and
-- can't be changed once set.
create function tohyee_check_bill_purchase_order() returns trigger
language plpgsql as $$
declare
  po record;
begin
  if tg_op = 'UPDATE' and new.purchase_order_id is distinct from old.purchase_order_id then
    raise exception 'A bill''s purchase order can''t be changed' using errcode = 'P0001';
  end if;
  if new.purchase_order_id is null then
    return new;
  end if;
  select status, contact_id into po from purchase_orders where id = new.purchase_order_id;
  if po.status <> 'approved' then
    raise exception 'Bills can only be made from an approved purchase order' using errcode = 'P0001';
  end if;
  if po.contact_id <> new.contact_id then
    raise exception 'A bill from a purchase order must be from the purchase order''s supplier' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger bills_purchase_order before insert or update on bills
  for each row execute function tohyee_check_bill_purchase_order();

-- A bill line from a purchase order line: that line is on the bill's own
-- purchase order, has the same item and unit, and the bills that aren't
-- voided never add up to more than was ordered (PO6).
create function tohyee_check_bill_line_purchase_order() returns trigger
language plpgsql as $$
declare
  po_line record;
  bill_po bigint;
  on_bills numeric;
begin
  if new.purchase_order_line_id is null then
    return new;
  end if;
  select purchase_order_id, quantity, item_id, unit_id into po_line from purchase_order_lines where id = new.purchase_order_line_id;
  select purchase_order_id into bill_po from bills where id = new.bill_id;
  if bill_po is distinct from po_line.purchase_order_id then
    raise exception 'A bill line can only come from its own bill''s purchase order' using errcode = 'P0001';
  end if;
  if new.item_id is distinct from po_line.item_id or new.unit_id is distinct from po_line.unit_id then
    raise exception 'A bill line from a purchase order keeps its item and unit' using errcode = 'P0001';
  end if;
  select coalesce(sum(l.quantity), 0) into on_bills
    from bill_lines l join bills b on b.id = l.bill_id
   where l.purchase_order_line_id = new.purchase_order_line_id and b.status <> 'voided';
  if on_bills > po_line.quantity then
    raise exception 'Bills can''t add up to more than the purchase order line ordered' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger bill_lines_purchase_order after insert or update on bill_lines
  for each row execute function tohyee_check_bill_line_purchase_order();
`,
  },
  {
    version: "0026",
    name: "stock_transfers",
    sql: `
-- Stock transfers between locations (examples TR1-TR6). Stock leaves one
-- location at its weighted average cost and arrives at another at the same
-- value: two movements (transfer out, transfer in) and one journal that
-- moves the value between the locations on the inventory account (Dr tagged
-- with the location it goes to, Cr with the one it comes from). Transfers
-- are never changed or deleted; a transfer back undoes one.

create table stock_transfers (
  id bigserial primary key,
  command_source text not null,
  idempotency_key text not null,
  request_hash text not null,
  transfer_date date not null,
  item_id bigint not null references items(id),
  item_code text not null,
  from_location_value_id bigint not null references tracking_values(id),
  to_location_value_id bigint not null references tracking_values(id),
  quantity numeric not null check (quantity > 0 and scale(quantity) <= 4),
  value numeric not null check (value > 0),
  reference text not null check (length(reference) between 1 and 100),
  description text check (description is null or length(description) between 1 and 500),
  journal_id bigint not null unique references ledger_journals(id),
  created_by_user_id uuid,
  created_by_email text,
  created_at timestamptz not null default now(),
  unique (command_source, idempotency_key),
  check (from_location_value_id <> to_location_value_id)
);
create trigger stock_transfers_append_only
  before update or delete on stock_transfers
  for each row execute function toeyee_forbid_mutation();
create trigger stock_transfers_no_truncate
  before truncate on stock_transfers
  for each statement execute function toeyee_forbid_mutation();

alter table inventory_movements drop constraint inventory_movements_movement_type_check;
alter table inventory_movements add constraint inventory_movements_movement_type_check check (
  movement_type in ('receipt', 'issue', 'adjustment', 'customer_return', 'supplier_return', 'landed_cost', 'reversal',
                    'transfer_out', 'transfer_in'));
alter table inventory_movements drop constraint inventory_movements_source_type_check;
alter table inventory_movements add constraint inventory_movements_source_type_check check (source_type is null or source_type in (
  'invoice', 'invoice_void', 'bill', 'bill_void', 'credit_note', 'credit_note_void',
  'supplier_credit_note', 'supplier_credit_note_void', 'transfer'));
-- A transfer's two movements name it (TR1).
alter table inventory_movements add constraint inventory_movements_transfer_check
  check ((movement_type in ('transfer_out', 'transfer_in')) = (source_type is not distinct from 'transfer'));
`,
  },
  {
    version: "0027",
    name: "budgets",
    sql: `
-- Budgets (examples BU1-BU8): an overall budget, which every organisation
-- has and can't archive, and named budgets, optionally for one tracking
-- value. Each holds an amount per profit and loss account per month, in the
-- account's natural direction. Budgets post nothing. They're archived, never
-- deleted; every change of amounts is in audit_events with the old and new
-- amounts.
create table budgets (
  id bigserial primary key,
  command_source text not null,
  idempotency_key text not null,
  request_hash text not null,
  name text not null check (length(name) between 1 and 100 and name = btrim(name)),
  is_overall boolean not null default false,
  tracking_value_id bigint references tracking_values(id),
  version integer not null default 1 check (version > 0),
  archived_at timestamptz,
  archived_by_email text,
  created_by_user_id uuid,
  created_by_email text,
  created_at timestamptz not null default now(),
  updated_by_email text,
  updated_at timestamptz not null default now(),
  unique (command_source, idempotency_key),
  check ((archived_at is null) = (archived_by_email is null)),
  check (not is_overall or (tracking_value_id is null and archived_at is null))
);
create unique index budgets_one_overall on budgets (is_overall) where is_overall;
create unique index budgets_name_key on budgets (lower(name)) where archived_at is null;

create function tohyee_guard_budget() returns trigger
language plpgsql as $$
begin
  if tg_op = 'TRUNCATE' then
    raise exception 'budgets can''t be truncated' using errcode = 'P0001';
  end if;
  if tg_op = 'DELETE' then
    raise exception 'Budgets can''t be deleted, only archived' using errcode = 'P0001';
  end if;
  if new.is_overall <> old.is_overall or new.tracking_value_id is distinct from old.tracking_value_id then
    raise exception 'A budget''s tracking value and whether it''s the overall budget never change' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger budgets_guard
  before update or delete on budgets
  for each row execute function tohyee_guard_budget();
create trigger budgets_no_truncate
  before truncate on budgets
  for each statement execute function tohyee_guard_budget();

create table budget_amounts (
  budget_id bigint not null references budgets(id),
  account_id bigint not null references accounts(id),
  month date not null check (extract(day from month) = 1),
  amount numeric not null check (scale(amount) <= 4),
  updated_by_email text,
  updated_at timestamptz not null default now(),
  primary key (budget_id, account_id, month)
);

-- Amounts are only for profit and loss accounts, can't be changed on an
-- archived budget, and are never deleted (an amount is set to 0.00 instead).
create function tohyee_guard_budget_amount() returns trigger
language plpgsql as $$
begin
  if tg_op = 'TRUNCATE' then
    raise exception 'budget_amounts can''t be truncated' using errcode = 'P0001';
  end if;
  if tg_op = 'DELETE' then
    raise exception 'Budget amounts can''t be deleted; set them to 0.00' using errcode = 'P0001';
  end if;
  if tg_op = 'UPDATE' and (new.budget_id <> old.budget_id or new.account_id <> old.account_id or new.month <> old.month) then
    raise exception 'A budget amount''s budget, account and month never change' using errcode = 'P0001';
  end if;
  if not exists (select 1 from accounts where id = new.account_id and account_class in ('revenue', 'expense')) then
    raise exception 'Budgets hold profit and loss accounts only' using errcode = 'P0001';
  end if;
  if exists (select 1 from budgets where id = new.budget_id and archived_at is not null) then
    raise exception 'This budget is archived, so its amounts can''t change' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger budget_amounts_guard
  before insert or update or delete on budget_amounts
  for each row execute function tohyee_guard_budget_amount();
create trigger budget_amounts_no_truncate
  before truncate on budget_amounts
  for each statement execute function tohyee_guard_budget_amount();

-- Every organisation has an overall budget, like Xero's.
insert into budgets (command_source, idempotency_key, request_hash, name, is_overall)
values ('system', 'overall-budget', 'overall-budget', 'Overall budget', true);
`,
  },
  {
    version: "0028",
    name: "expense_claims",
    sql: `
-- Expense claims (examples EC1-EC12): a member enters receipts they paid
-- for themselves and submits the claim; approving posts Dr each expense
-- account (net) / Dr GST / Cr expense claims payable; paying it posts
-- Dr expense claims payable / Cr the bank account. Declining returns a
-- submitted claim to its claimant as a draft; voiding an approved claim with
-- no active payments posts the exact reversal.

-- The liability approved claims are owed on, like accounts payable. New
-- organisations get it with the starting chart (2010); existing ones get it
-- here, at 2010 or the next free code after it.
insert into accounts (code, name, account_class, account_type, system_key)
select (select min(c)::text from generate_series(2010, 2099) c where not exists (select 1 from accounts where lower(code) = c::text)),
       'Expense claims payable', 'liability', 'current_liability', 'expense_claims_payable'
 where exists (select 1 from accounts)
   and not exists (select 1 from accounts where system_key = 'expense_claims_payable');

alter table ledger_journals drop constraint ledger_journals_origin_check;
alter table ledger_journals add constraint ledger_journals_origin_check
  check (origin in ('manual', 'correction', 'inventory', 'fx_revaluation', 'invoice', 'customer_payment', 'bill',
                    'supplier_payment', 'sales_credit_note', 'sales_credit_note_refund',
                    'supplier_credit_note', 'supplier_credit_note_refund', 'customer_overpayment_refund',
                    'bank_transaction', 'bank_transfer', 'customer_payment_batch', 'supplier_payment_batch',
                    'expense_claim', 'expense_claim_payment'));

alter table record_notes drop constraint record_notes_record_type_check;
alter table record_notes add constraint record_notes_record_type_check
  check (record_type in ('ledger_journal', 'sales_invoice', 'bill', 'sales_credit_note', 'supplier_credit_note', 'contact',
                         'expense_claim'));
alter table record_attachments drop constraint record_attachments_record_type_check;
alter table record_attachments add constraint record_attachments_record_type_check
  check (record_type in ('ledger_journal', 'sales_invoice', 'bill', 'sales_credit_note', 'supplier_credit_note', 'contact',
                         'expense_claim'));

create table expense_claims (
  id bigserial primary key,
  command_source text not null,
  idempotency_key text not null,
  request_hash text not null,
  status text not null default 'draft' check (status in ('draft', 'submitted', 'approved', 'voided')),
  claimant_user_id uuid,
  claimant_email text not null check (length(claimant_email) between 1 and 320),
  description text check (description is null or length(description) between 1 and 500),
  currency_code text not null check (currency_code ~ '^[A-Z]{3}$'),
  total numeric not null default 0 check (total >= 0),
  tax_total numeric not null default 0 check (tax_total >= 0),
  submitted_at timestamptz,
  declined_at timestamptz,
  declined_by_email text,
  decline_reason text check (decline_reason is null or length(decline_reason) between 1 and 500),
  claim_date date,
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
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (command_source, idempotency_key),
  unique (approve_command_source, approve_idempotency_key),
  unique (void_command_source, void_idempotency_key),
  check ((status in ('approved', 'voided')) = (approval_journal_id is not null and claim_date is not null and approved_at is not null)),
  check ((status = 'voided') = (void_journal_id is not null and void_date is not null and voided_at is not null)),
  check ((status = 'submitted') = (submitted_at is not null) or status in ('approved', 'voided')),
  check (void_date is null or void_date >= claim_date)
);
create index expense_claims_status_idx on expense_claims (status, id);
create index expense_claims_claimant_idx on expense_claims (claimant_user_id, id);

-- Receipts, tax inclusive: amount = net + GST.
create table expense_claim_receipts (
  id bigserial primary key,
  claim_id bigint not null references expense_claims(id),
  line_order integer not null check (line_order > 0),
  receipt_date date not null,
  supplier_name text not null check (length(supplier_name) between 1 and 200),
  description text not null check (length(description) between 1 and 500),
  account_id bigint not null references accounts(id),
  tax_code_id bigint references tax_codes(id),
  tax_rate numeric not null default 0 check (tax_rate >= 0),
  amount numeric not null check (amount > 0),
  net_amount numeric not null,
  tax_amount numeric not null check (tax_amount >= 0),
  tracking jsonb not null default '{}'::jsonb,
  unique (claim_id, line_order),
  check (net_amount + tax_amount = amount)
);
create trigger expense_claim_receipts_tracking before insert or update on expense_claim_receipts
  for each row when (new.tracking <> '{}'::jsonb) execute function tohyee_check_line_tracking();

-- Only drafts change or are deleted. A submitted claim goes back to draft
-- (declined) or on to approved; an approved one only to voided, once, and
-- then only its void details change; a voided one never changes.
create function tohyee_guard_expense_claim() returns trigger
language plpgsql as $$
begin
  if tg_op = 'TRUNCATE' then
    raise exception 'expense_claims can''t be truncated' using errcode = 'P0001';
  end if;
  if tg_op = 'DELETE' then
    if old.status <> 'draft' then
      raise exception 'Only draft expense claims can be deleted' using errcode = 'P0001';
    end if;
    return old;
  end if;
  if old.status = 'draft' and new.status in ('draft', 'submitted') then
    return new;
  end if;
  if old.status = 'submitted' and new.status in ('draft', 'approved') then
    return new;
  end if;
  if old.status = 'approved' and new.status = 'voided'
     and (to_jsonb(new) - array['status', 'void_date', 'void_journal_id', 'void_command_source', 'void_idempotency_key',
            'void_request_hash', 'voided_by_user_id', 'voided_by_email', 'voided_at', 'updated_at'])
       = (to_jsonb(old) - array['status', 'void_date', 'void_journal_id', 'void_command_source', 'void_idempotency_key',
            'void_request_hash', 'voided_by_user_id', 'voided_by_email', 'voided_at', 'updated_at']) then
    if exists (select 1 from expense_claim_payments where claim_id = new.id and status = 'active') then
      raise exception 'Expense claim #% has payments against it, so it can''t be voided. Void its payments first', old.id
        using errcode = 'P0001';
    end if;
    return new;
  end if;
  raise exception 'Expense claim #% is % and can''t change like that', old.id, old.status using errcode = 'P0001';
end;
$$;

-- Receipts only change while their claim is a draft.
create function tohyee_guard_expense_claim_receipt() returns trigger
language plpgsql as $$
declare
  claim_status text;
begin
  if tg_op = 'TRUNCATE' then
    raise exception 'expense_claim_receipts can''t be truncated' using errcode = 'P0001';
  end if;
  select status into claim_status from expense_claims
   where id = case when tg_op = 'DELETE' then old.claim_id else new.claim_id end;
  if claim_status is distinct from 'draft' then
    raise exception 'Receipts can only change while their expense claim is a draft' using errcode = 'P0001';
  end if;
  if tg_op = 'UPDATE' and new.claim_id <> old.claim_id then
    raise exception 'A receipt stays on its expense claim' using errcode = 'P0001';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

create table expense_claim_payments (
  id bigserial primary key,
  command_source text not null,
  idempotency_key text not null,
  request_hash text not null,
  status text not null default 'active' check (status in ('active', 'voided')),
  claim_id bigint not null references expense_claims(id),
  payment_date date not null,
  amount numeric not null check (amount > 0),
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
create index expense_claim_payments_claim_idx on expense_claim_payments (claim_id, id);

-- A payment is recorded as active against an approved claim, dated on or
-- after it, and a claim's active payments never add up to more than its
-- total. The claim stays locked until the transaction ends.
create function tohyee_check_expense_claim_payment() returns trigger
language plpgsql as $$
declare
  claim record;
  paid numeric;
begin
  if new.status <> 'active' then
    raise exception 'A payment is recorded as active and voided afterwards' using errcode = 'P0001';
  end if;
  select id, status, claim_date, total into claim from expense_claims where id = new.claim_id for update;
  if not found then
    return new;
  end if;
  if claim.status <> 'approved' then
    raise exception 'Payments can only be recorded against approved expense claims' using errcode = 'P0001';
  end if;
  if new.payment_date < claim.claim_date then
    raise exception 'A payment can''t be dated before its expense claim' using errcode = 'P0001';
  end if;
  select coalesce(sum(amount), 0) into paid from expense_claim_payments where claim_id = new.claim_id and status = 'active';
  if paid + new.amount > claim.total then
    raise exception 'Payments against expense claim #% can''t add up to more than its total', claim.id using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create function tohyee_guard_expense_claim_payment() returns trigger
language plpgsql as $$
begin
  if tg_op = 'TRUNCATE' then
    raise exception 'expense_claim_payments can''t be truncated' using errcode = 'P0001';
  end if;
  if tg_op = 'DELETE' then
    raise exception 'Expense claim payments can''t be deleted; void them instead' using errcode = 'P0001';
  end if;
  if old.status = 'active' and new.status = 'voided'
     and (to_jsonb(new) - array['status', 'void_date', 'void_journal_id', 'void_command_source',
            'void_idempotency_key', 'void_request_hash', 'voided_by_user_id', 'voided_by_email', 'voided_at'])
       = (to_jsonb(old) - array['status', 'void_date', 'void_journal_id', 'void_command_source',
            'void_idempotency_key', 'void_request_hash', 'voided_by_user_id', 'voided_by_email', 'voided_at']) then
    return new;
  end if;
  raise exception 'Expense claim payments can''t be changed, only voided once' using errcode = 'P0001';
end;
$$;

create trigger expense_claims_guard
  before update or delete on expense_claims
  for each row execute function tohyee_guard_expense_claim();
create trigger expense_claims_no_truncate
  before truncate on expense_claims
  for each statement execute function tohyee_guard_expense_claim();
create trigger expense_claim_receipts_guard
  before insert or update or delete on expense_claim_receipts
  for each row execute function tohyee_guard_expense_claim_receipt();
create trigger expense_claim_receipts_no_truncate
  before truncate on expense_claim_receipts
  for each statement execute function tohyee_guard_expense_claim_receipt();
create trigger expense_claim_payments_check
  before insert on expense_claim_payments
  for each row execute function tohyee_check_expense_claim_payment();
create trigger expense_claim_payments_guard
  before update or delete on expense_claim_payments
  for each row execute function tohyee_guard_expense_claim_payment();
create trigger expense_claim_payments_no_truncate
  before truncate on expense_claim_payments
  for each statement execute function tohyee_guard_expense_claim_payment();

-- The GST return counts approved claims like bills (on the claim date on
-- the invoice basis, when paid on the payments and hybrid bases). Receipts
-- have a supplier's name rather than a contact, so filed lines from claims
-- have no contact.
alter table gst_return_lines alter column contact_id drop not null;
alter table gst_return_lines drop constraint gst_return_lines_event_type_check;
alter table gst_return_lines add constraint gst_return_lines_event_type_check
  check (event_type in ('invoice_approved', 'invoice_voided', 'credit_note_approved', 'credit_note_voided',
                        'bill_approved', 'bill_voided', 'supplier_credit_note_approved', 'supplier_credit_note_voided',
                        'bank_transaction_posted', 'bank_transaction_voided',
                        'customer_payment', 'customer_payment_voided',
                        'credit_note_applied', 'credit_note_application_removed',
                        'credit_note_refunded', 'credit_note_refund_voided',
                        'overpayment_applied', 'overpayment_application_removed',
                        'supplier_payment', 'supplier_payment_voided',
                        'supplier_credit_note_applied', 'supplier_credit_note_application_removed',
                        'supplier_credit_note_refunded', 'supplier_credit_note_refund_voided',
                        'expense_claim_approved', 'expense_claim_voided',
                        'expense_claim_payment', 'expense_claim_payment_voided'));
alter table gst_return_lines drop constraint gst_return_lines_document_type_check;
alter table gst_return_lines add constraint gst_return_lines_document_type_check
  check (document_type in ('sales_invoice', 'sales_credit_note', 'bill', 'supplier_credit_note', 'bank_transaction',
                           'expense_claim'));
`,
  },
  {
    version: "0029",
    name: "fixed_assets",
    sql: `
-- Fixed assets (examples FA1-FA14), like Xero's fixed asset register. Asset
-- types say which accounts an asset's cost, accumulated depreciation and
-- depreciation expense are on, with a default method and rate the
-- organisation types in (Tohyee has no built-in IRD rates). Registering an
-- asset posts nothing: its cost is already in the ledger (from a bill, a
-- bank transaction or an opening journal). A depreciation run posts one
-- journal (Dr depreciation / Cr accumulated depreciation); the latest run can
-- be rolled back with the exact reversal. A disposal posts depreciation up to
-- the disposal, takes the cost and accumulated depreciation off, clears the
-- proceeds and posts the gain or loss; it can be undone with the exact
-- reversal. Nothing here is ever deleted.

-- Where gains and losses on disposals go by default. New organisations get
-- them with the starting chart (7030, 7040); existing ones get them here, at
-- that code or the next free one after it.
insert into accounts (code, name, account_class, account_type, system_key)
select (select min(c)::text from generate_series(7030, 7999) c where not exists (select 1 from accounts where lower(code) = c::text)),
       'Gain or loss on disposal of fixed assets', 'revenue', 'other_income', 'fixed_asset_disposal'
 where exists (select 1 from accounts)
   and not exists (select 1 from accounts where system_key = 'fixed_asset_disposal');
insert into accounts (code, name, account_class, account_type, system_key)
select (select min(c)::text from generate_series(7040, 7999) c where not exists (select 1 from accounts where lower(code) = c::text)),
       'Capital gains on disposal of fixed assets', 'revenue', 'other_income', 'fixed_asset_capital_gain'
 where exists (select 1 from accounts)
   and not exists (select 1 from accounts where system_key = 'fixed_asset_capital_gain');

alter table ledger_journals drop constraint ledger_journals_origin_check;
alter table ledger_journals add constraint ledger_journals_origin_check
  check (origin in ('manual', 'correction', 'inventory', 'fx_revaluation', 'invoice', 'customer_payment', 'bill',
                    'supplier_payment', 'sales_credit_note', 'sales_credit_note_refund',
                    'supplier_credit_note', 'supplier_credit_note_refund', 'customer_overpayment_refund',
                    'bank_transaction', 'bank_transfer', 'customer_payment_batch', 'supplier_payment_batch',
                    'expense_claim', 'expense_claim_payment', 'fixed_asset_depreciation', 'fixed_asset_disposal'));

alter table record_notes drop constraint record_notes_record_type_check;
alter table record_notes add constraint record_notes_record_type_check
  check (record_type in ('ledger_journal', 'sales_invoice', 'bill', 'sales_credit_note', 'supplier_credit_note', 'contact',
                         'expense_claim', 'fixed_asset'));
alter table record_attachments drop constraint record_attachments_record_type_check;
alter table record_attachments add constraint record_attachments_record_type_check
  check (record_type in ('ledger_journal', 'sales_invoice', 'bill', 'sales_credit_note', 'supplier_credit_note', 'contact',
                         'expense_claim', 'fixed_asset'));

-- How part months are counted (FA7, FA8): the month an asset is bought
-- counts in full, or depreciation starts the month after; the month it's
-- disposed of counts in full, or isn't depreciated.
alter table organisation_settings
  add column fixed_asset_first_month text not null default 'full_month'
    check (fixed_asset_first_month in ('full_month', 'next_month')),
  add column fixed_asset_disposal_month text not null default 'exclude'
    check (fixed_asset_disposal_month in ('include', 'exclude'));

create table fixed_asset_types (
  id bigserial primary key,
  command_source text not null,
  idempotency_key text not null,
  request_hash text not null,
  name text not null check (length(name) between 1 and 100 and name = btrim(name)),
  asset_account_id bigint not null references accounts(id),
  accumulated_depreciation_account_id bigint not null references accounts(id),
  depreciation_expense_account_id bigint not null references accounts(id),
  method text not null check (method in ('dv', 'sl', 'none')),
  rate numeric check (rate is null or (rate > 0 and rate <= 100 and scale(rate) <= 4)),
  archived_at timestamptz,
  archived_by_email text,
  created_by_user_id uuid,
  created_by_email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (command_source, idempotency_key),
  check ((method = 'none') = (rate is null)),
  check (asset_account_id <> accumulated_depreciation_account_id)
);
create unique index fixed_asset_types_name_key on fixed_asset_types (lower(name)) where archived_at is null;

create table fixed_asset_numbering (
  id boolean primary key default true check (id),
  last_number integer not null default 0 check (last_number >= 0)
);
insert into fixed_asset_numbering (id) values (true);
create trigger fixed_asset_numbering_guard
  before update or delete on fixed_asset_numbering
  for each row execute function toeyee_guard_invoice_numbering();
create trigger fixed_asset_numbering_no_truncate
  before truncate on fixed_asset_numbering
  for each statement execute function toeyee_guard_invoice_numbering();

create table fixed_assets (
  id bigserial primary key,
  command_source text not null,
  idempotency_key text not null,
  request_hash text not null,
  asset_number text not null unique check (asset_number ~ '^FA-[0-9]{4,}$'),
  name text not null check (length(name) between 1 and 200 and name = btrim(name)),
  description text check (description is null or length(description) between 1 and 1000),
  type_id bigint not null references fixed_asset_types(id),
  status text not null default 'registered' check (status in ('registered', 'disposed', 'archived')),
  purchase_date date not null,
  cost numeric not null check (cost > 0),
  -- Checked by tohyee_check_fixed_asset_bill_line (an approved bill's line,
  -- which can never be deleted) rather than a foreign key, so bill_lines keeps
  -- refusing TRUNCATE with its own message.
  bill_line_id bigint,
  method text not null check (method in ('dv', 'sl', 'none')),
  rate numeric check (rate is null or (rate > 0 and rate <= 100 and scale(rate) <= 4)),
  residual_value numeric not null default 0 check (residual_value >= 0),
  opening_date date,
  opening_accumulated_depreciation numeric not null default 0 check (opening_accumulated_depreciation >= 0),
  tracking jsonb not null default '{}'::jsonb,
  archived_at timestamptz,
  archived_by_email text,
  created_by_user_id uuid,
  created_by_email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (command_source, idempotency_key),
  check ((method = 'none') = (rate is null)),
  check (residual_value <= cost),
  check (opening_accumulated_depreciation <= cost - residual_value),
  check (opening_date is not null or opening_accumulated_depreciation = 0),
  check (opening_date is null or (opening_date >= purchase_date
         and opening_date = (date_trunc('month', opening_date) + interval '1 month - 1 day')::date)),
  check ((status = 'archived') = (archived_at is not null))
);
create index fixed_assets_type_idx on fixed_assets (type_id);
create index fixed_assets_bill_line_idx on fixed_assets (bill_line_id) where bill_line_id is not null;
create trigger fixed_assets_tracking before insert or update on fixed_assets
  for each row when (new.tracking <> '{}'::jsonb) execute function tohyee_check_line_tracking();

create table fixed_asset_depreciation_runs (
  id bigserial primary key,
  command_source text not null,
  idempotency_key text not null,
  request_hash text not null,
  period_end date not null check (period_end = (date_trunc('month', period_end) + interval '1 month - 1 day')::date),
  status text not null default 'active' check (status in ('active', 'rolled_back')),
  total numeric not null check (total >= 0),
  journal_id bigint unique references ledger_journals(id),
  created_by_user_id uuid,
  created_by_email text,
  created_at timestamptz not null default now(),
  rollback_journal_id bigint unique references ledger_journals(id),
  rollback_command_source text,
  rollback_idempotency_key text,
  rollback_request_hash text,
  rolled_back_by_user_id uuid,
  rolled_back_by_email text,
  rolled_back_at timestamptz,
  unique (command_source, idempotency_key),
  unique (rollback_command_source, rollback_idempotency_key),
  check ((total > 0) = (journal_id is not null)),
  check ((status = 'rolled_back') = (rolled_back_at is not null and rollback_idempotency_key is not null)),
  check (rollback_journal_id is null or journal_id is not null),
  check (status = 'active' or (journal_id is null) = (rollback_journal_id is null))
);
create unique index fixed_asset_depreciation_runs_active_period on fixed_asset_depreciation_runs (period_end) where status = 'active';

create table fixed_asset_disposals (
  id bigserial primary key,
  command_source text not null,
  idempotency_key text not null,
  request_hash text not null,
  asset_id bigint not null references fixed_assets(id),
  status text not null default 'active' check (status in ('active', 'undone')),
  disposal_date date not null,
  proceeds numeric not null default 0 check (proceeds >= 0),
  proceeds_account_id bigint references accounts(id),
  gain_loss_account_id bigint not null references accounts(id),
  capital_gain_account_id bigint not null references accounts(id),
  cost numeric not null check (cost > 0),
  depreciation numeric not null check (depreciation >= 0),
  accumulated_depreciation numeric not null check (accumulated_depreciation >= 0 and accumulated_depreciation <= cost),
  depreciation_recovered numeric not null check (depreciation_recovered >= 0),
  capital_gain numeric not null check (capital_gain >= 0),
  loss numeric not null check (loss >= 0),
  journal_id bigint not null unique references ledger_journals(id),
  created_by_user_id uuid,
  created_by_email text,
  created_at timestamptz not null default now(),
  undo_journal_id bigint unique references ledger_journals(id),
  undo_command_source text,
  undo_idempotency_key text,
  undo_request_hash text,
  undone_by_user_id uuid,
  undone_by_email text,
  undone_at timestamptz,
  unique (command_source, idempotency_key),
  unique (undo_command_source, undo_idempotency_key),
  check ((proceeds = 0) = (proceeds_account_id is null)),
  -- Book value plus the gain, less the loss, is what it sold for.
  check (cost - accumulated_depreciation + depreciation_recovered + capital_gain - loss = proceeds),
  check (loss = 0 or (depreciation_recovered = 0 and capital_gain = 0)),
  check (depreciation_recovered <= accumulated_depreciation),
  check ((status = 'undone') = (undo_journal_id is not null and undone_at is not null))
);
create unique index fixed_asset_disposals_active_asset on fixed_asset_disposals (asset_id) where status = 'active';

-- Depreciation charged to an asset, one row per asset per financial year a
-- run (or a disposal) covers. Rows never change: a rolled back run or an
-- undone disposal takes its rows out of the count.
create table fixed_asset_depreciation_lines (
  id bigserial primary key,
  run_id bigint references fixed_asset_depreciation_runs(id),
  disposal_id bigint references fixed_asset_disposals(id),
  asset_id bigint not null references fixed_assets(id),
  financial_year_start date not null,
  from_month date not null check (extract(day from from_month) = 1),
  to_month date not null check (extract(day from to_month) = 1),
  months integer not null check (months > 0),
  amount numeric not null check (amount >= 0),
  check (num_nonnulls(run_id, disposal_id) = 1),
  check (to_month >= from_month and from_month >= financial_year_start)
);
create unique index fixed_asset_depreciation_lines_run on fixed_asset_depreciation_lines (run_id, asset_id, financial_year_start) where run_id is not null;
create unique index fixed_asset_depreciation_lines_disposal on fixed_asset_depreciation_lines (disposal_id, financial_year_start) where disposal_id is not null;
create index fixed_asset_depreciation_lines_asset on fixed_asset_depreciation_lines (asset_id);

-- Whether an asset has depreciation or a disposal that counts.
create function tohyee_fixed_asset_has_history(asset bigint) returns boolean
language sql stable as $$
  select exists (select 1 from fixed_asset_depreciation_lines l
                   left join fixed_asset_depreciation_runs r on r.id = l.run_id
                   left join fixed_asset_disposals d on d.id = l.disposal_id
                  where l.asset_id = asset and (r.status = 'active' or d.status = 'active'))
      or exists (select 1 from fixed_asset_disposals d where d.asset_id = asset and d.status = 'active');
$$;

-- Types are archived, never deleted; their accounts can't change once an
-- asset uses the type (its cost and depreciation are already on them).
create function tohyee_guard_fixed_asset_type() returns trigger
language plpgsql as $$
begin
  if tg_op = 'TRUNCATE' then
    raise exception 'fixed_asset_types can''t be truncated' using errcode = 'P0001';
  end if;
  if tg_op = 'DELETE' then
    raise exception 'Asset types can''t be deleted; archive them instead' using errcode = 'P0001';
  end if;
  if (new.asset_account_id, new.accumulated_depreciation_account_id, new.depreciation_expense_account_id)
       is distinct from (old.asset_account_id, old.accumulated_depreciation_account_id, old.depreciation_expense_account_id)
     and exists (select 1 from fixed_assets where type_id = old.id and status <> 'archived') then
    raise exception 'Asset type % has assets, so its accounts can''t change', old.name using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger fixed_asset_types_guard before update or delete on fixed_asset_types
  for each row execute function tohyee_guard_fixed_asset_type();
create trigger fixed_asset_types_no_truncate before truncate on fixed_asset_types
  for each statement execute function tohyee_guard_fixed_asset_type();

-- An asset from a bill line: an approved bill's line on the type's asset
-- account, and the assets from one line never cost more than the line's
-- amount excluding GST (FA2).
create function tohyee_check_fixed_asset_bill_line() returns trigger
language plpgsql as $$
declare
  line record;
  registered numeric;
  asset_account bigint;
begin
  if new.bill_line_id is null or new.status = 'archived' then
    return new;
  end if;
  select l.net_amount, l.account_id, b.status into line from bill_lines l join bills b on b.id = l.bill_id where l.id = new.bill_line_id;
  if line.status is distinct from 'approved' then
    raise exception 'An asset can only come from an approved bill''s line' using errcode = 'P0001';
  end if;
  select asset_account_id into asset_account from fixed_asset_types where id = new.type_id;
  if line.account_id <> asset_account then
    raise exception 'An asset from a bill line must be on its asset type''s asset account' using errcode = 'P0001';
  end if;
  select coalesce(sum(cost), 0) into registered from fixed_assets
   where bill_line_id = new.bill_line_id and status <> 'archived';
  if registered > line.net_amount then
    raise exception 'Assets from one bill line can''t cost more than the line (%)', line.net_amount using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger fixed_assets_bill_line after insert or update on fixed_assets
  for each row execute function tohyee_check_fixed_asset_bill_line();

-- Assets are never deleted. Once depreciated or disposed of, only the name,
-- description and tracking change; archiving is only for assets with no
-- depreciation or disposal; an archived asset never changes; the status
-- follows its disposal (FA2, FA14).
create function tohyee_guard_fixed_asset() returns trigger
language plpgsql as $$
begin
  if tg_op = 'TRUNCATE' then
    raise exception 'fixed_assets can''t be truncated' using errcode = 'P0001';
  end if;
  if tg_op = 'DELETE' then
    raise exception 'Fixed assets can''t be deleted; archive them instead' using errcode = 'P0001';
  end if;
  if old.status = 'archived' then
    raise exception 'Fixed asset % is archived and can''t change', old.asset_number using errcode = 'P0001';
  end if;
  if new.asset_number <> old.asset_number then
    raise exception 'A fixed asset''s number never changes' using errcode = 'P0001';
  end if;
  if new.status = 'archived' and tohyee_fixed_asset_has_history(old.id) then
    raise exception 'Fixed asset % has depreciation or a disposal, so it can''t be archived', old.asset_number using errcode = 'P0001';
  end if;
  if new.status = 'disposed' and old.status <> 'disposed'
     and not exists (select 1 from fixed_asset_disposals where asset_id = old.id and status = 'active') then
    raise exception 'Fixed asset % is only disposed of by recording its disposal', old.asset_number using errcode = 'P0001';
  end if;
  if new.status <> 'disposed' and exists (select 1 from fixed_asset_disposals where asset_id = old.id and status = 'active') then
    raise exception 'Fixed asset % has been disposed of; undo the disposal first', old.asset_number using errcode = 'P0001';
  end if;
  if (to_jsonb(new) - array['name', 'description', 'tracking', 'status', 'archived_at', 'archived_by_email', 'updated_at'])
       <> (to_jsonb(old) - array['name', 'description', 'tracking', 'status', 'archived_at', 'archived_by_email', 'updated_at'])
     and tohyee_fixed_asset_has_history(old.id) then
    raise exception 'Fixed asset % has depreciation or a disposal, so only its name, description and tracking can change', old.asset_number
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger fixed_assets_guard before update or delete on fixed_assets
  for each row execute function tohyee_guard_fixed_asset();
create trigger fixed_assets_no_truncate before truncate on fixed_assets
  for each statement execute function tohyee_guard_fixed_asset();

-- Runs go forward: each is after the latest active run (FA4). Only the
-- latest active run can be rolled back, once, and not while an asset it
-- depreciated has an active disposal (FA5, FA11).
create function tohyee_check_depreciation_run() returns trigger
language plpgsql as $$
declare
  latest date;
begin
  if new.status <> 'active' then
    raise exception 'A depreciation run is recorded as active' using errcode = 'P0001';
  end if;
  select max(period_end) into latest from fixed_asset_depreciation_runs where status = 'active';
  if latest is not null and new.period_end <= latest then
    raise exception 'Depreciation has already been run to %; a new run must be to a later month end', latest using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger fixed_asset_depreciation_runs_check before insert on fixed_asset_depreciation_runs
  for each row execute function tohyee_check_depreciation_run();

create function tohyee_guard_depreciation_run() returns trigger
language plpgsql as $$
declare
  blocking text;
begin
  if tg_op = 'TRUNCATE' then
    raise exception 'fixed_asset_depreciation_runs can''t be truncated' using errcode = 'P0001';
  end if;
  if tg_op = 'DELETE' then
    raise exception 'Depreciation runs can''t be deleted; roll them back instead' using errcode = 'P0001';
  end if;
  if old.status = 'active' and new.status = 'rolled_back'
     and (to_jsonb(new) - array['status', 'rollback_journal_id', 'rollback_command_source', 'rollback_idempotency_key',
            'rollback_request_hash', 'rolled_back_by_user_id', 'rolled_back_by_email', 'rolled_back_at'])
       = (to_jsonb(old) - array['status', 'rollback_journal_id', 'rollback_command_source', 'rollback_idempotency_key',
            'rollback_request_hash', 'rolled_back_by_user_id', 'rolled_back_by_email', 'rolled_back_at']) then
    if exists (select 1 from fixed_asset_depreciation_runs where status = 'active' and period_end > old.period_end) then
      raise exception 'Only the latest depreciation run can be rolled back' using errcode = 'P0001';
    end if;
    select a.asset_number into blocking
      from fixed_asset_depreciation_lines l
      join fixed_asset_disposals d on d.asset_id = l.asset_id and d.status = 'active'
      join fixed_assets a on a.id = l.asset_id
     where l.run_id = old.id
     order by a.asset_number limit 1;
    if blocking is not null then
      raise exception 'Undo the disposal of % first: it was worked out from this run', blocking using errcode = 'P0001';
    end if;
    return new;
  end if;
  raise exception 'Depreciation runs can''t be changed, only rolled back once' using errcode = 'P0001';
end;
$$;
create trigger fixed_asset_depreciation_runs_guard before update or delete on fixed_asset_depreciation_runs
  for each row execute function tohyee_guard_depreciation_run();
create trigger fixed_asset_depreciation_runs_no_truncate before truncate on fixed_asset_depreciation_runs
  for each statement execute function tohyee_guard_depreciation_run();

create function tohyee_guard_depreciation_line() returns trigger
language plpgsql as $$
begin
  raise exception 'Depreciation lines can''t be changed or deleted' using errcode = 'P0001';
end;
$$;
create trigger fixed_asset_depreciation_lines_guard before update or delete on fixed_asset_depreciation_lines
  for each row execute function tohyee_guard_depreciation_line();
create trigger fixed_asset_depreciation_lines_no_truncate before truncate on fixed_asset_depreciation_lines
  for each statement execute function tohyee_guard_depreciation_line();

-- A disposal is of a registered asset, after the latest depreciation run
-- (the run would otherwise have depreciated months after it), on or after
-- the purchase date and after any opening balance date (FA8).
create function tohyee_check_fixed_asset_disposal() returns trigger
language plpgsql as $$
declare
  asset record;
  latest date;
begin
  if new.status <> 'active' then
    raise exception 'A disposal is recorded as active' using errcode = 'P0001';
  end if;
  select id, asset_number, status, purchase_date, opening_date, cost into asset from fixed_assets where id = new.asset_id for update;
  if asset.status <> 'registered' then
    raise exception 'Fixed asset % is %, so it can''t be disposed of', asset.asset_number, asset.status using errcode = 'P0001';
  end if;
  if new.disposal_date < asset.purchase_date or (asset.opening_date is not null and new.disposal_date <= asset.opening_date) then
    raise exception 'Fixed asset % can''t be disposed of before it was bought or its opening balance date', asset.asset_number
      using errcode = 'P0001';
  end if;
  select max(period_end) into latest from fixed_asset_depreciation_runs where status = 'active';
  if latest is not null and new.disposal_date <= latest then
    raise exception 'Depreciation has been run to %, so a disposal must be after it. Roll the run back first', latest using errcode = 'P0001';
  end if;
  if new.cost <> asset.cost then
    raise exception 'A disposal takes off the asset''s whole cost' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger fixed_asset_disposals_check before insert on fixed_asset_disposals
  for each row execute function tohyee_check_fixed_asset_disposal();

create function tohyee_guard_fixed_asset_disposal() returns trigger
language plpgsql as $$
begin
  if tg_op = 'TRUNCATE' then
    raise exception 'fixed_asset_disposals can''t be truncated' using errcode = 'P0001';
  end if;
  if tg_op = 'DELETE' then
    raise exception 'Disposals can''t be deleted; undo them instead' using errcode = 'P0001';
  end if;
  if old.status = 'active' and new.status = 'undone'
     and (to_jsonb(new) - array['status', 'undo_journal_id', 'undo_command_source', 'undo_idempotency_key', 'undo_request_hash',
            'undone_by_user_id', 'undone_by_email', 'undone_at'])
       = (to_jsonb(old) - array['status', 'undo_journal_id', 'undo_command_source', 'undo_idempotency_key', 'undo_request_hash',
            'undone_by_user_id', 'undone_by_email', 'undone_at']) then
    return new;
  end if;
  raise exception 'Disposals can''t be changed, only undone once' using errcode = 'P0001';
end;
$$;
create trigger fixed_asset_disposals_guard before update or delete on fixed_asset_disposals
  for each row execute function tohyee_guard_fixed_asset_disposal();
create trigger fixed_asset_disposals_no_truncate before truncate on fixed_asset_disposals
  for each statement execute function tohyee_guard_fixed_asset_disposal();

-- A bill can't be voided while an asset is registered from one of its lines
-- (FA2): the register would keep a cost the ledger no longer has.
create function tohyee_check_bill_fixed_assets() returns trigger
language plpgsql as $$
declare
  asset text;
begin
  if new.status = 'voided' and old.status <> 'voided' then
    select a.asset_number into asset from fixed_assets a join bill_lines l on l.id = a.bill_line_id
     where l.bill_id = new.id and a.status <> 'archived' order by a.asset_number limit 1;
    if asset is not null then
      raise exception 'Bill #% is registered as fixed asset %, so it can''t be voided. Archive the asset first', new.id, asset
        using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$;
create trigger bills_fixed_assets before update on bills
  for each row execute function tohyee_check_bill_fixed_assets();
`,
  },

  {
    version: "0030",
    name: "projects",
    sql: `
-- Projects and time tracking (examples PJ1-PJ12), like Xero Projects. A
-- project is work for one customer with tasks (hourly, fixed price or
-- non-chargeable), time entries in whole minutes, and expenses linked from
-- approved bill lines, expense claim receipts and spend money lines (linked,
-- never re-posted). Invoicing makes an ordinary draft sales invoice and links
-- each billed item to it, so nothing is billed twice; voiding the invoice or
-- deleting the draft makes the items unbilled again. Nothing here posts to the
-- ledger: only the invoices do.

-- Staff cost rates (admins): an hourly cost per member, copied onto each time
-- entry when it's entered. Never deleted (set to 0 instead).
create table project_staff_rates (
  user_id uuid primary key,
  cost_rate numeric not null check (cost_rate >= 0 and scale(cost_rate) <= 4),
  updated_by_email text,
  updated_at timestamptz not null default now()
);

create table projects (
  id bigserial primary key,
  command_source text not null,
  idempotency_key text not null,
  request_hash text not null,
  contact_id bigint not null references contacts(id),
  name text not null check (length(name) between 1 and 200),
  estimate numeric check (estimate is null or (estimate >= 0 and scale(estimate) <= 2)),
  deadline date,
  status text not null default 'in_progress' check (status in ('in_progress', 'closed')),
  closed_at timestamptz,
  closed_by_email text,
  created_by_user_id uuid,
  created_by_email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (command_source, idempotency_key),
  check ((status = 'closed') = (closed_at is not null))
);
create index projects_contact_idx on projects (contact_id, id);

create table project_tasks (
  id bigserial primary key,
  command_source text not null,
  idempotency_key text not null,
  request_hash text not null,
  project_id bigint not null references projects(id),
  name text not null check (length(name) between 1 and 200),
  charge_type text not null check (charge_type in ('hourly', 'fixed', 'non_chargeable')),
  -- The hourly rate, or the fixed price; none for non-chargeable tasks.
  rate numeric check (rate is null or (rate > 0 and scale(rate) <= 4)),
  estimate_minutes integer check (estimate_minutes is null or estimate_minutes > 0),
  status text not null default 'active' check (status in ('active', 'archived')),
  written_off_at timestamptz,
  written_off_by_email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (command_source, idempotency_key),
  check ((charge_type = 'non_chargeable') = (rate is null)),
  check (charge_type <> 'fixed' or scale(rate) <= 2),
  check (written_off_at is null or charge_type = 'fixed')
);
create index project_tasks_project_idx on project_tasks (project_id, id);
create unique index project_tasks_name_idx on project_tasks (project_id, lower(name)) where status = 'active';

create table project_time_entries (
  id bigserial primary key,
  command_source text not null,
  idempotency_key text not null,
  request_hash text not null,
  project_id bigint not null references projects(id),
  task_id bigint not null references project_tasks(id),
  -- The member whose time it is (a user id in the core database).
  user_id uuid not null,
  user_email text not null check (length(user_email) between 1 and 320),
  entry_date date not null,
  minutes integer not null check (minutes between 1 and 1440),
  description text check (description is null or length(description) between 1 and 500),
  -- Their staff cost rate when the entry was made.
  cost_rate numeric not null default 0 check (cost_rate >= 0),
  status text not null default 'active' check (status in ('active', 'removed')),
  removed_at timestamptz,
  removed_by_email text,
  written_off_at timestamptz,
  written_off_by_email text,
  created_by_user_id uuid,
  created_by_email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (command_source, idempotency_key),
  check ((status = 'removed') = (removed_at is not null))
);
create index project_time_entries_project_idx on project_time_entries (project_id, entry_date);
create index project_time_entries_user_idx on project_time_entries (user_id, entry_date);

create table project_expenses (
  id bigserial primary key,
  command_source text not null,
  idempotency_key text not null,
  request_hash text not null,
  project_id bigint not null references projects(id),
  source_type text not null check (source_type in ('bill_line', 'expense_claim_receipt', 'bank_transaction_line')),
  -- The line (no foreign keys, like fixed_assets.bill_line_id, so those
  -- tables keep their own truncate guards; the trigger below checks it).
  bill_line_id bigint,
  expense_claim_receipt_id bigint,
  bank_transaction_line_id bigint,
  -- The line's amount excluding GST.
  cost numeric not null check (cost > 0),
  chargeable boolean not null,
  markup_percent numeric not null default 0 check (markup_percent >= 0 and markup_percent <= 1000 and scale(markup_percent) <= 2),
  status text not null default 'active' check (status in ('active', 'removed')),
  removed_at timestamptz,
  removed_by_email text,
  written_off_at timestamptz,
  written_off_by_email text,
  created_by_user_id uuid,
  created_by_email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (command_source, idempotency_key),
  check (num_nonnulls(bill_line_id, expense_claim_receipt_id, bank_transaction_line_id) = 1),
  check ((source_type = 'bill_line') = (bill_line_id is not null)),
  check ((source_type = 'expense_claim_receipt') = (expense_claim_receipt_id is not null)),
  check ((source_type = 'bank_transaction_line') = (bank_transaction_line_id is not null)),
  check ((status = 'removed') = (removed_at is not null)),
  check (written_off_at is null or chargeable)
);
create index project_expenses_project_idx on project_expenses (project_id, id);
-- A line is on one project at a time (PJ4).
create unique index project_expenses_bill_line_idx on project_expenses (bill_line_id) where status = 'active';
create unique index project_expenses_receipt_idx on project_expenses (expense_claim_receipt_id) where status = 'active';
create unique index project_expenses_bank_line_idx on project_expenses (bank_transaction_line_id) where status = 'active';

-- An invoice made from a project (PJ6), and what it billed. Deleting the
-- draft invoice deletes these rows with it, so its items are unbilled again.
create table project_invoices (
  id bigserial primary key,
  command_source text not null,
  idempotency_key text not null,
  request_hash text not null,
  project_id bigint not null references projects(id),
  invoice_id bigint not null unique references sales_invoices(id) on delete cascade,
  created_by_user_id uuid,
  created_by_email text,
  created_at timestamptz not null default now(),
  unique (command_source, idempotency_key)
);
create index project_invoices_project_idx on project_invoices (project_id, id);

create table project_invoice_items (
  id bigserial primary key,
  project_invoice_id bigint not null references project_invoices(id) on delete cascade,
  project_id bigint not null references projects(id),
  kind text not null check (kind in ('time', 'fixed_task', 'expense')),
  time_entry_id bigint references project_time_entries(id),
  task_id bigint references project_tasks(id),
  expense_id bigint references project_expenses(id),
  line_order integer not null check (line_order > 0),
  check (num_nonnulls(time_entry_id, task_id, expense_id) = 1),
  check ((kind = 'time') = (time_entry_id is not null)),
  check ((kind = 'fixed_task') = (task_id is not null)),
  check ((kind = 'expense') = (expense_id is not null))
);
create index project_invoice_items_invoice_idx on project_invoice_items (project_invoice_id);
create index project_invoice_items_time_idx on project_invoice_items (time_entry_id) where time_entry_id is not null;
create index project_invoice_items_task_idx on project_invoice_items (task_id) where task_id is not null;
create index project_invoice_items_expense_idx on project_invoice_items (expense_id) where expense_id is not null;

-- The invoice an item is billed on: one that isn't voided (drafts count).
create function tohyee_project_item_invoice(p_kind text, p_id bigint) returns bigint
language sql stable as $$
  select s.id
    from project_invoice_items i
    join project_invoices pi on pi.id = i.project_invoice_id
    join sales_invoices s on s.id = pi.invoice_id
   where s.status <> 'voided'
     and case p_kind when 'time' then i.time_entry_id = p_id
                     when 'fixed_task' then i.task_id = p_id
                     else i.expense_id = p_id end
   order by s.id
   limit 1
$$;

-- Whether anything of a task has been invoiced (its time, or itself).
create function tohyee_project_task_billed(p_task bigint) returns boolean
language sql stable as $$
  select tohyee_project_item_invoice('fixed_task', p_task) is not null
      or exists (select 1 from project_time_entries e
                  where e.task_id = p_task and tohyee_project_item_invoice('time', e.id) is not null)
$$;

-- What stops a project closing: a draft project invoice, or something
-- unbilled that hasn't been written off (PJ10). Null when nothing does.
create function tohyee_project_open_item(p_project bigint) returns text
language sql stable as $$
  select coalesce(
    (select 'a project invoice is still a draft (approve or delete it)'
       from project_invoices pi join sales_invoices s on s.id = pi.invoice_id
      where pi.project_id = p_project and s.status = 'draft' limit 1),
    (select 'time on ' || t.name || ' is unbilled'
       from project_time_entries e join project_tasks t on t.id = e.task_id
      where e.project_id = p_project and e.status = 'active' and e.written_off_at is null
        and t.charge_type = 'hourly' and tohyee_project_item_invoice('time', e.id) is null limit 1),
    (select 'the fixed price of ' || t.name || ' is unbilled'
       from project_tasks t
      where t.project_id = p_project and t.status = 'active' and t.charge_type = 'fixed'
        and t.written_off_at is null and tohyee_project_item_invoice('fixed_task', t.id) is null limit 1),
    (select 'a chargeable expense is unbilled'
       from project_expenses x
      where x.project_id = p_project and x.status = 'active' and x.chargeable and x.written_off_at is null
        and tohyee_project_item_invoice('expense', x.id) is null limit 1))
$$;

create function tohyee_require_open_project(p_project bigint) returns void
language plpgsql as $$
declare
  project record;
begin
  select name, status into project from projects where id = p_project;
  if project.status = 'closed' then
    raise exception 'Project % is closed. Reopen it first', project.name using errcode = 'P0001';
  end if;
end;
$$;

create function tohyee_guard_project_staff_rate() returns trigger
language plpgsql as $$
begin
  raise exception 'Staff cost rates can''t be deleted; set the rate to 0 instead' using errcode = 'P0001';
end;
$$;
create trigger project_staff_rates_guard before delete on project_staff_rates
  for each row execute function tohyee_guard_project_staff_rate();
create trigger project_staff_rates_no_truncate before truncate on project_staff_rates
  for each statement execute function tohyee_guard_project_staff_rate();

-- Projects are never deleted. Only Close and Reopen change the status;
-- closing needs nothing unbilled and no draft invoices; a closed project
-- doesn't change otherwise; the customer only changes before any invoice.
create function tohyee_guard_project() returns trigger
language plpgsql as $$
declare
  blocking text;
  fixed text[] := array['status', 'closed_at', 'closed_by_email', 'updated_at'];
begin
  if tg_op = 'TRUNCATE' then
    raise exception 'projects can''t be truncated' using errcode = 'P0001';
  end if;
  if tg_op = 'DELETE' then
    raise exception 'Projects can''t be deleted; close them instead' using errcode = 'P0001';
  end if;
  if new.status <> old.status and (to_jsonb(new) - fixed) <> (to_jsonb(old) - fixed) then
    raise exception 'Closing or reopening a project changes nothing else' using errcode = 'P0001';
  end if;
  if old.status = 'in_progress' and new.status = 'closed' then
    blocking := tohyee_project_open_item(old.id);
    if blocking is not null then
      raise exception 'Project % can''t be closed: %', old.name, blocking using errcode = 'P0001';
    end if;
    return new;
  end if;
  if old.status = 'closed' and new.status = 'closed' then
    raise exception 'Project % is closed. Reopen it first', old.name using errcode = 'P0001';
  end if;
  if new.contact_id <> old.contact_id and exists (select 1 from project_invoices where project_id = old.id) then
    raise exception 'Project % has invoices, so its customer can''t change', old.name using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger projects_guard before update or delete on projects
  for each row execute function tohyee_guard_project();
create trigger projects_no_truncate before truncate on projects
  for each statement execute function tohyee_guard_project();

-- Tasks are archived, never deleted. The charge type, and a fixed price,
-- don't change once something of the task is invoiced; a write-off is only
-- of an unbilled fixed price and is never undone.
create function tohyee_guard_project_task() returns trigger
language plpgsql as $$
begin
  if tg_op = 'TRUNCATE' then
    raise exception 'project_tasks can''t be truncated' using errcode = 'P0001';
  end if;
  if tg_op = 'DELETE' then
    raise exception 'Project tasks can''t be deleted; archive them instead' using errcode = 'P0001';
  end if;
  if tg_op = 'INSERT' then
    perform tohyee_require_open_project(new.project_id);
    if new.written_off_at is not null or new.status <> 'active' then
      raise exception 'A task starts active and not written off' using errcode = 'P0001';
    end if;
    return new;
  end if;
  perform tohyee_require_open_project(old.project_id);
  if new.project_id <> old.project_id then
    raise exception 'A task stays on its project' using errcode = 'P0001';
  end if;
  if old.written_off_at is not null and new.written_off_at is distinct from old.written_off_at then
    raise exception 'Task % has been written off, and that can''t be undone', old.name using errcode = 'P0001';
  end if;
  if (new.charge_type <> old.charge_type or (old.charge_type = 'fixed' and new.rate <> old.rate))
     and tohyee_project_task_billed(old.id) then
    raise exception 'Task % has been invoiced, so its charge type and fixed price can''t change', old.name using errcode = 'P0001';
  end if;
  if old.written_off_at is null and new.written_off_at is not null
     and tohyee_project_item_invoice('fixed_task', old.id) is not null then
    raise exception 'Task % has been invoiced, so it can''t be written off', old.name using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger project_tasks_guard before insert or update or delete on project_tasks
  for each row execute function tohyee_guard_project_task();
create trigger project_tasks_no_truncate before truncate on project_tasks
  for each statement execute function tohyee_guard_project_task();

-- Time entries are removed, never deleted. They change only while their
-- project is open and they aren't invoiced, removed or written off; a new
-- entry is on an active task of its project (PJ3, PJ8).
create function tohyee_guard_project_time_entry() returns trigger
language plpgsql as $$
declare
  task record;
begin
  if tg_op = 'TRUNCATE' then
    raise exception 'project_time_entries can''t be truncated' using errcode = 'P0001';
  end if;
  if tg_op = 'DELETE' then
    raise exception 'Time entries can''t be deleted; remove them instead' using errcode = 'P0001';
  end if;
  perform tohyee_require_open_project(new.project_id);
  if tg_op = 'UPDATE' then
    if new.project_id <> old.project_id then
      raise exception 'A time entry stays on its project' using errcode = 'P0001';
    end if;
    if old.status = 'removed' then
      raise exception 'This time entry has been removed' using errcode = 'P0001';
    end if;
    if old.written_off_at is not null then
      raise exception 'This time entry has been written off and can''t change' using errcode = 'P0001';
    end if;
    if tohyee_project_item_invoice('time', old.id) is not null then
      raise exception 'This time entry is on an invoice, so it can''t change. Void or delete the invoice first' using errcode = 'P0001';
    end if;
  elsif new.status <> 'active' or new.written_off_at is not null then
    raise exception 'A time entry starts active and not written off' using errcode = 'P0001';
  end if;
  if tg_op = 'INSERT' or new.task_id <> old.task_id then
    select project_id, status, name into task from project_tasks where id = new.task_id;
    if task.project_id <> new.project_id then
      raise exception 'The task isn''t on this project' using errcode = 'P0001';
    end if;
    if task.status <> 'active' then
      raise exception 'Task % is archived, so no more time can go on it', task.name using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$;
create trigger project_time_entries_guard before insert or update or delete on project_time_entries
  for each row execute function tohyee_guard_project_time_entry();
create trigger project_time_entries_no_truncate before truncate on project_time_entries
  for each statement execute function tohyee_guard_project_time_entry();

-- A linked expense is an approved bill's line, an approved expense claim's
-- receipt or a posted spend money line, at its amount excluding GST (PJ4).
-- Links are removed, never deleted, and change only while their project is
-- open and they aren't invoiced, removed or written off.
create function tohyee_guard_project_expense() returns trigger
language plpgsql as $$
declare
  source record;
begin
  if tg_op = 'TRUNCATE' then
    raise exception 'project_expenses can''t be truncated' using errcode = 'P0001';
  end if;
  if tg_op = 'DELETE' then
    raise exception 'Project expenses can''t be deleted; remove them from the project instead' using errcode = 'P0001';
  end if;
  perform tohyee_require_open_project(new.project_id);
  if tg_op = 'INSERT' then
    if new.status <> 'active' or new.written_off_at is not null then
      raise exception 'A project expense starts active and not written off' using errcode = 'P0001';
    end if;
    if new.bill_line_id is not null then
      select b.status = 'approved' as ok, l.net_amount into source
        from bill_lines l join bills b on b.id = l.bill_id where l.id = new.bill_line_id;
    elsif new.expense_claim_receipt_id is not null then
      select c.status = 'approved' as ok, r.net_amount into source
        from expense_claim_receipts r join expense_claims c on c.id = r.claim_id where r.id = new.expense_claim_receipt_id;
    else
      select t.status = 'posted' and t.kind = 'spend' as ok, l.net_amount into source
        from bank_transaction_lines l join bank_transactions t on t.id = l.bank_transaction_id where l.id = new.bank_transaction_line_id;
    end if;
    if source.ok is not true then
      raise exception 'Only lines of approved bills, approved expense claims and spend money can go on a project' using errcode = 'P0001';
    end if;
    if new.cost <> source.net_amount then
      raise exception 'A project expense costs its line''s amount excluding GST (%)', source.net_amount using errcode = 'P0001';
    end if;
    return new;
  end if;
  if (to_jsonb(new) - array['chargeable', 'markup_percent', 'status', 'removed_at', 'removed_by_email',
                            'written_off_at', 'written_off_by_email', 'updated_at'])
     <> (to_jsonb(old) - array['chargeable', 'markup_percent', 'status', 'removed_at', 'removed_by_email',
                               'written_off_at', 'written_off_by_email', 'updated_at']) then
    raise exception 'A project expense''s line, project and cost never change' using errcode = 'P0001';
  end if;
  if old.status = 'removed' then
    raise exception 'This expense has been removed from its project' using errcode = 'P0001';
  end if;
  if old.written_off_at is not null then
    raise exception 'This expense has been written off and can''t change' using errcode = 'P0001';
  end if;
  if tohyee_project_item_invoice('expense', old.id) is not null then
    raise exception 'This expense is on an invoice, so it can''t change. Void or delete the invoice first' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger project_expenses_guard before insert or update or delete on project_expenses
  for each row execute function tohyee_guard_project_expense();
create trigger project_expenses_no_truncate before truncate on project_expenses
  for each statement execute function tohyee_guard_project_expense();

-- Project invoices and their items are only ever added, and go only with
-- the draft invoice they belong to when it's deleted.
create function tohyee_guard_project_invoice() returns trigger
language plpgsql as $$
begin
  if tg_op = 'TRUNCATE' then
    raise exception '% can''t be truncated', tg_table_name using errcode = 'P0001';
  end if;
  if tg_op = 'UPDATE' then
    raise exception 'What a project invoice billed never changes; void or delete the invoice instead' using errcode = 'P0001';
  end if;
  if tg_table_name = 'project_invoices' then
    if exists (select 1 from sales_invoices where id = old.invoice_id) then
      raise exception 'A project invoice goes only when its draft invoice is deleted' using errcode = 'P0001';
    end if;
  elsif exists (select 1 from project_invoices where id = old.project_invoice_id) then
    raise exception 'A project invoice goes only when its draft invoice is deleted' using errcode = 'P0001';
  end if;
  return old;
end;
$$;
create trigger project_invoices_guard before update or delete on project_invoices
  for each row execute function tohyee_guard_project_invoice();
create trigger project_invoices_no_truncate before truncate on project_invoices
  for each statement execute function tohyee_guard_project_invoice();
create trigger project_invoice_items_guard before update or delete on project_invoice_items
  for each row execute function tohyee_guard_project_invoice();
create trigger project_invoice_items_no_truncate before truncate on project_invoice_items
  for each statement execute function tohyee_guard_project_invoice();

create function tohyee_check_project_invoice() returns trigger
language plpgsql as $$
begin
  perform tohyee_require_open_project(new.project_id);
  return new;
end;
$$;
create trigger project_invoices_check before insert on project_invoices
  for each row execute function tohyee_check_project_invoice();

-- An item billed is unbilled, chargeable, of the invoice's project, and on
-- no other invoice that isn't voided (PJ6). Checked after the insert, so
-- two rows of one statement for the same item are caught too.
create function tohyee_check_project_invoice_item() returns trigger
language plpgsql as $$
declare
  v_project bigint;
  item record;
  billed integer;
begin
  select pi.project_id into v_project from project_invoices pi where pi.id = new.project_invoice_id;
  if v_project <> new.project_id then
    raise exception 'A project invoice bills only its own project' using errcode = 'P0001';
  end if;
  perform tohyee_require_open_project(new.project_id);
  if new.kind = 'time' then
    select e.project_id, e.status = 'active' and e.written_off_at is null and t.charge_type = 'hourly' as ok into item
      from project_time_entries e join project_tasks t on t.id = e.task_id where e.id = new.time_entry_id;
  elsif new.kind = 'fixed_task' then
    select t.project_id, t.status = 'active' and t.written_off_at is null and t.charge_type = 'fixed' as ok into item
      from project_tasks t where t.id = new.task_id;
  else
    select x.project_id, x.status = 'active' and x.written_off_at is null and x.chargeable as ok into item
      from project_expenses x where x.id = new.expense_id;
  end if;
  if item.project_id is distinct from new.project_id then
    raise exception 'A project invoice bills only its own project' using errcode = 'P0001';
  end if;
  if item.ok is not true then
    raise exception 'Only unbilled time on hourly tasks, fixed prices and chargeable expenses can be invoiced' using errcode = 'P0001';
  end if;
  select count(*) into billed
    from project_invoice_items i
    join project_invoices pi on pi.id = i.project_invoice_id
    join sales_invoices s on s.id = pi.invoice_id
   where s.status <> 'voided'
     and i.kind = new.kind
     and coalesce(i.time_entry_id, i.task_id, i.expense_id) = coalesce(new.time_entry_id, new.task_id, new.expense_id);
  if billed > 1 then
    raise exception 'That is already on an invoice' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger project_invoice_items_check after insert on project_invoice_items
  for each row execute function tohyee_check_project_invoice_item();

-- A closed project has nothing unbilled, so its invoices can't be voided or
-- deleted until it's reopened (PJ10).
create function tohyee_check_project_invoice_change() returns trigger
language plpgsql as $$
declare
  project text;
begin
  if tg_op = 'DELETE' or (new.status = 'voided' and old.status <> 'voided') then
    select p.name into project from project_invoices pi join projects p on p.id = pi.project_id
     where pi.invoice_id = old.id and p.status = 'closed';
    if project is not null then
      raise exception 'This invoice is from project %, which is closed. Reopen the project first', project using errcode = 'P0001';
    end if;
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;
create trigger sales_invoices_projects before update or delete on sales_invoices
  for each row execute function tohyee_check_project_invoice_change();

-- A bill, expense claim or spend money can't be voided while one of its
-- lines is on a project (PJ4): the project would keep a cost the ledger no
-- longer has. Remove it from the project first.
create function tohyee_check_project_expense_source() returns trigger
language plpgsql as $$
declare
  project text;
begin
  if new.status = 'voided' and old.status <> 'voided' then
    if tg_table_name = 'bills' then
      select p.name into project from project_expenses x join bill_lines l on l.id = x.bill_line_id join projects p on p.id = x.project_id
       where l.bill_id = new.id and x.status = 'active' limit 1;
    elsif tg_table_name = 'expense_claims' then
      select p.name into project from project_expenses x join expense_claim_receipts r on r.id = x.expense_claim_receipt_id
        join projects p on p.id = x.project_id
       where r.claim_id = new.id and x.status = 'active' limit 1;
    else
      select p.name into project from project_expenses x join bank_transaction_lines l on l.id = x.bank_transaction_line_id
        join projects p on p.id = x.project_id
       where l.bank_transaction_id = new.id and x.status = 'active' limit 1;
    end if;
    if project is not null then
      raise exception 'A line of this is on project %, so it can''t be voided. Remove it from the project first', project
        using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$;
create trigger bills_projects before update on bills
  for each row execute function tohyee_check_project_expense_source();
create trigger expense_claims_projects before update on expense_claims
  for each row execute function tohyee_check_project_expense_source();
create trigger bank_transactions_projects before update on bank_transactions
  for each row execute function tohyee_check_project_expense_source();
`,
  },

  {
    version: "0031",
    name: "standard_tax_codes",
    sql: `
-- New organisations now start with the standard NZ GST codes (like Xero), so
-- invoices and bills can be raised straight away. Existing organisations get
-- the same four here, but only if they have no tax codes at all: one that
-- already has any is left alone, so nothing is duplicated or clashes with
-- codes people made themselves. They apply from 1 October 2010, when GST
-- became 15%. (A brand-new database has no organisation_settings row yet;
-- provisioning seeds its codes after the migrations.)
insert into tax_codes (command_source, idempotency_key, request_hash, code, label, category, rate, effective_from)
select 'system', c.idempotency_key, 'nz-default-tax-code', c.code, c.label, c.category, c.rate, date '2010-10-01'
  from (values ('nz-default-tax-code-gst', 'GST', 'GST (15%)', 'standard', 0.15::numeric, 1),
               ('nz-default-tax-code-zero', 'ZERO', 'Zero rated', 'zero_rated', 0::numeric, 2),
               ('nz-default-tax-code-exempt', 'EXEMPT', 'Exempt', 'exempt', 0::numeric, 3),
               ('nz-default-tax-code-none', 'NONE', 'No GST', 'out_of_scope', 0::numeric, 4))
       as c (idempotency_key, code, label, category, rate, position)
 where exists (select 1 from organisation_settings)
   and not exists (select 1 from tax_codes)
 order by c.position;
`,
  },

  {
    version: "0032",
    name: "bank_reconciliation_splits",
    sql: `
-- One posted journal line shown by the bank as several statement lines (a
-- payment the bank split in two, say): example BK26. A split ties the lines
-- together; each line still gets its own reconciliation (kind 'split') with
-- one item for its part of the journal line. The parts add up to the journal
-- line exactly, and the lines are reconciled and unreconciled together.
create table bank_reconciliation_splits (
  id bigserial primary key,
  command_source text not null,
  idempotency_key text not null,
  request_hash text not null,
  account_id bigint not null references accounts(id),
  journal_line_id bigint not null references ledger_journal_lines(id),
  created_by_user_id uuid,
  created_by_email text,
  created_at timestamptz not null default now(),
  unique (command_source, idempotency_key)
);

create function tohyee_guard_reconciliation_split() returns trigger
language plpgsql as $$
begin
  raise exception 'Split reconciliations can''t be changed or deleted; unreconcile instead' using errcode = 'P0001';
end;
$$;
create trigger bank_reconciliation_splits_guard
  before update or delete on bank_reconciliation_splits
  for each row execute function tohyee_guard_reconciliation_split();
create trigger bank_reconciliation_splits_no_truncate
  before truncate on bank_reconciliation_splits
  for each statement execute function tohyee_guard_reconciliation_split();

alter table bank_reconciliations add column split_id bigint references bank_reconciliation_splits(id);
alter table bank_reconciliations drop constraint bank_reconciliations_kind_check;
alter table bank_reconciliations add constraint bank_reconciliations_kind_check
  check (kind in ('match', 'payments', 'bank_transaction', 'transfer', 'split'));
alter table bank_reconciliations add constraint bank_reconciliations_split_check
  check ((kind = 'split') = (split_id is not null));
create index bank_reconciliations_split_idx on bank_reconciliations (split_id) where split_id is not null;

alter table bank_reconciliation_items add column split_id bigint references bank_reconciliation_splits(id);
-- A journal line is in at most one active reconciliation, unless it's split,
-- when all its active items belong to the one split (checked at commit).
drop index bank_reconciliation_items_active_journal_line_key;
create unique index bank_reconciliation_items_active_journal_line_key
  on bank_reconciliation_items (journal_line_id) where active and split_id is null;
create index bank_reconciliation_items_journal_line_idx on bank_reconciliation_items (journal_line_id) where active;

-- As before, plus: a split's reconciliations are all active or all removed,
-- there are at least two, each has one item for part of the split's journal
-- line (same sign, smaller), and the active parts add up to it exactly with
-- nothing else reconciled against it.
create or replace function tohyee_check_reconciliation(target bigint) returns void
language plpgsql as $$
declare
  rec record;
  line record;
  split record;
  total numeric;
  wrong integer;
begin
  select * into rec from bank_reconciliations where id = target;
  if not found then
    return;
  end if;
  select * into line from bank_statement_lines where id = rec.statement_line_id;
  if rec.status = 'active' then
    if line.status <> 'reconciled' then
      raise exception 'Statement line % has a reconciliation but isn''t marked reconciled', line.id using errcode = '23514';
    end if;
    select coalesce(sum(i.amount), 0),
           count(*) filter (
             where j.account_id <> line.account_id
                or i.split_id is distinct from rec.split_id
                or (i.split_id is null and i.amount <> j.debit_amount - j.credit_amount)
                or (i.split_id is null and exists (
                      select 1 from bank_reconciliation_items o
                       where o.active and o.journal_line_id = i.journal_line_id and o.id <> i.id))
                or (i.split_id is not null and (sign(i.amount) <> sign(j.debit_amount - j.credit_amount)
                      or abs(i.amount) >= abs(j.debit_amount - j.credit_amount))))
      into total, wrong
      from bank_reconciliation_items i join ledger_journal_lines j on j.id = i.journal_line_id
     where i.reconciliation_id = rec.id;
    if wrong > 0 then
      raise exception 'Statement line % is reconciled against journal lines on another account or with other amounts', line.id
        using errcode = '23514';
    end if;
    if total <> line.amount then
      raise exception 'Statement line % (%) is reconciled against journal lines adding up to %', line.id, line.amount, total
        using errcode = '23514';
    end if;
    if rec.split_id is not null then
      select s.id, s.account_id, s.journal_line_id, j.debit_amount - j.credit_amount as journal_amount into split
        from bank_reconciliation_splits s join ledger_journal_lines j on j.id = s.journal_line_id
       where s.id = rec.split_id;
      if split.account_id <> line.account_id
         or exists (select 1 from bank_reconciliation_items i
                     where i.reconciliation_id = rec.id and i.journal_line_id <> split.journal_line_id)
         or exists (select 1 from bank_reconciliations r where r.split_id = split.id and r.status <> 'active')
         or (select count(*) from bank_reconciliations r where r.split_id = split.id) < 2
         or exists (select 1 from bank_reconciliation_items i
                     where i.active and i.journal_line_id = split.journal_line_id and i.split_id is distinct from split.id)
         or (select coalesce(sum(i.amount), 0) from bank_reconciliation_items i
              where i.active and i.split_id = split.id) <> split.journal_amount then
        raise exception 'Split reconciliation % doesn''t add up to its journal line, or isn''t reconciled as a whole', split.id
          using errcode = '23514';
      end if;
    end if;
  else
    if line.status = 'reconciled'
       and not exists (select 1 from bank_reconciliations where statement_line_id = line.id and status = 'active') then
      raise exception 'Statement line % is marked reconciled without a reconciliation', line.id using errcode = '23514';
    end if;
    if rec.split_id is not null
       and exists (select 1 from bank_reconciliations r where r.split_id = rec.split_id and r.status = 'active') then
      raise exception 'Split reconciliation % is only partly unreconciled; unreconcile all its lines together', rec.split_id
        using errcode = '23514';
    end if;
  end if;
end;
$$;
`,
  },
  {
    version: "0033",
    name: "foreign_currency_bank_accounts",
    sql: `
-- Foreign-currency bank accounts (examples FXB1-FXB11). Following NetSuite,
-- journal lines on a foreign-currency account keep both amounts: the NZD
-- (base) debit or credit as before, plus the foreign amount on the same side
-- and the exchange rate (base currency per 1 unit, up to 8 decimal places).
-- fx_kind says how the base amount was worked out:
--   'rate'           base = foreign x rate, rounded once to the base currency's units
--   'implied'        base given (money moved in from a base account); rate = base / foreign, for information
--   'carrying_value' money leaving at the account's carrying value (a transfer out); rate for information
--   'revaluation'    an FX revaluation (or its reversal): foreign amount 0, rate the closing rate
-- Lines posted before this migration have none of these, even on
-- foreign-currency accounts; such an account needs an opening foreign balance
-- (below) before it takes anything new.
alter table ledger_journal_lines
  add column foreign_currency_code text check (foreign_currency_code ~ '^[A-Z]{3}$'),
  add column foreign_amount numeric check (foreign_amount >= 0 and scale(foreign_amount) <= 4),
  add column exchange_rate numeric check (exchange_rate > 0 and scale(exchange_rate) <= 8),
  add column fx_kind text check (fx_kind in ('rate', 'implied', 'carrying_value', 'revaluation'));
alter table ledger_journal_lines add constraint ledger_journal_lines_foreign_check check (
  (foreign_currency_code is null and foreign_amount is null and exchange_rate is null and fx_kind is null)
  or (foreign_currency_code is not null and foreign_amount is not null and exchange_rate is not null and fx_kind is not null
      and (fx_kind = 'revaluation') = (foreign_amount = 0))
);
-- The line's amount in its account's currency, signed like a statement line
-- (debits positive): what statement lines are reconciled against.
alter table ledger_journal_lines add column account_amount numeric generated always as (
  case when foreign_amount is null then debit_amount - credit_amount
       when debit_amount > 0 then foreign_amount
       else -foreign_amount end
) stored;
create index ledger_journal_lines_foreign_idx on ledger_journal_lines (account_id) where foreign_amount is not null;
create index ledger_journal_lines_base_only_idx on ledger_journal_lines (account_id) where foreign_amount is null;

-- Whether an account is in a currency other than the organisation's base.
create function tohyee_is_foreign_account(target bigint) returns boolean
language sql stable as $$
  select a.currency_code is not null
         and a.currency_code is distinct from (select base_currency from organisation_settings)
    from accounts a where a.id = target
$$;

-- The foreign balance of a foreign-currency account that already had
-- base-only postings, entered once as at a date (FXB1). It posts nothing: it
-- says what the account's base balance at that date is in the foreign
-- currency. Never changed or deleted.
create table ledger_foreign_opening_balances (
  id bigserial primary key,
  command_source text not null,
  idempotency_key text not null,
  request_hash text not null,
  account_id bigint not null unique references accounts(id),
  currency_code text not null check (currency_code ~ '^[A-Z]{3}$'),
  as_at_date date not null,
  foreign_balance numeric not null,
  base_balance numeric not null,
  created_by_user_id uuid,
  created_by_email text,
  created_at timestamptz not null default now(),
  unique (command_source, idempotency_key),
  check (sign(foreign_balance) = sign(base_balance))
);
create trigger ledger_foreign_opening_balances_append_only
  before update or delete on ledger_foreign_opening_balances
  for each row execute function toeyee_forbid_mutation();
create trigger ledger_foreign_opening_balances_no_truncate
  before truncate on ledger_foreign_opening_balances
  for each statement execute function toeyee_forbid_mutation();

create function tohyee_check_foreign_opening_balance() returns trigger
language plpgsql as $$
declare
  account record;
  base_total numeric;
begin
  select a.code, a.currency_code into account from accounts a where a.id = new.account_id;
  if not tohyee_is_foreign_account(new.account_id) or account.currency_code <> new.currency_code then
    raise exception 'Account % isn''t in %, so it has no opening foreign balance', account.code, new.currency_code
      using errcode = '23514';
  end if;
  if not exists (select 1 from ledger_journal_lines where account_id = new.account_id and foreign_amount is null) then
    raise exception 'Account % has no postings from before Tohyee kept foreign amounts, so it doesn''t need an opening foreign balance',
      account.code using errcode = '23514';
  end if;
  if exists (select 1 from ledger_journal_lines l join ledger_journals j on j.id = l.journal_id
              where l.account_id = new.account_id
                and (j.posting_date > new.as_at_date or l.foreign_amount is not null)) then
    raise exception 'Account % has postings after %, so its opening foreign balance can''t be as at that date',
      account.code, new.as_at_date using errcode = '23514';
  end if;
  select coalesce(sum(l.debit_amount - l.credit_amount), 0) into base_total
    from ledger_journal_lines l where l.account_id = new.account_id;
  if base_total <> new.base_balance then
    raise exception 'Account %''s balance on % is %, not %', account.code, new.as_at_date, base_total, new.base_balance
      using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger ledger_foreign_opening_balances_check
  before insert on ledger_foreign_opening_balances
  for each row execute function tohyee_check_foreign_opening_balance();

-- Every line posted from now on: a line on a foreign-currency account has a
-- foreign amount in the account's currency; a line on a base-currency
-- account has none. A line at a rate has base = foreign x rate, rounded once.
-- A foreign-currency account with base-only postings takes nothing new but
-- revaluations (whose foreign balance is then typed) until its opening
-- foreign balance is entered, and then nothing dated on or before it. Nothing but a revaluation is posted to a foreign-currency account dated
-- before its latest transfer out (money that left at its carrying value).
create function tohyee_check_foreign_line() returns trigger
language plpgsql as $$
declare
  account record;
  base text;
  posted date;
  opening record;
  latest_out date;
begin
  select a.code, a.name, a.currency_code into account from accounts a where a.id = new.account_id;
  select base_currency into base from organisation_settings;
  if account.currency_code is null or account.currency_code = base then
    if new.foreign_currency_code is not null then
      raise exception 'Account % (%) is in %, so its journal lines have no foreign amount', account.code, account.name,
        coalesce(base, 'the base currency') using errcode = '23514';
    end if;
    return new;
  end if;
  if new.foreign_currency_code is null then
    raise exception 'Account % (%) is in %: its journal lines need the % amount and exchange rate as well as the % amount',
      account.code, account.name, account.currency_code, account.currency_code, coalesce(base, 'base') using errcode = '23514';
  end if;
  if new.foreign_currency_code <> account.currency_code then
    raise exception 'Account % (%) is in %, not %', account.code, account.name, account.currency_code, new.foreign_currency_code
      using errcode = '23514';
  end if;
  if new.fx_kind = 'rate'
     and round(new.foreign_amount * new.exchange_rate, case when base in ('JPY', 'XPF') then 0 else 2 end)
         <> new.debit_amount + new.credit_amount then
    raise exception 'On account %, % % at % is %, not %', account.code, account.currency_code, new.foreign_amount,
      new.exchange_rate, round(new.foreign_amount * new.exchange_rate, 2), new.debit_amount + new.credit_amount
      using errcode = '23514';
  end if;
  select posting_date into posted from ledger_journals where id = new.journal_id;
  select * into opening from ledger_foreign_opening_balances where account_id = new.account_id;
  if found then
    if posted <= opening.as_at_date then
      raise exception 'Account % (%) has an opening foreign balance as at %, so nothing can be posted to it dated on or before then',
        account.code, account.name, opening.as_at_date using errcode = '23514';
    end if;
  elsif new.fx_kind <> 'revaluation'
        and exists (select 1 from ledger_journal_lines where account_id = new.account_id and foreign_amount is null) then
    raise exception 'Account % (%) has postings from before Tohyee kept foreign amounts. Enter its % balance as at a date (its opening foreign balance) first',
      account.code, account.name, account.currency_code using errcode = '23514';
  end if;
  select max(j.posting_date) into latest_out
    from ledger_journal_lines l join ledger_journals j on j.id = l.journal_id
   where l.account_id = new.account_id and l.fx_kind = 'carrying_value' and l.credit_amount > 0;
  if latest_out is not null and posted < latest_out and new.fx_kind <> 'revaluation' then
    raise exception 'Account % (%) had money transferred out on %, at its carrying value; nothing can be posted to it dated before then',
      account.code, account.name, latest_out using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger ledger_journal_lines_foreign_check
  before insert on ledger_journal_lines
  for each row execute function tohyee_check_foreign_line();

-- An account's currency can't change once it has postings (the app refused it
-- already; now the database does too), since its lines' foreign amounts are
-- in that currency.
create function tohyee_guard_account_currency() returns trigger
language plpgsql as $$
begin
  if new.currency_code is distinct from old.currency_code
     and exists (select 1 from ledger_journal_lines where account_id = old.id) then
    raise exception 'Account % has postings, so its currency can''t change', old.code using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger accounts_currency_guard
  before update of currency_code on accounts
  for each row execute function tohyee_guard_account_currency();

-- Statement lines record their currency (the file's, or the account's). Lines
-- from before this have none and are in the base currency.
alter table bank_statement_lines add column currency_code text check (currency_code ~ '^[A-Z]{3}$');
create function tohyee_check_statement_line_currency() returns trigger
language plpgsql as $$
declare
  account_currency text;
begin
  select coalesce(a.currency_code, s.base_currency) into account_currency
    from accounts a cross join organisation_settings s where a.id = new.account_id;
  if new.currency_code is null or new.currency_code is distinct from account_currency then
    raise exception 'Statement lines on this account are in %, not %', account_currency, coalesce(new.currency_code, 'no currency')
      using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger bank_statement_lines_currency_check
  before insert on bank_statement_lines
  for each row execute function tohyee_check_statement_line_currency();

-- Spend and receive money on a foreign-currency account: amounts are in the
-- account's currency, with the rate and each line's base amounts (what the
-- GST return and project costs count).
alter table bank_transactions
  add column exchange_rate numeric check (exchange_rate > 0 and scale(exchange_rate) <= 8),
  add column base_total numeric check (base_total > 0);
alter table bank_transactions add constraint bank_transactions_foreign_check
  check ((exchange_rate is null) = (base_total is null));
alter table bank_transaction_lines
  add column base_line_amount numeric check (base_line_amount >= 0),
  add column base_net_amount numeric check (base_net_amount >= 0),
  add column base_tax_amount numeric check (base_tax_amount >= 0);
alter table bank_transaction_lines add constraint bank_transaction_lines_base_check check (
  (base_line_amount is null and base_net_amount is null and base_tax_amount is null)
  or (base_line_amount is not null and base_net_amount is not null and base_tax_amount is not null
      and base_line_amount = base_net_amount + base_tax_amount)
);

-- Transfers between a base-currency account and a foreign-currency one: the
-- amount in the other account's currency, and for money leaving a foreign
-- account its carrying value and the realised gain (negative for a loss).
alter table bank_transfers
  add column to_currency_code text check (to_currency_code ~ '^[A-Z]{3}$'),
  add column to_amount numeric check (to_amount > 0),
  add column carrying_amount numeric check (carrying_amount >= 0),
  add column realised_gain numeric;
alter table bank_transfers add constraint bank_transfers_foreign_check
  check ((to_currency_code is null) = (to_amount is null));

-- Statement lines on foreign-currency accounts are reconciled against their
-- journal lines' foreign amounts (account_amount); lines kept only in the
-- base currency can't be. Otherwise as before (0032).
create or replace function tohyee_check_reconciliation(target bigint) returns void
language plpgsql as $$
declare
  rec record;
  line record;
  split record;
  total numeric;
  wrong integer;
  foreign_line boolean;
begin
  select * into rec from bank_reconciliations where id = target;
  if not found then
    return;
  end if;
  select * into line from bank_statement_lines where id = rec.statement_line_id;
  foreign_line := tohyee_is_foreign_account(line.account_id);
  if rec.status = 'active' then
    if line.status <> 'reconciled' then
      raise exception 'Statement line % has a reconciliation but isn''t marked reconciled', line.id using errcode = '23514';
    end if;
    select coalesce(sum(i.amount), 0),
           count(*) filter (
             where j.account_id <> line.account_id
                or (foreign_line and j.foreign_amount is null)
                or i.split_id is distinct from rec.split_id
                or (i.split_id is null and i.amount <> j.account_amount)
                or (i.split_id is null and exists (
                      select 1 from bank_reconciliation_items o
                       where o.active and o.journal_line_id = i.journal_line_id and o.id <> i.id))
                or (i.split_id is not null and (sign(i.amount) <> sign(j.account_amount)
                      or abs(i.amount) >= abs(j.account_amount))))
      into total, wrong
      from bank_reconciliation_items i join ledger_journal_lines j on j.id = i.journal_line_id
     where i.reconciliation_id = rec.id;
    if wrong > 0 then
      raise exception 'Statement line % is reconciled against journal lines on another account or with other amounts', line.id
        using errcode = '23514';
    end if;
    if total <> line.amount then
      raise exception 'Statement line % (%) is reconciled against journal lines adding up to %', line.id, line.amount, total
        using errcode = '23514';
    end if;
    if rec.split_id is not null then
      select s.id, s.account_id, s.journal_line_id, j.account_amount as journal_amount into split
        from bank_reconciliation_splits s join ledger_journal_lines j on j.id = s.journal_line_id
       where s.id = rec.split_id;
      if split.account_id <> line.account_id
         or exists (select 1 from bank_reconciliation_items i
                     where i.reconciliation_id = rec.id and i.journal_line_id <> split.journal_line_id)
         or exists (select 1 from bank_reconciliations r where r.split_id = split.id and r.status <> 'active')
         or (select count(*) from bank_reconciliations r where r.split_id = split.id) < 2
         or exists (select 1 from bank_reconciliation_items i
                     where i.active and i.journal_line_id = split.journal_line_id and i.split_id is distinct from split.id)
         or (select coalesce(sum(i.amount), 0) from bank_reconciliation_items i
              where i.active and i.split_id = split.id) <> split.journal_amount then
        raise exception 'Split reconciliation % doesn''t add up to its journal line, or isn''t reconciled as a whole', split.id
          using errcode = '23514';
      end if;
    end if;
  else
    if line.status = 'reconciled'
       and not exists (select 1 from bank_reconciliations where statement_line_id = line.id and status = 'active') then
      raise exception 'Statement line % is marked reconciled without a reconciliation', line.id using errcode = '23514';
    end if;
    if rec.split_id is not null
       and exists (select 1 from bank_reconciliations r where r.split_id = rec.split_id and r.status = 'active') then
      raise exception 'Split reconciliation % is only partly unreconciled; unreconcile all its lines together', rec.split_id
        using errcode = '23514';
    end if;
  end if;
end;
$$;

-- Realised currency gains and losses (FXB5, FXB8) go to the account marked
-- for them: 7020 in the starting chart, or that code or the next free one.
update accounts set system_key = 'realised_fx', updated_at = now()
 where lower(code) = '7020' and account_class = 'revenue' and system_key is null and currency_code is null
   and not exists (select 1 from accounts where system_key = 'realised_fx');
insert into accounts (code, name, account_class, account_type, system_key)
select (select min(c)::text from generate_series(7020, 7999) c where not exists (select 1 from accounts where lower(code) = c::text)),
       'Realised currency gains and losses', 'revenue', 'other_income', 'realised_fx'
 where exists (select 1 from accounts)
   and not exists (select 1 from accounts where system_key = 'realised_fx');
`,
  },
  {
    version: "0034",
    name: "bringing_in_existing_books",
    sql: `
-- Bringing in an organisation's existing books (examples IM1-IM16).

-- An account's usual GST code, offered when the account is picked on a line
-- (like the tax code on another system's chart of accounts).
alter table accounts add column default_tax_code_id bigint references tax_codes(id);

-- Opening balances are posted by one journal of their own origin.
alter table ledger_journals drop constraint ledger_journals_origin_check;
alter table ledger_journals add constraint ledger_journals_origin_check
  check (origin in ('manual', 'correction', 'inventory', 'fx_revaluation', 'invoice', 'customer_payment', 'bill',
                    'supplier_payment', 'sales_credit_note', 'sales_credit_note_refund',
                    'supplier_credit_note', 'supplier_credit_note_refund', 'customer_overpayment_refund',
                    'bank_transaction', 'bank_transfer', 'customer_payment_batch', 'supplier_payment_batch',
                    'expense_claim', 'expense_claim_payment', 'fixed_asset_depreciation', 'fixed_asset_disposal',
                    'opening_balance'));

-- Open invoices and bills at the conversion date (IM5-IM9). They keep the
-- number they had (an opening invoice has no INV sequence of its own; new
-- invoices skip any INV-number already taken), post Dr accounts receivable /
-- Cr conversion clearing (bills the other way) with no GST, and never count
-- in GST returns or sales reports.
alter table sales_invoices add column is_opening_balance boolean not null default false;
alter table bills add column is_opening_balance boolean not null default false;
do $$
declare
  item record;
begin
  for item in
    select conname from pg_constraint
     where conrelid = 'sales_invoices'::regclass and contype = 'c'
       and pg_get_constraintdef(oid) like '%invoice_sequence%'
  loop
    execute format('alter table sales_invoices drop constraint %I', item.conname);
  end loop;
end;
$$;
alter table sales_invoices add constraint sales_invoices_number_check check (
  case when is_opening_balance
    then invoice_sequence is null and (invoice_number is null or length(invoice_number) between 1 and 100)
    else invoice_number is null
      or invoice_number = 'INV-' || lpad(invoice_sequence::text, greatest(4, length(invoice_sequence::text)), '0')
  end
);
alter table sales_invoices add constraint sales_invoices_status_check_fields check (
  (status = 'draft'
    and invoice_sequence is null and invoice_number is null and approval_journal_id is null
    and approve_command_source is null and approve_idempotency_key is null
    and approve_request_hash is null and approved_at is null
    and void_date is null and void_journal_id is null and void_command_source is null
    and void_idempotency_key is null and void_request_hash is null and voided_at is null)
  or (status = 'approved'
    and (is_opening_balance or invoice_sequence is not null) and invoice_number is not null and approval_journal_id is not null
    and approve_command_source is not null and approve_idempotency_key is not null
    and approve_request_hash is not null and approved_at is not null
    and void_date is null and void_journal_id is null and void_command_source is null
    and void_idempotency_key is null and void_request_hash is null and voided_at is null)
  or (status = 'voided'
    and (is_opening_balance or invoice_sequence is not null) and invoice_number is not null and approval_journal_id is not null
    and approve_command_source is not null and approve_idempotency_key is not null
    and approve_request_hash is not null and approved_at is not null
    and void_date is not null and void_journal_id is not null and void_command_source is not null
    and void_idempotency_key is not null and void_request_hash is not null and voided_at is not null)
);
alter table sales_invoices add constraint sales_invoices_opening_check
  check (not is_opening_balance or (tax_total = 0 and amounts_mode = 'no_tax'));
alter table bills add constraint bills_opening_check
  check (not is_opening_balance or (tax_total = 0 and amounts_mode = 'no_tax'));

-- The opening balances as brought in (IM1-IM4): once per organisation, never
-- changed. The lines are the trial balance as imported; the journal is what
-- was posted from it.
create table conversion_balances (
  id boolean primary key default true check (id),
  command_source text not null,
  idempotency_key text not null,
  request_hash text not null,
  conversion_date date not null,
  journal_id bigint not null unique references ledger_journals(id),
  invoice_count integer not null check (invoice_count >= 0),
  bill_count integer not null check (bill_count >= 0),
  stock_count integer not null check (stock_count >= 0),
  created_by_user_id uuid,
  created_by_email text,
  created_at timestamptz not null default now(),
  unique (command_source, idempotency_key)
);
create table conversion_balance_lines (
  id bigserial primary key,
  line_order integer not null unique check (line_order > 0),
  account_id bigint not null unique references accounts(id),
  debit_amount numeric not null check (debit_amount >= 0),
  credit_amount numeric not null check (credit_amount >= 0),
  check ((debit_amount > 0) <> (credit_amount > 0))
);
create trigger conversion_balances_append_only
  before update or delete on conversion_balances
  for each row execute function toeyee_forbid_mutation();
create trigger conversion_balances_no_truncate
  before truncate on conversion_balances
  for each statement execute function toeyee_forbid_mutation();
create trigger conversion_balance_lines_append_only
  before update or delete on conversion_balance_lines
  for each row execute function toeyee_forbid_mutation();
create trigger conversion_balance_lines_no_truncate
  before truncate on conversion_balance_lines
  for each statement execute function toeyee_forbid_mutation();

-- The imported trial balance balances, checked at commit.
create function tohyee_check_conversion_lines() returns trigger
language plpgsql as $$
declare
  debits numeric;
  credits numeric;
begin
  select coalesce(sum(debit_amount), 0), coalesce(sum(credit_amount), 0) into debits, credits from conversion_balance_lines;
  if debits <> credits then
    raise exception 'The opening balances don''t balance: debits %, credits %', debits, credits using errcode = '23514';
  end if;
  return null;
end;
$$;
create constraint trigger conversion_balance_lines_balance
  after insert on conversion_balance_lines deferrable initially deferred
  for each row execute function tohyee_check_conversion_lines();

-- How each kind of file was last mapped (column headings per field), so the
-- next file from the same system is read the same way.
create table import_mappings (
  kind text primary key check (kind in ('accounts', 'contacts', 'items', 'trial_balance', 'stock', 'open_invoices', 'open_bills')),
  preset text not null check (preset in ('tohyee', 'other_system')),
  columns jsonb not null,
  options jsonb not null default '{}'::jsonb,
  updated_by_email text,
  updated_at timestamptz not null default now()
);
`,
  },
  {
    version: "0035",
    name: "document_emails",
    sql: `
-- Emailing invoices, credit notes, quotes, purchase orders and customer
-- statements from the organisation's own email account (Gmail, Microsoft 365
-- or any SMTP server). The account's password is encrypted with the server's
-- TOHYEE_SECRET_KEY (the same encryption as other stored secrets) and is
-- never sent back to the browser.
create table organisation_email_settings (
  id boolean primary key default true check (id),
  from_name text not null check (length(from_name) between 1 and 100),
  from_address text not null check (length(from_address) between 3 and 254),
  reply_to text check (reply_to is null or length(reply_to) between 3 and 254),
  smtp_host text not null check (smtp_host ~ '^[a-z0-9.-]{1,200}$' or smtp_host = '::1'),
  smtp_port integer not null check (smtp_port between 1 and 65535),
  smtp_security text not null check (smtp_security in ('ssl', 'starttls', 'none')),
  smtp_username text not null check (length(smtp_username) between 1 and 254),
  smtp_password_ciphertext text not null,
  updated_by_email text not null,
  updated_at timestamptz not null default now(),
  last_test_at timestamptz,
  last_test_ok boolean,
  last_test_error text
);

-- The subject and message each kind of document's email starts with. No
-- row means Tohyee's default template.
create table email_templates (
  document_kind text primary key
    check (document_kind in ('invoice', 'credit_note', 'quote', 'purchase_order', 'statement')),
  subject text not null check (length(subject) between 1 and 250),
  body text not null check (length(body) between 1 and 10000),
  updated_by_email text not null,
  updated_at timestamptz not null default now()
);

-- A run of "email statements to every customer with a balance".
create table document_email_batches (
  id bigserial primary key,
  command_source text not null,
  idempotency_key text not null,
  request_hash text not null,
  statement jsonb not null,
  requested_by_user_id uuid,
  requested_by_email text not null,
  created_at timestamptz not null default now(),
  unique (command_source, idempotency_key)
);

-- Each email asked for: queued, then sent or failed by the background job.
-- 'sent' is only ever set when the SMTP server accepted the message (its
-- message id and reply are kept). What the email says and who it goes to
-- can't change once queued, finished emails can't change at all, and none
-- are ever deleted.
create table document_emails (
  id bigserial primary key,
  command_source text not null,
  idempotency_key text not null,
  request_hash text not null,
  document_kind text not null
    check (document_kind in ('invoice', 'credit_note', 'quote', 'purchase_order', 'statement')),
  -- The invoice, credit note, quote or purchase order; for a statement, the customer.
  document_id bigint not null,
  contact_id bigint not null references contacts(id),
  statement jsonb check ((document_kind = 'statement') = (statement is not null)),
  batch_id bigint references document_email_batches(id),
  to_addresses text[] not null check (cardinality(to_addresses) between 1 and 20),
  cc_addresses text[] not null default '{}' check (cardinality(cc_addresses) <= 20),
  subject text not null check (length(subject) between 1 and 250),
  body text not null check (length(body) between 1 and 10000),
  attachment_name text not null,
  status text not null default 'queued' check (status in ('queued', 'sending', 'sent', 'failed')),
  attempts integer not null default 0 check (attempts >= 0),
  next_attempt_at timestamptz not null default now(),
  claimed_at timestamptz,
  last_error text,
  message_id text,
  smtp_response text,
  attachment_sha256 text,
  attachment_bytes integer,
  requested_by_user_id uuid,
  requested_by_email text not null,
  created_at timestamptz not null default now(),
  finished_at timestamptz,
  unique (command_source, idempotency_key),
  check (status <> 'sent' or (message_id is not null and finished_at is not null and attachment_sha256 is not null)),
  check (status <> 'failed' or (last_error is not null and finished_at is not null))
);
create index document_emails_document on document_emails (document_kind, document_id, id);
create index document_emails_due on document_emails (next_attempt_at) where status in ('queued', 'sending');
create index document_emails_batch on document_emails (batch_id) where batch_id is not null;
create index document_emails_created on document_emails (created_at);

create function tohyee_guard_document_email() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' or tg_op = 'TRUNCATE' then
    raise exception 'Emails are kept as a record of what was sent; they can''t be deleted' using errcode = 'P0001';
  end if;
  if old.status in ('sent', 'failed') then
    raise exception 'Email % has finished and can''t be changed; send it again instead', old.id using errcode = 'P0001';
  end if;
  if new.document_kind is distinct from old.document_kind or new.document_id is distinct from old.document_id
     or new.contact_id is distinct from old.contact_id or new.statement is distinct from old.statement
     or new.batch_id is distinct from old.batch_id or new.to_addresses is distinct from old.to_addresses
     or new.cc_addresses is distinct from old.cc_addresses or new.subject is distinct from old.subject
     or new.body is distinct from old.body or new.attachment_name is distinct from old.attachment_name
     or new.requested_by_email is distinct from old.requested_by_email
     or new.requested_by_user_id is distinct from old.requested_by_user_id or new.created_at is distinct from old.created_at
     or new.request_hash is distinct from old.request_hash or new.idempotency_key is distinct from old.idempotency_key then
    raise exception 'What an email says and who it goes to can''t change once it''s queued' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger document_emails_guard
  before update or delete on document_emails
  for each row execute function tohyee_guard_document_email();
create trigger document_emails_no_truncate
  before truncate on document_emails
  for each statement execute function tohyee_guard_document_email();
create function tohyee_guard_document_email_batch() returns trigger
language plpgsql as $$
begin
  raise exception 'Statement runs are kept as a record of what was sent; they can''t be changed or deleted' using errcode = 'P0001';
end;
$$;
create trigger document_email_batches_guard
  before update or delete on document_email_batches
  for each row execute function tohyee_guard_document_email_batch();
create trigger document_email_batches_no_truncate
  before truncate on document_email_batches
  for each statement execute function tohyee_guard_document_email_batch();
`,
  },
  {
    version: "0036",
    name: "opening_gst_and_historical_adjustment",
    sql: `
-- Open invoices and bills at the conversion date carry the GST in what's
-- still owed (IM13, IM17-IM20), as in Xero: on the payments basis it's
-- returned when they're paid after the conversion. Their approval journal
-- still posts only Dr accounts receivable / Cr the conversion account (bills
-- the other way): the GST is already in the trial balance's GST line.
alter table sales_invoices drop constraint sales_invoices_opening_check;
alter table sales_invoices add constraint sales_invoices_opening_check
  check (not is_opening_balance or amounts_mode in ('no_tax', 'inclusive'));
alter table bills drop constraint bills_opening_check;
alter table bills add constraint bills_opening_check
  check (not is_opening_balance or amounts_mode in ('no_tax', 'inclusive'));

-- The account opening balances post through is equity, "Historical
-- adjustment" (IM1, IM21), like Xero's Historical Adjustment and NetSuite's
-- Opening Balance, at 3900 or the next free code up to 3999. An organisation
-- that already has the old 2990 Conversion clearing (current liability) with
-- nothing posted to it is changed over; one with postings is left as it is,
-- because an account's class is fixed once it has postings.
update accounts a
   set account_class = 'equity',
       account_type = 'equity',
       name = case when a.name = 'Conversion clearing' then 'Historical adjustment' else a.name end,
       code = case
                when a.code ~ '^299[0-9]$'
                  then coalesce((select min(c)::text from generate_series(3900, 3999) c
                                  where not exists (select 1 from accounts o where lower(o.code) = c::text)), a.code)
                else a.code
              end,
       description = 'Opening balances from invoices, bills and stock clear through here; it should always be 0.00.',
       updated_at = now()
 where a.system_key = 'conversion_clearing'
   and a.account_class <> 'equity'
   and not exists (select 1 from ledger_journal_lines l where l.account_id = a.id);
insert into accounts (code, name, account_class, account_type, system_key, description)
select (select min(c)::text from generate_series(3900, 3999) c where not exists (select 1 from accounts where lower(code) = c::text)),
       'Historical adjustment', 'equity', 'equity', 'conversion_clearing',
       'Opening balances from invoices, bills and stock clear through here; it should always be 0.00.'
 where exists (select 1 from accounts)
   and not exists (select 1 from accounts where system_key = 'conversion_clearing')
   and exists (select 1 from generate_series(3900, 3999) c where not exists (select 1 from accounts where lower(code) = c::text));
`,
  },
  {
    version: "0037",
    name: "microsoft_sending_and_logo",
    sql: `
-- Sending documents through a Microsoft 365 or Outlook mailbox the admin
-- signs in to (OAuth 2.0 with the organisation's own Microsoft app, the one
-- the CRM's mail sync uses, and Microsoft Graph's sendMail), as well as
-- through SMTP. The tokens are encrypted with TOHYEE_SECRET_KEY, like the
-- SMTP password, and never sent to the browser. SMTP details stay saved when
-- the Microsoft mailbox is chosen, and the other way round.
alter table organisation_email_settings
  add column sending_method text not null default 'smtp' check (sending_method in ('smtp', 'microsoft')),
  add column microsoft_email text check (microsoft_email is null or length(microsoft_email) between 3 and 254),
  add column microsoft_refresh_token_ciphertext text,
  add column microsoft_access_token_ciphertext text,
  add column microsoft_access_token_expires_at timestamptz,
  add column microsoft_connected_by_email text,
  add column microsoft_connected_at timestamptz;
alter table organisation_email_settings
  alter column smtp_host drop not null,
  alter column smtp_port drop not null,
  alter column smtp_security drop not null,
  alter column smtp_username drop not null,
  alter column smtp_password_ciphertext drop not null;
alter table organisation_email_settings add constraint organisation_email_settings_smtp_complete check (
  (smtp_host is null) = (smtp_port is null) and (smtp_host is null) = (smtp_security is null)
  and (smtp_host is null) = (smtp_username is null) and (smtp_host is null) = (smtp_password_ciphertext is null));
alter table organisation_email_settings add constraint organisation_email_settings_microsoft_complete check (
  (microsoft_email is null) = (microsoft_refresh_token_ciphertext is null)
  and (microsoft_email is null) = (microsoft_connected_at is null));
alter table organisation_email_settings add constraint organisation_email_settings_method_ready check (
  (sending_method = 'smtp' and smtp_host is not null) or (sending_method = 'microsoft' and microsoft_email is not null));

-- One-time sign-in states for connecting the sending mailbox (15 minutes, once).
create table email_oauth_states (
  state text primary key,
  user_id text not null,
  created_at timestamptz not null default now(),
  used_at timestamptz
);

-- How each email went: through SMTP or Microsoft Graph.
alter table document_emails add column sent_via text check (sent_via in ('smtp', 'microsoft'));

-- The organisation's logo, on emails, PDFs and printed documents. Stored in
-- the organisation's own database so its backup includes it; replacing it
-- replaces the row.
create table organisation_logo (
  id boolean primary key default true check (id),
  file_name text not null check (length(file_name) between 1 and 255),
  content_type text not null check (content_type in ('image/png', 'image/jpeg')),
  byte_size integer not null check (byte_size between 1 and 524288),
  width integer not null check (width between 1 and 4000),
  height integer not null check (height between 1 and 4000),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  content bytea not null check (octet_length(content) = byte_size),
  uploaded_by_email text not null,
  uploaded_at timestamptz not null default now()
);
`,
  },
  {
    version: "0038",
    name: "opening_balance_account_name",
    sql: `
-- The account opening balances clear through is called "Opening balance",
-- like NetSuite's Opening Balance account (Jess, 30 Sep 2026). Only the
-- starting name changes; an account someone has renamed keeps its name.
update accounts
   set name = 'Opening balance', updated_at = now()
 where system_key = 'conversion_clearing'
   and name = 'Historical adjustment';
`,
  },
  {
    version: "0039",
    name: "period_close",
    sql: `
-- Period close (examples PC1-PC12), like NetSuite's Period Close Checklist:
-- months are closed in order and the lock date is the last day closed, so
-- reopening a month reopens every later one. The unlock window goes: an
-- open window becomes a reopening from its first day (what reopening that
-- month does now), recorded in the audit log.
insert into audit_events (event_type, entity_type, entity_id, actor_email, details)
select 'ledger.period_reopened', 'accounting_period_controls', '1', null,
       jsonb_build_object(
         'reason', 'Tohyee update: the unlock window from ' || unlock_start || ' to ' || unlock_end
                   || ' became a reopening from ' || unlock_start || ' (unlock windows were replaced by Period close).',
         'from', jsonb_build_object('lockDate', lock_date::text),
         'to', jsonb_build_object('lockDate', (unlock_start - 1)::text))
  from accounting_period_controls
 where unlock_start is not null and lock_date is not null and unlock_start <= lock_date;
update accounting_period_controls
   set lock_date = unlock_start - 1, updated_at = now()
 where unlock_start is not null and lock_date is not null and unlock_start <= lock_date;
alter table accounting_period_controls drop column unlock_start, drop column unlock_end;

-- Nothing can be posted on or before the lock date, whatever the app does.
-- The row is read "for share" so closing a period waits for postings in
-- progress, and postings wait for a close in progress.
create function tohyee_refuse_locked_posting() returns trigger
language plpgsql as $$
declare
  locked date;
begin
  select lock_date into locked from accounting_period_controls where id for share;
  if locked is not null and new.posting_date <= locked then
    raise exception 'Journal dated % is in a closed period (closed up to %).', new.posting_date, locked
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
create trigger ledger_journals_open_period
  before insert on ledger_journals
  for each row execute function tohyee_refuse_locked_posting();
`,
  },
  {
    version: "0040",
    name: "repeating_bills",
    sql: `
-- Repeating bill templates (RB1-RB10), the purchases twin of repeating
-- invoices (RI1-RI10) and like Xero's repeating bills. The same schedule
-- (every N weeks or months from the start date, until an optional end date);
-- templates are ended, never deleted, and post nothing.
--
-- Suppliers have no payment terms in Tohyee, so the due date is a rule:
-- N days after the bill date, N days after the end of the bill's month, or
-- day N of the following month. Every bill needs a supplier invoice number
-- that's unique for its supplier, so the template holds a pattern with
-- {date} or {n} (RB3), filled in for each bill.
create table repeating_bills (
  id bigserial primary key,
  command_source text not null,
  idempotency_key text not null,
  request_hash text not null,
  status text not null default 'active' check (status in ('active', 'paused', 'ended')),
  contact_id bigint not null references contacts(id),
  supplier_invoice_number text not null check (length(supplier_invoice_number) between 1 and 80
    and (supplier_invoice_number like '%{date}%' or supplier_invoice_number like '%{n}%' or supplier_invoice_number like '%{month}%')),
  amounts_mode text not null check (amounts_mode in ('exclusive', 'inclusive', 'no_tax')),
  currency_code text not null check (currency_code ~ '^[A-Z]{3}$'),
  subtotal numeric not null check (subtotal >= 0),
  tax_total numeric not null check (tax_total >= 0),
  total numeric not null check (total > 0),
  custom_fields jsonb not null default '{}'::jsonb,
  period text not null check (period in ('week', 'month')),
  every integer not null check (every between 1 and 99),
  start_date date not null,
  end_date date,
  due_rule text not null check (due_rule in ('days_after', 'days_after_month_end', 'day_of_next_month')),
  due_days integer not null check (due_days between 0 and 365),
  save_as text not null check (save_as in ('draft', 'approve')),
  resumed_from date,
  last_error text,
  last_error_at timestamptz,
  created_by_user_id uuid,
  created_by_email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (command_source, idempotency_key),
  check (end_date is null or end_date >= start_date),
  check (due_rule <> 'day_of_next_month' or due_days between 1 and 31),
  check (total = subtotal + tax_total)
);
create index repeating_bills_status_idx on repeating_bills (status, id);
create trigger repeating_bills_no_delete before delete on repeating_bills
  for each row execute function toeyee_forbid_delete();
create trigger repeating_bills_no_truncate before truncate on repeating_bills
  for each statement execute function toeyee_forbid_delete();

-- An ended template can't change or start again (RB8).
create function tohyee_guard_repeating_bill() returns trigger
language plpgsql as $$
begin
  if old.status = 'ended' then
    raise exception 'This repeating bill has ended, so it can''t be changed' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger repeating_bills_guard before update on repeating_bills
  for each row execute function tohyee_guard_repeating_bill();

create table repeating_bill_lines (
  id bigserial primary key,
  repeating_bill_id bigint not null references repeating_bills(id),
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
  tracking jsonb not null default '{}'::jsonb,
  custom_fields jsonb not null default '{}'::jsonb,
  item_id bigint references items(id),
  unit_id bigint references item_units(id),
  base_quantity numeric,
  unique (repeating_bill_id, line_order),
  check (tax_code_id is not null or tax_rate = 0),
  check (net_amount = line_amount or net_amount + tax_amount = line_amount),
  check ((item_id is null) = (base_quantity is null) and (unit_id is null or item_id is not null))
);
create function tohyee_guard_repeating_bill_line() returns trigger
language plpgsql as $$
begin
  if tg_op = 'TRUNCATE' then
    raise exception 'repeating_bill_lines can''t be truncated' using errcode = 'P0001';
  end if;
  if (select status from repeating_bills
       where id = case when tg_op = 'DELETE' then old.repeating_bill_id else new.repeating_bill_id end) = 'ended' then
    raise exception 'Lines of an ended repeating bill can''t be changed' using errcode = 'P0001';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;
create trigger repeating_bill_lines_guard before insert or update or delete on repeating_bill_lines
  for each row execute function tohyee_guard_repeating_bill_line();
create trigger repeating_bill_lines_no_truncate before truncate on repeating_bill_lines
  for each statement execute function tohyee_guard_repeating_bill_line();
create trigger repeating_bill_lines_item before insert or update on repeating_bill_lines
  for each row execute function tohyee_check_line_item();
create trigger repeating_bill_lines_tracking before insert or update on repeating_bill_lines
  for each row when (new.tracking <> '{}'::jsonb) execute function tohyee_check_line_tracking();
create trigger repeating_bills_custom_fields before insert or update on repeating_bills
  for each row when (new.custom_fields <> '{}'::jsonb) execute function tohyee_check_custom_values('document');
create trigger repeating_bill_lines_custom_fields before insert or update on repeating_bill_lines
  for each row when (new.custom_fields <> '{}'::jsonb) execute function tohyee_check_custom_values('line');

-- One row per scheduled date that made a bill: the unique key stops a date
-- being made twice (RB4). Never changed or deleted, except that deleting the
-- draft bill clears its link (RB9), so the date isn't made again.
create table repeating_bill_runs (
  id bigserial primary key,
  repeating_bill_id bigint not null references repeating_bills(id),
  scheduled_date date not null,
  bill_id bigint unique references bills(id) on delete set null,
  bill_deleted boolean not null default false,
  outcome text not null check (outcome in ('draft', 'approved', 'approval_refused')),
  message text check (message is null or length(message) between 1 and 1000),
  created_by_email text,
  created_at timestamptz not null default now(),
  unique (repeating_bill_id, scheduled_date),
  check (outcome <> 'approval_refused' or message is not null),
  check (outcome <> 'draft' or message is null)
);
create function tohyee_guard_repeating_bill_run() returns trigger
language plpgsql as $$
begin
  if tg_op = 'TRUNCATE' then
    raise exception 'repeating_bill_runs can''t be truncated' using errcode = 'P0001';
  end if;
  if tg_op = 'DELETE' then
    raise exception 'A repeating bill''s history can''t be deleted' using errcode = 'P0001';
  end if;
  if old.bill_id is not null and new.bill_id is null
     and (to_jsonb(new) - array['bill_id', 'bill_deleted']) = (to_jsonb(old) - array['bill_id', 'bill_deleted']) then
    new.bill_deleted := true;
    return new;
  end if;
  raise exception 'A repeating bill''s history can''t be changed' using errcode = 'P0001';
end;
$$;
create trigger repeating_bill_runs_guard before update or delete on repeating_bill_runs
  for each row execute function tohyee_guard_repeating_bill_run();
create trigger repeating_bill_runs_no_truncate before truncate on repeating_bill_runs
  for each statement execute function tohyee_guard_repeating_bill_run();
`,
  },
  {
    version: "0041",
    name: "netsuite_followups",
    sql: `
-- Following NetSuite (decided 1 Oct 2026, examples SPT1-SPT5, RB11-RB13,
-- GP1-GP6):
--
-- Supplier payment terms (NetSuite vendors have a Terms field): a supplier's
-- default term, from the same list as customers' terms. It's its own column
-- because a contact that's both a customer and a supplier can have different
-- terms each way.
alter table contacts
  add column supplier_payment_term_id bigint references payment_terms(id);

-- A draft bill can be saved without the supplier's invoice number (NetSuite's
-- reference number is optional), to be filled in when the real invoice
-- arrives. Approving still needs one, unique for the supplier (B5): approved
-- and voided bills always have it.
alter table bills alter column supplier_invoice_number drop not null;
alter table bills add constraint bills_number_unless_draft
  check (status = 'draft' or supplier_invoice_number is not null);

-- A repeating bill can leave the number pattern empty; its bills are then
-- always drafts without a number (RB11). Its due date can come from the
-- supplier's payment terms (RB12).
alter table repeating_bills alter column supplier_invoice_number drop not null;
alter table repeating_bills add constraint repeating_bills_number_or_draft
  check (supplier_invoice_number is not null or save_as = 'draft');
alter table repeating_bills drop constraint repeating_bills_due_rule_check;
alter table repeating_bills add constraint repeating_bills_due_rule_check
  check (due_rule in ('days_after', 'days_after_month_end', 'day_of_next_month', 'terms'));
alter table repeating_bills add constraint repeating_bills_terms_days
  check (due_rule <> 'terms' or due_days = 0);

-- The GST filing frequency (NetSuite's tax periods): 1, 2 or 6 months, and
-- which months the periods end in, kept as the first month of the year a
-- period ends in (1 for monthly; 1 or 2 for two-monthly, odd or even
-- months; 1-6 for six-monthly, e.g. 3 for March and September). Null until
-- it's set; the GST return and the period close then fall back to the
-- latest filed return's length.
alter table organisation_settings
  add column gst_period_months smallint check (gst_period_months in (1, 2, 6)),
  add column gst_period_end_month smallint,
  add constraint organisation_settings_gst_period
    check ((gst_period_months is null and gst_period_end_month is null)
        or (gst_period_months is not null and gst_period_end_month between 1 and gst_period_months));
`,
  },
  {
    version: "0042",
    name: "multi_currency_documents",
    sql: `
-- Multi-currency sales invoices, bills, credit notes and payments (examples
-- MC1-MC13, following NetSuite). A contact has a currency (null: the base
-- currency), like a NetSuite customer's or vendor's primary currency, and its
-- invoices, bills and credit notes are in it. It can't change once the
-- contact has any.
alter table contacts add column currency_code text check (currency_code ~ '^[A-Z]{3}$');

create function tohyee_guard_contact_currency() returns trigger
language plpgsql as $$
begin
  if coalesce(new.currency_code, '') is distinct from coalesce(old.currency_code, '')
     and (exists (select 1 from sales_invoices where contact_id = old.id)
          or exists (select 1 from bills where contact_id = old.id)
          or exists (select 1 from sales_credit_notes where contact_id = old.id)
          or exists (select 1 from supplier_credit_notes where contact_id = old.id)) then
    raise exception 'Contact % has invoices, bills or credit notes, so its currency can''t change', old.name
      using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger contacts_currency_guard
  before update of currency_code on contacts
  for each row execute function tohyee_guard_contact_currency();

-- A foreign-currency document keeps its exchange rate (base currency per 1
-- unit, up to 8 decimal places) and its base-currency amounts: each line
-- converted on its own and rounded once, the totals the sum of the lines
-- (NetSuite converts line by line). A base-currency document has none.
alter table sales_invoices
  add column exchange_rate numeric check (exchange_rate > 0 and scale(exchange_rate) <= 8),
  add column base_subtotal numeric, add column base_tax_total numeric, add column base_total numeric;
alter table bills
  add column exchange_rate numeric check (exchange_rate > 0 and scale(exchange_rate) <= 8),
  add column base_subtotal numeric, add column base_tax_total numeric, add column base_total numeric;
alter table sales_credit_notes
  add column exchange_rate numeric check (exchange_rate > 0 and scale(exchange_rate) <= 8),
  add column base_subtotal numeric, add column base_tax_total numeric, add column base_total numeric;
alter table supplier_credit_notes
  add column exchange_rate numeric check (exchange_rate > 0 and scale(exchange_rate) <= 8),
  add column base_subtotal numeric, add column base_tax_total numeric, add column base_total numeric;
alter table sales_invoices add constraint sales_invoices_base_check check (
  (exchange_rate is null and base_subtotal is null and base_tax_total is null and base_total is null)
  or (exchange_rate is not null and base_total = base_subtotal + base_tax_total and base_total > 0));
alter table bills add constraint bills_base_check check (
  (exchange_rate is null and base_subtotal is null and base_tax_total is null and base_total is null)
  or (exchange_rate is not null and base_total = base_subtotal + base_tax_total and base_total > 0));
alter table sales_credit_notes add constraint sales_credit_notes_base_check check (
  (exchange_rate is null and base_subtotal is null and base_tax_total is null and base_total is null)
  or (exchange_rate is not null and base_total = base_subtotal + base_tax_total and base_total > 0));
alter table supplier_credit_notes add constraint supplier_credit_notes_base_check check (
  (exchange_rate is null and base_subtotal is null and base_tax_total is null and base_total is null)
  or (exchange_rate is not null and base_total = base_subtotal + base_tax_total and base_total > 0));
alter table sales_invoice_lines add column base_net_amount numeric, add column base_tax_amount numeric;
alter table bill_lines add column base_net_amount numeric, add column base_tax_amount numeric;
alter table sales_credit_note_lines add column base_net_amount numeric, add column base_tax_amount numeric;
alter table supplier_credit_note_lines add column base_net_amount numeric, add column base_tax_amount numeric;

-- A document is in its contact's currency, and has a rate exactly when that
-- isn't the base currency.
create function tohyee_check_document_currency() returns trigger
language plpgsql as $$
declare
  wanted text;
begin
  select coalesce(c.currency_code, s.base_currency) into wanted
    from contacts c cross join organisation_settings s where c.id = new.contact_id;
  if wanted is not null and new.currency_code <> wanted then
    raise exception 'This contact''s documents are in %, not %', wanted, new.currency_code using errcode = '23514';
  end if;
  if (new.currency_code = (select base_currency from organisation_settings)) <> (new.exchange_rate is null) then
    raise exception 'A document has an exchange rate exactly when it isn''t in the base currency' using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger sales_invoices_currency_check before insert or update of contact_id, currency_code, exchange_rate on sales_invoices
  for each row execute function tohyee_check_document_currency();
create trigger bills_currency_check before insert or update of contact_id, currency_code, exchange_rate on bills
  for each row execute function tohyee_check_document_currency();
create trigger sales_credit_notes_currency_check before insert or update of contact_id, currency_code, exchange_rate on sales_credit_notes
  for each row execute function tohyee_check_document_currency();
create trigger supplier_credit_notes_currency_check before insert or update of contact_id, currency_code, exchange_rate on supplier_credit_notes
  for each row execute function tohyee_check_document_currency();

-- A payment of a foreign-currency invoice or bill keeps its own rate, the
-- base amount that moved in the bank account (amount x rate, rounded once),
-- the base amount it cleared from accounts receivable or payable (the
-- document's carrying value of what it paid) and the realised gain (a loss
-- is negative), like NetSuite's realized gain/loss.
alter table customer_payments
  add column exchange_rate numeric check (exchange_rate > 0 and scale(exchange_rate) <= 8),
  add column base_amount numeric, add column base_cleared numeric, add column realised_gain numeric;
alter table customer_payments add constraint customer_payments_base_check check (
  (exchange_rate is null and base_amount is null and base_cleared is null and realised_gain is null)
  or (exchange_rate is not null and base_amount > 0 and base_cleared > 0 and realised_gain = base_amount - base_cleared
      and overpayment_amount = 0 and batch_id is null));
alter table supplier_payments
  add column exchange_rate numeric check (exchange_rate > 0 and scale(exchange_rate) <= 8),
  add column base_amount numeric, add column base_cleared numeric, add column realised_gain numeric;
alter table supplier_payments add constraint supplier_payments_base_check check (
  (exchange_rate is null and base_amount is null and base_cleared is null and realised_gain is null)
  or (exchange_rate is not null and base_amount > 0 and base_cleared > 0 and realised_gain = base_cleared - base_amount
      and batch_id is null));

-- Credit applied between two foreign-currency documents clears each at its
-- own carrying value; the difference is a realised gain or loss, posted in
-- its own journal (NetSuite's realized gain/loss on applying a credit).
alter table sales_credit_note_applications
  add column invoice_base numeric, add column credit_note_base numeric, add column realised_gain numeric,
  add column journal_id bigint references ledger_journals(id);
alter table sales_credit_note_applications add constraint sales_credit_note_applications_base_check check (
  (invoice_base is null and credit_note_base is null and realised_gain is null and journal_id is null)
  or (invoice_base > 0 and credit_note_base > 0 and realised_gain = credit_note_base - invoice_base
      and (journal_id is null) = (realised_gain = 0)));
alter table supplier_credit_note_applications
  add column bill_base numeric, add column credit_note_base numeric, add column realised_gain numeric,
  add column journal_id bigint references ledger_journals(id);
alter table supplier_credit_note_applications add constraint supplier_credit_note_applications_base_check check (
  (bill_base is null and credit_note_base is null and realised_gain is null and journal_id is null)
  or (bill_base > 0 and credit_note_base > 0 and realised_gain = bill_base - credit_note_base
      and (journal_id is null) = (realised_gain = 0)));

-- Accounts receivable and payable stay in the base currency, but, like
-- NetSuite's A/R and A/P accounts, hold foreign-currency documents too: a
-- line for one has its foreign amount and currency. fx_kind 'document' is a
-- document's own line (base = its lines converted one by one; the rate is the
-- document's); a payment or credit clearing it is 'carrying_value' (the
-- document's carrying value of what's cleared); revaluations as before.
alter table ledger_journal_lines drop constraint ledger_journal_lines_fx_kind_check;
alter table ledger_journal_lines add constraint ledger_journal_lines_fx_kind_check
  check (fx_kind in ('rate', 'implied', 'carrying_value', 'revaluation', 'document'));

create or replace function tohyee_check_foreign_line() returns trigger
language plpgsql as $$
declare
  account record;
  base text;
  posted date;
  opening record;
  latest_out date;
begin
  select a.code, a.name, a.currency_code, a.system_key into account from accounts a where a.id = new.account_id;
  select base_currency into base from organisation_settings;
  if account.currency_code is null or account.currency_code = base then
    if new.foreign_currency_code is not null then
      if account.system_key not in ('accounts_receivable', 'accounts_payable') then
        raise exception 'Account % (%) is in %, so its journal lines have no foreign amount', account.code, account.name,
          coalesce(base, 'the base currency') using errcode = '23514';
      end if;
      if new.foreign_currency_code = base then
        raise exception 'Account % (%): a foreign amount can''t be in the base currency', account.code, account.name
          using errcode = '23514';
      end if;
      if new.fx_kind not in ('document', 'carrying_value', 'revaluation') then
        raise exception 'Account % (%) only takes foreign amounts from invoices, bills, credit notes, their payments and revaluations',
          account.code, account.name using errcode = '23514';
      end if;
    end if;
    return new;
  end if;
  if new.fx_kind = 'document' then
    raise exception 'Account % (%) is a foreign-currency account, not accounts receivable or payable', account.code, account.name
      using errcode = '23514';
  end if;
  if new.foreign_currency_code is null then
    raise exception 'Account % (%) is in %: its journal lines need the % amount and exchange rate as well as the % amount',
      account.code, account.name, account.currency_code, account.currency_code, coalesce(base, 'base') using errcode = '23514';
  end if;
  if new.foreign_currency_code <> account.currency_code then
    raise exception 'Account % (%) is in %, not %', account.code, account.name, account.currency_code, new.foreign_currency_code
      using errcode = '23514';
  end if;
  if new.fx_kind = 'rate'
     and round(new.foreign_amount * new.exchange_rate, case when base in ('JPY', 'XPF') then 0 else 2 end)
         <> new.debit_amount + new.credit_amount then
    raise exception 'On account %, % % at % is %, not %', account.code, account.currency_code, new.foreign_amount,
      new.exchange_rate, round(new.foreign_amount * new.exchange_rate, 2), new.debit_amount + new.credit_amount
      using errcode = '23514';
  end if;
  select posting_date into posted from ledger_journals where id = new.journal_id;
  select * into opening from ledger_foreign_opening_balances where account_id = new.account_id;
  if found then
    if posted <= opening.as_at_date then
      raise exception 'Account % (%) has an opening foreign balance as at %, so nothing can be posted to it dated on or before then',
        account.code, account.name, opening.as_at_date using errcode = '23514';
    end if;
  elsif new.fx_kind <> 'revaluation'
        and exists (select 1 from ledger_journal_lines where account_id = new.account_id and foreign_amount is null) then
    raise exception 'Account % (%) has postings from before Tohyee kept foreign amounts. Enter its % balance as at a date (its opening foreign balance) first',
      account.code, account.name, account.currency_code using errcode = '23514';
  end if;
  select max(j.posting_date) into latest_out
    from ledger_journal_lines l join ledger_journals j on j.id = l.journal_id
   where l.account_id = new.account_id and l.fx_kind = 'carrying_value' and l.credit_amount > 0;
  if latest_out is not null and posted < latest_out and new.fx_kind <> 'revaluation' then
    raise exception 'Account % (%) had money transferred out on %, at its carrying value; nothing can be posted to it dated before then',
      account.code, account.name, latest_out using errcode = '23514';
  end if;
  return new;
end;
$$;

-- Revaluing open foreign-currency balances on accounts receivable and
-- payable (NetSuite's revaluation of open currency balances): one item per
-- account and currency on a date. Their balance can be either sign.
alter table ledger_fx_revaluation_run_items drop constraint ledger_fx_revaluation_run_items_account_id_revaluation_date_key;
alter table ledger_fx_revaluation_run_items add constraint ledger_fx_revaluation_run_items_account_currency_date_key
  unique (account_id, currency_code, revaluation_date);
alter table ledger_fx_revaluation_run_items drop constraint ledger_fx_revaluation_run_items_foreign_amount_check;
alter table ledger_fx_revaluation_run_items add constraint ledger_fx_revaluation_run_items_foreign_amount_check
  check (foreign_amount <> 0);
`,
  },
  {
    version: "0043",
    name: "multi_currency_settlements",
    sql: `
-- More multi-currency, following NetSuite (examples MC14-MC30): foreign
-- overpayments and refunds, payments for several foreign documents, and
-- quotes, repeating documents and purchase orders for foreign contacts.

-- A payment of a foreign-currency invoice can overpay it (MC14). The
-- overpayment is credit in the invoice's currency at the payment's rate:
-- base_overpayment is its base value (overpayment x rate, rounded once); the
-- invoice part clears the invoice at its carrying value (0 when it's all
-- overpayment), and the realised gain is on the invoice part only. Foreign
-- payments from before have no overpayment (null counts as 0). Parts of a
-- payment for several documents can be in a foreign currency now (MC20).
alter table customer_payments add column base_overpayment numeric;
alter table customer_payments drop constraint customer_payments_base_check;
alter table customer_payments add constraint customer_payments_base_check check (
  (exchange_rate is null and base_amount is null and base_cleared is null and realised_gain is null and base_overpayment is null)
  or (exchange_rate is not null and base_amount > 0 and base_cleared >= 0 and coalesce(base_overpayment, 0) >= 0
      and realised_gain = base_amount - coalesce(base_overpayment, 0) - base_cleared
      and (overpayment_amount <> 0 or coalesce(base_overpayment, 0) = 0)
      and (amount <> overpayment_amount or base_cleared = 0)));
alter table supplier_payments drop constraint supplier_payments_base_check;
alter table supplier_payments add constraint supplier_payments_base_check check (
  (exchange_rate is null and base_amount is null and base_cleared is null and realised_gain is null)
  or (exchange_rate is not null and base_amount > 0 and base_cleared > 0 and realised_gain = base_cleared - base_amount));

-- Applying a foreign overpayment to another invoice (MC15) clears each side
-- at its own carrying value; a difference is a realised gain or loss in a
-- journal of its own, as for credit notes (MC7).
alter table customer_overpayment_applications
  add column invoice_base numeric, add column overpayment_base numeric, add column realised_gain numeric,
  add column journal_id bigint references ledger_journals(id);
alter table customer_overpayment_applications add constraint customer_overpayment_applications_base_check check (
  (invoice_base is null and overpayment_base is null and realised_gain is null and journal_id is null)
  or (invoice_base > 0 and overpayment_base > 0 and realised_gain = overpayment_base - invoice_base
      and (journal_id is null) = (realised_gain = 0)));

-- A refund of foreign-currency credit (an overpayment, a credit note or a
-- supplier credit note; MC16-MC18) is in the credit's currency at the
-- refund's own rate: base_amount is what moved in the bank account (amount x
-- rate, rounded once), base_cleared the credit's carrying value of what's
-- refunded, and the difference a realised gain (a loss is negative).
alter table customer_overpayment_refunds
  add column exchange_rate numeric check (exchange_rate > 0 and scale(exchange_rate) <= 8),
  add column base_amount numeric, add column base_cleared numeric, add column realised_gain numeric;
alter table customer_overpayment_refunds add constraint customer_overpayment_refunds_base_check check (
  (exchange_rate is null and base_amount is null and base_cleared is null and realised_gain is null)
  or (exchange_rate is not null and base_amount > 0 and base_cleared > 0 and realised_gain = base_cleared - base_amount));
alter table sales_credit_note_refunds
  add column exchange_rate numeric check (exchange_rate > 0 and scale(exchange_rate) <= 8),
  add column base_amount numeric, add column base_cleared numeric, add column realised_gain numeric;
alter table sales_credit_note_refunds add constraint sales_credit_note_refunds_base_check check (
  (exchange_rate is null and base_amount is null and base_cleared is null and realised_gain is null)
  or (exchange_rate is not null and base_amount > 0 and base_cleared > 0 and realised_gain = base_cleared - base_amount));
alter table supplier_credit_note_refunds
  add column exchange_rate numeric check (exchange_rate > 0 and scale(exchange_rate) <= 8),
  add column base_amount numeric, add column base_cleared numeric, add column realised_gain numeric;
alter table supplier_credit_note_refunds add constraint supplier_credit_note_refunds_base_check check (
  (exchange_rate is null and base_amount is null and base_cleared is null and realised_gain is null)
  or (exchange_rate is not null and base_amount > 0 and base_cleared > 0 and realised_gain = base_amount - base_cleared));

-- The base value settled on a foreign-currency document, or used of its
-- credit, by its active payments, applications and refunds.
create function tohyee_invoice_base_settled(invoice bigint) returns numeric
language sql stable as $$
  select coalesce((select sum(base_cleared) from customer_payments where invoice_id = invoice and status = 'active'), 0)
       + coalesce((select sum(invoice_base) from sales_credit_note_applications where invoice_id = invoice and status = 'active'), 0)
       + coalesce((select sum(invoice_base) from customer_overpayment_applications where invoice_id = invoice and status = 'active'), 0)
$$;
create function tohyee_bill_base_settled(bill bigint) returns numeric
language sql stable as $$
  select coalesce((select sum(base_cleared) from supplier_payments where bill_id = bill and status = 'active'), 0)
       + coalesce((select sum(bill_base) from supplier_credit_note_applications where bill_id = bill and status = 'active'), 0)
$$;
create function tohyee_credit_note_base_used(credit_note bigint) returns numeric
language sql stable as $$
  select coalesce((select sum(credit_note_base) from sales_credit_note_applications where credit_note_id = credit_note and status = 'active'), 0)
       + coalesce((select sum(base_cleared) from sales_credit_note_refunds where credit_note_id = credit_note and status = 'active'), 0)
$$;
create function tohyee_supplier_credit_note_base_used(credit_note bigint) returns numeric
language sql stable as $$
  select coalesce((select sum(credit_note_base) from supplier_credit_note_applications where credit_note_id = credit_note and status = 'active'), 0)
       + coalesce((select sum(base_cleared) from supplier_credit_note_refunds where credit_note_id = credit_note and status = 'active'), 0)
$$;
create function tohyee_overpayment_base_used(payment bigint) returns numeric
language sql stable as $$
  select coalesce((select sum(overpayment_base) from customer_overpayment_applications where payment_id = payment and status = 'active'), 0)
       + coalesce((select sum(base_cleared) from customer_overpayment_refunds where payment_id = payment and status = 'active'), 0)
$$;

-- A payment for several foreign-currency documents (MC20-MC24) keeps its
-- rate and the base amount that moved in the bank account; its parts have
-- the same rate and their base amounts add up to it.
alter table customer_payment_batches
  add column exchange_rate numeric check (exchange_rate > 0 and scale(exchange_rate) <= 8),
  add column base_amount numeric;
alter table customer_payment_batches add constraint customer_payment_batches_base_check
  check ((exchange_rate is null) = (base_amount is null) and (base_amount is null or base_amount > 0));
alter table supplier_payment_batches
  add column exchange_rate numeric check (exchange_rate > 0 and scale(exchange_rate) <= 8),
  add column base_amount numeric;
alter table supplier_payment_batches add constraint supplier_payment_batches_base_check
  check ((exchange_rate is null) = (base_amount is null) and (base_amount is null or base_amount > 0));

create or replace function tohyee_check_payment_batch_parts() returns trigger
language plpgsql as $$
declare
  batch record;
  parts record;
begin
  if tg_table_name = 'customer_payment_batches' then
    select * into batch from customer_payment_batches where id = new.id;
    select count(*) as n, count(distinct p.invoice_id) as documents, coalesce(sum(p.amount), 0) as total,
           sum(p.base_amount) as base_total,
           bool_and(i.contact_id = batch.contact_id and p.payment_date = batch.payment_date
                    and p.bank_account_id = batch.bank_account_id and p.currency_code = batch.currency_code
                    and p.exchange_rate is not distinct from batch.exchange_rate
                    and p.journal_id = batch.journal_id and p.status = batch.status
                    and p.void_journal_id is not distinct from batch.void_journal_id) as agree
      into parts
      from customer_payments p join sales_invoices i on i.id = p.invoice_id
     where p.batch_id = new.id;
  else
    select * into batch from supplier_payment_batches where id = new.id;
    select count(*) as n, count(distinct p.bill_id) as documents, coalesce(sum(p.amount), 0) as total,
           sum(p.base_amount) as base_total,
           bool_and(b.contact_id = batch.contact_id and p.payment_date = batch.payment_date
                    and p.bank_account_id = batch.bank_account_id and p.currency_code = batch.currency_code
                    and p.exchange_rate is not distinct from batch.exchange_rate
                    and p.journal_id = batch.journal_id and p.status = batch.status
                    and p.void_journal_id is not distinct from batch.void_journal_id) as agree
      into parts
      from supplier_payments p join bills b on b.id = p.bill_id
     where p.batch_id = new.id;
  end if;
  if parts.n = 0 or parts.documents <> parts.n or parts.total <> batch.amount or not parts.agree
     or parts.base_total is distinct from batch.base_amount then
    raise exception 'A payment for several documents must be made of one part for each, adding up to the amount paid'
      using errcode = 'P0001';
  end if;
  return null;
end;
$$;

-- Quotes, repeating invoices and bills, and purchase orders are in their
-- contact's currency too (MC25-MC28; NetSuite keeps "the currency from the
-- original transaction"). They post nothing, so they have no rate. A
-- contact's currency can't change once it has any of them either.
create function tohyee_check_contact_currency() returns trigger
language plpgsql as $$
declare
  wanted text;
begin
  select coalesce(c.currency_code, s.base_currency) into wanted
    from contacts c cross join organisation_settings s where c.id = new.contact_id;
  if wanted is not null and new.currency_code <> wanted then
    raise exception 'This contact''s documents are in %, not %', wanted, new.currency_code using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger quotes_currency_check before insert or update of contact_id, currency_code on quotes
  for each row execute function tohyee_check_contact_currency();
create trigger repeating_invoices_currency_check before insert or update of contact_id, currency_code on repeating_invoices
  for each row execute function tohyee_check_contact_currency();
create trigger repeating_bills_currency_check before insert or update of contact_id, currency_code on repeating_bills
  for each row execute function tohyee_check_contact_currency();
create trigger purchase_orders_currency_check before insert or update of contact_id, currency_code on purchase_orders
  for each row execute function tohyee_check_contact_currency();

create or replace function tohyee_guard_contact_currency() returns trigger
language plpgsql as $$
begin
  if coalesce(new.currency_code, '') is distinct from coalesce(old.currency_code, '')
     and (exists (select 1 from sales_invoices where contact_id = old.id)
          or exists (select 1 from bills where contact_id = old.id)
          or exists (select 1 from sales_credit_notes where contact_id = old.id)
          or exists (select 1 from supplier_credit_notes where contact_id = old.id)
          or exists (select 1 from quotes where contact_id = old.id)
          or exists (select 1 from repeating_invoices where contact_id = old.id)
          or exists (select 1 from repeating_bills where contact_id = old.id)
          or exists (select 1 from purchase_orders where contact_id = old.id)) then
    raise exception 'Contact % has documents, so its currency can''t change', old.name
      using errcode = '23514';
  end if;
  return new;
end;
$$;
`,
  },
  {
    version: "0044",
    name: "google_sending",
    sql: `
-- Sending documents through a Gmail or Google Workspace mailbox an admin
-- signs in to (OAuth 2.0 with the organisation's own Google app, the one the
-- CRM's mail sync uses, and the Gmail API's messages.send with the
-- gmail.send scope), alongside SMTP and Microsoft. Tokens are encrypted with
-- TOHYEE_SECRET_KEY and never sent to the browser. The other methods' details
-- stay saved while Google is chosen.
alter table organisation_email_settings drop constraint organisation_email_settings_sending_method_check;
alter table organisation_email_settings add constraint organisation_email_settings_sending_method_check
  check (sending_method in ('smtp', 'microsoft', 'google'));
alter table organisation_email_settings
  add column google_email text check (google_email is null or length(google_email) between 3 and 254),
  add column google_refresh_token_ciphertext text,
  add column google_access_token_ciphertext text,
  add column google_access_token_expires_at timestamptz,
  add column google_connected_by_email text,
  add column google_connected_at timestamptz;
alter table organisation_email_settings add constraint organisation_email_settings_google_complete check (
  (google_email is null) = (google_refresh_token_ciphertext is null)
  and (google_email is null) = (google_connected_at is null));
alter table organisation_email_settings drop constraint organisation_email_settings_method_ready;
alter table organisation_email_settings add constraint organisation_email_settings_method_ready check (
  (sending_method = 'smtp' and smtp_host is not null) or (sending_method = 'microsoft' and microsoft_email is not null)
  or (sending_method = 'google' and google_email is not null));

-- Which provider each one-time sign-in state was made for, so a state from
-- one sign-in can't be finished at the other's callback.
alter table email_oauth_states add column provider text not null default 'microsoft' check (provider in ('microsoft', 'google'));

-- How each email went: through SMTP, Microsoft Graph or the Gmail API.
alter table document_emails drop constraint document_emails_sent_via_check;
alter table document_emails add constraint document_emails_sent_via_check check (sent_via in ('smtp', 'microsoft', 'google'));
`,
  },
  {
    version: "0045",
    name: "fx_rounding_and_document_revaluation",
    sql: `
-- Following NetSuite (examples MC31-MC45): the cent or two left by rounding
-- when a payment or credit settles a foreign-currency document goes to a
-- Rounding Gain/Loss account of its own, apart from the realised gain or
-- loss ((payment rate - document rate) x amount, rounded to cents); and open
-- invoices, bills, credit notes and overpayments are revalued one by one.

-- The rounding account: 7050 in the starting chart; existing organisations
-- get it here, at 7050 or the next free code after it.
insert into accounts (code, name, account_class, account_type, system_key)
select (select min(c)::text from generate_series(7050, 7999) c where not exists (select 1 from accounts where lower(code) = c::text)),
       'Rounding gains and losses', 'revenue', 'other_income', 'fx_rounding'
 where exists (select 1 from accounts)
   and not exists (select 1 from accounts where system_key = 'fx_rounding')
   and exists (select 1 from generate_series(7050, 7999) c where not exists (select 1 from accounts where lower(code) = c::text));

-- Each settlement keeps its realised gain (on 7020) and its rounding (on
-- 7050) apart; together they're the difference, as before. Settlements from
-- before have no rounding (null): all of it went to 7020.
alter table customer_payments add column rounding_gain numeric;
alter table customer_payments drop constraint customer_payments_base_check;
alter table customer_payments add constraint customer_payments_base_check check (
  (exchange_rate is null and base_amount is null and base_cleared is null and realised_gain is null and base_overpayment is null
   and rounding_gain is null)
  or (exchange_rate is not null and base_amount > 0 and base_cleared >= 0 and coalesce(base_overpayment, 0) >= 0
      and realised_gain + coalesce(rounding_gain, 0) = base_amount - coalesce(base_overpayment, 0) - base_cleared
      and (overpayment_amount <> 0 or coalesce(base_overpayment, 0) = 0)
      and (amount <> overpayment_amount or base_cleared = 0)));
alter table supplier_payments add column rounding_gain numeric;
alter table supplier_payments drop constraint supplier_payments_base_check;
alter table supplier_payments add constraint supplier_payments_base_check check (
  (exchange_rate is null and base_amount is null and base_cleared is null and realised_gain is null and rounding_gain is null)
  or (exchange_rate is not null and base_amount > 0 and base_cleared > 0
      and realised_gain + coalesce(rounding_gain, 0) = base_cleared - base_amount));
alter table sales_credit_note_applications add column rounding_gain numeric;
alter table sales_credit_note_applications drop constraint sales_credit_note_applications_base_check;
alter table sales_credit_note_applications add constraint sales_credit_note_applications_base_check check (
  (invoice_base is null and credit_note_base is null and realised_gain is null and journal_id is null and rounding_gain is null)
  or (invoice_base > 0 and credit_note_base > 0 and realised_gain + coalesce(rounding_gain, 0) = credit_note_base - invoice_base
      and (journal_id is null) = (realised_gain = 0 and coalesce(rounding_gain, 0) = 0)));
alter table supplier_credit_note_applications add column rounding_gain numeric;
alter table supplier_credit_note_applications drop constraint supplier_credit_note_applications_base_check;
alter table supplier_credit_note_applications add constraint supplier_credit_note_applications_base_check check (
  (bill_base is null and credit_note_base is null and realised_gain is null and journal_id is null and rounding_gain is null)
  or (bill_base > 0 and credit_note_base > 0 and realised_gain + coalesce(rounding_gain, 0) = bill_base - credit_note_base
      and (journal_id is null) = (realised_gain = 0 and coalesce(rounding_gain, 0) = 0)));
alter table customer_overpayment_applications add column rounding_gain numeric;
alter table customer_overpayment_applications drop constraint customer_overpayment_applications_base_check;
alter table customer_overpayment_applications add constraint customer_overpayment_applications_base_check check (
  (invoice_base is null and overpayment_base is null and realised_gain is null and journal_id is null and rounding_gain is null)
  or (invoice_base > 0 and overpayment_base > 0 and realised_gain + coalesce(rounding_gain, 0) = overpayment_base - invoice_base
      and (journal_id is null) = (realised_gain = 0 and coalesce(rounding_gain, 0) = 0)));
alter table customer_overpayment_refunds add column rounding_gain numeric;
alter table customer_overpayment_refunds drop constraint customer_overpayment_refunds_base_check;
alter table customer_overpayment_refunds add constraint customer_overpayment_refunds_base_check check (
  (exchange_rate is null and base_amount is null and base_cleared is null and realised_gain is null and rounding_gain is null)
  or (exchange_rate is not null and base_amount > 0 and base_cleared > 0
      and realised_gain + coalesce(rounding_gain, 0) = base_cleared - base_amount));
alter table sales_credit_note_refunds add column rounding_gain numeric;
alter table sales_credit_note_refunds drop constraint sales_credit_note_refunds_base_check;
alter table sales_credit_note_refunds add constraint sales_credit_note_refunds_base_check check (
  (exchange_rate is null and base_amount is null and base_cleared is null and realised_gain is null and rounding_gain is null)
  or (exchange_rate is not null and base_amount > 0 and base_cleared > 0
      and realised_gain + coalesce(rounding_gain, 0) = base_cleared - base_amount));
alter table supplier_credit_note_refunds add column rounding_gain numeric;
alter table supplier_credit_note_refunds drop constraint supplier_credit_note_refunds_base_check;
alter table supplier_credit_note_refunds add constraint supplier_credit_note_refunds_base_check check (
  (exchange_rate is null and base_amount is null and base_cleared is null and realised_gain is null and rounding_gain is null)
  or (exchange_rate is not null and base_amount > 0 and base_cleared > 0
      and realised_gain + coalesce(rounding_gain, 0) = base_amount - base_cleared));

-- A revaluation of accounts receivable or payable in one currency lists each
-- open document it revalued (NetSuite's Open Receivables and Open
-- Payables): its open foreign amount and base value in the account's normal
-- direction (credit notes and overpayments are negative), its own rate, and
-- its unrealised amount = (closing rate - its rate) x open foreign amount,
-- rounded once. The account and currency's item is their total.
create table ledger_fx_revaluation_documents (
  id bigserial primary key,
  run_id bigint not null references ledger_fx_revaluation_runs(id),
  item_line_order integer not null,
  line_order integer not null,
  document_kind text not null
    check (document_kind in ('invoice', 'credit_note', 'overpayment', 'bill', 'supplier_credit_note')),
  document_id bigint not null,
  document_number text,
  document_date date not null,
  currency_code text not null,
  foreign_amount numeric not null check (foreign_amount <> 0),
  carrying_amount numeric not null,
  document_rate numeric not null check (document_rate > 0),
  closing_rate numeric not null check (closing_rate > 0),
  delta_amount numeric not null,
  unique (run_id, line_order),
  unique (run_id, document_kind, document_id),
  foreign key (run_id, item_line_order) references ledger_fx_revaluation_run_items (run_id, line_order),
  check (delta_amount = round((closing_rate - document_rate) * foreign_amount, scale(delta_amount)))
);
create trigger ledger_fx_revaluation_documents_append_only
  before update or delete on ledger_fx_revaluation_documents
  for each row execute function toeyee_forbid_mutation();
create trigger ledger_fx_revaluation_documents_no_truncate
  before truncate on ledger_fx_revaluation_documents
  for each statement execute function toeyee_forbid_mutation();
`,
  },
  {
    version: "0046",
    name: "currency_exchange_rates",
    sql: `
-- The currency exchange rates list (examples MC46-MC53), like NetSuite's
-- Currency Exchange Rates: rates for each foreign currency, each with the
-- date it takes effect, in the base currency per 1 unit (the direction of
-- every other exchange_rate column). A new foreign-currency document takes
-- the latest entry effective on or before its date. Entries are never
-- changed or deleted: a correction is a newer entry, or archiving the wrong
-- one. One command (a single rate or a pasted list) shares an idempotency
-- key, one row per line.
create table currency_exchange_rates (
  id bigserial primary key,
  command_source text not null,
  idempotency_key text not null,
  line_number integer not null check (line_number between 1 and 500),
  request_hash text not null,
  currency_code text not null check (currency_code ~ '^[A-Z]{3}$'),
  effective_date date not null,
  rate numeric not null check (rate > 0 and scale(rate) <= 8),
  note text check (note is null or length(note) between 1 and 200),
  created_by_user_id uuid,
  created_by_email text,
  created_at timestamptz not null default now(),
  archived_at timestamptz,
  archived_by_user_id uuid,
  archived_by_email text,
  unique (command_source, idempotency_key, line_number),
  check (archived_at is not null or (archived_by_user_id is null and archived_by_email is null))
);
create index currency_exchange_rates_lookup_idx
  on currency_exchange_rates (currency_code, effective_date desc, created_at desc, id desc) where archived_at is null;

create function tohyee_guard_currency_exchange_rate() returns trigger
language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    if new.currency_code = (select base_currency from organisation_settings where id = true) then
      raise exception 'Exchange rates are for foreign currencies, not %', new.currency_code using errcode = '23514';
    end if;
    if new.archived_at is not null then
      raise exception 'A new exchange rate can''t be archived already' using errcode = '23514';
    end if;
    return new;
  end if;
  if tg_op = 'UPDATE' then
    -- Archiving is the only change: once, and nothing else about the entry.
    if old.archived_at is null and new.archived_at is not null
       and (new.id, new.command_source, new.idempotency_key, new.line_number, new.request_hash, new.currency_code,
            new.effective_date, new.rate, new.note, new.created_by_user_id, new.created_by_email, new.created_at)
           is not distinct from
           (old.id, old.command_source, old.idempotency_key, old.line_number, old.request_hash, old.currency_code,
            old.effective_date, old.rate, old.note, old.created_by_user_id, old.created_by_email, old.created_at) then
      return new;
    end if;
    raise exception 'Exchange rates can''t be changed; add a newer entry or archive this one' using errcode = 'P0001';
  end if;
  raise exception 'Exchange rates can''t be deleted; archive them instead' using errcode = 'P0001';
end;
$$;
create trigger currency_exchange_rates_guard before insert or update or delete on currency_exchange_rates
  for each row execute function tohyee_guard_currency_exchange_rate();
create trigger currency_exchange_rates_no_truncate before truncate on currency_exchange_rates
  for each statement execute function tohyee_guard_currency_exchange_rate();
`,
  },
  {
    version: "0047",
    name: "foreign_currency_projects_crm",
    sql: `
-- Projects and CRM opportunities in a customer's currency (MC61-MC70),
-- following NetSuite: "Projects and their associated transactions must share
-- a single currency", and a new transaction starts in the customer's
-- currency. A project's rates, fixed prices and estimate are in its currency,
-- and so are an opportunity's amount. Existing ones take their customer's
-- currency (the base currency for customers without one).
alter table projects disable trigger projects_guard;
alter table projects add column currency_code text;
update projects p
   set currency_code = coalesce(c.currency_code, (select base_currency from organisation_settings limit 1), 'NZD')
  from contacts c where c.id = p.contact_id;
alter table projects enable trigger projects_guard;
alter table projects alter column currency_code set not null;
alter table projects add constraint projects_currency_code_check check (currency_code ~ '^[A-Z]{3}$');

alter table crm_opportunities add column currency_code text;
update crm_opportunities o
   set currency_code = coalesce(c.currency_code, (select base_currency from organisation_settings limit 1), 'NZD')
  from contacts c where c.id = o.contact_id;
alter table crm_opportunities alter column currency_code set not null;
alter table crm_opportunities add constraint crm_opportunities_currency_code_check check (currency_code ~ '^[A-Z]{3}$');

-- They're in their contact's currency (the same check as quotes, 0043).
create trigger projects_currency_check before insert or update of contact_id, currency_code on projects
  for each row execute function tohyee_check_contact_currency();
create trigger crm_opportunities_currency_check before insert or update of contact_id, currency_code on crm_opportunities
  for each row execute function tohyee_check_contact_currency();

-- A project's currency doesn't change once it has tasks, time, expenses or
-- invoices (their amounts are in it); an opportunity's once it has made its
-- invoice.
create function tohyee_guard_project_currency() returns trigger
language plpgsql as $$
begin
  if new.currency_code <> old.currency_code
     and (exists (select 1 from project_tasks where project_id = old.id)
          or exists (select 1 from project_time_entries where project_id = old.id)
          or exists (select 1 from project_expenses where project_id = old.id)
          or exists (select 1 from project_invoices where project_id = old.id)) then
    raise exception 'Project % has tasks, time, expenses or invoices in %, so its currency can''t change', old.name, old.currency_code
      using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger projects_currency_guard before update of currency_code on projects
  for each row execute function tohyee_guard_project_currency();

create function tohyee_guard_opportunity_currency() returns trigger
language plpgsql as $$
begin
  if old.invoice_id is not null and (new.currency_code <> old.currency_code or new.contact_id <> old.contact_id) then
    raise exception 'Opportunity % has made an invoice, so its company and currency can''t change', old.name
      using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger crm_opportunities_currency_guard before update of contact_id, currency_code on crm_opportunities
  for each row execute function tohyee_guard_opportunity_currency();

-- A contact's currency can't change once it has projects or opportunities
-- either (their estimates, rates and amounts are in it). A trigger of its
-- own, beside contacts_currency_guard.
create function tohyee_guard_contact_currency_projects() returns trigger
language plpgsql as $$
begin
  if coalesce(new.currency_code, '') is distinct from coalesce(old.currency_code, '')
     and (exists (select 1 from projects where contact_id = old.id)
          or exists (select 1 from crm_opportunities where contact_id = old.id)) then
    raise exception 'Contact % has projects or opportunities, so its currency can''t change', old.name
      using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger contacts_currency_projects_guard
  before update of currency_code on contacts
  for each row execute function tohyee_guard_contact_currency_projects();

-- Charging an expense on a project in another currency isn't settled (its
-- cost is in the base currency, and which rate converts it isn't), so a
-- foreign-currency project's expenses are costs only (MC63).
create function tohyee_check_project_expense_currency() returns trigger
language plpgsql as $$
begin
  if new.chargeable and new.status = 'active'
     and (select p.currency_code from projects p where p.id = new.project_id)
         <> (select base_currency from organisation_settings limit 1) then
    raise exception 'Expenses on a project in another currency can''t be chargeable yet' using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger project_expenses_currency_check before insert or update of chargeable, status on project_expenses
  for each row execute function tohyee_check_project_expense_currency();
`,
  },
  {
    version: "0048",
    name: "exports_tax_code",
    sql: `
-- Exports and the tax code for overseas customers (EX1-EX15), following
-- NetSuite: a "Foreign Trade" box and a "Tax Code for Exports" per
-- organisation, and a customer's own tax code. Contacts get a country for
-- their billing address and (optionally) their delivery address, as ISO
-- 3166-1 alpha-2 codes; the addresses themselves stay free text. Existing
-- contacts are in New Zealand, and existing organisations have Foreign trade
-- off with ZERO as the tax code for exports (EX1).
alter table contacts add column billing_country text not null default 'NZ'
  check (billing_country ~ '^[A-Z]{2}$');
alter table contacts add column delivery_country text
  check (delivery_country ~ '^[A-Z]{2}$');
alter table contacts add column default_sales_tax_code_id bigint references tax_codes(id);

alter table organisation_settings add column foreign_trade boolean not null default false;
alter table organisation_settings add column export_tax_code_id bigint references tax_codes(id);
update organisation_settings
   set export_tax_code_id = (select id from tax_codes where code = 'ZERO' and category = 'zero_rated');

-- The tax code for exports is zero-rated (IR375: exports are zero-rated, not
-- exempt), so the sale is in Box 5 and Box 6 (EX11, EX13).
create function tohyee_check_export_tax_code() returns trigger
language plpgsql as $$
begin
  if new.export_tax_code_id is not null
     and (select category from tax_codes where id = new.export_tax_code_id) <> 'zero_rated' then
    raise exception 'The tax code for exports must be zero-rated' using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger organisation_settings_export_tax_code_check
  before insert or update of export_tax_code_id on organisation_settings
  for each row execute function tohyee_check_export_tax_code();
`,
  },
  {
    version: "0049",
    name: "contact_purchase_tax_code",
    sql: `
-- A contact's own default purchase tax code (EX16-EX25), like Xero's contact
-- "Purchase defaults" tax rate and the default sales tax code (EX5). New
-- purchase lines start with it; saved documents never change. Existing
-- contacts have none, so nothing changes for them (EX16).
alter table contacts add column default_purchase_tax_code_id bigint references tax_codes(id);
`,
  },
  {
    version: "0050",
    name: "tax_code_available_on",
    sql: `
-- A tax code's "Available on" (TAO1-TAO12), following NetSuite: Sales,
-- Purchases or Both. Every existing code is Both, so nothing changes for
-- existing organisations (TAO1). Document lines are checked when they're
-- saved or approved (like a code being active); saved documents are never
-- checked again. Here the database keeps the settings that choose a code
-- for one side on codes available on that side.
alter table tax_codes add column available_on text not null default 'both'
  check (available_on in ('sales', 'purchases', 'both'));

create function tohyee_tax_code_available(code_id bigint, side text) returns boolean
language sql stable as $$
  select code_id is null or exists (select 1 from tax_codes where id = code_id and available_on in (side, 'both'))
$$;

-- The tax code for exports is zero-rated (EX13) and available on sales (TAO7).
create or replace function tohyee_check_export_tax_code() returns trigger
language plpgsql as $$
begin
  if new.export_tax_code_id is not null
     and (select category from tax_codes where id = new.export_tax_code_id) <> 'zero_rated' then
    raise exception 'The tax code for exports must be zero-rated' using errcode = '23514';
  end if;
  if not tohyee_tax_code_available(new.export_tax_code_id, 'sales') then
    raise exception 'The tax code for exports must be available on sales' using errcode = '23514';
  end if;
  return new;
end;
$$;

-- A contact's default sales tax code is available on sales, its default
-- purchase tax code on purchases (TAO7); only checked when it's set.
create function tohyee_check_contact_tax_defaults() returns trigger
language plpgsql as $$
begin
  if (tg_op = 'INSERT' or new.default_sales_tax_code_id is distinct from old.default_sales_tax_code_id)
     and not tohyee_tax_code_available(new.default_sales_tax_code_id, 'sales') then
    raise exception 'A contact''s default sales tax code must be available on sales' using errcode = '23514';
  end if;
  if (tg_op = 'INSERT' or new.default_purchase_tax_code_id is distinct from old.default_purchase_tax_code_id)
     and not tohyee_tax_code_available(new.default_purchase_tax_code_id, 'purchases') then
    raise exception 'A contact''s default purchase tax code must be available on purchases' using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger contacts_tax_defaults_check
  before insert or update of default_sales_tax_code_id, default_purchase_tax_code_id on contacts
  for each row execute function tohyee_check_contact_tax_defaults();

-- An item's sales tax code likewise, and its purchase tax code (TAO7).
create function tohyee_check_item_tax_codes() returns trigger
language plpgsql as $$
begin
  if (tg_op = 'INSERT' or new.sales_tax_code_id is distinct from old.sales_tax_code_id)
     and not tohyee_tax_code_available(new.sales_tax_code_id, 'sales') then
    raise exception 'An item''s sales tax code must be available on sales' using errcode = '23514';
  end if;
  if (tg_op = 'INSERT' or new.purchase_tax_code_id is distinct from old.purchase_tax_code_id)
     and not tohyee_tax_code_available(new.purchase_tax_code_id, 'purchases') then
    raise exception 'An item''s purchase tax code must be available on purchases' using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger items_tax_codes_check
  before insert or update of sales_tax_code_id, purchase_tax_code_id on items
  for each row execute function tohyee_check_item_tax_codes();

-- A bank rule for money in suggests receive money (sales), for money out
-- spend money (purchases), and for either both (TAO8).
create function tohyee_check_bank_rule_tax_code() returns trigger
language plpgsql as $$
begin
  if (new.direction in ('in', 'any') and not tohyee_tax_code_available(new.tax_code_id, 'sales'))
     or (new.direction in ('out', 'any') and not tohyee_tax_code_available(new.tax_code_id, 'purchases')) then
    raise exception 'A bank rule''s tax code must be available on the side it codes (money in: sales; out: purchases; either: both)'
      using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger bank_rules_tax_code_check
  before insert or update of tax_code_id, direction on bank_rules
  for each row execute function tohyee_check_bank_rule_tax_code();

-- Changing a code's "Available on" is refused while a setting above uses it
-- on the side it would lose (TAO10). Tohyee lists them; this is the backstop.
create function tohyee_guard_tax_code_available_on() returns trigger
language plpgsql as $$
begin
  if new.available_on = old.available_on or new.available_on = 'both' then
    return new;
  end if;
  if new.available_on = 'purchases' and (
       exists (select 1 from contacts where default_sales_tax_code_id = old.id)
       or exists (select 1 from organisation_settings where export_tax_code_id = old.id)
       or exists (select 1 from items where sales_tax_code_id = old.id)
       or exists (select 1 from bank_rules where tax_code_id = old.id and direction in ('in', 'any'))) then
    raise exception 'Tax code % is used for sales, so it can''t be made available on purchases only', old.code
      using errcode = '23514';
  end if;
  if new.available_on = 'sales' and (
       exists (select 1 from contacts where default_purchase_tax_code_id = old.id)
       or exists (select 1 from items where purchase_tax_code_id = old.id)
       or exists (select 1 from bank_rules where tax_code_id = old.id and direction in ('out', 'any'))) then
    raise exception 'Tax code % is used for purchases, so it can''t be made available on sales only', old.code
      using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger tax_codes_available_on_guard
  before update of available_on on tax_codes
  for each row execute function tohyee_guard_tax_code_available_on();
`,
  },
  {
    version: "0051",
    name: "payroll_employees",
    sql: `
create table payroll_employees (
  id uuid primary key default gen_random_uuid(),
  idempotency_key text not null unique,
  request_hash text not null,
  first_name text not null check (length(btrim(first_name)) between 1 and 100),
  last_name text not null check (length(btrim(last_name)) between 1 and 100),
  email text check (email is null or length(email) <= 320),
  phone text check (phone is null or length(phone) <= 50),
  postal_address text check (postal_address is null or length(postal_address) <= 1000),
  date_of_birth date,
  tax_code text not null check (tax_code ~ '^[A-Z0-9]+( [A-Z0-9]+)*$' and length(tax_code) <= 20),
  ird_number_ciphertext text not null,
  kiwisaver_status text not null
    check (kiwisaver_status in ('enrolled', 'not_enrolled', 'opted_out', 'savings_suspension', 'not_eligible')),
  kiwisaver_employee_rate numeric(5,2) not null
    check (kiwisaver_employee_rate between 0 and 100),
  kiwisaver_employer_rate numeric(5,2) not null
    check (kiwisaver_employer_rate between 0 and 100),
  student_loan boolean not null,
  pay_frequency text not null
    check (pay_frequency in ('weekly', 'fortnightly', 'four_weekly', 'monthly')),
  pay_basis text not null check (pay_basis in ('salary', 'hourly')),
  annual_salary numeric(16,2),
  hourly_rate numeric(16,2),
  ordinary_hours_per_week numeric(7,2),
  start_date date not null,
  finish_date date,
  bank_account_ciphertext text,
  is_archived boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (finish_date is null or finish_date >= start_date),
  check (
    (pay_basis = 'salary' and annual_salary > 0 and hourly_rate is null and ordinary_hours_per_week is null)
    or (pay_basis = 'hourly' and annual_salary is null and hourly_rate > 0 and ordinary_hours_per_week > 0)
  )
);

create index payroll_employees_active_name
  on payroll_employees (lower(last_name), lower(first_name))
  where not is_archived;

create function tohyee_payroll_employee_forbid_delete() returns trigger
language plpgsql as $$
begin
  raise exception 'Payroll employee records can''t be deleted or truncated; archive the employee instead' using errcode = 'P0001';
end;
$$;
create trigger payroll_employees_no_delete
  before delete on payroll_employees
  for each row execute function tohyee_payroll_employee_forbid_delete();
create trigger payroll_employees_no_truncate
  before truncate on payroll_employees
  for each statement execute function tohyee_payroll_employee_forbid_delete();
`,
  },
  {
    version: "0052",
    name: "not_for_profit_module",
    sql: `
alter table organisation_settings
  add column not_for_profit_enabled boolean not null default false;
`,
  },
  {
    version: "0053",
    name: "crm_custom_fields",
    sql: `
-- Custom fields on CRM records (CRMF1-CRMF9): people and opportunities get
-- their own kinds of field, contact fields can be used on prospects, and
-- fields can be grouped into named, ordered sections. Values never change an
-- amount, account, tag, stage or GST box.
alter table custom_fields drop constraint custom_fields_record_check;
alter table custom_fields add constraint custom_fields_record_check
  check (record in ('contact', 'document', 'line', 'person', 'opportunity'));
do $$
declare
  con_name text;
begin
  for con_name in
    select conname from pg_constraint
     where conrelid = 'custom_fields'::regclass and contype = 'c' and pg_get_constraintdef(oid) ilike '%used_on <@%'
  loop
    execute format('alter table custom_fields drop constraint %I', con_name);
  end loop;
end;
$$;
alter table custom_fields add constraint custom_fields_used_on_kind_check check (
  (record = 'contact' and used_on <@ array['customer', 'supplier', 'prospect'])
  or (record in ('document', 'line') and used_on <@ array['invoice', 'bill', 'credit_note', 'supplier_credit_note', 'spend', 'receive', 'journal'])
  or (record = 'person' and used_on <@ array['person'])
  or (record = 'opportunity' and used_on <@ array['opportunity'])
);

-- Existing contact fields stay where they are: prospects only get the fields
-- an admin turns on for them (CRMF3, CRMF11).

create table custom_field_sections (
  id bigserial primary key,
  record text not null check (record in ('contact', 'document', 'person', 'opportunity')),
  name text not null check (length(name) between 1 and 60),
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index custom_field_sections_name_idx on custom_field_sections (record, lower(name));
create trigger custom_field_sections_no_truncate before truncate on custom_field_sections
  for each statement execute function tohyee_guard_custom_field();

alter table custom_fields add column section_id bigint references custom_field_sections(id);
create index custom_fields_section_idx on custom_fields (section_id) where section_id is not null;

-- A field can only be in a section for its own kind of record, and a
-- section's kind never changes.
create function tohyee_check_custom_field_section() returns trigger
language plpgsql as $$
begin
  if tg_table_name = 'custom_field_sections' then
    if new.record <> old.record then
      raise exception 'A custom field section''s kind of record can''t change' using errcode = 'P0001';
    end if;
  elsif new.section_id is not null
        and not exists (select 1 from custom_field_sections s where s.id = new.section_id and s.record = new.record) then
    raise exception 'A custom field can only be in a section for its own kind of record' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger custom_fields_section_check before insert or update of section_id, record on custom_fields
  for each row execute function tohyee_check_custom_field_section();
create trigger custom_field_sections_guard before update of record on custom_field_sections
  for each row execute function tohyee_check_custom_field_section();

alter table crm_people add column custom_fields jsonb not null default '{}'::jsonb;
alter table crm_opportunities add column custom_fields jsonb not null default '{}'::jsonb;
create trigger crm_people_custom_fields before insert or update on crm_people
  for each row when (new.custom_fields <> '{}'::jsonb) execute function tohyee_check_custom_values('person');
create trigger crm_opportunities_custom_fields before insert or update on crm_opportunities
  for each row when (new.custom_fields <> '{}'::jsonb) execute function tohyee_check_custom_values('opportunity');
`,
  },
  {
    version: "0057",
    name: "payroll_allocation_rates_access",
    sql: `
-- Payroll stage P1b (examples PE3-PE12): payroll access, pay groups and
-- employee groups, job details, pay rate history and cost allocations.
-- Nothing here posts to the ledger.

-- Payroll access (PE9-PE12): a permission an admin gives named members, kept
-- against their core user id. Grants and removals are in audit_events.
-- payroll_access_started_at records that the first owner was given it, so
-- it's only done once (PE9).
alter table organisation_settings add column payroll_access_started_at timestamptz;

create table payroll_access (
  user_id uuid primary key,
  granted_at timestamptz not null default now(),
  granted_by_user_id uuid,
  granted_by_email text not null check (length(granted_by_email) between 1 and 320)
);

-- Rows that are kept for ever: archived, never deleted (TG_ARGV[0] is the message).
create function tohyee_payroll_forbid_delete() returns trigger
language plpgsql as $$
begin
  raise exception '%', tg_argv[0] using errcode = 'P0001';
end;
$$;

-- Pay groups (e.g. "Weekly wages", each with a pay frequency) and employee
-- groups for reporting (PE8).
create table payroll_pay_groups (
  id uuid primary key default gen_random_uuid(),
  idempotency_key text not null unique,
  request_hash text not null,
  name text not null check (length(btrim(name)) between 1 and 100),
  pay_frequency text not null
    check (pay_frequency in ('weekly', 'fortnightly', 'four_weekly', 'monthly')),
  is_archived boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index payroll_pay_groups_name_idx on payroll_pay_groups (lower(name));
create trigger payroll_pay_groups_no_delete
  before delete on payroll_pay_groups
  for each row execute function tohyee_payroll_forbid_delete('Pay groups can''t be deleted; archive them instead');
create trigger payroll_pay_groups_no_truncate
  before truncate on payroll_pay_groups
  for each statement execute function tohyee_payroll_forbid_delete('Pay groups can''t be deleted; archive them instead');

create table payroll_employee_groups (
  id uuid primary key default gen_random_uuid(),
  idempotency_key text not null unique,
  request_hash text not null,
  name text not null check (length(btrim(name)) between 1 and 100),
  is_archived boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index payroll_employee_groups_name_idx on payroll_employee_groups (lower(name));
create trigger payroll_employee_groups_no_delete
  before delete on payroll_employee_groups
  for each row execute function tohyee_payroll_forbid_delete('Employee groups can''t be deleted; archive them instead');
create trigger payroll_employee_groups_no_truncate
  before truncate on payroll_employee_groups
  for each statement execute function tohyee_payroll_forbid_delete('Employee groups can''t be deleted; archive them instead');

-- Job details (PE8).
alter table payroll_employees
  add column job_title text check (job_title is null or length(btrim(job_title)) between 1 and 100),
  add column reports_to_id uuid references payroll_employees(id),
  add column pay_group_id uuid references payroll_pay_groups(id),
  add column employee_group_id uuid references payroll_employee_groups(id),
  add constraint payroll_employees_not_own_manager check (reports_to_id is null or reports_to_id <> id);
create index payroll_employees_pay_group_idx on payroll_employees (pay_group_id) where pay_group_id is not null;

-- An employee in a pay group is paid at the group's frequency, and a group's
-- frequency can't change while employees are in it (PE8).
create function tohyee_check_payroll_pay_group() returns trigger
language plpgsql as $$
declare
  group_frequency text;
begin
  if tg_table_name = 'payroll_employees' then
    if new.pay_group_id is not null then
      select pay_frequency into group_frequency from payroll_pay_groups where id = new.pay_group_id for share;
      if group_frequency is distinct from new.pay_frequency then
        raise exception 'An employee''s pay frequency must match their pay group''s' using errcode = 'P0001';
      end if;
    end if;
  elsif new.pay_frequency <> old.pay_frequency
        and exists (select 1 from payroll_employees where pay_group_id = new.id) then
    raise exception 'A pay group''s frequency can''t change while employees are in it' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger payroll_employees_pay_group
  before insert or update of pay_group_id, pay_frequency on payroll_employees
  for each row execute function tohyee_check_payroll_pay_group();
create trigger payroll_pay_groups_frequency
  before update of pay_frequency on payroll_pay_groups
  for each row execute function tohyee_check_payroll_pay_group();

-- Rows that are history: added, never changed or deleted.
create function tohyee_payroll_append_only() returns trigger
language plpgsql as $$
begin
  raise exception '% can''t be changed or deleted; save a new one instead', tg_argv[0] using errcode = 'P0001';
end;
$$;

-- Pay rate history (PE7). The rate in effect on a date is the one with the
-- latest effective_from on or before it; for the same date, the latest
-- entry_number (a correction).
create table payroll_pay_rates (
  id uuid primary key default gen_random_uuid(),
  entry_number bigserial not null unique,
  employee_id uuid not null references payroll_employees(id),
  effective_from date not null,
  pay_basis text not null check (pay_basis in ('salary', 'hourly')),
  annual_salary numeric(16,2),
  hourly_rate numeric(16,2),
  ordinary_hours_per_week numeric(7,2),
  reason text check (reason is null or length(btrim(reason)) between 1 and 200),
  idempotency_key text not null unique,
  request_hash text not null,
  created_by_user_id uuid,
  created_by_email text not null,
  created_at timestamptz not null default now(),
  check (
    (pay_basis = 'salary' and annual_salary > 0 and hourly_rate is null and ordinary_hours_per_week is null)
    or (pay_basis = 'hourly' and annual_salary is null and hourly_rate > 0 and ordinary_hours_per_week > 0)
  )
);
create index payroll_pay_rates_effective_idx on payroll_pay_rates (employee_id, effective_from, entry_number);
create trigger payroll_pay_rates_append_only
  before update or delete on payroll_pay_rates
  for each row execute function tohyee_payroll_append_only('Pay rates');
create trigger payroll_pay_rates_no_truncate
  before truncate on payroll_pay_rates
  for each statement execute function tohyee_payroll_append_only('Pay rates');

-- Every existing employee's pay becomes their first rate, from their start
-- date. From now on payroll_employees.pay_basis, annual_salary, hourly_rate
-- and ordinary_hours_per_week keep the pay the employee started on; the rate
-- history is where pay is read from.
insert into payroll_pay_rates (
  employee_id, effective_from, pay_basis, annual_salary, hourly_rate, ordinary_hours_per_week,
  reason, idempotency_key, request_hash, created_by_email
)
select id, start_date, pay_basis, annual_salary, hourly_rate, ordinary_hours_per_week,
       'Starting pay', 'starting-pay:' || id::text, 'migration-0057', 'system'
  from payroll_employees
 order by created_at, id;

-- Cost allocations (PE3-PE6): where an employee's pay is charged, split by %
-- across Department, Class and Location values, a project and (from the RDTI
-- register, a later stage) an R&D activity. Lines total exactly 100.00%,
-- checked at commit.
create table payroll_cost_allocations (
  id uuid primary key default gen_random_uuid(),
  entry_number bigserial not null unique,
  employee_id uuid not null references payroll_employees(id),
  effective_from date not null,
  idempotency_key text not null unique,
  request_hash text not null,
  created_by_user_id uuid,
  created_by_email text not null,
  created_at timestamptz not null default now()
);
create index payroll_cost_allocations_effective_idx on payroll_cost_allocations (employee_id, effective_from, entry_number);

create table payroll_cost_allocation_lines (
  allocation_id uuid not null references payroll_cost_allocations(id),
  line_number integer not null check (line_number between 1 and 100),
  percentage numeric(5,2) not null check (percentage > 0 and percentage <= 100),
  department_id bigint references tracking_values(id),
  class_id bigint references tracking_values(id),
  location_id bigint references tracking_values(id),
  project_id bigint references projects(id),
  -- The R&D activity register is a later stage (R2); no foreign key yet.
  rd_activity_id uuid,
  primary key (allocation_id, line_number)
);
create unique index payroll_cost_allocation_lines_distinct_idx on payroll_cost_allocation_lines (
  allocation_id, coalesce(department_id, 0), coalesce(class_id, 0), coalesce(location_id, 0),
  coalesce(project_id, 0), coalesce(rd_activity_id, '00000000-0000-0000-0000-000000000000'::uuid)
);

create function tohyee_check_payroll_allocation_line() returns trigger
language plpgsql as $$
begin
  if new.department_id is not null and not exists (
    select 1 from tracking_values v join tracking_categories c on c.id = v.category_id
     where v.id = new.department_id and c.kind = 'department'
  ) then
    raise exception 'An allocation line''s department must be a Department value' using errcode = 'P0001';
  end if;
  if new.class_id is not null and not exists (
    select 1 from tracking_values v join tracking_categories c on c.id = v.category_id
     where v.id = new.class_id and c.kind = 'class'
  ) then
    raise exception 'An allocation line''s class must be a Class value' using errcode = 'P0001';
  end if;
  if new.location_id is not null and not exists (
    select 1 from tracking_values v join tracking_categories c on c.id = v.category_id
     where v.id = new.location_id and c.kind = 'location'
  ) then
    raise exception 'An allocation line''s location must be a Location value' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger payroll_cost_allocation_lines_tracking
  before insert on payroll_cost_allocation_lines
  for each row execute function tohyee_check_payroll_allocation_line();

create function tohyee_assert_payroll_allocation_total(target uuid) returns void
language plpgsql as $$
declare
  total numeric;
begin
  select coalesce(sum(percentage), 0) into total from payroll_cost_allocation_lines where allocation_id = target;
  if total <> 100 then
    raise exception 'A cost allocation''s lines must total exactly 100.00%% (these total %)', to_char(total, 'FM990.00') || '%'
      using errcode = '23514';
  end if;
end;
$$;
create function tohyee_check_payroll_allocation() returns trigger
language plpgsql as $$
begin
  if tg_table_name = 'payroll_cost_allocations' then
    perform tohyee_assert_payroll_allocation_total(new.id);
  else
    perform tohyee_assert_payroll_allocation_total(new.allocation_id);
  end if;
  return null;
end;
$$;
create constraint trigger payroll_cost_allocations_total
  after insert on payroll_cost_allocations
  deferrable initially deferred
  for each row execute function tohyee_check_payroll_allocation();
create constraint trigger payroll_cost_allocation_lines_total
  after insert on payroll_cost_allocation_lines
  deferrable initially deferred
  for each row execute function tohyee_check_payroll_allocation();

create trigger payroll_cost_allocations_append_only
  before update or delete on payroll_cost_allocations
  for each row execute function tohyee_payroll_append_only('Cost allocations');
create trigger payroll_cost_allocations_no_truncate
  before truncate on payroll_cost_allocations
  for each statement execute function tohyee_payroll_append_only('Cost allocations');
create trigger payroll_cost_allocation_lines_append_only
  before update or delete on payroll_cost_allocation_lines
  for each row execute function tohyee_payroll_append_only('Cost allocations');
create trigger payroll_cost_allocation_lines_no_truncate
  before truncate on payroll_cost_allocation_lines
  for each statement execute function tohyee_payroll_append_only('Cost allocations');
`,
  },
  {
    version: "0055",
    name: "sales_orders",
    sql: `
-- Sales orders, stage 1 (examples SO1-SO12), following NetSuite's. A draft can
-- be edited and deleted; approving numbers it (SO-0001, no gaps) and locks
-- it. Sales orders post nothing and don't touch stock. "Invoice" makes a
-- draft invoice whose lines point back to the order's lines; what's invoiced
-- is worked out from those invoices, never stored. An approved order can be
-- closed (nothing more to invoice) or cancelled (only with no invoices that
-- aren't voided).

create table sales_order_numbering (
  id boolean primary key default true check (id),
  last_number integer not null default 0 check (last_number >= 0)
);
insert into sales_order_numbering (id) values (true);
create trigger sales_order_numbering_guard
  before update or delete on sales_order_numbering
  for each row execute function toeyee_guard_invoice_numbering();
create trigger sales_order_numbering_no_truncate
  before truncate on sales_order_numbering
  for each statement execute function toeyee_guard_invoice_numbering();

create table sales_orders (
  id bigserial primary key,
  command_source text not null,
  idempotency_key text not null,
  request_hash text not null,
  status text not null default 'draft' check (status in ('draft', 'approved', 'closed', 'cancelled')),
  contact_id bigint not null references contacts(id),
  order_date date not null,
  expected_date date,
  reference text check (reference is null or length(reference) between 1 and 100),
  memo text check (memo is null or length(memo) between 1 and 1000),
  amounts_mode text not null check (amounts_mode in ('exclusive', 'inclusive', 'no_tax')),
  currency_code text not null check (currency_code ~ '^[A-Z]{3}$'),
  subtotal numeric not null check (subtotal >= 0),
  tax_total numeric not null check (tax_total >= 0),
  total numeric not null check (total > 0),
  custom_fields jsonb not null default '{}'::jsonb,
  salesperson_id bigint references salespeople(id),
  so_sequence integer unique check (so_sequence > 0),
  so_number text unique,
  approve_command_source text,
  approve_idempotency_key text,
  approve_request_hash text,
  approved_by_user_id uuid,
  approved_by_email text,
  approved_at timestamptz,
  close_command_source text,
  close_idempotency_key text,
  close_request_hash text,
  closed_by_user_id uuid,
  closed_by_email text,
  closed_at timestamptz,
  cancel_command_source text,
  cancel_idempotency_key text,
  cancel_request_hash text,
  cancelled_by_user_id uuid,
  cancelled_by_email text,
  cancelled_at timestamptz,
  created_by_user_id uuid,
  created_by_email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (command_source, idempotency_key),
  unique (approve_command_source, approve_idempotency_key),
  unique (close_command_source, close_idempotency_key),
  unique (cancel_command_source, cancel_idempotency_key),
  check (expected_date is null or expected_date >= order_date),
  check (total = subtotal + tax_total),
  check (so_number is null or so_number = 'SO-' || lpad(so_sequence::text, greatest(4, length(so_sequence::text)), '0')),
  check ((status = 'draft') = (so_number is null)),
  check ((status = 'draft') = (approved_at is null)),
  check ((status = 'closed') = (closed_at is not null)),
  check ((status = 'cancelled') = (cancelled_at is not null))
);
create index sales_orders_status_idx on sales_orders (status, id);
create index sales_orders_contact_idx on sales_orders (contact_id);

create table sales_order_lines (
  id bigserial primary key,
  sales_order_id bigint not null references sales_orders(id),
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
  tracking jsonb not null default '{}'::jsonb,
  custom_fields jsonb not null default '{}'::jsonb,
  item_id bigint references items(id),
  unit_id bigint references item_units(id),
  base_quantity numeric,
  unique (sales_order_id, line_order),
  check (tax_code_id is not null or tax_rate = 0),
  check (net_amount = line_amount or net_amount + tax_amount = line_amount),
  check ((item_id is null) = (base_quantity is null) and (unit_id is null or item_id is not null))
);

-- A draft can be edited and deleted. An approved sales order is locked: it
-- can only be closed (not while it has draft invoices) or cancelled (only
-- while it has no invoices that aren't voided), once (SO2, SO7, SO8). Its
-- lines are frozen with it.
create function tohyee_guard_sales_order() returns trigger
language plpgsql as $$
declare
  close_columns text[] := array['status', 'close_command_source', 'close_idempotency_key', 'close_request_hash',
    'closed_by_user_id', 'closed_by_email', 'closed_at', 'updated_at'];
  cancel_columns text[] := array['status', 'cancel_command_source', 'cancel_idempotency_key', 'cancel_request_hash',
    'cancelled_by_user_id', 'cancelled_by_email', 'cancelled_at', 'updated_at'];
begin
  if tg_op = 'TRUNCATE' then
    raise exception 'sales_orders can''t be truncated' using errcode = 'P0001';
  end if;
  if old.status = 'draft' then
    if tg_op = 'DELETE' then
      return old;
    end if;
    if new.status in ('closed', 'cancelled') then
      raise exception 'A draft sales order can''t be closed or cancelled; delete it instead' using errcode = 'P0001';
    end if;
    return new;
  end if;
  if tg_op = 'DELETE' then
    raise exception 'Sales order % is %, so it can''t be deleted', old.so_number, old.status using errcode = 'P0001';
  end if;
  if old.status = 'approved' and new.status = 'closed'
     and (to_jsonb(new) - close_columns) = (to_jsonb(old) - close_columns) then
    if exists (select 1 from sales_invoices where sales_order_id = old.id and status = 'draft') then
      raise exception 'Sales order % has draft invoices, so it can''t be closed', old.so_number using errcode = 'P0001';
    end if;
    return new;
  end if;
  if old.status = 'approved' and new.status = 'cancelled'
     and (to_jsonb(new) - cancel_columns) = (to_jsonb(old) - cancel_columns) then
    if exists (select 1 from sales_invoices where sales_order_id = old.id and status <> 'voided') then
      raise exception 'Sales order % has invoices, so it can''t be cancelled', old.so_number using errcode = 'P0001';
    end if;
    return new;
  end if;
  raise exception 'Sales order % is %, so it can''t be changed', old.so_number, old.status using errcode = 'P0001';
end;
$$;
create trigger sales_orders_guard before update or delete on sales_orders
  for each row execute function tohyee_guard_sales_order();
create trigger sales_orders_no_truncate before truncate on sales_orders
  for each statement execute function tohyee_guard_sales_order();

create function tohyee_guard_sales_order_line() returns trigger
language plpgsql as $$
declare
  parent_status text;
begin
  if tg_op = 'TRUNCATE' then
    raise exception 'sales_order_lines can''t be truncated' using errcode = 'P0001';
  end if;
  select status into parent_status from sales_orders
   where id = case when tg_op = 'DELETE' then old.sales_order_id else new.sales_order_id end for share;
  if parent_status <> 'draft' then
    raise exception 'Lines of an approved sales order can''t be changed' using errcode = 'P0001';
  end if;
  if tg_op = 'UPDATE' and old.sales_order_id <> new.sales_order_id then
    raise exception 'A sales order line can''t move to another sales order' using errcode = 'P0001';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;
create trigger sales_order_lines_guard before insert or update or delete on sales_order_lines
  for each row execute function tohyee_guard_sales_order_line();
create trigger sales_order_lines_no_truncate before truncate on sales_order_lines
  for each statement execute function tohyee_guard_sales_order_line();
create trigger sales_order_lines_item before insert or update on sales_order_lines
  for each row execute function tohyee_check_line_item();
create trigger sales_order_lines_tracking before insert or update on sales_order_lines
  for each row when (new.tracking <> '{}'::jsonb) execute function tohyee_check_line_tracking();
create trigger sales_orders_custom_fields before insert or update on sales_orders
  for each row when (new.custom_fields <> '{}'::jsonb) execute function tohyee_check_custom_values('document');
create trigger sales_order_lines_custom_fields before insert or update on sales_order_lines
  for each row when (new.custom_fields <> '{}'::jsonb) execute function tohyee_check_custom_values('line');

-- In the customer's currency, like quotes (MC25), with no rate; a contact's
-- currency can't change once it has sales orders.
create trigger sales_orders_currency_check before insert or update of contact_id, currency_code on sales_orders
  for each row execute function tohyee_check_contact_currency();
create function tohyee_guard_contact_currency_sales_orders() returns trigger
language plpgsql as $$
begin
  if coalesce(new.currency_code, '') is distinct from coalesce(old.currency_code, '')
     and exists (select 1 from sales_orders where contact_id = old.id) then
    raise exception 'Contact % has sales orders, so its currency can''t change', old.name using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger contacts_currency_sales_orders_guard
  before update of currency_code on contacts
  for each row execute function tohyee_guard_contact_currency_sales_orders();

-- Invoices made from a sales order (SO3-SO6). The invoice names it, and each
-- of its lines that came from it names that line.
alter table sales_invoices add column sales_order_id bigint references sales_orders(id);
create index sales_invoices_sales_order_idx on sales_invoices (sales_order_id) where sales_order_id is not null;
alter table sales_invoice_lines add column sales_order_line_id bigint references sales_order_lines(id);
create index sales_invoice_lines_sales_order_line_idx on sales_invoice_lines (sales_order_line_id) where sales_order_line_id is not null;

-- An invoice's sales order was approved when the invoice was made, is for
-- the same customer, and can't be changed once set. Voiding an invoice of a
-- closed order is still allowed (SO7).
create function tohyee_check_invoice_sales_order() returns trigger
language plpgsql as $$
declare
  so record;
begin
  if tg_op = 'UPDATE' and new.sales_order_id is distinct from old.sales_order_id then
    raise exception 'An invoice''s sales order can''t be changed' using errcode = 'P0001';
  end if;
  if new.sales_order_id is null then
    return new;
  end if;
  select status, contact_id into so from sales_orders where id = new.sales_order_id;
  if tg_op = 'INSERT' and so.status <> 'approved' then
    raise exception 'Invoices can only be made from an approved sales order' using errcode = 'P0001';
  end if;
  if so.contact_id <> new.contact_id then
    raise exception 'An invoice from a sales order must be to the sales order''s customer' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger sales_invoices_sales_order before insert or update of contact_id, sales_order_id on sales_invoices
  for each row execute function tohyee_check_invoice_sales_order();

-- An invoice line from a sales order line: that line is on the invoice's own
-- sales order, which is approved, it has the same item and unit, and the
-- invoices that aren't voided never add up to more than was ordered (SO6).
-- The order is locked for update, so two transactions adding to the same
-- order take turns and the second counts the first's lines once it commits;
-- closing or cancelling it waits too.
create function tohyee_check_invoice_line_sales_order() returns trigger
language plpgsql as $$
declare
  so_line record;
  invoice_so bigint;
  so_status text;
  on_invoices numeric;
begin
  if new.sales_order_line_id is null then
    return new;
  end if;
  select sales_order_id, quantity, item_id, unit_id into so_line from sales_order_lines where id = new.sales_order_line_id;
  select sales_order_id into invoice_so from sales_invoices where id = new.invoice_id;
  if invoice_so is distinct from so_line.sales_order_id then
    raise exception 'An invoice line can only come from its own invoice''s sales order' using errcode = 'P0001';
  end if;
  select status into so_status from sales_orders where id = so_line.sales_order_id for update;
  if so_status <> 'approved' then
    raise exception 'Invoice lines can only come from an approved sales order' using errcode = 'P0001';
  end if;
  if new.item_id is distinct from so_line.item_id or new.unit_id is distinct from so_line.unit_id then
    raise exception 'An invoice line from a sales order keeps its item and unit' using errcode = 'P0001';
  end if;
  select coalesce(sum(l.quantity), 0) into on_invoices
    from sales_invoice_lines l join sales_invoices i on i.id = l.invoice_id
   where l.sales_order_line_id = new.sales_order_line_id and i.status <> 'voided';
  if on_invoices > so_line.quantity then
    raise exception 'Invoices can''t add up to more than the sales order line ordered' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger sales_invoice_lines_sales_order
  after insert or update of sales_order_line_id, quantity, item_id, unit_id, invoice_id on sales_invoice_lines
  for each row execute function tohyee_check_invoice_line_sales_order();

-- A finalised quote can be accepted as a sales order instead of an invoice
-- (SO9; NetSuite's estimate to sales order). An accepted quote has one or
-- the other, never both.
alter table quotes add column sales_order_id bigint unique references sales_orders(id);
do $do$
declare
  found text;
begin
  select conname into found from pg_constraint
   where conrelid = 'quotes'::regclass and contype = 'c'
     and pg_get_constraintdef(oid) like '%status = ''accepted''%invoice_id IS NOT NULL%';
  if found is null then
    raise exception 'quotes'' accepted check wasn''t found';
  end if;
  execute format('alter table quotes drop constraint %I', found);
end;
$do$;
alter table quotes add constraint quotes_accepted_check
  check ((status = 'accepted') = (invoice_id is not null or sales_order_id is not null)
         and (invoice_id is null or sales_order_id is null));

create or replace function tohyee_guard_quote() returns trigger
language plpgsql as $$
declare
  close_columns text[] := array['status', 'invoice_id', 'sales_order_id', 'close_command_source', 'close_idempotency_key',
    'close_request_hash', 'closed_by_user_id', 'closed_by_email', 'closed_at', 'updated_at'];
begin
  if tg_op = 'TRUNCATE' then
    raise exception 'quotes can''t be truncated' using errcode = 'P0001';
  end if;
  if old.status = 'draft' then
    if tg_op = 'DELETE' then
      return old;
    end if;
    return new;
  end if;
  if tg_op = 'DELETE' then
    raise exception 'Quote % is %, so it can''t be deleted', old.quote_number, old.status using errcode = 'P0001';
  end if;
  if old.status = 'finalised' and new.status in ('accepted', 'declined')
     and (to_jsonb(new) - close_columns) = (to_jsonb(old) - close_columns) then
    return new;
  end if;
  raise exception 'Quote % is %, so it can''t be changed', old.quote_number, old.status using errcode = 'P0001';
end;
$$;
`,
  },
  {
    version: "0056",
    name: "sales_platform_connections",
    sql: `
-- Sales platform connections, stage 1 (examples SPC1-SPC10): connections to
-- sales platforms (Shopify first), the links from a platform's records to
-- Tohyee's contacts and items, a sync log people can read, and the webhook
-- deliveries already handled. Nothing here posts to the ledger. Versions
-- 0051-0055 are reserved by other branches.
create table sales_platform_connections (
  id bigserial primary key,
  platform text not null check (platform in ('shopify')),
  store_domain text not null check (length(store_domain) between 1 and 255),
  store_name text check (store_name is null or length(store_name) <= 255),
  store_currency text check (store_currency is null or store_currency ~ '^[A-Z]{3}$'),
  prices_include_tax boolean,
  auth_method text not null check (length(auth_method) between 1 and 40),
  -- The platform's credentials as encrypted JSON (TOHYEE_SECRET_KEY); removed on disconnecting.
  credentials_ciphertext text,
  access_token_ciphertext text,
  access_token_expires_at timestamptz,
  -- Random, in the webhook address, so deliveries can find their connection.
  webhook_key text not null unique check (length(webhook_key) >= 32),
  webhook_subscription_ids text[] not null default '{}',
  webhooks_note text,
  sync_customers boolean not null default true,
  sync_products boolean not null default true,
  status text not null default 'active' check (status in ('active', 'paused', 'disconnected')),
  customers_synced_until timestamptz,
  products_synced_until timestamptz,
  last_sync_at timestamptz,
  last_error text,
  failures integer not null default 0,
  connected_by_email text not null,
  connected_at timestamptz not null default now(),
  disconnected_by_email text,
  disconnected_at timestamptz,
  updated_at timestamptz not null default now(),
  check ((status = 'disconnected') = (credentials_ciphertext is null)),
  check (status <> 'disconnected' or (access_token_ciphertext is null and disconnected_at is not null))
);
-- A store is connected at most once at a time.
create unique index sales_platform_connections_store_idx
  on sales_platform_connections (platform, lower(store_domain)) where status <> 'disconnected';

-- Which Tohyee record each platform record is, so nothing is brought in
-- twice, with the values the platform last had (to tell whether someone
-- changed a value in Tohyee). Removed on disconnecting.
create table sales_platform_mappings (
  id bigserial primary key,
  connection_id bigint not null references sales_platform_connections(id),
  record_kind text not null check (record_kind in ('customer', 'product_variant')),
  external_id text not null check (length(external_id) between 1 and 100),
  contact_id bigint references contacts(id),
  item_id bigint references items(id),
  synced_values jsonb not null default '{}',
  external_updated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((record_kind = 'customer') = (contact_id is not null)),
  check ((record_kind = 'product_variant') = (item_id is not null)),
  unique (connection_id, record_kind, external_id)
);
create unique index sales_platform_mappings_contact_idx on sales_platform_mappings (connection_id, contact_id) where contact_id is not null;
create unique index sales_platform_mappings_item_idx on sales_platform_mappings (connection_id, item_id) where item_id is not null;

-- What each sync and webhook did. Append-only, and kept after disconnecting.
create table sales_platform_sync_log (
  id bigserial primary key,
  connection_id bigint not null references sales_platform_connections(id),
  logged_at timestamptz not null default now(),
  source text not null check (source in ('sync', 'webhook', 'connection')),
  action text not null check (action in (
    'connected', 'tested', 'settings', 'webhooks', 'disconnected', 'sync',
    'created', 'linked', 'updated', 'kept', 'skipped', 'failed')),
  record_kind text check (record_kind is null or record_kind in ('customer', 'product_variant')),
  external_id text check (external_id is null or length(external_id) <= 100),
  contact_id bigint references contacts(id),
  item_id bigint references items(id),
  message text not null check (length(message) between 1 and 1000),
  actor_email text not null
);
create index sales_platform_sync_log_connection_idx on sales_platform_sync_log (connection_id, id desc);
create index sales_platform_sync_log_record_idx on sales_platform_sync_log (connection_id, record_kind, external_id, id desc);
create trigger sales_platform_sync_log_no_update before update or delete on sales_platform_sync_log
  for each row execute function toeyee_forbid_mutation();
create trigger sales_platform_sync_log_no_truncate before truncate on sales_platform_sync_log
  for each statement execute function toeyee_forbid_mutation();

-- Webhook deliveries already handled (by the platform's delivery ID), so a
-- delivery sent again does nothing.
create table sales_platform_webhook_deliveries (
  connection_id bigint not null references sales_platform_connections(id),
  delivery_id text not null check (length(delivery_id) between 1 and 200),
  topic text not null check (length(topic) between 1 and 100),
  received_at timestamptz not null default now(),
  primary key (connection_id, delivery_id)
);
`,
  },
  {
    version: "0059",
    name: "crm_record_types",
    sql: `
-- CRM record types and page layouts (CRM roadmap items 3 and 4, examples
-- CRT1-CRT13), after Salesforce record types and page layouts (NetSuite
-- custom forms): each company (contact), person and opportunity has one
-- record type, and each type has one layout saying which sections and
-- fields its record page shows, in order, and which are required or
-- read-only on that type. One type per kind is the default.
create table crm_record_types (
  id bigserial primary key,
  record text not null check (record in ('contact', 'person', 'opportunity')),
  name text not null check (length(name) between 1 and 60),
  description text check (description is null or length(description) between 1 and 300),
  is_default boolean not null default false,
  is_active boolean not null default true,
  sort_order integer not null default 0,
  layout jsonb not null check (jsonb_typeof(layout) = 'object' and jsonb_typeof(layout -> 'sections') = 'array'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (is_active or not is_default)
);
create unique index crm_record_types_name_idx on crm_record_types (record, lower(name));
create unique index crm_record_types_default_idx on crm_record_types (record) where is_default;

-- Types are never deleted (archive one instead) and stay the kind they were made for.
create function tohyee_guard_crm_record_type() returns trigger
language plpgsql as $$
begin
  if tg_op in ('DELETE', 'TRUNCATE') then
    raise exception 'Record types are never deleted; archive one instead' using errcode = 'P0001';
  end if;
  if new.record <> old.record then
    raise exception 'A record type''s kind of record can''t change' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger crm_record_types_guard before update or delete on crm_record_types
  for each row execute function tohyee_guard_crm_record_type();
create trigger crm_record_types_no_truncate before truncate on crm_record_types
  for each statement execute function tohyee_guard_crm_record_type();

-- The "Standard" type for each kind (CRT1): its standard fields, then its
-- custom fields with no section, then one section per custom field section,
-- then the system fields (read-only).
insert into crm_record_types (record, name, is_default, layout)
select k.record, 'Standard', true,
  jsonb_build_object('sections',
    jsonb_build_array(jsonb_build_object('name', k.first_section, 'fields',
      k.standard || coalesce((select jsonb_agg(jsonb_build_object('key', 'custom:' || f.id, 'required', false, 'readOnly', false) order by f.sort_order, f.id)
                                from custom_fields f where f.record = k.record and f.section_id is null), '[]'::jsonb)))
    || k.extra
    || coalesce((select jsonb_agg(jsonb_build_object(
          'name', case when lower(s.name) = any (k.reserved) then left(s.name, 56) || ' (2)' else s.name end,
          'fields', coalesce((select jsonb_agg(jsonb_build_object('key', 'custom:' || f.id, 'required', false, 'readOnly', false) order by f.sort_order, f.id)
                                from custom_fields f where f.section_id = s.id), '[]'::jsonb))
        order by s.sort_order, s.id)
        from custom_field_sections s where s.record = k.record), '[]'::jsonb)
    || '[{"name": "System information", "fields": [{"key": "createdAt", "required": false, "readOnly": true}, {"key": "updatedAt", "required": false, "readOnly": true}]}]'::jsonb)
from (values
  ('contact', 'Company information',
   '[{"key": "name", "required": true, "readOnly": false}, {"key": "ownerUserId", "required": false, "readOnly": false},
     {"key": "email", "required": false, "readOnly": false}, {"key": "phone", "required": false, "readOnly": false},
     {"key": "gstNumber", "required": false, "readOnly": false}]'::jsonb,
   '[{"name": "Address information", "fields": [{"key": "postalAddress", "required": false, "readOnly": false},
     {"key": "deliveryAddress", "required": false, "readOnly": false}]}]'::jsonb,
   array['company information', 'address information', 'system information']),
  ('person', 'Person information',
   '[{"key": "firstName", "required": true, "readOnly": false}, {"key": "lastName", "required": false, "readOnly": false},
     {"key": "jobTitle", "required": false, "readOnly": false}, {"key": "contactId", "required": false, "readOnly": false},
     {"key": "email", "required": false, "readOnly": false}, {"key": "phone", "required": false, "readOnly": false}]'::jsonb,
   '[]'::jsonb,
   array['person information', 'system information']),
  ('opportunity', 'Opportunity information',
   '[{"key": "name", "required": true, "readOnly": false}, {"key": "contactId", "required": true, "readOnly": false},
     {"key": "pointOfContactId", "required": false, "readOnly": false}, {"key": "ownerUserId", "required": false, "readOnly": false},
     {"key": "amount", "required": false, "readOnly": false}, {"key": "closeDate", "required": false, "readOnly": false},
     {"key": "stage", "required": false, "readOnly": false}]'::jsonb,
   '[]'::jsonb,
   array['opportunity information', 'system information'])
) as k(record, first_section, standard, extra, reserved);

-- A company's owner (after Twenty's account owner and Salesforce's Account
-- Owner): a member of the organisation, kept in the core database.
alter table contacts add column owner_user_id text;

-- Every record has a type; existing ones get the default (CRT1).
alter table contacts add column record_type_id bigint references crm_record_types(id);
alter table crm_people add column record_type_id bigint references crm_record_types(id);
alter table crm_opportunities add column record_type_id bigint references crm_record_types(id);
update contacts set record_type_id = (select id from crm_record_types where record = 'contact' and is_default);
update crm_people set record_type_id = (select id from crm_record_types where record = 'person' and is_default);
update crm_opportunities set record_type_id = (select id from crm_record_types where record = 'opportunity' and is_default);
alter table contacts alter column record_type_id set not null;
alter table crm_people alter column record_type_id set not null;
alter table crm_opportunities alter column record_type_id set not null;
create index contacts_record_type_idx on contacts (record_type_id);
create index crm_people_record_type_idx on crm_people (record_type_id);
create index crm_opportunities_record_type_idx on crm_opportunities (record_type_id);

-- A new record without a type gets its kind's default; a type must be for
-- the record's kind.
create function tohyee_crm_record_type_of() returns trigger
language plpgsql as $$
declare
  kind text := tg_argv[0];
  found text;
begin
  if new.record_type_id is null then
    new.record_type_id := (select id from crm_record_types where record = kind and is_default);
    if new.record_type_id is null then
      raise exception 'There''s no default record type for %', kind using errcode = 'P0001';
    end if;
  else
    found := (select record from crm_record_types where id = new.record_type_id);
    if found is distinct from kind then
      raise exception 'That record type isn''t for this kind of record' using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$;
create trigger contacts_record_type before insert or update of record_type_id on contacts
  for each row execute function tohyee_crm_record_type_of('contact');
create trigger crm_people_record_type before insert or update of record_type_id on crm_people
  for each row execute function tohyee_crm_record_type_of('person');
create trigger crm_opportunities_record_type before insert or update of record_type_id on crm_opportunities
  for each row execute function tohyee_crm_record_type_of('opportunity');
`,
  },
  {
    version: "0060",
    name: "rdti_register_and_tags",
    sql: `
-- R&D Tax Incentive, stage R2 (docs/ACCOUNTING-EXAMPLES.md RD1-RD3, RD8-RD13,
-- RD21-RD23; docs/DECISIONS.md 30-50): the activity register, approvals with
-- IRD's letter, files kept with history, tags linking posted cost lines to
-- activities, fixed asset tax depreciation and usage logs, and a history of
-- every change. Nothing here posts or changes an amount. Who and when come
-- from the signed-in user and the server's clock: the stamp triggers below
-- overwrite whatever a statement supplies, so nothing is backdated.

create function tohyee_rd_stamp_created() returns trigger
language plpgsql as $$
begin
  new.created_at := now();
  return new;
end;
$$;

create function tohyee_rd_stamp_changed() returns trigger
language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    new.created_at := now();
    new.updated_at := now();
    new.updated_by_user_id := new.created_by_user_id;
    new.updated_by_email := new.created_by_email;
  else
    new.created_at := old.created_at;
    new.created_by_user_id := old.created_by_user_id;
    new.created_by_email := old.created_by_email;
    new.updated_at := now();
  end if;
  return new;
end;
$$;

create function tohyee_rd_forbid() returns trigger
language plpgsql as $$
begin
  raise exception '% are kept: they can''t be %', tg_argv[0],
    case tg_op when 'UPDATE' then 'changed' else 'deleted' end
    using errcode = 'P0001';
end;
$$;

-- The register (RD1, RD2). Archived, never deleted.
create table rd_activities (
  id uuid primary key default gen_random_uuid(),
  idempotency_key text not null unique,
  request_hash text not null,
  code text not null check (code ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,19}$'),
  name text not null check (length(name) between 1 and 200 and name = btrim(name)),
  project_name text not null check (length(project_name) between 1 and 200 and project_name = btrim(project_name)),
  kind text not null check (kind in ('core', 'supporting')),
  place text not null check (place in ('nz', 'overseas')),
  first_income_year integer not null check (first_income_year between 2000 and 2999),
  last_income_year integer check (last_income_year is null or last_income_year between first_income_year and 2999),
  purpose_and_uncertainty text not null default '' check (length(purpose_and_uncertainty) <= 10000),
  why_not_public_knowledge text not null default '' check (length(why_not_public_knowledge) <= 10000),
  systematic_approach text not null default '' check (length(systematic_approach) <= 10000),
  why_required text not null default '' check (length(why_required) <= 10000),
  status text not null default 'active' check (status in ('active', 'archived')),
  archived_at timestamptz,
  archived_by_user_id uuid,
  archived_by_email text,
  version integer not null default 1 check (version > 0),
  material_changed_at timestamptz,
  created_by_user_id uuid,
  created_by_email text not null,
  created_at timestamptz not null default now(),
  updated_by_user_id uuid,
  updated_by_email text not null,
  updated_at timestamptz not null default now(),
  -- Core R&D must be performed in New Zealand (LY 2(1)(c); IR1240 p 12).
  check (kind = 'supporting' or place = 'nz'),
  check (kind = 'supporting' or why_required = ''),
  check ((status = 'archived') = (archived_at is not null)),
  check ((archived_at is null) = (archived_by_email is null))
);
create unique index rd_activities_code_idx on rd_activities (lower(code));

-- The core activities a supporting activity supports (decision 39: one
-- supporting activity can support several). Changing them is a change to
-- the activity, kept in rd_history.
create table rd_activity_supports (
  supporting_id uuid not null references rd_activities(id),
  core_id uuid not null references rd_activities(id),
  primary key (supporting_id, core_id),
  check (supporting_id <> core_id)
);
create index rd_activity_supports_core_idx on rd_activity_supports (core_id);

create function tohyee_assert_rd_activity(target uuid) returns void
language plpgsql as $$
declare
  activity record;
begin
  select id, code, kind into activity from rd_activities where id = target;
  if not found then
    return;
  end if;
  if activity.kind = 'core' then
    if exists (select 1 from rd_activity_supports where supporting_id = target) then
      raise exception 'R&D activity % is core, so it doesn''t support another activity', activity.code using errcode = '23514';
    end if;
  else
    if not exists (select 1 from rd_activity_supports where supporting_id = target) then
      raise exception 'Supporting R&D activity % needs the core activity it supports', activity.code using errcode = '23514';
    end if;
    if exists (select 1 from rd_activity_supports where core_id = target) then
      raise exception 'R&D activity % is supporting, so another activity can''t support it', activity.code using errcode = '23514';
    end if;
    if exists (select 1 from rd_activity_supports s join rd_activities c on c.id = s.core_id
                where s.supporting_id = target and c.kind <> 'core') then
      raise exception 'Supporting R&D activity % can only support core activities', activity.code using errcode = '23514';
    end if;
  end if;
end;
$$;
create function tohyee_check_rd_activity() returns trigger
language plpgsql as $$
begin
  if tg_table_name = 'rd_activities' then
    perform tohyee_assert_rd_activity(new.id);
  elsif tg_op = 'DELETE' then
    perform tohyee_assert_rd_activity(old.supporting_id);
    perform tohyee_assert_rd_activity(old.core_id);
  else
    perform tohyee_assert_rd_activity(new.supporting_id);
    perform tohyee_assert_rd_activity(new.core_id);
  end if;
  return null;
end;
$$;
create constraint trigger rd_activities_links
  after insert or update on rd_activities
  deferrable initially deferred
  for each row execute function tohyee_check_rd_activity();
create constraint trigger rd_activity_supports_links
  after insert or delete on rd_activity_supports
  deferrable initially deferred
  for each row execute function tohyee_check_rd_activity();

create trigger rd_activities_stamp before insert or update on rd_activities
  for each row execute function tohyee_rd_stamp_changed();
create trigger rd_activities_no_delete before delete on rd_activities
  for each row execute function tohyee_rd_forbid('R&D activities');
create trigger rd_activities_no_truncate before truncate on rd_activities
  for each statement execute function tohyee_rd_forbid('R&D activities');
create trigger rd_activity_supports_no_change before update on rd_activity_supports
  for each row execute function tohyee_rd_forbid('R&D activity links');
create trigger rd_activity_supports_no_truncate before truncate on rd_activity_supports
  for each statement execute function tohyee_rd_forbid('R&D activity links');

-- Files on R&D records (decision 45): kept, never deleted. Replacing one
-- adds a new row pointing at the one it replaces, so the old file stays.
create table rd_files (
  id uuid primary key default gen_random_uuid(),
  idempotency_key text not null unique,
  request_hash text not null,
  record_type text not null check (record_type in ('activity', 'approval', 'tag', 'asset')),
  record_id text not null check (length(record_id) between 1 and 60),
  purpose text not null check (purpose in ('approval_letter', 'contractor_statement', 'workings', 'other')),
  file_name text not null check (length(file_name) between 1 and 255),
  content_type text not null check (content_type in (
    'application/pdf', 'image/jpeg', 'image/png', 'image/heic', 'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'text/csv')),
  byte_size integer not null check (byte_size between 1 and 10485760),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  content bytea not null check (octet_length(content) = byte_size),
  replaces_id uuid unique references rd_files(id),
  created_by_user_id uuid,
  created_by_email text not null,
  created_at timestamptz not null default now(),
  check (replaces_id is null or replaces_id <> id)
);
create index rd_files_record_idx on rd_files (record_type, record_id);
create trigger rd_files_stamp before insert on rd_files
  for each row execute function tohyee_rd_stamp_created();
create trigger rd_files_append_only before update or delete on rd_files
  for each row execute function tohyee_rd_forbid('R&D files');
create trigger rd_files_no_truncate before truncate on rd_files
  for each statement execute function tohyee_rd_forbid('R&D files');

-- Approvals as entered from IRD's letter (RD3; decision 40). Only general
-- approval (TAA 68CB) for now; it covers up to 3 income years. The letter is
-- required: an approval can't be saved without one.
create table rd_approvals (
  id uuid primary key default gen_random_uuid(),
  idempotency_key text not null unique,
  request_hash text not null,
  kind text not null check (kind in ('general')),
  reference text not null check (length(reference) between 1 and 100 and reference = btrim(reference)),
  letter_date date not null,
  first_income_year integer not null check (first_income_year between 2000 and 2999),
  last_income_year integer not null check (last_income_year between first_income_year and first_income_year + 2),
  note text check (note is null or length(note) <= 2000),
  status text not null default 'active' check (status in ('active', 'withdrawn')),
  withdrawn_reason text check (withdrawn_reason is null or length(withdrawn_reason) between 1 and 500),
  withdrawn_at timestamptz,
  withdrawn_by_user_id uuid,
  withdrawn_by_email text,
  version integer not null default 1 check (version > 0),
  created_by_user_id uuid,
  created_by_email text not null,
  created_at timestamptz not null default now(),
  updated_by_user_id uuid,
  updated_by_email text not null,
  updated_at timestamptz not null default now(),
  check ((status = 'withdrawn') = (withdrawn_at is not null)),
  check ((withdrawn_at is null) = (withdrawn_reason is null)),
  check ((withdrawn_at is null) = (withdrawn_by_email is null))
);
create table rd_approval_activities (
  approval_id uuid not null references rd_approvals(id),
  activity_id uuid not null references rd_activities(id),
  primary key (approval_id, activity_id)
);
create index rd_approval_activities_activity_idx on rd_approval_activities (activity_id);

create function tohyee_assert_rd_approval(target uuid) returns void
language plpgsql as $$
begin
  if not exists (select 1 from rd_approvals where id = target) then
    return;
  end if;
  if not exists (select 1 from rd_approval_activities where approval_id = target) then
    raise exception 'An R&D approval needs the activities it covers' using errcode = '23514';
  end if;
  if not exists (select 1 from rd_files where record_type = 'approval' and record_id = target::text and purpose = 'approval_letter') then
    raise exception 'An R&D approval needs IRD''s letter attached' using errcode = '23514';
  end if;
end;
$$;
create function tohyee_check_rd_approval() returns trigger
language plpgsql as $$
begin
  if tg_table_name = 'rd_approvals' then
    perform tohyee_assert_rd_approval(new.id);
  else
    perform tohyee_assert_rd_approval(new.approval_id);
  end if;
  return null;
end;
$$;
create constraint trigger rd_approvals_complete
  after insert on rd_approvals
  deferrable initially deferred
  for each row execute function tohyee_check_rd_approval();
create constraint trigger rd_approval_activities_complete
  after insert on rd_approval_activities
  deferrable initially deferred
  for each row execute function tohyee_check_rd_approval();

-- Only withdrawing changes an approval; what was entered from the letter stays.
create function tohyee_guard_rd_approval() returns trigger
language plpgsql as $$
begin
  if old.status <> 'active' or new.status <> 'withdrawn'
     or (new.kind, new.reference, new.letter_date, new.first_income_year, new.last_income_year, new.note)
        is distinct from (old.kind, old.reference, old.letter_date, old.first_income_year, old.last_income_year, old.note) then
    raise exception 'R&D approvals are kept as entered; an approval can only be withdrawn' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger rd_approvals_guard before update on rd_approvals
  for each row execute function tohyee_guard_rd_approval();
create trigger rd_approvals_stamp before insert or update on rd_approvals
  for each row execute function tohyee_rd_stamp_changed();
create trigger rd_approvals_no_delete before delete on rd_approvals
  for each row execute function tohyee_rd_forbid('R&D approvals');
create trigger rd_approvals_no_truncate before truncate on rd_approvals
  for each statement execute function tohyee_rd_forbid('R&D approvals');
create trigger rd_approval_activities_append_only before update or delete on rd_approval_activities
  for each row execute function tohyee_rd_forbid('R&D approvals');
create trigger rd_approval_activities_no_truncate before truncate on rd_approval_activities
  for each statement execute function tohyee_rd_forbid('R&D approvals');

-- A tag links one posted cost line to an activity (RD8, RD9, RD11-RD13). The
-- line's amount is excluding GST and in the base currency at the document's
-- rate; amount is the R&D share, rounded down to the cent. Tags are removed,
-- never deleted, and only one active tag can be on a line.
create table rd_tags (
  id uuid primary key default gen_random_uuid(),
  idempotency_key text not null unique,
  request_hash text not null,
  source_type text not null
    check (source_type in ('bill_line', 'expense_claim_receipt', 'bank_transaction_line', 'journal_line')),
  -- Checked by tohyee_check_rd_tag_source rather than foreign keys, so the
  -- source tables keep refusing TRUNCATE with their own messages.
  bill_line_id bigint,
  expense_claim_receipt_id bigint,
  bank_transaction_line_id bigint,
  journal_line_id bigint,
  activity_id uuid not null references rd_activities(id),
  work_date date not null,
  line_amount numeric not null check (line_amount > 0),
  percentage numeric(5,2) not null check (percentage > 0 and percentage <= 100),
  amount numeric not null check (amount >= 0 and amount <= line_amount),
  eligibility text not null check (eligibility in ('eligible', 'ineligible')),
  category text check (category in ('employee', 'materials_overheads', 'contract', 'approved_research_provider')),
  ineligible_reason text check (length(ineligible_reason) between 1 and 60),
  overseas boolean not null default false,
  commercial_production boolean not null default false,
  internal_software boolean not null default false,
  feedstock boolean not null default false,
  contractor_ineligible_amount numeric not null default 0 check (contractor_ineligible_amount >= 0),
  unused_amount numeric not null default 0 check (unused_amount >= 0),
  unused_marked_by_user_id uuid,
  unused_marked_by_email text,
  unused_marked_at timestamptz,
  note text check (note is null or length(note) <= 2000),
  status text not null default 'active' check (status in ('active', 'removed')),
  removed_reason text check (removed_reason is null or length(removed_reason) between 1 and 500),
  removed_at timestamptz,
  removed_by_user_id uuid,
  removed_by_email text,
  version integer not null default 1 check (version > 0),
  created_by_user_id uuid,
  created_by_email text not null,
  created_at timestamptz not null default now(),
  updated_by_user_id uuid,
  updated_by_email text not null,
  updated_at timestamptz not null default now(),
  check (num_nonnulls(bill_line_id, expense_claim_receipt_id, bank_transaction_line_id, journal_line_id) = 1),
  check ((source_type = 'bill_line') = (bill_line_id is not null)),
  check ((source_type = 'expense_claim_receipt') = (expense_claim_receipt_id is not null)),
  check ((source_type = 'bank_transaction_line') = (bank_transaction_line_id is not null)),
  check ((source_type = 'journal_line') = (journal_line_id is not null)),
  check ((eligibility = 'eligible') = (category is not null)),
  check ((eligibility = 'ineligible') = (ineligible_reason is not null)),
  check (contractor_ineligible_amount = 0 or category in ('contract', 'approved_research_provider')),
  check (eligibility = 'eligible' or (unused_amount = 0 and contractor_ineligible_amount = 0)),
  check (unused_amount + contractor_ineligible_amount <= amount),
  check ((unused_amount = 0) = (unused_marked_at is null)),
  check ((unused_marked_at is null) = (unused_marked_by_email is null)),
  check ((status = 'removed') = (removed_at is not null)),
  check ((removed_at is null) = (removed_reason is null)),
  check ((removed_at is null) = (removed_by_email is null))
);
create unique index rd_tags_bill_line_idx on rd_tags (bill_line_id) where status = 'active' and bill_line_id is not null;
create unique index rd_tags_claim_receipt_idx on rd_tags (expense_claim_receipt_id)
  where status = 'active' and expense_claim_receipt_id is not null;
create unique index rd_tags_bank_line_idx on rd_tags (bank_transaction_line_id)
  where status = 'active' and bank_transaction_line_id is not null;
create unique index rd_tags_journal_line_idx on rd_tags (journal_line_id) where status = 'active' and journal_line_id is not null;
create index rd_tags_activity_idx on rd_tags (activity_id, work_date);
create index rd_tags_work_date_idx on rd_tags (work_date);

-- The line a tag is on, its date and amount never change, and a removed tag
-- stays removed.
create function tohyee_guard_rd_tag() returns trigger
language plpgsql as $$
begin
  if old.status = 'removed'
     or (new.source_type, new.bill_line_id, new.expense_claim_receipt_id, new.bank_transaction_line_id, new.journal_line_id,
         new.work_date, new.line_amount)
        is distinct from (old.source_type, old.bill_line_id, old.expense_claim_receipt_id, old.bank_transaction_line_id,
                          old.journal_line_id, old.work_date, old.line_amount) then
    raise exception 'An R&D tag stays on its line; remove it and tag the line again instead' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create function tohyee_check_rd_tag_source() returns trigger
language plpgsql as $$
declare
  line_exists boolean;
begin
  line_exists := case new.source_type
    when 'bill_line' then exists (select 1 from bill_lines where id = new.bill_line_id)
    when 'expense_claim_receipt' then exists (select 1 from expense_claim_receipts where id = new.expense_claim_receipt_id)
    when 'bank_transaction_line' then exists (select 1 from bank_transaction_lines where id = new.bank_transaction_line_id)
    else exists (select 1 from ledger_journal_lines where id = new.journal_line_id)
  end;
  if not line_exists then
    raise exception 'An R&D tag must be on an existing line' using errcode = '23503';
  end if;
  return new;
end;
$$;
create trigger rd_tags_source before insert on rd_tags
  for each row execute function tohyee_check_rd_tag_source();
create trigger rd_tags_guard before update on rd_tags
  for each row execute function tohyee_guard_rd_tag();
create trigger rd_tags_stamp before insert or update on rd_tags
  for each row execute function tohyee_rd_stamp_changed();
create trigger rd_tags_no_delete before delete on rd_tags
  for each row execute function tohyee_rd_forbid('R&D tags');
create trigger rd_tags_no_truncate before truncate on rd_tags
  for each statement execute function tohyee_rd_forbid('R&D tags');

-- Tax depreciation entered per asset for an income year (RD11; decision 33),
-- never the book depreciation the fixed asset register posts. Investment
-- Boost (DI 5) counts as depreciation. The latest entry for an asset and year
-- counts; earlier ones are its history.
create table rd_asset_tax_depreciation (
  id uuid primary key default gen_random_uuid(),
  entry_number bigserial not null unique,
  idempotency_key text not null unique,
  request_hash text not null,
  -- Checked by tohyee_check_rd_asset, like rd_tags' lines.
  asset_id bigint not null,
  income_year integer not null check (income_year between 2000 and 2999),
  tax_depreciation numeric not null check (tax_depreciation >= 0),
  investment_boost numeric not null check (investment_boost >= 0),
  ineligible_reason text check (length(ineligible_reason) between 1 and 60),
  note text check (note is null or length(note) <= 2000),
  created_by_user_id uuid,
  created_by_email text not null,
  created_at timestamptz not null default now()
);
create index rd_asset_tax_depreciation_asset_idx on rd_asset_tax_depreciation (asset_id, income_year, entry_number);
create function tohyee_check_rd_asset() returns trigger
language plpgsql as $$
begin
  if not exists (select 1 from fixed_assets where id = new.asset_id) then
    raise exception 'That fixed asset doesn''t exist' using errcode = '23503';
  end if;
  return new;
end;
$$;
create trigger rd_asset_tax_depreciation_asset before insert on rd_asset_tax_depreciation
  for each row execute function tohyee_check_rd_asset();
create trigger rd_asset_tax_depreciation_stamp before insert on rd_asset_tax_depreciation
  for each row execute function tohyee_rd_stamp_created();
create trigger rd_asset_tax_depreciation_append_only before update or delete on rd_asset_tax_depreciation
  for each row execute function tohyee_rd_forbid('R&D tax depreciation entries');
create trigger rd_asset_tax_depreciation_no_truncate before truncate on rd_asset_tax_depreciation
  for each statement execute function tohyee_rd_forbid('R&D tax depreciation entries');

-- An asset's usage log (RD11): hours on an activity, or on other work when
-- activity_id is null. Idle time isn't logged.
create table rd_asset_usage (
  id uuid primary key default gen_random_uuid(),
  idempotency_key text not null unique,
  request_hash text not null,
  asset_id bigint not null,
  activity_id uuid references rd_activities(id),
  work_date date not null,
  hours numeric(9,2) not null check (hours > 0 and hours <= 100000),
  description text check (description is null or length(description) <= 500),
  status text not null default 'active' check (status in ('active', 'removed')),
  removed_reason text check (removed_reason is null or length(removed_reason) between 1 and 500),
  removed_at timestamptz,
  removed_by_user_id uuid,
  removed_by_email text,
  version integer not null default 1 check (version > 0),
  created_by_user_id uuid,
  created_by_email text not null,
  created_at timestamptz not null default now(),
  updated_by_user_id uuid,
  updated_by_email text not null,
  updated_at timestamptz not null default now(),
  check ((status = 'removed') = (removed_at is not null)),
  check ((removed_at is null) = (removed_reason is null)),
  check ((removed_at is null) = (removed_by_email is null))
);
create index rd_asset_usage_asset_idx on rd_asset_usage (asset_id, work_date);
create function tohyee_guard_rd_asset_usage() returns trigger
language plpgsql as $$
begin
  if old.status = 'removed' or (new.asset_id, new.work_date) is distinct from (old.asset_id, old.work_date) then
    raise exception 'A usage log entry keeps its asset and date; remove it and enter a new one instead' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger rd_asset_usage_asset before insert on rd_asset_usage
  for each row execute function tohyee_check_rd_asset();
create trigger rd_asset_usage_guard before update on rd_asset_usage
  for each row execute function tohyee_guard_rd_asset_usage();
create trigger rd_asset_usage_stamp before insert or update on rd_asset_usage
  for each row execute function tohyee_rd_stamp_changed();
create trigger rd_asset_usage_no_delete before delete on rd_asset_usage
  for each row execute function tohyee_rd_forbid('Usage log entries');
create trigger rd_asset_usage_no_truncate before truncate on rd_asset_usage
  for each statement execute function tohyee_rd_forbid('Usage log entries');

-- Every version of every R&D record: what it was, who saved it and when
-- (RD23). Append-only.
create table rd_history (
  id bigserial primary key,
  record_type text not null
    check (record_type in ('activity', 'approval', 'tag', 'asset_usage', 'asset_tax_depreciation', 'file')),
  record_id text not null check (length(record_id) between 1 and 60),
  version integer not null check (version > 0),
  action text not null check (action in ('created', 'changed', 'archived', 'restored', 'withdrawn', 'removed', 'replaced')),
  snapshot jsonb not null,
  changed_by_user_id uuid,
  changed_by_email text not null,
  created_at timestamptz not null default now(),
  unique (record_type, record_id, version)
);
create trigger rd_history_stamp before insert on rd_history
  for each row execute function tohyee_rd_stamp_created();
create trigger rd_history_append_only before update or delete on rd_history
  for each row execute function tohyee_rd_forbid('R&D history');
create trigger rd_history_no_truncate before truncate on rd_history
  for each statement execute function tohyee_rd_forbid('R&D history');

-- Payroll's hook (P1b): an allocation line's R&D activity is now a real
-- reference to the register. Pay runs don't tag R&D yet (P3).
alter table payroll_cost_allocation_lines
  add constraint payroll_cost_allocation_lines_rd_activity_fkey foreign key (rd_activity_id) references rd_activities(id);
create index payroll_cost_allocation_lines_rd_activity_idx on payroll_cost_allocation_lines (rd_activity_id)
  where rd_activity_id is not null;
`,
  },
  {
    version: "0058",
    name: "payroll_pay_runs",
    sql: `
-- Payroll stage P3 (examples PRUN1-PRUN11): pay items, pay runs, and the
-- accounts an approved pay run posts to. Approving posts one journal dated
-- the pay date; approved pay runs are never changed, only voided.

-- The accounts pay runs credit (PRUN1), marked by role so they can be
-- renamed or re-coded. New organisations get them with the starting chart;
-- existing ones get them here, at the code shown or the next free one (an
-- existing 2200 liability is taken as PAYE payable).
update accounts set system_key = 'paye_payable', updated_at = now()
 where lower(code) = '2200' and account_class = 'liability' and system_key is null and currency_code is null
   and not exists (select 1 from accounts where system_key = 'paye_payable');
insert into accounts (code, name, account_class, account_type, system_key)
select (select min(c)::text from generate_series(2200, 2299) c where not exists (select 1 from accounts where lower(code) = c::text)),
       'PAYE payable', 'liability', 'current_liability', 'paye_payable'
 where exists (select 1 from accounts)
   and not exists (select 1 from accounts where system_key = 'paye_payable');
insert into accounts (code, name, account_class, account_type, system_key)
select (select min(c)::text from generate_series(2210, 2299) c where not exists (select 1 from accounts where lower(code) = c::text)),
       'KiwiSaver payable', 'liability', 'current_liability', 'kiwisaver_payable'
 where exists (select 1 from accounts)
   and not exists (select 1 from accounts where system_key = 'kiwisaver_payable');
insert into accounts (code, name, account_class, account_type, system_key)
select (select min(c)::text from generate_series(2220, 2299) c where not exists (select 1 from accounts where lower(code) = c::text)),
       'ESCT payable', 'liability', 'current_liability', 'esct_payable'
 where exists (select 1 from accounts)
   and not exists (select 1 from accounts where system_key = 'esct_payable');
insert into accounts (code, name, account_class, account_type, system_key)
select (select min(c)::text from generate_series(2230, 2299) c where not exists (select 1 from accounts where lower(code) = c::text)),
       'Student loan payable', 'liability', 'current_liability', 'student_loan_payable'
 where exists (select 1 from accounts)
   and not exists (select 1 from accounts where system_key = 'student_loan_payable');
insert into accounts (code, name, account_class, account_type, system_key)
select (select min(c)::text from generate_series(2240, 2299) c where not exists (select 1 from accounts where lower(code) = c::text)),
       'Wages payable', 'liability', 'current_liability', 'wages_payable'
 where exists (select 1 from accounts)
   and not exists (select 1 from accounts where system_key = 'wages_payable');
insert into accounts (code, name, account_class, account_type, system_key)
select (select min(c)::text from generate_series(2250, 2299) c where not exists (select 1 from accounts where lower(code) = c::text)),
       'Payroll deductions payable', 'liability', 'current_liability', 'payroll_deductions_payable'
 where exists (select 1 from accounts)
   and not exists (select 1 from accounts where system_key = 'payroll_deductions_payable');

alter table ledger_journals drop constraint ledger_journals_origin_check;
alter table ledger_journals add constraint ledger_journals_origin_check
  check (origin in ('manual', 'correction', 'inventory', 'fx_revaluation', 'invoice', 'customer_payment', 'bill',
                    'supplier_payment', 'sales_credit_note', 'sales_credit_note_refund',
                    'supplier_credit_note', 'supplier_credit_note_refund', 'customer_overpayment_refund',
                    'bank_transaction', 'bank_transfer', 'customer_payment_batch', 'supplier_payment_batch',
                    'expense_claim', 'expense_claim_payment', 'fixed_asset_depreciation', 'fixed_asset_disposal',
                    'opening_balance', 'payroll'));

-- PRUN7: optionally, whoever approves a pay run must not have prepared it.
alter table organisation_settings add column payroll_approver_must_differ boolean not null default false;

-- The employee's ESCT rate (spec 5.21), needed when they get employer
-- KiwiSaver contributions. Checked against IRD's bands for the pay date.
alter table payroll_employees add column esct_rate numeric(5,2) check (esct_rate is null or esct_rate between 0 and 100);

-- Pay items (PRUN10): earnings, after-tax deductions and the KiwiSaver
-- employer contribution, each with its account and its tax treatment per
-- IRD's spec. Taxable means PAYE, the ACC earners' levy and student loan
-- together; the kind fixes what can vary. An account can be missing (an
-- organisation whose chart didn't have it); pay runs refuse until it's set.
create table payroll_pay_items (
  id uuid primary key default gen_random_uuid(),
  idempotency_key text not null unique,
  request_hash text not null,
  name text not null check (length(btrim(name)) between 1 and 100),
  category text not null check (category in ('earnings', 'deduction', 'employer_contribution')),
  kind text not null check (kind in ('ordinary_time', 'overtime', 'allowance', 'holiday_pay', 'reimbursement',
                                     'after_tax_deduction', 'kiwisaver_employer')),
  account_id bigint references accounts(id),
  rate_multiplier numeric(6,4) check (rate_multiplier is null or rate_multiplier > 0),
  subject_to_paye boolean not null,
  subject_to_acc_levy boolean not null,
  subject_to_student_loan boolean not null,
  subject_to_kiwisaver boolean not null,
  subject_to_esct boolean not null,
  is_system boolean not null default false,
  is_archived boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((category = 'earnings') = (kind in ('ordinary_time', 'overtime', 'allowance', 'holiday_pay', 'reimbursement'))),
  check ((category = 'deduction') = (kind = 'after_tax_deduction')),
  check ((category = 'employer_contribution') = (kind = 'kiwisaver_employer')),
  check (subject_to_acc_levy = subject_to_paye and subject_to_student_loan = subject_to_paye),
  check (not subject_to_kiwisaver or subject_to_paye),
  check (subject_to_esct = (category = 'employer_contribution')),
  check (kind not in ('ordinary_time', 'overtime', 'holiday_pay') or (subject_to_paye and subject_to_kiwisaver)),
  check (kind not in ('reimbursement', 'after_tax_deduction', 'kiwisaver_employer') or not subject_to_paye),
  check ((rate_multiplier is not null) = (kind = 'overtime')),
  check (not is_system or (kind in ('ordinary_time', 'kiwisaver_employer') and not is_archived))
);
create unique index payroll_pay_items_name_idx on payroll_pay_items (lower(name));
create unique index payroll_pay_items_system_idx on payroll_pay_items (kind) where is_system;
create trigger payroll_pay_items_no_delete
  before delete on payroll_pay_items
  for each row execute function tohyee_payroll_forbid_delete('Pay items can''t be deleted; archive them instead');
create trigger payroll_pay_items_no_truncate
  before truncate on payroll_pay_items
  for each statement execute function tohyee_payroll_forbid_delete('Pay items can''t be deleted; archive them instead');

-- The starting pay items (PRUN10), once, mapped to the starting chart's
-- accounts where the organisation has them. Called here for existing
-- organisations and by provisioning after the starting chart.
create function tohyee_seed_payroll_pay_items() returns void
language plpgsql as $$
declare
  wages bigint := (select id from accounts where lower(code) = '6200' and account_class = 'expense' and currency_code is null);
  kiwisaver bigint := (select id from accounts where lower(code) = '6210' and account_class = 'expense' and currency_code is null);
  general bigint := (select id from accounts where lower(code) = '6070' and account_class = 'expense' and currency_code is null);
  deductions bigint := (select id from accounts where system_key = 'payroll_deductions_payable');
begin
  if exists (select 1 from payroll_pay_items) then
    return;
  end if;
  insert into payroll_pay_items (
    idempotency_key, request_hash, name, category, kind, account_id, rate_multiplier,
    subject_to_paye, subject_to_acc_levy, subject_to_student_loan, subject_to_kiwisaver, subject_to_esct, is_system
  ) values
    ('system:ordinary-time', 'system', 'Ordinary time', 'earnings', 'ordinary_time', wages, null, true, true, true, true, false, true),
    ('system:overtime', 'system', 'Overtime', 'earnings', 'overtime', wages, 1.5, true, true, true, true, false, false),
    ('system:allowance', 'system', 'Allowance (taxable)', 'earnings', 'allowance', wages, null, true, true, true, true, false, false),
    ('system:holiday-pay', 'system', 'Holiday pay', 'earnings', 'holiday_pay', wages, null, true, true, true, true, false, false),
    ('system:reimbursement', 'system', 'Reimbursement', 'earnings', 'reimbursement', general, null, false, false, false, false, false, false),
    ('system:union-fees', 'system', 'Union fees', 'deduction', 'after_tax_deduction', deductions, null, false, false, false, false, false, false),
    ('system:kiwisaver-employer', 'system', 'KiwiSaver employer contribution', 'employer_contribution', 'kiwisaver_employer', kiwisaver, null,
     false, false, false, false, true, true);
end;
$$;
select tohyee_seed_payroll_pay_items() where exists (select 1 from accounts);

-- Pay runs (PRUN1-PRUN11): one pay group, one pay period, one pay date.
-- A draft can be changed or deleted; approving posts one journal and keeps
-- a copy of what each employee's pay was calculated from; voiding posts its
-- exact reversal. Only one pay run (not voided) per group and period.
create table payroll_pay_runs (
  id uuid primary key default gen_random_uuid(),
  run_number bigserial not null unique,
  command_source text not null,
  idempotency_key text not null,
  request_hash text not null,
  pay_group_id uuid not null references payroll_pay_groups(id),
  pay_frequency text not null check (pay_frequency in ('weekly', 'fortnightly', 'four_weekly', 'monthly')),
  period_start date not null,
  period_end date not null,
  pay_date date not null,
  status text not null default 'draft' check (status in ('draft', 'approved', 'voided')),
  created_by_user_id uuid,
  created_by_email text not null,
  -- Everyone who created or changed the draft (PRUN7).
  prepared_by_user_ids uuid[] not null default '{}',
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
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (command_source, idempotency_key),
  unique (approve_command_source, approve_idempotency_key),
  unique (void_command_source, void_idempotency_key),
  check (period_end >= period_start),
  check (pay_date >= period_start),
  check ((status = 'draft') = (approval_journal_id is null and approved_at is null)),
  check ((status = 'voided') = (void_journal_id is not null and void_date is not null and voided_at is not null)),
  check (void_date is null or void_date >= pay_date)
);
create unique index payroll_pay_runs_period_idx on payroll_pay_runs (pay_group_id, period_start) where status <> 'voided';
create index payroll_pay_runs_pay_date_idx on payroll_pay_runs (pay_date desc, run_number desc);

-- Each employee on a pay run. While it's a draft, pay is calculated from
-- their current details; approving copies what it was calculated from and
-- the results here.
create table payroll_pay_run_employees (
  pay_run_id uuid not null references payroll_pay_runs(id),
  employee_id uuid not null references payroll_employees(id),
  employee_name text check (employee_name is null or length(employee_name) between 1 and 201),
  tax_code text,
  student_loan boolean,
  kiwisaver_status text,
  kiwisaver_employee_rate numeric(5,2),
  kiwisaver_employer_rate numeric(5,2),
  esct_rate numeric(5,2),
  gross numeric(16,2),
  taxable_earnings numeric(16,2),
  non_taxable_earnings numeric(16,2),
  kiwisaver_earnings numeric(16,2),
  paye numeric(16,2),
  student_loan_deduction numeric(16,2),
  kiwisaver_employee numeric(16,2),
  deductions numeric(16,2),
  net_pay numeric(16,2),
  kiwisaver_employer numeric(16,2),
  esct numeric(16,2),
  kiwisaver_employer_net numeric(16,2),
  employer_cost numeric(16,2),
  primary key (pay_run_id, employee_id)
);
create index payroll_pay_run_employees_employee_idx on payroll_pay_run_employees (employee_id);

-- Earnings and deductions per employee (PRUN2): hours x rate (rounded half
-- up once) or an amount.
create table payroll_pay_run_lines (
  pay_run_id uuid not null,
  employee_id uuid not null,
  line_number integer not null check (line_number between 1 and 200),
  pay_item_id uuid not null references payroll_pay_items(id),
  quantity numeric(10,2) check (quantity is null or quantity >= 0),
  rate numeric(18,6) check (rate is null or rate >= 0),
  amount numeric(16,2) not null check (amount >= 0),
  description text check (description is null or length(btrim(description)) between 1 and 200),
  primary key (pay_run_id, employee_id, line_number),
  foreign key (pay_run_id, employee_id) references payroll_pay_run_employees(pay_run_id, employee_id),
  check ((quantity is null) = (rate is null)),
  check (quantity is null or amount = round(quantity * rate, 2))
);

-- Each employee's share of each debit line of the pay run's journal
-- (PRUN1): who, which pay item, account, tracking and project. Only people
-- with payroll access see these; the journal shows totals.
create table payroll_pay_run_postings (
  pay_run_id uuid not null references payroll_pay_runs(id),
  posting_number integer not null check (posting_number > 0),
  employee_id uuid not null references payroll_employees(id),
  pay_item_id uuid not null references payroll_pay_items(id),
  account_id bigint not null references accounts(id),
  tracking jsonb not null default '{}'::jsonb,
  project_id bigint references projects(id),
  percentage numeric(5,2) not null check (percentage > 0 and percentage <= 100),
  amount numeric(16,2) not null check (amount >= 0),
  journal_line_order integer not null check (journal_line_order > 0),
  primary key (pay_run_id, posting_number)
);
create index payroll_pay_run_postings_employee_idx on payroll_pay_run_postings (employee_id);
create trigger payroll_pay_run_postings_append_only
  before update or delete on payroll_pay_run_postings
  for each row execute function tohyee_payroll_append_only('Pay run postings');
create trigger payroll_pay_run_postings_no_truncate
  before truncate on payroll_pay_run_postings
  for each statement execute function tohyee_payroll_append_only('Pay run postings');

-- A draft can change; an approved pay run can only be voided; a voided one
-- never changes (PRUN6). Only drafts can be deleted.
create function tohyee_guard_payroll_pay_run() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    if old.status <> 'draft' then
      raise exception 'An approved or voided pay run can''t be deleted' using errcode = 'P0001';
    end if;
    return old;
  end if;
  if old.status = 'draft' then
    return new;
  end if;
  if old.status = 'approved' and new.status = 'voided'
     and (new.id, new.run_number, new.command_source, new.idempotency_key, new.request_hash, new.pay_group_id,
          new.pay_frequency, new.period_start, new.period_end, new.pay_date, new.created_by_user_id,
          new.created_by_email, new.prepared_by_user_ids, new.approval_journal_id, new.approve_command_source,
          new.approve_idempotency_key, new.approve_request_hash, new.approved_by_user_id, new.approved_by_email,
          new.approved_at, new.created_at)
         is not distinct from
         (old.id, old.run_number, old.command_source, old.idempotency_key, old.request_hash, old.pay_group_id,
          old.pay_frequency, old.period_start, old.period_end, old.pay_date, old.created_by_user_id,
          old.created_by_email, old.prepared_by_user_ids, old.approval_journal_id, old.approve_command_source,
          old.approve_idempotency_key, old.approve_request_hash, old.approved_by_user_id, old.approved_by_email,
          old.approved_at, old.created_at) then
    return new;
  end if;
  raise exception 'An approved or voided pay run can''t be changed' using errcode = 'P0001';
end;
$$;
create trigger payroll_pay_runs_guard
  before update or delete on payroll_pay_runs
  for each row execute function tohyee_guard_payroll_pay_run();
create trigger payroll_pay_runs_no_truncate
  before truncate on payroll_pay_runs
  for each statement execute function tohyee_payroll_forbid_delete('Pay runs can''t be truncated');

-- An approved or voided pay run's employees and lines never change.
create function tohyee_guard_payroll_pay_run_detail() returns trigger
language plpgsql as $$
declare
  run_id uuid;
  run_status text;
begin
  if tg_op = 'DELETE' then
    run_id := old.pay_run_id;
  else
    run_id := new.pay_run_id;
  end if;
  select status into run_status from payroll_pay_runs where id = run_id;
  if run_status is not null and run_status <> 'draft' then
    raise exception 'An approved or voided pay run can''t be changed' using errcode = 'P0001';
  end if;
  if tg_op = 'UPDATE' and new.pay_run_id <> old.pay_run_id then
    raise exception 'A pay run''s lines can''t move to another pay run' using errcode = 'P0001';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;
create trigger payroll_pay_run_employees_guard
  before insert or update or delete on payroll_pay_run_employees
  for each row execute function tohyee_guard_payroll_pay_run_detail();
create trigger payroll_pay_run_employees_no_truncate
  before truncate on payroll_pay_run_employees
  for each statement execute function tohyee_payroll_forbid_delete('Pay runs can''t be truncated');
create trigger payroll_pay_run_lines_guard
  before insert or update or delete on payroll_pay_run_lines
  for each row execute function tohyee_guard_payroll_pay_run_detail();
create trigger payroll_pay_run_lines_no_truncate
  before truncate on payroll_pay_run_lines
  for each statement execute function tohyee_payroll_forbid_delete('Pay runs can''t be truncated');
`,
  },
  {
    version: "0062",
    name: "payroll_payments",
    sql: `
-- Payroll stage P4 (examples PPAY1-PPAY12): paying the net wages of an
-- approved pay run and paying IRD the deductions the pay runs credited.
-- Each payment posts one journal; it's undone only by voiding it (the exact
-- reversal). Payments are never edited or deleted.

-- How often the organisation pays IRD (PPAY4, PPAY9): monthly, or twice a
-- month for employers whose gross annual PAYE and ESCT is $500,000 or more.
alter table organisation_settings add column payroll_ird_payment_frequency text not null default 'monthly'
  check (payroll_ird_payment_frequency in ('monthly', 'twice_monthly'));

-- Wage payments (PPAY1-PPAY3): Dr wages payable, Cr the bank. For the whole
-- pay run (employee_id null) or one employee on it, never both on one run.
create table payroll_wage_payments (
  id uuid primary key default gen_random_uuid(),
  payment_number bigserial not null unique,
  command_source text not null,
  idempotency_key text not null,
  request_hash text not null,
  pay_run_id uuid not null references payroll_pay_runs(id),
  employee_id uuid,
  payment_date date not null,
  bank_account_id bigint not null references accounts(id),
  amount numeric(16,2) not null check (amount > 0),
  journal_id bigint not null unique references ledger_journals(id),
  status text not null default 'active' check (status in ('active', 'voided')),
  created_by_user_id uuid,
  created_by_email text not null,
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
  foreign key (pay_run_id, employee_id) references payroll_pay_run_employees(pay_run_id, employee_id),
  check ((status = 'voided') = (void_journal_id is not null and void_date is not null and voided_at is not null)),
  check (void_date is null or void_date >= payment_date)
);
create index payroll_wage_payments_run_idx on payroll_wage_payments (pay_run_id);

-- A payment is for an approved pay run, on or after its pay date, never more
-- than what's unpaid (in total, or for that employee), and a run is paid
-- either as a whole or per employee. The service checks first, with the pay
-- run locked; this keeps the rule if it doesn't.
create function tohyee_check_payroll_wage_payment() returns trigger
language plpgsql as $$
declare
  run record;
  net numeric;
  paid numeric;
begin
  select status, pay_date into run from payroll_pay_runs where id = new.pay_run_id;
  if run.status is distinct from 'approved' then
    raise exception 'Only an approved pay run''s wages can be paid' using errcode = 'P0001';
  end if;
  if new.payment_date < run.pay_date then
    raise exception 'A wage payment can''t be dated before its pay run''s pay date' using errcode = 'P0001';
  end if;
  if exists (select 1 from payroll_wage_payments p
              where p.pay_run_id = new.pay_run_id and p.status = 'active' and (p.employee_id is null) <> (new.employee_id is null)) then
    raise exception 'A pay run is paid either as a whole or per employee, not both' using errcode = 'P0001';
  end if;
  select coalesce(sum(net_pay), 0) into net from payroll_pay_run_employees
   where pay_run_id = new.pay_run_id and (new.employee_id is null or employee_id = new.employee_id);
  select coalesce(sum(amount), 0) into paid from payroll_wage_payments
   where pay_run_id = new.pay_run_id and status = 'active' and (new.employee_id is null or employee_id = new.employee_id);
  if paid + new.amount > net then
    raise exception 'A wage payment can''t be more than the net pay left to pay' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger payroll_wage_payments_check
  before insert on payroll_wage_payments
  for each row execute function tohyee_check_payroll_wage_payment();

-- Payments are never edited or deleted; the only change is voiding one, once.
create function tohyee_guard_payroll_payment() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Payroll payments can''t be deleted; void them instead' using errcode = 'P0001';
  end if;
  if old.status = 'active' and new.status = 'voided'
     and (to_jsonb(new) - array['status', 'void_date', 'void_journal_id', 'void_command_source', 'void_idempotency_key',
                                'void_request_hash', 'voided_by_user_id', 'voided_by_email', 'voided_at'])
         = (to_jsonb(old) - array['status', 'void_date', 'void_journal_id', 'void_command_source', 'void_idempotency_key',
                                  'void_request_hash', 'voided_by_user_id', 'voided_by_email', 'voided_at']) then
    return new;
  end if;
  raise exception 'Payroll payments can''t be changed; void them instead' using errcode = 'P0001';
end;
$$;
create trigger payroll_wage_payments_guard
  before update or delete on payroll_wage_payments
  for each row execute function tohyee_guard_payroll_payment();
create trigger payroll_wage_payments_no_truncate
  before truncate on payroll_wage_payments
  for each statement execute function tohyee_payroll_forbid_delete('Payroll payments can''t be deleted; void them instead');

-- IRD payroll payments (PPAY4-PPAY9): for one IRD period (by pay date), Dr
-- each liability paid, Cr the bank. Lines are the liabilities and amounts.
create table payroll_ird_payments (
  id uuid primary key default gen_random_uuid(),
  payment_number bigserial not null unique,
  command_source text not null,
  idempotency_key text not null,
  request_hash text not null,
  frequency text not null check (frequency in ('monthly', 'twice_monthly')),
  period_start date not null,
  period_end date not null,
  payment_date date not null,
  bank_account_id bigint not null references accounts(id),
  amount numeric(16,2) not null check (amount > 0),
  journal_id bigint not null unique references ledger_journals(id),
  status text not null default 'active' check (status in ('active', 'voided')),
  created_by_user_id uuid,
  created_by_email text not null,
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
  check (period_end >= period_start),
  check (payment_date >= period_start),
  check ((status = 'voided') = (void_journal_id is not null and void_date is not null and voided_at is not null)),
  check (void_date is null or void_date >= payment_date)
);
create index payroll_ird_payments_period_idx on payroll_ird_payments (period_start, period_end);
create trigger payroll_ird_payments_guard
  before update or delete on payroll_ird_payments
  for each row execute function tohyee_guard_payroll_payment();
create trigger payroll_ird_payments_no_truncate
  before truncate on payroll_ird_payments
  for each statement execute function tohyee_payroll_forbid_delete('Payroll payments can''t be deleted; void them instead');

create table payroll_ird_payment_lines (
  ird_payment_id uuid not null references payroll_ird_payments(id),
  liability text not null check (liability in ('paye', 'student_loan', 'kiwisaver', 'esct')),
  account_id bigint not null references accounts(id),
  amount numeric(16,2) not null check (amount > 0),
  primary key (ird_payment_id, liability)
);
create trigger payroll_ird_payment_lines_append_only
  before update or delete on payroll_ird_payment_lines
  for each row execute function tohyee_payroll_append_only('IRD payment lines');
create trigger payroll_ird_payment_lines_no_truncate
  before truncate on payroll_ird_payment_lines
  for each statement execute function tohyee_payroll_append_only('IRD payment lines');

-- An IRD payment's lines add up to it (checked at commit).
create function tohyee_check_payroll_ird_payment_total() returns trigger
language plpgsql as $$
declare
  payment_id uuid;
  expected numeric;
  total numeric;
  line_count integer;
begin
  if tg_table_name = 'payroll_ird_payment_lines' then
    payment_id := (to_jsonb(new) ->> 'ird_payment_id')::uuid;
  else
    payment_id := (to_jsonb(new) ->> 'id')::uuid;
  end if;
  select amount into expected from payroll_ird_payments where id = payment_id;
  select coalesce(sum(amount), 0), count(*) into total, line_count from payroll_ird_payment_lines where ird_payment_id = payment_id;
  if line_count = 0 or total <> expected then
    raise exception 'An IRD payment''s lines must add up to its amount' using errcode = 'P0001';
  end if;
  return null;
end;
$$;
create constraint trigger payroll_ird_payments_total
  after insert on payroll_ird_payments deferrable initially deferred
  for each row execute function tohyee_check_payroll_ird_payment_total();
create constraint trigger payroll_ird_payment_lines_total
  after insert on payroll_ird_payment_lines deferrable initially deferred
  for each row execute function tohyee_check_payroll_ird_payment_total();

-- A pay run can't be voided while it has active wage payments, or while an
-- active IRD payment pays the period its pay date is in (PPAY3, PPAY12).
create function tohyee_check_payroll_pay_run_void() returns trigger
language plpgsql as $$
begin
  if old.status = 'approved' and new.status = 'voided' then
    if exists (select 1 from payroll_wage_payments where pay_run_id = old.id and status = 'active') then
      raise exception 'A pay run with wage payments can''t be voided; void the payments first' using errcode = 'P0001';
    end if;
    if exists (select 1 from payroll_ird_payments
                where status = 'active' and period_start <= old.pay_date and period_end >= old.pay_date) then
      raise exception 'A pay run whose IRD period has IRD payments can''t be voided; void the IRD payments first' using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$;
create trigger payroll_pay_runs_void_check
  before update on payroll_pay_runs
  for each row execute function tohyee_check_payroll_pay_run_void();
`,
  },
  {
    version: "0061",
    name: "sales_platform_orders",
    sql: `
-- Sales platform connections, stage 2 (examples SPC11-SPC23, decisions
-- 51-55): Shopify orders, payments, refunds and payouts into the accounts.
-- The connection's posting settings, which Tohyee tax code each Shopify tax
-- rate is, and which Tohyee documents each Shopify order, refund and payout
-- became. Versions 0051-0060 are taken or reserved by other branches.
alter table sales_platform_connections
  add column post_to_accounts boolean not null default false,
  add column start_date date,
  add column clearing_account_id bigint references accounts(id),
  add column payout_account_id bigint references accounts(id),
  add column fees_account_id bigint references accounts(id),
  add column sales_account_id bigint references accounts(id),
  add column shipping_account_id bigint references accounts(id),
  add column untaxed_tax_code_id bigint references tax_codes(id),
  -- The access scopes the store gave the app, as it last said.
  add column granted_scopes text[] not null default '{}',
  add column orders_synced_until timestamptz,
  add column payouts_synced_until timestamptz,
  add constraint sales_platform_connections_posting_check check (
    not post_to_accounts or (start_date is not null and clearing_account_id is not null and payout_account_id is not null
      and fees_account_id is not null and sales_account_id is not null and shipping_account_id is not null)
  );

-- Shopify's tax rate (as a fraction, 0.15) -> Tohyee's tax code.
create table sales_platform_tax_codes (
  connection_id bigint not null references sales_platform_connections(id),
  rate numeric(9, 6) not null check (rate > 0 and rate < 1),
  tax_code_id bigint not null references tax_codes(id),
  primary key (connection_id, rate)
);

-- Which Tohyee documents each platform order, refund and payout became.
-- Keyed by the store rather than the connection and kept after
-- disconnecting, so connecting the store again never brings an order in
-- twice.
create table sales_platform_documents (
  id bigserial primary key,
  platform text not null check (platform in ('shopify')),
  store_domain text not null check (store_domain = lower(store_domain) and length(store_domain) between 1 and 255),
  record_kind text not null check (record_kind in ('order', 'refund', 'payout')),
  external_id text not null check (length(external_id) between 1 and 100),
  -- A refund's order.
  order_external_id text check (order_external_id is null or length(order_external_id) <= 100),
  connection_id bigint not null references sales_platform_connections(id),
  name text check (name is null or length(name) <= 100),
  state text not null check (state in ('open', 'done', 'cancelled')),
  -- Something stopped it part way (e.g. a locked period): the catch-up sync tries again.
  retry boolean not null default false,
  contact_id bigint references contacts(id),
  sales_order_id bigint references sales_orders(id),
  invoice_id bigint references sales_invoices(id),
  customer_payment_id bigint references customer_payments(id),
  credit_note_id bigint references sales_credit_notes(id),
  credit_note_refund_id bigint references sales_credit_note_refunds(id),
  transfer_id bigint references bank_transfers(id),
  bank_transaction_id bigint references bank_transactions(id),
  external_updated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((record_kind = 'refund') = (order_external_id is not null)),
  unique (platform, store_domain, record_kind, external_id)
);
create index sales_platform_documents_retry_idx on sales_platform_documents (connection_id) where retry;

-- The sync log names the documents posted, and orders, refunds and payouts.
alter table sales_platform_sync_log drop constraint sales_platform_sync_log_action_check;
alter table sales_platform_sync_log add constraint sales_platform_sync_log_action_check check (action in (
  'connected', 'tested', 'settings', 'webhooks', 'disconnected', 'sync',
  'created', 'linked', 'updated', 'kept', 'skipped', 'failed', 'posted', 'cancelled', 'waiting'));
alter table sales_platform_sync_log drop constraint sales_platform_sync_log_record_kind_check;
alter table sales_platform_sync_log add constraint sales_platform_sync_log_record_kind_check check (
  record_kind is null or record_kind in ('customer', 'product_variant', 'order', 'refund', 'payout'));
alter table sales_platform_sync_log
  add column document_type text check (document_type is null or document_type in (
    'sales_order', 'invoice', 'customer_payment', 'credit_note', 'credit_note_refund', 'transfer', 'bank_transaction')),
  add column document_id bigint,
  add constraint sales_platform_sync_log_document_check check ((document_type is null) = (document_id is null));
`,
  },
  {
    version: "0063",
    name: "payroll_bank_files_and_payslips",
    sql: `
-- Payroll stage P5 (examples PBF1-PBF7, PSLIP1-PSLIP6).

-- Bank direct credit files (PBF7): each bank account's own account number
-- and the bank's file format, chosen by an admin. Not secret (it's on every
-- invoice), so not encrypted. Westpac and Kiwibank aren't offered: neither
-- publishes a field-level specification.
alter table bank_account_settings
  add column direct_credit_format text
    check (direct_credit_format in ('anz_domestic_extended', 'asb_mt9', 'bnz_ib4b')),
  add column direct_credit_account_number text
    check (direct_credit_account_number is null or direct_credit_account_number ~ '^[0-9]{2}-[0-9]{4}-[0-9]{7}-[0-9]{2,3}$'),
  add column direct_credit_updated_by_email text,
  add column direct_credit_updated_at timestamptz,
  add constraint bank_account_settings_direct_credit_check
    check ((direct_credit_format is null) = (direct_credit_account_number is null));

-- Payslip emails (PSLIP5) go through the document email outbox. A payslip
-- is one employee on one approved pay run; it has no contact and no bigint
-- document id. The message never holds pay figures (it's fixed text), and
-- the PDF is written when the email is sent.
alter table document_emails
  alter column document_id drop not null,
  alter column contact_id drop not null,
  add column pay_run_id uuid references payroll_pay_runs(id),
  add column employee_id uuid references payroll_employees(id);
alter table document_emails drop constraint document_emails_document_kind_check;
alter table document_emails add constraint document_emails_document_kind_check
  check (document_kind in ('invoice', 'credit_note', 'quote', 'purchase_order', 'statement', 'payslip'));
alter table document_emails add constraint document_emails_payslip_check
  check (case when document_kind = 'payslip'
              then pay_run_id is not null and employee_id is not null and document_id is null
                   and contact_id is null and batch_id is null
              else pay_run_id is null and employee_id is null and document_id is not null and contact_id is not null end);
create index document_emails_payslip on document_emails (pay_run_id, employee_id, id) where pay_run_id is not null;

create or replace function tohyee_guard_document_email() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' or tg_op = 'TRUNCATE' then
    raise exception 'Emails are kept as a record of what was sent; they can''t be deleted' using errcode = 'P0001';
  end if;
  if old.status in ('sent', 'failed') then
    raise exception 'Email % has finished and can''t be changed; send it again instead', old.id using errcode = 'P0001';
  end if;
  if new.document_kind is distinct from old.document_kind or new.document_id is distinct from old.document_id
     or new.contact_id is distinct from old.contact_id or new.statement is distinct from old.statement
     or new.pay_run_id is distinct from old.pay_run_id or new.employee_id is distinct from old.employee_id
     or new.batch_id is distinct from old.batch_id or new.to_addresses is distinct from old.to_addresses
     or new.cc_addresses is distinct from old.cc_addresses or new.subject is distinct from old.subject
     or new.body is distinct from old.body or new.attachment_name is distinct from old.attachment_name
     or new.requested_by_email is distinct from old.requested_by_email
     or new.requested_by_user_id is distinct from old.requested_by_user_id or new.created_at is distinct from old.created_at
     or new.request_hash is distinct from old.request_hash or new.idempotency_key is distinct from old.idempotency_key then
    raise exception 'What an email says and who it goes to can''t change once it''s queued' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
`,
  },
  {
    version: "0064",
    name: "payroll_payday_filing_settings",
    sql: `
-- Payroll stage P6 (examples PF1-PF9, decision 62): the header details of
-- IRD's payday filing employment information file. Making a file stores
-- nothing else (decision 65). Version 0063 is taken by another branch.
alter table organisation_settings
  add column payroll_employer_ird_number text
    check (payroll_employer_ird_number ~ '^[0-9]{9}$' and payroll_employer_ird_number <> '000000000'),
  add column payroll_contact_name text
    check (char_length(payroll_contact_name) between 1 and 20 and position(',' in payroll_contact_name) = 0),
  add column payroll_contact_phone text check (payroll_contact_phone ~ '^[0-9A-Za-z]{1,12}$'),
  add column payroll_contact_email text
    check (char_length(payroll_contact_email) <= 60 and payroll_contact_email ~ '^[A-Za-z0-9@_.-]+$');
`,
  },
  {
    version: "0065",
    name: "rdti_claim_report",
    sql: `
-- R&D Tax Incentive, stage R3 (docs/ACCOUNTING-EXAMPLES.md RD10, RD23,
-- RD34, RD35, RD42; docs/DECISIONS.md 46, 58, 64): overhead rules ("% of an
-- account" to an activity, with a basis and the workings attached), applied
-- when the claim report runs; nothing here posts or changes an amount. The
-- claim report records each export's summary in rd_history.

alter table rd_history drop constraint rd_history_record_type_check;
alter table rd_history add constraint rd_history_record_type_check check (record_type in (
  'activity', 'approval', 'tag', 'asset_usage', 'asset_tax_depreciation', 'file', 'overhead_rule', 'claim_export'));
alter table rd_history drop constraint rd_history_action_check;
alter table rd_history add constraint rd_history_action_check check (action in (
  'created', 'changed', 'archived', 'restored', 'withdrawn', 'removed', 'replaced', 'ended', 'exported'));
alter table rd_files drop constraint rd_files_record_type_check;
alter table rd_files add constraint rd_files_record_type_check check (record_type in ('activity', 'approval', 'tag', 'asset', 'overhead_rule'));

-- An overhead rule (RD10, RD34): percentage of every posted line on an
-- expense account, dated in the rule's period, to one activity, with a basis
-- from IR1240 p 15's list and a description of the calculation. Changing a
-- rule adds a new one that replaces it (RD35): from the same start the old
-- one is marked replaced; from a later date the old one ends the day before.
-- Rules are never deleted.
create table rd_overhead_rules (
  id uuid primary key default gen_random_uuid(),
  idempotency_key text not null unique,
  request_hash text not null,
  account_id bigint not null references accounts(id),
  activity_id uuid not null references rd_activities(id),
  percentage numeric(5,2) not null check (percentage > 0 and percentage <= 100),
  basis text not null check (basis in ('time', 'floor_area', 'usage', 'volume', 'unit_sales', 'dollar_value', 'activity_based_costing')),
  basis_detail text not null check (length(basis_detail) between 1 and 500 and basis_detail = btrim(basis_detail)),
  effective_from date not null,
  effective_to date check (effective_to is null or effective_to >= effective_from),
  replaces_id uuid unique references rd_overhead_rules(id),
  status text not null default 'active' check (status in ('active', 'replaced')),
  replaced_at timestamptz,
  version integer not null default 1 check (version > 0),
  created_by_user_id uuid,
  created_by_email text not null,
  created_at timestamptz not null default now(),
  updated_by_user_id uuid,
  updated_by_email text not null,
  updated_at timestamptz not null default now(),
  check ((status = 'replaced') = (replaced_at is not null)),
  check (replaces_id is null or replaces_id <> id)
);
create index rd_overhead_rules_account_idx on rd_overhead_rules (account_id, effective_from) where status = 'active';

-- What a rule applies to never changes; only its end date (ending it, or a
-- change from a later date) and being replaced. A replaced rule stays so.
create function tohyee_guard_rd_overhead_rule() returns trigger
language plpgsql as $$
begin
  if old.status = 'replaced'
     or (new.idempotency_key, new.request_hash, new.account_id, new.activity_id, new.percentage, new.basis, new.basis_detail,
         new.effective_from, new.replaces_id)
        is distinct from (old.idempotency_key, old.request_hash, old.account_id, old.activity_id, old.percentage, old.basis,
                          old.basis_detail, old.effective_from, old.replaces_id) then
    raise exception 'An overhead rule is kept as entered; change it by adding a rule that replaces it' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger rd_overhead_rules_guard before update on rd_overhead_rules
  for each row execute function tohyee_guard_rd_overhead_rule();
create trigger rd_overhead_rules_stamp before insert or update on rd_overhead_rules
  for each row execute function tohyee_rd_stamp_changed();
create trigger rd_overhead_rules_no_delete before delete on rd_overhead_rules
  for each row execute function tohyee_rd_forbid('Overhead rules');
create trigger rd_overhead_rules_no_truncate before truncate on rd_overhead_rules
  for each statement execute function tohyee_rd_forbid('Overhead rules');

-- The workings are required (decision 46): a rule can't be saved without them.
create function tohyee_check_rd_overhead_rule() returns trigger
language plpgsql as $$
begin
  if not exists (select 1 from rd_files where record_type = 'overhead_rule' and record_id = new.id::text and purpose = 'workings') then
    raise exception 'An overhead rule needs its workings attached' using errcode = '23514';
  end if;
  return null;
end;
$$;
create constraint trigger rd_overhead_rules_workings
  after insert on rd_overhead_rules
  deferrable initially deferred
  for each row execute function tohyee_check_rd_overhead_rule();
`,
  },
  {
    version: "0066",
    name: "crm_opportunity_stages",
    sql: `
-- Editable opportunity stages, probability, forecast categories, sales
-- processes and quotas (examples CRMS1-CRMS11, decisions 76-90), after
-- Salesforce's Stage picklist, Probability and Forecast Category fields,
-- sales processes and forecast quotas. The six fixed stages become the
-- organisation's starting stages and keep their keys, so saved
-- opportunities, the API and the history keep working.
create table crm_opportunity_stages (
  id bigserial primary key,
  key text not null unique check (key ~ '^[a-z][a-z0-9_]{0,39}$'),
  name text not null check (length(name) between 1 and 40 and name = btrim(name)),
  sort_order integer not null,
  stage_type text not null check (stage_type in ('open', 'won', 'lost')),
  probability integer not null check (probability between 0 and 100),
  forecast_category text not null check (forecast_category in ('pipeline', 'best_case', 'commit', 'closed', 'omitted')),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (stage_type <> 'won' or (probability = 100 and forecast_category = 'closed')),
  check (stage_type <> 'lost' or (probability = 0 and forecast_category = 'omitted')),
  check (stage_type <> 'open' or forecast_category <> 'closed')
);
create unique index crm_opportunity_stages_name_idx on crm_opportunity_stages (lower(name));

insert into crm_opportunity_stages (key, name, sort_order, stage_type, probability, forecast_category) values
  ('new', 'New', 1, 'open', 10, 'pipeline'),
  ('screening', 'Screening', 2, 'open', 20, 'pipeline'),
  ('meeting', 'Meeting', 3, 'open', 50, 'pipeline'),
  ('proposal', 'Proposal', 4, 'open', 75, 'pipeline'),
  ('won', 'Won', 5, 'won', 100, 'closed'),
  ('lost', 'Lost', 6, 'lost', 0, 'omitted');

-- Stages are archived, never deleted; a key never changes; a stage's type
-- can't change while opportunities are in it; and at least one active
-- stage of each type stays (CRMS3).
create function tohyee_guard_crm_opportunity_stage() returns trigger
language plpgsql as $$
begin
  if tg_op in ('DELETE', 'TRUNCATE') then
    raise exception 'Opportunity stages are never deleted; archive one instead' using errcode = 'P0001';
  end if;
  if new.key <> old.key then
    raise exception 'A stage''s key can''t change' using errcode = 'P0001';
  end if;
  if new.stage_type <> old.stage_type and exists (select 1 from crm_opportunities where stage = old.key) then
    raise exception '% has opportunities, so its type can''t change', old.name using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger crm_opportunity_stages_guard before update or delete on crm_opportunity_stages
  for each row execute function tohyee_guard_crm_opportunity_stage();
create trigger crm_opportunity_stages_no_truncate before truncate on crm_opportunity_stages
  for each statement execute function tohyee_guard_crm_opportunity_stage();

create function tohyee_crm_stages_each_type() returns trigger
language plpgsql as $$
declare
  missing text;
begin
  select t into missing from unnest(array['open', 'won', 'lost']) t
   where not exists (select 1 from crm_opportunity_stages s where s.stage_type = t and s.is_active) limit 1;
  if missing is not null then
    raise exception 'At least one active % stage must stay', case missing when 'open' then 'Open' when 'won' then 'Closed won' else 'Closed lost' end
      using errcode = 'P0001';
  end if;
  return null;
end;
$$;
create constraint trigger crm_opportunity_stages_each_type after update on crm_opportunity_stages
  deferrable initially deferred for each row execute function tohyee_crm_stages_each_type();

-- Opportunities: the fixed list of stages becomes a reference to the
-- organisation's stages, and the "invoice only when won" check becomes
-- "invoice only in a Closed won stage" (CRMS4).
do $$
declare
  c record;
begin
  for c in select conname from pg_constraint
            where conrelid = 'crm_opportunities'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%stage%' loop
    execute format('alter table crm_opportunities drop constraint %I', c.conname);
  end loop;
end;
$$;
alter table crm_opportunities add constraint crm_opportunities_stage_fkey foreign key (stage) references crm_opportunity_stages (key);
create index crm_opportunities_stage_idx on crm_opportunities (stage);
create index crm_opportunities_close_date_idx on crm_opportunities (close_date);

-- Probability and forecast category start as the stage's (CRMS1).
alter table crm_opportunities add column probability integer check (probability between 0 and 100);
alter table crm_opportunities add column forecast_category text
  check (forecast_category in ('pipeline', 'best_case', 'commit', 'closed', 'omitted'));
update crm_opportunities o set probability = s.probability, forecast_category = s.forecast_category
  from crm_opportunity_stages s where s.key = o.stage;
alter table crm_opportunities alter column probability set not null;
alter table crm_opportunities alter column forecast_category set not null;

-- A won opportunity is 100% Closed, a lost one 0% Omitted, an open one never
-- Closed, and only a won one has an invoice (CRMS4, CRMS5). Missing values
-- come from the stage.
create function tohyee_crm_opportunity_stage_rules() returns trigger
language plpgsql as $$
declare
  s crm_opportunity_stages;
begin
  select * into s from crm_opportunity_stages where key = new.stage;
  if not found then
    raise exception 'There''s no stage called %', new.stage using errcode = 'P0001';
  end if;
  if new.probability is null then new.probability := s.probability; end if;
  if new.forecast_category is null then new.forecast_category := s.forecast_category; end if;
  if s.stage_type = 'won' and (new.probability <> 100 or new.forecast_category <> 'closed') then
    raise exception 'A won opportunity is 100%% and in the Closed forecast category' using errcode = 'P0001';
  end if;
  if s.stage_type = 'lost' and (new.probability <> 0 or new.forecast_category <> 'omitted') then
    raise exception 'A lost opportunity is 0%% and in the Omitted forecast category' using errcode = 'P0001';
  end if;
  if s.stage_type = 'open' and new.forecast_category = 'closed' then
    raise exception 'Only a won opportunity can be in the Closed forecast category' using errcode = 'P0001';
  end if;
  if new.invoice_id is not null and s.stage_type <> 'won' then
    raise exception 'Only a won opportunity can have an invoice' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger crm_opportunities_stage_rules before insert or update of stage, probability, forecast_category, invoice_id on crm_opportunities
  for each row execute function tohyee_crm_opportunity_stage_rules();

-- Once an opportunity has made an invoice it keeps that invoice and its
-- stage, whatever the stage is called now.
create or replace function tohyee_guard_crm_opportunity() returns trigger
language plpgsql as $$
begin
  if old.invoice_id is not null and (new.invoice_id is distinct from old.invoice_id or new.stage is distinct from old.stage) then
    raise exception 'This opportunity has made an invoice, so its stage can''t change' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

-- Sales processes (CRMS7): the stages an opportunity record type uses, in
-- the stages' own order; null means every active stage.
alter table crm_record_types add column stage_keys text[];
alter table crm_record_types add constraint crm_record_types_stage_keys_check
  check (stage_keys is null or (record = 'opportunity' and cardinality(stage_keys) between 3 and 100));

-- Quotas (CRMS10): per owner per month, in the base currency.
create table crm_forecast_quotas (
  id bigserial primary key,
  owner_user_id text not null check (length(owner_user_id) between 1 and 200),
  month date not null check (extract(day from month) = 1),
  amount numeric(20, 2) not null check (amount >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_user_id, month)
);
`,
  },
  {
    version: "0067",
    name: "payroll_timesheets",
    sql: `
-- Payroll stage P9 (docs/ACCOUNTING-EXAMPLES.md TS1-TS11; docs/DECISIONS.md
-- 91-101): weekly timesheets of hours by R&D activity, Department or
-- project, stamped by the database and never overwritten, approved by a
-- manager; approved pay runs keep the shares their costs were split by.
-- 0066 is taken by the CRM branch.

-- An employee's own login (decision 95) and their timesheet approver
-- (decision 96), both members' user ids in the core database.
alter table payroll_employees
  add column user_id uuid,
  add column timesheet_approver_user_id uuid,
  add constraint payroll_employees_not_own_timesheet_approver
    check (timesheet_approver_user_id is null or user_id is null or timesheet_approver_user_id <> user_id);
create unique index payroll_employees_user_idx on payroll_employees (user_id) where user_id is not null and not is_archived;

-- One timesheet per employee per week, Monday to Sunday (decision 92).
-- Draft -> submitted -> approved; rejected back to draft; reopened from
-- approved to draft only while no approved pay run has used it (decision 97).
create table payroll_timesheets (
  id uuid primary key default gen_random_uuid(),
  idempotency_key text not null unique,
  request_hash text not null,
  employee_id uuid not null references payroll_employees(id),
  week_start date not null check (extract(isodow from week_start) = 1),
  status text not null default 'draft' check (status in ('draft', 'submitted', 'approved')),
  version integer not null default 1 check (version > 0),
  submitted_at timestamptz,
  submitted_by_user_id uuid,
  submitted_by_email text,
  approved_at timestamptz,
  approved_by_user_id uuid,
  approved_by_email text,
  created_by_user_id uuid,
  created_by_email text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (employee_id, week_start),
  check ((status = 'draft') = (submitted_at is null)),
  check ((status = 'approved') = (approved_at is not null)),
  check (submitted_at is null or submitted_by_email is not null),
  check (approved_at is null or approved_by_email is not null)
);
create index payroll_timesheets_status_idx on payroll_timesheets (status, week_start);

-- Each cell of the week: hours on a day against an R&D activity, a
-- Department, a project, any combination, or none ("other work", spread by
-- the default allocation). entered_at is the database's time (decision 94).
-- A change marks the old entry replaced and adds a new one; clearing a cell
-- marks it removed. Nothing is deleted.
create table payroll_timesheet_entries (
  id uuid primary key default gen_random_uuid(),
  timesheet_id uuid not null references payroll_timesheets(id),
  work_date date not null,
  department_id bigint references tracking_values(id),
  project_id bigint references projects(id),
  rd_activity_id uuid references rd_activities(id),
  hours numeric(4,2) not null check (hours > 0 and hours <= 24),
  description text check (description is null or (length(description) between 1 and 500 and description = btrim(description))),
  status text not null default 'active' check (status in ('active', 'replaced', 'removed')),
  replaces_id uuid unique references payroll_timesheet_entries(id),
  entered_at timestamptz not null default now(),
  entered_by_user_id uuid,
  entered_by_email text not null,
  ended_at timestamptz,
  ended_by_user_id uuid,
  ended_by_email text,
  check ((status = 'active') = (ended_at is null)),
  check (ended_at is null or ended_by_email is not null)
);
create unique index payroll_timesheet_entries_cell_idx on payroll_timesheet_entries (
  timesheet_id, work_date, coalesce(department_id, 0), coalesce(project_id, 0),
  coalesce(rd_activity_id, '00000000-0000-0000-0000-000000000000'::uuid)
) where status = 'active';
create index payroll_timesheet_entries_sheet_idx on payroll_timesheet_entries (timesheet_id, work_date);

-- What happened to a timesheet, who did it and when (TS4).
create table payroll_timesheet_history (
  id bigserial primary key,
  timesheet_id uuid not null references payroll_timesheets(id),
  action text not null check (action in ('created', 'submitted', 'approved', 'rejected', 'reopened')),
  reason text check (reason is null or (length(reason) between 1 and 500 and reason = btrim(reason))),
  actor_user_id uuid,
  actor_email text not null,
  created_at timestamptz not null default now()
);
create index payroll_timesheet_history_sheet_idx on payroll_timesheet_history (timesheet_id, id);
create trigger payroll_timesheet_history_append_only
  before update or delete on payroll_timesheet_history
  for each row execute function tohyee_payroll_append_only('Timesheet history');
create trigger payroll_timesheet_history_no_truncate
  before truncate on payroll_timesheet_history
  for each statement execute function tohyee_payroll_append_only('Timesheet history');

-- The timesheets an approved pay run used (decision 98), and each
-- employee's shares of their costs: from a timesheet row or a line of the
-- default allocation, with its hours and weight (decisions 98, 100).
create table payroll_pay_run_timesheets (
  pay_run_id uuid not null references payroll_pay_runs(id),
  timesheet_id uuid not null references payroll_timesheets(id),
  primary key (pay_run_id, timesheet_id)
);
create index payroll_pay_run_timesheets_sheet_idx on payroll_pay_run_timesheets (timesheet_id);
create trigger payroll_pay_run_timesheets_append_only
  before update or delete on payroll_pay_run_timesheets
  for each row execute function tohyee_payroll_append_only('A pay run''s timesheets');
create trigger payroll_pay_run_timesheets_no_truncate
  before truncate on payroll_pay_run_timesheets
  for each statement execute function tohyee_payroll_append_only('A pay run''s timesheets');

create table payroll_pay_run_shares (
  pay_run_id uuid not null references payroll_pay_runs(id),
  employee_id uuid not null references payroll_employees(id),
  share_number integer not null check (share_number > 0),
  source text not null check (source in ('allocation', 'timesheet')),
  allocation_id uuid references payroll_cost_allocations(id),
  allocation_percentage numeric(5,2) check (allocation_percentage is null or (allocation_percentage > 0 and allocation_percentage <= 100)),
  hours numeric(8,2) check (hours is null or hours > 0),
  weight numeric not null check (weight > 0),
  percentage numeric(9,4) not null check (percentage >= 0 and percentage <= 100),
  tracking jsonb not null default '{}'::jsonb,
  department_id bigint references tracking_values(id),
  project_id bigint references projects(id),
  rd_activity_id uuid references rd_activities(id),
  primary key (pay_run_id, employee_id, share_number),
  check ((source = 'timesheet') = (hours is not null)),
  check ((source = 'allocation') = (allocation_percentage is not null)),
  check (source = 'allocation' or allocation_id is null)
);
create index payroll_pay_run_shares_employee_idx on payroll_pay_run_shares (employee_id);
create trigger payroll_pay_run_shares_append_only
  before update or delete on payroll_pay_run_shares
  for each row execute function tohyee_payroll_append_only('Pay run shares');
create trigger payroll_pay_run_shares_no_truncate
  before truncate on payroll_pay_run_shares
  for each statement execute function tohyee_payroll_append_only('Pay run shares');

-- A posting's share of the pay and its percentage to 4 places (decision 101).
alter table payroll_pay_run_postings alter column percentage type numeric(9,4);
alter table payroll_pay_run_postings drop constraint payroll_pay_run_postings_percentage_check;
alter table payroll_pay_run_postings add constraint payroll_pay_run_postings_percentage_check check (percentage >= 0 and percentage <= 100);
alter table payroll_pay_run_postings add column share_number integer check (share_number is null or share_number > 0);

-- A timesheet's employee, week and creation never change; its status moves
-- only as decision 97 says; it's never deleted.
create function tohyee_guard_payroll_timesheet() returns trigger
language plpgsql as $$
begin
  if tg_op in ('DELETE', 'TRUNCATE') then
    raise exception 'Timesheets can''t be deleted' using errcode = 'P0001';
  end if;
  if (new.id, new.idempotency_key, new.request_hash, new.employee_id, new.week_start, new.created_by_user_id,
      new.created_by_email, new.created_at)
     is distinct from
     (old.id, old.idempotency_key, old.request_hash, old.employee_id, old.week_start, old.created_by_user_id,
      old.created_by_email, old.created_at) then
    raise exception 'A timesheet''s employee and week can''t change' using errcode = 'P0001';
  end if;
  if new.status = old.status then
    if old.status <> 'draft' and (new.version, new.submitted_at, new.approved_at) is distinct from (old.version, old.submitted_at, old.approved_at) then
      raise exception 'This timesheet is %, so it can''t change', old.status using errcode = 'P0001';
    end if;
    return new;
  end if;
  if not ((old.status = 'draft' and new.status = 'submitted')
          or (old.status = 'submitted' and new.status in ('approved', 'draft'))
          or (old.status = 'approved' and new.status = 'draft')) then
    raise exception 'A timesheet can''t go from % to %', old.status, new.status using errcode = 'P0001';
  end if;
  if old.status = 'approved' and exists (
    select 1 from payroll_pay_run_timesheets l join payroll_pay_runs r on r.id = l.pay_run_id
     where l.timesheet_id = old.id and r.status = 'approved'
  ) then
    raise exception 'An approved pay run used this timesheet, so it can''t be reopened. Void the pay run first' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger payroll_timesheets_guard
  before update or delete on payroll_timesheets
  for each row execute function tohyee_guard_payroll_timesheet();
create trigger payroll_timesheets_no_truncate
  before truncate on payroll_timesheets
  for each statement execute function tohyee_guard_payroll_timesheet();

-- Entries are stamped by the database, go only on a draft timesheet's
-- week, and change only by being replaced or removed (decision 94).
create function tohyee_guard_payroll_timesheet_entry() returns trigger
language plpgsql as $$
declare
  sheet record;
begin
  if tg_op in ('DELETE', 'TRUNCATE') then
    raise exception 'Timesheet entries can''t be deleted; clear the cell instead' using errcode = 'P0001';
  end if;
  select status, week_start into sheet from payroll_timesheets where id = new.timesheet_id for share;
  if sheet.status is distinct from 'draft' then
    raise exception 'This timesheet is %, so its hours can''t change', coalesce(sheet.status, 'missing') using errcode = 'P0001';
  end if;
  if tg_op = 'INSERT' then
    new.entered_at := now();
    if new.status <> 'active' or new.ended_at is not null then
      raise exception 'A timesheet entry starts active' using errcode = 'P0001';
    end if;
    if new.work_date < sheet.week_start or new.work_date > sheet.week_start + 6 then
      raise exception 'The date % isn''t in the week starting %', new.work_date, sheet.week_start using errcode = 'P0001';
    end if;
    return new;
  end if;
  if old.status <> 'active' or new.status not in ('replaced', 'removed')
     or (new.id, new.timesheet_id, new.work_date, new.department_id, new.project_id, new.rd_activity_id, new.hours,
         new.description, new.replaces_id, new.entered_at, new.entered_by_user_id, new.entered_by_email)
        is distinct from
        (old.id, old.timesheet_id, old.work_date, old.department_id, old.project_id, old.rd_activity_id, old.hours,
         old.description, old.replaces_id, old.entered_at, old.entered_by_user_id, old.entered_by_email) then
    raise exception 'A timesheet entry is kept as entered; change it by entering the new hours' using errcode = 'P0001';
  end if;
  new.ended_at := now();
  return new;
end;
$$;
create trigger payroll_timesheet_entries_guard
  before insert or update or delete on payroll_timesheet_entries
  for each row execute function tohyee_guard_payroll_timesheet_entry();
create trigger payroll_timesheet_entries_no_truncate
  before truncate on payroll_timesheet_entries
  for each statement execute function tohyee_guard_payroll_timesheet_entry();

-- A pay run uses only approved timesheets.
create function tohyee_check_payroll_pay_run_timesheet() returns trigger
language plpgsql as $$
begin
  -- Locked, so a reopen can't slip in before the pay run commits.
  perform 1 from payroll_timesheets where id = new.timesheet_id and status = 'approved' for share;
  if not found then
    raise exception 'A pay run can only use approved timesheets' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger payroll_pay_run_timesheets_approved
  before insert on payroll_pay_run_timesheets
  for each row execute function tohyee_check_payroll_pay_run_timesheet();
`,
  },
  {
    version: "0068",
    name: "payroll_workforce_budgets",
    sql: `
-- Payroll stage P11 (docs/ACCOUNTING-EXAMPLES.md WB1-WB7; docs/DECISIONS.md
-- 112-123): workforce budgets of wages by employee or position and month,
-- written into the budgets they feed. Workforce budgets post nothing.

create table payroll_workforce_budgets (
  id uuid primary key default gen_random_uuid(),
  idempotency_key text not null unique,
  request_hash text not null,
  name text not null check (length(name) between 1 and 100 and name = btrim(name)),
  first_month date not null check (extract(day from first_month) = 1),
  months integer not null check (months between 1 and 24),
  version integer not null default 1 check (version > 0),
  created_by_user_id uuid,
  created_by_email text not null,
  created_at timestamptz not null default now(),
  updated_by_email text not null,
  updated_at timestamptz not null default now()
);
create unique index payroll_workforce_budgets_name_idx on payroll_workforce_budgets (lower(name));

-- The budgets a workforce budget feeds; a budget is fed by at most one (decision 120).
create table payroll_workforce_budget_targets (
  workforce_budget_id uuid not null references payroll_workforce_budgets(id),
  budget_id bigint not null unique references budgets(id),
  added_by_email text not null,
  added_at timestamptz not null default now(),
  primary key (workforce_budget_id, budget_id)
);

-- Lines: an employee or a position (decision 114). Replaced as a set on each save.
create table payroll_workforce_budget_lines (
  id uuid primary key default gen_random_uuid(),
  workforce_budget_id uuid not null references payroll_workforce_budgets(id),
  line_number integer not null check (line_number between 1 and 500),
  employee_id uuid references payroll_employees(id),
  position_name text check (position_name is null or (length(position_name) between 1 and 100 and position_name = btrim(position_name))),
  pay_basis text not null check (pay_basis in ('salary', 'hourly')),
  fte numeric(5,4) check (fte is null or (fte > 0 and fte <= 1)),
  hours_per_week numeric(6,2) check (hours_per_week is null or (hours_per_week > 0 and hours_per_week <= 168)),
  kiwisaver_rate numeric(5,2) not null check (kiwisaver_rate between 0 and 100),
  start_month date not null check (extract(day from start_month) = 1),
  end_month date check (end_month is null or (extract(day from end_month) = 1 and end_month >= start_month)),
  check ((employee_id is null) <> (position_name is null)),
  check ((pay_basis = 'salary') = (fte is not null)),
  check ((pay_basis = 'hourly') = (hours_per_week is not null)),
  unique (workforce_budget_id, line_number)
);
create unique index payroll_workforce_budget_lines_employee_idx
  on payroll_workforce_budget_lines (workforce_budget_id, employee_id) where employee_id is not null;

-- Pay from a month: the first from the line's start month, later ones pay rises (decision 116).
create table payroll_workforce_budget_line_rates (
  line_id uuid not null references payroll_workforce_budget_lines(id) on delete cascade,
  from_month date not null check (extract(day from from_month) = 1),
  rate numeric(14,4) not null check (rate > 0),
  primary key (line_id, from_month)
);

-- A position's own split (decision 117); employees use their cost allocation.
create table payroll_workforce_budget_line_splits (
  line_id uuid not null references payroll_workforce_budget_lines(id) on delete cascade,
  split_number integer not null check (split_number between 1 and 20),
  percentage numeric(5,2) not null check (percentage > 0 and percentage <= 100),
  department_id bigint references tracking_values(id),
  project_id bigint references projects(id),
  primary key (line_id, split_number)
);

-- Budget amounts a workforce budget wrote (decision 113, 121).
alter table budget_amounts add column workforce_budget_id uuid references payroll_workforce_budgets(id);

-- Only the owning workforce budget's own rewrite (which sets
-- tohyee.workforce_budget_feed to its id for the transaction) may write,
-- change or release an amount it owns, or take one over.
create function tohyee_guard_budget_amount_workforce() returns trigger
language plpgsql as $$
declare
  feeding text := coalesce(current_setting('tohyee.workforce_budget_feed', true), '');
begin
  if tg_op = 'UPDATE' and old.workforce_budget_id is not null and feeding <> old.workforce_budget_id::text then
    raise exception 'This budget amount comes from a workforce budget; change it there' using errcode = 'P0001';
  end if;
  if new.workforce_budget_id is not null and feeding <> new.workforce_budget_id::text then
    raise exception 'Only the workforce budget itself can write its budget amounts' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger budget_amounts_workforce_guard
  before insert or update on budget_amounts
  for each row execute function tohyee_guard_budget_amount_workforce();
`,
  },
  {
    version: "0069",
    name: "payroll_extra_back_final_pays",
    sql: `
-- Payroll stage P12 (docs/ACCOUNTING-EXAMPLES.md XP1-XP14; docs/DECISIONS.md
-- 124-137): extra pays, back pay and final pays.

-- New pay item kinds (decision 125): extra pays and back pay, and on a final
-- pay holiday pay on finishing (worked out outside Tohyee until leave, P8)
-- and redundancy, which has no ACC earners' levy and doesn't count for
-- KiwiSaver (spec 5.11.1 step 4.1, 4.5.1). The checks that listed the kinds,
-- and the one that tied the levy to PAYE, are replaced.
do $$
declare
  c record;
begin
  for c in select conname from pg_constraint
            where conrelid = 'payroll_pay_items'::regclass and contype = 'c'
              and ((pg_get_constraintdef(oid) like '%''holiday_pay''%' and pg_get_constraintdef(oid) like '%''reimbursement''%')
                   or pg_get_constraintdef(oid) like '%subject_to_acc_levy = subject_to_paye%') loop
    execute format('alter table payroll_pay_items drop constraint %I', c.conname);
  end loop;
end;
$$;
alter table payroll_pay_items add constraint payroll_pay_items_kind_check
  check (kind in ('ordinary_time', 'overtime', 'allowance', 'holiday_pay', 'reimbursement', 'extra_pay', 'back_pay',
                  'termination_holiday_pay', 'redundancy', 'after_tax_deduction', 'kiwisaver_employer'));
alter table payroll_pay_items add constraint payroll_pay_items_earnings_check
  check ((category = 'earnings') = (kind in ('ordinary_time', 'overtime', 'allowance', 'holiday_pay', 'reimbursement', 'extra_pay',
                                              'back_pay', 'termination_holiday_pay', 'redundancy')));
alter table payroll_pay_items add constraint payroll_pay_items_taxes_check
  check (subject_to_student_loan = subject_to_paye
         and (subject_to_acc_levy = subject_to_paye or kind = 'redundancy'));
alter table payroll_pay_items add constraint payroll_pay_items_extra_pay_check
  check ((kind not in ('extra_pay', 'back_pay', 'termination_holiday_pay')
          or (subject_to_paye and subject_to_acc_levy and subject_to_kiwisaver))
         and (kind <> 'redundancy' or (subject_to_paye and not subject_to_acc_levy and not subject_to_kiwisaver)));

-- Back pay worked out from pay rate history (decision 133) keeps the
-- approved pay run it's for, so it isn't paid twice.
alter table payroll_pay_run_lines add column back_pay_for_pay_run_id uuid references payroll_pay_runs(id);
alter table payroll_pay_run_lines add constraint payroll_pay_run_lines_back_pay_check
  check (back_pay_for_pay_run_id is null or (quantity is null and amount > 0));
create index payroll_pay_run_lines_back_pay_idx on payroll_pay_run_lines (back_pay_for_pay_run_id, employee_id)
  where back_pay_for_pay_run_id is not null;

-- What approving kept about extra pays and final pays (decisions 127-130,
-- 134): the extra pays, their tax (part of paye), the rate and annualised
-- income they were taxed with, the lump sum indicator (EI field 14) and
-- the finish date of a final pay. Null on pay runs approved before P12.
alter table payroll_pay_run_employees add column extra_pay numeric(16,2) check (extra_pay is null or extra_pay >= 0);
alter table payroll_pay_run_employees add column extra_pay_tax numeric(16,2) check (extra_pay_tax is null or extra_pay_tax >= 0);
alter table payroll_pay_run_employees add column extra_pay_tax_rate numeric(5,2);
alter table payroll_pay_run_employees add column extra_pay_method text
  check (extra_pay_method is null or extra_pay_method in ('four_weeks', 'end_of_employment', 'flat_rate'));
alter table payroll_pay_run_employees add column extra_pay_annualised numeric(18,4);
alter table payroll_pay_run_employees add column lump_sum_lowest_rate boolean;
alter table payroll_pay_run_employees add column finish_date date;
`,
  },
  {
    version: "0070",
    name: "payroll_holidays_act_leave",
    sql: `
-- Payroll stage P8 (docs/ACCOUNTING-EXAMPLES.md HL1-HL42, decisions 7-29
-- and 138 on): Holidays Act 2003 leave, built as a dated rule-set that ends
-- at each employee's first pay period starting on or after 6 Aug 2028.
-- Every leave entry stores its hours and the hours in one unit (a usual week
-- or a usual day) so balances stay exact and can move to the Employment
-- Leave Act 2026 (decisions 8, 26).

-- The organisation's anniversary day (decision 22) and a policy not to
-- consider cash-ups (s 28E).
alter table organisation_settings add column payroll_anniversary_region text
  check (payroll_anniversary_region is null or payroll_anniversary_region in ('auckland', 'taranaki', 'hawkes_bay', 'wellington',
    'marlborough', 'nelson', 'canterbury', 'canterbury_south', 'westland', 'otago', 'southland', 'chatham_islands'));
alter table organisation_settings add column payroll_no_cash_ups boolean not null default false;

-- Files kept with leave records: cash-up requests and answers (decision 29),
-- agreements (unpaid leave counting, holidays in advance, exchanging an
-- alternative holiday). Never changed or deleted (kept 6 years, s 81(4)).
create table payroll_leave_files (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references payroll_employees(id),
  purpose text not null check (purpose in ('cash_up_request', 'cash_up_answer', 'unpaid_leave_agreement', 'advance_agreement',
                                           'exchange_agreement')),
  file_name text not null check (length(file_name) between 1 and 255),
  content_type text not null,
  byte_size integer not null check (byte_size > 0),
  sha256 text not null,
  content bytea not null,
  created_at timestamptz not null default now(),
  created_by_user_id uuid,
  created_by_email text not null
);
create index payroll_leave_files_employee_idx on payroll_leave_files (employee_id);
create trigger payroll_leave_files_append_only
  before update or delete on payroll_leave_files
  for each row execute function tohyee_payroll_append_only('Leave files');
create trigger payroll_leave_files_no_truncate
  before truncate on payroll_leave_files
  for each statement execute function tohyee_payroll_append_only('Leave files');

-- Each employee's usual week and leave settings, dated (decisions 8, 9, 11,
-- 13, 19, 22; s 17, s 27(1)(a)). Never changed: a change is a new row from
-- a date, as pay rates are (PE7).
create table payroll_leave_settings (
  id uuid primary key default gen_random_uuid(),
  entry_number bigserial not null unique,
  idempotency_key text not null unique,
  request_hash text not null,
  employee_id uuid not null references payroll_employees(id),
  effective_from date not null,
  pattern_kind text not null check (pattern_kind in ('fixed', 'varies')),
  -- Seven days, Monday first: ordinary hours and usual extras (overtime, allowances), each regular or not.
  pattern_days jsonb,
  week_hours numeric(7,2) check (week_hours is null or week_hours > 0),
  week_days numeric(4,2) check (week_days is null or (week_days > 0 and week_days <= 7)),
  daily_pay text not null check (daily_pay in ('rdp', 'adp')),
  adp_reason text check (adp_reason is null or adp_reason in ('not_practicable', 'varies_within_period')),
  annual_paid_in_period boolean not null,
  part_day_sick_agreed boolean not null default false,
  employment_type text not null default 'continuous' check (employment_type in ('continuous', 'casual')),
  anniversary_region text
    check (anniversary_region is null or anniversary_region in ('auckland', 'taranaki', 'hawkes_bay', 'wellington',
      'marlborough', 'nelson', 'canterbury', 'canterbury_south', 'westland', 'otago', 'southland', 'chatham_islands')),
  note text check (note is null or length(note) <= 1000),
  created_at timestamptz not null default now(),
  created_by_user_id uuid,
  created_by_email text not null,
  check ((pattern_kind = 'fixed') = (pattern_days is not null and jsonb_typeof(pattern_days) = 'array' and jsonb_array_length(pattern_days) = 7)),
  check ((pattern_kind = 'varies') = (week_hours is not null and week_days is not null)),
  check ((daily_pay = 'adp') = (adp_reason is not null))
);
create index payroll_leave_settings_employee_idx on payroll_leave_settings (employee_id, effective_from, entry_number);
create trigger payroll_leave_settings_append_only
  before update or delete on payroll_leave_settings
  for each row execute function tohyee_payroll_append_only('Leave settings');
create trigger payroll_leave_settings_no_truncate
  before truncate on payroll_leave_settings
  for each statement execute function tohyee_payroll_append_only('Leave settings');

-- Unpaid leave (s 16(2), s 16(3); decision 14). A single period of other
-- unpaid leave longer than a week moves the anniversary unless a written
-- agreement to count it is recorded.
create table payroll_unpaid_leave (
  id uuid primary key default gen_random_uuid(),
  idempotency_key text not null unique,
  request_hash text not null,
  employee_id uuid not null references payroll_employees(id),
  start_date date not null,
  end_date date not null,
  reason text not null check (reason in ('other', 'sick', 'bereavement', 'family_violence', 'parental', 'volunteers', 'acc')),
  agreed_to_count boolean not null default false,
  agreement_file_id uuid references payroll_leave_files(id),
  note text check (note is null or length(note) <= 1000),
  status text not null default 'active' check (status in ('active', 'cancelled')),
  created_at timestamptz not null default now(),
  created_by_user_id uuid,
  created_by_email text not null,
  cancelled_at timestamptz,
  cancelled_by_email text,
  check (end_date >= start_date),
  check (not agreed_to_count or (reason = 'other' and agreement_file_id is not null)),
  check ((status = 'cancelled') = (cancelled_at is not null))
);
create index payroll_unpaid_leave_employee_idx on payroll_unpaid_leave (employee_id, start_date);

-- Leave booked for an employee (annual holidays, sick, bereavement and
-- family violence leave, alternative holidays). Pay runs for the days it
-- covers pay it; a booking a pay run has paid can't be cancelled.
create table payroll_leave_bookings (
  id uuid primary key default gen_random_uuid(),
  booking_number bigserial not null unique,
  idempotency_key text not null unique,
  request_hash text not null,
  employee_id uuid not null references payroll_employees(id),
  leave_type text not null check (leave_type in ('annual', 'sick', 'bereavement', 'family_violence', 'alternative')),
  start_date date not null,
  end_date date not null,
  -- Hours each day for someone whose hours vary: {"2026-11-04": "6.5", …}.
  day_hours jsonb,
  -- A part day of sick or family violence leave: the hours worked that day (decision 19).
  hours_worked numeric(5,2) check (hours_worked is null or hours_worked > 0),
  bereavement_kind text check (bereavement_kind is null or bereavement_kind in ('close_family', 'pregnancy_loss', 'other')),
  -- Sick, bereavement or family violence leave in advance, agreed (s 63(3), s 72D(3)).
  in_advance_agreed boolean not null default false,
  -- The written agreement to recover annual holidays taken in advance (decision 15), when there is one.
  advance_agreement_file_id uuid references payroll_leave_files(id),
  note text check (note is null or length(note) <= 1000),
  status text not null default 'booked' check (status in ('booked', 'cancelled')),
  created_at timestamptz not null default now(),
  created_by_user_id uuid,
  created_by_email text not null,
  cancelled_at timestamptz,
  cancelled_by_email text,
  check (end_date >= start_date),
  check (end_date <= start_date + 366),
  check (hours_worked is null or (start_date = end_date and leave_type in ('sick', 'family_violence'))),
  check ((leave_type = 'bereavement') = (bereavement_kind is not null)),
  check (leave_type <> 'alternative' or start_date = end_date),
  check ((status = 'cancelled') = (cancelled_at is not null))
);
create index payroll_leave_bookings_employee_idx on payroll_leave_bookings (employee_id, start_date) where status = 'booked';

-- Whether a public holiday would otherwise have been a working day, and the
-- hours worked on it (decisions 21, 23): decided by the person running pay
-- and recorded. A decision an approved pay run used can't change.
create table payroll_public_holiday_decisions (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references payroll_employees(id),
  holiday_date date not null,
  holiday_name text not null,
  otherwise_working boolean not null,
  -- Tohyee's suggestion and why, for someone whose hours vary (decision 21).
  suggestion text check (suggestion is null or length(suggestion) <= 200),
  hours_worked numeric(5,2) check (hours_worked is null or (hours_worked > 0 and hours_worked <= 24)),
  -- s 50(1)(b): an identifiable penal rate an hour in the agreement.
  penal_hourly_rate numeric(12,4) check (penal_hourly_rate is null or penal_hourly_rate > 0),
  -- A typed extra the agreement gives (decision 23).
  extra_amount numeric(16,2) check (extra_amount is null or extra_amount > 0),
  note text check (note is null or length(note) <= 1000),
  status text not null default 'current' check (status in ('current', 'replaced')),
  decided_at timestamptz not null default now(),
  decided_by_user_id uuid,
  decided_by_email text not null,
  check (hours_worked is null or penal_hourly_rate is null or hours_worked > 0)
);
create unique index payroll_public_holiday_decisions_current_idx on payroll_public_holiday_decisions (employee_id, holiday_date)
  where status = 'current';

-- Cash-ups of annual holidays (s 28A-s 28F; decision 29): only with the
-- employee's written request and the employer's written answer attached.
create table payroll_cash_ups (
  id uuid primary key default gen_random_uuid(),
  cash_up_number bigserial not null unique,
  idempotency_key text not null unique,
  request_hash text not null,
  employee_id uuid not null references payroll_employees(id),
  requested_on date not null,
  agreed_on date not null,
  weeks numeric(12,8) not null check (weeks > 0 and weeks <= 1),
  hours numeric(12,4) not null check (hours > 0),
  week_hours numeric(7,2) not null check (week_hours > 0),
  request_file_id uuid not null references payroll_leave_files(id),
  answer_file_id uuid not null references payroll_leave_files(id),
  status text not null default 'agreed' check (status in ('agreed', 'cancelled')),
  created_at timestamptz not null default now(),
  created_by_user_id uuid,
  created_by_email text not null,
  cancelled_at timestamptz,
  cancelled_by_email text,
  check (agreed_on >= requested_on),
  check ((status = 'cancelled') = (cancelled_at is not null))
);
create index payroll_cash_ups_employee_idx on payroll_cash_ups (employee_id);

-- Alternative holidays exchanged for payment (s 61; decision 24).
create table payroll_alternative_exchanges (
  id uuid primary key default gen_random_uuid(),
  idempotency_key text not null unique,
  request_hash text not null,
  employee_id uuid not null references payroll_employees(id),
  arose_on date not null,
  requested_on date not null,
  agreed_on date not null,
  default_amount numeric(16,2) not null check (default_amount >= 0),
  amount numeric(16,2) not null check (amount > 0),
  agreement_note text not null check (length(btrim(agreement_note)) between 1 and 1000),
  agreement_file_id uuid references payroll_leave_files(id),
  status text not null default 'agreed' check (status in ('agreed', 'cancelled')),
  created_at timestamptz not null default now(),
  created_by_user_id uuid,
  created_by_email text not null,
  cancelled_at timestamptz,
  cancelled_by_email text,
  check (requested_on >= arose_on + interval '12 months'),
  check (agreed_on >= requested_on),
  check ((status = 'cancelled') = (cancelled_at is not null))
);

-- Leave pay items (decision 138): one per kind, made by Tohyee, each with its
-- own account so reports show annual holidays, sick leave and the rest
-- apart. Leave taken in the pay period is ordinary pay for PAYE (IRD's
-- operational position on holiday pay, 2016); cash-ups and exchanged
-- alternative holidays are extra pays (decision 151). Family violence leave
-- is "Special leave" so payslips and journals don't say what it is
-- (decision 27).
do $$
declare
  c record;
begin
  for c in select conname from pg_constraint
            where conrelid = 'payroll_pay_items'::regclass and contype = 'c'
              and (pg_get_constraintdef(oid) like '%''holiday_pay''%'
                   or pg_get_constraintdef(oid) like '%is_system%'
                   or pg_get_constraintdef(oid) like '%''termination_holiday_pay''%') loop
    execute format('alter table payroll_pay_items drop constraint %I', c.conname);
  end loop;
end;
$$;
alter table payroll_pay_items add constraint payroll_pay_items_kind_check
  check (kind in ('ordinary_time', 'overtime', 'allowance', 'holiday_pay', 'reimbursement', 'extra_pay', 'back_pay',
                  'termination_holiday_pay', 'redundancy', 'after_tax_deduction', 'kiwisaver_employer',
                  'annual_leave', 'sick_leave', 'bereavement_leave', 'family_violence_leave', 'public_holiday',
                  'public_holiday_worked', 'alternative_holiday', 'annual_leave_cash_up', 'alternative_holiday_payout'));
alter table payroll_pay_items add constraint payroll_pay_items_earnings_check
  check ((category = 'earnings') = (kind in ('ordinary_time', 'overtime', 'allowance', 'holiday_pay', 'reimbursement', 'extra_pay',
                                              'back_pay', 'termination_holiday_pay', 'redundancy', 'annual_leave', 'sick_leave',
                                              'bereavement_leave', 'family_violence_leave', 'public_holiday', 'public_holiday_worked',
                                              'alternative_holiday', 'annual_leave_cash_up', 'alternative_holiday_payout')));
alter table payroll_pay_items add constraint payroll_pay_items_extra_pay_check
  check ((kind not in ('extra_pay', 'back_pay', 'termination_holiday_pay', 'annual_leave_cash_up', 'alternative_holiday_payout')
          or (subject_to_paye and subject_to_acc_levy and subject_to_kiwisaver))
         and (kind <> 'redundancy' or (subject_to_paye and not subject_to_acc_levy and not subject_to_kiwisaver)));
alter table payroll_pay_items add constraint payroll_pay_items_leave_check
  check (kind not in ('holiday_pay', 'annual_leave', 'sick_leave', 'bereavement_leave', 'family_violence_leave', 'public_holiday',
                      'public_holiday_worked', 'alternative_holiday')
         or (subject_to_paye and subject_to_acc_levy and subject_to_kiwisaver));
alter table payroll_pay_items add constraint payroll_pay_items_ordinary_check
  check (kind not in ('ordinary_time', 'overtime') or (subject_to_paye and subject_to_kiwisaver));
alter table payroll_pay_items add constraint payroll_pay_items_system_check
  check (not is_system or (kind in ('ordinary_time', 'kiwisaver_employer', 'termination_holiday_pay', 'annual_leave', 'sick_leave',
                                    'bereavement_leave', 'family_violence_leave', 'public_holiday', 'public_holiday_worked',
                                    'alternative_holiday', 'annual_leave_cash_up', 'alternative_holiday_payout')
                           and not is_archived));

-- Gross earnings for holiday pay (s 14; decision 139): what counts in
-- average weekly earnings, average daily pay and the 8%. Reimbursements,
-- non-taxable allowances, redundancy (Employment NZ: "generally ...
-- compensation and not earnings") and cash-ups (s 14(c)(iv)) don't;
-- an extra pay or allowance the employer isn't bound to pay is marked
-- discretionary when it's added (s 14(b)(i)).
alter table payroll_pay_items add column counts_for_holiday_pay boolean;
update payroll_pay_items
   set counts_for_holiday_pay = category = 'earnings' and subject_to_paye and kind not in ('redundancy', 'annual_leave_cash_up');
alter table payroll_pay_items alter column counts_for_holiday_pay set not null;
alter table payroll_pay_items add constraint payroll_pay_items_holiday_gross_check
  check ((not counts_for_holiday_pay or (category = 'earnings' and subject_to_paye))
         and (kind not in ('redundancy', 'annual_leave_cash_up', 'reimbursement') or not counts_for_holiday_pay)
         and (kind not in ('ordinary_time', 'overtime', 'holiday_pay', 'back_pay', 'termination_holiday_pay', 'annual_leave',
                           'sick_leave', 'bereavement_leave', 'family_violence_leave', 'public_holiday', 'public_holiday_worked',
                           'alternative_holiday', 'alternative_holiday_payout') or counts_for_holiday_pay));

-- The starting pay items (0058) with the new column, for organisations made from now on.
create or replace function tohyee_seed_payroll_pay_items() returns void
language plpgsql as $$
declare
  wages bigint := (select id from accounts where lower(code) = '6200' and account_class = 'expense' and currency_code is null);
  kiwisaver bigint := (select id from accounts where lower(code) = '6210' and account_class = 'expense' and currency_code is null);
  general bigint := (select id from accounts where lower(code) = '6070' and account_class = 'expense' and currency_code is null);
  deductions bigint := (select id from accounts where system_key = 'payroll_deductions_payable');
begin
  if exists (select 1 from payroll_pay_items) then
    return;
  end if;
  insert into payroll_pay_items (
    idempotency_key, request_hash, name, category, kind, account_id, rate_multiplier,
    subject_to_paye, subject_to_acc_levy, subject_to_student_loan, subject_to_kiwisaver, subject_to_esct, is_system,
    counts_for_holiday_pay
  ) values
    ('system:ordinary-time', 'system', 'Ordinary time', 'earnings', 'ordinary_time', wages, null, true, true, true, true, false, true, true),
    ('system:overtime', 'system', 'Overtime', 'earnings', 'overtime', wages, 1.5, true, true, true, true, false, false, true),
    ('system:allowance', 'system', 'Allowance (taxable)', 'earnings', 'allowance', wages, null, true, true, true, true, false, false, true),
    ('system:holiday-pay', 'system', 'Holiday pay', 'earnings', 'holiday_pay', wages, null, true, true, true, true, false, false, true),
    ('system:reimbursement', 'system', 'Reimbursement', 'earnings', 'reimbursement', general, null, false, false, false, false, false, false,
     false),
    ('system:union-fees', 'system', 'Union fees', 'deduction', 'after_tax_deduction', deductions, null, false, false, false, false, false, false,
     false),
    ('system:kiwisaver-employer', 'system', 'KiwiSaver employer contribution', 'employer_contribution', 'kiwisaver_employer', kiwisaver, null,
     false, false, false, false, true, true, false);
end;
$$;

create function tohyee_seed_payroll_leave_items() returns void
language plpgsql as $$
declare
  wages bigint := (select id from accounts where lower(code) = '6200' and account_class = 'expense' and currency_code is null);
  item record;
  wanted text;
  suffix integer;
begin
  if not exists (select 1 from payroll_pay_items) then
    return;
  end if;
  for item in select * from (values
      ('annual_leave', 'Annual leave', false),
      ('sick_leave', 'Sick leave', false),
      ('bereavement_leave', 'Bereavement leave', false),
      ('family_violence_leave', 'Special leave', false),
      ('public_holiday', 'Public holiday', false),
      ('public_holiday_worked', 'Public holiday worked', false),
      ('alternative_holiday', 'Alternative holiday', false),
      ('annual_leave_cash_up', 'Annual leave cashed up', true),
      ('alternative_holiday_payout', 'Alternative holiday paid out', true),
      ('termination_holiday_pay', 'Holiday pay owed on finishing', true)) as v(kind, name, extra) loop
    if exists (select 1 from payroll_pay_items where is_system and kind = item.kind) then
      continue;
    end if;
    wanted := item.name;
    suffix := 1;
    while exists (select 1 from payroll_pay_items where lower(name) = lower(wanted)) loop
      suffix := suffix + 1;
      wanted := item.name || ' (' || suffix || ')';
    end loop;
    insert into payroll_pay_items (
      idempotency_key, request_hash, name, category, kind, account_id, rate_multiplier,
      subject_to_paye, subject_to_acc_levy, subject_to_student_loan, subject_to_kiwisaver, subject_to_esct, is_system,
      counts_for_holiday_pay
    ) values ('system:' || replace(item.kind, '_', '-'), 'system', wanted, 'earnings', item.kind, wages, null,
              true, true, true, true, false, true, item.kind <> 'annual_leave_cash_up');
  end loop;
end;
$$;
select tohyee_seed_payroll_leave_items();

-- Leave on pay run lines. A line is typed, part of the usual pay Tohyee
-- made from the usual week, or leave Tohyee worked out (decision 141).
-- Leave lines keep the dates, hours, units and the rate and its inputs
-- (decision 8), and what they pay (a booking, a public holiday, a cash-up,
-- an exchange, holiday pay on finishing). "regular" marks overtime and
-- allowances that are a regular part of pay (s 8(1)(b); decision 11).
alter table payroll_pay_run_lines add column source text not null default 'typed'
  check (source in ('typed', 'usual_pay', 'leave'));
alter table payroll_pay_run_lines add column regular boolean;
alter table payroll_pay_run_lines add column leave_type text
  check (leave_type is null or leave_type in ('annual', 'sick', 'bereavement', 'family_violence', 'alternative', 'public_holiday',
                                              'public_holiday_worked', 'cash_up', 'exchange', 'termination'));
alter table payroll_pay_run_lines add column leave_booking_id uuid references payroll_leave_bookings(id);
alter table payroll_pay_run_lines add column leave_from date;
alter table payroll_pay_run_lines add column leave_to date;
alter table payroll_pay_run_lines add column leave_hours numeric(12,4) check (leave_hours is null or leave_hours >= 0);
alter table payroll_pay_run_lines add column leave_unit_hours numeric(12,4) check (leave_unit_hours is null or leave_unit_hours > 0);
alter table payroll_pay_run_lines add column leave_units numeric(16,8);
alter table payroll_pay_run_lines add column leave_in_advance boolean not null default false;
alter table payroll_pay_run_lines add column holiday_date date;
alter table payroll_pay_run_lines add column cash_up_id uuid references payroll_cash_ups(id);
alter table payroll_pay_run_lines add column exchange_id uuid references payroll_alternative_exchanges(id);
alter table payroll_pay_run_lines add column leave_basis jsonb;
alter table payroll_pay_run_lines add constraint payroll_pay_run_lines_leave_check
  check ((source = 'leave') = (leave_type is not null)
         and (source <> 'leave' or (quantity is null and back_pay_for_pay_run_id is null))
         and ((leave_hours is null) = (leave_unit_hours is null)));
create index payroll_pay_run_lines_leave_idx on payroll_pay_run_lines (employee_id, leave_type) where leave_type is not null;
create index payroll_pay_run_lines_booking_idx on payroll_pay_run_lines (leave_booking_id) where leave_booking_id is not null;

-- What stops a draft's leave being worked out (shown with the employee and
-- blocking approval until it's fixed), set each time the leave is updated.
alter table payroll_pay_run_employees add column leave_problem text;
alter table payroll_pay_run_employees add column leave_notes jsonb;
`,
  },
  {
    version: "0071",
    name: "payroll_leave_opening_balances_and_requests",
    sql: `
-- Opening leave balances (decision 168; docs/ACCOUNTING-EXAMPLES.md
-- HL43-HL48): an employee's leave and earlier earnings from another
-- payroll, as at the end of the opening date, entered once (a replacement
-- keeps the old one) with where they came from and the previous system's
-- report attached. Employees' own leave requests (decision 169; HL49-HL51).
do $$
declare
  c record;
begin
  for c in select conname from pg_constraint
            where conrelid = 'payroll_leave_files'::regclass and contype = 'c'
              and pg_get_constraintdef(oid) like '%cash_up_request%' loop
    execute format('alter table payroll_leave_files drop constraint %I', c.conname);
  end loop;
end;
$$;
alter table payroll_leave_files add constraint payroll_leave_files_purpose_check
  check (purpose in ('cash_up_request', 'cash_up_answer', 'unpaid_leave_agreement', 'advance_agreement', 'exchange_agreement',
                     'opening_balances_report'));

create table payroll_leave_opening_balances (
  id uuid primary key default gen_random_uuid(),
  entry_number bigserial not null unique,
  idempotency_key text not null unique,
  request_hash text not null,
  employee_id uuid not null references payroll_employees(id),
  as_at date not null,
  -- Annual holidays in weeks (negative when taken in advance) and the usual week's hours they're in (decision 8).
  annual_weeks numeric(12,8) not null,
  annual_week_hours numeric(7,2) not null check (annual_week_hours > 0),
  annual_last_entitled date check (annual_last_entitled is null or annual_last_entitled <= as_at),
  annual_cashed_up_weeks numeric(12,8) not null default 0 check (annual_cashed_up_weeks >= 0 and annual_cashed_up_weeks <= 1),
  annual_advance_paid numeric(16,2) not null default 0 check (annual_advance_paid >= 0),
  sick_days numeric(10,4) not null,
  family_violence_days numeric(10,4) not null,
  -- The dates untaken alternative holidays arose (s 81(2)(k)).
  alternative_holidays date[] not null default '{}',
  source text not null check (length(btrim(source)) between 1 and 1000),
  report_file_id uuid not null references payroll_leave_files(id),
  status text not null default 'current' check (status in ('current', 'replaced')),
  created_at timestamptz not null default now(),
  created_by_user_id uuid,
  created_by_email text not null,
  replaced_at timestamptz,
  replaced_by_email text,
  check ((annual_weeks < 0) = (annual_advance_paid > 0)),
  check ((status = 'replaced') = (replaced_at is not null))
);
create unique index payroll_leave_opening_balances_current_idx on payroll_leave_opening_balances (employee_id) where status = 'current';

-- The earlier earnings, one row per pay period of the previous payroll:
-- gross earnings (s 14), the irregular part (s 8(2)), days worked or on
-- paid leave (s 9A(2)). Never changed.
create table payroll_leave_opening_earnings (
  opening_id uuid not null references payroll_leave_opening_balances(id),
  line_number integer not null check (line_number > 0),
  period_start date not null,
  period_end date not null,
  gross numeric(16,2) not null check (gross >= 0),
  irregular numeric(16,2) not null default 0 check (irregular >= 0 and irregular <= gross),
  days integer not null check (days >= 0 and days <= period_end - period_start + 1),
  primary key (opening_id, line_number),
  check (period_end >= period_start and period_end - period_start <= 30)
);
create trigger payroll_leave_opening_earnings_append_only
  before update or delete on payroll_leave_opening_earnings
  for each row execute function tohyee_payroll_append_only('Opening earnings');
create trigger payroll_leave_opening_earnings_no_truncate
  before truncate on payroll_leave_opening_earnings
  for each statement execute function tohyee_payroll_append_only('Opening earnings');

-- Leave asked for by employees (decision 169): hours and days only, never
-- pay. Approving books the leave (payroll_leave_bookings) as the approver.
create table payroll_leave_requests (
  id uuid primary key default gen_random_uuid(),
  request_number bigserial not null unique,
  idempotency_key text not null unique,
  request_hash text not null,
  employee_id uuid not null references payroll_employees(id),
  leave_type text not null check (leave_type in ('annual', 'sick', 'bereavement', 'family_violence', 'alternative')),
  start_date date not null,
  end_date date not null,
  day_hours jsonb,
  bereavement_kind text check (bereavement_kind is null or bereavement_kind in ('close_family', 'pregnancy_loss', 'other')),
  note text check (note is null or length(note) <= 1000),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'withdrawn')),
  created_at timestamptz not null default now(),
  created_by_user_id uuid not null,
  created_by_email text not null,
  updated_at timestamptz not null default now(),
  decided_at timestamptz,
  decided_by_user_id uuid,
  decided_by_email text,
  rejection_reason text check (rejection_reason is null or length(btrim(rejection_reason)) between 1 and 1000),
  booking_id uuid references payroll_leave_bookings(id),
  check (end_date >= start_date and end_date <= start_date + 366),
  check ((leave_type = 'bereavement') = (bereavement_kind is not null)),
  check (leave_type <> 'alternative' or start_date = end_date),
  check ((status in ('approved', 'rejected')) = (decided_at is not null and decided_by_email is not null)),
  check ((status = 'approved') = (booking_id is not null)),
  check ((status = 'rejected') = (rejection_reason is not null)),
  check (decided_by_user_id is null or decided_by_user_id <> created_by_user_id)
);
create index payroll_leave_requests_employee_idx on payroll_leave_requests (employee_id, start_date);
create index payroll_leave_requests_pending_idx on payroll_leave_requests (status) where status = 'pending';
`,
  },
  {
    version: "0072",
    name: "payroll_leave_liability_postings",
    sql: `
-- Posting the leave liability to the ledger (decision 177; decisions
-- 182-187; docs/ACCOUNTING-EXAMPLES.md HL52-HL56). The two accounts are
-- payroll settings. Each posting is the change since the last posting not
-- voided, Dr leave expense / Cr employee entitlements (or the other way),
-- by Department; it keeps the liability it posted to, by Department, so
-- the next one can measure from it. Voided with a reversing journal, never
-- changed or deleted.
alter table organisation_settings
  add column payroll_leave_expense_account_id bigint references accounts(id),
  add column payroll_leave_liability_account_id bigint references accounts(id);

create table payroll_leave_liability_postings (
  id uuid primary key default gen_random_uuid(),
  posting_number bigserial not null unique,
  command_source text not null,
  idempotency_key text not null,
  request_hash text not null,
  as_at date not null,
  expense_account_id bigint not null references accounts(id),
  liability_account_id bigint not null references accounts(id),
  -- The liability at as_at (the report's total) and the change in it
  -- (0.00 when only its split between Departments changed).
  liability numeric(16,2) not null check (liability >= 0),
  change numeric(16,2) not null,
  -- The posting this one measured from (null for the first).
  previous_posting_id uuid references payroll_leave_liability_postings(id),
  journal_id bigint not null unique references ledger_journals(id),
  status text not null default 'active' check (status in ('active', 'voided')),
  created_by_user_id uuid,
  created_by_email text not null,
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
  check ((status = 'voided') = (void_journal_id is not null and void_date is not null and voided_at is not null)),
  check (void_date is null or void_date >= as_at)
);
create index payroll_leave_liability_postings_active_idx on payroll_leave_liability_postings (posting_number) where status = 'active';

-- The liability posted, by Department (null: no Department). Never changed.
create table payroll_leave_liability_departments (
  posting_id uuid not null references payroll_leave_liability_postings(id),
  line_number integer not null check (line_number > 0),
  department_id bigint references tracking_values(id),
  liability numeric(16,2) not null check (liability >= 0),
  primary key (posting_id, line_number)
);
create unique index payroll_leave_liability_departments_idx on payroll_leave_liability_departments (posting_id, coalesce(department_id, 0));
create trigger payroll_leave_liability_departments_append_only
  before update or delete on payroll_leave_liability_departments
  for each row execute function tohyee_payroll_append_only('Leave liability postings');
create trigger payroll_leave_liability_departments_no_truncate
  before truncate on payroll_leave_liability_departments
  for each statement execute function tohyee_payroll_append_only('Leave liability postings');

create function tohyee_guard_leave_liability_posting() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Leave liability postings can''t be deleted; void them instead' using errcode = 'P0001';
  end if;
  if old.status = 'active' and new.status = 'voided'
     and (to_jsonb(new) - array['status', 'void_date', 'void_journal_id', 'void_command_source', 'void_idempotency_key',
                                'void_request_hash', 'voided_by_user_id', 'voided_by_email', 'voided_at'])
         = (to_jsonb(old) - array['status', 'void_date', 'void_journal_id', 'void_command_source', 'void_idempotency_key',
                                  'void_request_hash', 'voided_by_user_id', 'voided_by_email', 'voided_at']) then
    return new;
  end if;
  raise exception 'Leave liability postings can''t be changed; void them instead' using errcode = 'P0001';
end;
$$;
create trigger payroll_leave_liability_postings_guard
  before update or delete on payroll_leave_liability_postings
  for each row execute function tohyee_guard_leave_liability_posting();
create trigger payroll_leave_liability_postings_no_truncate
  before truncate on payroll_leave_liability_postings
  for each statement execute function tohyee_payroll_forbid_delete('Leave liability postings can''t be deleted; void them instead');
`,
  },
  {
    version: "0073",
    name: "payroll_leave_liability_kiwisaver",
    sql: `
-- Employer KiwiSaver on the leave liability (decision 190;
-- docs/ACCOUNTING-EXAMPLES.md HL59, HL60): each posting keeps the employer
-- KiwiSaver (gross, before ESCT) on the liability it posted, in total and by
-- Department, beside the holiday pay, so the next posting can measure each
-- from it. Postings before this measured none (0.00). ADD COLUMN with a
-- default fires no row triggers, so the append-only guards are untouched.
alter table payroll_leave_liability_postings
  add column kiwisaver numeric(16,2) not null default 0 check (kiwisaver >= 0);
alter table payroll_leave_liability_departments
  add column kiwisaver numeric(16,2) not null default 0 check (kiwisaver >= 0);
`,
  },
  {
    version: "0074",
    name: "payroll_week_settings",
    sql: `
-- Two payroll settings (docs/DECISIONS.md 192, 199; examples TS12, PREP9):
-- the first day of the timesheet week (ISO 1 = Monday to 7 = Sunday; NetSuite's
-- "first day of week" preference), and the standard week FTE is measured
-- against (40.00 hours unless changed).
alter table organisation_settings
  add column payroll_timesheet_first_day smallint not null default 1 check (payroll_timesheet_first_day between 1 and 7),
  add column payroll_standard_week numeric(5,2) not null default 40.00 check (payroll_standard_week > 0 and payroll_standard_week <= 168);

-- A timesheet's week starts on the organisation's first day, not always a
-- Monday. The day can only change while there are no timesheets (checked
-- when settings are saved, and below), so every timesheet keeps to it.
alter table payroll_timesheets drop constraint payroll_timesheets_week_start_check;

create function tohyee_check_timesheet_week_start() returns trigger
language plpgsql as $$
declare
  first_day smallint;
begin
  select payroll_timesheet_first_day into first_day from organisation_settings where id = true;
  if extract(isodow from new.week_start) <> coalesce(first_day, 1) then
    raise exception 'A timesheet week starts on the organisation''s first day of the week (ISO day %)', coalesce(first_day, 1) using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger payroll_timesheets_week_start_check
  before insert or update of week_start on payroll_timesheets
  for each row execute function tohyee_check_timesheet_week_start();

create function tohyee_guard_timesheet_first_day() returns trigger
language plpgsql as $$
begin
  if new.payroll_timesheet_first_day <> old.payroll_timesheet_first_day and exists (select 1 from payroll_timesheets) then
    raise exception 'The first day of the timesheet week can''t change once there are timesheets' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger organisation_settings_timesheet_first_day_guard
  before update of payroll_timesheet_first_day on organisation_settings
  for each row execute function tohyee_guard_timesheet_first_day();
`,
  },
  {
    version: "0075",
    name: "sales_platform_guest_contact",
    sql: `
-- Guest checkouts (decision 317; docs/ACCOUNTING-EXAMPLES.md SPC24): an
-- order without a platform customer goes to one contact chosen on the
-- connection. Null: guest checkouts are refused, as before.
alter table sales_platform_connections
  add column guest_contact_id bigint references contacts(id);
`,
  },
  {
    version: "0076",
    name: "purchase_order_close",
    sql: `
-- Closing the rest of a purchase order (decision 281; docs/ACCOUNTING-EXAMPLES.md
-- PO10; Xero's "mark as billed", NetSuite's close): an approved one with no
-- draft bills becomes closed, so what's left isn't on order any more. Its
-- approved bills stay (and can still be voided); no new bills come from it.
alter table purchase_orders drop constraint purchase_orders_status_check;
alter table purchase_orders add constraint purchase_orders_status_check check (status in ('draft', 'approved', 'cancelled', 'closed'));
alter table purchase_orders
  add column close_command_source text,
  add column close_idempotency_key text,
  add column close_request_hash text,
  add column closed_by_user_id uuid,
  add column closed_by_email text,
  add column closed_at timestamptz,
  add constraint purchase_orders_close_key unique (close_command_source, close_idempotency_key),
  add constraint purchase_orders_closed_at check ((status = 'closed') = (closed_at is not null));

create or replace function tohyee_guard_purchase_order() returns trigger
language plpgsql as $$
declare
  cancel_columns text[] := array['status', 'cancel_command_source', 'cancel_idempotency_key', 'cancel_request_hash',
    'cancelled_by_user_id', 'cancelled_by_email', 'cancelled_at', 'updated_at'];
  close_columns text[] := array['status', 'close_command_source', 'close_idempotency_key', 'close_request_hash',
    'closed_by_user_id', 'closed_by_email', 'closed_at', 'updated_at'];
begin
  if tg_op = 'TRUNCATE' then
    raise exception 'purchase_orders can''t be truncated' using errcode = 'P0001';
  end if;
  if old.status = 'draft' then
    if tg_op = 'DELETE' then
      return old;
    end if;
    if new.status in ('cancelled', 'closed') then
      raise exception 'A draft purchase order can''t be cancelled or closed; delete it instead' using errcode = 'P0001';
    end if;
    return new;
  end if;
  if tg_op = 'DELETE' then
    raise exception 'Purchase order % is %, so it can''t be deleted', old.po_number, old.status using errcode = 'P0001';
  end if;
  if old.status = 'approved' and new.status = 'cancelled'
     and (to_jsonb(new) - cancel_columns) = (to_jsonb(old) - cancel_columns) then
    if exists (select 1 from bills where purchase_order_id = old.id and status <> 'voided') then
      raise exception 'Purchase order % has bills, so it can''t be cancelled', old.po_number using errcode = 'P0001';
    end if;
    return new;
  end if;
  if old.status = 'approved' and new.status = 'closed'
     and (to_jsonb(new) - close_columns) = (to_jsonb(old) - close_columns) then
    if exists (select 1 from bills where purchase_order_id = old.id and status = 'draft') then
      raise exception 'Purchase order % has a draft bill, so it can''t be closed', old.po_number using errcode = 'P0001';
    end if;
    return new;
  end if;
  raise exception 'Purchase order % is %, so it can''t be changed', old.po_number, old.status using errcode = 'P0001';
end;
$$;

-- New bills only from an approved purchase order; a bill already from one
-- that's since been closed can still change (be voided, say).
create or replace function tohyee_check_bill_purchase_order() returns trigger
language plpgsql as $$
declare
  po record;
begin
  if tg_op = 'UPDATE' and new.purchase_order_id is distinct from old.purchase_order_id then
    raise exception 'A bill''s purchase order can''t be changed' using errcode = 'P0001';
  end if;
  if new.purchase_order_id is null then
    return new;
  end if;
  select status, contact_id into po from purchase_orders where id = new.purchase_order_id;
  if po.status <> 'approved' and not (tg_op = 'UPDATE' and po.status = 'closed') then
    raise exception 'Bills can only be made from an approved purchase order' using errcode = 'P0001';
  end if;
  if po.contact_id <> new.contact_id then
    raise exception 'A bill from a purchase order must be from the purchase order''s supplier' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
`,
  },
  {
    version: "0077",
    name: "expense_claim_receipt_gst_number",
    sql: `
-- The supplier's GST number on an expense claim receipt (decision 293;
-- docs/ACCOUNTING-EXAMPLES.md EC13): IRD's taxable supply information over
-- $200 shows it, so it's needed to claim GST on such a receipt.
alter table expense_claim_receipts
  add column supplier_gst_number text check (supplier_gst_number is null or supplier_gst_number ~ '^[0-9]{8,9}$');
`,
  },
  {
    version: "0078",
    name: "payroll_pay_run_bank_account",
    sql: `
-- The bank account each approved pay paid into (decision 262; PSLIP7),
-- encrypted as on the employee, so a payslip shows where that pay went
-- even after the employee changes account. Null for pays approved before
-- this (their payslips show the employee's current account, as before).
alter table payroll_pay_run_employees add column bank_account_ciphertext text;
`,
  },
  {
    version: "0079",
    name: "crm_opportunity_sales_order",
    sql: `
-- A won opportunity can make a sales order instead of an invoice (decision
-- 327; docs/ACCOUNTING-EXAMPLES.md CRM5b; NetSuite's opportunity to sales
-- order). One or the other, never both; once made, the stage is fixed.
alter table crm_opportunities add column sales_order_id bigint references sales_orders(id);
create unique index crm_opportunities_sales_order_idx on crm_opportunities (sales_order_id) where sales_order_id is not null;
alter table crm_opportunities add constraint crm_opportunities_one_document check (invoice_id is null or sales_order_id is null);

create or replace function tohyee_guard_crm_opportunity() returns trigger
language plpgsql as $$
begin
  if old.invoice_id is not null and (new.invoice_id is distinct from old.invoice_id or new.stage is distinct from old.stage) then
    raise exception 'This opportunity has made an invoice, so its stage can''t change' using errcode = 'P0001';
  end if;
  if old.sales_order_id is not null and (new.sales_order_id is distinct from old.sales_order_id or new.stage is distinct from old.stage) then
    raise exception 'This opportunity has made a sales order, so its stage can''t change' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create or replace function tohyee_crm_opportunity_sales_order_won() returns trigger
language plpgsql as $$
begin
  if new.sales_order_id is not null
     and (select stage_type from crm_opportunity_stages where key = new.stage) is distinct from 'won' then
    raise exception 'Only a won opportunity can have a sales order' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger crm_opportunities_sales_order_won before insert or update of stage, sales_order_id on crm_opportunities
  for each row execute function tohyee_crm_opportunity_sales_order_won();
`,
  },
  {
    version: "0080",
    name: "default_payment_terms",
    sql: `
-- The organisation's own payment terms for new invoices and for new bills,
-- used when the customer or supplier has none (decision 333; Xero's
-- default due dates in invoice settings).
alter table organisation_settings
  add column default_sales_payment_term_id bigint references payment_terms(id),
  add column default_bill_payment_term_id bigint references payment_terms(id);
`,
  },
  {
    version: "0081",
    name: "ledger_journal_drafts",
    sql: `
-- Draft manual journals (decisions 349-352; examples MJD1-MJD9, like Xero's
-- draft manual journals). A draft posts nothing. Posting it posts one manual
-- journal through the usual path (balanced, open period, account rules) and
-- links it here; a posted draft can't change or be deleted. Drafts can be
-- deleted by people (not by AI keys, which never delete).
create table ledger_journal_drafts (
  id bigserial primary key,
  command_source text not null,
  idempotency_key text not null,
  request_hash text not null,
  status text not null default 'draft' check (status in ('draft', 'posted')),
  posting_date date not null,
  reference text not null check (length(reference) between 1 and 100),
  description text,
  custom_fields jsonb not null default '{}'::jsonb,
  total numeric not null check (total > 0),
  created_by_user_id uuid,
  created_by_email text not null,
  -- e.g. 'AI key "Claude on my laptop"' when an AI key made it; null for a person.
  created_via text,
  created_at timestamptz not null default now(),
  updated_by_email text,
  updated_via text,
  updated_at timestamptz not null default now(),
  posted_journal_id bigint unique references ledger_journals(id),
  posted_by_email text,
  posted_via text,
  posted_at timestamptz,
  unique (command_source, idempotency_key),
  check ((status = 'posted') = (posted_journal_id is not null))
);
create index ledger_journal_drafts_status_idx on ledger_journal_drafts (status, id desc);

create table ledger_journal_draft_lines (
  draft_id bigint not null references ledger_journal_drafts(id) on delete cascade,
  line_order integer not null check (line_order > 0),
  account_id bigint not null references accounts(id),
  description text,
  debit_amount numeric not null default 0 check (debit_amount >= 0),
  credit_amount numeric not null default 0 check (credit_amount >= 0),
  tracking jsonb not null default '{}'::jsonb,
  custom_fields jsonb not null default '{}'::jsonb,
  foreign_amount numeric,
  exchange_rate numeric,
  primary key (draft_id, line_order),
  check ((debit_amount > 0) <> (credit_amount > 0)),
  check ((foreign_amount is null) = (exchange_rate is null))
);

-- A posted draft is history: it can't change (other than nothing) or be deleted.
create function tohyee_guard_journal_draft() returns trigger
language plpgsql as $$
begin
  if old.status = 'posted' then
    raise exception 'This draft journal has been posted, so it can''t be changed or deleted' using errcode = 'P0001';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;
create trigger ledger_journal_drafts_guard before update or delete on ledger_journal_drafts
  for each row execute function tohyee_guard_journal_draft();

create function tohyee_guard_journal_draft_line() returns trigger
language plpgsql as $$
begin
  if (select status from ledger_journal_drafts where id = coalesce(new.draft_id, old.draft_id)) = 'posted' then
    raise exception 'This draft journal has been posted, so its lines can''t change' using errcode = 'P0001';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;
create trigger ledger_journal_draft_lines_guard before insert or update or delete on ledger_journal_draft_lines
  for each row execute function tohyee_guard_journal_draft_line();
`,
  },
  {
    version: "0082",
    name: "analytics_sources_and_loads",
    sql: `
-- Analytics (decisions 353-358). The module is switched on per organisation.
alter table organisation_settings add column analytics_enabled boolean not null default false;

-- A file in the organisation's analytics folder and how it's loaded: which
-- columns, named what, as which type (money as exact decimals, decision 356).
-- The loaded data itself lives in the organisation's DuckDB file.
create table analytics_sources (
  id bigserial primary key,
  name text not null check (length(name) between 1 and 100),
  -- The DuckDB table it loads into.
  table_name text not null unique check (table_name ~ '^[a-z][a-z0-9_]{0,62}$' and table_name not like '_tohyee%'),
  -- Path inside the organisation's folder, with / between folders.
  file_name text not null check (length(file_name) between 1 and 500),
  delimiter text not null default ',' check (length(delimiter) = 1),
  -- [{ "source": "Unit price", "name": "unit_price", "kind": "money" }]
  columns jsonb not null check (jsonb_typeof(columns) = 'array' and jsonb_array_length(columns) > 0),
  reload_daily boolean not null default true,
  created_by_email text not null,
  created_at timestamptz not null default now(),
  updated_by_email text not null,
  updated_at timestamptz not null default now()
);

-- Every load, written by the loader as it works (decision 357), never
-- typed in. Kept when a source is removed, so the history stays.
create table analytics_load_runs (
  id bigserial primary key,
  source_id bigint references analytics_sources(id) on delete set null,
  source_name text not null,
  table_name text not null,
  file_name text not null,
  trigger text not null check (trigger in ('schedule', 'manual')),
  status text not null default 'running' check (status in ('running', 'ok', 'failed')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  rows_loaded bigint,
  milliseconds integer,
  error text,
  requested_by_email text
);
create index analytics_load_runs_source_idx on analytics_load_runs (source_id, started_at desc);
create index analytics_load_runs_started_idx on analytics_load_runs (started_at desc);
`,
  },
  {
    version: "0083",
    name: "analytics_dashboards",
    sql: `
-- Analytics dashboards (step 3 of docs/ANALYTICS-REVIEW.md): tiles that each
-- ask one question of a loaded table, with a date range and slicers for the
-- whole dashboard. The questions are kept here (backed up with the
-- organisation); the answers are worked out from the DuckDB file each time.
create table analytics_dashboards (
  id bigserial primary key,
  name text not null check (length(name) between 1 and 100),
  description text check (description is null or length(description) <= 500),
  -- { "from": "2026-01-01" | null, "to": ... , "slicers": [{ "field": "region", "label": "Region" }] }
  settings jsonb not null default '{}'::jsonb check (jsonb_typeof(settings) = 'object'),
  -- [{ "id", "title", "visual", "width", "query": { table, groupBy, measures, filters, dateField, sort, limit } }]
  tiles jsonb not null default '[]'::jsonb check (jsonb_typeof(tiles) = 'array'),
  created_by_email text not null,
  created_at timestamptz not null default now(),
  updated_by_email text not null,
  updated_at timestamptz not null default now()
);
`,
  },
  {
    version: "0084",
    name: "gst_late_claims",
    sql: `
-- Late claims (examples LG1-LG7, like Xero's): a line dated in an earlier
-- filed return's period that the earlier return didn't count, counted in a
-- later return. late_from_return_id is the filed return it belongs to; null
-- for the return's own period. A line can only be claimed late from a return
-- whose period ends before the claiming return starts.
-- late_reversal: the line takes back off a line the earlier return counted
-- that has since changed or gone (its amounts are that line's, negated).
alter table gst_return_lines add column late_from_return_id bigint references gst_returns(id),
  add column late_reversal boolean not null default false,
  add constraint gst_return_lines_late_reversal_check check (not late_reversal or late_from_return_id is not null);
create index gst_return_lines_late_from_idx on gst_return_lines (late_from_return_id) where late_from_return_id is not null;
`,
  },
  {
    version: "0085",
    name: "analytics_dashboard_shares",
    sql: `
-- Dashboards shared with report viewers (decision 360): they see only these,
-- after signing in. user_id is the core database's user id.
create table analytics_dashboard_shares (
  dashboard_id bigint not null references analytics_dashboards(id) on delete cascade,
  user_id text not null check (user_id ~ '^[0-9a-f-]{36}$'),
  shared_by_email text not null,
  shared_at timestamptz not null default now(),
  primary key (dashboard_id, user_id)
);
create index analytics_dashboard_shares_user_idx on analytics_dashboard_shares (user_id);
`,
  },
  {
    version: "0086",
    name: "custom_transaction_reports",
    sql: `
alter table custom_reports drop constraint custom_reports_base_check;
alter table custom_reports add constraint custom_reports_base_check
  check (base in ('profit_and_loss', 'balance_sheet', 'account_transactions', 'aged_receivables', 'aged_payables', 'sales_by_salesperson', 'journal_report'));
`,
  },
  {
    version: "0087",
    name: "analytics_shaped_tables",
    sql: `
-- Shaping definitions stay with the organisation's backed-up data. The
-- transformed rows themselves live in its rebuildable DuckDB file.
create table analytics_shaped_tables (
  id bigserial primary key,
  name text not null check (length(name) between 1 and 100),
  table_name text not null unique check (
    table_name ~ '^[a-z][a-z0-9_]{0,62}$'
    and table_name not like 'tohyee\\_%' escape '\\'
  ),
  base_table text not null check (base_table ~ '^[a-z][a-z0-9_]{0,62}$'),
  steps jsonb not null default '[]'::jsonb
    check (jsonb_typeof(steps) = 'array' and jsonb_array_length(steps) <= 100),
  created_by_email text not null,
  created_at timestamptz not null default now(),
  updated_by_email text not null,
  updated_at timestamptz not null default now()
);
create index analytics_shaped_tables_base_idx on analytics_shaped_tables (base_table);

-- Keep rebuilds in the same history as CSV and books loads. Deleting a
-- definition keeps its history, just as deleting a CSV source does.
alter table analytics_load_runs add column shaped_table_id bigint
  references analytics_shaped_tables(id) on delete set null;
create index analytics_load_runs_shape_idx on analytics_load_runs (shaped_table_id, started_at desc);
`,
  },
  {
    version: "0088",
    name: "analytics_report_emails",
    sql: `
create table analytics_report_mailboxes (
  id bigserial primary key,
  kind text not null check (kind in ('crm', 'imap')),
  account_id bigint references crm_connected_accounts(id) on delete cascade,
  owner_user_id uuid not null,
  host text,
  port integer,
  username text,
  password_ciphertext text,
  folder_id text not null check (length(folder_id) between 1 and 500),
  folder_name text not null check (length(folder_name) between 1 and 500),
  replace_files boolean not null default true,
  lease_id uuid,
  lease_until timestamptz,
  last_check_at timestamptz,
  created_by_email text not null,
  updated_at timestamptz not null default now(),
  check ((kind = 'crm' and account_id is not null and host is null and port is null and username is null and password_ciphertext is null)
      or (kind = 'imap' and account_id is null and host is not null and port = 993 and username is not null and password_ciphertext is not null))
);
create table analytics_report_email_checks (
  id bigserial primary key,
  mailbox_id bigint not null references analytics_report_mailboxes(id) on delete cascade,
  trigger text not null check (trigger in ('manual', 'schedule')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  files_saved integer not null default 0 check (files_saved >= 0),
  error text,
  status text not null default 'running' check (status in ('running', 'ok', 'failed')),
  requested_by_email text not null,
  files jsonb not null default '[]'::jsonb
);
create index analytics_report_email_checks_mailbox_idx on analytics_report_email_checks (mailbox_id, started_at desc);
-- Messages already dealt with: saved, or failed. A failed message is tried
-- again on later checks, up to three times, then left with its reason.
create table analytics_report_email_messages (
  mailbox_id bigint not null references analytics_report_mailboxes(id) on delete cascade,
  message_id text not null,
  received_at timestamptz,
  saved_at timestamptz not null default now(),
  status text not null default 'saved' check (status in ('saved', 'failed')),
  attempts integer not null default 1 check (attempts between 1 and 3),
  error text,
  primary key (mailbox_id, message_id)
);
-- Reserve the newest receipt before filesystem writes. Retrying that same
-- message can finish a crashed write, but an older receipt cannot replace it.
create table analytics_report_email_outputs (
  mailbox_id bigint not null references analytics_report_mailboxes(id) on delete cascade,
  output_name text not null,
  received_at timestamptz not null,
  message_id text not null,
  primary key (mailbox_id, output_name)
);
`,
  },
  {
    version: "0089",
    name: "dashboard_preferences",
    sql: `
create table dashboard_preferences (
  user_id uuid not null,
  page text not null check (length(page) between 1 and 120),
  hidden boolean not null default false,
  tiles jsonb not null default '[]'::jsonb
    check (jsonb_typeof(tiles) = 'array'),
  updated_at timestamptz not null default now(),
  primary key (user_id, page)
);
`,
  },
  {
    version: "0090",
    name: "analytics_source_excel_sheets",
    sql: `
alter table analytics_sources add column sheet_name text
  check (sheet_name is null or length(sheet_name) between 1 and 31);
`,
  },
  {
    version: "0091",
    name: "bank_rule_conditions_lines_and_contact_defaults",
    sql: `
-- Bank rules with several conditions and split lines (BR1-BR10, decisions
-- 380-383). Each existing rule becomes one text condition and one 100% line,
-- so it suggests exactly what it did before (BR10).
alter table bank_rules add column match_mode text not null default 'all' check (match_mode in ('all', 'any'));
alter table bank_rules add column contact_mode text not null default 'chosen' check (contact_mode in ('chosen', 'payee'));
alter table bank_rules alter column contact_id drop not null;
alter table bank_rules add constraint bank_rules_contact_chosen_check
  check ((contact_mode = 'chosen') = (contact_id is not null));

create table bank_rule_conditions (
  id bigserial primary key,
  rule_id bigint not null references bank_rules(id) on delete cascade,
  position integer not null check (position between 1 and 10),
  field text not null check (field in ('any', 'description', 'payee', 'particulars', 'code', 'reference', 'amount')),
  operator text not null check (operator in ('contains', 'equals', 'starts_with', 'at_least', 'at_most', 'between')),
  text_value text,
  amount_from numeric(18, 2),
  amount_to numeric(18, 2),
  unique (rule_id, position),
  check (
    case when field = 'amount' then
      operator in ('equals', 'at_least', 'at_most', 'between')
      and text_value is null and amount_from is not null and amount_from >= 0
      and (operator = 'between') = (amount_to is not null)
      and (amount_to is null or amount_to >= amount_from)
    else
      operator in ('contains', 'equals', 'starts_with')
      and text_value is not null and length(text_value) between 1 and 200
      and amount_from is null and amount_to is null
    end
  )
);

create table bank_rule_lines (
  id bigserial primary key,
  rule_id bigint not null references bank_rules(id) on delete cascade,
  position integer not null check (position between 1 and 20),
  account_id bigint not null references accounts(id),
  tax_code_id bigint references tax_codes(id),
  description text check (description is null or length(description) between 1 and 500),
  tracking jsonb not null default '{}'::jsonb check (jsonb_typeof(tracking) = 'object'),
  fixed_amount numeric(18, 2) check (fixed_amount is null or fixed_amount > 0),
  percentage numeric(5, 2) check (percentage is null or (percentage > 0 and percentage <= 100)),
  unique (rule_id, position),
  check ((fixed_amount is null) <> (percentage is null))
);
create index bank_rule_lines_tax_code_idx on bank_rule_lines (tax_code_id);

insert into bank_rule_conditions (rule_id, position, field, operator, text_value)
select id, 1, match_field, 'contains', match_text from bank_rules;
insert into bank_rule_lines (rule_id, position, account_id, tax_code_id, description, percentage)
select id, 1, target_account_id, tax_code_id, line_description, 100 from bank_rules;

drop trigger bank_rules_tax_code_check on bank_rules;
drop function tohyee_check_bank_rule_tax_code();
-- The statement line's amount includes GST, so a rule's lines are GST inclusive
-- when they have a GST code and have no tax otherwise (decision 381).
alter table bank_rules drop column match_field, drop column match_text, drop column target_account_id,
  drop column tax_code_id, drop column line_description, drop column amounts_mode;

-- A rule's line codes money in as receive money (sales), money out as spend
-- money (purchases), either as both (TAO8). Checked when a line is saved and
-- when the rule's direction changes.
create function tohyee_bank_rule_line_tax_ok(code_id bigint, direction text) returns boolean
language sql stable as $$
  select (direction not in ('in', 'any') or tohyee_tax_code_available(code_id, 'sales'))
     and (direction not in ('out', 'any') or tohyee_tax_code_available(code_id, 'purchases'))
$$;
create function tohyee_check_bank_rule_line_tax_code() returns trigger
language plpgsql as $$
begin
  if not tohyee_bank_rule_line_tax_ok(new.tax_code_id, (select direction from bank_rules where id = new.rule_id)) then
    raise exception 'A bank rule''s tax code must be available on the side it codes (money in: sales; out: purchases; either: both)'
      using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger bank_rule_lines_tax_code_check
  before insert or update of tax_code_id, rule_id on bank_rule_lines
  for each row execute function tohyee_check_bank_rule_line_tax_code();
create function tohyee_check_bank_rule_direction() returns trigger
language plpgsql as $$
begin
  if exists (select 1 from bank_rule_lines l where l.rule_id = new.id and not tohyee_bank_rule_line_tax_ok(l.tax_code_id, new.direction)) then
    raise exception 'A bank rule''s tax code must be available on the side it codes (money in: sales; out: purchases; either: both)'
      using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger bank_rules_direction_check
  before update of direction on bank_rules
  for each row execute function tohyee_check_bank_rule_direction();

-- Contacts' default accounts and tracking (SD1-SD3, decision 384).
alter table contacts add column default_purchase_account_id bigint references accounts(id);
alter table contacts add column default_sales_account_id bigint references accounts(id);
alter table contacts add column default_purchase_tracking jsonb not null default '{}'::jsonb
  check (jsonb_typeof(default_purchase_tracking) = 'object');
alter table contacts add column default_sales_tracking jsonb not null default '{}'::jsonb
  check (jsonb_typeof(default_sales_tracking) = 'object');

-- The "Available on" backstop (TAO10), now looking at rule lines.
create or replace function tohyee_guard_tax_code_available_on() returns trigger
language plpgsql as $$
begin
  if new.available_on = old.available_on or new.available_on = 'both' then
    return new;
  end if;
  if new.available_on = 'purchases' and (
       exists (select 1 from contacts where default_sales_tax_code_id = old.id)
       or exists (select 1 from organisation_settings where export_tax_code_id = old.id)
       or exists (select 1 from items where sales_tax_code_id = old.id)
       or exists (select 1 from bank_rule_lines l join bank_rules r on r.id = l.rule_id
                   where l.tax_code_id = old.id and r.direction in ('in', 'any'))) then
    raise exception 'Tax code % is used for sales, so it can''t be made available on purchases only', old.code
      using errcode = '23514';
  end if;
  if new.available_on = 'sales' and (
       exists (select 1 from contacts where default_purchase_tax_code_id = old.id)
       or exists (select 1 from items where purchase_tax_code_id = old.id)
       or exists (select 1 from bank_rule_lines l join bank_rules r on r.id = l.rule_id
                   where l.tax_code_id = old.id and r.direction in ('out', 'any'))) then
    raise exception 'Tax code % is used for purchases, so it can''t be made available on sales only', old.code
      using errcode = '23514';
  end if;
  return new;
end;
$$;
`,
  },
  {
    version: "0092",
    name: "bank_file_feeds",
    sql: `
-- Automatic statement files (BF1-BF10, decisions 385-387): a folder feed reads
-- one subfolder of the organisation's bank files folder (chosen by a server
-- admin); a mailbox feed reads one mailbox folder or Gmail label. Files go
-- through the statement importers; nothing is posted.
create table bank_file_feeds (
  id bigserial primary key,
  account_id bigint not null references accounts(id),
  kind text not null check (kind in ('folder', 'mailbox')),
  subfolder text check (subfolder is null or length(subfolder) between 1 and 255),
  mail_kind text check (mail_kind in ('crm', 'imap')),
  mail_account_id bigint references crm_connected_accounts(id) on delete set null,
  imap_host text check (imap_host is null or length(imap_host) between 1 and 253),
  imap_username text check (imap_username is null or length(imap_username) between 1 and 320),
  imap_password_ciphertext text,
  mail_folder_id text check (mail_folder_id is null or length(mail_folder_id) between 1 and 500),
  mail_folder_name text check (mail_folder_name is null or length(mail_folder_name) between 1 and 500),
  owner_user_id uuid,
  sync_every_hours integer not null default 6 check (sync_every_hours between 1 and 24),
  last_check_at timestamptz,
  last_status text check (last_status in ('ok', 'failed')),
  last_error text check (last_error is null or length(last_error) <= 1000),
  last_files_read integer check (last_files_read >= 0),
  last_lines_added integer check (last_lines_added >= 0),
  lease_until timestamptz,
  created_by_email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (kind = 'folder' and subfolder is not null and mail_kind is null and mail_folder_id is null)
    or (kind = 'mailbox' and subfolder is null and mail_kind is not null and mail_folder_id is not null and owner_user_id is not null
        and (mail_kind <> 'imap' or (imap_host is not null and imap_username is not null and imap_password_ciphertext is not null)))
  )
);
create index bank_file_feeds_account_idx on bank_file_feeds (account_id);

-- What each place has already given an account, kept when a feed is removed
-- so linking the same place again doesn't import old files twice (BF10). A
-- file is seen again only when its contents change (BF3).
create table bank_file_feed_seen (
  account_id bigint not null references accounts(id),
  location text not null check (length(location) between 1 and 1200),
  item_key text not null check (length(item_key) between 1 and 1200),
  content_hash text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  result text not null check (result in ('imported', 'no_new', 'failed')),
  reason text check (reason is null or length(reason) <= 1000),
  import_id bigint references bank_statement_imports(id),
  lines_added integer not null default 0 check (lines_added >= 0),
  seen_at timestamptz not null default now(),
  primary key (account_id, location, item_key, content_hash)
);

alter table bank_statement_imports add column file_feed text check (file_feed in ('folder', 'mailbox'));
`,
  },
  {
    version: "0093",
    name: "simplefin_feeds",
    sql: `
-- SimpleFIN bank feeds (SF1-SF10, decisions 388-391): the organisation's own
-- SimpleFIN Bridge connection. The access URL (which holds its credentials) is
-- encrypted with the server's TOHYEE_SECRET_KEY and cleared on disconnect.
-- One active connection at a time.
create table simplefin_connections (
  id bigserial primary key,
  access_url_ciphertext text,
  host text not null check (length(host) between 1 and 253),
  sync_every_hours integer not null default 6 check (sync_every_hours between 1 and 24),
  sync_minute integer not null check (sync_minute between 0 and 59),
  status text not null default 'active' check (status in ('active', 'removed')),
  last_synced_at timestamptz,
  last_sync_status text not null default 'never' check (last_sync_status in ('never', 'ok', 'failed')),
  last_sync_error text,
  last_problems jsonb not null default '[]'::jsonb,
  -- The accounts the Bridge last listed (id, name, currency, connection), for linking.
  accounts jsonb not null default '[]'::jsonb,
  lease_until timestamptz,
  created_by_email text,
  created_at timestamptz not null default now(),
  removed_at timestamptz,
  removed_by_email text,
  check ((status = 'active') = (removed_at is null)),
  check (status = 'removed' or access_url_ciphertext is not null)
);
create unique index simplefin_connections_one_active on simplefin_connections ((true)) where status = 'active';

-- Every request made to the Bridge, so Tohyee stays under its 24 a day (SF5).
create table simplefin_requests (
  id bigserial primary key,
  connection_id bigint not null references simplefin_connections(id),
  made_at timestamptz not null default now()
);
create index simplefin_requests_made_at_idx on simplefin_requests (made_at);

-- A SimpleFIN account linked to a bank or credit card account: its currency
-- (which must be the account's), the first date to bring in, and the time
-- zone that turns SimpleFIN's posted times into dates (SF3).
create table simplefin_links (
  account_id bigint primary key references accounts(id),
  connection_id bigint references simplefin_connections(id),
  simplefin_account_id text not null check (length(simplefin_account_id) between 1 and 200),
  simplefin_account_name text check (simplefin_account_name is null or length(simplefin_account_name) <= 200),
  connection_name text check (connection_name is null or length(connection_name) <= 200),
  currency_code text not null check (currency_code ~ '^[A-Z]{3}$'),
  start_date date not null,
  time_zone text not null check (length(time_zone) between 1 and 64),
  active boolean not null default true,
  last_synced_at timestamptz,
  last_sync_status text not null default 'never' check (last_sync_status in ('never', 'ok', 'failed')),
  last_sync_error text,
  last_skipped jsonb not null default '[]'::jsonb,
  created_by_email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (not active or connection_id is not null)
);
create unique index simplefin_links_account_once on simplefin_links (simplefin_account_id) where active;

alter table bank_statement_imports drop constraint bank_statement_imports_source_check;
alter table bank_statement_imports add constraint bank_statement_imports_source_check check (source in ('file', 'akahu', 'simplefin'));
alter table bank_statement_imports drop constraint bank_statement_imports_file_format_check;
alter table bank_statement_imports add constraint bank_statement_imports_file_format_check
  check (file_format in ('csv', 'xlsx', 'ofx', 'qif', 'camt053', 'mt940', 'akahu', 'simplefin'));
`,
  },
  {
    version: "0094",
    name: "stripe_feeds",
    sql: `
-- Stripe as a bank feed (ST1-ST10, decisions 392-395): the organisation's own
-- restricted Stripe API key, encrypted with the server's TOHYEE_SECRET_KEY and
-- cleared on disconnect. One active connection at a time.
create table stripe_connections (
  id bigserial primary key,
  api_key_ciphertext text,
  key_hint text not null check (length(key_hint) between 1 and 40),
  live_mode boolean not null,
  sync_every_hours integer not null default 6 check (sync_every_hours between 1 and 24),
  status text not null default 'active' check (status in ('active', 'removed')),
  -- Stripe's balance per currency when last read: [{currency, available, pending}].
  balances jsonb not null default '[]'::jsonb,
  last_synced_at timestamptz,
  last_sync_status text not null default 'never' check (last_sync_status in ('never', 'ok', 'failed')),
  last_sync_error text,
  lease_until timestamptz,
  created_by_email text,
  created_at timestamptz not null default now(),
  removed_at timestamptz,
  removed_by_email text,
  check ((status = 'active') = (removed_at is null)),
  check (status = 'removed' or api_key_ciphertext is not null)
);
create unique index stripe_connections_one_active on stripe_connections ((true)) where status = 'active';

-- A Stripe balance currency linked to a bank account in that currency.
create table stripe_links (
  account_id bigint primary key references accounts(id),
  connection_id bigint references stripe_connections(id),
  currency_code text not null check (currency_code ~ '^[A-Z]{3}$'),
  start_date date not null,
  active boolean not null default true,
  last_synced_at timestamptz,
  last_sync_status text not null default 'never' check (last_sync_status in ('never', 'ok', 'failed')),
  last_sync_error text,
  created_by_email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (not active or connection_id is not null)
);
create unique index stripe_links_currency_once on stripe_links (currency_code) where active;

alter table bank_statement_imports drop constraint bank_statement_imports_source_check;
alter table bank_statement_imports add constraint bank_statement_imports_source_check check (source in ('file', 'akahu', 'simplefin', 'stripe'));
alter table bank_statement_imports drop constraint bank_statement_imports_file_format_check;
alter table bank_statement_imports add constraint bank_statement_imports_file_format_check
  check (file_format in ('csv', 'xlsx', 'ofx', 'qif', 'camt053', 'mt940', 'akahu', 'simplefin', 'stripe'));
`,
  },
  {
    version: "0095",
    name: "paypal_feeds",
    sql: `
-- PayPal as a bank feed (PP1-PP10, decisions 396-399): the organisation's own
-- PayPal REST app. Its client secret (PayPal has no read-only credentials) is
-- encrypted with the server's TOHYEE_SECRET_KEY and cleared on disconnect.
create table paypal_connections (
  id bigserial primary key,
  client_id text not null check (length(client_id) between 1 and 200),
  client_secret_ciphertext text,
  sync_every_hours integer not null default 6 check (sync_every_hours between 1 and 24),
  status text not null default 'active' check (status in ('active', 'removed')),
  -- PayPal's balances when last read: [{currency, total, available, withheld}].
  balances jsonb not null default '[]'::jsonb,
  last_synced_at timestamptz,
  last_sync_status text not null default 'never' check (last_sync_status in ('never', 'ok', 'failed')),
  last_sync_error text,
  lease_until timestamptz,
  created_by_email text,
  created_at timestamptz not null default now(),
  removed_at timestamptz,
  removed_by_email text,
  check ((status = 'active') = (removed_at is null)),
  check (status = 'removed' or client_secret_ciphertext is not null)
);
create unique index paypal_connections_one_active on paypal_connections ((true)) where status = 'active';

-- A PayPal balance currency linked to a bank account in that currency.
create table paypal_links (
  account_id bigint primary key references accounts(id),
  connection_id bigint references paypal_connections(id),
  currency_code text not null check (currency_code ~ '^[A-Z]{3}$'),
  start_date date not null,
  active boolean not null default true,
  last_synced_at timestamptz,
  last_sync_status text not null default 'never' check (last_sync_status in ('never', 'ok', 'failed')),
  last_sync_error text,
  created_by_email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (not active or connection_id is not null)
);
create unique index paypal_links_currency_once on paypal_links (currency_code) where active;

alter table bank_statement_imports drop constraint bank_statement_imports_source_check;
alter table bank_statement_imports add constraint bank_statement_imports_source_check
  check (source in ('file', 'akahu', 'simplefin', 'stripe', 'paypal'));
alter table bank_statement_imports drop constraint bank_statement_imports_file_format_check;
alter table bank_statement_imports add constraint bank_statement_imports_file_format_check
  check (file_format in ('csv', 'xlsx', 'ofx', 'qif', 'camt053', 'mt940', 'akahu', 'simplefin', 'stripe', 'paypal'));
`,
  },
  {
    version: "0096",
    name: "wise_feeds",
    sql: `
-- Wise as a bank feed (WI1-WI10, decisions 400-403): the organisation's own
-- Wise business account, read with a personal API token (not read-only),
-- encrypted with the server's TOHYEE_SECRET_KEY and cleared on disconnect.
create table wise_connections (
  id bigserial primary key,
  token_ciphertext text,
  profile_id bigint not null,
  profile_name text check (profile_name is null or length(profile_name) <= 200),
  sync_every_hours integer not null default 6 check (sync_every_hours between 1 and 24),
  status text not null default 'active' check (status in ('active', 'removed')),
  -- The profile's standard balances when last read: [{id, currency, amount}].
  balances jsonb not null default '[]'::jsonb,
  last_synced_at timestamptz,
  last_sync_status text not null default 'never' check (last_sync_status in ('never', 'ok', 'failed')),
  last_sync_error text,
  lease_until timestamptz,
  created_by_email text,
  created_at timestamptz not null default now(),
  removed_at timestamptz,
  removed_by_email text,
  check ((status = 'active') = (removed_at is null)),
  check (status = 'removed' or token_ciphertext is not null)
);
create unique index wise_connections_one_active on wise_connections ((true)) where status = 'active';

-- A Wise currency balance linked to a bank account in that currency.
create table wise_links (
  account_id bigint primary key references accounts(id),
  connection_id bigint references wise_connections(id),
  balance_id bigint not null,
  currency_code text not null check (currency_code ~ '^[A-Z]{3}$'),
  start_date date not null,
  active boolean not null default true,
  last_synced_at timestamptz,
  last_sync_status text not null default 'never' check (last_sync_status in ('never', 'ok', 'failed')),
  last_sync_error text,
  created_by_email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (not active or connection_id is not null)
);
create unique index wise_links_currency_once on wise_links (currency_code) where active;

alter table bank_statement_imports drop constraint bank_statement_imports_source_check;
alter table bank_statement_imports add constraint bank_statement_imports_source_check
  check (source in ('file', 'akahu', 'simplefin', 'stripe', 'paypal', 'wise'));
alter table bank_statement_imports drop constraint bank_statement_imports_file_format_check;
alter table bank_statement_imports add constraint bank_statement_imports_file_format_check
  check (file_format in ('csv', 'xlsx', 'ofx', 'qif', 'camt053', 'mt940', 'akahu', 'simplefin', 'stripe', 'paypal', 'wise'));
`,
  },
  {
    version: "0097",
    name: "bills_inbox_and_mileage",
    sql: `
-- Bills inbox mailboxes (BI2, decisions 404-406): one mailbox folder or Gmail
-- label read through an admin's own CRM mailbox, or IMAP with an app password
-- (stored encrypted). PDF and image attachments become inbox items.
create table bill_inbox_mailboxes (
  id bigserial primary key,
  mail_kind text not null check (mail_kind in ('crm', 'imap')),
  mail_account_id bigint references crm_connected_accounts(id) on delete set null,
  imap_host text check (imap_host is null or length(imap_host) between 1 and 253),
  imap_username text check (imap_username is null or length(imap_username) between 1 and 320),
  imap_password_ciphertext text,
  mail_folder_id text not null check (length(mail_folder_id) between 1 and 500),
  mail_folder_name text not null check (length(mail_folder_name) between 1 and 500),
  owner_user_id uuid not null,
  sync_every_hours integer not null default 1 check (sync_every_hours between 1 and 24),
  last_check_at timestamptz,
  last_status text check (last_status in ('ok', 'failed')),
  last_error text check (last_error is null or length(last_error) <= 1000),
  last_files_added integer check (last_files_added >= 0),
  last_files_skipped integer check (last_files_skipped >= 0),
  lease_until timestamptz,
  created_by_email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (mail_kind <> 'imap' or (imap_host is not null and imap_username is not null and imap_password_ciphertext is not null))
);

-- Messages a mailbox place has given the inbox: each is read once (BI2), and
-- removing the mailbox doesn't forget them.
create table bill_inbox_mail_seen (
  location text not null check (length(location) between 1 and 1200),
  message_id text not null check (length(message_id) between 1 and 1000),
  files_added integer not null default 0 check (files_added >= 0),
  seen_at timestamptz not null default now(),
  primary key (location, message_id)
);

-- The bills inbox (BI1-BI7): supplier bills and receipts that arrived but
-- aren't bills yet. Nothing here posts. An item is waiting until a bill is
-- made from it (bill_id) or someone removes it with a reason; a removed
-- item's file is dropped and the row kept for the history.
create table bill_inbox_items (
  id bigserial primary key,
  command_source text not null,
  idempotency_key text not null,
  request_hash text not null,
  source text not null check (source in ('upload', 'mailbox', 'ai')),
  file_name text not null check (length(file_name) between 1 and 255),
  content_type text not null check (content_type in ('application/pdf', 'image/jpeg', 'image/png', 'image/heic')),
  byte_size integer not null check (byte_size between 1 and 10485760),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  content bytea,
  mailbox_id bigint references bill_inbox_mailboxes(id) on delete set null,
  email_from text check (email_from is null or length(email_from) <= 500),
  email_subject text check (email_subject is null or length(email_subject) <= 1000),
  email_date timestamptz,
  bill_id bigint references bills(id) on delete set null,
  made_by_email text,
  made_via text,
  made_at timestamptz,
  removed_at timestamptz,
  removed_by_email text,
  removed_reason text check (removed_reason is null or length(removed_reason) between 1 and 500),
  created_by_user_id uuid,
  created_by_email text not null,
  created_at timestamptz not null default now(),
  unique (command_source, idempotency_key),
  check ((removed_at is null) = (removed_by_email is null)),
  check ((removed_at is null) = (removed_reason is null)),
  check ((removed_at is null) = (content is not null)),
  check (removed_at is null or bill_id is null),
  check (content is null or octet_length(content) = byte_size)
);
create unique index bill_inbox_items_bill_once on bill_inbox_items (bill_id) where bill_id is not null;
create index bill_inbox_items_sha256_idx on bill_inbox_items (sha256);
create index bill_inbox_items_waiting_idx on bill_inbox_items (id) where bill_id is null and removed_at is null;

-- IRD kilometre rates per income year (1 April - 31 March, named by the year
-- it ends) and vehicle type (MI1, decisions 407-410). Admins enter them; a
-- year's rates are fixed once an approved claim used them. Tohyee starts
-- with the rates IRD published for 2025-26 (OS 19/04).
create table mileage_rates (
  year_ending integer not null check (year_ending between 2000 and 2200),
  vehicle_type text not null check (vehicle_type in ('petrol', 'diesel', 'petrol_hybrid', 'electric')),
  tier1_rate numeric not null check (tier1_rate > 0 and tier1_rate < 100 and scale(tier1_rate) <= 4),
  tier2_rate numeric not null check (tier2_rate > 0 and tier2_rate < 100 and scale(tier2_rate) <= 4),
  updated_by_email text,
  updated_at timestamptz not null default now(),
  primary key (year_ending, vehicle_type)
);
insert into mileage_rates (year_ending, vehicle_type, tier1_rate, tier2_rate, updated_by_email) values
  (2026, 'petrol', 1.20, 0.37, 'tohyee'),
  (2026, 'diesel', 1.30, 0.38, 'tohyee'),
  (2026, 'petrol_hybrid', 0.90, 0.24, 'tohyee'),
  (2026, 'electric', 1.22, 0.23, 'tohyee');

-- Mileage lines on expense claims (MI2-MI7): kilometres times the kilometre
-- rate, with how it was worked out kept on the line. No GST (question 4).
alter table expense_claim_receipts
  add column kind text not null default 'receipt' check (kind in ('receipt', 'mileage')),
  add column from_place text check (from_place is null or length(from_place) between 1 and 200),
  add column to_place text check (to_place is null or length(to_place) between 1 and 200),
  add column km numeric check (km is null or (km > 0 and km <= 2000 and scale(km) <= 1)),
  add column vehicle_type text check (vehicle_type is null or vehicle_type in ('petrol', 'diesel', 'petrol_hybrid', 'electric')),
  add column rate_year_ending integer,
  add column tier1_km numeric check (tier1_km is null or tier1_km >= 0),
  add column tier1_rate numeric check (tier1_rate is null or tier1_rate > 0),
  add column tier2_km numeric check (tier2_km is null or tier2_km >= 0),
  add column tier2_rate numeric check (tier2_rate is null or tier2_rate > 0),
  add column rate_note text check (rate_note is null or length(rate_note) <= 200),
  add column tier_override text check (tier_override is null or tier_override in ('tier1', 'tier2')),
  add constraint expense_claim_receipts_mileage_check check (
    (kind = 'receipt' and km is null and vehicle_type is null and from_place is null and to_place is null and rate_year_ending is null
       and tier1_km is null and tier1_rate is null and tier2_km is null and tier2_rate is null and rate_note is null and tier_override is null)
    or (kind = 'mileage' and km is not null and vehicle_type is not null and from_place is not null and to_place is not null
       and rate_year_ending is not null and tier1_km is not null and tier1_rate is not null and tier2_km is not null and tier2_rate is not null
       and tier1_km + tier2_km = km and tax_code_id is null and tax_amount = 0 and supplier_gst_number is null)
  );
`,
  },
  {
    version: "0098",
    name: "online_payments",
    sql: `
-- Online invoice payments with Stripe (PN1-PN12, decisions 414-419): whether
-- an admin turned "Pay now" on, and the lease for checking payments.
create table online_payment_settings (
  provider text primary key check (provider in ('stripe')),
  enabled boolean not null default false,
  last_check_at timestamptz,
  last_check_status text check (last_check_status in ('ok', 'failed')),
  last_check_error text check (last_check_error is null or length(last_check_error) <= 1000),
  lease_until timestamptz,
  updated_by_email text,
  updated_at timestamptz not null default now()
);

-- An invoice can leave "Pay now" off (question 5).
create table invoice_payment_options (
  invoice_id bigint primary key references sales_invoices(id) on delete cascade,
  pay_now boolean not null,
  updated_by_email text,
  updated_at timestamptz not null default now()
);

-- Each Stripe payment link made for an invoice, for its amount due then. One
-- is open at a time; a link whose amount no longer matches is switched off.
create table invoice_payment_links (
  id bigserial primary key,
  invoice_id bigint not null references sales_invoices(id) on delete cascade,
  provider text not null default 'stripe' check (provider in ('stripe')),
  provider_link_id text not null unique check (length(provider_link_id) between 1 and 200),
  url text not null check (url ~ '^https://' and length(url) <= 1000),
  currency_code text not null check (currency_code ~ '^[A-Z]{3}$'),
  amount numeric not null check (amount > 0),
  status text not null default 'open' check (status in ('open', 'closed')),
  closed_reason text check (closed_reason is null or length(closed_reason) <= 200),
  close_pending boolean not null default false,
  created_by_email text,
  created_at timestamptz not null default now(),
  closed_at timestamptz,
  check ((status = 'closed') = (closed_at is not null))
);
create unique index invoice_payment_links_one_open on invoice_payment_links (invoice_id) where status = 'open';

-- Each completed Stripe checkout session seen: recorded as a customer
-- payment, or left as a notice for a person (PN10, a missing balance link).
create table online_payments (
  id bigserial primary key,
  provider text not null default 'stripe' check (provider in ('stripe')),
  session_id text not null unique check (length(session_id) between 1 and 300),
  link_id bigint references invoice_payment_links(id),
  invoice_id bigint references sales_invoices(id) on delete set null,
  provider_payment_id text,
  currency_code text not null check (currency_code ~ '^[A-Z]{3}$'),
  amount numeric not null check (amount > 0),
  paid_date date not null,
  -- What reached Stripe's balance: its currency, amount and balance transaction.
  settled_currency text check (settled_currency is null or settled_currency ~ '^[A-Z]{3}$'),
  settled_amount numeric,
  -- A notice that's tried again at each check: no bank account was linked to that balance yet.
  waiting_for_link boolean not null default false,
  status text not null check (status in ('recorded', 'notice')),
  payment_id bigint references customer_payments(id),
  notice text check (notice is null or length(notice) <= 1000),
  dismissed_at timestamptz,
  dismissed_by_email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((status = 'recorded') = (payment_id is not null)),
  check (status = 'recorded' or notice is not null)
);
create index online_payments_invoice_idx on online_payments (invoice_id);
`,
  },
  {
    version: "0099",
    name: "online_payments_paypal",
    sql: `
-- Pay with PayPal (PPN1-PPN10, decisions 420-423): the online payment tables
-- also hold PayPal, whose "links" are invoices in the organisation's own
-- PayPal account. An invoice can have one open link per provider.
alter table online_payment_settings drop constraint online_payment_settings_provider_check;
alter table online_payment_settings add constraint online_payment_settings_provider_check check (provider in ('stripe', 'paypal'));
alter table invoice_payment_links drop constraint invoice_payment_links_provider_check;
alter table invoice_payment_links add constraint invoice_payment_links_provider_check check (provider in ('stripe', 'paypal'));
drop index invoice_payment_links_one_open;
create unique index invoice_payment_links_one_open on invoice_payment_links (invoice_id, provider) where status = 'open';
alter table online_payments drop constraint online_payments_provider_check;
alter table online_payments add constraint online_payments_provider_check check (provider in ('stripe', 'paypal'));
`,
  },
  {
    version: "0100",
    name: "approval_workflows",
    sql: `
-- Approval workflows (AW1-AW17, decisions 424-431): rules that send a bill,
-- purchase order or expense claim through approval steps before it's
-- approved. Rules are archived, never deleted; their steps are replaced when
-- a rule is edited, and a waiting request follows the rule as it is now.
create table approval_rules (
  id bigserial primary key,
  document_type text not null check (document_type in ('bill', 'purchase_order', 'expense_claim')),
  name text not null check (length(name) between 1 and 100 and name = btrim(name)),
  position integer not null check (position > 0),
  -- Conditions, all of which must hold; null means any.
  min_total numeric check (min_total is null or min_total >= 0),
  contact_id bigint references contacts(id),
  claimant_user_id uuid,
  claimant_email text check (claimant_email is null or length(claimant_email) between 1 and 320),
  account_id bigint references accounts(id),
  tracking_value_id bigint references tracking_values(id),
  version integer not null default 1 check (version > 0),
  archived_at timestamptz,
  archived_by_email text,
  created_by_email text,
  created_at timestamptz not null default now(),
  updated_by_email text,
  updated_at timestamptz not null default now(),
  check ((archived_at is null) = (archived_by_email is null)),
  check ((claimant_user_id is null) = (claimant_email is null)),
  check (document_type = 'expense_claim' or claimant_user_id is null),
  check (document_type <> 'expense_claim' or contact_id is null)
);
create unique index approval_rules_name_key on approval_rules (document_type, lower(name)) where archived_at is null;

create table approval_rule_steps (
  id bigserial primary key,
  rule_id bigint not null references approval_rules(id),
  step_number integer not null check (step_number between 1 and 10),
  mode text not null check (mode in ('any', 'all')),
  unique (rule_id, step_number)
);

create table approval_step_approvers (
  step_id bigint not null references approval_rule_steps(id) on delete cascade,
  user_id uuid not null,
  email text not null check (length(email) between 1 and 320),
  primary key (step_id, user_id)
);

-- A document's trip through a rule's steps. One waiting request per document.
create table approval_requests (
  id bigserial primary key,
  document_type text not null check (document_type in ('bill', 'purchase_order', 'expense_claim')),
  document_id bigint not null,
  rule_id bigint not null references approval_rules(id),
  rule_name text not null,
  status text not null default 'waiting' check (status in ('waiting', 'approved', 'declined', 'withdrawn')),
  submitted_by_user_id uuid,
  submitted_by_email text not null,
  submitted_at timestamptz not null default now(),
  finished_by_email text,
  finished_at timestamptz,
  decline_reason text check (decline_reason is null or length(decline_reason) between 1 and 500),
  -- Why the final approval was refused (a locked period, AW10); cleared when it goes through.
  last_error text check (last_error is null or length(last_error) <= 1000),
  last_error_at timestamptz,
  check ((status = 'waiting') = (finished_at is null)),
  check ((status = 'declined') = (decline_reason is not null))
);
create unique index approval_requests_one_waiting on approval_requests (document_type, document_id) where status = 'waiting';
create index approval_requests_document on approval_requests (document_type, document_id, id);

-- Each approval or decline of a step, by one person.
create table approval_actions (
  id bigserial primary key,
  request_id bigint not null references approval_requests(id),
  step_number integer not null check (step_number between 1 and 10),
  action text not null check (action in ('approved', 'declined')),
  user_id uuid,
  email text not null,
  reason text check (reason is null or length(reason) between 1 and 500),
  created_at timestamptz not null default now(),
  unique (request_id, step_number, email)
);

-- Requests and their actions are the record of who approved what.
create function tohyee_guard_approval_history() returns trigger
language plpgsql as $$
begin
  if tg_op = 'TRUNCATE' or tg_op = 'DELETE' then
    raise exception 'Approval history is kept; it can''t be deleted' using errcode = 'P0001';
  end if;
  if tg_table_name = 'approval_actions' then
    raise exception 'An approval action never changes' using errcode = 'P0001';
  end if;
  if old.status <> 'waiting' then
    raise exception 'A finished approval request never changes' using errcode = 'P0001';
  end if;
  if new.document_type <> old.document_type or new.document_id <> old.document_id or new.rule_id <> old.rule_id then
    raise exception 'An approval request''s document and rule never change' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger approval_requests_guard before update or delete on approval_requests
  for each row execute function tohyee_guard_approval_history();
create trigger approval_requests_no_truncate before truncate on approval_requests
  for each statement execute function tohyee_guard_approval_history();
create trigger approval_actions_guard before update or delete on approval_actions
  for each row execute function tohyee_guard_approval_history();
create trigger approval_actions_no_truncate before truncate on approval_actions
  for each statement execute function tohyee_guard_approval_history();

-- The email to each approver of a step (AW3, AW12), sent through the
-- organisation's email by the email job.
create table approval_emails (
  id bigserial primary key,
  request_id bigint not null references approval_requests(id),
  step_number integer not null,
  to_user_id uuid not null,
  to_email text not null check (length(to_email) between 1 and 320),
  subject text not null check (length(subject) between 1 and 250),
  body text not null check (length(body) between 1 and 5000),
  status text not null default 'queued' check (status in ('queued', 'sending', 'sent', 'failed')),
  attempts integer not null default 0 check (attempts >= 0),
  next_attempt_at timestamptz not null default now(),
  claimed_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  finished_at timestamptz,
  unique (request_id, step_number, to_user_id)
);
create index approval_emails_due on approval_emails (next_attempt_at) where status in ('queued', 'sending');

-- A repeating bill whose bill a rule matches is submitted instead (AW14).
alter table repeating_bill_runs drop constraint repeating_bill_runs_outcome_check;
alter table repeating_bill_runs add constraint repeating_bill_runs_outcome_check check (outcome in ('draft', 'approved', 'approval_refused', 'submitted'));
alter table repeating_bill_runs add constraint repeating_bill_runs_submitted_message check (outcome <> 'submitted' or message is not null);
`,
  },
  {
    version: "0101",
    name: "cash_flow_forecast",
    sql: `
-- Cash flow forecast (CF1-CF9, decisions 432-436), like NetSuite's Cash 360.
-- The forecast itself is worked out from the books each time; these hold
-- only what people add: forecast items (Cash 360's additional values) and
-- the accounts forecast from their average (Cash 360's account categories).
create table cash_flow_items (
  id bigserial primary key,
  direction text not null check (direction in ('in', 'out')),
  description text not null check (length(description) between 1 and 200 and description = btrim(description)),
  amount numeric not null check (amount > 0),
  item_date date not null,
  repeat text not null default 'none' check (repeat in ('none', 'week', 'month')),
  until_date date,
  version integer not null default 1 check (version > 0),
  archived_at timestamptz,
  archived_by_email text,
  created_by_email text,
  created_at timestamptz not null default now(),
  updated_by_email text,
  updated_at timestamptz not null default now(),
  check (repeat <> 'none' or until_date is null),
  check (until_date is null or until_date >= item_date),
  check ((archived_at is null) = (archived_by_email is null))
);

create table cash_flow_account_averages (
  account_id bigint primary key references accounts(id),
  direction text not null check (direction in ('in', 'out')),
  months integer not null check (months in (3, 6)),
  updated_by_email text,
  updated_at timestamptz not null default now()
);
`,
  },
  {
    version: "0102",
    name: "intercompany_and_ecb_rates",
    sql: `
-- Consolidation (CO2, decisions 437-445): accounts that hold amounts with
-- another organisation in a consolidation group (NetSuite's "Eliminate
-- Intercompany Transactions"), and the contact that stands for another
-- group organisation, by its id on this server.
create table intercompany_accounts (
  account_id bigint primary key references accounts(id),
  counterpart_organisation_id text not null check (length(counterpart_organisation_id) between 1 and 100),
  updated_by_email text,
  updated_at timestamptz not null default now()
);
create table intercompany_contacts (
  contact_id bigint primary key references contacts(id),
  counterpart_organisation_id text not null check (length(counterpart_organisation_id) between 1 and 100),
  updated_by_email text,
  updated_at timestamptz not null default now()
);
create unique index intercompany_contacts_one_per_organisation on intercompany_contacts (counterpart_organisation_id);

-- Daily rates from the European Central Bank into the exchange rates list
-- (FX1, decision 437).
create table ecb_rate_settings (
  id boolean primary key default true check (id),
  enabled boolean not null default false,
  enabled_on date,
  -- Currencies to bring in besides those the organisation already uses (e.g. a consolidation member's).
  extra_currencies text[] not null default '{}',
  last_run_at timestamptz,
  last_rates_date date,
  last_error text,
  updated_by_email text,
  updated_at timestamptz not null default now()
);
insert into ecb_rate_settings (id) values (true);
`,
  },
  {
    version: "0103",
    name: "report_commentaries",
    sql: `
-- AI commentary as a suggestion (item 6 part 3, decision 446): a commentary
-- on the cash flow forecast, written by a person or suggested by the
-- connected AI, shown as not checked until a person accepts or edits it.
create table report_commentaries (
  id bigserial primary key,
  report text not null check (report in ('cash_flow_forecast')),
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
    version: "0104",
    name: "shopify_chargebacks_and_reserves",
    sql: `
-- Shopify chargebacks and reserves (item 7 part 1, examples SPC25-SPC31,
-- decisions 447-450): the account a disputed amount goes to, the bank
-- account money Shopify holds back sits in, and the further documents a
-- payout can become (a receive money for won disputes, transfers to and
-- from the reserve).
alter table sales_platform_connections
  add column chargebacks_account_id bigint references accounts(id),
  add column reserve_account_id bigint references accounts(id);

alter table sales_platform_documents
  add column receipt_bank_transaction_id bigint references bank_transactions(id),
  add column reserve_held_transfer_id bigint references bank_transfers(id),
  add column reserve_released_transfer_id bigint references bank_transfers(id);
`,
  },
  {
    version: "0105",
    name: "woocommerce_orders",
    sql: `
-- WooCommerce orders into the accounts (item 7 part 2, examples WC1-WC10,
-- decisions 451-455): WooCommerce as a second platform, which needs no
-- clearing, payout or fees account (it has no payouts), and where each
-- payment method's money goes.
alter table sales_platform_connections drop constraint sales_platform_connections_platform_check;
alter table sales_platform_connections add constraint sales_platform_connections_platform_check check (platform in ('shopify', 'woocommerce'));
alter table sales_platform_documents drop constraint sales_platform_documents_platform_check;
alter table sales_platform_documents add constraint sales_platform_documents_platform_check check (platform in ('shopify', 'woocommerce'));
alter table sales_platform_connections drop constraint sales_platform_connections_posting_check;
alter table sales_platform_connections add constraint sales_platform_connections_posting_check check (
  not post_to_accounts or (start_date is not null and sales_account_id is not null and shipping_account_id is not null
    and (platform = 'woocommerce' or (clearing_account_id is not null and payout_account_id is not null and fees_account_id is not null)))
);

-- Each payment method seen on the store's orders: the bank account its
-- money is recorded into, or left owing (bank transfer, cheque) for the
-- bank feed to match; neither until an admin chooses (WC8).
create table sales_platform_payment_methods (
  connection_id bigint not null references sales_platform_connections(id),
  method text not null check (length(method) between 1 and 100),
  title text check (title is null or length(title) <= 200),
  account_id bigint references accounts(id),
  left_owing boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (connection_id, method),
  check (not (left_owing and account_id is not null))
);
`,
  },
  {
    version: "0106",
    name: "payroll_details_changed_on_drafts",
    sql: `
-- Changing an employee counts as preparing their draft pay runs (example
-- PRUN7b, review issue #140): who changed whose payroll details while a pay
-- run was a draft, so "approver must be different" refuses them too.
alter table payroll_pay_runs add column details_changed_by jsonb not null default '[]'::jsonb;
`,
  },
  {
    version: "0107",
    name: "payroll_kiwisaver_temporary_rate_reduction",
    sql: `
-- A KiwiSaver temporary rate reduction approved by IRD, with the dates on
-- IRD's approval (example PR13b, review issue #141). Approving a pay run keeps
-- it with the pay, like the bank account (PSLIP7).
alter table payroll_employees
  add column kiwisaver_reduction_from date,
  add column kiwisaver_reduction_to date,
  add constraint payroll_employees_kiwisaver_reduction_dates check (
    (kiwisaver_reduction_from is null) = (kiwisaver_reduction_to is null)
    and (kiwisaver_reduction_to is null or kiwisaver_reduction_to >= kiwisaver_reduction_from)
  );
alter table payroll_pay_run_employees
  add column kiwisaver_reduction_from date,
  add column kiwisaver_reduction_to date;
`,
  },
  {
    version: "0108",
    name: "fx_revaluation_voids",
    sql: `
-- Voiding an FX revaluation (example FXB12, issue #151): the run is kept and
-- a void is recorded beside it (append-only, once per run), with the
-- journals reversing its revaluation journal (dated the revaluation date)
-- and its reversal journal (dated the reversal date), and who voided it.
-- A voided revaluation no longer counts anywhere a revaluation is looked up.
create table ledger_fx_revaluation_voids (
  id bigserial primary key,
  run_id bigint not null unique references ledger_fx_revaluation_runs(id),
  command_source text not null,
  idempotency_key text not null,
  request_hash text not null,
  void_journal_id bigint not null references ledger_journals(id),
  void_reversal_journal_id bigint not null references ledger_journals(id),
  voided_by_user_id uuid,
  voided_by_email text not null,
  voided_at timestamptz not null default now(),
  unique (command_source, idempotency_key)
);
create trigger ledger_fx_revaluation_voids_append_only
  before update or delete on ledger_fx_revaluation_voids
  for each row execute function toeyee_forbid_mutation();
create trigger ledger_fx_revaluation_voids_no_truncate
  before truncate on ledger_fx_revaluation_voids
  for each statement execute function toeyee_forbid_mutation();

-- One revaluation per account, currency and date, not counting voided ones
-- (so a voided revaluation's date can be revalued again). The unique
-- constraint can't see voids, so a trigger checks it, under a lock per
-- account, currency and date.
alter table ledger_fx_revaluation_run_items drop constraint ledger_fx_revaluation_run_items_account_currency_date_key;
create index ledger_fx_revaluation_run_items_account_idx on ledger_fx_revaluation_run_items (account_id, currency_code, revaluation_date);
create function tohyee_check_fx_revaluation_item() returns trigger
language plpgsql as $$
begin
  perform pg_advisory_xact_lock(hashtextextended(
    'tohyee_fx_revaluation_item:' || new.account_id || ':' || new.currency_code || ':' || new.revaluation_date, 0));
  if exists (select 1 from ledger_fx_revaluation_run_items i
              where i.account_id = new.account_id and i.currency_code = new.currency_code
                and i.revaluation_date = new.revaluation_date
                and not exists (select 1 from ledger_fx_revaluation_voids v where v.run_id = i.run_id)) then
    raise exception 'Account % (%) has already been revalued on %', new.account_id, new.currency_code, new.revaluation_date
      using errcode = '23505';
  end if;
  return new;
end;
$$;
create trigger ledger_fx_revaluation_run_items_unique_check
  before insert on ledger_fx_revaluation_run_items
  for each row execute function tohyee_check_fx_revaluation_item();

-- A transfer out of a foreign-currency account (a carrying-value credit)
-- can't be dated before the reversal date of a revaluation of the account
-- that isn't voided (FXB12): its carrying value would include the
-- unrealised amount, and the reversal would then hit money that had gone.
create or replace function tohyee_check_foreign_line() returns trigger
language plpgsql as $$
declare
  account record;
  base text;
  posted date;
  opening record;
  latest_out date;
  spanning record;
begin
  select a.code, a.name, a.currency_code, a.system_key into account from accounts a where a.id = new.account_id;
  select base_currency into base from organisation_settings;
  if account.currency_code is null or account.currency_code = base then
    if new.foreign_currency_code is not null then
      if account.system_key not in ('accounts_receivable', 'accounts_payable') then
        raise exception 'Account % (%) is in %, so its journal lines have no foreign amount', account.code, account.name,
          coalesce(base, 'the base currency') using errcode = '23514';
      end if;
      if new.foreign_currency_code = base then
        raise exception 'Account % (%): a foreign amount can''t be in the base currency', account.code, account.name
          using errcode = '23514';
      end if;
      if new.fx_kind not in ('document', 'carrying_value', 'revaluation') then
        raise exception 'Account % (%) only takes foreign amounts from invoices, bills, credit notes, their payments and revaluations',
          account.code, account.name using errcode = '23514';
      end if;
    end if;
    return new;
  end if;
  if new.fx_kind = 'document' then
    raise exception 'Account % (%) is a foreign-currency account, not accounts receivable or payable', account.code, account.name
      using errcode = '23514';
  end if;
  if new.foreign_currency_code is null then
    raise exception 'Account % (%) is in %: its journal lines need the % amount and exchange rate as well as the % amount',
      account.code, account.name, account.currency_code, account.currency_code, coalesce(base, 'base') using errcode = '23514';
  end if;
  if new.foreign_currency_code <> account.currency_code then
    raise exception 'Account % (%) is in %, not %', account.code, account.name, account.currency_code, new.foreign_currency_code
      using errcode = '23514';
  end if;
  if new.fx_kind = 'rate'
     and round(new.foreign_amount * new.exchange_rate, case when base in ('JPY', 'XPF') then 0 else 2 end)
         <> new.debit_amount + new.credit_amount then
    raise exception 'On account %, % % at % is %, not %', account.code, account.currency_code, new.foreign_amount,
      new.exchange_rate, round(new.foreign_amount * new.exchange_rate, 2), new.debit_amount + new.credit_amount
      using errcode = '23514';
  end if;
  select posting_date into posted from ledger_journals where id = new.journal_id;
  select * into opening from ledger_foreign_opening_balances where account_id = new.account_id;
  if found then
    if posted <= opening.as_at_date then
      raise exception 'Account % (%) has an opening foreign balance as at %, so nothing can be posted to it dated on or before then',
        account.code, account.name, opening.as_at_date using errcode = '23514';
    end if;
  elsif new.fx_kind <> 'revaluation'
        and exists (select 1 from ledger_journal_lines where account_id = new.account_id and foreign_amount is null) then
    raise exception 'Account % (%) has postings from before Tohyee kept foreign amounts. Enter its % balance as at a date (its opening foreign balance) first',
      account.code, account.name, account.currency_code using errcode = '23514';
  end if;
  select max(j.posting_date) into latest_out
    from ledger_journal_lines l join ledger_journals j on j.id = l.journal_id
   where l.account_id = new.account_id and l.fx_kind = 'carrying_value' and l.credit_amount > 0;
  if latest_out is not null and posted < latest_out and new.fx_kind <> 'revaluation' then
    raise exception 'Account % (%) had money transferred out on %, at its carrying value; nothing can be posted to it dated before then',
      account.code, account.name, latest_out using errcode = '23514';
  end if;
  if new.fx_kind = 'carrying_value' and new.credit_amount > 0 then
    select r.reference, r.revaluation_date, r.reversal_posting_date into spanning
      from ledger_fx_revaluation_run_items i join ledger_fx_revaluation_runs r on r.id = i.run_id
     where i.account_id = new.account_id and r.reversal_posting_date > posted
       and not exists (select 1 from ledger_fx_revaluation_voids v where v.run_id = r.id)
     order by r.reversal_posting_date desc limit 1;
    if found then
      raise exception '% (%) was revalued on % (%), and that isn''t reversed until %. A transfer out dated before then isn''t supported',
        account.code, account.name, spanning.revaluation_date, spanning.reference, spanning.reversal_posting_date
        using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;
`,
  },
  {
    version: "0109",
    name: "gst_registration",
    sql: `
-- GST registration (issue #180, NR1-NR8). gst_registered says whether the
-- organisation is registered for GST at all; gst_registered_from and
-- gst_registered_until (both optional, inclusive) limit when. Null "from"
-- means registered from the start. New organisations start registered, as
-- before. An existing organisation with no GST number that has never had
-- GST in its books (nothing on the GST account) isn't registered (NR8).
alter table organisation_settings
  add column gst_registered boolean not null default true,
  add column gst_registered_from date,
  add column gst_registered_until date,
  add constraint organisation_settings_gst_registration
    check ((gst_registered or (gst_registered_from is null and gst_registered_until is null))
           and (gst_registered_until is null or gst_registered_from is null or gst_registered_until >= gst_registered_from));

update organisation_settings
   set gst_registered = false
 where gst_number is null
   and exists (select 1 from ledger_journals)
   and not exists (select 1 from ledger_journal_lines l join accounts a on a.id = l.account_id where a.system_key = 'gst');
`,
  },
  {
    version: "0110",
    name: "exchange_rate_sources",
    sql: `
-- Where exchange rates come from (#183, examples FX2-FX9, decision 479):
-- the ECB's daily rates, uploaded rate sets, or typed only. The setting
-- lives with the ECB settings (the organisation's exchange rate settings).
-- Organisations already taking ECB rates keep them; the rest are typed only,
-- which is how they work today.
alter table ecb_rate_settings
  add column rate_source text not null default 'typed' check (rate_source in ('ecb', 'uploaded', 'typed'));
update ecb_rate_settings set rate_source = 'ecb' where enabled;

-- Each change of source, with the reason Inland Revenue asks you to keep (FX7).
create table exchange_rate_source_changes (
  id bigserial primary key,
  from_source text not null check (from_source in ('ecb', 'uploaded', 'typed')),
  to_source text not null check (to_source in ('ecb', 'uploaded', 'typed')),
  reason text check (reason is null or length(reason) between 1 and 500),
  changed_by_user_id uuid,
  changed_by_email text,
  changed_at timestamptz not null default now(),
  check (from_source <> to_source)
);

-- An uploaded set of rates for a period (FX3), named for where it came from
-- (IRD, RBNZ, a bank). Its rates are entries in the exchange rates list,
-- effective from the period's start and used only up to its end (FX5). A
-- set is never changed or deleted; a newer set for the same period replaces
-- it, with a reason, and the old set's rates are archived (FX6).
create table exchange_rate_sets (
  id bigserial primary key,
  command_source text not null,
  idempotency_key text not null,
  request_hash text not null,
  name text not null check (length(name) between 1 and 100),
  period_start date not null,
  period_end date not null,
  quoted text not null check (quoted in ('foreign_per_base', 'base_per_foreign')),
  file_name text check (file_name is null or length(file_name) between 1 and 255),
  replaces_set_id bigint references exchange_rate_sets(id),
  replace_reason text check (replace_reason is null or length(replace_reason) between 1 and 500),
  replaced_at timestamptz,
  replaced_by_email text,
  created_by_user_id uuid,
  created_by_email text,
  created_at timestamptz not null default now(),
  unique (command_source, idempotency_key),
  check (period_end >= period_start),
  check ((replaces_set_id is null) = (replace_reason is null))
);

create function tohyee_guard_exchange_rate_set() returns trigger
language plpgsql as $$
begin
  if tg_op = 'UPDATE' and old.replaced_at is null and new.replaced_at is not null
     and (to_jsonb(new) - array['replaced_at', 'replaced_by_email']) = (to_jsonb(old) - array['replaced_at', 'replaced_by_email']) then
    return new;
  end if;
  raise exception 'Exchange rate sets can''t be changed or deleted; upload a set that replaces it' using errcode = 'P0001';
end;
$$;
create trigger exchange_rate_sets_guard before update or delete on exchange_rate_sets
  for each row execute function tohyee_guard_exchange_rate_set();
create trigger exchange_rate_sets_no_truncate before truncate on exchange_rate_sets
  for each statement execute function tohyee_guard_exchange_rate_set();

alter table currency_exchange_rates add column rate_set_id bigint references exchange_rate_sets(id);
create index currency_exchange_rates_set_idx on currency_exchange_rates (rate_set_id) where rate_set_id is not null;

-- Archiving is still the only change, and it can't move an entry between sets.
create or replace function tohyee_guard_currency_exchange_rate() returns trigger
language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    if new.currency_code = (select base_currency from organisation_settings where id = true) then
      raise exception 'Exchange rates are for foreign currencies, not %', new.currency_code using errcode = '23514';
    end if;
    if new.archived_at is not null then
      raise exception 'A new exchange rate can''t be archived already' using errcode = '23514';
    end if;
    return new;
  end if;
  if tg_op = 'UPDATE' then
    if old.archived_at is null and new.archived_at is not null
       and (to_jsonb(new) - array['archived_at', 'archived_by_user_id', 'archived_by_email'])
         = (to_jsonb(old) - array['archived_at', 'archived_by_user_id', 'archived_by_email']) then
      return new;
    end if;
    raise exception 'Exchange rates can''t be changed; add a newer entry or archive this one' using errcode = 'P0001';
  end if;
  raise exception 'Exchange rates can''t be deleted; archive them instead' using errcode = 'P0001';
end;
$$;

-- Where each foreign-currency document's rate came from (FX4): "Typed" when
-- typed on the document, else the list entry's source ("ECB", a set's name,
-- "Exchange rates list") or "Last rate used". Older documents have none.
alter table sales_invoices add column exchange_rate_source text check (exchange_rate_source is null or length(exchange_rate_source) between 1 and 120);
alter table bills add column exchange_rate_source text check (exchange_rate_source is null or length(exchange_rate_source) between 1 and 120);
alter table sales_credit_notes add column exchange_rate_source text check (exchange_rate_source is null or length(exchange_rate_source) between 1 and 120);
alter table supplier_credit_notes add column exchange_rate_source text check (exchange_rate_source is null or length(exchange_rate_source) between 1 and 120);
`,
  },
  {
    version: "0111",
    name: "accounting_module",
    sql: `
-- Accounting as a module that can be off (#181, examples MOD2-MOD7,
-- decision 480). Existing organisations keep it on (MOD7). At least one of
-- Accounting, CRM or Analytics stays on, and Advanced reporting and
-- Not-for-profit need Accounting (MOD5). Turning it off keeps everything.
alter table organisation_settings
  add column accounting_enabled boolean not null default true,
  add constraint organisation_settings_one_app_on check (accounting_enabled or crm_enabled or analytics_enabled),
  add constraint organisation_settings_accounting_extras
    check (accounting_enabled or (not advanced_features and not not_for_profit_enabled));
`,
  },
  {
    version: "0112",
    name: "several_feed_logins",
    sql: `
-- Several logins per bank feed provider (#182, examples BK30-BK37, decision
-- 481; replaces decision 388's "one connection per provider"). Each login
-- has a name, unique among the provider's active logins. The existing
-- connection becomes a login named after the provider (BK37).
alter table akahu_connections
  add column name text,
  -- Why the login's tokens stopped working (BK33), until new ones are saved (BK34).
  add column token_problem text check (token_problem is null or length(token_problem) between 1 and 500);
update akahu_connections set name = 'Akahu';
alter table akahu_connections alter column name set not null,
  add constraint akahu_connections_name check (length(name) between 1 and 100);
drop index akahu_connections_one_active;
create unique index akahu_connections_name_once on akahu_connections (lower(name)) where status = 'active';

-- Which login an Akahu feed syncs with (BK31, BK32); existing feeds use the existing connection.
alter table bank_account_settings add column akahu_connection_id bigint references akahu_connections(id);
update bank_account_settings
   set akahu_connection_id = (select id from akahu_connections order by (status = 'active') desc, id desc limit 1)
 where akahu_account_id is not null;

alter table simplefin_connections add column name text;
update simplefin_connections set name = 'SimpleFIN';
alter table simplefin_connections alter column name set not null,
  add constraint simplefin_connections_name check (length(name) between 1 and 100);
drop index simplefin_connections_one_active;
create unique index simplefin_connections_name_once on simplefin_connections (lower(name)) where status = 'active';

alter table stripe_connections add column name text;
update stripe_connections set name = 'Stripe';
alter table stripe_connections alter column name set not null,
  add constraint stripe_connections_name check (length(name) between 1 and 100);
drop index stripe_connections_one_active;
create unique index stripe_connections_name_once on stripe_connections (lower(name)) where status = 'active';

alter table paypal_connections add column name text;
update paypal_connections set name = 'PayPal';
alter table paypal_connections alter column name set not null,
  add constraint paypal_connections_name check (length(name) between 1 and 100);
drop index paypal_connections_one_active;
create unique index paypal_connections_name_once on paypal_connections (lower(name)) where status = 'active';

alter table wise_connections add column name text;
update wise_connections set name = 'Wise';
alter table wise_connections alter column name set not null,
  add constraint wise_connections_name check (length(name) between 1 and 100);
drop index wise_connections_one_active;
create unique index wise_connections_name_once on wise_connections (lower(name)) where status = 'active';

-- Stripe, PayPal and Wise: one link per currency per login, not per organisation.
drop index stripe_links_currency_once;
create unique index stripe_links_currency_once on stripe_links (connection_id, currency_code) where active;
drop index paypal_links_currency_once;
create unique index paypal_links_currency_once on paypal_links (connection_id, currency_code) where active;
drop index wise_links_currency_once;
create unique index wise_links_currency_once on wise_links (connection_id, currency_code) where active;
`,
  },
  {
    version: "0113",
    name: "gocardless_direct_debit",
    sql: `
-- Direct debit with GoCardless, BECS NZ (stage 10 of the add-ons plan,
-- examples GC1-GC10, decision 482). One connection per organisation: the
-- organisation's own GoCardless access token, stored encrypted.
create table gocardless_settings (
  id boolean primary key default true check (id),
  environment text not null default 'live' check (environment in ('live', 'sandbox')),
  access_token_ciphertext text,
  creditor_name text,
  enabled boolean not null default false,
  -- Where collected money waits until GoCardless pays it out (GC4, GC5), the bank account it's paid into, and the fees.
  clearing_account_id bigint references accounts(id),
  payout_account_id bigint references accounts(id),
  fees_account_id bigint references accounts(id),
  connected_at timestamptz,
  connected_by_email text,
  last_check_at timestamptz,
  last_check_status text check (last_check_status in ('ok', 'failed')),
  last_check_error text check (last_check_error is null or length(last_check_error) <= 1000),
  lease_until timestamptz,
  updated_by_email text,
  updated_at timestamptz not null default now(),
  check (not enabled or (access_token_ciphertext is not null and clearing_account_id is not null and payout_account_id is not null
                         and fees_account_id is not null))
);
insert into gocardless_settings (id) values (true);

-- A customer's direct debit authority (mandate, GC2, GC7): asked for with a
-- GoCardless page the customer fills in; one current per contact.
create table gocardless_authorities (
  id bigserial primary key,
  contact_id bigint not null references contacts(id),
  billing_request_id text not null unique check (length(billing_request_id) between 1 and 100),
  flow_url text check (flow_url is null or (flow_url ~ '^https://' and length(flow_url) <= 1000)),
  flow_expires_at timestamptz,
  mandate_id text unique check (mandate_id is null or length(mandate_id) between 1 and 100),
  status text not null default 'pending' check (status in ('pending', 'active', 'ended')),
  provider_status text,
  next_possible_charge_date date,
  ended_reason text check (ended_reason is null or length(ended_reason) <= 500),
  created_by_email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index gocardless_authorities_one_current on gocardless_authorities (contact_id) where status in ('pending', 'active');

-- Each collection asked of GoCardless for an invoice (GC3-GC9).
create table gocardless_collections (
  id bigserial primary key,
  invoice_id bigint not null references sales_invoices(id),
  authority_id bigint not null references gocardless_authorities(id),
  provider_payment_id text not null unique check (length(provider_payment_id) between 1 and 100),
  amount numeric not null check (amount > 0),
  charge_date date,
  status text not null check (status in ('scheduled', 'confirmed', 'failed', 'cancelled')),
  provider_status text,
  -- The customer payment recorded for it (GC4), voided again if it fails later (GC6).
  customer_payment_id bigint references customer_payments(id),
  failure_reason text check (failure_reason is null or length(failure_reason) <= 500),
  retries integer not null default 0 check (retries between 0 and 3),
  notice text check (notice is null or length(notice) <= 1000),
  created_by_email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index gocardless_collections_one_open on gocardless_collections (invoice_id) where status = 'scheduled';

-- "Don't collect this one" on an invoice.
create table gocardless_invoice_skips (
  invoice_id bigint primary key references sales_invoices(id) on delete cascade,
  created_by_email text,
  created_at timestamptz not null default now()
);

-- Each GoCardless payout posted (GC5): collected money and fees out of the clearing account.
create table gocardless_payouts (
  id bigserial primary key,
  payout_id text not null unique check (length(payout_id) between 1 and 100),
  amount numeric not null,
  fees numeric not null,
  arrival_date date not null,
  reference text,
  journal_id bigint references ledger_journals(id),
  created_at timestamptz not null default now()
);
`,
  },
  {
    version: "0114",
    name: "crm_sales_teams",
    sql: `
-- Sales teams (decision 491, #216): an admin or owner makes them. A team has
-- one manager, who sees the deals, tasks and forecasts of its reps; a rep is
-- in one team at most. User ids are the core database's users (as the CRM's
-- owner and assignee columns).
create table crm_teams (
  id bigserial primary key,
  name text not null unique check (length(name) between 1 and 100),
  manager_user_id text not null,
  created_by_email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index crm_teams_manager on crm_teams (manager_user_id);

create table crm_team_members (
  user_id text primary key,
  team_id bigint not null references crm_teams(id) on delete cascade,
  added_by_email text,
  added_at timestamptz not null default now()
);
create index crm_team_members_team on crm_team_members (team_id);
`,
  },
  {
    version: "0115",
    name: "crm_leads",
    sql: `
-- Leads (decision 492, #216): enquiries before they're customers, after
-- Salesforce's leads. Typed in, imported from a spreadsheet, sent from a web
-- form or emailed in; worked, then converted into a company, a person and
-- optionally an opportunity, keeping their tasks and activities. Never deleted.
create table crm_leads (
  id bigserial primary key,
  command_source text,
  idempotency_key text,
  first_name text check (first_name is null or length(first_name) between 1 and 100),
  last_name text check (last_name is null or length(last_name) between 1 and 100),
  company_name text check (company_name is null or length(company_name) between 1 and 200),
  email text check (email is null or length(email) <= 254),
  phone text check (phone is null or length(phone) <= 50),
  job_title text check (job_title is null or length(job_title) <= 100),
  description text check (description is null or length(description) <= 4000),
  source text not null check (source in ('manual', 'import', 'web_form', 'email')),
  source_detail text check (source_detail is null or length(source_detail) <= 300),
  status text not null default 'new' check (status in ('new', 'working', 'unqualified', 'converted')),
  unqualified_reason text check (unqualified_reason is null or length(unqualified_reason) <= 500),
  needs_review boolean not null default false,
  owner_user_id text,
  converted_at timestamptz,
  converted_contact_id bigint references contacts(id),
  converted_person_id bigint references crm_people(id),
  converted_opportunity_id bigint references crm_opportunities(id),
  created_by_email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (command_source, idempotency_key),
  check (first_name is not null or last_name is not null or company_name is not null or email is not null),
  check ((status = 'converted') = (converted_at is not null)),
  check (status <> 'converted' or (converted_contact_id is not null and converted_person_id is not null)),
  check (status <> 'unqualified' or unqualified_reason is not null)
);
create index crm_leads_owner on crm_leads (owner_user_id, status);
create index crm_leads_email on crm_leads (lower(email)) where email is not null;
create trigger crm_leads_no_delete before delete on crm_leads for each row execute function toeyee_forbid_delete();
create trigger crm_leads_no_truncate before truncate on crm_leads for each statement execute function toeyee_forbid_delete();

-- A lead's tasks and activities; on conversion they also get its new company and person.
alter table crm_tasks add column lead_id bigint references crm_leads(id);
alter table crm_activities add column lead_id bigint references crm_leads(id);
alter table crm_activities drop constraint crm_activities_check;
alter table crm_activities add constraint crm_activities_check
  check (contact_id is not null or person_id is not null or opportunity_id is not null or lead_id is not null);
create index crm_tasks_lead on crm_tasks (lead_id) where lead_id is not null;
create index crm_activities_lead on crm_activities (lead_id) where lead_id is not null;
`,
  },
  {
    version: "0116",
    name: "crm_lead_intake",
    sql: `
-- Leads from a web form and from email (decision 493, #216). A form has a
-- random key in its address; what it sends becomes an unassigned lead to
-- review. A trap field only robots fill in, and a limit per address, keep
-- spam down (Jess 10 Oct 2026: no outside service).
create table crm_lead_forms (
  id bigserial primary key,
  name text not null unique check (length(name) between 1 and 100),
  form_key text not null unique check (form_key ~ '^[0-9a-f]{40}$'),
  is_active boolean not null default true,
  thank_you_url text check (thank_you_url is null or (length(thank_you_url) <= 500 and thank_you_url ~ '^https?://')),
  leads_received integer not null default 0 check (leads_received >= 0),
  last_lead_at timestamptz,
  created_by_email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- A mailbox folder or label whose emails become leads, read as the admin who
-- set it up (their own CRM mailbox, or IMAP), like the bills inbox (BI2).
create table crm_lead_mailboxes (
  id bigserial primary key,
  mail_kind text not null check (mail_kind in ('crm', 'imap')),
  mail_account_id bigint references crm_connected_accounts(id) on delete set null,
  imap_host text check (imap_host is null or length(imap_host) between 1 and 253),
  imap_username text check (imap_username is null or length(imap_username) between 1 and 320),
  imap_password_ciphertext text,
  mail_folder_id text not null check (length(mail_folder_id) between 1 and 500),
  mail_folder_name text not null check (length(mail_folder_name) between 1 and 500),
  owner_user_id uuid not null,
  sync_every_hours integer not null default 1 check (sync_every_hours between 1 and 24),
  last_check_at timestamptz,
  last_status text check (last_status in ('ok', 'failed')),
  last_error text check (last_error is null or length(last_error) <= 1000),
  last_leads_added integer check (last_leads_added >= 0),
  lease_until timestamptz,
  created_by_email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (mail_kind <> 'imap' or (imap_host is not null and imap_username is not null and imap_password_ciphertext is not null))
);

-- Emails already made into leads: each is read once, even if its mailbox is set up again.
create table crm_lead_mail_seen (
  location text not null check (length(location) between 1 and 1200),
  message_id text not null check (length(message_id) between 1 and 1000),
  lead_id bigint references crm_leads(id),
  seen_at timestamptz not null default now(),
  primary key (location, message_id)
);
`,
  },
  {
    version: "0117",
    name: "crm_duplicates",
    sql: `
-- Duplicate companies and people (decision 494, #216). A company with no
-- accounting records can be merged into another: its CRM records move across
-- and it's archived, pointing at the one kept. Two that both have accounting
-- records are only marked as the same customer; the books never change.
alter table contacts add column merged_into_contact_id bigint references contacts(id);
alter table crm_people add column merged_into_person_id bigint references crm_people(id);
alter table contacts add constraint contacts_merged_archived check (merged_into_contact_id is null or is_archived);
alter table crm_people add constraint crm_people_merged_archived check (merged_into_person_id is null or is_archived);

-- What someone decided about a suggested pair: not duplicates, or the same
-- customer kept apart because both have accounting records.
create table crm_duplicate_reviews (
  id bigserial primary key,
  record text not null check (record in ('company', 'person')),
  first_id bigint not null,
  second_id bigint not null,
  decision text not null check (decision in ('not_duplicate', 'same_customer')),
  decided_by_email text,
  decided_at timestamptz not null default now(),
  check (first_id < second_id),
  unique (record, first_id, second_id)
);
`,
  },
  {
    version: "0118",
    name: "crm_follow_up_rules",
    sql: `
-- Follow-up rules (decision 495, #216 stage 2): each makes a task for the
-- right person when a lead arrives, a deal reaches a stage, a deal goes
-- quiet or a task is overdue. A run is kept per rule and per event, so a
-- check that runs twice never makes a second task.
create table crm_follow_up_rules (
  id bigserial primary key,
  kind text not null check (kind in ('lead_arrives', 'deal_stage', 'deal_quiet', 'task_overdue')),
  name text not null check (length(name) between 1 and 100),
  stage_key text,
  days integer not null check (days between 0 and 365),
  task_title text check (task_title is null or length(task_title) between 1 and 150),
  is_active boolean not null default true,
  created_by_email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((kind = 'deal_stage') = (stage_key is not null)),
  check (kind not in ('deal_quiet', 'task_overdue') or days >= 1)
);

create table crm_follow_up_runs (
  id bigserial primary key,
  rule_id bigint not null references crm_follow_up_rules(id) on delete cascade,
  run_key text not null,
  task_id bigint references crm_tasks(id),
  lead_id bigint references crm_leads(id),
  opportunity_id bigint references crm_opportunities(id),
  source_task_id bigint references crm_tasks(id),
  outcome text not null check (outcome in ('task_created', 'skipped')),
  detail text,
  ran_at timestamptz not null default now(),
  unique (rule_id, run_key)
);
create index crm_follow_up_runs_recent on crm_follow_up_runs (ran_at desc);
create index crm_follow_up_runs_task on crm_follow_up_runs (task_id);
`,
  },
  {
    version: "0119",
    name: "crm_sales_email",
    sql: `
-- Sales emails from the rep's own mailbox (decision 496, #216 stage 2).
-- A mailbox can send only after its owner allowed it (a second sign-in that
-- adds gmail.send or Mail.Send). Nothing is ever sent without a person
-- pressing Send.
alter table crm_connected_accounts add column can_send boolean not null default false;
alter table crm_oauth_states add column with_send boolean not null default false;

-- People and leads who asked not to be emailed.
alter table crm_people add column email_opt_out boolean not null default false;
alter table crm_leads add column email_opt_out boolean not null default false;

create table crm_email_templates (
  id bigserial primary key,
  name text not null check (length(name) between 1 and 100),
  subject text not null check (length(subject) between 1 and 200),
  body text not null check (length(body) between 1 and 20000),
  is_active boolean not null default true,
  created_by_email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index crm_email_templates_name on crm_email_templates (lower(name));

-- Each email sent from Tohyee. A retry with the same key returns this row
-- instead of sending again; one that may have gone is never retried.
create table crm_sent_emails (
  id bigserial primary key,
  command_source text not null,
  idempotency_key text not null,
  request_hash text not null,
  account_id bigint not null references crm_connected_accounts(id),
  sent_by_user_id text not null,
  to_email text not null,
  subject text not null,
  body text not null,
  template_id bigint references crm_email_templates(id),
  lead_id bigint references crm_leads(id),
  person_id bigint references crm_people(id),
  contact_id bigint references contacts(id),
  opportunity_id bigint references crm_opportunities(id),
  status text not null check (status in ('sending', 'sent', 'failed', 'maybe_sent')),
  error text,
  provider_message_id text,
  activity_id bigint references crm_activities(id),
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  unique (command_source, idempotency_key)
);
create index crm_sent_emails_lead on crm_sent_emails (lead_id);
create index crm_sent_emails_person on crm_sent_emails (person_id);
create index crm_sent_emails_opportunity on crm_sent_emails (opportunity_id);
`,
  },
  {
    version: "0120",
    name: "crm_sequences",
    sql: `
-- Sequences (decision 497, #216 stage 2; Jess 10 Oct 2026: each step becomes
-- a task, and nothing is sent without a person pressing Send). A step's task
-- is made on its day; the enrolment stops on a reply, an opt-out, a closed
-- deal or an unqualified lead, or when someone stops it.
create table crm_sequences (
  id bigserial primary key,
  name text not null check (length(name) between 1 and 100),
  description text check (description is null or length(description) <= 500),
  is_active boolean not null default true,
  created_by_email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index crm_sequences_name on crm_sequences (lower(name));

create table crm_sequence_steps (
  id bigserial primary key,
  sequence_id bigint not null references crm_sequences(id) on delete cascade,
  position integer not null check (position between 1 and 30),
  day_offset integer not null check (day_offset between 0 and 365),
  kind text not null check (kind in ('email', 'call', 'task')),
  title text not null check (length(title) between 1 and 150),
  template_id bigint references crm_email_templates(id),
  check (kind = 'email' or template_id is null),
  unique (sequence_id, position)
);

create table crm_sequence_enrolments (
  id bigserial primary key,
  sequence_id bigint not null references crm_sequences(id),
  lead_id bigint references crm_leads(id),
  person_id bigint references crm_people(id),
  opportunity_id bigint references crm_opportunities(id),
  assignee_user_id text,
  status text not null default 'active' check (status in ('active', 'finished', 'stopped')),
  stop_reason text,
  started_on date not null,
  enrolled_by_email text,
  enrolled_at timestamptz not null default now(),
  ended_at timestamptz,
  check (num_nonnulls(lead_id, person_id, opportunity_id) = 1),
  check ((status = 'active') = (ended_at is null))
);
create unique index crm_sequence_enrolments_lead on crm_sequence_enrolments (sequence_id, lead_id) where status = 'active' and lead_id is not null;
create unique index crm_sequence_enrolments_person on crm_sequence_enrolments (sequence_id, person_id) where status = 'active' and person_id is not null;
create unique index crm_sequence_enrolments_deal on crm_sequence_enrolments (sequence_id, opportunity_id) where status = 'active' and opportunity_id is not null;
create index crm_sequence_enrolments_active on crm_sequence_enrolments (status) where status = 'active';

-- Each step of each enrolment happens once (a task made, or skipped with why).
create table crm_sequence_step_runs (
  id bigserial primary key,
  enrolment_id bigint not null references crm_sequence_enrolments(id),
  position integer not null,
  task_id bigint references crm_tasks(id),
  outcome text not null check (outcome in ('task_created', 'skipped')),
  detail text,
  ran_at timestamptz not null default now(),
  unique (enrolment_id, position)
);
`,
  },
];
