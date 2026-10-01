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

-- A company in the CRM was a customer for its fields; it's a prospect now,
-- so fields already on customers are on prospects too (CRMF3).
update custom_fields set used_on = used_on || array['prospect'], updated_at = now()
 where record = 'contact' and 'customer' = any(used_on) and not 'prospect' = any(used_on);

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
];
