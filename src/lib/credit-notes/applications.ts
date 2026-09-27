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
import { lockInvoice } from "@/lib/invoices/service";
import { assertPostingDateAllowed } from "@/lib/ledger/period-controls";
import { currencyMinorUnits } from "@/lib/money/currency";
import { add, cmp, dec, parseDecimalInput, toFixedString, toPlainString, ZERO_DECIMAL } from "@/lib/money/decimal";
import {
  asRecord,
  optionalSource,
  requireArray,
  requireId,
  requireIdempotencyKey,
} from "@/lib/validation";

/**
 * Credit from an approved sales credit note applied to approved invoices of
 * the same customer and currency (examples CN3-CN7, CN11, CN12). Applying
 * posts no journal, because both sides are accounts receivable; it only
 * lowers the invoice's amount due and the credit note's remaining credit.
 * One command can apply credit to several invoices, all or nothing. An
 * application can be removed once, which fills in its removal details; rows
 * are never deleted. Period locks still apply by date.
 */
export const APPLICATION_STATUSES = ["active", "removed"] as const;
export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];

export type CreditNoteApplication = {
  id: string;
  creditNoteId: string;
  creditNoteNumber: string;
  invoiceId: string;
  invoiceNumber: string;
  status: ApplicationStatus;
  applicationDate: string;
  amount: string;
  currencyCode: string;
  createdByEmail: string | null;
  createdAt: string;
  removalDate: string | null;
  removedByEmail: string | null;
  removedAt: string | null;
};

type ApplicationRow = {
  id: string;
  credit_note_id: string;
  credit_note_number: string;
  invoice_id: string;
  invoice_number: string;
  status: ApplicationStatus;
  application_date: string;
  amount: string;
  currency_code: string;
  created_by_email: string | null;
  created_at: string;
  removal_date: string | null;
  removed_by_email: string | null;
  removed_at: string | null;
};

/** The most invoices one command can apply credit to. */
const MAX_APPLICATIONS = 100;

const APPLICATION_SELECT = `select a.id, a.credit_note_id, n.credit_note_number, a.invoice_id, i.invoice_number, a.status,
       a.application_date, a.amount, a.currency_code, a.created_by_email, a.created_at, a.removal_date,
       a.removed_by_email, a.removed_at
  from sales_credit_note_applications a
  join sales_credit_notes n on n.id = a.credit_note_id
  join sales_invoices i on i.id = a.invoice_id`;

function toApplication(row: ApplicationRow): CreditNoteApplication {
  return {
    id: row.id,
    creditNoteId: row.credit_note_id,
    creditNoteNumber: row.credit_note_number,
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

async function getApplication(tx: OrgTx, applicationId: string): Promise<CreditNoteApplication> {
  const result = await tx.query<ApplicationRow>(`${APPLICATION_SELECT} where a.id = $1`, [applicationId]);
  const row = result.rows[0];
  if (!row) {
    throw new NotFoundError("Application not found.");
  }
  return toApplication(row);
}

async function getApplications(tx: OrgTx, applicationIds: string[]): Promise<CreditNoteApplication[]> {
  const result = await tx.query<ApplicationRow>(`${APPLICATION_SELECT} where a.id = any($1::bigint[]) order by a.id`, [
    applicationIds,
  ]);
  return result.rows.map(toApplication);
}

/** A credit note's applications, active and removed, oldest first. */
export async function listApplications(tx: OrgTx, creditNoteIdInput: unknown): Promise<CreditNoteApplication[]> {
  const creditNoteId = requireId(creditNoteIdInput, "creditNoteId");
  const creditNote = await tx.query("select id from sales_credit_notes where id = $1", [creditNoteId]);
  if (creditNote.rowCount === 0) {
    throw new NotFoundError("Credit note not found.");
  }
  const result = await tx.query<ApplicationRow>(
    `${APPLICATION_SELECT} where a.credit_note_id = $1 order by a.application_date, a.id`,
    [creditNoteId],
  );
  return result.rows.map(toApplication);
}

/** The credit applied to an invoice, active and removed, oldest first. */
export async function listInvoiceCredit(tx: OrgTx, invoiceIdInput: unknown): Promise<CreditNoteApplication[]> {
  const invoiceId = requireId(invoiceIdInput, "invoiceId");
  const result = await tx.query<ApplicationRow>(
    `${APPLICATION_SELECT} where a.invoice_id = $1 order by a.application_date, a.id`,
    [invoiceId],
  );
  return result.rows.map(toApplication);
}

type ApplyResult = { created: boolean; applications: CreditNoteApplication[]; creditNote: CreditNote };
type RemoveResult = { created: boolean; application: CreditNoteApplication; creditNote: CreditNote };

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string }).code === "23505";
}

/**
 * Applies an approved credit note's credit to one or more approved invoices
 * of the same customer and currency, all or nothing (examples CN3-CN5). Each
 * amount must be more than zero and not more than that invoice's amount due,
 * the total not more than the remaining credit, and the date on or after the
 * credit note's and each invoice's date, in an open period. No journal posts.
 */
export async function applyCreditNote(
  tx: OrgTx,
  creditNoteIdInput: unknown,
  command: { source?: unknown; idempotencyKey: unknown; applicationDate: unknown; applications: unknown },
): Promise<ApplyResult> {
  const creditNoteId = requireId(creditNoteIdInput, "creditNoteId");
  const source = optionalSource(command.source);
  const idempotencyKey = requireIdempotencyKey(command.idempotencyKey);
  const applicationDate = parseIsoDate(command.applicationDate, "applicationDate");
  // Approved credit notes are always in the base currency: it can't change once anything is posted.
  const scale = currencyMinorUnits(tx.baseCurrency);
  const rawApplications = requireArray(command.applications, "applications", MAX_APPLICATIONS);
  if (rawApplications.length === 0) {
    throw new ValidationError("Apply credit to at least one invoice.");
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
  const hash = requestHash("credit_note_application", {
    creditNoteId,
    applicationDate,
    applications: wanted.map((entry) => ({ invoiceId: entry.invoiceId, amount: toPlainString(entry.amount) })),
  });
  const replay = async (): Promise<ApplyResult | null> => {
    const earlier = await tx.query<{ id: string; credit_note_id: string; request_hash: string }>(
      `select id, credit_note_id, request_hash from sales_credit_note_applications
        where command_source = $1 and idempotency_key = $2 order by id`,
      [source, idempotencyKey],
    );
    if (earlier.rows.length === 0) {
      return null;
    }
    for (const row of earlier.rows) {
      assertSameRequest(row.request_hash, hash, "credit note application");
    }
    return {
      created: false,
      applications: await getApplications(tx, earlier.rows.map((row) => row.id)),
      creditNote: await getCreditNote(tx, earlier.rows[0].credit_note_id),
    };
  };

  const earlier = await replay();
  if (earlier) {
    return earlier;
  }
  // The credit note first, then its invoices by id: the same order as the database checks.
  const creditNote = await lockCreditNote(tx, creditNoteId);
  // The original of a retry may have committed while this request waited for the lock.
  const committedMeanwhile = await replay();
  if (committedMeanwhile) {
    return committedMeanwhile;
  }
  if (creditNote.status === "draft") {
    throw new ConflictError("This credit note is still a draft, so its credit can't be applied. Approve it first.");
  }
  if (creditNote.status === "voided") {
    throw new ConflictError(`${creditNoteLabel(creditNote)} has been voided, so its credit can't be applied.`);
  }
  if (applicationDate < creditNote.creditNoteDate) {
    throw new ValidationError(
      `The application date can't be before the credit note date (${creditNote.creditNoteDate}).`,
    );
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
    if (invoice.contactId !== creditNote.contactId) {
      throw new ValidationError(
        `${entry.label}: ${name} is for ${invoice.contactName}, not ${creditNote.contactName}. Credit can only be applied to the same customer's invoices.`,
      );
    }
    if (invoice.currencyCode !== creditNote.currencyCode) {
      throw new ValidationError(
        `${entry.label}: ${name} is in ${invoice.currencyCode}, but the credit note is in ${creditNote.currencyCode}. Applying credit across currencies isn't supported yet.`,
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
  if (cmp(total, dec(creditNote.remainingCredit!)) > 0) {
    throw new ValidationError(
      `The credit applied (${toFixedString(total, scale)}) is more than ${creditNoteLabel(creditNote)}'s remaining credit (${creditNote.remainingCredit}).`,
    );
  }
  await assertPostingDateAllowed(tx, applicationDate);

  const ids: string[] = [];
  for (const entry of sorted) {
    const amount = toFixedString(entry.amount, scale);
    let inserted;
    try {
      inserted = await tx.query<{ id: string }>(
        `insert into sales_credit_note_applications (
           command_source, idempotency_key, request_hash, credit_note_id, invoice_id, application_date, amount,
           currency_code, created_by_user_id, created_by_email
         )
         values ($1, $2, $3, $4, $5, $6, $7::numeric, $8, $9, $10)
         returning id`,
        [
          source,
          idempotencyKey,
          hash,
          creditNoteId,
          entry.invoiceId,
          applicationDate,
          amount,
          creditNote.currencyCode,
          tx.actor.userId,
          tx.actor.email,
        ],
      );
    } catch (error) {
      if (isUniqueViolation(error)) {
        // The same key was used for a different application by a request that committed first.
        throw new ConflictError(
          "That idempotency key was already used for a different credit note application. Use a new key for a new application.",
        );
      }
      throw error;
    }
    const applicationId = inserted.rows[0].id;
    ids.push(applicationId);
    const invoice = invoices.get(entry.invoiceId)!;
    await writeAuditEvent(tx, {
      eventType: "credit_note.applied",
      entityType: "sales_credit_note_application",
      entityId: applicationId,
      details: {
        creditNoteId,
        creditNoteNumber: creditNote.creditNoteNumber,
        invoiceId: entry.invoiceId,
        invoiceNumber: invoice.invoiceNumber,
        applicationDate,
        amount,
      },
    });
  }
  return {
    created: true,
    applications: await getApplications(tx, ids),
    creditNote: await getCreditNote(tx, creditNoteId),
  };
}

/**
 * Removes an application (example CN7): the credit is available again and the
 * invoice's amount due goes back up. No journal posts. The removal date must
 * be on or after the application date and in an open period. An application
 * can only be removed once.
 */
export async function removeApplication(
  tx: OrgTx,
  creditNoteIdInput: unknown,
  applicationIdInput: unknown,
  command: { source?: unknown; idempotencyKey: unknown; removalDate: unknown },
): Promise<RemoveResult> {
  const creditNoteId = requireId(creditNoteIdInput, "creditNoteId");
  const applicationId = requireId(applicationIdInput, "applicationId");
  const source = optionalSource(command.source);
  const idempotencyKey = requireIdempotencyKey(command.idempotencyKey);
  const removalDate = parseIsoDate(command.removalDate, "removalDate");
  const onCreditNote = await tx.query<{ invoice_id: string }>(
    "select invoice_id from sales_credit_note_applications where id = $1 and credit_note_id = $2",
    [applicationId, creditNoteId],
  );
  const invoiceId = onCreditNote.rows[0]?.invoice_id;
  if (!invoiceId) {
    throw new NotFoundError("Application not found.");
  }
  const hash = requestHash("credit_note_application_removal", { applicationId, removalDate });
  const replay = async (): Promise<RemoveResult | null> => {
    const earlier = await tx.query<{ id: string; credit_note_id: string; hash: string }>(
      `select id, credit_note_id, removal_request_hash as hash from sales_credit_note_applications
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
      creditNote: await getCreditNote(tx, row.credit_note_id),
    };
  };

  const earlier = await replay();
  if (earlier) {
    return earlier;
  }
  const creditNote = await lockCreditNote(tx, creditNoteId);
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
    throw new ValidationError(
      `The removal date can't be before the application date (${application.applicationDate}).`,
    );
  }
  await assertPostingDateAllowed(tx, removalDate);

  try {
    await tx.query(
      `update sales_credit_note_applications
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
    eventType: "credit_note.application_removed",
    entityType: "sales_credit_note_application",
    entityId: applicationId,
    details: {
      creditNoteId,
      creditNoteNumber: creditNote.creditNoteNumber,
      invoiceId,
      invoiceNumber: application.invoiceNumber,
      removalDate,
      amount: application.amount,
    },
  });
  return {
    created: true,
    application: await getApplication(tx, applicationId),
    creditNote: await getCreditNote(tx, creditNoteId),
  };
}
