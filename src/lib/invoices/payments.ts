import { parseAccountCodeInput } from "@/lib/accounts/service";
import { writeAuditEvent } from "@/lib/audit";
import { parseIsoDate } from "@/lib/dates";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { assertSameRequest, requestHash } from "@/lib/idempotency";
import { getInvoice, lockInvoice, receivableAccountCode, type Invoice } from "@/lib/invoices/service";
import { getJournal, parseJournalBody, postJournalBody } from "@/lib/ledger/journals";
import { currencyMinorUnits } from "@/lib/money/currency";
import { cmp, dec, isZero, parseDecimalInput, toFixedString, toPlainString } from "@/lib/money/decimal";
import { optionalSource, optionalString, requireId, requireIdempotencyKey } from "@/lib/validation";

/**
 * Customer payments against approved sales invoices (examples CP1-CP8). Each
 * payment is against one invoice and posts Dr the bank account / Cr accounts
 * receivable on the payment date. A payment can't be edited; voiding it posts
 * the exact reversal on the void date. An invoice's amount due and paid status
 * are worked out from its active payments whenever it's read, never stored.
 */
export const PAYMENT_STATUSES = ["active", "voided"] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export type CustomerPayment = {
  id: string;
  invoiceId: string;
  invoiceNumber: string;
  status: PaymentStatus;
  paymentDate: string;
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

type PaymentRow = {
  id: string;
  invoice_id: string;
  invoice_number: string;
  status: PaymentStatus;
  payment_date: string;
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

const PAYMENT_SELECT = `select p.id, p.invoice_id, i.invoice_number, p.status, p.payment_date, p.amount, p.currency_code,
       p.bank_account_id, a.code as bank_account_code, a.name as bank_account_name, p.reference, p.journal_id,
       p.created_by_email, p.created_at, p.void_date, p.void_journal_id, p.voided_by_email, p.voided_at
  from customer_payments p
  join sales_invoices i on i.id = p.invoice_id
  join accounts a on a.id = p.bank_account_id`;

function toPayment(row: PaymentRow): CustomerPayment {
  return {
    id: row.id,
    invoiceId: row.invoice_id,
    invoiceNumber: row.invoice_number,
    status: row.status,
    paymentDate: row.payment_date,
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

async function getPayment(tx: OrgTx, paymentId: string): Promise<CustomerPayment> {
  const result = await tx.query<PaymentRow>(`${PAYMENT_SELECT} where p.id = $1`, [paymentId]);
  const row = result.rows[0];
  if (!row) {
    throw new NotFoundError("Payment not found.");
  }
  return toPayment(row);
}

/** An invoice's payments, active and voided, oldest first. */
export async function listPayments(tx: OrgTx, invoiceIdInput: unknown): Promise<CustomerPayment[]> {
  const invoiceId = requireId(invoiceIdInput, "invoiceId");
  const invoice = await tx.query("select id from sales_invoices where id = $1", [invoiceId]);
  if (invoice.rowCount === 0) {
    throw new NotFoundError("Invoice not found.");
  }
  const result = await tx.query<PaymentRow>(
    `${PAYMENT_SELECT} where p.invoice_id = $1 order by p.payment_date, p.id`,
    [invoiceId],
  );
  return result.rows.map(toPayment);
}

type PaymentResult = { created: boolean; payment: CustomerPayment; invoice: Invoice };

async function findByKey(
  tx: OrgTx,
  command: "record" | "void",
  source: string,
  idempotencyKey: string,
): Promise<{ id: string; invoiceId: string; hash: string } | null> {
  const columns =
    command === "record"
      ? { source: "command_source", key: "idempotency_key", hash: "request_hash" }
      : { source: "void_command_source", key: "void_idempotency_key", hash: "void_request_hash" };
  const result = await tx.query<{ id: string; invoice_id: string; hash: string }>(
    `select id, invoice_id, ${columns.hash} as hash from customer_payments
      where ${columns.source} = $1 and ${columns.key} = $2`,
    [source, idempotencyKey],
  );
  const row = result.rows[0];
  return row ? { id: row.id, invoiceId: row.invoice_id, hash: row.hash } : null;
}

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string }).code === "23505";
}

/**
 * The account a payment goes into (example CP8): an active bank account in
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
    throw new ValidationError(`${label} is archived, so payments can't go into it.`);
  }
  if (row.account_type !== "bank") {
    throw new ValidationError(`${label} isn't a bank account, so payments can't go into it. Choose a bank account.`);
  }
  if (row.currency_code !== null) {
    throw new ValidationError(
      `${label} is in ${row.currency_code}. Payments go into bank accounts in the base currency (${tx.baseCurrency}) only.`,
    );
  }
  return { id: row.id, code: row.code, name: row.name };
}

/**
 * Records a payment against an approved invoice (examples CP1-CP3, CP6-CP8):
 * posts one journal on the payment date, Dr the bank account / Cr accounts
 * receivable. It can't be more than the amount due, dated before the invoice,
 * or dated in a locked period.
 */
export async function recordPayment(
  tx: OrgTx,
  invoiceIdInput: unknown,
  command: {
    source?: unknown;
    idempotencyKey: unknown;
    paymentDate: unknown;
    amount: unknown;
    bankAccountCode: unknown;
    reference?: unknown;
  },
): Promise<PaymentResult> {
  const invoiceId = requireId(invoiceIdInput, "invoiceId");
  const source = optionalSource(command.source);
  const idempotencyKey = requireIdempotencyKey(command.idempotencyKey);
  const paymentDate = parseIsoDate(command.paymentDate, "paymentDate");
  // Approved invoices are always in the base currency: it can't change once anything is posted.
  const scale = currencyMinorUnits(tx.baseCurrency);
  const amount = dec(parseDecimalInput(command.amount, "amount", { maxScale: scale }));
  const bankAccountCode = parseAccountCodeInput(command.bankAccountCode, "bankAccountCode");
  const reference = optionalString(command.reference, "reference", { maxLength: 100 });
  const hash = requestHash("customer_payment", {
    invoiceId,
    paymentDate,
    amount: toPlainString(amount),
    bankAccountCode: bankAccountCode.toLowerCase(),
    reference,
  });
  const replay = async (): Promise<PaymentResult | null> => {
    const earlier = await findByKey(tx, "record", source, idempotencyKey);
    if (!earlier) {
      return null;
    }
    assertSameRequest(earlier.hash, hash, "payment");
    return { created: false, payment: await getPayment(tx, earlier.id), invoice: await getInvoice(tx, earlier.invoiceId) };
  };

  const earlier = await replay();
  if (earlier) {
    return earlier;
  }
  const invoice = await lockInvoice(tx, invoiceId);
  // The original of a retry may have committed while this request waited for the lock.
  const committedMeanwhile = await replay();
  if (committedMeanwhile) {
    return committedMeanwhile;
  }
  if (invoice.status === "draft") {
    throw new ConflictError("This invoice is still a draft, so it can't be paid. Approve it first.");
  }
  if (invoice.status === "voided") {
    throw new ConflictError(`Invoice ${invoice.invoiceNumber} has been voided, so it can't be paid.`);
  }
  if (paymentDate < invoice.invoiceDate) {
    throw new ValidationError(
      `The payment date can't be before the invoice date (${invoice.invoiceDate}). Prepayments aren't supported yet.`,
    );
  }
  const due = dec(invoice.amountDue!);
  if (isZero(due)) {
    throw new ConflictError(`Invoice ${invoice.invoiceNumber} is already paid in full.`);
  }
  if (cmp(amount, due) > 0) {
    throw new ValidationError(
      `The payment of ${toFixedString(amount, scale)} is more than the amount due (${invoice.amountDue}). Overpayments aren't supported yet.`,
    );
  }
  const bank = await resolveBankAccount(tx, bankAccountCode);
  const receivable = await receivableAccountCode(tx);

  // The journal is keyed by the payment's id, so it's taken first.
  const next = await tx.query<{ id: string }>(
    "select nextval(pg_get_serial_sequence('customer_payments', 'id'))::text as id",
  );
  const paymentId = next.rows[0].id;
  const fixedAmount = toFixedString(amount, scale);
  const customer = invoice.contactName;
  const posted = await postJournalBody(
    tx,
    "customer_payment:record",
    paymentId,
    parseJournalBody(tx, {
      postingDate: paymentDate,
      reference: reference ?? invoice.invoiceNumber,
      description: `Payment from ${customer} for ${invoice.invoiceNumber}`,
      lines: [
        { accountCode: bank.code, debitAmount: fixedAmount, creditAmount: "0", description: customer },
        { accountCode: receivable, debitAmount: "0", creditAmount: fixedAmount, description: customer },
      ],
    }),
    { origin: "customer_payment" },
  );

  try {
    await tx.query(
      `insert into customer_payments (
         id, command_source, idempotency_key, request_hash, invoice_id, payment_date, amount, currency_code,
         bank_account_id, reference, journal_id, created_by_user_id, created_by_email
       )
       values ($1, $2, $3, $4, $5, $6, $7::numeric, $8, $9, $10, $11, $12, $13)`,
      [
        paymentId,
        source,
        idempotencyKey,
        hash,
        invoiceId,
        paymentDate,
        fixedAmount,
        invoice.currencyCode,
        bank.id,
        reference,
        posted.journal.id,
        tx.actor.userId,
        tx.actor.email,
      ],
    );
  } catch (error) {
    if (isUniqueViolation(error)) {
      // The same key was used for a payment against another invoice by a request that committed first.
      throw new ConflictError(
        "That idempotency key was already used for a different payment. Use a new key for a new payment.",
      );
    }
    throw error;
  }
  await writeAuditEvent(tx, {
    eventType: "customer_payment.recorded",
    entityType: "customer_payment",
    entityId: paymentId,
    details: {
      invoiceId,
      invoiceNumber: invoice.invoiceNumber,
      paymentDate,
      amount: fixedAmount,
      bankAccountCode: bank.code,
      journalId: posted.journal.id,
    },
  });
  return { created: true, payment: await getPayment(tx, paymentId), invoice: await getInvoice(tx, invoiceId) };
}

/**
 * Voids a payment (example CP4): posts the exact reversal of its journal on
 * the void date, which must be in an open period and not before the payment.
 * The amount is due again. A payment can only be voided once.
 */
export async function voidPayment(
  tx: OrgTx,
  invoiceIdInput: unknown,
  paymentIdInput: unknown,
  command: { source?: unknown; idempotencyKey: unknown; voidDate: unknown },
): Promise<PaymentResult> {
  const invoiceId = requireId(invoiceIdInput, "invoiceId");
  const paymentId = requireId(paymentIdInput, "paymentId");
  const source = optionalSource(command.source);
  const idempotencyKey = requireIdempotencyKey(command.idempotencyKey);
  const voidDate = parseIsoDate(command.voidDate, "voidDate");
  const onInvoice = await tx.query("select id from customer_payments where id = $1 and invoice_id = $2", [
    paymentId,
    invoiceId,
  ]);
  if (onInvoice.rowCount === 0) {
    throw new NotFoundError("Payment not found.");
  }
  const hash = requestHash("customer_payment_void", { paymentId, voidDate });
  const replay = async (): Promise<PaymentResult | null> => {
    const earlier = await findByKey(tx, "void", source, idempotencyKey);
    if (!earlier) {
      return null;
    }
    assertSameRequest(earlier.hash, hash, "payment void");
    return { created: false, payment: await getPayment(tx, earlier.id), invoice: await getInvoice(tx, earlier.invoiceId) };
  };

  const earlier = await replay();
  if (earlier) {
    return earlier;
  }
  const invoice = await lockInvoice(tx, invoiceId);
  const committedMeanwhile = await replay();
  if (committedMeanwhile) {
    return committedMeanwhile;
  }
  const payment = await getPayment(tx, paymentId);
  if (payment.status === "voided") {
    throw new ConflictError("This payment has already been voided.");
  }
  if (voidDate < payment.paymentDate) {
    throw new ValidationError(`The void date can't be before the payment date (${payment.paymentDate}).`);
  }

  const original = await getJournal(tx, payment.journalId);
  const posted = await postJournalBody(
    tx,
    "customer_payment:void",
    paymentId,
    parseJournalBody(tx, {
      postingDate: voidDate,
      reference: `VOID-${original.reference}`.slice(0, 100),
      description: `Void of payment from ${invoice.contactName} for ${invoice.invoiceNumber}`,
      lines: original.lines.map((line) => ({
        accountCode: line.accountCode,
        debitAmount: line.creditAmount,
        creditAmount: line.debitAmount,
        description: line.description,
      })),
    }),
    { origin: "customer_payment", relatedJournalId: original.id, correctionKind: "reversal" },
  );

  try {
    await tx.query(
      `update customer_payments
          set status = 'voided', void_date = $2, void_journal_id = $3, void_command_source = $4,
              void_idempotency_key = $5, void_request_hash = $6, voided_by_user_id = $7, voided_by_email = $8,
              voided_at = now()
        where id = $1`,
      [paymentId, voidDate, posted.journal.id, source, idempotencyKey, hash, tx.actor.userId, tx.actor.email],
    );
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ConflictError(
        "That idempotency key was already used for a different payment void. Use a new key for a new payment void.",
      );
    }
    throw error;
  }
  await writeAuditEvent(tx, {
    eventType: "customer_payment.voided",
    entityType: "customer_payment",
    entityId: paymentId,
    details: {
      invoiceId,
      invoiceNumber: invoice.invoiceNumber,
      voidDate,
      amount: payment.amount,
      journalId: posted.journal.id,
    },
  });
  return { created: true, payment: await getPayment(tx, paymentId), invoice: await getInvoice(tx, invoiceId) };
}
