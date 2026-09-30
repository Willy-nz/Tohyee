import { parseAccountCodeInput } from "@/lib/accounts/service";
import { isBankOrCreditCard } from "@/lib/accounts/types";
import { writeAuditEvent } from "@/lib/audit";
import { type Bill, type BillSummary, getBill, lockBill, payableAccountCode } from "@/lib/bills/service";
import { parseIsoDate } from "@/lib/dates";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { assertSameRequest, requestHash } from "@/lib/idempotency";
import { getJournal, parseJournalBody, postJournalBody, sameForeign } from "@/lib/ledger/journals";
import { clearedBase, exchangeRateFor, openBase, parseRateInput, roundingField, settlementGainLines, splitGain, thirdCurrencyMessage } from "@/lib/fx/documents";
import { currencyMinorUnits } from "@/lib/money/currency";
import { cmp, dec, isZero, parseDecimalInput, significantScale, sub, toFixedString, toPlainString } from "@/lib/money/decimal";
import { convertAtRate } from "@/lib/money/fx";
import { optionalSource, optionalString, requireId, requireIdempotencyKey } from "@/lib/validation";

/**
 * Supplier payments against approved bills (examples SP1-SP8), the mirror of
 * customer payments. Each payment is against one bill and posts Dr accounts
 * payable / Cr the bank account on the payment date. A payment can't be
 * edited; voiding it posts the exact reversal on the void date. A bill's
 * amount due and paid status are worked out from its active payments whenever
 * it's read, never stored.
 */
export const SUPPLIER_PAYMENT_STATUSES = ["active", "voided"] as const;
export type SupplierPaymentStatus = (typeof SUPPLIER_PAYMENT_STATUSES)[number];

export type SupplierPayment = {
  id: string;
  billId: string;
  supplierInvoiceNumber: string;
  status: SupplierPaymentStatus;
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
  /** Set when it's one bill's part of a payment for several bills (SMP1-SMP6), which is voided as a whole. */
  batchId: string | null;
  /**
   * For a foreign-currency bill (MC10): the payment's rate, the base amount that left the bank account,
   * the base amount it cleared from accounts payable (at the bill's rate) and the realised gain
   * (negative for a loss). Null otherwise.
   */
  exchangeRate: string | null;
  baseAmount: string | null;
  baseCleared: string | null;
  realisedGain: string | null;
  /** Rounding on 7050 (MC31): what's left of the difference after the realised gain; 0.00 when none. */
  roundingGain: string | null;
};

type PaymentRow = {
  id: string;
  bill_id: string;
  supplier_invoice_number: string;
  status: SupplierPaymentStatus;
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
  batch_id: string | null;
  exchange_rate: string | null;
  base_amount: string | null;
  base_cleared: string | null;
  realised_gain: string | null;
  rounding_gain: string | null;
};

const PAYMENT_SELECT = `select p.id, p.bill_id, b.supplier_invoice_number, p.status, p.payment_date, p.amount,
       p.currency_code, p.bank_account_id, a.code as bank_account_code, a.name as bank_account_name, p.reference,
       p.journal_id, p.created_by_email, p.created_at, p.void_date, p.void_journal_id, p.voided_by_email, p.voided_at,
       p.batch_id, p.exchange_rate::text, p.base_amount::text, p.base_cleared::text, p.realised_gain::text, p.rounding_gain::text
  from supplier_payments p
  join bills b on b.id = p.bill_id
  join accounts a on a.id = p.bank_account_id`;

function toPayment(row: PaymentRow): SupplierPayment {
  return {
    id: row.id,
    billId: row.bill_id,
    supplierInvoiceNumber: row.supplier_invoice_number,
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
    batchId: row.batch_id,
    exchangeRate: row.exchange_rate === null ? null : toPlainString(dec(row.exchange_rate)),
    baseAmount: row.base_amount === null ? null : toFixedString(dec(row.base_amount), 2),
    baseCleared: row.base_cleared === null ? null : toFixedString(dec(row.base_cleared), 2),
    realisedGain: row.realised_gain === null ? null : toFixedString(dec(row.realised_gain), 2),
    roundingGain: roundingField(row),
  };
}

function billLabel(bill: BillSummary): string {
  return `Bill ${bill.supplierInvoiceNumber} from ${bill.contactName}`;
}

async function getPayment(tx: OrgTx, paymentId: string): Promise<SupplierPayment> {
  const result = await tx.query<PaymentRow>(`${PAYMENT_SELECT} where p.id = $1`, [paymentId]);
  const row = result.rows[0];
  if (!row) {
    throw new NotFoundError("Payment not found.");
  }
  return toPayment(row);
}

/** A bill's payments, active and voided, oldest first. */
export async function listSupplierPayments(tx: OrgTx, billIdInput: unknown): Promise<SupplierPayment[]> {
  const billId = requireId(billIdInput, "billId");
  const bill = await tx.query("select id from bills where id = $1", [billId]);
  if (bill.rowCount === 0) {
    throw new NotFoundError("Bill not found.");
  }
  const result = await tx.query<PaymentRow>(`${PAYMENT_SELECT} where p.bill_id = $1 order by p.payment_date, p.id`, [
    billId,
  ]);
  return result.rows.map(toPayment);
}

type PaymentResult = { created: boolean; payment: SupplierPayment; bill: Bill };

async function findByKey(
  tx: OrgTx,
  command: "record" | "void",
  source: string,
  idempotencyKey: string,
): Promise<{ id: string; billId: string; hash: string } | null> {
  const columns =
    command === "record"
      ? { source: "command_source", key: "idempotency_key", hash: "request_hash" }
      : { source: "void_command_source", key: "void_idempotency_key", hash: "void_request_hash" };
  const result = await tx.query<{ id: string; bill_id: string; hash: string }>(
    `select id, bill_id, ${columns.hash} as hash from supplier_payments
      where ${columns.source} = $1 and ${columns.key} = $2`,
    [source, idempotencyKey],
  );
  const row = result.rows[0];
  return row ? { id: row.id, billId: row.bill_id, hash: row.hash } : null;
}

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string }).code === "23505";
}

/**
 * The account a payment is made from (example SP8): an active bank account
 * in the base currency, or, for a foreign-currency bill (MC10), in the
 * bill's currency (`currency`).
 */
export async function resolveBankAccount(
  tx: OrgTx,
  code: string,
  currency: string | null = null,
): Promise<{ id: string; code: string; name: string; currencyCode: string | null }> {
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
    throw new ValidationError(`${label} is archived, so payments can't be made from it.`);
  }
  if (!isBankOrCreditCard(row.account_type)) {
    throw new ValidationError(`${label} isn't a bank account, so payments can't be made from it. Choose a bank or credit card account.`);
  }
  const accountCurrency = row.currency_code === tx.baseCurrency ? null : row.currency_code;
  if (accountCurrency !== null && accountCurrency !== currency) {
    throw new ValidationError(
      currency
        ? thirdCurrencyMessage(label, accountCurrency, currency, "bill", tx.baseCurrency)
        : `${label} is in ${accountCurrency}. Payments are made from bank accounts in the base currency (${tx.baseCurrency}) only.`,
    );
  }
  return { id: row.id, code: row.code, name: row.name, currencyCode: accountCurrency };
}

/**
 * Records a payment against an approved bill (examples SP1-SP3, SP6-SP8):
 * posts one journal on the payment date, Dr accounts payable / Cr the bank
 * account. It can't be more than the amount due, dated before the bill, or
 * dated in a locked period.
 */
export async function recordSupplierPayment(
  tx: OrgTx,
  billIdInput: unknown,
  command: {
    source?: unknown;
    idempotencyKey: unknown;
    paymentDate: unknown;
    amount: unknown;
    bankAccountCode: unknown;
    reference?: unknown;
    /** For a foreign-currency bill (MC10): base currency per 1 unit on the payment date; left out, the last rate used. */
    exchangeRate?: unknown;
  },
): Promise<PaymentResult> {
  const billId = requireId(billIdInput, "billId");
  const source = optionalSource(command.source);
  const idempotencyKey = requireIdempotencyKey(command.idempotencyKey);
  const paymentDate = parseIsoDate(command.paymentDate, "paymentDate");
  // In the bill's currency (MC10): checked against it once the bill is loaded.
  const amount = dec(parseDecimalInput(command.amount, "amount", { maxScale: 4 }));
  const bankAccountCode = parseAccountCodeInput(command.bankAccountCode, "bankAccountCode");
  const reference = optionalString(command.reference, "reference", { maxLength: 100 });
  const typedRate = parseRateInput(command.exchangeRate);
  const hash = requestHash("supplier_payment", {
    billId,
    paymentDate,
    amount: toPlainString(amount),
    bankAccountCode: bankAccountCode.toLowerCase(),
    reference,
    // Only when sent, so earlier payments hash the same.
    ...(typedRate != null ? { exchangeRate: typedRate } : {}),
  });
  const replay = async (): Promise<PaymentResult | null> => {
    const earlier = await findByKey(tx, "record", source, idempotencyKey);
    if (!earlier) {
      return null;
    }
    assertSameRequest(earlier.hash, hash, "payment");
    return { created: false, payment: await getPayment(tx, earlier.id), bill: await getBill(tx, earlier.billId) };
  };

  const earlier = await replay();
  if (earlier) {
    return earlier;
  }
  const bill = await lockBill(tx, billId);
  // The original of a retry may have committed while this request waited for the lock.
  const committedMeanwhile = await replay();
  if (committedMeanwhile) {
    return committedMeanwhile;
  }
  if (bill.status === "draft") {
    throw new ConflictError("This bill is still a draft, so it can't be paid. Approve it first.");
  }
  if (bill.status === "voided") {
    throw new ConflictError(`${billLabel(bill)} has been voided, so it can't be paid.`);
  }
  if (paymentDate < bill.billDate) {
    throw new ValidationError(
      `The payment date can't be before the bill date (${bill.billDate}). Prepayments aren't supported yet.`,
    );
  }
  const scale = currencyMinorUnits(bill.currencyCode);
  if (significantScale(amount) > scale) {
    throw new ValidationError(scale === 0 ? "amount must be a whole number." : `amount can have at most ${scale} decimal places.`);
  }
  const due = dec(bill.amountDue!);
  if (isZero(due)) {
    throw new ConflictError(`${billLabel(bill)} is already paid in full.`);
  }
  if (cmp(amount, due) > 0) {
    throw new ValidationError(
      `The payment of ${toFixedString(amount, scale)} is more than the amount due (${bill.amountDue}). Overpayments aren't supported yet.`,
    );
  }
  if (bill.exchangeRate !== null) {
    return recordForeignSupplierPayment(tx, bill, {
      source,
      idempotencyKey,
      hash,
      paymentDate,
      amount: toFixedString(amount, scale),
      bankAccountCode,
      reference,
      typedRate,
    });
  }
  if (typedRate != null) {
    throw new ValidationError(`${billLabel(bill)} is in ${tx.baseCurrency}, so its payments have no exchange rate.`);
  }
  const bank = await resolveBankAccount(tx, bankAccountCode);
  const payable = await payableAccountCode(tx);

  // The journal is keyed by the payment's id, so it's taken first.
  const next = await tx.query<{ id: string }>(
    "select nextval(pg_get_serial_sequence('supplier_payments', 'id'))::text as id",
  );
  const paymentId = next.rows[0].id;
  const fixedAmount = toFixedString(amount, scale);
  const supplier = bill.contactName;
  const posted = await postJournalBody(
    tx,
    "supplier_payment:record",
    paymentId,
    parseJournalBody(tx, {
      postingDate: paymentDate,
      reference: reference ?? bill.supplierInvoiceNumber,
      description: `Payment to ${supplier} for bill ${bill.supplierInvoiceNumber}`,
      lines: [
        { accountCode: payable, debitAmount: fixedAmount, creditAmount: "0", description: supplier },
        { accountCode: bank.code, debitAmount: "0", creditAmount: fixedAmount, description: supplier },
      ],
    }),
    { origin: "supplier_payment" },
  );

  try {
    await tx.query(
      `insert into supplier_payments (
         id, command_source, idempotency_key, request_hash, bill_id, payment_date, amount, currency_code,
         bank_account_id, reference, journal_id, created_by_user_id, created_by_email
       )
       values ($1, $2, $3, $4, $5, $6, $7::numeric, $8, $9, $10, $11, $12, $13)`,
      [
        paymentId,
        source,
        idempotencyKey,
        hash,
        billId,
        paymentDate,
        fixedAmount,
        bill.currencyCode,
        bank.id,
        reference,
        posted.journal.id,
        tx.actor.userId,
        tx.actor.email,
      ],
    );
  } catch (error) {
    if (isUniqueViolation(error)) {
      // The same key was used for a payment against another bill by a request that committed first.
      throw new ConflictError(
        "That idempotency key was already used for a different payment. Use a new key for a new payment.",
      );
    }
    throw error;
  }
  await writeAuditEvent(tx, {
    eventType: "supplier_payment.recorded",
    entityType: "supplier_payment",
    entityId: paymentId,
    details: {
      billId,
      supplierInvoiceNumber: bill.supplierInvoiceNumber,
      paymentDate,
      amount: fixedAmount,
      bankAccountCode: bank.code,
      journalId: posted.journal.id,
    },
  });
  return { created: true, payment: await getPayment(tx, paymentId), bill: await getBill(tx, billId) };
}

/**
 * A payment of a foreign-currency bill (example MC10), the mirror of a
 * customer's (MC5): in the bill's currency, from a bank account in that
 * currency or the base currency, at the payment's own rate. The bank account
 * is credited amount x rate, rounded once; accounts payable is cleared at the
 * bill's carrying value of what's paid; the difference is a realised gain
 * (paying less than it was carried at) or loss on 7020.
 */
async function recordForeignSupplierPayment(
  tx: OrgTx,
  bill: Bill,
  input: {
    source: string;
    idempotencyKey: string;
    hash: string;
    paymentDate: string;
    amount: string;
    bankAccountCode: string;
    reference: string | null;
    typedRate: string | null | undefined;
  },
): Promise<PaymentResult> {
  const currency = bill.currencyCode;
  const bank = await resolveBankAccount(tx, input.bankAccountCode, currency);
  const rate = (await exchangeRateFor(tx, { currencyCode: currency, date: input.paymentDate, typed: input.typedRate, what: "payment" }))!;
  const payable = await payableAccountCode(tx);
  const baseAmount = convertAtRate(input.amount, rate);
  const cleared = clearedBase({ amount: bill.amountDue!, base: await openBase(tx, "bill", bill.id) }, input.amount);
  const gain = toFixedString(sub(dec(cleared), dec(baseAmount)), 2);
  // Accounts payable is debited at the bill's rate and the bank credited at the payment's (MC31).
  const split = splitGain(gain, input.amount, bill.exchangeRate!, rate);
  const gainLines = await settlementGainLines(tx, split, `bill ${bill.supplierInvoiceNumber} paid at ${rate}`);

  const next = await tx.query<{ id: string }>("select nextval(pg_get_serial_sequence('supplier_payments', 'id'))::text as id");
  const paymentId = next.rows[0].id;
  const supplier = bill.contactName;
  const posted = await postJournalBody(
    tx,
    "supplier_payment:record",
    paymentId,
    parseJournalBody(
      tx,
      {
        postingDate: input.paymentDate,
        reference: input.reference ?? bill.supplierInvoiceNumber,
        description: `Payment to ${supplier} for bill ${bill.supplierInvoiceNumber} (${currency} ${input.amount} at ${rate})`,
        lines: [
          {
            accountCode: payable,
            debitAmount: cleared,
            creditAmount: "0",
            description: supplier,
            foreign: { currencyCode: currency, amount: input.amount, rate: bill.exchangeRate!, kind: "carrying_value" as const },
          },
          {
            accountCode: bank.code,
            debitAmount: "0",
            creditAmount: baseAmount,
            description: supplier,
            ...(bank.currencyCode ? { foreign: { currencyCode: currency, amount: input.amount, rate, kind: "rate" as const } } : {}),
          },
          ...gainLines,
        ],
      },
      { internal: true },
    ),
    { origin: "supplier_payment" },
  );
  try {
    await tx.query(
      `insert into supplier_payments (
         id, command_source, idempotency_key, request_hash, bill_id, payment_date, amount, currency_code,
         bank_account_id, reference, journal_id, created_by_user_id, created_by_email,
         exchange_rate, base_amount, base_cleared, realised_gain, rounding_gain
       )
       values ($1, $2, $3, $4, $5, $6, $7::numeric, $8, $9, $10, $11, $12, $13, $14::numeric, $15::numeric, $16::numeric, $17::numeric, $18::numeric)`,
      [
        paymentId,
        input.source,
        input.idempotencyKey,
        input.hash,
        bill.id,
        input.paymentDate,
        input.amount,
        currency,
        bank.id,
        input.reference,
        posted.journal.id,
        tx.actor.userId,
        tx.actor.email,
        rate,
        baseAmount,
        cleared,
        split.realised,
        split.rounding,
      ],
    );
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ConflictError("That idempotency key was already used for a different payment. Use a new key for a new payment.");
    }
    throw error;
  }
  await writeAuditEvent(tx, {
    eventType: "supplier_payment.recorded",
    entityType: "supplier_payment",
    entityId: paymentId,
    details: {
      billId: bill.id,
      supplierInvoiceNumber: bill.supplierInvoiceNumber,
      paymentDate: input.paymentDate,
      amount: input.amount,
      currencyCode: currency,
      exchangeRate: rate,
      baseAmount,
      baseCleared: cleared,
      realisedGain: split.realised,
      roundingGain: split.rounding,
      bankAccountCode: bank.code,
      journalId: posted.journal.id,
    },
  });
  return { created: true, payment: await getPayment(tx, paymentId), bill: await getBill(tx, bill.id) };
}

/**
 * Voids a payment (example SP4): posts the exact reversal of its journal on
 * the void date, which must be in an open period and not before the payment.
 * The amount is due again. A payment can only be voided once.
 */
export async function voidSupplierPayment(
  tx: OrgTx,
  billIdInput: unknown,
  paymentIdInput: unknown,
  command: { source?: unknown; idempotencyKey: unknown; voidDate: unknown },
): Promise<PaymentResult> {
  const billId = requireId(billIdInput, "billId");
  const paymentId = requireId(paymentIdInput, "paymentId");
  const source = optionalSource(command.source);
  const idempotencyKey = requireIdempotencyKey(command.idempotencyKey);
  const voidDate = parseIsoDate(command.voidDate, "voidDate");
  const onBill = await tx.query("select id from supplier_payments where id = $1 and bill_id = $2", [paymentId, billId]);
  if (onBill.rowCount === 0) {
    throw new NotFoundError("Payment not found.");
  }
  const hash = requestHash("supplier_payment_void", { paymentId, voidDate });
  const replay = async (): Promise<PaymentResult | null> => {
    const earlier = await findByKey(tx, "void", source, idempotencyKey);
    if (!earlier) {
      return null;
    }
    assertSameRequest(earlier.hash, hash, "payment void");
    return { created: false, payment: await getPayment(tx, earlier.id), bill: await getBill(tx, earlier.billId) };
  };

  const earlier = await replay();
  if (earlier) {
    return earlier;
  }
  const bill = await lockBill(tx, billId);
  const committedMeanwhile = await replay();
  if (committedMeanwhile) {
    return committedMeanwhile;
  }
  const payment = await getPayment(tx, paymentId);
  if (payment.status === "voided") {
    throw new ConflictError("This payment has already been voided.");
  }
  if (payment.batchId) {
    // Example SMP4. The database refuses it too.
    throw new ConflictError("This is part of a payment for several bills, so it can't be voided on its own: void the whole payment.");
  }
  if (voidDate < payment.paymentDate) {
    throw new ValidationError(`The void date can't be before the payment date (${payment.paymentDate}).`);
  }

  const original = await getJournal(tx, payment.journalId);
  const posted = await postJournalBody(
    tx,
    "supplier_payment:void",
    paymentId,
    parseJournalBody(tx, {
      postingDate: voidDate,
      reference: `VOID-${original.reference}`.slice(0, 100),
      description: `Void of payment to ${bill.contactName} for bill ${bill.supplierInvoiceNumber}`,
      lines: original.lines.map((line) => ({
        accountCode: line.accountCode,
        debitAmount: line.creditAmount,
        creditAmount: line.debitAmount,
        description: line.description,
        tracking: line.tracking,
        ...sameForeign(line),
      })),
    }, { internal: true }),
    { origin: "supplier_payment", relatedJournalId: original.id, correctionKind: "reversal" },
  );

  try {
    await tx.query(
      `update supplier_payments
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
    eventType: "supplier_payment.voided",
    entityType: "supplier_payment",
    entityId: paymentId,
    details: {
      billId,
      supplierInvoiceNumber: bill.supplierInvoiceNumber,
      voidDate,
      amount: payment.amount,
      journalId: posted.journal.id,
    },
  });
  return { created: true, payment: await getPayment(tx, paymentId), bill: await getBill(tx, billId) };
}
