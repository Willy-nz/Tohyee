import { parseAccountCodeInput } from "@/lib/accounts/service";
import { isBankOrCreditCard } from "@/lib/accounts/types";
import { writeAuditEvent } from "@/lib/audit";
import {
  creditNoteLabel,
  getCreditNote,
  lockCreditNote,
  type CreditNote,
} from "@/lib/credit-notes/service";
import { parseIsoDate } from "@/lib/dates";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { assertSameRequest, requestHash } from "@/lib/idempotency";
import { controlAccountCode, RECEIVABLE_ACCOUNT } from "@/lib/invoices/service";
import { getJournal, parseJournalBody, postJournalBody } from "@/lib/ledger/journals";
import { currencyMinorUnits } from "@/lib/money/currency";
import { cmp, dec, isZero, parseDecimalInput, toFixedString, toPlainString } from "@/lib/money/decimal";
import { optionalSource, optionalString, requireId, requireIdempotencyKey } from "@/lib/validation";

/**
 * Cash refunds of a sales credit note's remaining credit (examples CN8, CN11,
 * CN12). A refund posts Dr accounts receivable / Cr the bank account on the
 * refund date. It can't be edited; voiding it posts the exact reversal on the
 * void date and the credit is available again.
 */
export const REFUND_STATUSES = ["active", "voided"] as const;
export type RefundStatus = (typeof REFUND_STATUSES)[number];

export type CreditNoteRefund = {
  id: string;
  creditNoteId: string;
  creditNoteNumber: string;
  status: RefundStatus;
  refundDate: string;
  amount: string;
  currencyCode: string;
  bankAccountId: string;
  bankAccountCode: string;
  bankAccountName: string;
  reference: string | null;
  journalId: string;
  createdByEmail: string | null;
  createdAt: string;
  voidDate: string | null;
  voidJournalId: string | null;
  voidedByEmail: string | null;
  voidedAt: string | null;
};

type RefundRow = {
  id: string;
  credit_note_id: string;
  credit_note_number: string;
  status: RefundStatus;
  refund_date: string;
  amount: string;
  currency_code: string;
  bank_account_id: string;
  bank_account_code: string;
  bank_account_name: string;
  reference: string | null;
  journal_id: string;
  created_by_email: string | null;
  created_at: string;
  void_date: string | null;
  void_journal_id: string | null;
  voided_by_email: string | null;
  voided_at: string | null;
};

const REFUND_SELECT = `select r.id, r.credit_note_id, n.credit_note_number, r.status, r.refund_date, r.amount, r.currency_code,
       r.bank_account_id, a.code as bank_account_code, a.name as bank_account_name, r.reference, r.journal_id,
       r.created_by_email, r.created_at, r.void_date, r.void_journal_id, r.voided_by_email, r.voided_at
  from sales_credit_note_refunds r
  join sales_credit_notes n on n.id = r.credit_note_id
  join accounts a on a.id = r.bank_account_id`;

function toRefund(row: RefundRow): CreditNoteRefund {
  return {
    id: row.id,
    creditNoteId: row.credit_note_id,
    creditNoteNumber: row.credit_note_number,
    status: row.status,
    refundDate: row.refund_date,
    amount: toFixedString(dec(row.amount), currencyMinorUnits(row.currency_code)),
    currencyCode: row.currency_code,
    bankAccountId: row.bank_account_id,
    bankAccountCode: row.bank_account_code,
    bankAccountName: row.bank_account_name,
    reference: row.reference,
    journalId: row.journal_id,
    createdByEmail: row.created_by_email,
    createdAt: row.created_at,
    voidDate: row.void_date,
    voidJournalId: row.void_journal_id,
    voidedByEmail: row.voided_by_email,
    voidedAt: row.voided_at,
  };
}

async function getRefund(tx: OrgTx, refundId: string): Promise<CreditNoteRefund> {
  const result = await tx.query<RefundRow>(`${REFUND_SELECT} where r.id = $1`, [refundId]);
  const row = result.rows[0];
  if (!row) {
    throw new NotFoundError("Refund not found.");
  }
  return toRefund(row);
}

/** A credit note's refunds, active and voided, oldest first. */
export async function listRefunds(tx: OrgTx, creditNoteIdInput: unknown): Promise<CreditNoteRefund[]> {
  const creditNoteId = requireId(creditNoteIdInput, "creditNoteId");
  const creditNote = await tx.query("select id from sales_credit_notes where id = $1", [creditNoteId]);
  if (creditNote.rowCount === 0) {
    throw new NotFoundError("Credit note not found.");
  }
  const result = await tx.query<RefundRow>(`${REFUND_SELECT} where r.credit_note_id = $1 order by r.refund_date, r.id`, [
    creditNoteId,
  ]);
  return result.rows.map(toRefund);
}

type RefundResult = { created: boolean; refund: CreditNoteRefund; creditNote: CreditNote };

async function findByKey(
  tx: OrgTx,
  command: "record" | "void",
  source: string,
  idempotencyKey: string,
): Promise<{ id: string; creditNoteId: string; hash: string } | null> {
  const columns =
    command === "record"
      ? { source: "command_source", key: "idempotency_key", hash: "request_hash" }
      : { source: "void_command_source", key: "void_idempotency_key", hash: "void_request_hash" };
  const result = await tx.query<{ id: string; credit_note_id: string; hash: string }>(
    `select id, credit_note_id, ${columns.hash} as hash from sales_credit_note_refunds
      where ${columns.source} = $1 and ${columns.key} = $2`,
    [source, idempotencyKey],
  );
  const row = result.rows[0];
  return row ? { id: row.id, creditNoteId: row.credit_note_id, hash: row.hash } : null;
}

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string }).code === "23505";
}

/**
 * The account a refund is paid from (example CN8): an active bank account in
 * the base currency.
 */
async function resolveBankAccount(
  tx: OrgTx,
  code: string,
): Promise<{ id: string; code: string; name: string }> {
  const result = await tx.query<{
    id: string;
    code: string;
    name: string;
    account_type: string;
    currency_code: string | null;
    is_active: boolean;
  }>("select id, code, name, account_type, currency_code, is_active from accounts where lower(code) = lower($1)", [
    code,
  ]);
  const row = result.rows[0];
  if (!row) {
    throw new ValidationError(`There's no account with the code ${code}.`);
  }
  const label = `Account ${row.code} (${row.name})`;
  if (!row.is_active) {
    throw new ValidationError(`${label} is archived, so refunds can't be paid from it.`);
  }
  if (!isBankOrCreditCard(row.account_type)) {
    throw new ValidationError(`${label} isn't a bank account, so refunds can't be paid from it. Choose a bank or credit card account.`);
  }
  if (row.currency_code !== null) {
    throw new ValidationError(
      `${label} is in ${row.currency_code}. Refunds are paid from bank accounts in the base currency (${tx.baseCurrency}) only.`,
    );
  }
  return { id: row.id, code: row.code, name: row.name };
}

/**
 * Refunds some or all of an approved credit note's remaining credit to the
 * customer (example CN8): posts Dr accounts receivable / Cr the bank account
 * on the refund date. It can't be more than the remaining credit, dated
 * before the credit note, or dated in a locked period.
 */
export async function refundCreditNote(
  tx: OrgTx,
  creditNoteIdInput: unknown,
  command: {
    source?: unknown;
    idempotencyKey: unknown;
    refundDate: unknown;
    amount: unknown;
    bankAccountCode: unknown;
    reference?: unknown;
  },
): Promise<RefundResult> {
  const creditNoteId = requireId(creditNoteIdInput, "creditNoteId");
  const source = optionalSource(command.source);
  const idempotencyKey = requireIdempotencyKey(command.idempotencyKey);
  const refundDate = parseIsoDate(command.refundDate, "refundDate");
  // Approved credit notes are always in the base currency: it can't change once anything is posted.
  const scale = currencyMinorUnits(tx.baseCurrency);
  const amount = dec(parseDecimalInput(command.amount, "amount", { maxScale: scale }));
  const bankAccountCode = parseAccountCodeInput(command.bankAccountCode, "bankAccountCode");
  const reference = optionalString(command.reference, "reference", { maxLength: 100 });
  const hash = requestHash("credit_note_refund", {
    creditNoteId,
    refundDate,
    amount: toPlainString(amount),
    bankAccountCode: bankAccountCode.toLowerCase(),
    reference,
  });
  const replay = async (): Promise<RefundResult | null> => {
    const earlier = await findByKey(tx, "record", source, idempotencyKey);
    if (!earlier) {
      return null;
    }
    assertSameRequest(earlier.hash, hash, "refund");
    return {
      created: false,
      refund: await getRefund(tx, earlier.id),
      creditNote: await getCreditNote(tx, earlier.creditNoteId),
    };
  };

  const earlier = await replay();
  if (earlier) {
    return earlier;
  }
  const creditNote = await lockCreditNote(tx, creditNoteId);
  // The original of a retry may have committed while this request waited for the lock.
  const committedMeanwhile = await replay();
  if (committedMeanwhile) {
    return committedMeanwhile;
  }
  if (creditNote.status === "draft") {
    throw new ConflictError("This credit note is still a draft, so it can't be refunded. Approve it first.");
  }
  if (creditNote.status === "voided") {
    throw new ConflictError(`${creditNoteLabel(creditNote)} has been voided, so it can't be refunded.`);
  }
  if (refundDate < creditNote.creditNoteDate) {
    throw new ValidationError(`The refund date can't be before the credit note date (${creditNote.creditNoteDate}).`);
  }
  const remaining = dec(creditNote.remainingCredit!);
  if (isZero(remaining)) {
    throw new ConflictError(`${creditNoteLabel(creditNote)} has no credit left to refund.`);
  }
  if (cmp(amount, remaining) > 0) {
    throw new ValidationError(
      `The refund of ${toFixedString(amount, scale)} is more than the remaining credit (${creditNote.remainingCredit}).`,
    );
  }
  const bank = await resolveBankAccount(tx, bankAccountCode);
  const receivable = await controlAccountCode(tx, RECEIVABLE_ACCOUNT, "refunds can't be recorded");

  // The journal is keyed by the refund's id, so it's taken first.
  const next = await tx.query<{ id: string }>(
    "select nextval(pg_get_serial_sequence('sales_credit_note_refunds', 'id'))::text as id",
  );
  const refundId = next.rows[0].id;
  const fixedAmount = toFixedString(amount, scale);
  const customer = creditNote.contactName;
  const posted = await postJournalBody(
    tx,
    "sales_credit_note_refund:record",
    refundId,
    parseJournalBody(tx, {
      postingDate: refundDate,
      reference: reference ?? creditNote.creditNoteNumber,
      description: `Refund to ${customer} for ${creditNote.creditNoteNumber}`,
      lines: [
        { accountCode: receivable, debitAmount: fixedAmount, creditAmount: "0", description: customer },
        { accountCode: bank.code, debitAmount: "0", creditAmount: fixedAmount, description: customer },
      ],
    }),
    { origin: "sales_credit_note_refund" },
  );

  try {
    await tx.query(
      `insert into sales_credit_note_refunds (
         id, command_source, idempotency_key, request_hash, credit_note_id, refund_date, amount, currency_code,
         bank_account_id, reference, journal_id, created_by_user_id, created_by_email
       )
       values ($1, $2, $3, $4, $5, $6, $7::numeric, $8, $9, $10, $11, $12, $13)`,
      [
        refundId,
        source,
        idempotencyKey,
        hash,
        creditNoteId,
        refundDate,
        fixedAmount,
        creditNote.currencyCode,
        bank.id,
        reference,
        posted.journal.id,
        tx.actor.userId,
        tx.actor.email,
      ],
    );
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ConflictError("That idempotency key was already used for a different refund. Use a new key for a new refund.");
    }
    throw error;
  }
  await writeAuditEvent(tx, {
    eventType: "credit_note.refunded",
    entityType: "sales_credit_note_refund",
    entityId: refundId,
    details: {
      creditNoteId,
      creditNoteNumber: creditNote.creditNoteNumber,
      refundDate,
      amount: fixedAmount,
      bankAccountCode: bank.code,
      journalId: posted.journal.id,
    },
  });
  return { created: true, refund: await getRefund(tx, refundId), creditNote: await getCreditNote(tx, creditNoteId) };
}

/**
 * Voids a refund (example CN8): posts the exact reversal of its journal on
 * the void date, which must be in an open period and not before the refund.
 * The credit is available again. A refund can only be voided once.
 */
export async function voidRefund(
  tx: OrgTx,
  creditNoteIdInput: unknown,
  refundIdInput: unknown,
  command: { source?: unknown; idempotencyKey: unknown; voidDate: unknown },
): Promise<RefundResult> {
  const creditNoteId = requireId(creditNoteIdInput, "creditNoteId");
  const refundId = requireId(refundIdInput, "refundId");
  const source = optionalSource(command.source);
  const idempotencyKey = requireIdempotencyKey(command.idempotencyKey);
  const voidDate = parseIsoDate(command.voidDate, "voidDate");
  const onCreditNote = await tx.query("select id from sales_credit_note_refunds where id = $1 and credit_note_id = $2", [
    refundId,
    creditNoteId,
  ]);
  if (onCreditNote.rowCount === 0) {
    throw new NotFoundError("Refund not found.");
  }
  const hash = requestHash("credit_note_refund_void", { refundId, voidDate });
  const replay = async (): Promise<RefundResult | null> => {
    const earlier = await findByKey(tx, "void", source, idempotencyKey);
    if (!earlier) {
      return null;
    }
    assertSameRequest(earlier.hash, hash, "refund void");
    return {
      created: false,
      refund: await getRefund(tx, earlier.id),
      creditNote: await getCreditNote(tx, earlier.creditNoteId),
    };
  };

  const earlier = await replay();
  if (earlier) {
    return earlier;
  }
  const creditNote = await lockCreditNote(tx, creditNoteId);
  const committedMeanwhile = await replay();
  if (committedMeanwhile) {
    return committedMeanwhile;
  }
  const refund = await getRefund(tx, refundId);
  if (refund.status === "voided") {
    throw new ConflictError("This refund has already been voided.");
  }
  if (voidDate < refund.refundDate) {
    throw new ValidationError(`The void date can't be before the refund date (${refund.refundDate}).`);
  }

  const original = await getJournal(tx, refund.journalId);
  const posted = await postJournalBody(
    tx,
    "sales_credit_note_refund:void",
    refundId,
    parseJournalBody(tx, {
      postingDate: voidDate,
      reference: `VOID-${original.reference}`.slice(0, 100),
      description: `Void of refund to ${creditNote.contactName} for ${creditNote.creditNoteNumber}`,
      lines: original.lines.map((line) => ({
        accountCode: line.accountCode,
        debitAmount: line.creditAmount,
        creditAmount: line.debitAmount,
        description: line.description,
        tracking: line.tracking,
      })),
    }),
    { origin: "sales_credit_note_refund", relatedJournalId: original.id, correctionKind: "reversal" },
  );

  try {
    await tx.query(
      `update sales_credit_note_refunds
          set status = 'voided', void_date = $2, void_journal_id = $3, void_command_source = $4,
              void_idempotency_key = $5, void_request_hash = $6, voided_by_user_id = $7, voided_by_email = $8,
              voided_at = now()
        where id = $1`,
      [refundId, voidDate, posted.journal.id, source, idempotencyKey, hash, tx.actor.userId, tx.actor.email],
    );
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ConflictError(
        "That idempotency key was already used for a different refund void. Use a new key for a new refund void.",
      );
    }
    throw error;
  }
  await writeAuditEvent(tx, {
    eventType: "credit_note.refund_voided",
    entityType: "sales_credit_note_refund",
    entityId: refundId,
    details: {
      creditNoteId,
      creditNoteNumber: creditNote.creditNoteNumber,
      voidDate,
      amount: refund.amount,
      journalId: posted.journal.id,
    },
  });
  return { created: true, refund: await getRefund(tx, refundId), creditNote: await getCreditNote(tx, creditNoteId) };
}
