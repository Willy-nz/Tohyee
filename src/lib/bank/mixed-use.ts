import { aiGstRefusal, GST_EVIDENCE, type GstEvidence } from "@/lib/ai/gst-evidence";
import { isBankOrCreditCard } from "@/lib/accounts/types";
import { writeAuditEvent } from "@/lib/audit";
import { lineErrorText } from "@/lib/bank/bulk";
import { getStatementLine, lockStatementLine, type StatementLine } from "@/lib/bank/accounts";
import {
  type AccountUsage,
  ACCOUNT_USAGES,
  claimsGst,
  decisionRefusal,
  lineParts,
  personGstRefusal,
  REVIEW_DECISIONS,
  type ReviewDecision,
  refundRefusal,
  type RefundPair,
  USAGE_LABELS,
} from "@/lib/bank/mixed-use-rules";
import { createBankTransaction, getBankTransaction, voidBankTransaction } from "@/lib/bank/transactions";
import { type ActionWork, createBatch, type NewBatchAction, runBatch, type RunOptions, type RunOutcome } from "@/lib/batches/service";
import type { OrgRunner, OrgTx } from "@/lib/db/org-transaction";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { assertSameRequest, requestHash } from "@/lib/idempotency";
import { getJournal, parseJournalBody, postJournalBody } from "@/lib/ledger/journals";
import { assertPostingDateAllowed } from "@/lib/ledger/period-controls";
import { add, dec, parseDecimalInput, toFixedString, ZERO_DECIMAL } from "@/lib/money/decimal";
import { getGstRegistration, gstStatusOn } from "@/lib/tax/registration";
import { asRecord, optionalSource, optionalString, requireArray, requireId, requireIdempotencyKey, requireOneOf, requireString } from "@/lib/validation";

/**
 * Personal and mixed-use bank and card accounts (#545, examples MU1-MU14,
 * decisions 1308-1315). A mixed-use or personal account's lines are
 * reviewed, never reconciled:
 *
 * - business (money out): spend money on the account for the whole line
 *   (Dr expense, Dr GST / Cr the account) and an owner journal (Dr the
 *   account / Cr the owner account), both on the line's date (MU2);
 * - split: the same for the business part; the private part posts nothing (MU4);
 * - private: nothing posted (MU3);
 * - refund (money in): receive money with the original's accounts and tax
 *   codes, and the owner journal the other way (MU8).
 *
 * So the account's balance in the books is always 0.00; the database checks
 * that at commit, refuses reconciling these lines, and keeps a reviewed line
 * as it is until its review is undone (tenant migration 0219).
 */

export type UsageAccount = {
  accountId: string;
  code: string;
  name: string;
  accountType: "bank" | "credit_card";
  usage: AccountUsage;
  usageLabel: string;
  ownerAccount: { code: string; name: string } | null;
  changedAt: string | null;
  changedByEmail: string | null;
  toReview: number;
  reviewed: number;
};

type UsageRow = {
  id: string;
  code: string;
  name: string;
  account_type: "bank" | "credit_card";
  usage: AccountUsage | null;
  owner_code: string | null;
  owner_name: string | null;
  changed_at: string | null;
  changed_by_email: string | null;
  to_review: string;
  reviewed: string;
};

const USAGE_SELECT = `
  select a.id::text, a.code, a.name, a.account_type, u.usage, o.code as owner_code, o.name as owner_name,
         u.changed_at::text, u.changed_by_email,
         (select count(*) from bank_statement_lines l where l.account_id = a.id and l.status = 'unreconciled')::text as to_review,
         (select count(*) from mixed_use_reviews r join bank_statement_lines l on l.id = r.statement_line_id
           where l.account_id = a.id and r.status = 'active' and l.status <> 'deleted')::text as reviewed
    from accounts a
    left join bank_account_usage u on u.account_id = a.id
    left join accounts o on o.id = u.owner_account_id
   where a.account_type in ('bank', 'credit_card')`;

function toUsageAccount(row: UsageRow): UsageAccount {
  const usage = row.usage ?? "business";
  return {
    accountId: row.id,
    code: row.code,
    name: row.name,
    accountType: row.account_type,
    usage,
    usageLabel: USAGE_LABELS[usage],
    ownerAccount: row.owner_code ? { code: row.owner_code, name: row.owner_name ?? "" } : null,
    changedAt: row.changed_at,
    changedByEmail: row.changed_by_email,
    toReview: usage === "business" ? 0 : Number(row.to_review),
    reviewed: Number(row.reviewed),
  };
}

/** Every bank and credit card account with how it's used (MU1). */
export async function listAccountUsage(tx: OrgTx): Promise<UsageAccount[]> {
  const rows = await tx.query<UsageRow>(`${USAGE_SELECT} and a.is_active order by a.code`);
  return rows.rows.map(toUsageAccount);
}

export async function getAccountUsage(tx: OrgTx, accountIdInput: unknown): Promise<UsageAccount> {
  const accountId = requireId(accountIdInput, "accountId");
  const row = (await tx.query<UsageRow>(`${USAGE_SELECT} and a.id = $1`, [accountId])).rows[0];
  if (!row) throw new NotFoundError("Bank or credit card account not found.");
  return toUsageAccount(row);
}

async function usageOf(tx: OrgTx, accountId: string): Promise<{ usage: AccountUsage; ownerAccountId: string | null }> {
  const row = (await tx.query<{ usage: AccountUsage; owner_account_id: string | null }>(
    "select usage, owner_account_id::text from bank_account_usage where account_id = $1",
    [accountId],
  )).rows[0];
  return { usage: row?.usage ?? "business", ownerAccountId: row?.owner_account_id ?? null };
}

/** Ends the active reviews these conditions pick, without posting anything (they're all private). */
async function endPrivateReviews(tx: OrgTx, accountId: string, where: "automatic" | "private", reason: string): Promise<string[]> {
  const ended = await tx.query<{ statement_line_id: string }>(
    `update mixed_use_reviews r
        set status = 'undone', undone_at = now(), undone_by_user_id = $2, undone_by_email = $3, undone_via = $4, undo_reason = $5
       from bank_statement_lines l
      where l.id = r.statement_line_id and l.account_id = $1 and r.status = 'active'
        and ${where === "automatic" ? "r.automatic" : "r.decision = 'private'"}
      returning r.statement_line_id::text`,
    [accountId, tx.actor.userId, tx.actor.email, tx.actor.via ?? null, reason],
  );
  return ended.rows.map((row) => row.statement_line_id);
}

/** MU12: the account's lines not yet reviewed become private, automatically. */
async function makeUnreviewedPrivate(tx: OrgTx, accountId: string): Promise<number> {
  const made = await tx.query(
    `with lines as (
       update bank_statement_lines set status = 'excluded', updated_at = now()
        where account_id = $1 and status = 'unreconciled'
        returning id, amount)
     insert into mixed_use_reviews (statement_line_id, decision, private_amount, automatic)
     select id, 'private', abs(amount), true from lines`,
    [accountId],
  );
  return made.rowCount ?? 0;
}

/**
 * Sets how an account is used (MU1, MU12, MU13). An admin only (the route).
 * Mixed use and personal need an owner account (equity) and an account in
 * the base currency with nothing in the business books yet.
 */
export async function setAccountUsage(
  tx: OrgTx,
  accountIdInput: unknown,
  input: { usage: unknown; ownerAccountCode?: unknown },
): Promise<UsageAccount> {
  const accountId = requireId(accountIdInput, "accountId");
  const usage = requireOneOf(input.usage, "usage", ACCOUNT_USAGES);
  const account = (await tx.query<{ id: string; code: string; name: string; account_type: string; currency_code: string | null; is_active: boolean }>(
    "select id::text, code, name, account_type, currency_code, is_active from accounts where id = $1 for update",
    [accountId],
  )).rows[0];
  if (!account || !isBankOrCreditCard(account.account_type)) throw new NotFoundError("Bank or credit card account not found.");
  const label = `${account.code} (${account.name})`;
  const current = await usageOf(tx, accountId);
  let ownerAccountId: string | null = null;
  if (usage !== "business") {
    if (!account.is_active) throw new ValidationError(`${label} is archived.`);
    if (account.currency_code && account.currency_code !== tx.baseCurrency) {
      throw new ValidationError(`Mixed use and personal are for accounts in ${tx.baseCurrency}. ${label} is in ${account.currency_code}.`);
    }
    const ownerCode = optionalString(input.ownerAccountCode, "ownerAccountCode", { maxLength: 20 });
    const owner = (await tx.query<{ id: string; code: string; name: string; account_class: string; is_active: boolean; system_key: string | null }>(
      ownerCode
        ? "select id::text, code, name, account_class, is_active, system_key from accounts where lower(code) = lower($1)"
        : "select id::text, code, name, account_class, is_active, system_key from accounts where id = coalesce($1::bigint, (select id from accounts where code = '3000'))",
      [ownerCode ?? current.ownerAccountId],
    )).rows[0];
    if (!owner) throw new ValidationError(ownerCode ? `There's no account with the code ${ownerCode}.` : "Choose the owner's equity account (e.g. 3000 Owner funds introduced).");
    if (owner.account_class !== "equity" || owner.system_key === "retained_earnings" || owner.system_key === "conversion_clearing" || !owner.is_active) {
      throw new ValidationError(`The owner account must be an active equity account for the owner, such as 3000 Owner funds introduced. ${owner.code} (${owner.name}) isn't.`);
    }
    ownerAccountId = owner.id;
  } else if (current.usage !== "business") {
    const kept = await tx.query<{ n: string }>(
      `select count(*)::text as n from mixed_use_reviews r join bank_statement_lines l on l.id = r.statement_line_id
        where l.account_id = $1 and r.status = 'active' and r.decision <> 'private'`,
      [accountId],
    );
    if (Number(kept.rows[0].n) > 0) {
      throw new ConflictError(
        `${label} has ${kept.rows[0].n} business, split or refund ${kept.rows[0].n === "1" ? "line" : "lines"} in the books. Undo those reviews first, then make it business only.`,
      );
    }
  }

  let madePrivate = 0;
  let backToReview = 0;
  if (current.usage === "personal" && usage === "mixed") {
    // MU12: the lines that were private only because the account was personal go back to review.
    const lines = await endPrivateReviews(tx, accountId, "automatic", "Account changed to mixed use");
    if (lines.length) {
      await tx.query("update bank_statement_lines set status = 'unreconciled', updated_at = now() where id = any($1::bigint[]) and status = 'excluded'", [lines]);
    }
    backToReview = lines.length;
  }
  if (usage === "business" && current.usage !== "business") {
    // MU13: private reviews end; their lines stay excluded.
    await endPrivateReviews(tx, accountId, "private", "Account changed to business only");
  }
  await tx.query(
    `insert into bank_account_usage (account_id, usage, owner_account_id, changed_by_email, changed_at)
     values ($1, $2, $3, $4, now())
     on conflict (account_id) do update set usage = excluded.usage, owner_account_id = excluded.owner_account_id,
       changed_by_email = excluded.changed_by_email, changed_at = now()`,
    [accountId, usage, ownerAccountId, tx.actor.email],
  );
  if (usage === "personal" && current.usage !== "personal") madePrivate = await makeUnreviewedPrivate(tx, accountId);
  await writeAuditEvent(tx, {
    eventType: "bank_account.usage_changed",
    entityType: "account",
    entityId: accountId,
    details: { from: current.usage, to: usage, ownerAccountId, madePrivate, backToReview },
  });
  return getAccountUsage(tx, accountId);
}

// ---------------------------------------------------------------------------
// Lines and their reviews
// ---------------------------------------------------------------------------

export type ReviewPart = { accountCode: string; accountName: string; taxCode: string | null; amount: string; description: string };

export type ReviewView = {
  id: string;
  decision: ReviewDecision;
  businessAmount: string;
  privateAmount: string;
  automatic: boolean;
  gstEvidence: string | null;
  bankTransactionId: string | null;
  ownerJournalId: string | null;
  contactId: string | null;
  contactName: string | null;
  parts: ReviewPart[];
  refundOfLineId: string | null;
  createdByEmail: string | null;
  createdVia: string | null;
  createdAt: string;
};

export type ReviewLine = {
  id: string;
  accountId: string;
  date: string;
  amount: string;
  description: string;
  payee: string | null;
  reference: string | null;
  /** to_review: waiting; reviewed: has an active review; excluded: left out as a duplicate (BK12), no review. */
  state: "to_review" | "reviewed" | "excluded";
  possibleDuplicateOf: string | null;
  /** MU7: money in that matches money out of a business-only account within 2 days. */
  looksLikePaymentFrom: string | null;
  review: ReviewView | null;
};

type ReviewLineRow = {
  id: string;
  account_id: string;
  line_date: string;
  amount: string;
  description: string;
  payee: string | null;
  reference: string | null;
  status: string;
  possible_duplicate_of: string | null;
  payment_from: string | null;
  review: (Omit<ReviewView, "businessAmount" | "privateAmount"> & { businessAmount: string; privateAmount: string }) | null;
};

const LINE_SELECT = `
  select l.id::text, l.account_id::text, l.line_date::text, l.amount::text, l.description, l.payee, l.reference, l.status,
         l.possible_duplicate_of::text,
         case when l.amount > 0 then (
           select a.code || ' ' || a.name from bank_statement_lines o join accounts a on a.id = o.account_id
            where o.amount = -l.amount and o.status <> 'deleted' and o.account_id <> l.account_id
              and abs(o.line_date - l.line_date) <= 2 and tohyee_account_usage(o.account_id) = 'business'
            order by abs(o.line_date - l.line_date), o.id limit 1) end as payment_from,
         (select jsonb_build_object(
                   'id', r.id::text, 'decision', r.decision, 'businessAmount', r.business_amount::text,
                   'privateAmount', r.private_amount::text, 'automatic', r.automatic, 'gstEvidence', r.gst_evidence,
                   'bankTransactionId', r.bank_transaction_id::text, 'ownerJournalId', r.owner_journal_id::text,
                   'contactId', t.contact_id::text, 'contactName', c.name,
                   'parts', coalesce((select jsonb_agg(jsonb_build_object('accountCode', la.code, 'accountName', la.name, 'taxCode', tc.code,
                                                       'amount', bl.line_amount::text, 'description', bl.description) order by bl.line_order)
                                        from bank_transaction_lines bl join accounts la on la.id = bl.account_id
                                        left join tax_codes tc on tc.id = bl.tax_code_id
                                       where bl.bank_transaction_id = r.bank_transaction_id), '[]'::jsonb),
                   'refundOfLineId', ro.statement_line_id::text,
                   'createdByEmail', r.created_by_email, 'createdVia', r.created_via, 'createdAt', r.created_at)
            from mixed_use_reviews r
            left join bank_transactions t on t.id = r.bank_transaction_id
            left join contacts c on c.id = t.contact_id
            left join mixed_use_reviews ro on ro.id = r.refund_of_review_id
           where r.statement_line_id = l.id and r.status = 'active') as review
    from bank_statement_lines l`;

function toReviewLine(row: ReviewLineRow): ReviewLine {
  const money = (value: string) => toFixedString(dec(value), 2);
  return {
    id: row.id,
    accountId: row.account_id,
    date: row.line_date,
    amount: money(row.amount),
    description: row.description,
    payee: row.payee,
    reference: row.reference,
    state: row.review ? "reviewed" : row.status === "unreconciled" ? "to_review" : "excluded",
    possibleDuplicateOf: row.possible_duplicate_of,
    looksLikePaymentFrom: row.payment_from,
    review: row.review
      ? {
          ...row.review,
          businessAmount: money(row.review.businessAmount),
          privateAmount: money(row.review.privateAmount),
          parts: row.review.parts.map((part) => ({ ...part, amount: money(part.amount) })),
        }
      : null,
  };
}

export const REVIEW_STATES = ["to_review", "reviewed", "excluded", "all"] as const;

/** A mixed-use or personal account's lines, newest first, with their reviews (MU2-MU12). */
export async function listReviewLines(
  tx: OrgTx,
  accountIdInput: unknown,
  options: { state?: unknown; limit?: unknown; search?: unknown } = {},
): Promise<{ account: UsageAccount; lines: ReviewLine[] }> {
  const account = await getAccountUsage(tx, accountIdInput);
  const state = options.state == null || options.state === "" ? "to_review" : requireOneOf(options.state, "state", REVIEW_STATES);
  const limitRaw = Number(options.limit ?? 100);
  const limit = Number.isInteger(limitRaw) && limitRaw > 0 && limitRaw <= 500 ? limitRaw : 100;
  const search = optionalString(options.search, "search", { maxLength: 100 });
  const filter =
    state === "to_review"
      ? "and l.status = 'unreconciled'"
      : state === "reviewed"
        ? "and exists (select 1 from mixed_use_reviews r where r.statement_line_id = l.id and r.status = 'active')"
        : state === "excluded"
          ? "and l.status = 'excluded' and not exists (select 1 from mixed_use_reviews r where r.statement_line_id = l.id and r.status = 'active')"
          : "";
  const rows = await tx.query<ReviewLineRow>(
    `${LINE_SELECT}
      where l.account_id = $1 and l.status <> 'deleted' ${filter}
        and ($3::text is null or l.description ilike '%' || $3 || '%' or coalesce(l.payee, '') ilike '%' || $3 || '%')
      order by l.line_date desc, l.id desc limit $2`,
    [account.accountId, limit, search],
  );
  return { account, lines: rows.rows.map(toReviewLine) };
}

export async function getReviewLine(tx: OrgTx, lineIdInput: unknown): Promise<ReviewLine> {
  const lineId = requireId(lineIdInput, "lineId");
  const row = (await tx.query<ReviewLineRow>(`${LINE_SELECT} where l.id = $1`, [lineId])).rows[0];
  if (!row) throw new NotFoundError("Statement line not found.");
  return toReviewLine(row);
}

type ParsedPart = { description: string; accountCode: string; taxCode: string | null; amount: string; tracking?: Record<string, unknown> };

type ParsedReview = {
  decision: ReviewDecision;
  businessAmount: string | null;
  contactId: string | null;
  parts: ParsedPart[];
  gstEvidence: GstEvidence | null;
  refundOfLineId: string | null;
  notDuplicate: boolean;
};

/** A positive amount with at most 2 places, or null when it wasn't given. */
function parseDecimalInputOrNull(input: unknown, label: string): string | null {
  if (input == null || input === "") return null;
  return parseDecimalInput(input, label, { maxScale: 2 });
}

function parseReview(input: Record<string, unknown>, fallbackDescription: string): ParsedReview {
  const decision = requireOneOf(input.decision, "decision", REVIEW_DECISIONS);
  const posts = decision !== "private";
  const parts: ParsedPart[] = posts
    ? requireArray(input.lines, "lines", 20).map((raw, index) => {
        const label = `Line ${index + 1}`;
        const entry = asRecord(raw, label);
        const taxCode = optionalString(entry.taxCode, `${label} taxCode`, { maxLength: 20 });
        return {
          description: optionalString(entry.description, `${label} description`, { maxLength: 500 }) ?? fallbackDescription.slice(0, 500),
          accountCode: requireString(entry.accountCode, `${label} accountCode`, { maxLength: 20 }),
          taxCode,
          amount: parseDecimalInputOrNull(entry.amount, `${label} amount`) ?? "",
          ...(entry.tracking && typeof entry.tracking === "object" ? { tracking: entry.tracking as Record<string, unknown> } : {}),
        };
      })
    : [];
  if (posts && parts.length === 0) throw new ValidationError("Add at least one line for the business part.");
  if (parts.some((part) => part.amount === "")) throw new ValidationError("Each line needs an amount.");
  const gstEvidence =
    input.gstEvidence == null || input.gstEvidence === "" ? null : requireOneOf(input.gstEvidence, "gstEvidence", GST_EVIDENCE);
  return {
    decision,
    businessAmount: decision === "split" ? parseDecimalInputOrNull(input.businessAmount, "businessAmount") : null,
    contactId: input.contactId == null || input.contactId === "" ? null : requireId(input.contactId, "contactId"),
    parts,
    gstEvidence,
    refundOfLineId: decision === "refund" ? requireId(input.refundOfLineId, "refundOfLineId") : null,
    notDuplicate: input.notDuplicate === true,
  };
}

export type ReviewResult = { created: boolean; line: ReviewLine };

type ActiveReview = { id: string; decision: ReviewDecision; automatic: boolean; command_source: string | null; recent: boolean; bank_transaction_id: string | null; owner_journal_id: string | null };

async function activeReview(tx: OrgTx, lineId: string): Promise<ActiveReview | null> {
  return (
    (await tx.query<ActiveReview>(
      `select id::text, decision, automatic, command_source, created_at > now() - interval '24 hours' as recent,
              bank_transaction_id::text, owner_journal_id::text
         from mixed_use_reviews where statement_line_id = $1 and status = 'active'`,
      [lineId],
    )).rows[0] ?? null
  );
}

/**
 * Reviews one line (MU2-MU8, MU11, MU12). `ai`: the GST evidence rules for
 * an AI (GSR10) instead of a person's receipt tick (MU5).
 */
export async function reviewLine(
  tx: OrgTx,
  lineIdInput: unknown,
  input: Record<string, unknown>,
  options: { ai?: boolean } = {},
): Promise<ReviewResult> {
  const lineId = requireId(lineIdInput, "lineId");
  const source = optionalSource(input.source);
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  if (idempotencyKey.length > 110) throw new ValidationError("idempotencyKey must be at most 110 characters for a review.");
  const replay = async (): Promise<ReviewResult | null> => {
    const earlier = (await tx.query<{ statement_line_id: string; request_hash: string }>(
      "select statement_line_id::text, request_hash from mixed_use_reviews where command_source = $1 and idempotency_key = $2",
      [source, idempotencyKey],
    )).rows[0];
    if (!earlier) return null;
    if (earlier.statement_line_id !== lineId) throw new ConflictError("That idempotency key was already used to review another line.");
    assertSameRequest(earlier.request_hash, hash, "review");
    return { created: false, line: await getReviewLine(tx, lineId) };
  };
  const firstLook = await getStatementLine(tx, lineId);
  const parsed = parseReview(input, firstLook.payee ?? firstLook.description);
  const hash = requestHash("mixed_use_review", { lineId, ...parsed });
  const earlier = await replay();
  if (earlier) return earlier;
  const line = await lockStatementLine(tx, lineId);
  const committed = await replay();
  if (committed) return committed;

  const usage = await usageOf(tx, line.accountId);
  if (usage.usage === "business") throw new ValidationError("This account is business only, so its lines are reconciled, not reviewed.");
  if (line.status === "deleted") throw new ConflictError("This line's import was deleted.");
  const current = await activeReview(tx, lineId);
  if (current && !current.automatic) throw new ConflictError(`This line is already reviewed as ${current.decision}. Undo that first.`);
  if (!current && line.status === "excluded") throw new ConflictError("This line is excluded (e.g. a duplicate). Include it again before reviewing it.");
  if (line.status === "reconciled") throw new ConflictError("This line is reconciled.");
  const refusal = decisionRefusal(parsed.decision, line.amount);
  if (refusal) throw new ValidationError(refusal);
  await assertPostingDateAllowed(tx, line.date);

  let parts: { business: string; private: string };
  try {
    const businessTyped =
      parsed.decision === "refund"
        ? toFixedString(parsed.parts.reduce((total, part) => add(total, dec(part.amount)), ZERO_DECIMAL), 2)
        : parsed.businessAmount;
    parts = lineParts(parsed.decision, line.amount, businessTyped);
  } catch (error) {
    throw new ValidationError(error instanceof Error ? error.message : "The amounts don't add up.");
  }
  const posts = parsed.decision !== "private";
  if (posts) {
    const linesTotal = toFixedString(parsed.parts.reduce((total, part) => add(total, dec(part.amount)), ZERO_DECIMAL), 2);
    if (linesTotal !== parts.business) {
      throw new ValidationError(`The lines add up to ${linesTotal}, but the business part is ${parts.business}.`);
    }
    // MU11: a possible duplicate of a line already in the books waits for the person to say it isn't one.
    if (line.possibleDuplicateOf && !parsed.notDuplicate) {
      const other = await activeReview(tx, line.possibleDuplicateOf);
      if (other && other.decision !== "private") {
        throw new ConflictError(
          `This line looks like a duplicate of line ${line.possibleDuplicateOf}, which is already reviewed as ${other.decision}. If it really is a separate purchase, say it isn't a duplicate; otherwise mark it private or exclude it.`,
        );
      }
    }
  }

  let refundOf: { id: string; contactId: string } | null = null;
  if (parsed.decision === "refund") {
    const original = (await tx.query<{ id: string; decision: ReviewDecision; account_id: string; bank_transaction_id: string; contact_id: string }>(
      `select r.id::text, r.decision, l.account_id::text, r.bank_transaction_id::text, t.contact_id::text
         from mixed_use_reviews r join bank_statement_lines l on l.id = r.statement_line_id
         left join bank_transactions t on t.id = r.bank_transaction_id
        where r.statement_line_id = $1 and r.status = 'active'`,
      [parsed.refundOfLineId],
    )).rows[0];
    if (!original || original.account_id !== line.accountId || (original.decision !== "business" && original.decision !== "split")) {
      throw new ValidationError("A refund must be of a purchase on this account that's reviewed as business or split.");
    }
    const pairs = async (where: string, value: string): Promise<RefundPair[]> =>
      (
        await tx.query<RefundPair>(
          `select a.code as "accountCode", tc.code as "taxCode", bl.line_amount::text as amount
             from mixed_use_reviews r join bank_transaction_lines bl on bl.bank_transaction_id = r.bank_transaction_id
             join accounts a on a.id = bl.account_id left join tax_codes tc on tc.id = bl.tax_code_id
            where ${where} and r.status = 'active'`,
          [value],
        )
      ).rows;
    const why = refundRefusal(await pairs("r.id = $1", original.id), await pairs("r.refund_of_review_id = $1", original.id), parsed.parts);
    if (why) throw new ValidationError(why);
    refundOf = { id: original.id, contactId: original.contact_id };
  }

  let gstEvidence: GstEvidence | null = parsed.gstEvidence;
  if (posts && parsed.decision !== "refund") {
    const codes = parsed.parts.map((part) => part.taxCode);
    const known = codes.filter((code): code is string => code !== null);
    const found = known.length
      ? (await tx.query<{ code: string; category: string }>("select code, category from tax_codes where code = any($1::text[])", [known])).rows
      : [];
    const categories = codes.map((code) => (code === null ? null : (found.find((row) => row.code === code)?.category ?? "standard")));
    const registration = await getGstRegistration(tx);
    const status = gstStatusOn(registration, line.date);
    const why = options.ai
      ? aiGstRefusal(status, parsed.gstEvidence ?? undefined, categories as never, registration.organisationName)
      : personGstRefusal(status, claimsGst(categories), parsed.gstEvidence === "tax_document");
    if (why) throw new ValidationError(why);
  } else if (!posts) {
    gstEvidence = null;
  }

  // A personal account's automatic "private" gives way to the person's review (MU12).
  if (current?.automatic) {
    await tx.query(
      `update mixed_use_reviews set status = 'undone', undone_at = now(), undone_by_user_id = $2, undone_by_email = $3, undone_via = $4,
              undo_reason = 'Reviewed by a person' where id = $1`,
      [current.id, tx.actor.userId, tx.actor.email, tx.actor.via ?? null],
    );
  }

  let bankTransactionId: string | null = null;
  let ownerJournalId: string | null = null;
  if (posts) {
    const contactId = parsed.contactId ?? refundOf?.contactId ?? null;
    if (!contactId) throw new ValidationError("Choose who the purchase was from (the contact).");
    const moneyOut = line.amount.startsWith("-");
    const account = (await tx.query<{ code: string; name: string }>("select code, name from accounts where id = $1", [line.accountId])).rows[0];
    const owner = (await tx.query<{ code: string }>("select code from accounts where id = $1", [usage.ownerAccountId])).rows[0];
    const reference = (line.reference ?? line.payee ?? line.description).slice(0, 100);
    const made = await createBankTransaction(
      tx,
      {
        source,
        idempotencyKey: `${idempotencyKey}:bt`,
        kind: moneyOut ? "spend" : "receive",
        accountId: line.accountId,
        contactId,
        date: line.date,
        reference,
        amountsMode: "inclusive",
        lines: parsed.parts,
      },
      { expectedTotal: parts.business },
    );
    bankTransactionId = made.bankTransaction.id;
    const forAccount = moneyOut ? { debitAmount: parts.business } : { creditAmount: parts.business };
    const forOwner = moneyOut ? { creditAmount: parts.business } : { debitAmount: parts.business };
    const posted = await postJournalBody(
      tx,
      source,
      `${idempotencyKey}:owner`,
      parseJournalBody(
        tx,
        {
          postingDate: line.date,
          reference: reference,
          description: moneyOut
            ? `Paid by the owner from ${account.code} ${account.name}: ${made.bankTransaction.contactName}`.slice(0, 500)
            : `Refund to the owner's ${account.code} ${account.name}: ${made.bankTransaction.contactName}`.slice(0, 500),
          lines: [
            { accountCode: account.code, ...forAccount, description: "Owner's account, not a business balance" },
            { accountCode: owner.code, ...forOwner, description: moneyOut ? "Paid personally by the owner" : "Refunded to the owner" },
          ],
        },
        { internal: true },
      ),
      { origin: "bank_transaction" },
    );
    ownerJournalId = posted.journal.id;
  }

  // The line first: once its review is in, the database keeps it as it is (MU10).
  if (line.status !== "excluded") {
    await tx.query("update bank_statement_lines set status = 'excluded', updated_at = now() where id = $1", [lineId]);
  }
  const inserted = await tx.query<{ id: string }>(
    `insert into mixed_use_reviews (command_source, idempotency_key, request_hash, statement_line_id, decision, business_amount,
       private_amount, refund_of_review_id, bank_transaction_id, owner_journal_id, gst_evidence, not_duplicate,
       created_by_user_id, created_by_email, created_via)
     values ($1, $2, $3, $4, $5, $6::numeric, $7::numeric, $8, $9, $10, $11, $12, $13, $14, $15) returning id::text`,
    [
      source,
      idempotencyKey,
      hash,
      lineId,
      parsed.decision,
      parts.business,
      parts.private,
      refundOf?.id ?? null,
      bankTransactionId,
      ownerJournalId,
      gstEvidence,
      parsed.notDuplicate,
      tx.actor.userId,
      tx.actor.email,
      tx.actor.via ?? null,
    ],
  );
  await writeAuditEvent(tx, {
    eventType: "statement_line.reviewed",
    entityType: "bank_statement_line",
    entityId: lineId,
    details: { reviewId: inserted.rows[0].id, decision: parsed.decision, business: parts.business, private: parts.private, bankTransactionId, ownerJournalId },
  });
  return { created: true, line: await getReviewLine(tx, lineId) };
}

/**
 * Undoes a line's review (MU9): what it posted is voided on the line's date
 * (the spend or receive money, and the owner journal reversed), and the line
 * goes back to review, or to private on a personal account. `onlySource`
 * and `withinHours`: an AI undoing only its own recent reviews (AIB8).
 */
export async function undoReview(
  tx: OrgTx,
  lineIdInput: unknown,
  command: { source?: unknown; idempotencyKey: unknown },
  options: { onlySource?: string; withinHours?: number } = {},
): Promise<ReviewResult> {
  const lineId = requireId(lineIdInput, "lineId");
  const source = optionalSource(command.source);
  const idempotencyKey = requireIdempotencyKey(command.idempotencyKey);
  if (idempotencyKey.length > 110) throw new ValidationError("idempotencyKey must be at most 110 characters for an undo.");
  const hash = requestHash("mixed_use_review_undo", { lineId });
  const replay = async (): Promise<ReviewResult | null> => {
    const earlier = (await tx.query<{ statement_line_id: string; undo_request_hash: string }>(
      "select statement_line_id::text, undo_request_hash from mixed_use_reviews where undo_command_source = $1 and undo_idempotency_key = $2",
      [source, idempotencyKey],
    )).rows[0];
    if (!earlier) return null;
    assertSameRequest(earlier.undo_request_hash, hash, "undo");
    return { created: false, line: await getReviewLine(tx, earlier.statement_line_id) };
  };
  const earlier = await replay();
  if (earlier) return earlier;
  const line: StatementLine = await lockStatementLine(tx, lineId);
  const again = await replay();
  if (again) return again;
  const review = await activeReview(tx, lineId);
  if (!review) throw new ConflictError("This line isn't reviewed.");
  if (review.automatic) throw new ConflictError("This line is private because the account is personal. Review it as business to change it.");
  if (options.onlySource) {
    const person = "A person can undo it in Tohyee.";
    if (review.command_source !== options.onlySource) throw new ConflictError(`This line was reviewed by a person or another AI connection. ${person}`);
    if (!review.recent) throw new ConflictError(`This connection reviewed the line more than ${options.withinHours ?? 24} hours ago. ${person}`);
  }
  await assertPostingDateAllowed(tx, line.date);
  const refunds = await tx.query("select 1 from mixed_use_reviews where refund_of_review_id = $1 and status = 'active'", [review.id]);
  if (refunds.rowCount) throw new ConflictError("A refund of this purchase is reviewed. Undo the refund first.");

  await tx.query(
    `update mixed_use_reviews
        set status = 'undone', undo_command_source = $2, undo_idempotency_key = $3, undo_request_hash = $4,
            undone_by_user_id = $5, undone_by_email = $6, undone_via = $7, undone_at = now()
      where id = $1`,
    [review.id, source, idempotencyKey, hash, tx.actor.userId, tx.actor.email, tx.actor.via ?? null],
  );
  if (review.bank_transaction_id && review.owner_journal_id) {
    const transaction = await getBankTransaction(tx, review.bank_transaction_id);
    if (transaction.status === "posted") {
      await voidBankTransaction(tx, review.bank_transaction_id, { source, idempotencyKey: `${idempotencyKey}:void`, voidDate: line.date });
    }
    const original = await getJournal(tx, review.owner_journal_id);
    const reversed = await postJournalBody(
      tx,
      source,
      `${idempotencyKey}:owner`,
      parseJournalBody(
        tx,
        {
          postingDate: line.date,
          reference: `VOID-${original.reference}`.slice(0, 100),
          description: `Void of ${original.description ?? "owner journal"}`.slice(0, 500),
          lines: original.lines.map((entry) => ({ accountCode: entry.accountCode, debitAmount: entry.creditAmount, creditAmount: entry.debitAmount, description: entry.description })),
        },
        { internal: true },
      ),
      { origin: "bank_transaction", relatedJournalId: original.id, correctionKind: "reversal" },
    );
    await tx.query("update mixed_use_reviews set owner_reversal_journal_id = $2 where id = $1", [review.id, reversed.journal.id]);
  }
  const usage = await usageOf(tx, line.accountId);
  if (usage.usage === "personal") {
    await tx.query(
      "insert into mixed_use_reviews (statement_line_id, decision, private_amount, automatic) values ($1, 'private', abs($2::numeric), true)",
      [lineId, line.amount],
    );
  } else {
    await tx.query("update bank_statement_lines set status = 'unreconciled', updated_at = now() where id = $1", [lineId]);
  }
  await writeAuditEvent(tx, {
    eventType: "statement_line.review_undone",
    entityType: "bank_statement_line",
    entityId: lineId,
    details: { reviewId: review.id, decision: review.decision },
  });
  return { created: true, line: await getReviewLine(tx, lineId) };
}

// ---------------------------------------------------------------------------
// Many lines at once: a durable batch (#547)
// ---------------------------------------------------------------------------

export const MAX_REVIEW_ACTIONS = 100;

/** The batch's actions from what was asked; a malformed one is recorded as refused. Pure. */
export function reviewBatchActions(rawActions: readonly unknown[], key: string, byAi: boolean): NewBatchAction[] {
  const seen = new Set<string>();
  return rawActions.map((raw, index) => {
    const label = `Action ${index + 1}`;
    const payload = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : { value: raw };
    try {
      const fields = asRecord(raw, label);
      const decision = requireOneOf(fields.decision, `${label} decision`, REVIEW_DECISIONS);
      const lineId = requireId(fields.lineId, `${label} lineId`);
      if (seen.has(lineId)) throw new ValidationError(`${label}: line ${lineId} is already in this call.`);
      seen.add(lineId);
      return { action: decision, targetId: lineId, payload: { ...fields, byAi }, idempotencyKey: `${key}:${lineId}` };
    } catch (error) {
      const lineId = typeof payload.lineId === "string" && /^[1-9]\d{0,17}$/.test(payload.lineId) ? payload.lineId : null;
      return { action: "review", targetId: lineId, payload: { ...payload, byAi }, idempotencyKey: `${key}:#${index}`, refused: lineErrorText(error) };
    }
  });
}

/** The work for one review in a batch, as the batch's own command source. */
export function reviewWork(source: string): ActionWork {
  return async (tx, action) => {
    const fields = { ...action.payload, source, idempotencyKey: action.idempotencyKey };
    const done = await reviewLine(tx, action.targetId, fields, { ai: action.payload.byAi === true });
    return { lineId: done.line.id, created: done.created };
  };
}

/** Reviews up to 100 lines, each in its own transaction (MU14), or resumes the same batch. */
export async function startReviewBatch(
  run: OrgRunner,
  input: { actions: unknown; idempotencyKey: string; source: string; byAi: boolean },
  options: RunOptions = {},
): Promise<RunOutcome & { created: boolean }> {
  const raw = requireArray(input.actions, "actions", MAX_REVIEW_ACTIONS);
  if (raw.length === 0) throw new ValidationError("Give at least one line to review.");
  if (input.idempotencyKey.length > 80) throw new ValidationError("idempotencyKey must be at most 80 characters for a batch.");
  const actions = reviewBatchActions(raw, input.idempotencyKey, input.byAi);
  const { batch, created } = await run((tx) =>
    createBatch(tx, {
      kind: "mixed_use_review",
      source: input.source,
      idempotencyKey: input.idempotencyKey,
      requestHash: requestHash("mixed_use_review_batch", { actions: raw, byAi: input.byAi }),
      actions,
    }),
  );
  return { ...(await runBatch(run, batch.id, reviewWork(batch.source), options)), created };
}
