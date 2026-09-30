import { parseAccountCodeInput } from "@/lib/accounts/service";
import { getStatementLine } from "@/lib/bank/accounts";
import { assertBulkKey, type BulkResult, eachLine } from "@/lib/bank/bulk";
import { reconcileStatementLine } from "@/lib/bank/reconcile";
import type { OrgRunner, OrgTx } from "@/lib/db/org-transaction";
import { ConflictError, ValidationError } from "@/lib/errors";
import { parseTrackingInput, sortedTags, type TrackingTags } from "@/lib/tracking/service";
import { asRecord, optionalId, optionalSource, optionalString, requireArray, requireId, requireIdempotencyKey } from "@/lib/validation";

/**
 * Bulk coding, or cash coding (examples BK22, BK23), like Xero's: several
 * unreconciled lines on one account coded at once. Each line gets an account,
 * a GST code (or none), and optionally a contact, description and tracking,
 * from the values for all lines or its own (its own win). Each line becomes
 * its own spend money (money out) or receive money (money in) for its full
 * amount, dated the line date and reconciled to it, through the same
 * reconcile command as one line at a time (BK6, BK7), in its own database
 * transaction: a line that's refused (a locked period, no account, no
 * contact) is reported on its own with the reason and doesn't stop the rest.
 *
 * With a GST code the line's amount includes GST (tax inclusive); without
 * one there's no GST. With no contact, the line's contact is the active
 * contact whose name is the line's payee (or, with no payee, its
 * description), ignoring case and extra spaces; with no such contact the
 * line is refused.
 */
export type CashCodingValues = {
  contactId?: unknown;
  accountCode?: unknown;
  /** A tax code, or null / "" for no GST. */
  taxCode?: unknown;
  description?: unknown;
  tracking?: unknown;
};

export type CashCodingInput = CashCodingValues & {
  source?: unknown;
  idempotencyKey?: unknown;
  /** The ticked lines: `{ lineId, ...values for this line only }`. */
  lines?: unknown;
};

type Values = {
  contactId?: string | null;
  accountCode?: string | null;
  taxCode?: string | null;
  description?: string | null;
  tracking?: TrackingTags;
};

/** Only the values given are kept, so a line's own value (even "no GST") can be told apart from "use the value for all". */
function parseValues(input: Record<string, unknown>, label: string): Values {
  const has = (field: string) => Object.hasOwn(input, field) && input[field] !== undefined;
  const values: Values = {};
  if (has("contactId")) values.contactId = optionalId(input.contactId, `${label}contactId`);
  if (has("accountCode")) {
    values.accountCode =
      input.accountCode === null || (typeof input.accountCode === "string" && input.accountCode.trim() === "")
        ? null
        : parseAccountCodeInput(input.accountCode, `${label}accountCode`);
  }
  if (has("taxCode")) values.taxCode = optionalString(input.taxCode, `${label}taxCode`, { maxLength: 20 }) || null;
  if (has("description")) values.description = optionalString(input.description, `${label}description`, { maxLength: 500 })?.trim() || null;
  if (has("tracking")) values.tracking = sortedTags(parseTrackingInput(input.tracking, label.trim() || "All lines"));
  return values;
}

async function contactNamed(tx: OrgTx, name: string): Promise<string> {
  const found = await tx.query<{ id: string }>(
    `select id from contacts
      where not is_archived and lower(regexp_replace(btrim(name), '\\s+', ' ', 'g')) = lower(regexp_replace(btrim($1), '\\s+', ' ', 'g'))
      order by id limit 1`,
    [name],
  );
  if (!found.rows[0]) {
    throw new ValidationError(`No contact was chosen, and there's no contact called “${name}”. Choose a contact for this line.`);
  }
  return found.rows[0].id;
}

export async function cashCodeStatementLines(run: OrgRunner, accountIdInput: unknown, input: CashCodingInput): Promise<BulkResult> {
  const accountId = requireId(accountIdInput, "accountId");
  const source = optionalSource(input.source);
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  assertBulkKey(idempotencyKey);
  const all = parseValues(input as Record<string, unknown>, "");
  const seen = new Set<string>();
  const items = requireArray(input.lines, "lines", 200).map((raw, index) => {
    const entry = asRecord(raw, `Line ${index + 1}`);
    const lineId = requireId(entry.lineId, `Line ${index + 1} lineId`);
    if (seen.has(lineId)) throw new ValidationError(`Statement line ${lineId} is ticked twice.`);
    seen.add(lineId);
    return { lineId, own: parseValues(entry, `Line ${index + 1} `) };
  });
  if (items.length === 0) throw new ValidationError("Tick at least one statement line.");

  return eachLine(run, items, async (tx, { lineId, own }) => {
    const pick = <K extends keyof Values>(field: K): Values[K] => (own[field] !== undefined ? own[field] : all[field]);
    const line = await getStatementLine(tx, lineId);
    if (line.accountId !== accountId) throw new ConflictError("This line is on another account.");
    const accountCode = pick("accountCode");
    if (!accountCode) throw new ValidationError("Choose an account for this line.");
    const taxCode = pick("taxCode") ?? null;
    const tracking = pick("tracking") ?? {};
    const contactId = pick("contactId") ?? (await contactNamed(tx, line.payee ?? line.description));
    return reconcileStatementLine(tx, lineId, {
      source,
      idempotencyKey: `${idempotencyKey}:${lineId}`,
      kind: "bank_transaction",
      contactId,
      amountsMode: taxCode ? "inclusive" : "no_tax",
      lines: [
        {
          description: pick("description") ?? line.description,
          accountCode,
          ...(taxCode ? { taxCode } : {}),
          amount: line.amount.replace(/^-/, ""),
          ...(Object.keys(tracking).length > 0 ? { tracking } : {}),
        },
      ],
    });
  });
}
