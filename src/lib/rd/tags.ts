import { writeAuditEvent } from "@/lib/audit";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { assertSameRequest, requestHash } from "@/lib/idempotency";
import { add, cmp, dec, parseDecimalInput, toFixedString, ZERO_DECIMAL } from "@/lib/money/decimal";
import {
  countedAmount,
  incomeYearOf,
  RD_CATEGORY_LABELS,
  RD_INELIGIBLE_REASON_CODES,
  RD_INELIGIBLE_REASONS,
  RD_LINE_CATEGORIES,
  rdShare,
  type RdIneligibleReason,
  type RdLineCategory,
  type RdPlace,
} from "@/lib/rd/amounts";
import { iso, loadHistory, rdSettings, requireUuid, timeliness, timeZone, writeHistory, yearLabel, type HistoryEntry, type RdSettings, type Timeliness } from "@/lib/rd/common";
import { listRdFiles, type RdFile } from "@/lib/rd/files";
import { approvedYearsFor, type RdActivityRef } from "@/lib/rd/register";
import { asRecord, optionalBoolean, optionalString, requireId, requireIdempotencyKey, requireOneOf, requireString } from "@/lib/validation";

/**
 * Tags (RD8, RD9, RD11-RD13; decisions 33, 41, 42, 47): a posted cost line
 * linked to an R&D activity with a share, a category (or an ineligible
 * reason) and the return's flags. A tag never changes an amount, an account
 * or a GST box and posts nothing. The R&D amount is always excluding GST and
 * in the base currency at the document's own rate (exchange gains and losses
 * are never tagged), rounded down to the cent. Lines on posted bills,
 * expense claims, spend money and manual journals can be tagged; a tag on a
 * document voided or reversed afterwards stays in history but drops out of
 * the totals.
 */

export const RD_SOURCE_TYPES = ["bill_line", "expense_claim_receipt", "bank_transaction_line", "journal_line"] as const;
export type RdSourceType = (typeof RD_SOURCE_TYPES)[number];
export const RD_DOCUMENT_TYPES = ["bill", "expense_claim", "bank_transaction", "journal"] as const;
export type RdDocumentType = (typeof RD_DOCUMENT_TYPES)[number];

const SOURCE_COLUMN: Record<RdSourceType, string> = {
  bill_line: "bill_line_id",
  expense_claim_receipt: "expense_claim_receipt_id",
  bank_transaction_line: "bank_transaction_line_id",
  journal_line: "journal_line_id",
};

/** System accounts whose lines are never R&D costs: GST (LY 1(6)), exchange gains and losses (decision 42), control accounts. */
const UNTAGGABLE_SYSTEM_KEYS = new Set([
  "bank",
  "accounts_receivable",
  "accounts_payable",
  "expense_claims_payable",
  "gst",
  "retained_earnings",
  "unrealised_fx_gain",
  "unrealised_fx_loss",
  "fixed_asset_disposal",
  "fixed_asset_capital_gain",
  "realised_fx",
  "fx_rounding",
  "conversion_clearing",
]);

/**
 * A manual journal, or a replacement in a correction chain that started from
 * a manual journal. A replacement of a journal posted by an expense claim or
 * another document isn't one: that document's own lines are tagged, so
 * tagging the replacement too would count the cost twice.
 */
const MANUAL_JOURNAL = `(j.origin = 'manual' or (j.origin = 'correction' and j.correction_kind = 'replacement' and (
    with recursive chain (origin, related_journal_id) as (
      select o.origin, o.related_journal_id from ledger_journals o where o.id = j.related_journal_id
      union all
      select p.origin, p.related_journal_id from chain join ledger_journals p on p.id = chain.related_journal_id where chain.origin = 'correction'
    )
    select origin from chain where origin <> 'correction' limit 1) = 'manual'))`;

/**
 * Every line that can be (or is) tagged, with its document. `amount` is the
 * base-currency amount excluding GST as posted to the line's account; a
 * journal line's is its debit (journals are in the base currency). `usable`
 * is false for drafts and voided or reversed documents.
 */
const SOURCES = `(
  select 'bill_line'::text as source_type, l.id as line_id, 'bill'::text as document_type, b.id as document_id,
         'Bill ' || coalesce(b.supplier_invoice_number, '#' || b.id) as document_label, c.name as contact_name, b.bill_date as posted_on,
         l.description, a.code as account_code, a.name as account_name, a.account_type, a.account_class, a.system_key,
         coalesce(l.base_net_amount, l.net_amount) as amount, b.currency_code, l.net_amount as document_amount, b.exchange_rate,
         b.status = 'approved' as usable, b.status as document_status
    from bill_lines l join bills b on b.id = l.bill_id join contacts c on c.id = b.contact_id join accounts a on a.id = l.account_id
  union all
  select 'expense_claim_receipt', r.id, 'expense_claim', x.id, 'Expense claim CLAIM-' || x.id, r.supplier_name, coalesce(x.claim_date, r.receipt_date),
         r.description, a.code, a.name, a.account_type, a.account_class, a.system_key,
         r.net_amount, null, r.net_amount, null,
         x.status = 'approved' and not exists (select 1 from ledger_journals rv where rv.related_journal_id = x.approval_journal_id and rv.correction_kind = 'reversal'),
         case when exists (select 1 from ledger_journals rv where rv.related_journal_id = x.approval_journal_id and rv.correction_kind = 'reversal')
              then 'reversed' else x.status end
    from expense_claim_receipts r join expense_claims x on x.id = r.claim_id join accounts a on a.id = r.account_id
  union all
  select 'bank_transaction_line', l.id, 'bank_transaction', t.id, 'Spend money' || coalesce(' ' || t.reference, ' #' || t.id), c.name, t.transaction_date,
         l.description, a.code, a.name, a.account_type, a.account_class, a.system_key,
         coalesce(l.base_net_amount, l.net_amount), t.currency_code, l.net_amount, t.exchange_rate,
         t.kind = 'spend' and t.status = 'posted', case when t.kind = 'spend' then t.status else 'receive money' end
    from bank_transaction_lines l join bank_transactions t on t.id = l.bank_transaction_id
    join contacts c on c.id = t.contact_id join accounts a on a.id = l.account_id
  union all
  select 'journal_line', l.id, 'journal', j.id, 'Journal #' || j.id || ' ' || j.reference, null, j.posting_date,
         coalesce(l.description, j.description, j.reference), a.code, a.name, a.account_type, a.account_class, a.system_key,
         l.debit_amount, null, l.debit_amount, null,
         ${MANUAL_JOURNAL} and not exists (select 1 from ledger_journals r where r.related_journal_id = j.id and r.correction_kind = 'reversal'),
         case when exists (select 1 from ledger_journals r where r.related_journal_id = j.id and r.correction_kind = 'reversal') then 'reversed'
              when ${MANUAL_JOURNAL} then 'posted'
              else 'not manual' end
    from ledger_journal_lines l join ledger_journals j on j.id = l.journal_id join accounts a on a.id = l.account_id
)`;

type SourceRow = {
  source_type: RdSourceType;
  line_id: string;
  document_type: RdDocumentType;
  document_id: string;
  document_label: string;
  contact_name: string | null;
  posted_on: string;
  description: string;
  account_code: string;
  account_name: string;
  account_type: string;
  account_class: string;
  system_key: string | null;
  amount: string;
  currency_code: string | null;
  document_amount: string;
  exchange_rate: string | null;
  usable: boolean;
  document_status: string;
};

const SOURCE_COLUMNS = `src.source_type, src.line_id::text, src.document_type, src.document_id::text, src.document_label, src.contact_name,
  src.posted_on::text, src.description, src.account_code, src.account_name, src.account_type, src.account_class, src.system_key,
  src.amount::text, src.currency_code, src.document_amount::text, src.exchange_rate::text, src.usable, src.document_status`;

/** Whether a line can be tagged, and whether only as ineligible. */
export type Taggability = { taggable: boolean; ineligibleOnly: boolean; reason: string | null };

export function taggability(row: Pick<SourceRow, "usable" | "account_type" | "account_class" | "system_key" | "amount" | "source_type" | "document_status" | "document_label">): Taggability {
  const no = (reason: string): Taggability => ({ taggable: false, ineligibleOnly: false, reason });
  if (!row.usable) {
    if (row.source_type === "journal_line") {
      return no(
        row.document_status === "reversed"
          ? `${row.document_label} has been reversed.`
          : "Only manual journals' lines are tagged here; tag the bill, expense claim or spend money it came from.",
      );
    }
    if (row.source_type === "bank_transaction_line") return no(row.document_status === "receive money" ? "Receive money isn't a cost." : "That spend money has been voided.");
    if (row.document_status === "reversed") return no(`${row.document_label}'s journal has been reversed in the ledger.`);
    return no(`${row.document_label} isn't approved, or has been voided.`);
  }
  if (cmp(dec(row.amount), ZERO_DECIMAL) <= 0) return no("Only debits (costs) are tagged; credits and refunds aren't.");
  if (row.system_key && UNTAGGABLE_SYSTEM_KEYS.has(row.system_key)) {
    return no(
      row.system_key === "gst"
        ? "GST is never part of an R&D amount (LY 1(6))."
        : ["realised_fx", "fx_rounding", "unrealised_fx_gain", "unrealised_fx_loss"].includes(row.system_key)
          ? "Exchange gains and losses aren't tagged; foreign lines count at the document's rate (decision 42)."
          : "Lines on that system account aren't costs.",
    );
  }
  if (row.account_type === "depreciation") {
    return no("Book depreciation isn't R&D tax depreciation: enter the asset's tax depreciation and usage log on the fixed asset instead (decision 33).");
  }
  if (row.account_class === "expense") return { taggable: true, ineligibleOnly: false, reason: null };
  if (row.account_class === "asset" && row.account_type !== "bank") {
    return { taggable: true, ineligibleOnly: true, reason: "Capital and other balance sheet costs can only be tagged as ineligible (e.g. acquiring depreciable property, Sch 21B B cl 2)." };
  }
  return no("Only cost lines (expense, direct cost and asset accounts) are tagged.");
}

export type RdTag = {
  id: string;
  sourceType: RdSourceType;
  lineId: string;
  documentType: RdDocumentType;
  documentId: string;
  documentLabel: string;
  documentStatus: string;
  contactName: string | null;
  description: string;
  accountCode: string;
  accountName: string;
  incomeYear: number;
  incomeYearLabel: string;
  lineAmount: string;
  currencyCode: string | null;
  documentAmount: string;
  exchangeRate: string | null;
  percentage: string;
  amount: string;
  /** What counts in its category: the share less goods not used by year end and the contractor's ineligible costs. 0 for ineligible tags. */
  countedAmount: string;
  eligibility: "eligible" | "ineligible";
  category: RdLineCategory | null;
  categoryLabel: string | null;
  ineligibleReason: RdIneligibleReason | null;
  ineligibleReasonLabel: string | null;
  ineligibleReasonSource: string | null;
  /** Overseas when flagged, or when the activity is performed overseas. */
  overseas: boolean;
  commercialProduction: boolean;
  internalSoftware: boolean;
  feedstock: boolean;
  contractorIneligibleAmount: string;
  unusedAmount: string;
  unusedMarkedAt: string | null;
  unusedMarkedByEmail: string | null;
  note: string | null;
  status: "active" | "removed";
  removedReason: string | null;
  removedAt: string | null;
  removedByEmail: string | null;
  /** The document was voided or reversed after it was tagged, so the tag isn't counted. */
  sourceVoided: boolean;
  activity: RdActivityRef & { place: RdPlace };
  version: number;
  createdAt: string;
  createdByEmail: string;
  updatedAt: string;
  updatedByEmail: string;
  timeliness: Timeliness;
  warnings: string[];
};

export type RdTagDetail = RdTag & { history: HistoryEntry[]; files: RdFile[] };

type TagRow = SourceRow & {
  id: string;
  activity_id: string;
  activity_code: string;
  activity_name: string;
  activity_kind: "core" | "supporting";
  activity_status: "active" | "archived";
  activity_place: RdPlace;
  activity_first_year: number;
  activity_last_year: number | null;
  work_date: string;
  line_amount: string;
  percentage: string;
  tag_amount: string;
  eligibility: "eligible" | "ineligible";
  category: RdLineCategory | null;
  ineligible_reason: RdIneligibleReason | null;
  overseas: boolean;
  commercial_production: boolean;
  internal_software: boolean;
  feedstock: boolean;
  contractor_ineligible_amount: string;
  unused_amount: string;
  unused_marked_at: Date | null;
  unused_marked_by_email: string | null;
  note: string | null;
  status: "active" | "removed";
  removed_reason: string | null;
  removed_at: Date | null;
  removed_by_email: string | null;
  version: number;
  created_at: Date;
  created_by_email: string;
  updated_at: Date;
  updated_by_email: string;
  entered_on: string;
  changed_on: string;
  request_hash: string;
};

const TAG_QUERY = `
  select ${SOURCE_COLUMNS}, t.id, t.activity_id, act.code as activity_code, act.name as activity_name, act.kind as activity_kind,
         act.status as activity_status, act.place as activity_place, act.first_income_year as activity_first_year,
         act.last_income_year as activity_last_year, t.work_date::text, t.line_amount::text, t.percentage::text, t.amount::text as tag_amount,
         t.eligibility, t.category, t.ineligible_reason, t.overseas, t.commercial_production, t.internal_software, t.feedstock,
         t.contractor_ineligible_amount::text, t.unused_amount::text, t.unused_marked_at, t.unused_marked_by_email, t.note, t.status,
         t.removed_reason, t.removed_at, t.removed_by_email, t.version, t.created_at, t.created_by_email, t.updated_at, t.updated_by_email,
         to_char((t.created_at at time zone $1)::date, 'YYYY-MM-DD') as entered_on,
         to_char((t.updated_at at time zone $1)::date, 'YYYY-MM-DD') as changed_on, t.request_hash
    from rd_tags t
    join rd_activities act on act.id = t.activity_id
    join ${SOURCES} src on src.source_type = t.source_type
     and src.line_id = coalesce(t.bill_line_id, t.expense_claim_receipt_id, t.bank_transaction_line_id, t.journal_line_id)`;

function toTag(row: TagRow, settings: RdSettings, approved: Map<string, Set<number>>): RdTag {
  const incomeYear = incomeYearOf(row.work_date, settings.yearEndMonth);
  const sourceVoided = !row.usable;
  const counted =
    row.eligibility === "eligible" && row.status === "active" && !sourceVoided
      ? countedAmount(row.tag_amount, row.unused_amount, row.contractor_ineligible_amount, settings.scale)
      : toFixedString(ZERO_DECIMAL, settings.scale);
  const when = timeliness(row.work_date, row.entered_on, row.version > 1 ? row.changed_on : null);
  const warnings: string[] = [];
  const label = yearLabel(settings, incomeYear);
  if (!approved.get(row.activity_id)?.has(incomeYear)) warnings.push(`No approval entered for ${label}.`);
  if (incomeYear < row.activity_first_year || (row.activity_last_year != null && incomeYear > row.activity_last_year)) {
    warnings.push(`${label} is outside ${row.activity_code}'s income years.`);
  }
  if (when.enteredLate) warnings.push(`Entered late: ${when.timelinessText}.`);
  if (sourceVoided && row.status === "active") warnings.push(`${row.document_label} has been ${row.document_status === "reversed" ? "reversed" : "voided"}, so this tag isn't counted.`);
  const reason = row.ineligible_reason ? RD_INELIGIBLE_REASONS[row.ineligible_reason] : null;
  return {
    id: row.id,
    sourceType: row.source_type,
    lineId: row.line_id,
    documentType: row.document_type,
    documentId: row.document_id,
    documentLabel: row.document_label,
    documentStatus: row.document_status,
    contactName: row.contact_name,
    description: row.description,
    accountCode: row.account_code,
    accountName: row.account_name,
    incomeYear,
    incomeYearLabel: label,
    lineAmount: toFixedString(dec(row.line_amount), settings.scale),
    currencyCode: row.currency_code,
    documentAmount: row.document_amount,
    exchangeRate: row.exchange_rate,
    percentage: toFixedString(dec(row.percentage), 2),
    amount: toFixedString(dec(row.tag_amount), settings.scale),
    countedAmount: counted,
    eligibility: row.eligibility,
    category: row.category,
    categoryLabel: row.category ? RD_CATEGORY_LABELS[row.category] : null,
    ineligibleReason: row.ineligible_reason,
    ineligibleReasonLabel: reason?.label ?? null,
    ineligibleReasonSource: reason?.source || null,
    overseas: row.overseas || row.activity_place === "overseas",
    commercialProduction: row.commercial_production,
    internalSoftware: row.internal_software,
    feedstock: row.feedstock,
    contractorIneligibleAmount: toFixedString(dec(row.contractor_ineligible_amount), settings.scale),
    unusedAmount: toFixedString(dec(row.unused_amount), settings.scale),
    unusedMarkedAt: row.unused_marked_at ? iso(row.unused_marked_at) : null,
    unusedMarkedByEmail: row.unused_marked_by_email,
    note: row.note,
    status: row.status,
    removedReason: row.removed_reason,
    removedAt: row.removed_at ? iso(row.removed_at) : null,
    removedByEmail: row.removed_by_email,
    sourceVoided,
    activity: { id: row.activity_id, code: row.activity_code, name: row.activity_name, kind: row.activity_kind, status: row.activity_status, place: row.activity_place },
    version: row.version,
    createdAt: iso(row.created_at),
    createdByEmail: row.created_by_email,
    updatedAt: iso(row.updated_at),
    updatedByEmail: row.updated_by_email,
    timeliness: when,
    warnings,
  };
}

/** Loads tags matching a condition on `t` (rd_tags), `src` or `act`; parameters start at $2. */
export async function loadTags(tx: OrgTx, where: string, params: unknown[], order = "src.posted_on, src.document_id, src.line_id, t.created_at"): Promise<RdTag[]> {
  const settings = await rdSettings(tx);
  const rows = (await tx.query<TagRow>(`${TAG_QUERY} where ${where} order by ${order}`, [timeZone(), ...params])).rows;
  const approved = await approvedYearsFor(tx, [...new Set(rows.map((row) => row.activity_id))]);
  return rows.map((row) => toTag(row, settings, approved));
}

export async function getTag(tx: OrgTx, idInput: unknown): Promise<RdTagDetail> {
  const id = requireUuid(idInput, "tagId");
  const tag = (await loadTags(tx, "t.id = $2", [id]))[0];
  if (!tag) throw new NotFoundError("R&D tag not found.");
  return { ...tag, history: await loadHistory(tx, "tag", id), files: await listRdFiles(tx, "tag", [id]) };
}

type TagFields = {
  activityId: string;
  percentage: string;
  eligibility: "eligible" | "ineligible";
  category: RdLineCategory | null;
  ineligibleReason: RdIneligibleReason | null;
  overseas: boolean;
  commercialProduction: boolean;
  internalSoftware: boolean;
  feedstock: boolean;
  contractorIneligibleAmount: string;
  unusedAmount: string;
  note: string | null;
};

function money(input: unknown, field: string, scale: number): string {
  if (input == null || input === "") return toFixedString(ZERO_DECIMAL, scale);
  return toFixedString(dec(parseDecimalInput(input, field, { maxScale: scale, allowZero: true })), scale);
}

function parseTagFields(body: Record<string, unknown>, scale: number): TagFields {
  const activityId = requireUuid(body.activityId, "activityId");
  const percentage = parseDecimalInput(body.percentage ?? "100", "percentage", { maxScale: 2 });
  if (cmp(dec(percentage), dec("100")) > 0) throw new ValidationError("The R&D share can be at most 100%.");
  const eligibility = requireOneOf(body.eligibility, "eligibility", ["eligible", "ineligible"] as const);
  const category = eligibility === "eligible" ? requireOneOf(body.category, "category", RD_LINE_CATEGORIES) : null;
  if (eligibility === "ineligible" && body.category != null && body.category !== "") throw new ValidationError("An ineligible tag has a reason, not a category.");
  const ineligibleReason = eligibility === "ineligible" ? requireOneOf(body.ineligibleReason, "ineligibleReason", RD_INELIGIBLE_REASON_CODES) : null;
  if (eligibility === "eligible" && body.ineligibleReason != null && body.ineligibleReason !== "") throw new ValidationError("An eligible tag has a category, not an ineligible reason.");
  const note = optionalString(body.note, "note", { maxLength: 2000 });
  if (ineligibleReason === "other" && !note) throw new ValidationError("Say why it's ineligible in the note.");
  const contractorIneligibleAmount = money(body.contractorIneligibleAmount, "contractorIneligibleAmount", scale);
  const unusedAmount = money(body.unusedAmount, "unusedAmount", scale);
  if (cmp(dec(contractorIneligibleAmount), ZERO_DECIMAL) > 0 && category !== "contract" && category !== "approved_research_provider") {
    throw new ValidationError("The contractor's own ineligible costs apply only to contract and approved research provider expenditure (LY 6).");
  }
  if (eligibility === "ineligible" && cmp(dec(unusedAmount), ZERO_DECIMAL) > 0) throw new ValidationError("Only an eligible tag has an amount not used by year end.");
  return {
    activityId,
    percentage: toFixedString(dec(percentage), 2),
    eligibility,
    category,
    ineligibleReason,
    overseas: optionalBoolean(body.overseas, "overseas") ?? false,
    commercialProduction: optionalBoolean(body.commercialProduction, "commercialProduction") ?? false,
    internalSoftware: optionalBoolean(body.internalSoftware, "internalSoftware") ?? false,
    feedstock: optionalBoolean(body.feedstock, "feedstock") ?? false,
    contractorIneligibleAmount,
    unusedAmount,
    note,
  };
}

async function requireTaggableActivity(tx: OrgTx, activityId: string): Promise<{ code: string; place: RdPlace }> {
  const activity = (await tx.query<{ code: string; status: string; place: RdPlace }>("select code, status, place from rd_activities where id = $1 for share", [activityId])).rows[0];
  if (!activity) throw new ValidationError("That R&D activity doesn't exist.");
  if (activity.status !== "active") throw new ValidationError(`${activity.code} is archived, so it can't be tagged.`);
  return activity;
}

/** The share and checks that depend on the line's amount. */
function share(fields: TagFields, lineAmount: string, scale: number, ineligibleOnly: boolean): string {
  if (ineligibleOnly && fields.eligibility === "eligible") {
    throw new ValidationError("That line is on a balance sheet account, so it can only be tagged as ineligible (e.g. acquiring depreciable property).");
  }
  const amount = rdShare(lineAmount, fields.percentage, scale);
  if (cmp(dec(amount), ZERO_DECIMAL) <= 0) throw new ValidationError("That share is less than a cent of the line.");
  if (cmp(add(dec(fields.unusedAmount), dec(fields.contractorIneligibleAmount)), dec(amount)) > 0) {
    throw new ValidationError(`The amounts not used by year end and the contractor's ineligible costs can't be more than the R&D share (${amount}).`);
  }
  return amount;
}

function fieldsSnapshot(fields: TagFields, amount: string): Record<string, unknown> {
  return { ...fields, amount };
}

/**
 * Tags a posted line to an activity (bookkeepers and above). Allowed before
 * an approval is entered, with a warning (decision 47). One active tag per
 * line.
 */
export async function createTag(tx: OrgTx, bodyInput: unknown): Promise<{ created: boolean; tag: RdTagDetail }> {
  const body = asRecord(bodyInput, "body");
  const settings = await rdSettings(tx);
  const idempotencyKey = requireIdempotencyKey(body.idempotencyKey);
  const sourceType = requireOneOf(body.sourceType, "sourceType", RD_SOURCE_TYPES);
  const lineId = requireId(body.lineId, "lineId");
  const fields = parseTagFields(body, settings.scale);
  const hash = requestHash("rd_tag", { sourceType, lineId, ...fields });
  const existing = (await tx.query<{ id: string; request_hash: string }>("select id, request_hash from rd_tags where idempotency_key = $1", [idempotencyKey])).rows[0];
  if (existing) {
    assertSameRequest(existing.request_hash, hash, "R&D tag");
    return { created: false, tag: await getTag(tx, existing.id) };
  }
  const line = (await tx.query<SourceRow>(`select ${SOURCE_COLUMNS} from ${SOURCES} src where src.source_type = $1 and src.line_id = $2`, [sourceType, lineId])).rows[0];
  if (!line) throw new NotFoundError("There's no such line.");
  const allowed = taggability(line);
  if (!allowed.taggable) throw new ValidationError(allowed.reason ?? "That line can't be tagged.");
  const activity = await requireTaggableActivity(tx, fields.activityId);
  const amount = share(fields, line.amount, settings.scale, allowed.ineligibleOnly);
  // Every cost of an overseas activity is overseas (LY 7; IR1240 p 69-70).
  const overseas = fields.overseas || activity.place === "overseas";
  const unused = cmp(dec(fields.unusedAmount), ZERO_DECIMAL) > 0;
  let id: string;
  try {
    await tx.query("savepoint rd_tag_insert");
    id = (
      await tx.query<{ id: string }>(
        `insert into rd_tags (idempotency_key, request_hash, source_type, ${SOURCE_COLUMN[sourceType]}, activity_id, work_date, line_amount, percentage, amount,
                              eligibility, category, ineligible_reason, overseas, commercial_production, internal_software, feedstock,
                              contractor_ineligible_amount, unused_amount, unused_marked_by_user_id, unused_marked_by_email, unused_marked_at, note,
                              created_by_user_id, created_by_email, updated_by_user_id, updated_by_email)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18,
                 case when $19 then $20::uuid end, case when $19 then $21 end, case when $19 then now() end, $22, $20, $21, $20, $21)
         returning id`,
        [
          idempotencyKey,
          hash,
          sourceType,
          lineId,
          fields.activityId,
          line.posted_on,
          line.amount,
          fields.percentage,
          amount,
          fields.eligibility,
          fields.category,
          fields.ineligibleReason,
          overseas,
          fields.commercialProduction,
          fields.internalSoftware,
          fields.feedstock,
          fields.contractorIneligibleAmount,
          fields.unusedAmount,
          unused,
          tx.actor.userId,
          tx.actor.email,
          fields.note,
        ],
      )
    ).rows[0].id;
    await tx.query("release savepoint rd_tag_insert");
  } catch (error) {
    if ((error as { code?: string }).code === "23505" && String((error as { constraint?: string }).constraint).startsWith("rd_tags_")) {
      await tx.query("rollback to savepoint rd_tag_insert");
      throw new ConflictError("That line is already tagged to an R&D activity. Change or remove its tag instead.");
    }
    throw error;
  }
  await writeHistory(tx, "tag", id, "created", { sourceType, lineId, workDate: line.posted_on, lineAmount: line.amount, ...fieldsSnapshot({ ...fields, overseas }, amount) });
  await writeAuditEvent(tx, { eventType: "rd.tag_created", entityType: "rd_tag", entityId: id, details: { sourceType, lineId, activity: activity.code, amount } });
  return { created: true, tag: await getTag(tx, id) };
}

async function lockTag(tx: OrgTx, id: string) {
  const row = (
    await tx.query<{
      status: string;
      version: number;
      source_type: RdSourceType;
      line_id: string;
      line_amount: string;
      unused_amount: string;
      activity_id: string;
      percentage: string;
      eligibility: "eligible" | "ineligible";
      category: RdLineCategory | null;
      ineligible_reason: RdIneligibleReason | null;
      overseas: boolean;
      commercial_production: boolean;
      internal_software: boolean;
      feedstock: boolean;
      contractor_ineligible_amount: string;
      note: string | null;
    }>(
      `select status, version, source_type, coalesce(bill_line_id, expense_claim_receipt_id, bank_transaction_line_id, journal_line_id)::text as line_id,
              line_amount::text, unused_amount::text, activity_id, percentage::text, eligibility, category, ineligible_reason, overseas,
              commercial_production, internal_software, feedstock, contractor_ineligible_amount::text, note
         from rd_tags where id = $1 for update`,
      [id],
    )
  ).rows[0];
  if (!row) throw new NotFoundError("R&D tag not found.");
  return row;
}

/**
 * Changes a tag (bookkeepers and above): its activity, share, category or
 * reason, flags, amounts not used by year end (stamped with who and when,
 * decision 41) or the contractor's ineligible costs. The old version stays
 * in its history, and the tag shows how long after it was entered it was
 * changed (RD23).
 */
export async function updateTag(tx: OrgTx, idInput: unknown, bodyInput: unknown): Promise<RdTagDetail> {
  const id = requireUuid(idInput, "tagId");
  const body = asRecord(bodyInput, "body");
  const settings = await rdSettings(tx);
  const current = await lockTag(tx, id);
  if (body.version != null && Number(body.version) !== current.version) {
    throw new ConflictError("Someone else changed this tag since you opened it. Reload it and make your change again.");
  }
  if (current.status !== "active") throw new ValidationError("That tag has been removed.");
  const before: TagFields = {
    activityId: current.activity_id,
    percentage: toFixedString(dec(current.percentage), 2),
    eligibility: current.eligibility,
    category: current.category,
    ineligibleReason: current.ineligible_reason,
    overseas: current.overseas,
    commercialProduction: current.commercial_production,
    internalSoftware: current.internal_software,
    feedstock: current.feedstock,
    contractorIneligibleAmount: toFixedString(dec(current.contractor_ineligible_amount), settings.scale),
    unusedAmount: toFixedString(dec(current.unused_amount), settings.scale),
    note: current.note,
  };
  const merged = { ...before, ...body };
  // Switching between eligible and ineligible clears the other side's field unless it's sent.
  if (body.eligibility === "ineligible" && body.category === undefined) merged.category = null;
  if (body.eligibility === "eligible" && body.ineligibleReason === undefined) merged.ineligibleReason = null;
  if (body.eligibility === "ineligible") {
    if (body.unusedAmount === undefined) merged.unusedAmount = "0";
    if (body.contractorIneligibleAmount === undefined) merged.contractorIneligibleAmount = "0";
  }
  const fields = parseTagFields(merged, settings.scale);
  const line = (await tx.query<SourceRow>(`select ${SOURCE_COLUMNS} from ${SOURCES} src where src.source_type = $1 and src.line_id = $2`, [current.source_type, current.line_id])).rows[0];
  const allowed = taggability(line);
  if (!allowed.taggable) throw new ValidationError(`${allowed.reason ?? "That line can't be tagged."} Remove the tag instead.`);
  const activity = fields.activityId === before.activityId ? (await tx.query<{ code: string; place: RdPlace }>("select code, place from rd_activities where id = $1", [fields.activityId])).rows[0] : await requireTaggableActivity(tx, fields.activityId);
  const amount = share(fields, current.line_amount, settings.scale, allowed.ineligibleOnly);
  const overseas = fields.overseas || activity.place === "overseas";
  const after = { ...fields, overseas };
  const changed = (Object.keys(after) as (keyof TagFields)[]).filter((key) => JSON.stringify(after[key]) !== JSON.stringify(before[key]));
  if (changed.length === 0) return getTag(tx, id);
  const unusedChanged = changed.includes("unusedAmount");
  const unused = cmp(dec(fields.unusedAmount), ZERO_DECIMAL) > 0;
  await tx.query(
    `update rd_tags
        set activity_id = $2, percentage = $3, amount = $4, eligibility = $5, category = $6, ineligible_reason = $7, overseas = $8,
            commercial_production = $9, internal_software = $10, feedstock = $11, contractor_ineligible_amount = $12, unused_amount = $13,
            unused_marked_by_user_id = case when not $14 then unused_marked_by_user_id when $15 then $16::uuid end,
            unused_marked_by_email = case when not $14 then unused_marked_by_email when $15 then $17 end,
            unused_marked_at = case when not $14 then unused_marked_at when $15 then now() end,
            note = $18, version = version + 1, updated_by_user_id = $16, updated_by_email = $17
      where id = $1`,
    [
      id,
      fields.activityId,
      fields.percentage,
      amount,
      fields.eligibility,
      fields.category,
      fields.ineligibleReason,
      overseas,
      fields.commercialProduction,
      fields.internalSoftware,
      fields.feedstock,
      fields.contractorIneligibleAmount,
      fields.unusedAmount,
      unusedChanged,
      unused,
      tx.actor.userId,
      tx.actor.email,
      fields.note,
    ],
  );
  await writeHistory(tx, "tag", id, "changed", { ...fieldsSnapshot(after, amount), changed });
  await writeAuditEvent(tx, { eventType: "rd.tag_changed", entityType: "rd_tag", entityId: id, details: { changed, amount } });
  return getTag(tx, id);
}

/** Removes a tag (bookkeepers and above). It stays in history, with the reason, and drops out of the totals. */
export async function removeTag(tx: OrgTx, idInput: unknown, reasonInput: unknown): Promise<RdTagDetail> {
  const id = requireUuid(idInput, "tagId");
  const reason = requireString(reasonInput, "reason", { maxLength: 500 });
  const current = await lockTag(tx, id);
  if (current.status !== "active") throw new ValidationError("That tag has already been removed.");
  await tx.query(
    `update rd_tags set status = 'removed', removed_reason = $2, removed_at = now(), removed_by_user_id = $3, removed_by_email = $4,
            version = version + 1, updated_by_user_id = $3, updated_by_email = $4 where id = $1`,
    [id, reason, tx.actor.userId, tx.actor.email],
  );
  await writeHistory(tx, "tag", id, "removed", { reason });
  await writeAuditEvent(tx, { eventType: "rd.tag_removed", entityType: "rd_tag", entityId: id, details: { reason } });
  return getTag(tx, id);
}

export type RdLine = {
  sourceType: RdSourceType;
  lineId: string;
  documentLabel: string;
  postedOn: string;
  description: string;
  accountCode: string;
  accountName: string;
  /** Base currency, excluding GST. */
  amount: string;
  currencyCode: string | null;
  documentAmount: string;
  exchangeRate: string | null;
} & Taggability & { tag: RdTag | null };

function toLine(row: SourceRow, tag: RdTag | null, scale: number): RdLine {
  return {
    sourceType: row.source_type,
    lineId: row.line_id,
    documentLabel: row.document_label,
    postedOn: row.posted_on,
    description: row.description,
    accountCode: row.account_code,
    accountName: row.account_name,
    amount: toFixedString(dec(row.amount), scale),
    currencyCode: row.currency_code,
    documentAmount: row.document_amount,
    exchangeRate: row.exchange_rate,
    ...taggability(row),
    tag,
  };
}

/**
 * A document's lines with their tags, for the tag picker on a bill, expense
 * claim, spend money or journal (viewers and above). A journal posted by a
 * bill, expense claim or spend money shows that document's lines, so spend
 * money can be tagged from its journal.
 */
export async function listDocumentLines(tx: OrgTx, documentTypeInput: unknown, documentIdInput: unknown): Promise<{ documentType: RdDocumentType; documentId: string; lines: RdLine[] }> {
  let documentType = requireOneOf(documentTypeInput, "documentType", RD_DOCUMENT_TYPES);
  let documentId = requireId(documentIdInput, "documentId");
  if (documentType === "journal") {
    const posted = (
      await tx.query<{ document_type: RdDocumentType; id: string }>(
        `select 'bill' as document_type, id::text from bills where approval_journal_id = $1
         union all select 'expense_claim', id::text from expense_claims where approval_journal_id = $1
         union all select 'bank_transaction', id::text from bank_transactions where journal_id = $1`,
        [documentId],
      )
    ).rows[0];
    if (posted) {
      documentType = posted.document_type;
      documentId = posted.id;
    }
  }
  const settings = await rdSettings(tx);
  const rows = (
    await tx.query<SourceRow>(`select ${SOURCE_COLUMNS} from ${SOURCES} src where src.document_type = $1 and src.document_id = $2 order by src.line_id`, [
      documentType,
      documentId,
    ])
  ).rows;
  const sourceType = rows[0]?.source_type;
  const tags = sourceType
    ? await loadTags(tx, `t.status = 'active' and t.source_type = $2 and src.line_id = any($3::bigint[])`, [sourceType, rows.map((row) => row.line_id)])
    : [];
  return { documentType, documentId, lines: rows.map((row) => toLine(row, tags.find((tag) => tag.lineId === row.line_id) ?? null, settings.scale)) };
}

/**
 * Posted cost lines not yet tagged, newest first, for tagging from the R&D
 * screens (anyone in the organisation reads; bookkeepers tag). Spend money
 * is tagged from here or from its journal.
 */
export async function listUntaggedLines(tx: OrgTx, filters: { search?: unknown; from?: unknown; to?: unknown } = {}): Promise<RdLine[]> {
  const settings = await rdSettings(tx);
  const search = optionalString(filters.search, "search", { maxLength: 100 })?.replace(/[\\%_]/g, "\\$&") ?? null;
  const from = filters.from ? requireString(filters.from, "from", { pattern: /^\d{4}-\d{2}-\d{2}$/, patternHint: "from must be YYYY-MM-DD." }) : null;
  const to = filters.to ? requireString(filters.to, "to", { pattern: /^\d{4}-\d{2}-\d{2}$/, patternHint: "to must be YYYY-MM-DD." }) : null;
  const rows = (
    await tx.query<SourceRow>(
      `select ${SOURCE_COLUMNS} from ${SOURCES} src
        where src.usable and src.amount > 0 and src.account_class in ('expense', 'asset') and src.account_type not in ('depreciation', 'bank')
          and (src.system_key is null or not (src.system_key = any($4::text[])))
          and ($2::date is null or src.posted_on >= $2::date) and ($3::date is null or src.posted_on <= $3::date)
          and not exists (select 1 from rd_tags t where t.status = 'active' and t.source_type = src.source_type
                            and coalesce(t.bill_line_id, t.expense_claim_receipt_id, t.bank_transaction_line_id, t.journal_line_id) = src.line_id)
          and ($1::text is null or src.description ilike '%' || $1 || '%' or src.contact_name ilike '%' || $1 || '%'
               or src.document_label ilike '%' || $1 || '%' or src.account_code ilike $1 || '%' or src.account_name ilike '%' || $1 || '%')
        order by src.posted_on desc, src.document_id desc, src.line_id
        limit 200`,
      [search, from, to, [...UNTAGGABLE_SYSTEM_KEYS]],
    )
  ).rows;
  return rows.map((row) => toLine(row, null, settings.scale));
}
