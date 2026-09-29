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
];
