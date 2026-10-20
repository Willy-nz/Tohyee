import { type Actor, type OrgTx, withOrganisationTransaction } from "@/lib/db/org-transaction";
import { ConflictError } from "@/lib/errors";
import type { OrganisationRecord } from "@/lib/organisations/registry";
import { columnNameFrom, replaceTohyeeTables, type TableCopy, type TableCopyRow } from "@/lib/analytics/engine";
import { type LoadRun, requireAnalytics } from "@/lib/analytics/sources";
import { readFarmTables } from "@/lib/analytics/farm";
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
const PRICE = "DECIMAL(18,4)";

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
    system_account: string | null;
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
            l.foreign_amount::text, l.exchange_rate::text, a.system_key as system_account, l.tracking
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
      // Which built-in account it is, if any (accounts_receivable, accounts_payable, ...), for the built-in values (#337).
      { name: "system_account", type: "VARCHAR" },
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
        row.system_account,
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
              o.created_at::date::text as created_on, (select k.name from crm_campaigns k where k.id = o.source_campaign_id) as source_campaign
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
        row.source_campaign,
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
        { name: "source_campaign", type: "VARCHAR" },
      ],
      rows: opportunityRows,
    });
    const activities = await tx.query<Record<string, string | null>>(
      `select a.kind, a.happened_at::date::text as happened_on, a.subject, c.name as company, o.name as opportunity, a.created_by_email,
              a.opportunity_id::text, a.lead_id::text, a.person_id::text
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
        { name: "opportunity_id", type: "BIGINT" },
        { name: "lead_id", type: "BIGINT" },
        { name: "person_id", type: "BIGINT" },
      ],
      rows: activities.rows.map((row) => [
        row.kind,
        row.happened_on,
        row.subject,
        row.company,
        row.opportunity,
        row.created_by_email ? personName(tx, row.created_by_email) : null,
        row.opportunity_id,
        row.lead_id,
        row.person_id,
      ]),
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
    tables.push(...(await readCrmReportingTables(tx, ownerName)));
  }
  // Farm data while Farming is on (#249); Farming needs Accounting, so it goes with the books.
  tables.push(...(await readFarmTables(tx)));
  // With Accounting off (MOD4), only the CRM's tables: no ledger, documents, contacts, items or farm data.
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

/**
 * The CRM's reporting tables (decision 652, #216; #360 item 17): leads,
 * campaigns and their members, sequences and who's in them, sales emails,
 * deal products and tasks, copied as they are, like the opportunities.
 * People's email addresses and phone numbers, and emails' subjects and
 * words, aren't copied: reports count and group, they don't need them.
 */
async function readCrmReportingTables(tx: OrgTx, ownerName: (id: string | null) => string | null): Promise<TableCopy[]> {
  const tables: TableCopy[] = [];
  const leads = await tx.query<Record<string, string | null>>(
    `select l.id::text, coalesce(nullif(concat_ws(' ', l.first_name, l.last_name), ''), l.company_name, 'Lead') as name, l.company_name,
            l.status, l.source, l.source_detail, l.owner_user_id, k.name as source_campaign, l.created_at::date::text as created_on,
            l.converted_at::date::text as converted_on, l.unqualified_reason, l.converted_contact_id::text, l.converted_opportunity_id::text,
            l.needs_review::text
       from crm_leads l left join crm_campaigns k on k.id = l.source_campaign_id
      order by l.created_at, l.id`,
  );
  tables.push({
    name: "tohyee_crm_leads",
    columns: [
      { name: "lead_id", type: "BIGINT" },
      { name: "name", type: "VARCHAR" },
      { name: "company", type: "VARCHAR" },
      { name: "status", type: "VARCHAR" },
      { name: "source", type: "VARCHAR" },
      { name: "source_detail", type: "VARCHAR" },
      { name: "owner", type: "VARCHAR" },
      { name: "source_campaign", type: "VARCHAR" },
      { name: "created_on", type: "DATE" },
      { name: "converted_on", type: "DATE" },
      { name: "unqualified_reason", type: "VARCHAR" },
      { name: "converted_contact_id", type: "BIGINT" },
      { name: "converted_opportunity_id", type: "BIGINT" },
      { name: "to_review", type: "BOOLEAN" },
    ],
    rows: leads.rows.map((row) => [
      row.id,
      row.name,
      row.company_name,
      row.status,
      row.source,
      row.source_detail,
      ownerName(row.owner_user_id),
      row.source_campaign,
      row.created_on,
      row.converted_on,
      row.unqualified_reason,
      row.converted_contact_id,
      row.converted_opportunity_id,
      row.needs_review,
    ]),
  });

  const campaigns = await tx.query<Record<string, string | null>>(
    `select c.id::text, c.name, c.kind, c.status, c.start_date::text, c.end_date::text, c.budget::text, c.actual_cost::text, c.created_at::date::text as created_on
       from crm_campaigns c order by c.created_at, c.id`,
  );
  tables.push({
    name: "tohyee_crm_campaigns",
    columns: [
      { name: "campaign_id", type: "BIGINT" },
      { name: "name", type: "VARCHAR" },
      { name: "kind", type: "VARCHAR" },
      { name: "status", type: "VARCHAR" },
      { name: "start_date", type: "DATE" },
      { name: "end_date", type: "DATE" },
      // Typed in, in the base currency, for reports only (decision 498).
      { name: "budget", type: MONEY },
      { name: "actual_cost", type: MONEY },
      { name: "created_on", type: "DATE" },
    ],
    rows: campaigns.rows.map((row) => [row.id, row.name, row.kind, row.status, row.start_date, row.end_date, row.budget, row.actual_cost, row.created_on]),
  });

  const members = await tx.query<Record<string, string | null>>(
    `select m.campaign_id::text, c.name as campaign, m.lead_id::text, m.person_id::text, m.status,
            m.added_at::date::text as added_on, m.responded_at::date::text as responded_on
       from crm_campaign_members m join crm_campaigns c on c.id = m.campaign_id
      order by m.added_at, m.id`,
  );
  tables.push({
    name: "tohyee_crm_campaign_members",
    columns: [
      { name: "campaign_id", type: "BIGINT" },
      { name: "campaign", type: "VARCHAR" },
      { name: "lead_id", type: "BIGINT" },
      { name: "person_id", type: "BIGINT" },
      { name: "status", type: "VARCHAR" },
      { name: "added_on", type: "DATE" },
      { name: "responded_on", type: "DATE" },
    ],
    rows: members.rows.map((row) => [row.campaign_id, row.campaign, row.lead_id, row.person_id, row.status, row.added_on, row.responded_on]),
  });

  const sequences = await tx.query<Record<string, string | null>>(
    `select q.id::text, q.name, q.is_active::text, (select count(*) from crm_sequence_steps st where st.sequence_id = q.id)::text as steps
       from crm_sequences q order by q.created_at, q.id`,
  );
  tables.push({
    name: "tohyee_crm_sequences",
    columns: [
      { name: "sequence_id", type: "BIGINT" },
      { name: "name", type: "VARCHAR" },
      { name: "active", type: "BOOLEAN" },
      { name: "steps", type: "INTEGER" },
    ],
    rows: sequences.rows.map((row) => [row.id, row.name, row.is_active, row.steps]),
  });

  const enrolments = await tx.query<Record<string, string | null>>(
    `select e.id::text, e.sequence_id::text, q.name as sequence,
            case when e.lead_id is not null then 'lead' when e.person_id is not null then 'person' else 'deal' end as record,
            e.lead_id::text, e.person_id::text, e.opportunity_id::text, e.assignee_user_id, e.status, e.stop_reason,
            e.started_on::text, e.ended_at::date::text as ended_on,
            (select count(*) from crm_sequence_step_runs r where r.enrolment_id = e.id and r.outcome = 'task_created')::text as tasks_made
       from crm_sequence_enrolments e join crm_sequences q on q.id = e.sequence_id
      order by e.enrolled_at, e.id`,
  );
  tables.push({
    name: "tohyee_crm_sequence_enrolments",
    columns: [
      { name: "enrolment_id", type: "BIGINT" },
      { name: "sequence_id", type: "BIGINT" },
      { name: "sequence", type: "VARCHAR" },
      { name: "record", type: "VARCHAR" },
      { name: "lead_id", type: "BIGINT" },
      { name: "person_id", type: "BIGINT" },
      { name: "opportunity_id", type: "BIGINT" },
      { name: "assigned_to", type: "VARCHAR" },
      { name: "status", type: "VARCHAR" },
      { name: "stop_reason", type: "VARCHAR" },
      { name: "started_on", type: "DATE" },
      { name: "ended_on", type: "DATE" },
      { name: "tasks_made", type: "INTEGER" },
    ],
    rows: enrolments.rows.map((row) => [
      row.id,
      row.sequence_id,
      row.sequence,
      row.record,
      row.lead_id,
      row.person_id,
      row.opportunity_id,
      ownerName(row.assignee_user_id),
      row.status,
      row.stop_reason,
      row.started_on,
      row.ended_on,
      row.tasks_made,
    ]),
  });

  // Sales emails: who sent one, when, to which record, and whether it went. No addresses, subjects or words.
  const emails = await tx.query<Record<string, string | null>>(
    `select e.id::text, coalesce(e.sent_at, e.created_at)::date::text as sent_on, e.sent_by_user_id, t.name as template, e.status,
            e.lead_id::text, e.person_id::text, e.contact_id::text, e.opportunity_id::text
       from crm_sent_emails e left join crm_email_templates t on t.id = e.template_id
      where e.status <> 'sending'
      order by coalesce(e.sent_at, e.created_at), e.id`,
  );
  tables.push({
    name: "tohyee_crm_sales_emails",
    columns: [
      { name: "email_id", type: "BIGINT" },
      { name: "sent_on", type: "DATE" },
      { name: "sent_by", type: "VARCHAR" },
      { name: "template", type: "VARCHAR" },
      { name: "status", type: "VARCHAR" },
      { name: "lead_id", type: "BIGINT" },
      { name: "person_id", type: "BIGINT" },
      { name: "contact_id", type: "BIGINT" },
      { name: "opportunity_id", type: "BIGINT" },
    ],
    rows: emails.rows.map((row) => [row.id, row.sent_on, ownerName(row.sent_by_user_id), row.template, row.status, row.lead_id, row.person_id, row.contact_id, row.opportunity_id]),
  });

  const lines = await tx.query<Record<string, string | null>>(
    `select l.id::text, l.opportunity_id::text, o.name as opportunity, l.line_order::text, i.code as item_code, i.name as item, l.description,
            l.quantity::text, l.unit_price::text, l.discount_percent::text, l.line_amount::text, o.currency_code
       from crm_opportunity_lines l
       join crm_opportunities o on o.id = l.opportunity_id
       left join items i on i.id = l.item_id
      order by l.opportunity_id, l.line_order`,
  );
  tables.push({
    name: "tohyee_crm_deal_products",
    columns: [
      { name: "line_id", type: "BIGINT" },
      { name: "opportunity_id", type: "BIGINT" },
      { name: "opportunity", type: "VARCHAR" },
      { name: "line_order", type: "INTEGER" },
      { name: "item_code", type: "VARCHAR" },
      { name: "item", type: "VARCHAR" },
      { name: "description", type: "VARCHAR" },
      { name: "quantity", type: QUANTITY },
      { name: "unit_price", type: PRICE },
      { name: "discount_percent", type: "DECIMAL(5,2)" },
      // Excluding GST, after the discount, in the deal's currency (DS7).
      { name: "amount", type: MONEY },
      { name: "currency", type: "VARCHAR" },
    ],
    rows: lines.rows.map((row) => [
      row.id,
      row.opportunity_id,
      row.opportunity,
      row.line_order,
      row.item_code,
      row.item,
      row.description,
      row.quantity,
      row.unit_price,
      row.discount_percent,
      row.line_amount,
      row.currency_code,
    ]),
  });

  const tasks = await tx.query<Record<string, string | null>>(
    `select t.id::text, t.title, t.status, t.due_date::text, t.completed_at::date::text as done_on, t.assignee_user_id, c.name as company,
            t.opportunity_id::text, t.lead_id::text, t.person_id::text, t.created_at::date::text as created_on
       from crm_tasks t left join contacts c on c.id = t.contact_id
      order by t.created_at, t.id`,
  );
  tables.push({
    name: "tohyee_crm_tasks",
    columns: [
      { name: "task_id", type: "BIGINT" },
      { name: "title", type: "VARCHAR" },
      { name: "status", type: "VARCHAR" },
      { name: "due_on", type: "DATE" },
      { name: "done_on", type: "DATE" },
      { name: "assigned_to", type: "VARCHAR" },
      { name: "company", type: "VARCHAR" },
      { name: "opportunity_id", type: "BIGINT" },
      { name: "lead_id", type: "BIGINT" },
      { name: "person_id", type: "BIGINT" },
      { name: "created_on", type: "DATE" },
    ],
    rows: tasks.rows.map((row) => [
      row.id,
      row.title,
      row.status,
      row.due_date,
      row.done_on,
      ownerName(row.assignee_user_id),
      row.company,
      row.opportunity_id,
      row.lead_id,
      row.person_id,
      row.created_on,
    ]),
  });
  return tables;
}
