import { parseAccountCodeInput } from "@/lib/accounts/service";
import type { AccountClass, AccountType } from "@/lib/accounts/types";
import { writeAuditEvent } from "@/lib/audit";
import { type Role, roleAtLeast } from "@/lib/auth/roles";
import { resolveBankAccount } from "@/lib/bills/payments";
import { billLineAccountProblem } from "@/lib/bills/accounts";
import { parseIsoDate } from "@/lib/dates";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { assertSameRequest, requestHash } from "@/lib/idempotency";
import { calculateInvoice, invoicePaymentStatus, type PaidStatus } from "@/lib/invoices/amounts";
import { type AvailableOn, sideRefusal } from "@/lib/tax/available-on";
import { type ControlAccount, controlAccountCode, GST_ACCOUNT } from "@/lib/invoices/service";
import { getJournal, parseJournalBody, postJournalBody } from "@/lib/ledger/journals";
import { assertPostingDateAllowed } from "@/lib/ledger/period-controls";
import { currencyMinorUnits } from "@/lib/money/currency";
import { add, cmp, dec, type Decimal, isZero, parseDecimalInput, sub, toFixedString, toPlainString, ZERO_DECIMAL } from "@/lib/money/decimal";
import { personName } from "@/lib/people/names";
import { removeRecordExtras } from "@/lib/records/extras";
import {
  assertRequiredTags,
  checkNewTags,
  keptValues,
  loadTrackingContext,
  parseTrackingInput,
  sortedTags,
  trackingKey,
  type TrackingTags,
} from "@/lib/tracking/service";
import { asRecord, optionalSource, optionalString, requireArray, requireId, requireIdempotencyKey, requireString } from "@/lib/validation";

/**
 * Expense claims (examples EC1-EC12), like Xero's (older) expense claims: a
 * member enters receipts they paid for themselves (tax inclusive), submits
 * the claim, and a bookkeeper or admin approves it, which posts one journal
 * on the claim date: Dr each receipt's account (net, grouped by account and
 * tracking), Dr GST, Cr expense claims payable. Paying it posts Dr expense
 * claims payable / Cr the bank account, like a supplier payment. A submitted
 * claim can be declined back to its claimant with a reason; an approved one
 * with no active payments can be voided (the exact reversal). What's paid
 * and due is worked out from the payments, never stored.
 */

export const EXPENSE_CLAIM_STATUSES = ["draft", "submitted", "approved", "voided"] as const;
export type ExpenseClaimStatus = (typeof EXPENSE_CLAIM_STATUSES)[number];

export const EXPENSE_CLAIMS_PAYABLE: ControlAccount = {
  systemKey: "expense_claims_payable",
  label: "expense claims payable",
  accountClass: "liability",
};

const MAX_RECEIPTS = 100;

export type ExpenseClaimReceipt = {
  id: string;
  lineOrder: number;
  receiptDate: string;
  supplierName: string;
  description: string;
  accountId: string;
  accountCode: string;
  accountName: string;
  taxCodeId: string | null;
  taxCode: string | null;
  taxRate: string;
  /** Including GST. */
  amount: string;
  netAmount: string;
  taxAmount: string;
  tracking: TrackingTags;
};

export type ExpenseClaimPayment = {
  id: string;
  status: "active" | "voided";
  paymentDate: string;
  amount: string;
  bankAccountCode: string;
  bankAccountName: string;
  reference: string | null;
  journalId: string;
  voidDate: string | null;
  voidJournalId: string | null;
  createdByEmail: string | null;
  createdAt: string;
  voidedByEmail: string | null;
};

export type ExpenseClaimSummary = {
  id: string;
  /** e.g. "CLAIM-12": the journal reference. Claims aren't numbered from a counter. */
  reference: string;
  status: ExpenseClaimStatus;
  claimantUserId: string | null;
  claimantEmail: string;
  description: string | null;
  currencyCode: string;
  subtotal: string;
  taxTotal: string;
  total: string;
  receiptCount: number;
  submittedAt: string | null;
  declinedAt: string | null;
  declinedByEmail: string | null;
  declineReason: string | null;
  claimDate: string | null;
  approvalJournalId: string | null;
  approvedByEmail: string | null;
  approvedAt: string | null;
  voidDate: string | null;
  voidJournalId: string | null;
  voidedByEmail: string | null;
  /** Approved claims only (worked out from active payments). */
  amountPaid: string | null;
  amountDue: string | null;
  paidStatus: PaidStatus | null;
  createdAt: string;
  updatedAt: string;
};

export type ExpenseClaim = ExpenseClaimSummary & { receipts: ExpenseClaimReceipt[]; payments: ExpenseClaimPayment[] };

type ClaimRow = {
  id: string;
  status: ExpenseClaimStatus;
  claimant_user_id: string | null;
  claimant_email: string;
  description: string | null;
  currency_code: string;
  total: string;
  tax_total: string;
  receipt_count: string;
  submitted_at: string | null;
  declined_at: string | null;
  declined_by_email: string | null;
  decline_reason: string | null;
  claim_date: string | null;
  approval_journal_id: string | null;
  approved_by_email: string | null;
  approved_at: string | null;
  void_date: string | null;
  void_journal_id: string | null;
  voided_by_email: string | null;
  amount_paid: string;
  created_at: string;
  updated_at: string;
};

const SUMMARY_SELECT = `select c.id::text, c.status, c.claimant_user_id::text, c.claimant_email, c.description, c.currency_code,
       c.total::text, c.tax_total::text,
       (select count(*) from expense_claim_receipts r where r.claim_id = c.id)::text as receipt_count,
       c.submitted_at, c.declined_at, c.declined_by_email, c.decline_reason, c.claim_date,
       c.approval_journal_id::text, c.approved_by_email, c.approved_at, c.void_date, c.void_journal_id::text, c.voided_by_email,
       coalesce((select sum(p.amount) from expense_claim_payments p where p.claim_id = c.id and p.status = 'active'), 0)::text as amount_paid,
       c.created_at, c.updated_at
  from expense_claims c`;

export function claimReference(id: string): string {
  return `CLAIM-${id}`;
}

function toSummary(row: ClaimRow, scale: number): ExpenseClaimSummary {
  const approved = row.status === "approved";
  const payment = approved ? invoicePaymentStatus(row.total, row.amount_paid, scale) : null;
  const total = dec(row.total);
  const tax = dec(row.tax_total);
  return {
    id: row.id,
    reference: claimReference(row.id),
    status: row.status,
    claimantUserId: row.claimant_user_id,
    claimantEmail: row.claimant_email,
    description: row.description,
    currencyCode: row.currency_code,
    subtotal: toFixedString(sub(total, tax), scale),
    taxTotal: toFixedString(tax, scale),
    total: toFixedString(total, scale),
    receiptCount: Number(row.receipt_count),
    submittedAt: row.submitted_at,
    declinedAt: row.declined_at,
    declinedByEmail: row.declined_by_email,
    declineReason: row.decline_reason,
    claimDate: row.claim_date,
    approvalJournalId: row.approval_journal_id,
    approvedByEmail: row.approved_by_email,
    approvedAt: row.approved_at,
    voidDate: row.void_date,
    voidJournalId: row.void_journal_id,
    voidedByEmail: row.voided_by_email,
    amountPaid: payment?.amountPaid ?? null,
    amountDue: payment?.amountDue ?? null,
    paidStatus: payment?.paidStatus ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

type ReceiptRow = {
  id: string;
  line_order: number;
  receipt_date: string;
  supplier_name: string;
  description: string;
  account_id: string;
  code: string;
  name: string;
  tax_code_id: string | null;
  tax_code: string | null;
  tax_rate: string;
  amount: string;
  net_amount: string;
  tax_amount: string;
  tracking: TrackingTags;
};

type PaymentRow = {
  id: string;
  status: "active" | "voided";
  payment_date: string;
  amount: string;
  code: string;
  name: string;
  reference: string | null;
  journal_id: string;
  void_date: string | null;
  void_journal_id: string | null;
  created_by_email: string | null;
  created_at: string;
  voided_by_email: string | null;
};

export async function getExpenseClaim(tx: OrgTx, idInput: unknown): Promise<ExpenseClaim> {
  const id = requireId(idInput, "claimId");
  const scale = currencyMinorUnits(tx.baseCurrency);
  const found = await tx.query<ClaimRow>(`${SUMMARY_SELECT} where c.id = $1`, [id]);
  if (!found.rows[0]) throw new NotFoundError("Expense claim not found.");
  const receipts = await tx.query<ReceiptRow>(
    `select r.id::text, r.line_order, r.receipt_date, r.supplier_name, r.description, r.account_id::text, a.code, a.name,
            r.tax_code_id::text, t.code as tax_code, r.tax_rate::text, r.amount::text, r.net_amount::text, r.tax_amount::text, r.tracking
       from expense_claim_receipts r join accounts a on a.id = r.account_id left join tax_codes t on t.id = r.tax_code_id
      where r.claim_id = $1 order by r.line_order`,
    [id],
  );
  const payments = await tx.query<PaymentRow>(
    `select p.id::text, p.status, p.payment_date, p.amount::text, a.code, a.name, p.reference, p.journal_id::text, p.void_date,
            p.void_journal_id::text, p.created_by_email, p.created_at, p.voided_by_email
       from expense_claim_payments p join accounts a on a.id = p.bank_account_id
      where p.claim_id = $1 order by p.id`,
    [id],
  );
  return {
    ...toSummary(found.rows[0], scale),
    receipts: receipts.rows.map((row) => ({
      id: row.id,
      lineOrder: row.line_order,
      receiptDate: row.receipt_date,
      supplierName: row.supplier_name,
      description: row.description,
      accountId: row.account_id,
      accountCode: row.code,
      accountName: row.name,
      taxCodeId: row.tax_code_id,
      taxCode: row.tax_code,
      taxRate: toPlainString(dec(row.tax_rate)),
      amount: toFixedString(dec(row.amount), scale),
      netAmount: toFixedString(dec(row.net_amount), scale),
      taxAmount: toFixedString(dec(row.tax_amount), scale),
      tracking: row.tracking ?? {},
    })),
    payments: payments.rows.map((row) => ({
      id: row.id,
      status: row.status,
      paymentDate: row.payment_date,
      amount: toFixedString(dec(row.amount), scale),
      bankAccountCode: row.code,
      bankAccountName: row.name,
      reference: row.reference,
      journalId: row.journal_id,
      voidDate: row.void_date,
      voidJournalId: row.void_journal_id,
      createdByEmail: row.created_by_email,
      createdAt: row.created_at,
      voidedByEmail: row.voided_by_email,
    })),
  };
}

async function lockClaim(tx: OrgTx, id: string): Promise<ExpenseClaim> {
  const locked = await tx.query("select 1 from expense_claims where id = $1 for update", [id]);
  if (locked.rowCount === 0) throw new NotFoundError("Expense claim not found.");
  return getExpenseClaim(tx, id);
}

/**
 * Claims, newest first. `status` is draft, submitted, approved, voided or
 * awaiting_payment (approved with something still due); `mine` shows only
 * the signed-in person's claims.
 */
export async function listExpenseClaims(tx: OrgTx, filters: { status?: unknown; mine?: unknown } = {}): Promise<ExpenseClaimSummary[]> {
  const status = filters.status == null || filters.status === "" ? null : String(filters.status);
  if (status !== null && status !== "awaiting_payment" && !(EXPENSE_CLAIM_STATUSES as readonly string[]).includes(status)) {
    throw new ValidationError("status must be draft, submitted, approved, voided or awaiting_payment.");
  }
  const mine = filters.mine === true || filters.mine === "true";
  const found = await tx.query<ClaimRow>(
    `${SUMMARY_SELECT}
      where ($1::text is null or c.status = $1 or ($1 = 'awaiting_payment' and c.status = 'approved'
             and c.total > coalesce((select sum(p.amount) from expense_claim_payments p where p.claim_id = c.id and p.status = 'active'), 0)))
        and (not $2 or c.claimant_user_id::text = $3 or (c.claimant_user_id is null and lower(c.claimant_email) = lower($4)))
      order by c.id desc limit 500`,
    [status, mine, tx.actor.userId ?? "", tx.actor.email],
  );
  const scale = currencyMinorUnits(tx.baseCurrency);
  return found.rows.map((row) => toSummary(row, scale));
}

/** A receipt as typed. */
type ReceiptInput = {
  receiptDate: string;
  supplierName: string;
  description: string;
  accountCode: string;
  taxCode: string | null;
  amount: string;
  tracking: TrackingTags;
};

type ResolvedReceipt = ReceiptInput & {
  accountId: string;
  accountCode: string;
  accountClass: AccountClass;
  taxCodeId: string | null;
  taxRate: string;
  netAmount: string;
  taxAmount: string;
};

function parseReceipts(input: unknown, scale: number): ReceiptInput[] {
  const raw = requireArray(input ?? [], "receipts", MAX_RECEIPTS);
  return raw.map((entry, index) => {
    const label = `Receipt ${index + 1}`;
    const line = asRecord(entry, label);
    const amount = parseDecimalInput(line.amount, `${label} amount`, { maxScale: scale });
    return {
      receiptDate: parseIsoDate(line.receiptDate, `${label} date`),
      supplierName: requireString(line.supplierName, `${label} supplier`, { maxLength: 200 }),
      description: requireString(line.description, `${label} description`, { maxLength: 500 }),
      accountCode: parseAccountCodeInput(line.accountCode, `${label} account`),
      taxCode: optionalString(line.taxCode, `${label} tax code`, { maxLength: 20 })?.toUpperCase() ?? null,
      amount: toFixedString(dec(amount), scale),
      tracking: sortedTags(parseTrackingInput(line.tracking, label)),
    };
  });
}

/**
 * Checks receipts against the organisation's data (EC1, EC9): each account
 * one a bill line could use other than the inventory account (stock comes in
 * on bills), each tax code active and in effect on the receipt's date, and
 * tags usable. A receipt with no tax code has no GST (not a GST receipt).
 */
async function resolveReceipts(tx: OrgTx, receipts: ReceiptInput[], kept: ReadonlySet<string>): Promise<{ receipts: ResolvedReceipt[]; subtotal: string; taxTotal: string; total: string }> {
  const scale = currencyMinorUnits(tx.baseCurrency);
  const tracking = await loadTrackingContext(tx);
  receipts.forEach((receipt, index) => checkNewTags(tracking, receipt.tracking, `Receipt ${index + 1}`, kept));
  const accounts = await tx.query<{
    id: string;
    code: string;
    name: string;
    account_class: AccountClass;
    account_type: AccountType;
    system_key: string | null;
    currency_code: string | null;
    is_active: boolean;
  }>(
    "select id::text, code, name, account_class, account_type, system_key, currency_code, is_active from accounts where lower(code) = any($1::text[])",
    [[...new Set(receipts.map((receipt) => receipt.accountCode.toLowerCase()))]],
  );
  const accountsByCode = new Map(accounts.rows.map((row) => [row.code.toLowerCase(), row]));
  const taxCodes = await tx.query<{ id: string; code: string; rate: string; is_active: boolean; effective_from: string; effective_to: string | null; available_on: AvailableOn }>(
    "select id::text, code, rate::text, is_active, effective_from, effective_to, available_on from tax_codes where code = any($1::text[])",
    [[...new Set(receipts.flatMap((receipt) => (receipt.taxCode ? [receipt.taxCode] : [])))]],
  );
  const taxCodesByCode = new Map(taxCodes.rows.map((row) => [row.code, row]));
  const resolved = receipts.map((receipt, index) => {
    const label = `Receipt ${index + 1}`;
    const account = accountsByCode.get(receipt.accountCode.toLowerCase());
    if (!account) throw new ValidationError(`${label}: there's no account with the code ${receipt.accountCode}.`);
    if (!account.is_active) throw new ValidationError(`${label}: account ${account.code} (${account.name}) is archived.`);
    if (account.system_key === "inventory" || account.account_type === "inventory") {
      throw new ValidationError(`${label}: account ${account.code} (${account.name}) is for stock, which comes in on bills. Choose an expense account.`);
    }
    const problem = billLineAccountProblem({
      accountClass: account.account_class,
      accountType: account.account_type,
      systemKey: account.system_key,
      currencyCode: account.currency_code === tx.baseCurrency ? null : account.currency_code,
    });
    if (problem) throw new ValidationError(`${label}: account ${account.code} (${account.name}) is ${problem}`);
    let taxCodeId: string | null = null;
    let taxRate = "0";
    if (receipt.taxCode !== null) {
      const taxCode = taxCodesByCode.get(receipt.taxCode);
      if (!taxCode) throw new ValidationError(`${label}: there's no tax code ${receipt.taxCode}.`);
      if (!taxCode.is_active) throw new ValidationError(`${label}: tax code ${taxCode.code} is inactive.`);
      // Receipts are purchases (TAO4).
      const offSide = sideRefusal(label, taxCode.code, taxCode.available_on, "purchases");
      if (offSide) throw new ValidationError(offSide);
      if (taxCode.effective_from > receipt.receiptDate || (taxCode.effective_to !== null && taxCode.effective_to < receipt.receiptDate)) {
        throw new ValidationError(`${label}: tax code ${taxCode.code} isn't in effect on ${receipt.receiptDate}.`);
      }
      taxCodeId = taxCode.id;
      taxRate = toPlainString(dec(taxCode.rate));
    }
    return { ...receipt, accountId: account.id, accountCode: account.code, accountClass: account.account_class, taxCodeId, taxRate };
  });
  // Tax inclusive, GST worked out and rounded per receipt, as on bills (B2).
  const amounts = calculateInvoice(
    "inclusive",
    resolved.map((receipt) => ({ quantity: "1", unitPrice: receipt.amount, taxRate: receipt.taxRate })),
    scale,
  );
  return {
    receipts: resolved.map((receipt, index) => ({ ...receipt, netAmount: amounts.lines[index].netAmount, taxAmount: amounts.lines[index].taxAmount })),
    subtotal: amounts.subtotal,
    taxTotal: amounts.taxTotal,
    total: amounts.total,
  };
}

async function writeReceipts(tx: OrgTx, claimId: string, receipts: ResolvedReceipt[]): Promise<void> {
  await tx.query("delete from expense_claim_receipts where claim_id = $1", [claimId]);
  for (const [index, receipt] of receipts.entries()) {
    await tx.query(
      `insert into expense_claim_receipts (claim_id, line_order, receipt_date, supplier_name, description, account_id, tax_code_id,
                                           tax_rate, amount, net_amount, tax_amount, tracking)
       values ($1, $2, $3, $4, $5, $6, $7, $8::numeric, $9::numeric, $10::numeric, $11::numeric, $12::jsonb)`,
      [
        claimId,
        index + 1,
        receipt.receiptDate,
        receipt.supplierName,
        receipt.description,
        receipt.accountId,
        receipt.taxCodeId,
        receipt.taxRate,
        receipt.amount,
        receipt.netAmount,
        receipt.taxAmount,
        JSON.stringify(receipt.tracking),
      ],
    );
  }
}

function hashReceipts(receipts: ReceiptInput[]): unknown[] {
  return receipts.map((receipt) => ({
    ...receipt,
    accountCode: receipt.accountCode.toLowerCase(),
    ...(Object.keys(receipt.tracking).length === 0 ? { tracking: undefined } : {}),
  }));
}

function isClaimant(tx: OrgTx, claim: ExpenseClaimSummary): boolean {
  if (claim.claimantUserId && tx.actor.userId) return claim.claimantUserId === tx.actor.userId;
  return claim.claimantEmail.toLowerCase() === tx.actor.email.toLowerCase();
}

function assertOwnDraft(tx: OrgTx, claim: ExpenseClaim, action: string): void {
  if (!isClaimant(tx, claim)) {
    throw new ForbiddenError(`Only ${personName(tx, claim.claimantEmail)}, who made this claim, can ${action} it.`);
  }
  if (claim.status !== "draft") {
    throw new ConflictError(`${claimReference(claim.id)} is ${claim.status}, so it can't be ${action === "delete" ? "deleted" : "changed"}.`);
  }
}

function parseDescription(input: unknown): string | null {
  return optionalString(input, "description", { maxLength: 500 });
}

/** Starts a draft claim for the signed-in person (EC1). Drafts post nothing. */
export async function createExpenseClaim(
  tx: OrgTx,
  command: { source?: unknown; idempotencyKey: unknown; description?: unknown; receipts?: unknown },
): Promise<{ created: boolean; claim: ExpenseClaim }> {
  const source = optionalSource(command.source);
  const idempotencyKey = requireIdempotencyKey(command.idempotencyKey);
  const scale = currencyMinorUnits(tx.baseCurrency);
  const description = parseDescription(command.description);
  const receipts = parseReceipts(command.receipts, scale);
  const hash = requestHash("expense_claim_create", { description, receipts: hashReceipts(receipts), claimant: tx.actor.email.toLowerCase() });
  const earlier = await tx.query<{ id: string; request_hash: string }>(
    "select id::text, request_hash from expense_claims where command_source = $1 and idempotency_key = $2",
    [source, idempotencyKey],
  );
  if (earlier.rows[0]) {
    assertSameRequest(earlier.rows[0].request_hash, hash, "expense claim");
    return { created: false, claim: await getExpenseClaim(tx, earlier.rows[0].id) };
  }
  const resolved = await resolveReceipts(tx, receipts, new Set());
  const inserted = await tx.query<{ id: string }>(
    `insert into expense_claims (command_source, idempotency_key, request_hash, claimant_user_id, claimant_email, description,
                                 currency_code, total, tax_total)
     values ($1, $2, $3, $4, $5, $6, $7, $8::numeric, $9::numeric)
     on conflict (command_source, idempotency_key) do nothing returning id::text`,
    [source, idempotencyKey, hash, tx.actor.userId, tx.actor.email, description, tx.baseCurrency, resolved.total, resolved.taxTotal],
  );
  if (!inserted.rows[0]) throw new ConflictError("That expense claim is being saved by another request. Try again.");
  const id = inserted.rows[0].id;
  await writeReceipts(tx, id, resolved.receipts);
  await writeAuditEvent(tx, {
    eventType: "expense_claim.created",
    entityType: "expense_claim",
    entityId: id,
    details: { total: resolved.total, receipts: resolved.receipts.length },
  });
  return { created: true, claim: await getExpenseClaim(tx, id) };
}

/** Changes a draft's receipts or description. Only its claimant can (EC1, EC5). */
export async function updateExpenseClaim(tx: OrgTx, idInput: unknown, command: { description?: unknown; receipts?: unknown }): Promise<ExpenseClaim> {
  const id = requireId(idInput, "claimId");
  const current = await lockClaim(tx, id);
  assertOwnDraft(tx, current, "change");
  const scale = currencyMinorUnits(tx.baseCurrency);
  const description = command.description === undefined ? current.description : parseDescription(command.description);
  const receipts =
    command.receipts === undefined
      ? current.receipts.map((receipt) => ({
          receiptDate: receipt.receiptDate,
          supplierName: receipt.supplierName,
          description: receipt.description,
          accountCode: receipt.accountCode,
          taxCode: receipt.taxCode,
          amount: receipt.amount,
          tracking: receipt.tracking,
        }))
      : parseReceipts(command.receipts, scale);
  const resolved = await resolveReceipts(tx, receipts, keptValues(current.receipts));
  await tx.query("update expense_claims set description = $2, total = $3::numeric, tax_total = $4::numeric, updated_at = now() where id = $1", [
    id,
    description,
    resolved.total,
    resolved.taxTotal,
  ]);
  await writeReceipts(tx, id, resolved.receipts);
  await writeAuditEvent(tx, {
    eventType: "expense_claim.updated",
    entityType: "expense_claim",
    entityId: id,
    details: { total: resolved.total, receipts: resolved.receipts.length },
  });
  return getExpenseClaim(tx, id);
}

/** Deletes a draft (never submitted, or declined). Only its claimant can. */
export async function deleteExpenseClaim(tx: OrgTx, idInput: unknown): Promise<void> {
  const id = requireId(idInput, "claimId");
  const current = await lockClaim(tx, id);
  assertOwnDraft(tx, current, "delete");
  await tx.query("delete from expense_claim_receipts where claim_id = $1", [id]);
  await tx.query("delete from expense_claims where id = $1", [id]);
  await removeRecordExtras(tx, "expense_claim", id);
  await writeAuditEvent(tx, { eventType: "expense_claim.deleted", entityType: "expense_claim", entityId: id, details: { total: current.total } });
}

/** Sends a draft for approval (EC2). It needs a receipt, and its receipts are checked again, including required tracking. */
export async function submitExpenseClaim(tx: OrgTx, idInput: unknown): Promise<ExpenseClaim> {
  const id = requireId(idInput, "claimId");
  const current = await lockClaim(tx, id);
  if (current.status === "submitted") return current;
  assertOwnDraft(tx, current, "submit");
  if (current.receipts.length === 0) throw new ValidationError("Add at least one receipt before submitting the claim.");
  await checkStillValid(tx, current);
  await tx.query(
    `update expense_claims set status = 'submitted', submitted_at = now(), declined_at = null, declined_by_email = null, decline_reason = null,
            updated_at = now() where id = $1`,
    [id],
  );
  await writeAuditEvent(tx, { eventType: "expense_claim.submitted", entityType: "expense_claim", entityId: id, details: { total: current.total } });
  return getExpenseClaim(tx, id);
}

/** Receipts worked out again give the same amounts, and required tracking is there (EC2, EC9). */
async function checkStillValid(tx: OrgTx, claim: ExpenseClaim): Promise<ResolvedReceipt[]> {
  const resolved = await resolveReceipts(
    tx,
    claim.receipts.map((receipt) => ({
      receiptDate: receipt.receiptDate,
      supplierName: receipt.supplierName,
      description: receipt.description,
      accountCode: receipt.accountCode,
      taxCode: receipt.taxCode,
      amount: receipt.amount,
      tracking: receipt.tracking,
    })),
    keptValues(claim.receipts),
  );
  const changed = resolved.receipts.some(
    (receipt, index) => receipt.taxAmount !== claim.receipts[index].taxAmount || receipt.netAmount !== claim.receipts[index].netAmount,
  );
  if (changed || resolved.total !== claim.total) {
    throw new ConflictError("This claim's GST no longer matches its tax codes. Its claimant needs to open it and save it again.");
  }
  assertRequiredTags(
    await loadTrackingContext(tx),
    resolved.receipts.map((receipt) => ({ tags: receipt.tracking, accountClass: receipt.accountClass })),
  );
  return resolved.receipts;
}

function assertApprover(role: Role): void {
  if (!roleAtLeast(role, "bookkeeper")) throw new ForbiddenError("Only bookkeepers and admins can approve, decline, void or pay expense claims.");
}

/** Returns a submitted claim to its claimant as a draft, with a reason (EC6). Posts nothing. */
export async function declineExpenseClaim(tx: OrgTx, role: Role, idInput: unknown, command: { reason: unknown }): Promise<ExpenseClaim> {
  assertApprover(role);
  const id = requireId(idInput, "claimId");
  const reason = requireString(command.reason, "The reason", { maxLength: 500 });
  const current = await lockClaim(tx, id);
  if (current.status !== "submitted") throw new ConflictError(`${claimReference(id)} is ${current.status}; only submitted claims can be declined.`);
  await tx.query(
    `update expense_claims set status = 'draft', submitted_at = null, declined_at = now(), declined_by_email = $2, decline_reason = $3,
            updated_at = now() where id = $1`,
    [id, tx.actor.email, reason],
  );
  await writeAuditEvent(tx, { eventType: "expense_claim.declined", entityType: "expense_claim", entityId: id, details: { reason } });
  return getExpenseClaim(tx, id);
}

type KeyedAction = "approve" | "void";

async function findByKey(tx: OrgTx, action: KeyedAction, source: string, key: string): Promise<{ id: string; hash: string } | null> {
  const found = await tx.query<{ id: string; hash: string }>(
    `select id::text, ${action}_request_hash as hash from expense_claims where ${action}_command_source = $1 and ${action}_idempotency_key = $2`,
    [source, key],
  );
  return found.rows[0] ?? null;
}

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string }).code === "23505";
}

/**
 * Approves a submitted claim (EC3, EC4, EC7-EC10): posts one journal on the
 * claim date, Dr each receipt's account for its net amount (one line per
 * account and set of tags), Dr GST for the receipts' GST, Cr expense claims
 * payable for the total. The claim date can't be before a receipt, nor in a
 * locked period. A bookkeeper can't approve their own claim; an admin or
 * owner can.
 */
export async function approveExpenseClaim(
  tx: OrgTx,
  role: Role,
  idInput: unknown,
  command: { source?: unknown; idempotencyKey: unknown; claimDate: unknown },
): Promise<{ created: boolean; claim: ExpenseClaim }> {
  assertApprover(role);
  const id = requireId(idInput, "claimId");
  const source = optionalSource(command.source);
  const idempotencyKey = requireIdempotencyKey(command.idempotencyKey);
  const claimDate = parseIsoDate(command.claimDate, "claimDate");
  const hash = requestHash("expense_claim_approval", { id, claimDate });
  const replay = async () => {
    const earlier = await findByKey(tx, "approve", source, idempotencyKey);
    if (!earlier) return null;
    assertSameRequest(earlier.hash, hash, "expense claim approval");
    return { created: false, claim: await getExpenseClaim(tx, earlier.id) };
  };
  const earlier = await replay();
  if (earlier) return earlier;
  const current = await lockClaim(tx, id);
  const meanwhile = await replay();
  if (meanwhile) return meanwhile;
  if (current.status !== "submitted") {
    throw new ConflictError(
      current.status === "draft" ? `${claimReference(id)} hasn't been submitted yet.` : `${claimReference(id)} is already ${current.status}.`,
    );
  }
  if (isClaimant(tx, current) && !roleAtLeast(role, "admin")) {
    throw new ForbiddenError("You can't approve your own expense claim. Ask another bookkeeper or an admin.");
  }
  const latest = current.receipts.reduce((date, receipt) => (receipt.receiptDate > date ? receipt.receiptDate : date), "");
  if (claimDate < latest) throw new ValidationError(`The claim date can't be before its latest receipt (${latest}).`);
  const receipts = await checkStillValid(tx, current);
  const payable = await controlAccountCode(tx, EXPENSE_CLAIMS_PAYABLE, "expense claims can't be approved");
  const gst = await controlAccountCode(tx, GST_ACCOUNT, "expense claims can't be approved");
  await assertPostingDateAllowed(tx, claimDate);

  const scale = currencyMinorUnits(tx.baseCurrency);
  const costs = new Map<string, { code: string; amount: Decimal; tracking: TrackingTags }>();
  for (const receipt of receipts) {
    const key = `${receipt.accountId}|${trackingKey(receipt.tracking)}`;
    const entry = costs.get(key) ?? { code: receipt.accountCode, amount: ZERO_DECIMAL, tracking: receipt.tracking };
    entry.amount = add(entry.amount, dec(receipt.netAmount));
    costs.set(key, entry);
  }
  const who = personName(tx, current.claimantEmail);
  const reference = claimReference(id);
  const posted = await postJournalBody(
    tx,
    "expense_claim:approval",
    id,
    parseJournalBody(tx, {
      postingDate: claimDate,
      reference,
      description: `Expense claim ${reference} from ${who}`,
      lines: [
        ...[...costs.values()]
          .filter((entry) => !isZero(entry.amount))
          .map((entry) => ({ accountCode: entry.code, debitAmount: toFixedString(entry.amount, scale), creditAmount: "0", description: who, tracking: entry.tracking })),
        ...(isZero(dec(current.taxTotal)) ? [] : [{ accountCode: gst, debitAmount: current.taxTotal, creditAmount: "0", description: "GST" }]),
        { accountCode: payable, debitAmount: "0", creditAmount: current.total, description: who },
      ],
    }),
    { origin: "expense_claim" },
  );
  try {
    await tx.query(
      `update expense_claims
          set status = 'approved', claim_date = $2, approval_journal_id = $3, approve_command_source = $4, approve_idempotency_key = $5,
              approve_request_hash = $6, approved_by_user_id = $7, approved_by_email = $8, approved_at = now(), updated_at = now()
        where id = $1`,
      [id, claimDate, posted.journal.id, source, idempotencyKey, hash, tx.actor.userId, tx.actor.email],
    );
  } catch (error) {
    if (isUniqueViolation(error)) throw new ConflictError("That idempotency key was already used for a different expense claim approval. Use a new key.");
    throw error;
  }
  await writeAuditEvent(tx, {
    eventType: "expense_claim.approved",
    entityType: "expense_claim",
    entityId: id,
    details: { claimDate, journalId: posted.journal.id, total: current.total },
  });
  return { created: true, claim: await getExpenseClaim(tx, id) };
}

/** Voids an approved claim with no active payments (EC7): posts the exact reversal on the void date. */
export async function voidExpenseClaim(
  tx: OrgTx,
  role: Role,
  idInput: unknown,
  command: { source?: unknown; idempotencyKey: unknown; voidDate: unknown },
): Promise<{ created: boolean; claim: ExpenseClaim }> {
  assertApprover(role);
  const id = requireId(idInput, "claimId");
  const source = optionalSource(command.source);
  const idempotencyKey = requireIdempotencyKey(command.idempotencyKey);
  const voidDate = parseIsoDate(command.voidDate, "voidDate");
  const hash = requestHash("expense_claim_void", { id, voidDate });
  const replay = async () => {
    const earlier = await findByKey(tx, "void", source, idempotencyKey);
    if (!earlier) return null;
    assertSameRequest(earlier.hash, hash, "expense claim void");
    return { created: false, claim: await getExpenseClaim(tx, earlier.id) };
  };
  const earlier = await replay();
  if (earlier) return earlier;
  const current = await lockClaim(tx, id);
  const meanwhile = await replay();
  if (meanwhile) return meanwhile;
  if (current.status === "voided") throw new ConflictError(`${claimReference(id)} has already been voided.`);
  if (current.status !== "approved") throw new ConflictError(`${claimReference(id)} isn't approved, so there's nothing to void. Decline or delete it instead.`);
  if (!isZero(dec(current.amountPaid ?? "0"))) {
    throw new ConflictError(`${claimReference(id)} has payments against it, so it can't be voided. Void its payments first.`);
  }
  if (voidDate < current.claimDate!) throw new ValidationError(`The void date can't be before the claim date (${current.claimDate}).`);
  const original = await getJournal(tx, current.approvalJournalId!);
  const posted = await postJournalBody(
    tx,
    "expense_claim:void",
    id,
    parseJournalBody(tx, {
      postingDate: voidDate,
      reference: `VOID-${original.reference}`.slice(0, 100),
      description: `Void of expense claim ${claimReference(id)} from ${personName(tx, current.claimantEmail)}`,
      lines: original.lines.map((line) => ({
        accountCode: line.accountCode,
        debitAmount: line.creditAmount,
        creditAmount: line.debitAmount,
        description: line.description,
        tracking: line.tracking,
      })),
    }),
    { origin: "expense_claim", relatedJournalId: original.id, correctionKind: "reversal" },
  );
  try {
    await tx.query(
      `update expense_claims
          set status = 'voided', void_date = $2, void_journal_id = $3, void_command_source = $4, void_idempotency_key = $5,
              void_request_hash = $6, voided_by_user_id = $7, voided_by_email = $8, voided_at = now(), updated_at = now()
        where id = $1`,
      [id, voidDate, posted.journal.id, source, idempotencyKey, hash, tx.actor.userId, tx.actor.email],
    );
  } catch (error) {
    if (isUniqueViolation(error)) throw new ConflictError("That idempotency key was already used for a different expense claim void. Use a new key.");
    throw error;
  }
  await writeAuditEvent(tx, { eventType: "expense_claim.voided", entityType: "expense_claim", entityId: id, details: { voidDate, journalId: posted.journal.id } });
  return { created: true, claim: await getExpenseClaim(tx, id) };
}

type PaymentResult = { created: boolean; payment: ExpenseClaimPayment; claim: ExpenseClaim };

async function paymentByKey(tx: OrgTx, action: "record" | "void", source: string, key: string) {
  const found = await tx.query<{ id: string; claim_id: string; hash: string }>(
    action === "record"
      ? "select id::text, claim_id::text, request_hash as hash from expense_claim_payments where command_source = $1 and idempotency_key = $2"
      : "select id::text, claim_id::text, void_request_hash as hash from expense_claim_payments where void_command_source = $1 and void_idempotency_key = $2",
    [source, key],
  );
  return found.rows[0] ?? null;
}

async function paymentResult(tx: OrgTx, claimId: string, paymentId: string, created: boolean): Promise<PaymentResult> {
  const claim = await getExpenseClaim(tx, claimId);
  const payment = claim.payments.find((entry) => entry.id === paymentId);
  if (!payment) throw new NotFoundError("Payment not found.");
  return { created, payment, claim };
}

/**
 * Pays an approved claim, in full or in part (EC4, EC5): posts Dr expense
 * claims payable / Cr the bank account on the payment date, which can't be
 * before the claim date. It can't be more than what's due.
 */
export async function recordExpenseClaimPayment(
  tx: OrgTx,
  role: Role,
  idInput: unknown,
  command: { source?: unknown; idempotencyKey: unknown; paymentDate: unknown; amount: unknown; bankAccountCode: unknown; reference?: unknown },
): Promise<PaymentResult> {
  assertApprover(role);
  const id = requireId(idInput, "claimId");
  const source = optionalSource(command.source);
  const idempotencyKey = requireIdempotencyKey(command.idempotencyKey);
  const paymentDate = parseIsoDate(command.paymentDate, "paymentDate");
  const scale = currencyMinorUnits(tx.baseCurrency);
  const amount = dec(parseDecimalInput(command.amount, "amount", { maxScale: scale }));
  const bankAccountCode = parseAccountCodeInput(command.bankAccountCode, "bankAccountCode");
  const reference = optionalString(command.reference, "reference", { maxLength: 100 });
  const hash = requestHash("expense_claim_payment", {
    id,
    paymentDate,
    amount: toPlainString(amount),
    bankAccountCode: bankAccountCode.toLowerCase(),
    reference,
  });
  const replay = async () => {
    const earlier = await paymentByKey(tx, "record", source, idempotencyKey);
    if (!earlier) return null;
    assertSameRequest(earlier.hash, hash, "payment");
    return paymentResult(tx, earlier.claim_id, earlier.id, false);
  };
  const earlier = await replay();
  if (earlier) return earlier;
  const claim = await lockClaim(tx, id);
  const meanwhile = await replay();
  if (meanwhile) return meanwhile;
  if (claim.status !== "approved") throw new ConflictError(`${claimReference(id)} is ${claim.status}, so it can't be paid. Only approved claims are paid.`);
  if (paymentDate < claim.claimDate!) throw new ValidationError(`The payment date can't be before the claim date (${claim.claimDate}).`);
  const due = dec(claim.amountDue!);
  if (isZero(due)) throw new ConflictError(`${claimReference(id)} is already paid in full.`);
  if (cmp(amount, due) > 0) throw new ValidationError(`The payment of ${toFixedString(amount, scale)} is more than the amount due (${claim.amountDue}).`);
  const bank = await resolveBankAccount(tx, bankAccountCode);
  const payable = await controlAccountCode(tx, EXPENSE_CLAIMS_PAYABLE, "expense claims can't be paid");
  const next = await tx.query<{ id: string }>("select nextval(pg_get_serial_sequence('expense_claim_payments', 'id'))::text as id");
  const paymentId = next.rows[0].id;
  const fixed = toFixedString(amount, scale);
  const claimant = personName(tx, claim.claimantEmail);
  const posted = await postJournalBody(
    tx,
    "expense_claim_payment:record",
    paymentId,
    parseJournalBody(tx, {
      postingDate: paymentDate,
      reference: reference ?? claimReference(id),
      description: `Payment of expense claim ${claimReference(id)} to ${claimant}`,
      lines: [
        { accountCode: payable, debitAmount: fixed, creditAmount: "0", description: claimant },
        { accountCode: bank.code, debitAmount: "0", creditAmount: fixed, description: claimant },
      ],
    }),
    { origin: "expense_claim_payment" },
  );
  try {
    await tx.query(
      `insert into expense_claim_payments (id, command_source, idempotency_key, request_hash, claim_id, payment_date, amount,
                                           bank_account_id, reference, journal_id, created_by_user_id, created_by_email)
       values ($1, $2, $3, $4, $5, $6, $7::numeric, $8, $9, $10, $11, $12)`,
      [paymentId, source, idempotencyKey, hash, id, paymentDate, fixed, bank.id, reference, posted.journal.id, tx.actor.userId, tx.actor.email],
    );
  } catch (error) {
    if (isUniqueViolation(error)) throw new ConflictError("That idempotency key was already used for a different payment. Use a new key for a new payment.");
    throw error;
  }
  await writeAuditEvent(tx, {
    eventType: "expense_claim_payment.recorded",
    entityType: "expense_claim_payment",
    entityId: paymentId,
    details: { claimId: id, paymentDate, amount: fixed, bankAccountCode: bank.code, journalId: posted.journal.id },
  });
  return paymentResult(tx, id, paymentId, true);
}

/** Voids a payment (EC5): the exact reversal on the void date; the amount is due again. */
export async function voidExpenseClaimPayment(
  tx: OrgTx,
  role: Role,
  idInput: unknown,
  paymentIdInput: unknown,
  command: { source?: unknown; idempotencyKey: unknown; voidDate: unknown },
): Promise<PaymentResult> {
  assertApprover(role);
  const id = requireId(idInput, "claimId");
  const paymentId = requireId(paymentIdInput, "paymentId");
  const source = optionalSource(command.source);
  const idempotencyKey = requireIdempotencyKey(command.idempotencyKey);
  const voidDate = parseIsoDate(command.voidDate, "voidDate");
  const onClaim = await tx.query("select 1 from expense_claim_payments where id = $1 and claim_id = $2", [paymentId, id]);
  if (onClaim.rowCount === 0) throw new NotFoundError("Payment not found.");
  const hash = requestHash("expense_claim_payment_void", { paymentId, voidDate });
  const replay = async () => {
    const earlier = await paymentByKey(tx, "void", source, idempotencyKey);
    if (!earlier) return null;
    assertSameRequest(earlier.hash, hash, "payment void");
    return paymentResult(tx, earlier.claim_id, earlier.id, false);
  };
  const earlier = await replay();
  if (earlier) return earlier;
  const claim = await lockClaim(tx, id);
  const meanwhile = await replay();
  if (meanwhile) return meanwhile;
  const payment = claim.payments.find((entry) => entry.id === paymentId)!;
  if (payment.status === "voided") throw new ConflictError("This payment has already been voided.");
  if (voidDate < payment.paymentDate) throw new ValidationError(`The void date can't be before the payment date (${payment.paymentDate}).`);
  const original = await getJournal(tx, payment.journalId);
  const posted = await postJournalBody(
    tx,
    "expense_claim_payment:void",
    paymentId,
    parseJournalBody(tx, {
      postingDate: voidDate,
      reference: `VOID-${original.reference}`.slice(0, 100),
      description: `Void of payment of expense claim ${claimReference(id)}`,
      lines: original.lines.map((line) => ({
        accountCode: line.accountCode,
        debitAmount: line.creditAmount,
        creditAmount: line.debitAmount,
        description: line.description,
        tracking: line.tracking,
      })),
    }),
    { origin: "expense_claim_payment", relatedJournalId: original.id, correctionKind: "reversal" },
  );
  try {
    await tx.query(
      `update expense_claim_payments
          set status = 'voided', void_date = $2, void_journal_id = $3, void_command_source = $4, void_idempotency_key = $5,
              void_request_hash = $6, voided_by_user_id = $7, voided_by_email = $8, voided_at = now()
        where id = $1`,
      [paymentId, voidDate, posted.journal.id, source, idempotencyKey, hash, tx.actor.userId, tx.actor.email],
    );
  } catch (error) {
    if (isUniqueViolation(error)) throw new ConflictError("That idempotency key was already used for a different payment void. Use a new key.");
    throw error;
  }
  await writeAuditEvent(tx, {
    eventType: "expense_claim_payment.voided",
    entityType: "expense_claim_payment",
    entityId: paymentId,
    details: { claimId: id, voidDate, amount: payment.amount, journalId: posted.journal.id },
  });
  return paymentResult(tx, id, paymentId, true);
}
