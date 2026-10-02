import { writeAuditEvent } from "@/lib/audit";
import { dueDateFor, PAYMENT_TERM_KINDS, type PaymentTermKind } from "@/lib/customers/terms";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { currencyMinorUnits } from "@/lib/money/currency";
import { add, cmp, dec, parseDecimalInput, sub, toFixedString } from "@/lib/money/decimal";
import { advancedFeaturesOn } from "@/lib/tracking/service";
import { optionalId, requireId, requireOneOf } from "@/lib/validation";

/**
 * Richer customers (examples RC1-RC12), NetSuite's customer detail: payment
 * terms (for every organisation, like Xero's), and while Advanced reporting
 * is on, credit limits, customer groups, price levels and parent customers.
 * The lists are archived, never deleted.
 */

export type PaymentTerm = { id: string; name: string; kind: PaymentTermKind; days: number; isActive: boolean };
export type CustomerGroup = { id: string; name: string; isActive: boolean };
export type PriceLevel = {
  id: string;
  name: string;
  /** Percent on (positive, a markup) or off (negative, a discount) the base price. */
  markupPercent: string;
  isActive: boolean;
};

export const CREDIT_LIMIT_ACTIONS = ["warn", "block"] as const;
export type CreditLimitAction = (typeof CREDIT_LIMIT_ACTIONS)[number];

export type CustomerSetup = {
  advancedFeatures: boolean;
  paymentTerms: PaymentTerm[];
  customerGroups: CustomerGroup[];
  priceLevels: PriceLevel[];
  creditLimitAction: CreditLimitAction;
  /** The organisation's terms for invoices and bills when the contact has none (decision 333). */
  defaultSalesPaymentTermId: string | null;
  defaultBillPaymentTermId: string | null;
};

export async function getCustomerSetup(tx: OrgTx): Promise<CustomerSetup> {
  // One transaction runs one query at a time.
  const terms = await tx.query<{ id: string; name: string; kind: PaymentTermKind; days: number; is_active: boolean }>(
    "select id, name, kind, days, is_active from payment_terms order by id",
  );
  const groups = await tx.query<{ id: string; name: string; is_active: boolean }>(
    "select id, name, is_active from customer_groups order by lower(name), id",
  );
  const levels = await tx.query<{ id: string; name: string; markup_percent: string; is_active: boolean }>(
    "select id, name, markup_percent::text, is_active from price_levels order by lower(name), id",
  );
  const settings = await tx.query<{ credit_limit_action: CreditLimitAction; sales: string | null; bills: string | null }>(
    "select credit_limit_action, default_sales_payment_term_id::text as sales, default_bill_payment_term_id::text as bills from organisation_settings where id = true",
  );
  return {
    advancedFeatures: await advancedFeaturesOn(tx),
    paymentTerms: terms.rows.map((row) => ({ id: row.id, name: row.name, kind: row.kind, days: row.days, isActive: row.is_active })),
    customerGroups: groups.rows.map((row) => ({ id: row.id, name: row.name, isActive: row.is_active })),
    priceLevels: levels.rows.map((row) => ({ id: row.id, name: row.name, markupPercent: row.markup_percent, isActive: row.is_active })),
    creditLimitAction: settings.rows[0]?.credit_limit_action ?? "warn",
    defaultSalesPaymentTermId: settings.rows[0]?.sales ?? null,
    defaultBillPaymentTermId: settings.rows[0]?.bills ?? null,
  };
}

function parseName(input: unknown): string {
  if (typeof input !== "string" || !input.trim()) throw new ValidationError("The name is required.");
  const name = input.trim().replace(/\s+/g, " ");
  if (name.length > 100) throw new ValidationError("The name can be at most 100 characters.");
  return name;
}

function parseActive(input: unknown): boolean | undefined {
  if (input === undefined) return undefined;
  if (typeof input !== "boolean") throw new ValidationError("isActive must be true or false.");
  return input;
}

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string }).code === "23505";
}

async function requireAdvanced(tx: OrgTx): Promise<void> {
  if (!(await advancedFeaturesOn(tx))) throw new ConflictError("Advanced reporting is off. Turn it on in Settings › Modules first.");
}

// ---------------------------------------------------------------------------
// The three lists

type ListTable = "payment_terms" | "customer_groups" | "price_levels";
const LIST_LABELS: Record<ListTable, { one: string; event: string }> = {
  payment_terms: { one: "payment term", event: "payment_term" },
  customer_groups: { one: "customer group", event: "customer_group" },
  price_levels: { one: "price level", event: "price_level" },
};

/** Inserts or updates one row of a list, turning a name clash into a clear message. */
async function saveListRow(
  tx: OrgTx,
  table: ListTable,
  id: string | null,
  values: Record<string, unknown>,
): Promise<string> {
  const columns = Object.keys(values);
  const params = Object.values(values);
  try {
    let savedId: string;
    if (id === null) {
      const inserted = await tx.query<{ id: string }>(
        `insert into ${table} (${columns.join(", ")}) values (${columns.map((_, i) => `$${i + 1}`).join(", ")}) returning id`,
        params,
      );
      savedId = inserted.rows[0].id;
    } else {
      await tx.query(
        `update ${table} set ${columns.map((column, i) => `${column} = $${i + 2}`).join(", ")}, updated_at = now() where id = $1`,
        [id, ...params],
      );
      savedId = id;
    }
    await writeAuditEvent(tx, {
      eventType: `${LIST_LABELS[table].event}.${id === null ? "created" : "updated"}`,
      entityType: LIST_LABELS[table].event,
      entityId: savedId,
      details: values,
    });
    return savedId;
  } catch (error) {
    if (isUniqueViolation(error)) throw new ConflictError(`There's already a ${LIST_LABELS[table].one} called ${String(values.name)}.`);
    throw error;
  }
}

async function lockListRow<T extends Record<string, unknown>>(tx: OrgTx, table: ListTable, idInput: unknown, columns: string): Promise<T & { id: string }> {
  const id = requireId(idInput, "id");
  const found = await tx.query<T & { id: string }>(`select id, ${columns} from ${table} where id = $1 for update`, [id]);
  if (!found.rows[0]) throw new NotFoundError(`That ${LIST_LABELS[table].one} wasn't found.`);
  return found.rows[0];
}

function parseTermKind(input: unknown): PaymentTermKind {
  return requireOneOf(input, "kind", PAYMENT_TERM_KINDS);
}

function parseTermDays(input: unknown, kind: PaymentTermKind): number {
  const text = typeof input === "number" ? String(input) : typeof input === "string" ? input.trim() : "";
  if (!/^\d{1,3}$/.test(text)) throw new ValidationError("Days must be a whole number.");
  const days = Number.parseInt(text, 10);
  if (kind === "day_of_next_month" && (days < 1 || days > 31)) throw new ValidationError("The day of the month must be from 1 to 31.");
  if (days > 365) throw new ValidationError("Days can be at most 365.");
  return days;
}

/** Adds a payment term (RC1). Admins; every organisation. */
export async function createPaymentTerm(tx: OrgTx, input: { name: unknown; kind: unknown; days: unknown }): Promise<CustomerSetup> {
  const kind = parseTermKind(input.kind);
  await saveListRow(tx, "payment_terms", null, { name: parseName(input.name), kind, days: parseTermDays(input.days, kind) });
  return getCustomerSetup(tx);
}

/** Renames, changes or archives a payment term (RC2). Invoices already saved keep their due dates. */
export async function updatePaymentTerm(
  tx: OrgTx,
  idInput: unknown,
  input: { name?: unknown; kind?: unknown; days?: unknown; isActive?: unknown },
): Promise<CustomerSetup> {
  const current = await lockListRow<{ name: string; kind: PaymentTermKind; days: number; is_active: boolean }>(
    tx,
    "payment_terms",
    idInput,
    "name, kind, days, is_active",
  );
  const kind = input.kind === undefined ? current.kind : parseTermKind(input.kind);
  await saveListRow(tx, "payment_terms", current.id, {
    name: input.name === undefined ? current.name : parseName(input.name),
    kind,
    days: input.days === undefined ? parseTermDays(current.days, kind) : parseTermDays(input.days, kind),
    is_active: parseActive(input.isActive) ?? current.is_active,
  });
  return getCustomerSetup(tx);
}

/** Adds a customer group (RC7). */
export async function createCustomerGroup(tx: OrgTx, input: { name: unknown }): Promise<CustomerSetup> {
  await requireAdvanced(tx);
  await saveListRow(tx, "customer_groups", null, { name: parseName(input.name) });
  return getCustomerSetup(tx);
}

export async function updateCustomerGroup(tx: OrgTx, idInput: unknown, input: { name?: unknown; isActive?: unknown }): Promise<CustomerSetup> {
  await requireAdvanced(tx);
  const current = await lockListRow<{ name: string; is_active: boolean }>(tx, "customer_groups", idInput, "name, is_active");
  await saveListRow(tx, "customer_groups", current.id, {
    name: input.name === undefined ? current.name : parseName(input.name),
    is_active: parseActive(input.isActive) ?? current.is_active,
  });
  return getCustomerSetup(tx);
}

/** A percent from above -100 to 1000, up to 4 decimal places: -10 is 10% off, 5 is 5% on. */
function parseMarkup(input: unknown): string {
  const value = parseDecimalInput(input, "The percent", { maxScale: 4, allowNegative: true, allowZero: true });
  if (cmp(dec(value), dec("-100")) <= 0) throw new ValidationError("A discount must be less than 100%.");
  if (cmp(dec(value), dec("1000")) > 0) throw new ValidationError("A markup can be at most 1000%.");
  return value;
}

/** Adds a price level (RC7). Nothing is priced from it until items arrive. */
export async function createPriceLevel(tx: OrgTx, input: { name: unknown; markupPercent: unknown }): Promise<CustomerSetup> {
  await requireAdvanced(tx);
  await saveListRow(tx, "price_levels", null, { name: parseName(input.name), markup_percent: parseMarkup(input.markupPercent) });
  return getCustomerSetup(tx);
}

export async function updatePriceLevel(
  tx: OrgTx,
  idInput: unknown,
  input: { name?: unknown; markupPercent?: unknown; isActive?: unknown },
): Promise<CustomerSetup> {
  await requireAdvanced(tx);
  const current = await lockListRow<{ name: string; markup_percent: string; is_active: boolean }>(
    tx,
    "price_levels",
    idInput,
    "name, markup_percent::text, is_active",
  );
  await saveListRow(tx, "price_levels", current.id, {
    name: input.name === undefined ? current.name : parseName(input.name),
    markup_percent: input.markupPercent === undefined ? current.markup_percent : parseMarkup(input.markupPercent),
    is_active: parseActive(input.isActive) ?? current.is_active,
  });
  return getCustomerSetup(tx);
}

/** Warn (the default) or block when approving an invoice would go over a customer's credit limit (RC3, RC4). */
export async function setCreditLimitAction(tx: OrgTx, input: unknown): Promise<CustomerSetup> {
  await requireAdvanced(tx);
  const action = requireOneOf(input, "creditLimitAction", CREDIT_LIMIT_ACTIONS);
  await tx.query("update organisation_settings set credit_limit_action = $1, updated_at = now() where id = true", [action]);
  await writeAuditEvent(tx, {
    eventType: "organisation.credit_limit_action_set",
    entityType: "organisation_settings",
    entityId: tx.organisationId,
    details: { creditLimitAction: action },
  });
  return getCustomerSetup(tx);
}

// ---------------------------------------------------------------------------
// A customer's details (RC2, RC3, RC7, RC8, RC12)

export type CustomerDetails = {
  deliveryAddress: string | null;
  paymentTermId: string | null;
  creditLimit: string | null;
  customerGroupId: string | null;
  priceLevelId: string | null;
  parentContactId: string | null;
};

export type CustomerDetailsInput = { [K in keyof CustomerDetails]?: unknown };

export const CUSTOMER_DETAIL_FIELDS = [
  "deliveryAddress",
  "paymentTermId",
  "creditLimit",
  "customerGroupId",
  "priceLevelId",
  "parentContactId",
] as const satisfies ReadonlyArray<keyof CustomerDetails>;

export const NO_CUSTOMER_DETAILS: CustomerDetails = {
  deliveryAddress: null,
  paymentTermId: null,
  creditLimit: null,
  customerGroupId: null,
  priceLevelId: null,
  parentContactId: null,
};

/** The fields as sent, in a stable shape for the idempotency hash (fields not sent are left out). */
export function customerDetailsForHash(input: CustomerDetailsInput): Record<string, unknown> {
  return Object.fromEntries(
    CUSTOMER_DETAIL_FIELDS.filter((field) => input[field] !== undefined).map((field) => [field, input[field] === "" ? null : input[field]]),
  );
}

function blank(input: unknown): boolean {
  return input === null || input === undefined || (typeof input === "string" && input.trim() === "");
}

async function checkListChoice(tx: OrgTx, table: ListTable, id: string): Promise<void> {
  const found = await tx.query<{ name: string; is_active: boolean }>(`select name, is_active from ${table} where id = $1`, [id]);
  const row = found.rows[0];
  if (!row) throw new ValidationError(`There's no ${LIST_LABELS[table].one} #${id}.`);
  if (!row.is_active) throw new ValidationError(`${row.name} is archived.`);
}

/**
 * Works out a contact's customer details from what was sent and what it had.
 * Payment terms and the delivery address are for everyone; the rest can only
 * be given a new value while Advanced reporting is on (a value already saved
 * stays). A newly chosen list entry must be active. Only customers can be
 * given them.
 */
export async function resolveCustomerDetails(
  tx: OrgTx,
  input: CustomerDetailsInput,
  current: CustomerDetails,
  options: { contactId: string | null; isCustomer: boolean },
): Promise<CustomerDetails> {
  const next: CustomerDetails = { ...current };
  if (input.deliveryAddress !== undefined) {
    if (blank(input.deliveryAddress)) next.deliveryAddress = null;
    else if (typeof input.deliveryAddress !== "string") throw new ValidationError("delivery address must be text.");
    else if (input.deliveryAddress.trim().length > 500) throw new ValidationError("delivery address can be at most 500 characters.");
    else next.deliveryAddress = input.deliveryAddress.trim();
  }
  const ids = ["paymentTermId", "customerGroupId", "priceLevelId", "parentContactId"] as const;
  for (const field of ids) {
    if (input[field] === undefined) continue;
    next[field] = blank(input[field]) ? null : optionalId(input[field], field);
  }
  if (input.creditLimit !== undefined) {
    next.creditLimit = blank(input.creditLimit)
      ? null
      : toFixedString(dec(parseDecimalInput(input.creditLimit, "The credit limit", { maxScale: currencyMinorUnits(tx.baseCurrency), allowZero: true })), currencyMinorUnits(tx.baseCurrency));
  }
  if (!options.isCustomer) {
    // Only customers have these (a supplier's delivery address isn't used).
    if (CUSTOMER_DETAIL_FIELDS.some((field) => input[field] !== undefined && !blank(input[field]))) {
      throw new ValidationError("Only customers have payment terms, a credit limit, a group, a price level, a parent or a delivery address.");
    }
    // A contact that stops being a customer keeps its details but leaves its parent.
    return { ...current, parentContactId: null };
  }

  const advanced = await advancedFeaturesOn(tx);
  const advancedOnly: Array<keyof CustomerDetails> = ["creditLimit", "customerGroupId", "priceLevelId", "parentContactId"];
  for (const field of advancedOnly) {
    const changed = field === "creditLimit"
      ? (next.creditLimit === null) !== (current.creditLimit === null) || (next.creditLimit !== null && current.creditLimit !== null && cmp(dec(next.creditLimit), dec(current.creditLimit)) !== 0)
      : next[field] !== current[field];
    if (changed && next[field] !== null && !advanced) {
      throw new ValidationError("Advanced reporting is off, so a credit limit, group, price level or parent customer can't be set.");
    }
  }
  if (next.paymentTermId !== null && next.paymentTermId !== current.paymentTermId) await checkListChoice(tx, "payment_terms", next.paymentTermId);
  if (next.customerGroupId !== null && next.customerGroupId !== current.customerGroupId) await checkListChoice(tx, "customer_groups", next.customerGroupId);
  if (next.priceLevelId !== null && next.priceLevelId !== current.priceLevelId) await checkListChoice(tx, "price_levels", next.priceLevelId);
  if (next.parentContactId !== null && next.parentContactId !== current.parentContactId) {
    if (next.parentContactId === options.contactId) throw new ValidationError("A customer can't be its own parent.");
    const parent = await tx.query<{ name: string; is_customer: boolean; is_archived: boolean }>(
      "select name, is_customer, is_archived from contacts where id = $1",
      [next.parentContactId],
    );
    const row = parent.rows[0];
    if (!row) throw new ValidationError(`There's no contact #${next.parentContactId}.`);
    if (!row.is_customer) throw new ValidationError(`${row.name} isn't a customer, so it can't be a parent customer.`);
    if (row.is_archived) throw new ValidationError(`${row.name} is archived.`);
    // Loops and depth are also checked by the database (RC8); this gives the clearer message first.
    if (options.contactId !== null) {
      const loop = await tx.query<{ found: boolean }>(
        `with recursive up(id, depth) as (
           select $1::bigint, 0
           union all
           select c.parent_contact_id, up.depth + 1 from contacts c join up on c.id = up.id
            where c.parent_contact_id is not null and up.depth < 20
         )
         select exists (select 1 from up where id = $2::bigint) as found`,
        [next.parentContactId, options.contactId],
      );
      if (loop.rows[0]?.found) throw new ValidationError(`${row.name} is one of this customer's sub-customers, so it can't be its parent.`);
    }
  }
  return next;
}

/** Turns a database refusal from the hierarchy trigger into a ValidationError with the same message. */
export function hierarchyError(error: unknown): Error | null {
  const message = (error as { message?: string }).message ?? "";
  if ((error as { code?: string }).code === "P0001" && /parent customer|sub-customers|hierarchy|own parent/i.test(message)) {
    return new ValidationError(`${message}.`);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Payment terms on invoices (RC1, RC2)

/**
 * The due date for a new invoice from its customer's payment terms, or null
 * when the customer has none (or they're archived).
 */
export async function dueDateFromTerms(tx: OrgTx, contactId: string, invoiceDate: string): Promise<string | null> {
  return dueDateFromContactOrDefault(tx, contactId, invoiceDate, "payment_term_id", "default_sales_payment_term_id");
}

/**
 * The contact's own active terms, else the organisation's default for
 * invoices or bills (decision 333), else none.
 */
async function dueDateFromContactOrDefault(
  tx: OrgTx,
  contactId: string,
  date: string,
  contactColumn: "payment_term_id" | "supplier_payment_term_id",
  defaultColumn: "default_sales_payment_term_id" | "default_bill_payment_term_id",
): Promise<string | null> {
  const found = await tx.query<{ kind: PaymentTermKind; days: number }>(
    `select t.kind, t.days
       from payment_terms t
      where t.is_active
        and t.id = coalesce(
              (select ct.id from contacts c join payment_terms ct on ct.id = c.${contactColumn} where c.id = $1 and ct.is_active),
              (select ${defaultColumn} from organisation_settings where id = true))`,
    [contactId],
  );
  const term = found.rows[0];
  return term ? dueDateFor(date, term) : null;
}

/** Sets the organisation's default terms for new invoices and bills (decision 333); blank clears one. Admins only. */
export async function setDefaultPaymentTerms(tx: OrgTx, input: { defaultSalesPaymentTermId?: unknown; defaultBillPaymentTermId?: unknown }): Promise<CustomerSetup> {
  const pick = async (value: unknown, label: string): Promise<string | null> => {
    if (value === null || value === "") return null;
    if (typeof value !== "string" && typeof value !== "number") throw new ValidationError(`Choose the ${label} payment term.`);
    const id = String(value);
    if (!/^\d{1,18}$/.test(id)) throw new ValidationError(`Choose the ${label} payment term.`);
    const found = await tx.query<{ is_active: boolean }>("select is_active from payment_terms where id = $1", [id]);
    if (!found.rows[0]) throw new ValidationError(`That ${label} payment term doesn't exist.`);
    if (!found.rows[0].is_active) throw new ValidationError(`That ${label} payment term is archived.`);
    return id;
  };
  if (input.defaultSalesPaymentTermId !== undefined) {
    const id = await pick(input.defaultSalesPaymentTermId, "invoice");
    await tx.query("update organisation_settings set default_sales_payment_term_id = $1, updated_at = now() where id = true", [id]);
  }
  if (input.defaultBillPaymentTermId !== undefined) {
    const id = await pick(input.defaultBillPaymentTermId, "bill");
    await tx.query("update organisation_settings set default_bill_payment_term_id = $1, updated_at = now() where id = true", [id]);
  }
  return getCustomerSetup(tx);
}

// ---------------------------------------------------------------------------
// Supplier payment terms (SPT1-SPT5), like the Terms on NetSuite's vendor record

/**
 * The due date for a new bill from its supplier's payment terms, or null
 * when the supplier has none (or they're archived). The same terms list and
 * maths as customers' (RC1): "20th of the following month" on a bill dated
 * 15 June is due 20 July.
 */
export async function dueDateFromSupplierTerms(tx: OrgTx, contactId: string, billDate: string): Promise<string | null> {
  return dueDateFromContactOrDefault(tx, contactId, billDate, "supplier_payment_term_id", "default_bill_payment_term_id");
}

/**
 * A supplier's payment term as sent (SPT1): blank clears it; a newly chosen
 * term must be active, and only suppliers can be given one. A contact that
 * stops being a supplier keeps its term (as customers keep theirs).
 */
export async function resolveSupplierPaymentTerm(
  tx: OrgTx,
  input: unknown,
  current: string | null,
  options: { isSupplier: boolean },
): Promise<string | null> {
  if (input === undefined) return current;
  const next = blank(input) ? null : optionalId(input, "supplierPaymentTermId");
  if (next === null || next === current) return next;
  if (!options.isSupplier) throw new ValidationError("Only suppliers have supplier payment terms.");
  await checkListChoice(tx, "payment_terms", next);
  return next;
}

// ---------------------------------------------------------------------------
// Receivables balances (RC3-RC5, RC9-RC11)

/**
 * What each customer owes as at a date, from the documents (never stored):
 * the unpaid part of approved invoices, less credit notes and overpayments
 * not yet used. `asAt` null means now (everything active). The total equals
 * the customer's share of accounts receivable.
 */
export const RECEIVABLES_SQL = `
with params as (select coalesce($1::date, 'infinity'::date) as as_at),
live_payments as (
  select p.* from customer_payments p, params
   where p.payment_date <= params.as_at and (p.void_date is null or p.void_date > params.as_at)
),
live_cn_apps as (
  select a.* from sales_credit_note_applications a, params
   where a.application_date <= params.as_at and (a.removal_date is null or a.removal_date > params.as_at)
),
live_op_apps as (
  select a.* from customer_overpayment_applications a, params
   where a.application_date <= params.as_at and (a.removal_date is null or a.removal_date > params.as_at)
),
live_cn_refunds as (
  select r.* from sales_credit_note_refunds r, params
   where r.refund_date <= params.as_at and (r.void_date is null or r.void_date > params.as_at)
),
live_op_refunds as (
  select r.* from customer_overpayment_refunds r, params
   where r.refund_date <= params.as_at and (r.void_date is null or r.void_date > params.as_at)
),
invoices_open as (
  select i.id, i.contact_id, i.invoice_number, i.invoice_date, i.due_date, i.currency_code, i.base_total,
         i.total
         - coalesce((select sum(p.amount - p.overpayment_amount) from live_payments p where p.invoice_id = i.id), 0)
         - coalesce((select sum(a.amount) from live_cn_apps a where a.invoice_id = i.id), 0)
         - coalesce((select sum(a.amount) from live_op_apps a where a.invoice_id = i.id), 0) as amount_due,
         -- A foreign-currency invoice's open base value at its own rate (MC9, MC15).
         i.base_total
         - coalesce((select sum(p.base_cleared) from live_payments p where p.invoice_id = i.id), 0)
         - coalesce((select sum(a.invoice_base) from live_cn_apps a where a.invoice_id = i.id), 0)
         - coalesce((select sum(a.invoice_base) from live_op_apps a where a.invoice_id = i.id), 0) as base_due
    from sales_invoices i, params
   where i.status in ('approved', 'voided') and i.invoice_date <= params.as_at
     and (i.void_date is null or i.void_date > params.as_at)
),
invoices as (
  select id, contact_id, invoice_number, invoice_date, due_date, currency_code, amount_due,
         case when base_total is null then amount_due else base_due end as amount_due_base
    from invoices_open
),
credit_notes_open as (
  select n.id, n.contact_id, n.credit_note_number, n.credit_note_date, n.total,
         n.total
         - coalesce((select sum(a.amount) from live_cn_apps a where a.credit_note_id = n.id), 0)
         - coalesce((select sum(r.amount) from live_cn_refunds r where r.credit_note_id = n.id), 0) as unused,
         -- A foreign-currency credit note's unused base value at its own rate (MC7, MC17).
         n.base_total
         - coalesce((select sum(a.credit_note_base) from live_cn_apps a where a.credit_note_id = n.id), 0)
         - coalesce((select sum(r.base_cleared) from live_cn_refunds r where r.credit_note_id = n.id), 0) as base_unused
    from sales_credit_notes n, params
   where n.status in ('approved', 'voided') and n.credit_note_date <= params.as_at
     and (n.void_date is null or n.void_date > params.as_at)
),
overpayments_open as (
  select p.id, i.contact_id, i.invoice_number, p.payment_date, p.overpayment_amount,
         p.overpayment_amount
         - coalesce((select sum(a.amount) from live_op_apps a where a.payment_id = p.id), 0)
         - coalesce((select sum(r.amount) from live_op_refunds r where r.payment_id = p.id), 0) as unused,
         -- A foreign-currency overpayment's unused base value at the payment's rate (MC14-MC16).
         case when p.exchange_rate is not null then
           coalesce(p.base_overpayment, 0)
           - coalesce((select sum(a.overpayment_base) from live_op_apps a where a.payment_id = p.id), 0)
           - coalesce((select sum(r.base_cleared) from live_op_refunds r where r.payment_id = p.id), 0) end as base_unused
    from live_payments p join sales_invoices i on i.id = p.invoice_id
   where p.overpayment_amount > 0
),
credit as (
  select contact_id, unused, coalesce(base_unused, unused) as unused_base from credit_notes_open
  union all
  select contact_id, unused, coalesce(base_unused, unused) from overpayments_open
)`;

/** A customer's receivables balance now (RC3): unpaid invoices less unused credit. */
export async function customerBalance(tx: OrgTx, contactId: string): Promise<string> {
  const result = await tx.query<{ balance: string }>(
    `${RECEIVABLES_SQL}
     select (coalesce((select sum(amount_due) from invoices where contact_id = $2), 0)
             - coalesce((select sum(unused) from credit where contact_id = $2), 0))::text as balance`,
    [null, contactId],
  );
  return toFixedString(dec(result.rows[0].balance), currencyMinorUnits(tx.baseCurrency));
}

/**
 * The credit limit check when approving an invoice (RC3-RC5, RC12): with
 * Advanced reporting on and a limit set, the customer's balance plus this
 * invoice must not go over it. "warn" returns a message (the invoice is
 * approved); "block" refuses. Null when within the limit or not checked.
 */
export async function checkCreditLimit(
  tx: OrgTx,
  invoice: { contactId: string; contactName: string; total: string },
): Promise<string | null> {
  if (!(await advancedFeaturesOn(tx))) return null;
  // Locking the customer makes approvals for them take turns, so two can't both fit under the limit.
  const found = await tx.query<{ credit_limit: string | null; credit_limit_action: CreditLimitAction }>(
    `select c.credit_limit::text, s.credit_limit_action from contacts c cross join organisation_settings s
      where c.id = $1 and s.id = true for update of c`,
    [invoice.contactId],
  );
  const row = found.rows[0];
  if (!row || row.credit_limit === null) return null;
  const scale = currencyMinorUnits(tx.baseCurrency);
  const balance = dec(await customerBalance(tx, invoice.contactId));
  const after = add(balance, dec(invoice.total));
  const limit = dec(row.credit_limit);
  if (cmp(after, limit) <= 0) return null;
  const money = (value: ReturnType<typeof dec>) => toFixedString(value, scale);
  const text =
    `${invoice.contactName} owes ${money(balance)}, so this invoice for ${money(dec(invoice.total))} takes them to ${money(after)}, ` +
    `${money(sub(after, limit))} over their credit limit of ${money(limit)}.`;
  if (row.credit_limit_action === "block") {
    throw new ConflictError(`${text} Approving is blocked in Settings › Customers; take a payment or raise the limit first.`);
  }
  return text;
}
