import { parseAccountCodeInput } from "@/lib/accounts/service";
import { isBankOrCreditCard } from "@/lib/accounts/types";
import { writeAuditEvent } from "@/lib/audit";
import { parseIsoDate } from "@/lib/dates";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { assertSameRequest, requestHash } from "@/lib/idempotency";
import { getPayment, PAYMENT_SELECT, toPayment, type CustomerPayment } from "@/lib/invoices/payments";
import { controlAccountCode, lockInvoice, RECEIVABLE_ACCOUNT } from "@/lib/invoices/service";
import { getJournal, parseJournalBody, postJournalBody } from "@/lib/ledger/journals";
import { assertPostingDateAllowed } from "@/lib/ledger/period-controls";
import { currencyMinorUnits } from "@/lib/money/currency";
import { add, cmp, dec, isZero, parseDecimalInput, toFixedString, toPlainString, ZERO_DECIMAL } from "@/lib/money/decimal";
import {
  asRecord,
  optionalBoolean,
  optionalId,
  optionalSource,
  optionalString,
  requireArray,
  requireId,
  requireIdempotencyKey,
} from "@/lib/validation";

/**
 * Customer overpayments (examples OP1-OP11): the part of a payment beyond its
 * invoice's amount due when it was recorded. It sits in accounts receivable as
 * credit for the customer, and works like a credit note's remaining credit:
 *
 * - applying it to the same customer's other approved invoices posts no
 *   journal (both sides are accounts receivable), all or nothing across one
 *   or more invoices; an application can be removed once;
 * - refunding it posts Dr accounts receivable / Cr the bank account; a refund
 *   can be voided once, which posts the exact reversal.
 *
 * An overpayment is identified by its payment's id. No GST is posted: the
 * invoice already carried the GST. Period locks apply by date even when no
 * journal is posted.
 */
export const OVERPAYMENT_APPLICATION_STATUSES = ["active", "removed"] as const;
export type OverpaymentApplicationStatus = (typeof OVERPAYMENT_APPLICATION_STATUSES)[number];
export const OVERPAYMENT_REFUND_STATUSES = ["active", "voided"] as const;
export type OverpaymentRefundStatus = (typeof OVERPAYMENT_REFUND_STATUSES)[number];

export type OverpaymentApplication = {
  id: string;
  paymentId: string;
  /** The invoice the payment overpaid. */
  sourceInvoiceId: string;
  sourceInvoiceNumber: string;
  invoiceId: string;
  invoiceNumber: string;
  status: OverpaymentApplicationStatus;
  applicationDate: string;
  amount: string;
  currencyCode: string;
  createdByEmail: string | null;
  createdAt: string;
  removalDate: string | null;
  removedByEmail: string | null;
  removedAt: string | null;
};

export type OverpaymentRefund = {
  id: string;
  paymentId: string;
  status: OverpaymentRefundStatus;
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

type ApplicationRow = {
  id: string;
  payment_id: string;
  source_invoice_id: string;
  source_invoice_number: string;
  invoice_id: string;
  invoice_number: string;
  status: OverpaymentApplicationStatus;
  application_date: string;
  amount: string;
  currency_code: string;
  created_by_email: string | null;
  created_at: string;
  removal_date: string | null;
  removed_by_email: string | null;
  removed_at: string | null;
};

type RefundRow = {
  id: string;
  payment_id: string;
  status: OverpaymentRefundStatus;
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

/** The most invoices one command can apply overpayment credit to. */
const MAX_APPLICATIONS = 100;

const APPLICATION_SELECT = `select o.id, o.payment_id, p.invoice_id as source_invoice_id,
       s.invoice_number as source_invoice_number, o.invoice_id, i.invoice_number, o.status, o.application_date,
       o.amount, o.currency_code, o.created_by_email, o.created_at, o.removal_date, o.removed_by_email, o.removed_at
  from customer_overpayment_applications o
  join customer_payments p on p.id = o.payment_id
  join sales_invoices s on s.id = p.invoice_id
  join sales_invoices i on i.id = o.invoice_id`;

const REFUND_SELECT = `select r.id, r.payment_id, r.status, r.refund_date, r.amount, r.currency_code, r.bank_account_id,
       a.code as bank_account_code, a.name as bank_account_name, r.reference, r.journal_id, r.created_by_email,
       r.created_at, r.void_date, r.void_journal_id, r.voided_by_email, r.voided_at
  from customer_overpayment_refunds r
  join accounts a on a.id = r.bank_account_id`;

function toApplication(row: ApplicationRow): OverpaymentApplication {
  return {
    id: row.id,
    paymentId: row.payment_id,
    sourceInvoiceId: row.source_invoice_id,
    sourceInvoiceNumber: row.source_invoice_number,
    invoiceId: row.invoice_id,
    invoiceNumber: row.invoice_number,
    status: row.status,
    applicationDate: row.application_date,
    amount: toFixedString(dec(row.amount), currencyMinorUnits(row.currency_code)),
    currencyCode: row.currency_code,
    createdByEmail: row.created_by_email,
    createdAt: row.created_at,
    removalDate: row.removal_date,
    removedByEmail: row.removed_by_email,
    removedAt: row.removed_at,
  };
}

function toRefund(row: RefundRow): OverpaymentRefund {
  return {
    id: row.id,
    paymentId: row.payment_id,
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

async function getApplication(tx: OrgTx, applicationId: string): Promise<OverpaymentApplication> {
  const result = await tx.query<ApplicationRow>(`${APPLICATION_SELECT} where o.id = $1`, [applicationId]);
  const row = result.rows[0];
  if (!row) {
    throw new NotFoundError("Application not found.");
  }
  return toApplication(row);
}

async function getApplications(tx: OrgTx, applicationIds: string[]): Promise<OverpaymentApplication[]> {
  const result = await tx.query<ApplicationRow>(`${APPLICATION_SELECT} where o.id = any($1::bigint[]) order by o.id`, [
    applicationIds,
  ]);
  return result.rows.map(toApplication);
}

async function getRefund(tx: OrgTx, refundId: string): Promise<OverpaymentRefund> {
  const result = await tx.query<RefundRow>(`${REFUND_SELECT} where r.id = $1`, [refundId]);
  const row = result.rows[0];
  if (!row) {
    throw new NotFoundError("Refund not found.");
  }
  return toRefund(row);
}

function paymentLabel(payment: CustomerPayment): string {
  return `The overpayment on ${payment.invoiceNumber} (payment of ${payment.amount} on ${payment.paymentDate})`;
}

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string }).code === "23505";
}

/** A payment with its overpayment details, for the overpayment's page. */
export async function getOverpayment(tx: OrgTx, paymentIdInput: unknown): Promise<CustomerPayment> {
  const paymentId = requireId(paymentIdInput, "paymentId");
  const payment = await getPayment(tx, paymentId);
  if (isZero(dec(payment.overpaymentAmount))) {
    throw new NotFoundError("This payment has no overpayment.");
  }
  return payment;
}

/**
 * Payments with an overpayment, newest first. `contactId` keeps one
 * customer's; `hasRemainingCredit` keeps only active ones with some left.
 */
export async function listOverpayments(
  tx: OrgTx,
  filters: { contactId?: unknown; hasRemainingCredit?: unknown } = {},
): Promise<CustomerPayment[]> {
  const contactId = optionalId(filters.contactId, "contactId");
  const hasRemainingCredit = optionalBoolean(filters.hasRemainingCredit, "hasRemainingCredit") ?? false;
  const result = await tx.query<Parameters<typeof toPayment>[0]>(
    `${PAYMENT_SELECT}
      where p.overpayment_amount > 0
        and ($1::bigint is null or i.contact_id = $1)
        and (not $2::boolean
             or (p.status = 'active' and used.overpayment_applied + used.overpayment_refunded < p.overpayment_amount))
      order by p.payment_date desc, p.id desc
      limit 200`,
    [contactId, hasRemainingCredit],
  );
  return result.rows.map(toPayment);
}

/** An overpayment's applications, active and removed, oldest first. */
export async function listOverpaymentApplications(
  tx: OrgTx,
  paymentIdInput: unknown,
): Promise<OverpaymentApplication[]> {
  const paymentId = requireId(paymentIdInput, "paymentId");
  await getPayment(tx, paymentId);
  const result = await tx.query<ApplicationRow>(
    `${APPLICATION_SELECT} where o.payment_id = $1 order by o.application_date, o.id`,
    [paymentId],
  );
  return result.rows.map(toApplication);
}

/** The overpayment credit applied to an invoice, active and removed, oldest first. */
export async function listInvoiceOverpaymentCredit(
  tx: OrgTx,
  invoiceIdInput: unknown,
): Promise<OverpaymentApplication[]> {
  const invoiceId = requireId(invoiceIdInput, "invoiceId");
  const result = await tx.query<ApplicationRow>(
    `${APPLICATION_SELECT} where o.invoice_id = $1 order by o.application_date, o.id`,
    [invoiceId],
  );
  return result.rows.map(toApplication);
}

/** An overpayment's refunds, active and voided, oldest first. */
export async function listOverpaymentRefunds(tx: OrgTx, paymentIdInput: unknown): Promise<OverpaymentRefund[]> {
  const paymentId = requireId(paymentIdInput, "paymentId");
  await getPayment(tx, paymentId);
  const result = await tx.query<RefundRow>(`${REFUND_SELECT} where r.payment_id = $1 order by r.refund_date, r.id`, [
    paymentId,
  ]);
  return result.rows.map(toRefund);
}

/**
 * Locks a payment until the transaction ends. Applications and refunds lock
 * the payment first, then any invoices by id: the same order as the database
 * checks.
 */
async function lockPayment(tx: OrgTx, paymentId: string): Promise<CustomerPayment> {
  const locked = await tx.query("select id from customer_payments where id = $1 for update", [paymentId]);
  if (locked.rowCount === 0) {
    throw new NotFoundError("Payment not found.");
  }
  return getPayment(tx, paymentId);
}

/** An overpayment can only be used while its payment is active and some of it is left. */
function assertUsable(payment: CustomerPayment, action: "applied" | "refunded"): void {
  if (isZero(dec(payment.overpaymentAmount))) {
    throw new ConflictError(
      `The payment of ${payment.amount} on ${payment.invoiceNumber} has no overpayment, so nothing can be ${action}.`,
    );
  }
  if (payment.status === "voided") {
    throw new ConflictError(`${paymentLabel(payment)} was voided, so it can't be ${action}.`);
  }
  if (isZero(dec(payment.overpaymentRemaining))) {
    throw new ConflictError(`${paymentLabel(payment)} has no credit left.`);
  }
}

type ApplyResult = { created: boolean; applications: OverpaymentApplication[]; payment: CustomerPayment };
type RemoveResult = { created: boolean; application: OverpaymentApplication; payment: CustomerPayment };
type RefundResult = { created: boolean; refund: OverpaymentRefund; payment: CustomerPayment };

/**
 * Applies an overpayment to one or more approved invoices of the same
 * customer and currency, all or nothing (examples OP2 and OP5). Each amount
 * must be more than zero and not more than that invoice's amount due, the
 * total not more than the overpayment left, and the date on or after the
 * payment's and each invoice's date, in an open period. No journal posts.
 */
export async function applyOverpayment(
  tx: OrgTx,
  paymentIdInput: unknown,
  command: { source?: unknown; idempotencyKey: unknown; applicationDate: unknown; applications: unknown },
): Promise<ApplyResult> {
  const paymentId = requireId(paymentIdInput, "paymentId");
  const source = optionalSource(command.source);
  const idempotencyKey = requireIdempotencyKey(command.idempotencyKey);
  const applicationDate = parseIsoDate(command.applicationDate, "applicationDate");
  // Payments are always in the base currency, like the approved invoices they pay.
  const scale = currencyMinorUnits(tx.baseCurrency);
  const rawApplications = requireArray(command.applications, "applications", MAX_APPLICATIONS);
  if (rawApplications.length === 0) {
    throw new ValidationError("Apply the overpayment to at least one invoice.");
  }
  const seen = new Set<string>();
  const wanted = rawApplications.map((raw, index) => {
    const label = `Application ${index + 1}`;
    const entry = asRecord(raw, label);
    const invoiceId = requireId(entry.invoiceId, `${label} invoiceId`);
    if (seen.has(invoiceId)) {
      throw new ValidationError(`${label} is for invoice #${invoiceId} again. Apply credit to each invoice once.`);
    }
    seen.add(invoiceId);
    const amount = dec(parseDecimalInput(entry.amount, `${label} amount`, { maxScale: scale }));
    return { label, invoiceId, amount };
  });
  const hash = requestHash("overpayment_application", {
    paymentId,
    applicationDate,
    applications: wanted.map((entry) => ({ invoiceId: entry.invoiceId, amount: toPlainString(entry.amount) })),
  });
  const replay = async (): Promise<ApplyResult | null> => {
    const earlier = await tx.query<{ id: string; payment_id: string; request_hash: string }>(
      `select id, payment_id, request_hash from customer_overpayment_applications
        where command_source = $1 and idempotency_key = $2 order by id`,
      [source, idempotencyKey],
    );
    if (earlier.rows.length === 0) {
      return null;
    }
    for (const row of earlier.rows) {
      assertSameRequest(row.request_hash, hash, "overpayment application");
    }
    return {
      created: false,
      applications: await getApplications(tx, earlier.rows.map((row) => row.id)),
      payment: await getPayment(tx, earlier.rows[0].payment_id),
    };
  };

  const earlier = await replay();
  if (earlier) {
    return earlier;
  }
  const payment = await lockPayment(tx, paymentId);
  // The original of a retry may have committed while this request waited for the lock.
  const committedMeanwhile = await replay();
  if (committedMeanwhile) {
    return committedMeanwhile;
  }
  assertUsable(payment, "applied");
  if (applicationDate < payment.paymentDate) {
    throw new ValidationError(`The application date can't be before the payment date (${payment.paymentDate}).`);
  }
  for (const entry of wanted) {
    if (entry.invoiceId === payment.invoiceId) {
      // Checked before locking, so invoices are always locked after the payment.
      throw new ValidationError(
        `${entry.label}: an overpayment can't be applied to ${payment.invoiceNumber}, the invoice it overpaid.`,
      );
    }
  }

  const sorted = [...wanted].sort((a, b) => cmp(dec(a.invoiceId), dec(b.invoiceId)));
  const invoices = new Map<string, Awaited<ReturnType<typeof lockInvoice>>>();
  for (const entry of sorted) {
    let invoice;
    try {
      invoice = await lockInvoice(tx, entry.invoiceId);
    } catch (error) {
      if (error instanceof NotFoundError) {
        throw new ValidationError(`${entry.label}: there's no invoice #${entry.invoiceId}.`);
      }
      throw error;
    }
    invoices.set(entry.invoiceId, invoice);
  }

  let total = ZERO_DECIMAL;
  for (const entry of wanted) {
    const invoice = invoices.get(entry.invoiceId)!;
    const name = invoice.invoiceNumber ? `invoice ${invoice.invoiceNumber}` : `draft invoice #${invoice.id}`;
    if (invoice.status === "draft") {
      throw new ConflictError(`${entry.label}: ${name} is still a draft, so credit can't be applied to it.`);
    }
    if (invoice.status === "voided") {
      throw new ConflictError(`${entry.label}: ${name} has been voided, so credit can't be applied to it.`);
    }
    if (invoice.contactId !== payment.contactId) {
      throw new ValidationError(
        `${entry.label}: ${name} is for ${invoice.contactName}, not ${payment.contactName}. An overpayment can only be applied to the same customer's invoices.`,
      );
    }
    if (invoice.currencyCode !== payment.currencyCode) {
      throw new ValidationError(
        `${entry.label}: ${name} is in ${invoice.currencyCode}, but the payment is in ${payment.currencyCode}. Applying credit across currencies isn't supported yet.`,
      );
    }
    if (applicationDate < invoice.invoiceDate) {
      throw new ValidationError(
        `${entry.label}: the application date can't be before the invoice date of ${name} (${invoice.invoiceDate}).`,
      );
    }
    if (cmp(entry.amount, dec(invoice.amountDue!)) > 0) {
      throw new ValidationError(
        `${entry.label}: ${toFixedString(entry.amount, scale)} is more than the amount due on ${name} (${invoice.amountDue}).`,
      );
    }
    total = add(total, entry.amount);
  }
  if (cmp(total, dec(payment.overpaymentRemaining)) > 0) {
    throw new ValidationError(
      `The credit applied (${toFixedString(total, scale)}) is more than the overpayment left (${payment.overpaymentRemaining}).`,
    );
  }
  await assertPostingDateAllowed(tx, applicationDate);

  const ids: string[] = [];
  for (const entry of sorted) {
    const amount = toFixedString(entry.amount, scale);
    let inserted;
    try {
      inserted = await tx.query<{ id: string }>(
        `insert into customer_overpayment_applications (
           command_source, idempotency_key, request_hash, payment_id, invoice_id, application_date, amount,
           currency_code, created_by_user_id, created_by_email
         )
         values ($1, $2, $3, $4, $5, $6, $7::numeric, $8, $9, $10)
         returning id`,
        [
          source,
          idempotencyKey,
          hash,
          paymentId,
          entry.invoiceId,
          applicationDate,
          amount,
          payment.currencyCode,
          tx.actor.userId,
          tx.actor.email,
        ],
      );
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictError(
          "That idempotency key was already used for a different overpayment application. Use a new key for a new application.",
        );
      }
      throw error;
    }
    const applicationId = inserted.rows[0].id;
    ids.push(applicationId);
    const invoice = invoices.get(entry.invoiceId)!;
    await writeAuditEvent(tx, {
      eventType: "overpayment.applied",
      entityType: "customer_overpayment_application",
      entityId: applicationId,
      details: {
        paymentId,
        sourceInvoiceNumber: payment.invoiceNumber,
        invoiceId: entry.invoiceId,
        invoiceNumber: invoice.invoiceNumber,
        applicationDate,
        amount,
      },
    });
  }
  return { created: true, applications: await getApplications(tx, ids), payment: await getPayment(tx, paymentId) };
}

/**
 * Removes an overpayment application (example OP6): the credit is available
 * again and the invoice's amount due goes back up. No journal posts. The
 * removal date must be on or after the application date and in an open
 * period. An application can only be removed once.
 */
export async function removeOverpaymentApplication(
  tx: OrgTx,
  paymentIdInput: unknown,
  applicationIdInput: unknown,
  command: { source?: unknown; idempotencyKey: unknown; removalDate: unknown },
): Promise<RemoveResult> {
  const paymentId = requireId(paymentIdInput, "paymentId");
  const applicationId = requireId(applicationIdInput, "applicationId");
  const source = optionalSource(command.source);
  const idempotencyKey = requireIdempotencyKey(command.idempotencyKey);
  const removalDate = parseIsoDate(command.removalDate, "removalDate");
  const onPayment = await tx.query<{ invoice_id: string }>(
    "select invoice_id from customer_overpayment_applications where id = $1 and payment_id = $2",
    [applicationId, paymentId],
  );
  const invoiceId = onPayment.rows[0]?.invoice_id;
  if (!invoiceId) {
    throw new NotFoundError("Application not found.");
  }
  const hash = requestHash("overpayment_application_removal", { applicationId, removalDate });
  const replay = async (): Promise<RemoveResult | null> => {
    const earlier = await tx.query<{ id: string; payment_id: string; hash: string }>(
      `select id, payment_id, removal_request_hash as hash from customer_overpayment_applications
        where removal_command_source = $1 and removal_idempotency_key = $2`,
      [source, idempotencyKey],
    );
    const row = earlier.rows[0];
    if (!row) {
      return null;
    }
    assertSameRequest(row.hash, hash, "application removal");
    return {
      created: false,
      application: await getApplication(tx, row.id),
      payment: await getPayment(tx, row.payment_id),
    };
  };

  const earlier = await replay();
  if (earlier) {
    return earlier;
  }
  const payment = await lockPayment(tx, paymentId);
  await lockInvoice(tx, invoiceId);
  const committedMeanwhile = await replay();
  if (committedMeanwhile) {
    return committedMeanwhile;
  }
  const application = await getApplication(tx, applicationId);
  if (application.status === "removed") {
    throw new ConflictError("This application has already been removed.");
  }
  if (removalDate < application.applicationDate) {
    throw new ValidationError(`The removal date can't be before the application date (${application.applicationDate}).`);
  }
  await assertPostingDateAllowed(tx, removalDate);

  try {
    await tx.query(
      `update customer_overpayment_applications
          set status = 'removed', removal_date = $2, removal_command_source = $3, removal_idempotency_key = $4,
              removal_request_hash = $5, removed_by_user_id = $6, removed_by_email = $7, removed_at = now()
        where id = $1`,
      [applicationId, removalDate, source, idempotencyKey, hash, tx.actor.userId, tx.actor.email],
    );
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ConflictError(
        "That idempotency key was already used for a different application removal. Use a new key for a new removal.",
      );
    }
    throw error;
  }
  await writeAuditEvent(tx, {
    eventType: "overpayment.application_removed",
    entityType: "customer_overpayment_application",
    entityId: applicationId,
    details: {
      paymentId,
      sourceInvoiceNumber: payment.invoiceNumber,
      invoiceId,
      invoiceNumber: application.invoiceNumber,
      removalDate,
      amount: application.amount,
    },
  });
  return {
    created: true,
    application: await getApplication(tx, applicationId),
    payment: await getPayment(tx, paymentId),
  };
}

/**
 * The account a refund is paid from (example OP7): an active bank account in
 * the base currency.
 */
async function resolveBankAccount(tx: OrgTx, code: string): Promise<{ id: string; code: string; name: string }> {
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

async function findRefundByKey(
  tx: OrgTx,
  command: "record" | "void",
  source: string,
  idempotencyKey: string,
): Promise<{ id: string; paymentId: string; hash: string } | null> {
  const columns =
    command === "record"
      ? { source: "command_source", key: "idempotency_key", hash: "request_hash" }
      : { source: "void_command_source", key: "void_idempotency_key", hash: "void_request_hash" };
  const result = await tx.query<{ id: string; payment_id: string; hash: string }>(
    `select id, payment_id, ${columns.hash} as hash from customer_overpayment_refunds
      where ${columns.source} = $1 and ${columns.key} = $2`,
    [source, idempotencyKey],
  );
  const row = result.rows[0];
  return row ? { id: row.id, paymentId: row.payment_id, hash: row.hash } : null;
}

/**
 * Refunds some or all of what's left of an overpayment to the customer
 * (example OP7): posts Dr accounts receivable / Cr the bank account on the
 * refund date. It can't be more than what's left, dated before the payment,
 * or dated in a locked period.
 */
export async function refundOverpayment(
  tx: OrgTx,
  paymentIdInput: unknown,
  command: {
    source?: unknown;
    idempotencyKey: unknown;
    refundDate: unknown;
    amount: unknown;
    bankAccountCode: unknown;
    reference?: unknown;
  },
): Promise<RefundResult> {
  const paymentId = requireId(paymentIdInput, "paymentId");
  const source = optionalSource(command.source);
  const idempotencyKey = requireIdempotencyKey(command.idempotencyKey);
  const refundDate = parseIsoDate(command.refundDate, "refundDate");
  const scale = currencyMinorUnits(tx.baseCurrency);
  const amount = dec(parseDecimalInput(command.amount, "amount", { maxScale: scale }));
  const bankAccountCode = parseAccountCodeInput(command.bankAccountCode, "bankAccountCode");
  const reference = optionalString(command.reference, "reference", { maxLength: 100 });
  const hash = requestHash("overpayment_refund", {
    paymentId,
    refundDate,
    amount: toPlainString(amount),
    bankAccountCode: bankAccountCode.toLowerCase(),
    reference,
  });
  const replay = async (): Promise<RefundResult | null> => {
    const earlier = await findRefundByKey(tx, "record", source, idempotencyKey);
    if (!earlier) {
      return null;
    }
    assertSameRequest(earlier.hash, hash, "refund");
    return { created: false, refund: await getRefund(tx, earlier.id), payment: await getPayment(tx, earlier.paymentId) };
  };

  const earlier = await replay();
  if (earlier) {
    return earlier;
  }
  const payment = await lockPayment(tx, paymentId);
  const committedMeanwhile = await replay();
  if (committedMeanwhile) {
    return committedMeanwhile;
  }
  assertUsable(payment, "refunded");
  if (refundDate < payment.paymentDate) {
    throw new ValidationError(`The refund date can't be before the payment date (${payment.paymentDate}).`);
  }
  if (cmp(amount, dec(payment.overpaymentRemaining)) > 0) {
    throw new ValidationError(
      `The refund of ${toFixedString(amount, scale)} is more than the overpayment left (${payment.overpaymentRemaining}).`,
    );
  }
  const bank = await resolveBankAccount(tx, bankAccountCode);
  const receivable = await controlAccountCode(tx, RECEIVABLE_ACCOUNT, "refunds can't be recorded");

  // The journal is keyed by the refund's id, so it's taken first.
  const next = await tx.query<{ id: string }>(
    "select nextval(pg_get_serial_sequence('customer_overpayment_refunds', 'id'))::text as id",
  );
  const refundId = next.rows[0].id;
  const fixedAmount = toFixedString(amount, scale);
  const customer = payment.contactName;
  const posted = await postJournalBody(
    tx,
    "customer_overpayment_refund:record",
    refundId,
    parseJournalBody(tx, {
      postingDate: refundDate,
      reference: reference ?? payment.invoiceNumber,
      description: `Refund of overpayment to ${customer} on ${payment.invoiceNumber}`,
      lines: [
        { accountCode: receivable, debitAmount: fixedAmount, creditAmount: "0", description: customer },
        { accountCode: bank.code, debitAmount: "0", creditAmount: fixedAmount, description: customer },
      ],
    }),
    { origin: "customer_overpayment_refund" },
  );

  try {
    await tx.query(
      `insert into customer_overpayment_refunds (
         id, command_source, idempotency_key, request_hash, payment_id, refund_date, amount, currency_code,
         bank_account_id, reference, journal_id, created_by_user_id, created_by_email
       )
       values ($1, $2, $3, $4, $5, $6, $7::numeric, $8, $9, $10, $11, $12, $13)`,
      [
        refundId,
        source,
        idempotencyKey,
        hash,
        paymentId,
        refundDate,
        fixedAmount,
        payment.currencyCode,
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
    eventType: "overpayment.refunded",
    entityType: "customer_overpayment_refund",
    entityId: refundId,
    details: {
      paymentId,
      sourceInvoiceNumber: payment.invoiceNumber,
      refundDate,
      amount: fixedAmount,
      bankAccountCode: bank.code,
      journalId: posted.journal.id,
    },
  });
  return { created: true, refund: await getRefund(tx, refundId), payment: await getPayment(tx, paymentId) };
}

/**
 * Voids an overpayment refund (example OP7): posts the exact reversal of its
 * journal on the void date, which must be in an open period and not before
 * the refund. The credit is available again. A refund can only be voided once.
 */
export async function voidOverpaymentRefund(
  tx: OrgTx,
  paymentIdInput: unknown,
  refundIdInput: unknown,
  command: { source?: unknown; idempotencyKey: unknown; voidDate: unknown },
): Promise<RefundResult> {
  const paymentId = requireId(paymentIdInput, "paymentId");
  const refundId = requireId(refundIdInput, "refundId");
  const source = optionalSource(command.source);
  const idempotencyKey = requireIdempotencyKey(command.idempotencyKey);
  const voidDate = parseIsoDate(command.voidDate, "voidDate");
  const onPayment = await tx.query("select id from customer_overpayment_refunds where id = $1 and payment_id = $2", [
    refundId,
    paymentId,
  ]);
  if (onPayment.rowCount === 0) {
    throw new NotFoundError("Refund not found.");
  }
  const hash = requestHash("overpayment_refund_void", { refundId, voidDate });
  const replay = async (): Promise<RefundResult | null> => {
    const earlier = await findRefundByKey(tx, "void", source, idempotencyKey);
    if (!earlier) {
      return null;
    }
    assertSameRequest(earlier.hash, hash, "refund void");
    return { created: false, refund: await getRefund(tx, earlier.id), payment: await getPayment(tx, earlier.paymentId) };
  };

  const earlier = await replay();
  if (earlier) {
    return earlier;
  }
  const payment = await lockPayment(tx, paymentId);
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
    "customer_overpayment_refund:void",
    refundId,
    parseJournalBody(tx, {
      postingDate: voidDate,
      reference: `VOID-${original.reference}`.slice(0, 100),
      description: `Void of refund of overpayment to ${payment.contactName} on ${payment.invoiceNumber}`,
      lines: original.lines.map((line) => ({
        accountCode: line.accountCode,
        debitAmount: line.creditAmount,
        creditAmount: line.debitAmount,
        description: line.description,
      })),
    }),
    { origin: "customer_overpayment_refund", relatedJournalId: original.id, correctionKind: "reversal" },
  );

  try {
    await tx.query(
      `update customer_overpayment_refunds
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
    eventType: "overpayment.refund_voided",
    entityType: "customer_overpayment_refund",
    entityId: refundId,
    details: {
      paymentId,
      sourceInvoiceNumber: payment.invoiceNumber,
      voidDate,
      amount: refund.amount,
      journalId: posted.journal.id,
    },
  });
  return { created: true, refund: await getRefund(tx, refundId), payment: await getPayment(tx, paymentId) };
}
