import { listDashboards } from "@/lib/analytics/dashboards";
import { crmEnabled } from "@/lib/crm/switch";
import { todayIsoDate } from "@/lib/dates";
import type { OrgTx } from "@/lib/db/org-transaction";
import { requireOneOf } from "@/lib/validation";
import { SEARCH_FILTERS, type SearchFilter, type SearchGroup, type SearchKind, type SearchRecord, type SearchResponse } from "./types";

const PER_KIND = 5;
const DASHBOARDS_HREF = "/analytics";
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"] as const;

function escapeLike(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

function amountTerm(query: string): string | null {
  const cleaned = query.replaceAll(",", "").trim();
  if (!/^\d+(\.\d+)?$/.test(cleaned)) return null;
  return cleaned;
}

function dateTerm(query: string): string | null {
  const trimmed = query.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
  const match = /^(\d{1,2})\s+([A-Za-z]{3,9})$/.exec(trimmed);
  if (!match) return null;
  const day = Number(match[1]);
  if (!Number.isInteger(day) || day < 1 || day > 31) return null;
  const month = MONTHS.findIndex((month) => month === match[2].slice(0, 3).toLowerCase());
  if (month < 0) return null;
  const [yearText] = todayIsoDate().split("-");
  const year = Number(yearText);
  const date = new Date(Date.UTC(year, month, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month || date.getUTCDate() !== day) return null;
  const monthText = String(month + 1).padStart(2, "0");
  const dayText = String(day).padStart(2, "0");
  return `${year}-${monthText}-${dayText}`;
}

function splitPrefix(query: string): { query: string; forcedFilter: SearchFilter | null } {
  const trimmed = query.trim();
  const lower = trimmed.toLowerCase();
  const prefixes: Array<{ starts: string[]; filter: SearchFilter }> = [
    { starts: ["c:", "contact "], filter: "contacts" },
    { starts: ["inv ", "invoice "], filter: "sales" },
    { starts: ["bill "], filter: "purchases" },
  ];
  for (const prefix of prefixes) {
    for (const start of prefix.starts) {
      if (lower.startsWith(start)) {
        return { query: trimmed.slice(start.length).trim(), forcedFilter: prefix.filter };
      }
    }
  }
  return { query: trimmed, forcedFilter: null };
}

type SearchInput = { query: string; filter: unknown; onlyDashboards: boolean; userId: string | null };

function whereParts(
  textColumns: string[],
  query: string,
  amountColumn: string | null,
  dateColumn: string | null,
): { sql: string; params: unknown[] } {
  const params: unknown[] = [];
  const words = query
    .toLowerCase()
    .split(/\s+/)
    .map((word) => word.trim())
    .filter(Boolean);
  const textConditions: string[] = [];
  for (const word of words) {
    params.push(`%${escapeLike(word)}%`);
    textConditions.push(`lower(concat_ws(' ', ${textColumns.join(", ")})) like $${params.length} escape '\\'`);
  }
  const matchers: string[] = [];
  if (textConditions.length > 0) {
    matchers.push(`(${textConditions.join(" and ")})`);
  }
  const amount = amountTerm(query);
  if (amountColumn && amount) {
    params.push(amount);
    matchers.push(`${amountColumn} = $${params.length}::numeric`);
  }
  const date = dateTerm(query);
  if (dateColumn && date) {
    params.push(date);
    matchers.push(`${dateColumn} = $${params.length}::date`);
  }
  if (matchers.length === 0) return { sql: "true", params };
  return { sql: `(${matchers.join(" or ")})`, params };
}

async function queryRecords(
  tx: OrgTx,
  kind: SearchKind,
  label: string,
  sql: string,
  params: unknown[],
): Promise<SearchGroup> {
  const found = await tx.query<{ title: string; subtitle: string; status: string | null; href: string }>(sql, params);
  return {
    key: kind,
    label,
    records: found.rows.map((row) => ({ kind, title: row.title, subtitle: row.subtitle, status: row.status, href: row.href })),
  };
}

export async function searchEverything(tx: OrgTx, input: SearchInput): Promise<SearchResponse> {
  const requested = requireOneOf(input.filter, "kind", SEARCH_FILTERS);
  const withPrefix = splitPrefix(input.query);
  const query = withPrefix.query;
  const filter = withPrefix.forcedFilter ?? requested;
  if (input.onlyDashboards) {
    const dashboards = await listDashboards(tx, { userId: input.userId, reportViewer: true });
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const records = dashboards
      .filter((dashboard) => words.every((word) => dashboard.name.toLowerCase().includes(word)))
      .slice(0, PER_KIND)
      .map<SearchRecord>((dashboard) => ({
        kind: "dashboard",
        title: dashboard.name,
        subtitle: "Analytics dashboard",
        status: null,
        href: DASHBOARDS_HREF,
      }));
    return { query, filter, groups: [{ key: "dashboard", label: "Dashboards", records }] };
  }

  const groups: SearchGroup[] = [];
  const crmOn = await crmEnabled(tx);
  const include = (name: SearchFilter) => filter === "all" || filter === name;

  if (include("contacts")) {
    const where = whereParts(["c.name", "coalesce(c.email, '')", "coalesce(c.phone, '')"], query, null, null);
    groups.push(
      await queryRecords(
        tx,
        "contact",
        "Contacts",
        `select c.name as title,
                concat_ws(' · ', case when c.is_customer and c.is_supplier then 'Customer and supplier'
                                     when c.is_customer then 'Customer'
                                     when c.is_supplier then 'Supplier'
                                     else 'Prospect' end, c.email, c.phone) as subtitle,
                null::text as status,
                '/operations/contacts' as href
           from contacts c
          where not c.is_archived and ${where.sql}
          order by c.id desc
          limit ${PER_KIND}`,
        where.params,
      ),
    );
  }

  if (include("sales")) {
    const invoiceWhere = whereParts(["i.invoice_number", "coalesce(i.reference, '')", "c.name", "coalesce(c.email, '')", "coalesce(c.phone, '')"], query, "i.total", "i.invoice_date");
    groups.push(
      await queryRecords(
        tx,
        "invoice",
        "Invoices",
        `select coalesce(i.invoice_number, concat('Draft invoice #', i.id::text)) as title,
                concat_ws(' · ', i.invoice_date::text, i.total::text, c.name) as subtitle,
                initcap(i.status) as status,
                '/operations/invoices/' || i.id::text as href
           from sales_invoices i
           join contacts c on c.id = i.contact_id
          where ${invoiceWhere.sql}
          order by i.invoice_date desc, i.id desc
          limit ${PER_KIND}`,
        invoiceWhere.params,
      ),
    );
    const creditWhere = whereParts(["coalesce(n.credit_note_number, '')", "coalesce(n.reference, '')", "c.name", "coalesce(c.email, '')", "coalesce(c.phone, '')"], query, "n.total", "n.credit_note_date");
    groups.push(
      await queryRecords(
        tx,
        "sales_credit_note",
        "Sales credit notes",
        `select coalesce(n.credit_note_number, concat('Draft credit note #', n.id::text)) as title,
                concat_ws(' · ', n.credit_note_date::text, n.total::text, c.name) as subtitle,
                initcap(n.status) as status,
                '/operations/credit-notes/' || n.id::text as href
           from sales_credit_notes n
           join contacts c on c.id = n.contact_id
          where ${creditWhere.sql}
          order by n.credit_note_date desc, n.id desc
          limit ${PER_KIND}`,
        creditWhere.params,
      ),
    );
    const quoteWhere = whereParts(["coalesce(q.quote_number, '')", "coalesce(q.reference, '')", "c.name", "coalesce(c.email, '')", "coalesce(c.phone, '')"], query, "q.total", "q.quote_date");
    groups.push(
      await queryRecords(
        tx,
        "quote",
        "Quotes",
        `select coalesce(q.quote_number, concat('Draft quote #', q.id::text)) as title,
                concat_ws(' · ', q.quote_date::text, q.total::text, c.name) as subtitle,
                initcap(q.status) as status,
                '/operations/quotes/' || q.id::text as href
           from quotes q
           join contacts c on c.id = q.contact_id
          where ${quoteWhere.sql}
          order by q.quote_date desc, q.id desc
          limit ${PER_KIND}`,
        quoteWhere.params,
      ),
    );
    const salesOrderWhere = whereParts(["coalesce(s.so_number, '')", "coalesce(s.reference, '')", "c.name", "coalesce(c.email, '')", "coalesce(c.phone, '')"], query, "s.total", "s.order_date");
    groups.push(
      await queryRecords(
        tx,
        "sales_order",
        "Sales orders",
        `select coalesce(s.so_number, concat('Draft sales order #', s.id::text)) as title,
                concat_ws(' · ', s.order_date::text, s.total::text, c.name) as subtitle,
                initcap(s.status) as status,
                '/operations/sales-orders/' || s.id::text as href
           from sales_orders s
           join contacts c on c.id = s.contact_id
          where ${salesOrderWhere.sql}
          order by s.order_date desc, s.id desc
          limit ${PER_KIND}`,
        salesOrderWhere.params,
      ),
    );
  }

  if (include("purchases")) {
    const billWhere = whereParts(["b.supplier_invoice_number", "coalesce(b.reference, '')", "c.name", "coalesce(c.email, '')", "coalesce(c.phone, '')"], query, "b.total", "b.bill_date");
    groups.push(
      await queryRecords(
        tx,
        "bill",
        "Bills",
        `select b.supplier_invoice_number as title,
                concat_ws(' · ', b.bill_date::text, b.total::text, c.name) as subtitle,
                initcap(b.status) as status,
                '/operations/bills/' || b.id::text as href
           from bills b
           join contacts c on c.id = b.contact_id
          where ${billWhere.sql}
          order by b.bill_date desc, b.id desc
          limit ${PER_KIND}`,
        billWhere.params,
      ),
    );
    const supplierCreditWhere = whereParts(["s.supplier_credit_note_number", "coalesce(s.reference, '')", "c.name", "coalesce(c.email, '')", "coalesce(c.phone, '')"], query, "s.total", "s.credit_note_date");
    groups.push(
      await queryRecords(
        tx,
        "supplier_credit_note",
        "Supplier credit notes",
        `select s.supplier_credit_note_number as title,
                concat_ws(' · ', s.credit_note_date::text, s.total::text, c.name) as subtitle,
                initcap(s.status) as status,
                '/operations/supplier-credit-notes/' || s.id::text as href
           from supplier_credit_notes s
           join contacts c on c.id = s.contact_id
          where ${supplierCreditWhere.sql}
          order by s.credit_note_date desc, s.id desc
          limit ${PER_KIND}`,
        supplierCreditWhere.params,
      ),
    );
    const purchaseOrderWhere = whereParts(["coalesce(p.po_number, '')", "coalesce(p.reference, '')", "c.name", "coalesce(c.email, '')", "coalesce(c.phone, '')"], query, "p.total", "p.order_date");
    groups.push(
      await queryRecords(
        tx,
        "purchase_order",
        "Purchase orders",
        `select coalesce(p.po_number, concat('Draft purchase order #', p.id::text)) as title,
                concat_ws(' · ', p.order_date::text, p.total::text, c.name) as subtitle,
                initcap(p.status) as status,
                '/operations/purchase-orders/' || p.id::text as href
           from purchase_orders p
           join contacts c on c.id = p.contact_id
          where ${purchaseOrderWhere.sql}
          order by p.order_date desc, p.id desc
          limit ${PER_KIND}`,
        purchaseOrderWhere.params,
      ),
    );
  }

  if (include("banking")) {
    const customerPaymentWhere = whereParts(["coalesce(p.reference, '')", "c.name", "a.name", "a.code"], query, "p.amount", "p.payment_date");
    groups.push(
      await queryRecords(
        tx,
        "customer_payment",
        "Customer payments",
        `select coalesce(p.reference, concat('Payment #', p.id::text)) as title,
                concat_ws(' · ', p.payment_date::text, p.amount::text, c.name) as subtitle,
                initcap(p.status) as status,
                '/operations/customer-payments' as href
           from customer_payment_batches p
           join contacts c on c.id = p.contact_id
           join accounts a on a.id = p.bank_account_id
          where ${customerPaymentWhere.sql}
          order by p.payment_date desc, p.id desc
          limit ${PER_KIND}`,
        customerPaymentWhere.params,
      ),
    );
    const supplierPaymentWhere = whereParts(["coalesce(p.reference, '')", "c.name", "a.name", "a.code"], query, "p.amount", "p.payment_date");
    groups.push(
      await queryRecords(
        tx,
        "supplier_payment",
        "Supplier payments",
        `select coalesce(p.reference, concat('Payment #', p.id::text)) as title,
                concat_ws(' · ', p.payment_date::text, p.amount::text, c.name) as subtitle,
                initcap(p.status) as status,
                '/operations/supplier-payments' as href
           from supplier_payment_batches p
           join contacts c on c.id = p.contact_id
           join accounts a on a.id = p.bank_account_id
          where ${supplierPaymentWhere.sql}
          order by p.payment_date desc, p.id desc
          limit ${PER_KIND}`,
        supplierPaymentWhere.params,
      ),
    );
    const bankLineWhere = whereParts(["s.description", "coalesce(s.payee, '')", "coalesce(s.reference, '')", "a.name", "a.code"], query, "abs(s.amount)", "s.line_date");
    groups.push(
      await queryRecords(
        tx,
        "bank_statement_line",
        "Bank statement lines",
        `select s.description as title,
                concat_ws(' · ', s.line_date::text, abs(s.amount)::text, a.name) as subtitle,
                initcap(s.status) as status,
                '/operations/bank-accounts/' || s.account_id::text as href
           from bank_statement_lines s
           join accounts a on a.id = s.account_id
          where s.status <> 'deleted' and ${bankLineWhere.sql}
          order by s.line_date desc, s.id desc
          limit ${PER_KIND}`,
        bankLineWhere.params,
      ),
    );
  }

  if (include("accounts")) {
    const journalWhere = whereParts(["j.reference", "coalesce(j.description, '')"], query, "j.total_debit", "j.posting_date");
    groups.push(
      await queryRecords(
        tx,
        "journal",
        "Manual journals",
        `select j.reference as title,
                concat_ws(' · ', j.posting_date::text, j.total_debit::text, coalesce(j.description, 'Manual journal')) as subtitle,
                null::text as status,
                '/operations/ledger-journals' as href
           from ledger_journals j
          where j.origin in ('manual', 'correction') and ${journalWhere.sql}
          order by j.posting_date desc, j.id desc
          limit ${PER_KIND}`,
        journalWhere.params,
      ),
    );
    const itemWhere = whereParts(["i.code", "i.name", "coalesce(i.description, '')"], query, null, null);
    groups.push(
      await queryRecords(
        tx,
        "item",
        "Items",
        `select concat(i.code, ' · ', i.name) as title,
                coalesce(i.description, i.item_type) as subtitle,
                case when i.is_active then 'Active' else 'Archived' end as status,
                '/operations/items' as href
           from items i
          where ${itemWhere.sql}
          order by i.id desc
          limit ${PER_KIND}`,
        itemWhere.params,
      ),
    );
    const accountWhere = whereParts(["a.code", "a.name", "coalesce(a.description, '')"], query, null, null);
    groups.push(
      await queryRecords(
        tx,
        "account",
        "Accounts",
        `select concat(a.code, ' · ', a.name) as title,
                a.account_type as subtitle,
                case when a.is_active then 'Active' else 'Archived' end as status,
                '/operations/accounts' as href
           from accounts a
          where ${accountWhere.sql}
          order by a.id desc
          limit ${PER_KIND}`,
        accountWhere.params,
      ),
    );
    const fixedAssetWhere = whereParts(["f.asset_number", "f.name", "coalesce(f.description, '')"], query, "f.cost", "f.purchase_date");
    groups.push(
      await queryRecords(
        tx,
        "fixed_asset",
        "Fixed assets",
        `select concat(f.asset_number, ' · ', f.name) as title,
                concat_ws(' · ', f.purchase_date::text, f.cost::text) as subtitle,
                initcap(f.status) as status,
                '/operations/fixed-assets/' || f.id::text as href
           from fixed_assets f
          where ${fixedAssetWhere.sql}
          order by f.purchase_date desc, f.id desc
          limit ${PER_KIND}`,
        fixedAssetWhere.params,
      ),
    );
  }

  if (crmOn && include("crm")) {
    const companyWhere = whereParts(["c.name", "coalesce(c.email, '')", "coalesce(c.phone, '')"], query, null, null);
    groups.push(
      await queryRecords(
        tx,
        "crm_company",
        "CRM companies",
        `select c.name as title,
                concat_ws(' · ', c.email, c.phone) as subtitle,
                null::text as status,
                '/crm/companies/' || c.id::text as href
           from contacts c
          where not c.is_archived and ${companyWhere.sql}
          order by c.id desc
          limit ${PER_KIND}`,
        companyWhere.params,
      ),
    );
    const personWhere = whereParts(["p.first_name", "coalesce(p.last_name, '')", "coalesce(p.email, '')", "coalesce(p.phone, '')"], query, null, null);
    groups.push(
      await queryRecords(
        tx,
        "crm_person",
        "CRM people",
        `select concat_ws(' ', p.first_name, p.last_name) as title,
                concat_ws(' · ', c.name, p.email, p.phone) as subtitle,
                null::text as status,
                '/crm/people/' || p.id::text as href
           from crm_people p
           left join contacts c on c.id = p.contact_id
          where not p.is_archived and ${personWhere.sql}
          order by p.id desc
          limit ${PER_KIND}`,
        personWhere.params,
      ),
    );
    const opportunityWhere = whereParts(["o.name", "c.name"], query, "o.amount", "o.close_date");
    groups.push(
      await queryRecords(
        tx,
        "crm_opportunity",
        "CRM opportunities",
        `select o.name as title,
                concat_ws(' · ', c.name, coalesce(o.close_date::text, ''), o.amount::text) as subtitle,
                initcap(o.stage) as status,
                '/crm/opportunities/' || o.id::text as href
           from crm_opportunities o
           join contacts c on c.id = o.contact_id
          where ${opportunityWhere.sql}
          order by coalesce(o.close_date, '1900-01-01'::date) desc, o.id desc
          limit ${PER_KIND}`,
        opportunityWhere.params,
      ),
    );
  }

  return { query, filter, groups: groups.filter((group) => group.records.length > 0) };
}
