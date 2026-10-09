import { type Actor, type OrgTx, withOrganisationTransaction } from "@/lib/db/org-transaction";
import { ConflictError } from "@/lib/errors";
import type { OrganisationRecord } from "@/lib/organisations/registry";
import { columnNameFrom, replaceTohyeeTables, type TableCopy, type TableCopyRow } from "@/lib/analytics/engine";
import { type LoadRun, requireAnalytics } from "@/lib/analytics/sources";
import { rebuildShapedTablesForTables } from "@/lib/analytics/shaped-tables";
import { coreQuery } from "@/lib/db/transactions";
import { personName } from "@/lib/people/names";

/**
 * Analytics step 2 (examples AB1-AB10, decision 359): the organisation's own
 * books and CRM, copied from its database into its analytics file as
 * `tohyee_*` tables. The same data, row for row; nothing is worked out to
 * match a report, and signs are as in the ledger (debit - credit) so each
 * dashboard tile decides which way round to show them. Pay run lines carry no
 * employee names.
 */

export const BOOKS_SOURCE_NAME = "Books and CRM";
export const BOOKS_TABLE_NAME = "tohyee_*";
const BOOKS_FILE_NAME = "(this organisation's database)";

const MONEY = "DECIMAL(18,2)";
const RATE = "DECIMAL(18,6)";
const QUANTITY = "DECIMAL(18,4)";

type Lookups = {
  trackingCategories: Array<{ id: string; column: string }>;
  trackingValues: Map<string, string>;
  customFields: Array<{ id: string; record: string; column: string }>;
  customOptions: Map<string, string>;
};

async function lookups(tx: OrgTx): Promise<Lookups> {
  const categories = await tx.query<{ id: string; name: string }>("select id::text, name from tracking_categories order by sort_order, tracking_categories.id");
  const values = await tx.query<{ id: string; name: string }>("select id::text, name from tracking_values");
  const fields = await tx.query<{ id: string; record: string; label: string }>("select id::text, record, label from custom_fields order by sort_order, custom_fields.id");
  const options = await tx.query<{ id: string; name: string }>("select id::text, name from custom_field_options");
  const taken = new Set<string>();
  return {
    trackingCategories: categories.rows.map((row) => ({ id: row.id, column: columnNameFrom(`tracking ${row.name}`, taken) })),
    trackingValues: new Map(values.rows.map((row) => [row.id, row.name])),
    customFields: fields.rows.map((row) => ({ id: row.id, record: row.record, column: columnNameFrom(`cf ${row.label}`, taken) })),
    customOptions: new Map(options.rows.map((row) => [row.id, row.name])),
  };
}

function trackingColumns(look: Lookups) {
  return look.trackingCategories.map((category) => ({ name: category.column, type: "VARCHAR" }));
}

function trackingValues(look: Lookups, tracking: Record<string, string> | null): Array<string | null> {
  return look.trackingCategories.map((category) => {
    const value = tracking?.[category.id];
    return value === undefined || value === null ? null : (look.trackingValues.get(String(value)) ?? String(value));
  });
}

function customColumns(look: Lookups, record: string) {
  return look.customFields.filter((field) => field.record === record).map((field) => ({ name: field.column, type: "VARCHAR" }));
}

/** A custom field's value as text: option ids become their names, lists are joined. */
function customValues(look: Lookups, record: string, values: Record<string, unknown> | null): Array<string | null> {
  return look.customFields
    .filter((field) => field.record === record)
    .map((field) => {
      const value = values?.[field.id];
      if (value === undefined || value === null || value === "") return null;
      const show = (entry: unknown) => look.customOptions.get(String(entry)) ?? String(entry);
      return Array.isArray(value) ? value.map(show).join(", ") : show(value);
    });
}

/** Rows read from PostgreSQL at a time for the big tables (ledger lines, invoices, bills and their lines). */
export const BOOKS_BATCH_SIZE = 5000;

/**
 * Every `tohyee_*` table, read in the caller's (read-only) transaction. The
 * big tables are read through server-side cursors, a batch at a time, while
 * they're appended (issue 150), so they must be consumed (by
 * `replaceTohyeeTables`) before that transaction ends.
 */
export async function readBooks(
  tx: OrgTx,
  ownerEmails: ReadonlyMap<string, string> = new Map(),
  options: { batchSize?: number } = {},
): Promise<TableCopy[]> {
  const batchSize = options.batchSize ?? BOOKS_BATCH_SIZE;
  if (!Number.isInteger(batchSize) || batchSize < 1) throw new Error("The batch size must be a positive whole number.");
  let cursors = 0;
  // The query only runs when the table is copied; each fetch replaces the last batch in memory.
  async function* batches<T extends object>(sql: string, toRow: (row: T) => TableCopyRow): AsyncIterable<TableCopyRow[]> {
    const cursor = `tohyee_books_${++cursors}`;
    await tx.query(`declare ${cursor} no scroll cursor for ${sql}`);
    try {
      for (;;) {
        const batch = await tx.query<T>(`fetch forward ${batchSize} from ${cursor}`);
        if (batch.rows.length > 0) yield batch.rows.map(toRow);
        if (batch.rows.length < batchSize) break;
      }
    } finally {
      // Closed early when the copy stops part-way; a failed transaction closes it anyway.
      await tx.query(`close ${cursor}`).catch(() => undefined);
    }
  }

  const look = await lookups(tx);
  const settings = await tx.query<{ crm_enabled: boolean; accounting_enabled: boolean }>(
    "select crm_enabled, accounting_enabled from organisation_settings where id = true",
  );
  const tables: TableCopy[] = [];

  // Ledger lines, with the contact of the document behind the journal where there is one.
  type LedgerRow = {
    journal_id: string;
    posting_date: string;
    origin: string;
    reference: string | null;
    journal_description: string | null;
    line_order: number;
    account_code: string;
    account_name: string;
    account_class: string;
    account_type: string;
    contact_name: string | null;
    description: string | null;
    debit: string;
    credit: string;
    amount: string;
    currency_code: string | null;
    foreign_amount: string | null;
    exchange_rate: string | null;
    tracking: Record<string, string> | null;
  };
  const ledgerSql =
    `with journal_contacts as (
       select approval_journal_id as journal_id, contact_id from sales_invoices where approval_journal_id is not null
       union all select void_journal_id, contact_id from sales_invoices where void_journal_id is not null
       union all select approval_journal_id, contact_id from bills where approval_journal_id is not null
       union all select void_journal_id, contact_id from bills where void_journal_id is not null
       union all select approval_journal_id, contact_id from sales_credit_notes where approval_journal_id is not null
       union all select void_journal_id, contact_id from sales_credit_notes where void_journal_id is not null
       union all select approval_journal_id, contact_id from supplier_credit_notes where approval_journal_id is not null
       union all select void_journal_id, contact_id from supplier_credit_notes where void_journal_id is not null
       union all select journal_id, contact_id from bank_transactions where journal_id is not null
       union all select void_journal_id, contact_id from bank_transactions where void_journal_id is not null
     ),
     one_contact as (select distinct on (journal_id) journal_id, contact_id from journal_contacts order by journal_id, contact_id)
     select j.id::text as journal_id, j.posting_date::text, j.origin, j.reference, j.description as journal_description,
            l.line_order, a.code as account_code, a.name as account_name, a.account_class, a.account_type,
            c.name as contact_name, l.description, l.debit_amount::text as debit, l.credit_amount::text as credit,
            (l.debit_amount - l.credit_amount)::text as amount, l.foreign_currency_code as currency_code,
            l.foreign_amount::text, l.exchange_rate::text, l.tracking
       from ledger_journal_lines l
       join ledger_journals j on j.id = l.journal_id
       join accounts a on a.id = l.account_id
       left join one_contact oc on oc.journal_id = j.id
       left join contacts c on c.id = oc.contact_id
      order by j.posting_date, j.id, l.line_order`;
  tables.push({
    name: "tohyee_ledger_lines",
    columns: [
      { name: "journal_id", type: "BIGINT" },
      { name: "posting_date", type: "DATE" },
      { name: "source", type: "VARCHAR" },
      { name: "reference", type: "VARCHAR" },
      { name: "journal_description", type: "VARCHAR" },
      { name: "line", type: "INTEGER" },
      { name: "account_code", type: "VARCHAR" },
      { name: "account_name", type: "VARCHAR" },
      { name: "account_class", type: "VARCHAR" },
      { name: "account_type", type: "VARCHAR" },
      { name: "contact", type: "VARCHAR" },
      { name: "description", type: "VARCHAR" },
      { name: "debit", type: MONEY },
      { name: "credit", type: MONEY },
      { name: "amount", type: MONEY },
      { name: "currency", type: "VARCHAR" },
      { name: "foreign_amount", type: MONEY },
      { name: "exchange_rate", type: RATE },
      ...trackingColumns(look),
    ],
    rows: batches<LedgerRow>(ledgerSql, (row) => {
      // Pay runs: no employee names (Jess, 3 Oct 2026; AB10).
      const payroll = row.origin === "payroll";
      return [
        row.journal_id,
        row.posting_date,
        row.origin,
        payroll ? null : row.reference,
        payroll ? "Pay run" : row.journal_description,
        String(row.line_order),
        row.account_code,
        row.account_name,
        row.account_class,
        row.account_type,
        payroll ? null : row.contact_name,
        payroll ? "Pay run" : row.description,
        row.debit,
        row.credit,
        row.amount,
        row.currency_code,
        row.foreign_amount,
        row.exchange_rate,
        ...trackingValues(look, row.tracking),
      ];
    }),
  });

  // Invoices and bills: approved and voided, never drafts.
  for (const kind of ["invoice", "bill"] as const) {
    const documents = kind === "invoice" ? "sales_invoices" : "bills";
    const lines = kind === "invoice" ? "sales_invoice_lines" : "bill_lines";
    const parent = kind === "invoice" ? "invoice_id" : "bill_id";
    const number = kind === "invoice" ? "d.invoice_number" : "d.supplier_invoice_number";
    const date = kind === "invoice" ? "invoice_date" : "bill_date";
    const headSql =
      `select d.id::text, ${number} as number, d.status, d.${date}::text as date, d.due_date::text, d.void_date::text,
              c.name as contact, d.${kind === "invoice" ? "reference" : "supplier_invoice_number"} as reference,
              coalesce(d.base_subtotal, d.subtotal)::text as net, coalesce(d.base_tax_total, d.tax_total)::text as gst,
              coalesce(d.base_total, d.total)::text as total, d.currency_code,
              case when d.base_total is not null then d.total::text end as foreign_total, d.exchange_rate::text,
              d.custom_fields
         from ${documents} d join contacts c on c.id = d.contact_id
        where d.status in ('approved', 'voided')
        order by d.${date}, d.id`;
    tables.push({
      name: `tohyee_${kind}s`,
      columns: [
        { name: `${kind}_id`, type: "BIGINT" },
        { name: "number", type: "VARCHAR" },
        { name: "status", type: "VARCHAR" },
        { name: `${kind}_date`, type: "DATE" },
        { name: "due_date", type: "DATE" },
        { name: "void_date", type: "DATE" },
        { name: "contact", type: "VARCHAR" },
        { name: "reference", type: "VARCHAR" },
        { name: "net", type: MONEY },
        { name: "gst", type: MONEY },
        { name: "total", type: MONEY },
        { name: "currency", type: "VARCHAR" },
        { name: "foreign_total", type: MONEY },
        { name: "exchange_rate", type: RATE },
        ...customColumns(look, "document"),
      ],
      rows: batches<Record<string, string | null> & { custom_fields: Record<string, unknown> | null }>(headSql, (row) => [
        row.id,
        row.number,
        row.status,
        row.date,
        row.due_date,
        row.void_date,
        row.contact,
        row.reference,
        row.net,
        row.gst,
        row.total,
        row.currency_code,
        row.foreign_total,
        row.exchange_rate,
        ...customValues(look, "document", row.custom_fields),
      ]),
    });
    const detailSql =
      `select d.id::text as document_id, ${number} as number, d.status, d.${date}::text as date, c.name as contact,
              l.line_order::text, l.description, i.code as item_code, a.code as account_code, a.name as account_name,
              t.code as tax_code, l.quantity::text, l.unit_price::text,
              coalesce(l.base_net_amount, l.net_amount)::text as net, coalesce(l.base_tax_amount, l.tax_amount)::text as gst,
              l.tracking
         from ${lines} l
         join ${documents} d on d.id = l.${parent}
         join contacts c on c.id = d.contact_id
         left join items i on i.id = l.item_id
         left join accounts a on a.id = l.account_id
         left join tax_codes t on t.id = l.tax_code_id
        where d.status in ('approved', 'voided')
        order by d.${date}, d.id, l.line_order`;
    tables.push({
      name: `tohyee_${kind}_lines`,
      columns: [
        { name: `${kind}_id`, type: "BIGINT" },
        { name: "number", type: "VARCHAR" },
        { name: "status", type: "VARCHAR" },
        { name: `${kind}_date`, type: "DATE" },
        { name: "contact", type: "VARCHAR" },
        { name: "line", type: "INTEGER" },
        { name: "description", type: "VARCHAR" },
        { name: "item_code", type: "VARCHAR" },
        { name: "account_code", type: "VARCHAR" },
        { name: "account_name", type: "VARCHAR" },
        { name: "tax_code", type: "VARCHAR" },
        { name: "quantity", type: QUANTITY },
        { name: "unit_price", type: RATE },
        { name: "net", type: MONEY },
        { name: "gst", type: MONEY },
        ...trackingColumns(look),
      ],
      rows: batches<Record<string, string | null> & { tracking: Record<string, string> | null }>(detailSql, (row) => [
        row.document_id,
        row.number,
        row.status,
        row.date,
        row.contact,
        row.line_order,
        row.description,
        row.item_code,
        row.account_code,
        row.account_name,
        row.tax_code,
        row.quantity,
        row.unit_price,
        row.net,
        row.gst,
        ...trackingValues(look, row.tracking),
      ]),
    });
  }

  const contacts = await tx.query<Record<string, string | null> & { custom_fields: Record<string, unknown> | null }>(
    `select id::text, name, is_customer::text, is_supplier::text, is_prospect::text, email, phone, postal_address,
            delivery_address, billing_country, delivery_country, gst_number, is_archived::text, custom_fields
       from contacts order by name, contacts.id`,
  );
  tables.push({
    name: "tohyee_contacts",
    columns: [
      { name: "contact_id", type: "BIGINT" },
      { name: "name", type: "VARCHAR" },
      { name: "is_customer", type: "BOOLEAN" },
      { name: "is_supplier", type: "BOOLEAN" },
      { name: "is_prospect", type: "BOOLEAN" },
      { name: "email", type: "VARCHAR" },
      { name: "phone", type: "VARCHAR" },
      { name: "postal_address", type: "VARCHAR" },
      { name: "delivery_address", type: "VARCHAR" },
      { name: "billing_country", type: "VARCHAR" },
      { name: "delivery_country", type: "VARCHAR" },
      { name: "gst_number", type: "VARCHAR" },
      { name: "archived", type: "BOOLEAN" },
      ...customColumns(look, "contact"),
    ],
    rows: contacts.rows.map((row) => [
      row.id,
      row.name,
      row.is_customer,
      row.is_supplier,
      row.is_prospect,
      row.email,
      row.phone,
      row.postal_address,
      row.delivery_address,
      row.billing_country,
      row.delivery_country,
      row.gst_number,
      row.is_archived,
      ...customValues(look, "contact", row.custom_fields),
    ]),
  });

  const items = await tx.query<Record<string, string | null>>(
    `select code, name, description, item_type, base_unit, sale_price::text, purchase_price::text, is_active::text
       from items order by code`,
  );
  tables.push({
    name: "tohyee_items",
    columns: [
      { name: "code", type: "VARCHAR" },
      { name: "name", type: "VARCHAR" },
      { name: "description", type: "VARCHAR" },
      { name: "item_type", type: "VARCHAR" },
      { name: "unit", type: "VARCHAR" },
      { name: "sale_price", type: RATE },
      { name: "purchase_price", type: RATE },
      { name: "active", type: "BOOLEAN" },
    ],
    rows: items.rows.map((row) => [row.code, row.name, row.description, row.item_type, row.base_unit, row.sale_price, row.purchase_price, row.is_active]),
  });

  // CRM, only while it's on (AB9).
  if (settings.rows[0]?.crm_enabled) {
    const opportunities = await tx.query<Record<string, string | null>>(
      `select o.id::text, o.name, c.name as company, o.owner_user_id, o.amount::text, o.currency_code, o.close_date::text,
              coalesce(s.name, o.stage) as stage, s.stage_type, o.probability::text, o.forecast_category,
              o.created_at::date::text as created_on
         from crm_opportunities o
         left join contacts c on c.id = o.contact_id
         left join crm_opportunity_stages s on s.key = o.stage
        order by o.created_at, o.id`,
    );
    const ownerName = (id: string | null) => {
      if (!id) return null;
      const email = ownerEmails.get(id);
      return email ? personName(tx, email) : null;
    };
    const opportunityRows: Array<Array<string | null>> = [];
    for (const row of opportunities.rows) {
      opportunityRows.push([
        row.id,
        row.name,
        row.company,
        ownerName(row.owner_user_id),
        row.amount,
        row.currency_code,
        row.close_date,
        row.stage,
        row.stage_type === "won" ? "won" : row.stage_type === "lost" ? "lost" : "open",
        row.probability,
        row.forecast_category,
        row.created_on,
      ]);
    }
    tables.push({
      name: "tohyee_crm_opportunities",
      columns: [
        { name: "opportunity_id", type: "BIGINT" },
        { name: "name", type: "VARCHAR" },
        { name: "company", type: "VARCHAR" },
        { name: "owner", type: "VARCHAR" },
        { name: "amount", type: MONEY },
        { name: "currency", type: "VARCHAR" },
        { name: "expected_close", type: "DATE" },
        { name: "stage", type: "VARCHAR" },
        { name: "outcome", type: "VARCHAR" },
        { name: "probability", type: "INTEGER" },
        { name: "forecast_category", type: "VARCHAR" },
        { name: "created_on", type: "DATE" },
      ],
      rows: opportunityRows,
    });
    const activities = await tx.query<Record<string, string | null>>(
      `select a.kind, a.happened_at::date::text as happened_on, a.subject, c.name as company, o.name as opportunity, a.created_by_email
         from crm_activities a
         left join contacts c on c.id = a.contact_id
         left join crm_opportunities o on o.id = a.opportunity_id
        order by a.happened_at, a.id`,
    );
    tables.push({
      name: "tohyee_crm_activities",
      columns: [
        { name: "kind", type: "VARCHAR" },
        { name: "happened_on", type: "DATE" },
        { name: "subject", type: "VARCHAR" },
        { name: "company", type: "VARCHAR" },
        { name: "opportunity", type: "VARCHAR" },
        { name: "by", type: "VARCHAR" },
      ],
      rows: activities.rows.map((row) => [row.kind, row.happened_on, row.subject, row.company, row.opportunity, row.created_by_email ? personName(tx, row.created_by_email) : null]),
    });
    const companies = await tx.query<Record<string, string | null>>(
      `select c.id::text, c.name, c.is_customer::text, c.is_prospect::text, c.billing_country,
              (select count(*) from crm_opportunities o where o.contact_id = c.id)::text as opportunities
         from contacts c
        where c.is_customer or c.is_prospect or exists (select 1 from crm_opportunities o where o.contact_id = c.id)
        order by c.name, c.id`,
    );
    tables.push({
      name: "tohyee_crm_companies",
      columns: [
        { name: "contact_id", type: "BIGINT" },
        { name: "name", type: "VARCHAR" },
        { name: "is_customer", type: "BOOLEAN" },
        { name: "is_prospect", type: "BOOLEAN" },
        { name: "country", type: "VARCHAR" },
        { name: "opportunities", type: "INTEGER" },
      ],
      rows: companies.rows.map((row) => [row.id, row.name, row.is_customer, row.is_prospect, row.billing_country, row.opportunities]),
    });
  }
  // With Accounting off (MOD4), only the CRM's tables: no ledger, documents, contacts or items.
  return settings.rows[0]?.accounting_enabled === false ? tables.filter((table) => table.name.startsWith("tohyee_crm_")) : tables;
}

/**
 * Copies the books and CRM now (nightly, or "Refresh now"). The copy is read
 * in one read-only transaction (the big tables in batches, appended as they
 * arrive) and swapped in only when every table has loaded; the record of it
 * is written before and after, like a CSV load.
 */
export async function refreshBooks(organisation: OrganisationRecord, actor: Actor, trigger: "schedule" | "manual"): Promise<LoadRun> {
  const runId = await withOrganisationTransaction(organisation, actor, async (tx) => {
    await requireAnalytics(tx);
    const busy = await tx.query("select 1 from analytics_load_runs where source_id is null and table_name = $1 and status = 'running' and started_at > now() - interval '1 hour'", [
      BOOKS_TABLE_NAME,
    ]);
    if (busy.rows.length > 0) throw new ConflictError("The books are already being copied.");
    const run = await tx.query<{ id: string }>(
      `insert into analytics_load_runs (source_id, source_name, table_name, file_name, trigger, requested_by_email)
       values (null, $1, $2, $3, $4, $5) returning id::text`,
      [BOOKS_SOURCE_NAME, BOOKS_TABLE_NAME, BOOKS_FILE_NAME, trigger, trigger === "manual" ? actor.email : null],
    );
    return run.rows[0].id;
  });

  const started = performance.now();
  let rows: number | null = null;
  let error: string | null = null;
  let changedTables: string[] = [];
  try {
    // CRM owners are users, kept in the core database: looked up first, outside the organisation's transaction.
    const members = await coreQuery<{ id: string; email: string }>(
      "select u.id::text, u.email from organisation_members m join users u on u.id = m.user_id where m.organisation_id = $1",
      [organisation.id],
    );
    const ownerEmails = new Map(members.rows.map((row) => [row.id, row.email]));
    // Appended to DuckDB (a local file, not a network call) while the transaction is open, a batch at a time.
    const copied = await withOrganisationTransaction(
      organisation,
      actor,
      async (tx) => {
        const tables = await readBooks(tx, ownerEmails);
        return { rows: await replaceTohyeeTables(organisation.id, tables), names: tables.map((table) => table.name) };
      },
      { readOnly: true },
    );
    rows = copied.rows;
    changedTables = copied.names;
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  }
  const milliseconds = Math.round(performance.now() - started);

  const run = await withOrganisationTransaction(organisation, actor, async (tx) => {
    const result = await tx.query<{
      id: string;
      source_id: string | null;
      source_name: string;
      table_name: string;
      file_name: string;
      trigger: "schedule" | "manual";
      status: "running" | "ok" | "failed";
      started_at: Date;
      finished_at: Date | null;
      rows_loaded: string | null;
      milliseconds: number | null;
      error: string | null;
      requested_by_email: string | null;
    }>(
      `update analytics_load_runs set status = $2, finished_at = now(), rows_loaded = $3, milliseconds = $4, error = $5
        where id = $1
        returning id::text, source_id::text, source_name, table_name, file_name, trigger, status, started_at, finished_at,
                  rows_loaded::text, milliseconds, error, requested_by_email`,
      [runId, error ? "failed" : "ok", rows === null ? null : String(rows), milliseconds, error],
    );
    const row = result.rows[0];
    return {
      id: row.id,
      sourceId: row.source_id,
      sourceName: row.source_name,
      tableName: row.table_name,
      fileName: row.file_name,
      trigger: row.trigger,
      status: row.status,
      startedAt: new Date(row.started_at).toISOString(),
      finishedAt: row.finished_at ? new Date(row.finished_at).toISOString() : null,
      rowsLoaded: row.rows_loaded,
      milliseconds: row.milliseconds,
      error: row.error,
      requestedByEmail: row.requested_by_email,
    };
  });
  if (run.status === "ok") {
    try {
      await rebuildShapedTablesForTables(organisation, actor, changedTables, trigger);
    } catch (caught) {
      console.warn("[tohyee] Shaped tables after copying the books:", caught instanceof Error ? caught.message : caught);
    }
  }
  return run;
}
