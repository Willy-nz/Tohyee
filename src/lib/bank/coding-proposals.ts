import { writeAuditEvent } from "@/lib/audit";
import { parseAccountCodeInput } from "@/lib/accounts/service";
import { GST_EVIDENCE } from "@/lib/ai/gst-evidence";
import { getStatementLine } from "@/lib/bank/accounts";
import { lineErrorText } from "@/lib/bank/bulk";
import {
  gstProblem,
  isOpen,
  matchesFilter,
  PROPOSAL_FILTERS,
  type ProposalFilter,
  type ProposalRowState,
  proposalTotals,
  type ProposalTotals,
  type RowProblem,
  rowState,
  staleReasons,
} from "@/lib/bank/coding-proposal-words";
import { reconcileStatementLine } from "@/lib/bank/reconcile";
import { type ActionWork, createBatch, runBatch, type RunOptions, type RunOutcome } from "@/lib/batches/service";
import type { OrgRunner, OrgTx } from "@/lib/db/org-transaction";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { requestHash, assertSameRequest } from "@/lib/idempotency";
import { getPeriodControls } from "@/lib/ledger/period-controls";
import { cmp, dec, isDecimalString, toFixedString, toPlainString } from "@/lib/money/decimal";
import { getGstRegistration, gstStatusOn, type GstRegistration } from "@/lib/tax/registration";
import { asRecord, optionalString, requireArray, requireId, requireIdempotencyKey, requireOneOf, requireString } from "@/lib/validation";

/**
 * Bank coding proposals (#544, decisions 1292-1299, examples BCP1-BCP8).
 *
 * A proposal is coding for some of one bank account's unreconciled
 * statement lines (contact, account, GST code, amount, why, how sure, and
 * what supports the GST), kept for a person to review. Making one posts
 * nothing and reconciles nothing. A person edits, rejects or approves rows;
 * approving runs through a durable batch (kind bank_coding, #547), so each
 * approved row is posted exactly once, as cash coding posts it (BK22: spend
 * or receive money for the line's full amount, GST inclusive with a GST
 * code, reconciled to the line), and a stopped approval can be resumed
 * from the Batches tab.
 *
 * Everything is checked again when a row is approved and again when it's
 * posted: the line is still unreconciled and unchanged (otherwise the row is
 * stale and left as it is), its date isn't locked, and its GST treatment
 * still holds (GST registration confirmed, and something supports the GST
 * code). Only a person approves: not an AI.
 */

/** At most this many rows in one proposal, or in one approval. */
export const MAX_PROPOSAL_ROWS = 100;
/** Approval keys get ":<row id>" added for each row's posting, and those must stay within 120 characters. */
const APPROVAL_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,80}$/;

export type ProposalRow = {
  id: string;
  position: number;
  lineId: string;
  /** The statement line as it is now. */
  line: { date: string; amount: string; description: string; payee: string | null; status: string };
  contactId: string;
  contactName: string | null;
  accountCode: string;
  accountName: string | null;
  taxCode: string | null;
  taxLabel: string | null;
  description: string;
  /** Without a sign; the line's amount. */
  amount: string;
  rationale: string | null;
  confidence: string | null;
  gstEvidence: string | null;
  evidence: string | null;
  /** The coding as first proposed (kept after an edit). */
  original: Record<string, unknown>;
  state: ProposalRowState;
  version: number;
  /** Nobody has edited, approved or rejected it yet. */
  reviewed: boolean;
  editedByEmail: string | null;
  editedAt: string | null;
  reviewedByEmail: string | null;
  reviewedAt: string | null;
  rejectReason: string | null;
  /** Filled in by the API routes (addPersonNames): the people's names beside their emails. */
  editedByName?: string;
  reviewedByName?: string;
  approvalBatchId: string | null;
  /** Why posting it failed. */
  error: string | null;
  postedReconciliationId: string | null;
  /** Why it can't be approved as it is (open rows only). */
  problems: RowProblem[];
  stale: boolean;
};

export type ProposalCounts = Record<ProposalRowState, number> & { total: number };

export type ProposalSummary = {
  id: string;
  accountId: string;
  accountCode: string;
  accountName: string;
  note: string | null;
  createdAt: string;
  createdByEmail: string | null;
  createdVia: string | null;
  /** Made by an AI (it says nothing about review). */
  aiDrafted: boolean;
  counts: ProposalCounts;
};

export type Proposal = ProposalSummary & {
  refused: Array<{ index: number; lineId: string | null; reason: string }>;
  rows: ProposalRow[];
  totals: ProposalTotals;
  /** The filter the rows were picked with. */
  filter: ProposalFilter;
};

type RowRecord = {
  id: string;
  proposal_id: string;
  position: number;
  statement_line_id: string;
  seen_line_date: string;
  seen_amount: string;
  seen_reconciliations: number;
  contact_id: string;
  contact_name: string | null;
  account_code: string;
  account_name: string | null;
  tax_code: string | null;
  tax_label: string | null;
  tax_category: string | null;
  description: string;
  amount: string;
  rationale: string | null;
  confidence: string | null;
  gst_evidence: string | null;
  evidence: string | null;
  original: Record<string, unknown>;
  status: "proposed" | "rejected" | "approved";
  version: number;
  edited_by_email: string | null;
  edited_at: string | null;
  reviewed_by_email: string | null;
  reviewed_at: string | null;
  reject_reason: string | null;
  approval_action_id: string | null;
  approval_batch_id: string | null;
  action_status: string | null;
  action_error: string | null;
  posted_reconciliation_id: string | null;
  line_date: string;
  line_amount: string;
  line_description: string;
  line_payee: string | null;
  line_status: string;
  line_reconciliations: number;
};

const ROW_SELECT = `
  select r.id::text, r.proposal_id::text, r.position, r.statement_line_id::text, r.seen_line_date::text, r.seen_amount::text,
         r.seen_reconciliations, r.contact_id::text, c.name as contact_name, r.account_code, a.name as account_name, r.tax_code,
         t.label as tax_label, t.category as tax_category, r.description, r.amount::text, r.rationale, r.confidence::text,
         r.gst_evidence, r.evidence, r.original, r.status, r.version, r.edited_by_email, r.edited_at::text, r.reviewed_by_email,
         r.reviewed_at::text, r.reject_reason, r.approval_action_id::text, ba.batch_id::text as approval_batch_id,
         ba.status as action_status, ba.error as action_error, r.posted_reconciliation_id::text,
         l.line_date::text, l.amount::text as line_amount, l.description as line_description, l.payee as line_payee, l.status as line_status,
         (select count(*)::int from bank_reconciliations br where br.statement_line_id = l.id) as line_reconciliations
    from bank_coding_proposal_rows r
    join bank_statement_lines l on l.id = r.statement_line_id
    left join contacts c on c.id = r.contact_id
    left join accounts a on lower(a.code) = lower(r.account_code)
    left join lateral (select tc.label, tc.category from tax_codes tc where tc.code = r.tax_code order by tc.is_active desc, tc.effective_from desc limit 1) t on true
    left join batch_actions ba on ba.id = r.approval_action_id`;

type Checks = { lockDate: string | null; registration: GstRegistration };

async function loadChecks(tx: OrgTx): Promise<Checks> {
  return { lockDate: (await getPeriodControls(tx)).lockDate, registration: await getGstRegistration(tx) };
}

/** Why an open row can't be approved as it is: stale, locked, or its GST doesn't hold. */
function problemsFor(row: RowRecord, checks: Checks): RowProblem[] {
  const problems: RowProblem[] = staleReasons(
    { date: row.seen_line_date, amount: row.seen_amount, reconciliations: row.seen_reconciliations },
    { status: row.line_status, date: row.line_date, amount: row.line_amount, reconciliations: row.line_reconciliations },
  ).map((text) => ({ kind: "stale" as const, text }));
  if (checks.lockDate && row.line_date <= checks.lockDate) {
    problems.push({ kind: "locked", text: `The line's date is in a locked period (locked up to ${checks.lockDate}).` });
  }
  // An unknown tax code counts as GST, so it isn't waved through (posting refuses it anyway).
  const category = row.tax_code === null ? null : (row.tax_category ?? "standard");
  const gst = gstProblem(gstStatusOn(checks.registration, row.line_date), row.gst_evidence, category);
  if (gst) problems.push({ kind: "gst", text: gst });
  return problems;
}

function toRow(row: RowRecord, checks: Checks): ProposalRow {
  const state = rowState(row.status, row.action_status);
  const problems = isOpen(state) ? problemsFor(row, checks) : [];
  return {
    id: row.id,
    position: row.position,
    lineId: row.statement_line_id,
    line: { date: row.line_date, amount: toFixedString(dec(row.line_amount), 2), description: row.line_description, payee: row.line_payee, status: row.line_status },
    contactId: row.contact_id,
    contactName: row.contact_name,
    accountCode: row.account_code,
    accountName: row.account_name,
    taxCode: row.tax_code,
    taxLabel: row.tax_label,
    description: row.description,
    amount: toFixedString(dec(row.amount), 2),
    rationale: row.rationale,
    confidence: row.confidence,
    gstEvidence: row.gst_evidence,
    evidence: row.evidence,
    original: row.original,
    state,
    version: row.version,
    reviewed: row.edited_at !== null || row.reviewed_at !== null,
    editedByEmail: row.edited_by_email,
    editedAt: row.edited_at,
    reviewedByEmail: row.reviewed_by_email,
    reviewedAt: row.reviewed_at,
    rejectReason: row.reject_reason,
    approvalBatchId: row.approval_batch_id,
    error: state === "failed" ? row.action_error : null,
    postedReconciliationId: row.posted_reconciliation_id,
    problems,
    stale: problems.some((problem) => problem.kind === "stale"),
  };
}

type ProposalRecord = {
  id: string;
  account_id: string;
  account_code: string;
  account_name: string;
  note: string | null;
  refused: Proposal["refused"];
  created_at: string;
  created_by_email: string | null;
  created_via: string | null;
};

const PROPOSAL_SELECT = `
  select p.id::text, p.account_id::text, a.code as account_code, a.name as account_name, p.note, p.refused, p.created_at::text,
         p.created_by_email, p.created_via
    from bank_coding_proposals p join accounts a on a.id = p.account_id`;

function emptyCounts(): ProposalCounts {
  return { proposed: 0, approved: 0, posted: 0, failed: 0, rejected: 0, total: 0 };
}

function summaryFrom(record: ProposalRecord, counts: ProposalCounts): ProposalSummary {
  return {
    id: record.id,
    accountId: record.account_id,
    accountCode: record.account_code,
    accountName: record.account_name,
    note: record.note,
    createdAt: record.created_at,
    createdByEmail: record.created_by_email,
    createdVia: record.created_via,
    aiDrafted: record.created_via !== null,
    counts,
  };
}

async function countsFor(tx: OrgTx, proposalIds: readonly string[]): Promise<Map<string, ProposalCounts>> {
  const rows = await tx.query<{ proposal_id: string; status: "proposed" | "rejected" | "approved"; action_status: string | null; n: number }>(
    `select r.proposal_id::text, r.status, ba.status as action_status, count(*)::int as n
       from bank_coding_proposal_rows r left join batch_actions ba on ba.id = r.approval_action_id
      where r.proposal_id = any($1::bigint[])
      group by r.proposal_id, r.status, ba.status`,
    [proposalIds],
  );
  const counts = new Map<string, ProposalCounts>();
  for (const row of rows.rows) {
    const entry = counts.get(row.proposal_id) ?? emptyCounts();
    entry[rowState(row.status, row.action_status)] += row.n;
    entry.total += row.n;
    counts.set(row.proposal_id, entry);
  }
  return counts;
}

/** One proposal with its rows (only those the filter picks), totals over all its rows, and each open row's problems. */
export async function getProposal(tx: OrgTx, proposalIdInput: unknown, options: { filter?: unknown } = {}): Promise<Proposal> {
  const proposalId = requireId(proposalIdInput, "proposalId");
  const filter: ProposalFilter =
    options.filter === undefined || options.filter === null || options.filter === "" ? "all" : requireOneOf(options.filter, "filter", PROPOSAL_FILTERS);
  const record = (await tx.query<ProposalRecord>(`${PROPOSAL_SELECT} where p.id = $1`, [proposalId])).rows[0];
  if (!record) throw new NotFoundError("Proposal not found.");
  const checks = await loadChecks(tx);
  const all = (await tx.query<RowRecord>(`${ROW_SELECT} where r.proposal_id = $1 order by r.position`, [proposalId])).rows.map((row) => toRow(row, checks));
  const counts = emptyCounts();
  for (const row of all) {
    counts[row.state] += 1;
    counts.total += 1;
  }
  return {
    ...summaryFrom(record, counts),
    refused: record.refused ?? [],
    rows: all.filter((row) => matchesFilter(row, filter)),
    totals: proposalTotals(all.map((row) => ({ ...row, lineAmount: row.line.amount }))),
    filter,
  };
}

/** The newest proposals, optionally for one bank account, with their counts by state. */
export async function listProposals(tx: OrgTx, options: { accountId?: unknown; limit?: number; offset?: number } = {}): Promise<ProposalSummary[]> {
  const accountId = options.accountId === undefined || options.accountId === null || options.accountId === "" ? null : requireId(options.accountId, "accountId");
  const records = (
    await tx.query<ProposalRecord>(`${PROPOSAL_SELECT} where ($1::bigint is null or p.account_id = $1) order by p.created_at desc, p.id desc limit $2 offset $3`, [
      accountId,
      Math.min(Math.max(options.limit ?? 50, 1), 201),
      Math.max(options.offset ?? 0, 0),
    ])
  ).rows;
  const counts = await countsFor(
    tx,
    records.map((record) => record.id),
  );
  return records.map((record) => summaryFrom(record, counts.get(record.id) ?? emptyCounts()));
}

// ---------------------------------------------------------------------------
// Proposing
// ---------------------------------------------------------------------------

type CodingFields = { contactId: string; accountCode: string; taxCode: string | null; description: string | null };

/** Checks a contact, account and tax code exist and are in use. */
async function checkCoding(tx: OrgTx, fields: CodingFields): Promise<void> {
  const contact = (await tx.query<{ is_archived: boolean }>("select is_archived from contacts where id = $1", [fields.contactId])).rows[0];
  if (!contact) throw new ValidationError(`Contact ${fields.contactId} wasn't found.`);
  if (contact.is_archived) throw new ValidationError("That contact is archived.");
  const account = (await tx.query<{ is_active: boolean; account_type: string }>("select is_active, account_type from accounts where lower(code) = lower($1)", [fields.accountCode])).rows[0];
  if (!account) throw new ValidationError(`There's no account ${fields.accountCode}.`);
  if (!account.is_active) throw new ValidationError(`Account ${fields.accountCode} is archived.`);
  if (account.account_type === "bank" || account.account_type === "credit_card") {
    throw new ValidationError(`Account ${fields.accountCode} is a bank account. Record a transfer on the reconcile screen instead.`);
  }
  if (fields.taxCode !== null) {
    const tax = await tx.query("select 1 from tax_codes where code = $1 and is_active", [fields.taxCode]);
    if (!tax.rowCount) throw new ValidationError(`There's no tax code ${fields.taxCode} in use.`);
  }
}

function parseCoding(raw: Record<string, unknown>, label: string): CodingFields {
  const contactId = requireId(raw.contactId, `${label} contactId`);
  const accountCode = parseAccountCodeInput(raw.accountCode, `${label} accountCode`);
  const taxCode = raw.taxCode === undefined || raw.taxCode === null || raw.taxCode === "" ? null : requireString(raw.taxCode, `${label} taxCode`, { maxLength: 20 });
  const description = optionalString(raw.description, `${label} description`, { maxLength: 500 })?.trim() || null;
  return { contactId, accountCode, taxCode, description };
}

function parseConfidence(input: unknown, label: string): string | null {
  if (input === undefined || input === null || input === "") return null;
  const text = typeof input === "number" ? String(input) : input;
  if (!isDecimalString(text)) throw new ValidationError(`${label} confidence must be a number from 0 to 1, e.g. "0.85".`);
  const value = dec(text);
  if (cmp(value, dec("0")) < 0 || cmp(value, dec("1")) > 0) throw new ValidationError(`${label} confidence must be from 0 to 1.`);
  return toPlainString(value);
}

/** A line is open in a proposal while a row for it is proposed, or approved and not posted. */
async function openRowFor(tx: OrgTx, lineId: string): Promise<string | null> {
  const found = await tx.query<{ proposal_id: string }>(
    `select r.proposal_id::text from bank_coding_proposal_rows r left join batch_actions ba on ba.id = r.approval_action_id
      where r.statement_line_id = $1 and (r.status = 'proposed' or (r.status = 'approved' and ba.status <> 'committed'))
      order by r.id limit 1`,
    [lineId],
  );
  return found.rows[0]?.proposal_id ?? null;
}

export type ProposeInput = { accountId: unknown; rows: unknown; note?: unknown; idempotencyKey: unknown; source: string };

/**
 * Keeps coding for some of an account's unreconciled lines for review
 * (decision 1292). Each row is checked on its own: one for a line that's
 * missing, on another account, not unreconciled, already in an open
 * proposal or twice in this one, or with a contact, account or tax code
 * that can't be used, isn't kept, and the answer says why. Nothing is
 * posted or reconciled. The same source and key again gives the same
 * proposal (`created` false); the same key for something else is refused.
 */
export async function proposeBankCoding(tx: OrgTx, input: ProposeInput): Promise<{ proposal: Proposal; created: boolean }> {
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  const accountId = requireId(input.accountId, "accountId");
  const raw = requireArray(input.rows, "rows", MAX_PROPOSAL_ROWS);
  if (raw.length === 0) throw new ValidationError("Give at least one row.");
  const note = optionalString(input.note, "note", { maxLength: 500 })?.trim() || null;
  const hash = requestHash("bank_coding_proposal", { accountId, rows: raw, note });
  const earlier = (
    await tx.query<{ id: string; request_hash: string }>("select id::text, request_hash from bank_coding_proposals where command_source = $1 and idempotency_key = $2", [
      input.source,
      idempotencyKey,
    ])
  ).rows[0];
  if (earlier) {
    assertSameRequest(earlier.request_hash, hash, "proposal");
    return { proposal: await getProposal(tx, earlier.id), created: false };
  }
  const account = (await tx.query<{ account_type: string }>("select account_type from accounts where id = $1", [accountId])).rows[0];
  if (!account || (account.account_type !== "bank" && account.account_type !== "credit_card")) throw new NotFoundError("Bank account not found.");

  const kept: Array<{ lineId: string; fields: CodingFields & { description: string }; amount: string; date: string; signed: string; reconciliations: number; rationale: string | null; confidence: string | null; gstEvidence: string | null; evidence: string | null }> = [];
  const refused: Proposal["refused"] = [];
  const seen = new Set<string>();
  for (const [index, entry] of raw.entries()) {
    const label = `Row ${index + 1}`;
    let lineId: string | null = null;
    try {
      const fields = asRecord(entry, label);
      lineId = requireId(fields.lineId, `${label} lineId`);
      if (seen.has(lineId)) throw new ValidationError(`Line ${lineId} is already in this proposal.`);
      seen.add(lineId);
      const coding = parseCoding(fields, label);
      const rationale = optionalString(fields.rationale, `${label} rationale`, { maxLength: 2000 })?.trim() || null;
      const evidence = optionalString(fields.evidence, `${label} evidence`, { maxLength: 2000 })?.trim() || null;
      const gstEvidence = fields.gstEvidence === undefined || fields.gstEvidence === null ? null : requireOneOf(fields.gstEvidence, `${label} gstEvidence`, GST_EVIDENCE);
      const confidence = parseConfidence(fields.confidence, label);
      const line = await getStatementLine(tx, lineId);
      if (line.accountId !== accountId) throw new ValidationError(`Line ${lineId} is on another account.`);
      if (line.status !== "unreconciled") throw new ConflictError(`Line ${lineId} is ${line.status}.`);
      const amount = line.amount.replace(/^-/, "");
      if (fields.amount !== undefined && fields.amount !== null && fields.amount !== "") {
        if (!isDecimalString(fields.amount) || toFixedString(dec(fields.amount), 2) !== toFixedString(dec(amount), 2)) {
          throw new ValidationError(`${label} amount must be the line's full amount (${amount}). Split lines on the reconcile screen.`);
        }
      }
      const open = await openRowFor(tx, lineId);
      if (open) throw new ConflictError(`Line ${lineId} is already in proposal ${open}. Reject that row first.`);
      await checkCoding(tx, coding);
      const reconciliations = Number(
        (await tx.query<{ n: string }>("select count(*)::text as n from bank_reconciliations where statement_line_id = $1", [lineId])).rows[0].n,
      );
      kept.push({
        lineId,
        fields: { ...coding, description: coding.description ?? line.description.slice(0, 500) },
        amount,
        date: line.date,
        signed: line.amount,
        reconciliations,
        rationale,
        confidence,
        gstEvidence,
        evidence,
      });
    } catch (error) {
      refused.push({ index, lineId, reason: lineErrorText(error) });
    }
  }
  if (kept.length === 0) {
    throw new ValidationError(`None of the rows could be kept. ${refused.slice(0, 3).map((entry) => `Row ${entry.index + 1}: ${entry.reason}`).join(" ")}`);
  }
  const inserted = await tx.query<{ id: string }>(
    `insert into bank_coding_proposals (account_id, command_source, idempotency_key, request_hash, note, refused, created_by_user_id, created_by_email, created_via)
     values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9)
     on conflict (command_source, idempotency_key) do nothing returning id::text`,
    [accountId, input.source, idempotencyKey, hash, note, JSON.stringify(refused), tx.actor.userId, tx.actor.email, tx.actor.via ?? null],
  );
  if (!inserted.rows[0]) throw new ConflictError("That proposal is being made by another request. Try again.");
  const proposalId = inserted.rows[0].id;
  for (const [position, row] of kept.entries()) {
    const original = { contactId: row.fields.contactId, accountCode: row.fields.accountCode, taxCode: row.fields.taxCode, description: row.fields.description, gstEvidence: row.gstEvidence };
    await tx.query(
      `insert into bank_coding_proposal_rows (proposal_id, position, statement_line_id, seen_line_date, seen_amount, seen_reconciliations, contact_id,
         account_code, tax_code, description, amount, rationale, confidence, gst_evidence, evidence, original)
       values ($1, $2, $3, $4::date, $5::numeric, $6, $7, $8, $9, $10, $11::numeric, $12, $13::numeric, $14, $15, $16::jsonb)`,
      [
        proposalId,
        position,
        row.lineId,
        row.date,
        row.signed,
        row.reconciliations,
        row.fields.contactId,
        row.fields.accountCode,
        row.fields.taxCode,
        row.fields.description,
        row.amount,
        row.rationale,
        row.confidence,
        row.gstEvidence,
        row.evidence,
        JSON.stringify(original),
      ],
    );
  }
  // Counts only: what was proposed stays in the proposal, not the audit trail (#544: no private data in logs).
  await writeAuditEvent(tx, { eventType: "bank_coding.proposed", entityType: "bank_coding_proposal", entityId: proposalId, details: { rows: kept.length, refused: refused.length } });
  return { proposal: await getProposal(tx, proposalId), created: true };
}

// ---------------------------------------------------------------------------
// Reviewing
// ---------------------------------------------------------------------------

/** Proposals are reviewed by people in Tohyee: an AI can propose, never approve, edit or reject (decision 1293). */
function assertPerson(tx: OrgTx): void {
  if (tx.actor.via) throw new ForbiddenError("Proposals are reviewed by a person in Tohyee, not by an AI.");
}

type Picked = { id: string; version: number };

function parsePicked(input: unknown): Picked[] {
  const seen = new Set<string>();
  const rows = requireArray(input, "rows", MAX_PROPOSAL_ROWS).map((raw, index) => {
    const entry = asRecord(raw, `rows[${index}]`);
    const id = requireId(entry.id, `rows[${index}].id`);
    const version = Number(entry.version);
    if (!Number.isInteger(version) || version < 1) throw new ValidationError(`rows[${index}].version must be the version you saw.`);
    if (seen.has(id)) throw new ValidationError(`Row ${id} is chosen twice.`);
    seen.add(id);
    return { id, version };
  });
  if (rows.length === 0) throw new ValidationError("Choose at least one row.");
  return rows;
}

/** Locks the chosen rows of this proposal; each must be the version the person saw (decision 1295). */
async function lockPicked(tx: OrgTx, proposalId: string, picked: readonly Picked[]): Promise<RowRecord[]> {
  const exists = await tx.query("select 1 from bank_coding_proposals where id = $1", [proposalId]);
  if (!exists.rowCount) throw new NotFoundError("Proposal not found.");
  const ids = picked.map((entry) => entry.id);
  await tx.query("select id from bank_coding_proposal_rows where proposal_id = $1 and id = any($2::bigint[]) order by id for update", [proposalId, ids]);
  const rows = (await tx.query<RowRecord>(`${ROW_SELECT} where r.proposal_id = $1 and r.id = any($2::bigint[]) order by r.position`, [proposalId, ids])).rows;
  const byId = new Map(rows.map((row) => [row.id, row]));
  for (const entry of picked) {
    const row = byId.get(entry.id);
    if (!row) throw new NotFoundError(`Row ${entry.id} isn't in this proposal.`);
    if (row.version !== entry.version) throw new ConflictError(`Row ${entry.id} has changed since you looked. Reload and check it again.`);
  }
  return rows;
}

function assertOpen(row: RowRecord): void {
  const state = rowState(row.status, row.action_status);
  if (!isOpen(state)) {
    throw new ConflictError(
      state === "approved" ? `Row ${row.id} is approved and waiting to post. Resume its batch on the Batches tab.` : `Row ${row.id} is already ${state}.`,
    );
  }
}

/**
 * A person's change to an open row (decision 1293): contact, account, GST
 * code or description. Saving it records that a person said the GST
 * treatment is right (gstEvidence person_said); the coding as first
 * proposed is kept. A failed row goes back to proposed.
 */
export async function editProposalRow(tx: OrgTx, proposalIdInput: unknown, rowIdInput: unknown, input: Record<string, unknown>): Promise<ProposalRow> {
  assertPerson(tx);
  const proposalId = requireId(proposalIdInput, "proposalId");
  const rowId = requireId(rowIdInput, "rowId");
  const [row] = await lockPicked(tx, proposalId, [{ id: rowId, version: Number(input.version) }]);
  assertOpen(row);
  const coding = parseCoding(input, "Row");
  await checkCoding(tx, coding);
  await tx.query(
    `update bank_coding_proposal_rows
        set contact_id = $2, account_code = $3, tax_code = $4, description = coalesce($5, description), gst_evidence = 'person_said',
            status = 'proposed', approval_action_id = null, version = version + 1, edited_by_email = $6, edited_at = now()
      where id = $1`,
    [rowId, coding.contactId, coding.accountCode, coding.taxCode, coding.description, tx.actor.email],
  );
  await writeAuditEvent(tx, { eventType: "bank_coding.edited", entityType: "bank_coding_proposal", entityId: proposalId, details: { rowId } });
  const checks = await loadChecks(tx);
  return toRow((await tx.query<RowRecord>(`${ROW_SELECT} where r.id = $1`, [rowId])).rows[0], checks);
}

/** Rejects open rows (decision 1293). Nothing is posted; the line is free to be proposed again. */
export async function rejectProposalRows(tx: OrgTx, proposalIdInput: unknown, input: { rows: unknown; reason?: unknown }): Promise<Proposal> {
  assertPerson(tx);
  const proposalId = requireId(proposalIdInput, "proposalId");
  const picked = parsePicked(input.rows);
  const reason = optionalString(input.reason, "reason", { maxLength: 500 })?.trim() || null;
  const rows = await lockPicked(tx, proposalId, picked);
  rows.forEach(assertOpen);
  await tx.query(
    `update bank_coding_proposal_rows
        set status = 'rejected', approval_action_id = null, reject_reason = $2, version = version + 1,
            reviewed_by_user_id = $3, reviewed_by_email = $4, reviewed_at = now()
      where id = any($1::bigint[])`,
    [rows.map((row) => row.id), reason, tx.actor.userId, tx.actor.email],
  );
  await writeAuditEvent(tx, { eventType: "bank_coding.rejected", entityType: "bank_coding_proposal", entityId: proposalId, details: { rows: rows.length } });
  return getProposal(tx, proposalId);
}

export type ApprovalOutcome = RunOutcome & {
  created: boolean;
  /** Chosen rows left as they are (stale, locked, GST), with why. */
  skipped: Array<{ rowId: string; reasons: string[] }>;
};

/**
 * Approves open rows (decision 1294) as a durable batch of kind bank_coding:
 * each chosen row that still holds (not stale, not locked, its GST still
 * holds) is marked approved by this person and given a batch action; the
 * others are left as they are and the answer says why. Then each action
 * posts its row in its own transaction, checking everything again first.
 * The same key again resumes the same batch (a double click posts nothing
 * twice); rows already approved can't be approved again with a new key.
 */
export async function approveProposalRows(
  run: OrgRunner,
  proposalIdInput: unknown,
  input: { rows: unknown; idempotencyKey: unknown; source: string },
  options: RunOptions = {},
): Promise<ApprovalOutcome> {
  const proposalId = requireId(proposalIdInput, "proposalId");
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  if (!APPROVAL_KEY_PATTERN.test(idempotencyKey)) throw new ValidationError("idempotencyKey can be at most 80 characters here.");
  const picked = parsePicked(input.rows);
  const hash = requestHash("bank_coding_approval", { proposalId, rows: [...picked].sort((left, right) => left.id.localeCompare(right.id)) });

  const made = await run(async (tx) => {
    assertPerson(tx);
    const earlier = await tx.query("select 1 from batches where command_source = $1 and idempotency_key = $2", [input.source, idempotencyKey]);
    if (earlier.rowCount) {
      // The same approval again (a lost answer, a double click): the batch already says what it covers.
      const again = await createBatch(tx, { kind: "bank_coding", source: input.source, idempotencyKey, requestHash: hash, actions: [] });
      return { ...again, skipped: [] as ApprovalOutcome["skipped"] };
    }
    const rows = await lockPicked(tx, proposalId, picked);
    rows.forEach(assertOpen);
    const checks = await loadChecks(tx);
    const skipped: ApprovalOutcome["skipped"] = [];
    const ready: RowRecord[] = [];
    for (const row of rows) {
      const problems = problemsFor(row, checks);
      if (problems.length) skipped.push({ rowId: row.id, reasons: problems.map((problem) => problem.text) });
      else ready.push(row);
    }
    if (ready.length === 0) {
      throw new ConflictError(`None of these can be approved as they are. ${skipped.slice(0, 3).map((entry) => `Row ${entry.rowId}: ${entry.reasons.join(" ")}`).join(" ")}`);
    }
    const { batch, created } = await createBatch(tx, {
      kind: "bank_coding",
      source: input.source,
      idempotencyKey,
      requestHash: hash,
      actions: ready.map((row) => ({
        action: "approve_coding",
        targetId: row.statement_line_id,
        payload: { proposalId, rowId: row.id, version: row.version + 1 },
        idempotencyKey: `${idempotencyKey}:${row.id}`,
      })),
    });
    for (const [position, row] of ready.entries()) {
      await tx.query(
        `update bank_coding_proposal_rows
            set status = 'approved', approval_action_id = $2, version = version + 1, reject_reason = null,
                reviewed_by_user_id = $3, reviewed_by_email = $4, reviewed_at = now()
          where id = $1`,
        [row.id, batch.actions[position].id, tx.actor.userId, tx.actor.email],
      );
    }
    await writeAuditEvent(tx, {
      eventType: "bank_coding.approved",
      entityType: "bank_coding_proposal",
      entityId: proposalId,
      details: { rows: ready.length, skipped: skipped.length, batchId: batch.id },
    });
    return { batch, created, skipped };
  });
  if (made.batch.kind !== "bank_coding") throw new ConflictError("That idempotency key was already used for a different kind of batch.");
  return { ...(await runBatch(run, made.batch.id, approvalWork(made.batch.source), options)), created: made.created, skipped: made.skipped };
}

/**
 * Posting one approved row (a bank_coding batch action), in the action's own
 * transaction: a retry with the action's key finds the earlier posting
 * instead of posting again; otherwise the row must still be approved by
 * this action and still hold, or it's refused with why and nothing changes.
 */
export function approvalWork(source: string): ActionWork {
  return async (tx, action) => {
    const rowId = requireId(action.payload.rowId, "rowId");
    await tx.query("select id from bank_coding_proposal_rows where id = $1 for update", [rowId]);
    const row = (await tx.query<RowRecord>(`${ROW_SELECT} where r.id = $1`, [rowId])).rows[0];
    if (!row) throw new NotFoundError("That proposal row wasn't found.");
    if (row.status !== "approved" || row.approval_action_id !== action.id || row.version !== Number(action.payload.version)) {
      throw new ConflictError("This row was changed after it was approved, so it wasn't posted. Check it and approve it again.");
    }
    const command = {
      source,
      idempotencyKey: action.idempotencyKey,
      kind: "bank_transaction",
      contactId: row.contact_id,
      amountsMode: row.tax_code ? "inclusive" : "no_tax",
      lines: [{ description: row.description, accountCode: row.account_code, ...(row.tax_code ? { taxCode: row.tax_code } : {}), amount: toFixedString(dec(row.amount), 2) }],
    };
    const earlier = await tx.query("select 1 from bank_reconciliations where command_source = $1 and idempotency_key = $2", [source, action.idempotencyKey]);
    if (!earlier.rowCount) {
      // Checked again now, not only when approved (decision 1295).
      const problems = problemsFor(row, await loadChecks(tx));
      if (problems.length) throw new ConflictError(problems.map((problem) => problem.text).join(" "));
    }
    const done = await reconcileStatementLine(tx, row.statement_line_id, command);
    const reconciliationId = done.line.reconciliation?.id ?? null;
    await tx.query("update bank_coding_proposal_rows set posted_reconciliation_id = $2 where id = $1", [rowId, reconciliationId]);
    return { lineId: row.statement_line_id, rowId, created: done.created };
  };
}
