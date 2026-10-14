import { writeAuditEvent } from "@/lib/audit";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { assertSameRequest, requestHash } from "@/lib/idempotency";
import { parseJournalBody, postJournalBody } from "@/lib/ledger/journals";
import { assertPostingDateAllowed } from "@/lib/ledger/period-controls";
import { currencyMinorUnits } from "@/lib/money/currency";
import { abs, dec, isNegative, isZero, toFixedString } from "@/lib/money/decimal";
import { checkNewTags, loadTrackingContext, missingRequired, parseTrackingInput, sortedTags, trackingKey, type TrackingTags } from "@/lib/tracking/service";
import { optionalSource, requireId, requireIdempotencyKey, requireOneOf, requireString } from "@/lib/validation";

/*
 * Recoding a posted line (#258, #259; examples RCD1-RCD6, decision 529).
 * Only the line's account and tracking change. A correcting journal (origin
 * "recode") on the document's own date moves the line's amount from the old
 * account and tracking to the new; the document line is updated to match,
 * so the document, its PDF and reports by document all agree with the
 * ledger. Amounts, GST codes, the contact and control accounts never change,
 * so a filed GST return is never affected. Refused on or before the lock
 * date, for stock lines, and for fixed asset accounts (use the fixed asset
 * register). A reason is required.
 */

export const RECODE_DOCUMENTS = ["invoice", "bill", "bank_transaction"] as const;
export type RecodeDocument = (typeof RECODE_DOCUMENTS)[number];

type Spec = {
  label: string;
  documents: string;
  lines: string;
  parentColumn: string;
  dateColumn: string;
  postedStatus: string;
  /** The side the line's account was posted on, for a positive amount. */
  side: (kind: string | null) => "debit" | "credit";
  reference: string;
};

const SPECS: Record<RecodeDocument, Spec> = {
  invoice: {
    label: "invoice",
    documents: "sales_invoices",
    lines: "sales_invoice_lines",
    parentColumn: "invoice_id",
    dateColumn: "invoice_date",
    postedStatus: "approved",
    side: () => "credit",
    reference: "coalesce(d.invoice_number, 'Invoice ' || d.id::text)",
  },
  bill: {
    label: "bill",
    documents: "bills",
    lines: "bill_lines",
    parentColumn: "bill_id",
    dateColumn: "bill_date",
    postedStatus: "approved",
    side: () => "debit",
    reference: "coalesce(nullif(d.supplier_invoice_number, ''), 'Bill ' || d.id::text)",
  },
  bank_transaction: {
    label: "bank transaction",
    documents: "bank_transactions",
    lines: "bank_transaction_lines",
    parentColumn: "bank_transaction_id",
    dateColumn: "transaction_date",
    postedStatus: "posted",
    side: (kind) => (kind === "receive" ? "credit" : "debit"),
    reference: "coalesce(nullif(d.reference, ''), initcap(d.kind) || ' ' || d.id::text)",
  },
};

export type Recode = {
  id: string;
  documentType: RecodeDocument;
  documentId: string;
  lineId: string;
  lineOrder: number;
  fromAccountCode: string;
  toAccountCode: string;
  fromTracking: TrackingTags;
  toTracking: TrackingTags;
  amount: string;
  journalId: string;
  reason: string;
  createdByEmail: string;
  createdAt: string;
};

const RECODE_SELECT = `select r.id::text, r.document_type, r.document_id::text, r.line_id::text, r.line_order, fa.code as from_code, ta.code as to_code,
         r.from_tracking, r.to_tracking, r.amount::text, r.journal_id::text, r.reason, r.created_by_email,
         to_char(r.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as created_at
    from document_recodes r join accounts fa on fa.id = r.from_account_id join accounts ta on ta.id = r.to_account_id`;

type RecodeRow = {
  id: string;
  document_type: RecodeDocument;
  document_id: string;
  line_id: string;
  line_order: number;
  from_code: string;
  to_code: string;
  from_tracking: TrackingTags;
  to_tracking: TrackingTags;
  amount: string;
  journal_id: string;
  reason: string;
  created_by_email: string;
  created_at: string;
};

function toRecode(row: RecodeRow): Recode {
  return {
    id: row.id,
    documentType: row.document_type,
    documentId: row.document_id,
    lineId: row.line_id,
    lineOrder: row.line_order,
    fromAccountCode: row.from_code,
    toAccountCode: row.to_code,
    fromTracking: row.from_tracking,
    toTracking: row.to_tracking,
    amount: row.amount,
    journalId: row.journal_id,
    reason: row.reason,
    createdByEmail: row.created_by_email,
    createdAt: row.created_at,
  };
}

export async function listRecodes(tx: OrgTx, input: { documentType: unknown; documentId: unknown }): Promise<Recode[]> {
  const documentType = requireOneOf(input.documentType, "documentType", RECODE_DOCUMENTS);
  const documentId = requireId(input.documentId, "documentId");
  const rows = await tx.query<RecodeRow>(`${RECODE_SELECT} where r.document_type = $1 and r.document_id = $2 order by r.id`, [documentType, documentId]);
  return rows.rows.map(toRecode);
}

/**
 * Recodes one line of a posted invoice, bill or bank transaction (RCD1-RCD6):
 * line `lineOrder` (1 for the first line) gets `accountCode` and/or `tracking`
 * (the line's whole new set of tags), with a `reason`.
 */
export async function recodeLine(
  tx: OrgTx,
  input: { source?: unknown; idempotencyKey: unknown; documentType: unknown; documentId: unknown; lineOrder: unknown; accountCode?: unknown; tracking?: unknown; reason: unknown },
): Promise<{ created: boolean; recode: Recode }> {
  const source = optionalSource(input.source);
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  const documentType = requireOneOf(input.documentType, "documentType", RECODE_DOCUMENTS);
  const spec = SPECS[documentType];
  const documentId = requireId(input.documentId, "documentId");
  const lineOrder = Number(input.lineOrder);
  if (!Number.isInteger(lineOrder) || lineOrder < 1 || lineOrder > 10000) throw new ValidationError("lineOrder must be the line's number, from 1.");
  const reason = requireString(input.reason, "A reason", { maxLength: 500 });

  const earlier = await tx.query<{ id: string; request_hash: string }>(
    "select id::text, request_hash from document_recodes where command_source = $1 and idempotency_key = $2",
    [source, idempotencyKey],
  );

  const document = (
    await tx.query<{ status: string; posting_date: string; kind: string | null; reference: string; currency_code: string | null }>(
      `select d.status, d.${spec.dateColumn}::text as posting_date, ${documentType === "bank_transaction" ? "d.kind" : "null::text as kind"},
              ${spec.reference} as reference, d.currency_code
         from ${spec.documents} d where d.id = $1 for update`,
      [documentId],
    )
  ).rows[0];
  if (!document) throw new NotFoundError(`That ${spec.label} wasn't found.`);
  const line = (
    await tx.query<{
      id: string;
      account_id: string;
      account_code: string;
      account_type: string;
      system_key: string | null;
      tracking: TrackingTags;
      amount: string;
      item_type: string | null;
      description: string | null;
    }>(
      `select l.id::text, l.account_id::text, a.code as account_code, a.account_type, a.system_key, l.tracking,
              coalesce(l.base_net_amount, l.net_amount)::text as amount,
              ${documentType === "bank_transaction" ? "null::text" : "i.item_type"} as item_type, l.description
         from ${spec.lines} l
         join accounts a on a.id = l.account_id
         ${documentType === "bank_transaction" ? "" : "left join items i on i.id = l.item_id"}
        where l.line_order = $1 and l.${spec.parentColumn} = $2`,
      [lineOrder, documentId],
    )
  ).rows[0];
  if (!line) throw new NotFoundError(`This ${spec.label} has no line ${lineOrder}.`);
  const lineId = line.id;

  const fromTracking = sortedTags(line.tracking ?? {});
  const toAccountCode = input.accountCode === undefined || input.accountCode === null || input.accountCode === "" ? line.account_code : requireString(input.accountCode, "The new account", { maxLength: 20 });
  const toTracking = sortedTags(input.tracking === undefined ? fromTracking : parseTrackingInput(input.tracking, "The line's"));
  const hash = requestHash("recode", { documentType, documentId, lineOrder, toAccountCode: toAccountCode.toLowerCase(), toTracking, reason });
  if (earlier.rows[0]) {
    assertSameRequest(earlier.rows[0].request_hash, hash, "recode");
    return { created: false, recode: toRecode((await tx.query<RecodeRow>(`${RECODE_SELECT} where r.id = $1`, [earlier.rows[0].id])).rows[0]) };
  }

  if (document.status !== spec.postedStatus) {
    throw new ConflictError(`Only a ${spec.postedStatus} ${spec.label} can be recoded. ${document.status === "draft" ? "Edit the draft instead." : "It's voided."}`);
  }
  if (line.item_type === "stock" || line.item_type === "kit" || line.system_key === "inventory") {
    throw new ValidationError("A stock item's line moves stock, so it can't be recoded. Void and re-enter it, or adjust the stock.");
  }
  if (line.account_type === "fixed_asset") {
    throw new ValidationError("That line is on a fixed asset account. Change it through the fixed asset register, or with a journal.");
  }

  const to = (
    await tx.query<{ id: string; code: string; is_active: boolean; system_key: string | null; account_type: string; account_class: string; currency_code: string | null }>(
      "select id::text, code, is_active, system_key, account_type, account_class, currency_code from accounts where lower(code) = lower($1)",
      [toAccountCode],
    )
  ).rows[0];
  if (!to) throw new ValidationError(`There's no account ${toAccountCode}.`);
  if (to.id !== line.account_id) {
    if (!to.is_active) throw new ValidationError(`Account ${to.code} is archived.`);
    if (to.currency_code) throw new ValidationError(`Account ${to.code} holds a foreign currency.`);
    if (to.system_key || to.account_type === "bank" || to.account_type === "credit_card") {
      throw new ValidationError(`Account ${to.code} is a control account (bank, card, receivables, payables, GST, stock and the like), so a line can't be recoded to it.`);
    }
    if (to.account_type === "fixed_asset") {
      throw new ValidationError(`Account ${to.code} is a fixed asset account. Register the asset in the fixed asset register instead.`);
    }
  }
  if (to.id === line.account_id && trackingKey(toTracking) === trackingKey(fromTracking)) {
    throw new ValidationError("Nothing would change: choose a different account or tracking.");
  }
  const tracking = await loadTrackingContext(tx);
  checkNewTags(tracking, toTracking, "The line", new Set(Object.values(fromTracking)));
  const missing = missingRequired(tracking, toTracking, to.account_class as Parameters<typeof missingRequired>[2]);
  if (missing) throw new ValidationError(`The line needs a ${missing}.`);

  // The correcting journal is dated like the document, so it must be after the lock date (RCD3).
  await assertPostingDateAllowed(tx, document.posting_date);

  const scale = currencyMinorUnits(tx.baseCurrency);
  const amount = dec(line.amount);
  if (isZero(amount)) throw new ValidationError("That line's amount is 0.00, so there's nothing to move. Its account can't be recoded.");
  const value = toFixedString(abs(amount), scale);
  // The original posting side for this line; a negative line was posted the other way.
  const original = spec.side(document.kind);
  const postedOn = isNegative(amount) ? (original === "debit" ? "credit" : "debit") : original;
  const onSide = (side: "debit" | "credit") => (side === "debit" ? { debitAmount: value, creditAmount: "0" } : { debitAmount: "0", creditAmount: value });
  const other = postedOn === "debit" ? "credit" : "debit";
  const journal = await postJournalBody(
    tx,
    "recode",
    `${documentType}:${lineId}:${hash.slice(0, 32)}`,
    parseJournalBody(
      tx,
      {
        postingDate: document.posting_date,
        reference: `Recode ${document.reference}`.slice(0, 100),
        description: `Recoded: ${reason}`.slice(0, 500),
        lines: [
          { accountCode: to.code, ...onSide(postedOn), description: line.description ?? undefined, tracking: toTracking },
          { accountCode: line.account_code, ...onSide(other), description: line.description ?? undefined, tracking: fromTracking },
        ],
      },
      { internal: true },
    ),
    { origin: "recode" },
  );

  await tx.query("select set_config('tohyee.recoding', 'on', true)");
  try {
    await tx.query(`update ${spec.lines} set account_id = $2, tracking = $3::jsonb where id = $1`, [lineId, to.id, JSON.stringify(toTracking)]);
  } finally {
    await tx.query("select set_config('tohyee.recoding', '', true)");
  }
  const inserted = await tx.query<{ id: string }>(
    `insert into document_recodes (command_source, idempotency_key, request_hash, document_type, document_id, line_id, line_order, from_account_id,
       to_account_id, from_tracking, to_tracking, amount, journal_id, reason, created_by_user_id, created_by_email)
     values ($1, $2, $3, $4, $5, $6, $16, $7, $8, $9::jsonb, $10::jsonb, $11::numeric, $12, $13, $14, $15) returning id::text`,
    [
      source,
      idempotencyKey,
      hash,
      documentType,
      documentId,
      lineId,
      line.account_id,
      to.id,
      JSON.stringify(fromTracking),
      JSON.stringify(toTracking),
      toFixedString(amount, scale),
      journal.journal.id,
      reason,
      tx.actor.userId,
      tx.actor.email,
      lineOrder,
    ],
  );
  await writeAuditEvent(tx, {
    eventType: "document.line_recoded",
    entityType: documentType,
    entityId: documentId,
    details: { lineOrder, from: line.account_code, to: to.code, fromTracking, toTracking, amount: toFixedString(amount, scale), reason, journalId: journal.journal.id },
  });
  return { created: true, recode: toRecode((await tx.query<RecodeRow>(`${RECODE_SELECT} where r.id = $1`, [inserted.rows[0].id])).rows[0]) };
}
