import { parseAccountCodeInput } from "@/lib/accounts/service";
import { writeAuditEvent } from "@/lib/audit";
import { type Bill, getBill, lockBill, payableAccountCode } from "@/lib/bills/service";
import { resolveBankAccount as resolveSupplierBankAccount } from "@/lib/bills/payments";
import { parseIsoDate } from "@/lib/dates";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { assertSameRequest, requestHash } from "@/lib/idempotency";
import { clearedBase, exchangeRateFor, openBase, parseRateInput, realisedFxAccountCode, realisedLines } from "@/lib/fx/documents";
import { foreignReceivableLines, resolveBankAccount as resolveCustomerBankAccount, splitForeignPayment } from "@/lib/invoices/payments";
import { getInvoice, type Invoice, lockInvoice, receivableAccountCode } from "@/lib/invoices/service";
import { getJournal, parseJournalBody, postJournalBody, sameForeign } from "@/lib/ledger/journals";
import { currencyMinorUnits } from "@/lib/money/currency";
import { convertAtRate } from "@/lib/money/fx";
import { add, cmp, dec, type Decimal, isPositive, isZero, parseDecimalInput, sub, sum, toFixedString, toPlainString, ZERO_DECIMAL } from "@/lib/money/decimal";
import { optionalSource, optionalString, requireId, requireIdempotencyKey } from "@/lib/validation";

/**
 * Payments for several documents (examples MP1-MP10 and SMP1-SMP6): one
 * amount received from a customer for several of their invoices, or paid to a
 * supplier for several of their bills. It posts one journal, with one line on
 * the bank account for the whole amount and one accounts receivable (payable)
 * line per document. Each document's part is kept as an ordinary customer
 * (supplier) payment with batch_id set, sharing the journal, so amounts due,
 * overpayments and the GST return need nothing new. It's voided as a whole.
 *
 * Documents in a foreign currency (MC20-MC24) are paid in that currency, all
 * at the payment's one rate, into (or from) a bank account in that currency
 * or the base currency. The bank line is the whole amount x rate, rounded
 * once; each document's part is its amount x rate, rounded once, except the
 * last, which takes what's left of the bank line, so the parts add up to it.
 * Each document is cleared at its own carrying value and has its own
 * realised gain or loss on 7020 (NetSuite: "For payments or credits applied
 * to multiple transactions, NetSuite calculates and records a gain or loss
 * for each transaction").
 */
export type BatchKind = "customer" | "supplier";

export type PaymentBatchPart = {
  paymentId: string;
  documentId: string;
  documentNumber: string;
  /** The part's full amount, including any overpayment. */
  amount: string;
  /** Only ever on a customer batch's last part, when every invoice was paid in full. */
  overpaymentAmount: string;
  /** In a foreign currency (MC20-MC24): the part's share of the bank line, what it cleared, and its realised gain (a loss is negative). */
  baseAmount: string | null;
  baseCleared: string | null;
  realisedGain: string | null;
};

export type PaymentBatch = {
  id: string;
  kind: BatchKind;
  status: "active" | "voided";
  contactId: string;
  contactName: string;
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
  parts: PaymentBatchPart[];
  overpaymentAmount: string;
  /** In a foreign currency (MC20-MC24): the payment's rate and the base amount that moved in the bank account. */
  exchangeRate: string | null;
  baseAmount: string | null;
};

type Kind = {
  batches: "customer_payment_batches" | "supplier_payment_batches";
  payments: "customer_payments" | "supplier_payments";
  documentColumn: "invoice_id" | "bill_id";
  documentTable: "sales_invoices" | "bills";
  documentNumberColumn: "invoice_number" | "supplier_invoice_number";
  documentDateColumn: "invoice_date" | "bill_date";
  origin: "customer_payment_batch" | "supplier_payment_batch";
  document: string;
  documents: string;
  contact: string;
};

const KINDS: Record<BatchKind, Kind> = {
  customer: {
    batches: "customer_payment_batches",
    payments: "customer_payments",
    documentColumn: "invoice_id",
    documentTable: "sales_invoices",
    documentNumberColumn: "invoice_number",
    documentDateColumn: "invoice_date",
    origin: "customer_payment_batch",
    document: "invoice",
    documents: "invoices",
    contact: "customer",
  },
  supplier: {
    batches: "supplier_payment_batches",
    payments: "supplier_payments",
    documentColumn: "bill_id",
    documentTable: "bills",
    documentNumberColumn: "supplier_invoice_number",
    documentDateColumn: "bill_date",
    origin: "supplier_payment_batch",
    document: "bill",
    documents: "bills",
    contact: "supplier",
  },
};

/** Parts are recorded under this command source, with keys made from the batch's id. */
const PART_SOURCE = "payment_batch";
const MAX_DOCUMENTS = 100;

type BatchRow = {
  id: string;
  status: "active" | "voided";
  contact_id: string;
  contact_name: string;
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
  exchange_rate: string | null;
  base_amount: string | null;
};

export async function getPaymentBatch(tx: OrgTx, kind: BatchKind, batchIdInput: unknown): Promise<PaymentBatch> {
  const k = KINDS[kind];
  const batchId = requireId(batchIdInput, "batchId");
  const found = await tx.query<BatchRow>(
    `select b.id, b.status, b.contact_id, c.name as contact_name, b.payment_date, b.amount, b.currency_code,
            b.bank_account_id, a.code as bank_account_code, a.name as bank_account_name, b.reference, b.journal_id,
            b.created_by_email, b.created_at, b.void_date, b.void_journal_id, b.voided_by_email, b.voided_at,
            b.exchange_rate::text, b.base_amount::text
       from ${k.batches} b join contacts c on c.id = b.contact_id join accounts a on a.id = b.bank_account_id
      where b.id = $1`,
    [batchId],
  );
  const row = found.rows[0];
  if (!row) throw new NotFoundError("Payment not found.");
  const scale = currencyMinorUnits(row.currency_code);
  const parts = await tx.query<{
    id: string;
    document_id: string;
    document_number: string;
    amount: string;
    overpayment: string;
    base_amount: string | null;
    base_cleared: string | null;
    realised_gain: string | null;
  }>(
    `select p.id, p.${k.documentColumn} as document_id, d.${k.documentNumberColumn} as document_number, p.amount,
            ${kind === "customer" ? "p.overpayment_amount" : "0::numeric"} as overpayment,
            p.base_amount::text, p.base_cleared::text, p.realised_gain::text
       from ${k.payments} p join ${k.documentTable} d on d.id = p.${k.documentColumn}
      where p.batch_id = $1 order by p.id`,
    [batchId],
  );
  return {
    id: row.id,
    kind,
    status: row.status,
    contactId: row.contact_id,
    contactName: row.contact_name,
    paymentDate: row.payment_date,
    amount: toFixedString(dec(row.amount), scale),
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
    parts: parts.rows.map((part) => ({
      paymentId: part.id,
      documentId: part.document_id,
      documentNumber: part.document_number,
      amount: toFixedString(dec(part.amount), scale),
      overpaymentAmount: toFixedString(dec(part.overpayment), scale),
      baseAmount: baseMoney(part.base_amount),
      baseCleared: baseMoney(part.base_cleared),
      realisedGain: baseMoney(part.realised_gain),
    })),
    overpaymentAmount: toFixedString(sum(parts.rows.map((part) => dec(part.overpayment))), scale),
    exchangeRate: row.exchange_rate === null ? null : toPlainString(dec(row.exchange_rate)),
    baseAmount: baseMoney(row.base_amount),
  };
}

/** A customer's (supplier's) payments for several documents, newest first. */
export async function listPaymentBatches(tx: OrgTx, kind: BatchKind, filters: { contactId?: unknown } = {}): Promise<PaymentBatch[]> {
  const k = KINDS[kind];
  const contactId = filters.contactId == null || filters.contactId === "" ? null : requireId(filters.contactId, "contactId");
  const ids = await tx.query<{ id: string }>(
    `select id from ${k.batches} where ($1::bigint is null or contact_id = $1) order by payment_date desc, id desc limit 200`,
    [contactId],
  );
  const batches: PaymentBatch[] = [];
  for (const row of ids.rows) batches.push(await getPaymentBatch(tx, kind, row.id));
  return batches;
}

const baseMoney = (value: string | null) => (value === null ? null : toFixedString(dec(value), 2));

type Document = {
  id: string;
  number: string;
  contactId: string;
  contactName: string;
  date: string;
  status: string;
  amountDue: Decimal | null;
  currencyCode: string;
  /** The document itself, for a foreign-currency payment's carrying values. */
  invoice?: Invoice;
  bill?: Bill;
};

async function lockDocument(tx: OrgTx, kind: BatchKind, id: string): Promise<Document> {
  if (kind === "customer") {
    const invoice = await lockInvoice(tx, id);
    return {
      id,
      number: invoice.invoiceNumber ?? `draft #${id}`,
      contactId: invoice.contactId,
      contactName: invoice.contactName,
      date: invoice.invoiceDate,
      status: invoice.status,
      amountDue: invoice.amountDue === null ? null : dec(invoice.amountDue),
      currencyCode: invoice.currencyCode,
      invoice,
    };
  }
  const bill = await lockBill(tx, id);
  return {
    id,
    number: bill.supplierInvoiceNumber ?? "(no number)",
    contactId: bill.contactId,
    contactName: bill.contactName,
    date: bill.billDate,
    status: bill.status,
    amountDue: bill.amountDue === null ? null : dec(bill.amountDue),
    currencyCode: bill.currencyCode,
    bill,
  };
}

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string }).code === "23505";
}

async function findByKey(tx: OrgTx, kind: BatchKind, command: "record" | "void", source: string, key: string) {
  const k = KINDS[kind];
  const columns =
    command === "record"
      ? { source: "command_source", key: "idempotency_key", hash: "request_hash" }
      : { source: "void_command_source", key: "void_idempotency_key", hash: "void_request_hash" };
  const found = await tx.query<{ id: string; hash: string }>(
    `select id, ${columns.hash} as hash from ${k.batches} where ${columns.source} = $1 and ${columns.key} = $2`,
    [source, key],
  );
  return found.rows[0] ?? null;
}

export type PaymentBatchResult = { created: boolean; batch: PaymentBatch };

/**
 * Records one payment for several invoices (bills) of one customer (supplier)
 * (examples MP1-MP4, MP10, SMP1-SMP3, SMP6). `documents` lists each invoice
 * (bill) once with the amount for it. The amounts add up to the amount
 * received (paid); for customers only, when every invoice is paid in full,
 * more can be received and the extra is an overpayment on the last one listed.
 */
export async function recordPaymentBatch(
  tx: OrgTx,
  kind: BatchKind,
  command: {
    source?: unknown;
    idempotencyKey: unknown;
    paymentDate: unknown;
    amount: unknown;
    bankAccountCode: unknown;
    reference?: unknown;
    documents: unknown;
    /** For documents in a foreign currency (MC20): base currency per 1 unit on the payment date; left out, the last rate used. */
    exchangeRate?: unknown;
  },
): Promise<PaymentBatchResult> {
  const k = KINDS[kind];
  const source = optionalSource(command.source);
  const idempotencyKey = requireIdempotencyKey(command.idempotencyKey);
  const paymentDate = parseIsoDate(command.paymentDate, "paymentDate");
  const scale = currencyMinorUnits(tx.baseCurrency);
  const received = dec(parseDecimalInput(command.amount, "amount", { maxScale: scale }));
  const bankAccountCode = parseAccountCodeInput(command.bankAccountCode, "bankAccountCode");
  const reference = optionalString(command.reference, "reference", { maxLength: 100 });
  const typedRate = parseRateInput(command.exchangeRate);
  if (!Array.isArray(command.documents) || command.documents.length === 0) {
    throw new ValidationError(`Choose at least one ${k.document} to pay.`);
  }
  if (command.documents.length > MAX_DOCUMENTS) {
    throw new ValidationError(`One payment can cover at most ${MAX_DOCUMENTS} ${k.documents}.`);
  }
  const lines = command.documents.map((entry, index) => {
    const item = (entry ?? {}) as { id?: unknown; amount?: unknown };
    return {
      id: requireId(item.id, `documents[${index}].id`),
      // Zero and negative amounts are refused below, with the document's number.
      amount: dec(parseDecimalInput(item.amount, `documents[${index}].amount`, { maxScale: scale, allowZero: true })),
    };
  });
  if (new Set(lines.map((line) => line.id)).size !== lines.length) {
    throw new ValidationError(`Each ${k.document} can only be listed once.`);
  }
  const hash = requestHash(k.origin, {
    paymentDate,
    amount: toPlainString(received),
    bankAccountCode: bankAccountCode.toLowerCase(),
    reference,
    documents: lines.map((line) => ({ id: line.id, amount: toPlainString(line.amount) })),
    // Only when sent, so earlier payments hash the same.
    ...(typedRate != null ? { exchangeRate: typedRate } : {}),
  });
  const replay = async (): Promise<PaymentBatchResult | null> => {
    const earlier = await findByKey(tx, kind, "record", source, idempotencyKey);
    if (!earlier) return null;
    assertSameRequest(earlier.hash, hash, "payment");
    return { created: false, batch: await getPaymentBatch(tx, kind, earlier.id) };
  };
  const earlier = await replay();
  if (earlier) return earlier;

  // Documents are locked in id order, the same order as everything else that locks several.
  const byId = new Map<string, Document>();
  for (const id of [...lines.map((line) => line.id)].sort((a, b) => Number(a) - Number(b))) {
    byId.set(id, await lockDocument(tx, kind, id));
  }
  const committedMeanwhile = await replay();
  if (committedMeanwhile) return committedMeanwhile;

  const documents = lines.map((line) => ({ ...line, document: byId.get(line.id)! }));
  const contactId = documents[0].document.contactId;
  const contactName = documents[0].document.contactName;
  for (const { document, amount } of documents) {
    if (document.status === "draft") {
      throw new ConflictError(`A draft ${k.document} can't be paid. Approve it first.`);
    }
    if (document.status === "voided") {
      throw new ConflictError(`${capital(k.document)} ${document.number} has been voided, so it can't be paid.`);
    }
    if (document.contactId !== contactId) {
      throw new ValidationError(`One payment can only pay ${k.documents} of one ${k.contact}: ${document.number} is ${document.contactName}'s.`);
    }
    if (document.currencyCode !== documents[0].document.currencyCode) {
      // One payment is in one currency (MC23), like NetSuite's: the documents it pays are all in it.
      throw new ValidationError(
        `One payment is in one currency: ${k.document} ${document.number} is in ${document.currencyCode}, but ${documents[0].document.number} is in ${documents[0].document.currencyCode}.`,
      );
    }
    if (paymentDate < document.date) {
      throw new ValidationError(`The payment date can't be before the date of ${k.document} ${document.number} (${document.date}).`);
    }
    if (!isPositive(amount)) {
      throw new ValidationError(`The amount for ${k.document} ${document.number} must be more than zero.`);
    }
    if (cmp(amount, document.amountDue!) > 0) {
      throw new ValidationError(
        `The amount for ${k.document} ${document.number} (${toFixedString(amount, scale)}) is more than its amount due (${toFixedString(document.amountDue!, scale)}).`,
      );
    }
  }
  const allocated = sum(documents.map((line) => line.amount));
  let overpayment: Decimal = ZERO_DECIMAL;
  if (cmp(received, allocated) < 0) {
    throw new ValidationError(
      `The amounts for the ${k.documents} add up to ${toFixedString(allocated, scale)}, more than the ${toFixedString(received, scale)} ${kind === "customer" ? "received" : "paid"}.`,
    );
  }
  if (cmp(received, allocated) > 0) {
    const allInFull = documents.every((line) => cmp(line.amount, line.document.amountDue!) === 0);
    if (kind === "supplier") {
      throw new ValidationError(
        `The amounts for the bills add up to ${toFixedString(allocated, scale)}, not the ${toFixedString(received, scale)} paid. Payments to suppliers can't be more than their bills' amounts due.`,
      );
    }
    if (!allInFull) {
      throw new ValidationError(
        `The amounts for the invoices add up to ${toFixedString(allocated, scale)}, less than the ${toFixedString(received, scale)} received. Pay every invoice in full before keeping the extra as an overpayment, or change the amounts.`,
      );
    }
    overpayment = sub(received, allocated);
  }
  const currency = documents[0].document.currencyCode;
  const foreign = currency !== tx.baseCurrency;
  if (!foreign && typedRate != null) {
    throw new ValidationError(`These ${k.documents} are in ${tx.baseCurrency}, so the payment has no exchange rate.`);
  }
  const bank =
    kind === "customer"
      ? await resolveCustomerBankAccount(tx, bankAccountCode, foreign ? currency : null)
      : await resolveSupplierBankAccount(tx, bankAccountCode, foreign ? currency : null);
  const control = kind === "customer" ? await receivableAccountCode(tx) : await payableAccountCode(tx);
  const rate = foreign ? (await exchangeRateFor(tx, { currencyCode: currency, date: paymentDate, typed: typedRate, what: "payment" }))! : null;

  const next = await tx.query<{ id: string }>(`select nextval(pg_get_serial_sequence('${k.batches}', 'id'))::text as id`);
  const batchId = next.rows[0].id;
  const fixed = (value: Decimal) => toFixedString(value, scale);
  const partAmounts = documents.map((line, index) => (index === documents.length - 1 ? add(line.amount, overpayment) : line.amount));
  const numbers = documents.map((line) => line.document.number);
  const described = `${kind === "customer" ? "Payment from" : "Payment to"} ${contactName} for ${numbers.join(", ")}${rate ? ` (${currency} ${fixed(received)} at ${rate})` : ""}`.slice(0, 500);
  const bankBase = rate ? convertAtRate(fixed(received), rate) : fixed(received);
  // A foreign-currency payment (MC20-MC24): each part's share of the bank line, what it clears and its gain.
  const fx: Array<{ baseAmount: string; cleared: string; gain: string; baseOverpayment: string; lines: Array<Record<string, unknown>> }> = [];
  if (rate) {
    const gainAccount = await realisedFxAccountCode(tx);
    let allotted = ZERO_DECIMAL;
    for (const [index, line] of documents.entries()) {
      const partAmount = fixed(partAmounts[index]);
      const baseAmount = index === documents.length - 1 ? toFixedString(sub(dec(bankBase), allotted), 2) : convertAtRate(partAmount, rate);
      allotted = add(allotted, dec(baseAmount));
      const description = `${contactName} · ${line.document.number}`.slice(0, 200);
      const gainLabel = `${line.document.number} paid at ${rate}`;
      if (kind === "customer") {
        const invoice = line.document.invoice!;
        const split = await splitForeignPayment(tx, invoice, partAmount, rate, baseAmount);
        const invoicePart = fixed(sub(partAmounts[index], dec(split.overpayment)));
        fx.push({
          baseAmount,
          cleared: split.cleared,
          gain: split.gain,
          baseOverpayment: split.baseOverpayment,
          lines: [
            ...foreignReceivableLines(control, description, currency, invoice.exchangeRate!, rate, split, invoicePart),
            ...(isZero(dec(split.gain)) ? [] : realisedLines(gainAccount, split.gain, gainLabel)),
          ],
        });
      } else {
        const bill = line.document.bill!;
        const cleared = clearedBase({ amount: bill.amountDue!, base: await openBase(tx, "bill", bill.id) }, partAmount);
        const gain = toFixedString(sub(dec(cleared), dec(baseAmount)), 2);
        fx.push({
          baseAmount,
          cleared,
          gain,
          baseOverpayment: "0.00",
          lines: [
            {
              accountCode: control,
              debitAmount: cleared,
              creditAmount: "0",
              description,
              foreign: { currencyCode: currency, amount: partAmount, rate: bill.exchangeRate!, kind: "carrying_value" as const },
            },
            ...(isZero(dec(gain)) ? [] : realisedLines(gainAccount, gain, gainLabel)),
          ],
        });
      }
    }
  }
  const controlLines = rate
    ? fx.flatMap((part) => part.lines)
    : documents.map((line, index) => ({
        accountCode: control,
        debitAmount: kind === "customer" ? "0" : fixed(partAmounts[index]),
        creditAmount: kind === "customer" ? fixed(partAmounts[index]) : "0",
        description: `${contactName} · ${line.document.number}`.slice(0, 500),
      }));
  const bankLine = {
    accountCode: bank.code,
    debitAmount: kind === "customer" ? bankBase : "0",
    creditAmount: kind === "customer" ? "0" : bankBase,
    description: contactName,
    ...(rate && bank.currencyCode ? { foreign: { currencyCode: currency, amount: fixed(received), rate, kind: "rate" as const } } : {}),
  };
  const posted = await postJournalBody(
    tx,
    `${k.origin}:record`,
    batchId,
    parseJournalBody(
      tx,
      {
        postingDate: paymentDate,
        reference: reference ?? numbers.join(", ").slice(0, 100),
        description: described,
        lines: kind === "customer" ? [bankLine, ...controlLines] : [...controlLines, bankLine],
      },
      { internal: true },
    ),
    { origin: k.origin },
  );

  try {
    await tx.query(
      `insert into ${k.batches} (
         id, command_source, idempotency_key, request_hash, contact_id, payment_date, amount, currency_code,
         bank_account_id, reference, journal_id, created_by_user_id, created_by_email, exchange_rate, base_amount
       ) values ($1, $2, $3, $4, $5, $6, $7::numeric, $8, $9, $10, $11, $12, $13, $14::numeric, $15::numeric)`,
      [
        batchId,
        source,
        idempotencyKey,
        hash,
        contactId,
        paymentDate,
        fixed(received),
        currency,
        bank.id,
        reference,
        posted.journal.id,
        tx.actor.userId,
        tx.actor.email,
        rate,
        rate ? bankBase : null,
      ],
    );
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ConflictError("That idempotency key was already used for a different payment. Use a new key for a new payment.");
    }
    throw error;
  }
  for (const [index, line] of documents.entries()) {
    const partOverpayment = index === documents.length - 1 ? overpayment : ZERO_DECIMAL;
    const values = [
      PART_SOURCE,
      `${k.origin}:${batchId}:${index + 1}`,
      hash,
      line.id,
      paymentDate,
      fixed(partAmounts[index]),
      currency,
      bank.id,
      reference,
      posted.journal.id,
      tx.actor.userId,
      tx.actor.email,
      batchId,
      rate,
      fx[index]?.baseAmount ?? null,
      fx[index]?.cleared ?? null,
      fx[index]?.gain ?? null,
    ];
    if (kind === "customer") {
      await tx.query(
        `insert into customer_payments (
           command_source, idempotency_key, request_hash, invoice_id, payment_date, amount, currency_code,
           bank_account_id, reference, journal_id, created_by_user_id, created_by_email, batch_id,
           exchange_rate, base_amount, base_cleared, realised_gain, overpayment_amount, base_overpayment
         ) values ($1, $2, $3, $4, $5, $6::numeric, $7, $8, $9, $10, $11, $12, $13, $14::numeric, $15::numeric, $16::numeric,
                   $17::numeric, $18::numeric, $19::numeric)`,
        [...values, fixed(partOverpayment), fx[index] ? fx[index].baseOverpayment : null],
      );
    } else {
      await tx.query(
        `insert into supplier_payments (
           command_source, idempotency_key, request_hash, bill_id, payment_date, amount, currency_code,
           bank_account_id, reference, journal_id, created_by_user_id, created_by_email, batch_id,
           exchange_rate, base_amount, base_cleared, realised_gain
         ) values ($1, $2, $3, $4, $5, $6::numeric, $7, $8, $9, $10, $11, $12, $13, $14::numeric, $15::numeric, $16::numeric, $17::numeric)`,
        values,
      );
    }
  }
  await writeAuditEvent(tx, {
    eventType: `${k.origin}.recorded`,
    entityType: k.origin,
    entityId: batchId,
    details: {
      contactId,
      paymentDate,
      amount: fixed(received),
      overpaymentAmount: fixed(overpayment),
      bankAccountCode: bank.code,
      journalId: posted.journal.id,
      ...(rate ? { currencyCode: currency, exchangeRate: rate, baseAmount: bankBase } : {}),
      documents: documents.map((line, index) => ({
        id: line.id,
        number: line.document.number,
        amount: fixed(partAmounts[index]),
        ...(fx[index] ? { baseAmount: fx[index].baseAmount, baseCleared: fx[index].cleared, realisedGain: fx[index].gain } : {}),
      })),
    },
  });
  return { created: true, batch: await getPaymentBatch(tx, kind, batchId) };
}

/**
 * Voids a payment for several documents as a whole (examples MP5, MP6, SMP4):
 * posts the exact reversal of its journal on the void date and voids every
 * part. Refused while a customer batch's overpayment is applied or refunded.
 */
export async function voidPaymentBatch(
  tx: OrgTx,
  kind: BatchKind,
  batchIdInput: unknown,
  command: { source?: unknown; idempotencyKey: unknown; voidDate: unknown },
): Promise<PaymentBatchResult> {
  const k = KINDS[kind];
  const batchId = requireId(batchIdInput, "batchId");
  const source = optionalSource(command.source);
  const idempotencyKey = requireIdempotencyKey(command.idempotencyKey);
  const voidDate = parseIsoDate(command.voidDate, "voidDate");
  const hash = requestHash(`${k.origin}_void`, { batchId, voidDate });
  const replay = async (): Promise<PaymentBatchResult | null> => {
    const earlier = await findByKey(tx, kind, "void", source, idempotencyKey);
    if (!earlier) return null;
    assertSameRequest(earlier.hash, hash, "payment void");
    return { created: false, batch: await getPaymentBatch(tx, kind, earlier.id) };
  };
  const earlier = await replay();
  if (earlier) return earlier;

  const current = await getPaymentBatch(tx, kind, batchId);
  for (const id of current.parts.map((part) => part.documentId).sort((a, b) => Number(a) - Number(b))) {
    await lockDocument(tx, kind, id);
  }
  await tx.query(`select id from ${k.batches} where id = $1 for update`, [batchId]);
  // Overpayment applications and refunds lock the part's payment, so they wait for this void or it waits for them.
  await tx.query(`select id from ${k.payments} where batch_id = $1 order by id for update`, [batchId]);
  const committedMeanwhile = await replay();
  if (committedMeanwhile) return committedMeanwhile;
  const batch = await getPaymentBatch(tx, kind, batchId);
  if (batch.status === "voided") throw new ConflictError("This payment has already been voided.");
  if (voidDate < batch.paymentDate) {
    throw new ValidationError(`The void date can't be before the payment date (${batch.paymentDate}).`);
  }
  if (kind === "customer") {
    const used = await tx.query<{ used: string }>(
      `select coalesce(sum(tohyee_overpayment_used(id)), 0)::text as used from customer_payments where batch_id = $1`,
      [batchId],
    );
    if (isPositive(dec(used.rows[0].used))) {
      throw new ConflictError(
        "This payment's overpayment has been applied or refunded, so it can't be voided. Remove its applications and void its refunds first.",
      );
    }
  }
  const original = await getJournal(tx, batch.journalId);
  const posted = await postJournalBody(
    tx,
    `${k.origin}:void`,
    batchId,
    parseJournalBody(
      tx,
      {
        postingDate: voidDate,
        reference: `VOID-${original.reference}`.slice(0, 100),
        description: `Void of ${original.description ?? "payment"}`.slice(0, 500),
        lines: original.lines.map((line) => ({
          accountCode: line.accountCode,
          debitAmount: line.creditAmount,
          creditAmount: line.debitAmount,
          description: line.description,
          tracking: line.tracking,
          ...sameForeign(line),
        })),
      },
      { internal: true },
    ),

    { origin: k.origin, relatedJournalId: original.id, correctionKind: "reversal" },
  );
  try {
    await tx.query(
      `update ${k.batches}
          set status = 'voided', void_date = $2, void_journal_id = $3, void_command_source = $4,
              void_idempotency_key = $5, void_request_hash = $6, voided_by_user_id = $7, voided_by_email = $8,
              voided_at = now()
        where id = $1`,
      [batchId, voidDate, posted.journal.id, source, idempotencyKey, hash, tx.actor.userId, tx.actor.email],
    );
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ConflictError("That idempotency key was already used for a different payment void. Use a new key for a new payment void.");
    }
    throw error;
  }
  await tx.query(
    `update ${k.payments}
        set status = 'voided', void_date = $2, void_journal_id = $3, void_command_source = '${PART_SOURCE}',
            void_idempotency_key = $7 || id::text, void_request_hash = $4,
            voided_by_user_id = $5, voided_by_email = $6, voided_at = now()
      where batch_id = $1`,
    [batchId, voidDate, posted.journal.id, hash, tx.actor.userId, tx.actor.email, `${k.origin}:${batchId}:void:`],
  );
  await writeAuditEvent(tx, {
    eventType: `${k.origin}.voided`,
    entityType: k.origin,
    entityId: batchId,
    details: { voidDate, amount: batch.amount, journalId: posted.journal.id },
  });
  return { created: true, batch: await getPaymentBatch(tx, kind, batchId) };
}

function capital(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Refreshes the documents a batch paid (for API responses). */
export async function batchDocuments(tx: OrgTx, batch: PaymentBatch) {
  return Promise.all(batch.parts.map((part) => (batch.kind === "customer" ? getInvoice(tx, part.documentId) : getBill(tx, part.documentId))));
}
