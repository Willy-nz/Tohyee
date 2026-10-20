import { writeAuditEvent } from "@/lib/audit";
import { parseIsoDate } from "@/lib/dates";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { assertSameRequest, requestHash } from "@/lib/idempotency";
import { add, cmp, dec, parseDecimalInput, sub, ZERO_DECIMAL } from "@/lib/money/decimal";
import { APPLIES_TO, APPLIES_TO_LABELS, type AppliesToKey, appliesToNumber, type TaxAllocation } from "@/lib/tax/income/allocation-kinds";
import { ALLOCATION_STATUSES, type AllocationStatus, money } from "@/lib/tax/income/rules";
import { requireId, requireIdempotencyKey, requireString } from "@/lib/validation";

/*
 * Where provisional tax payments go (examples ITX6A-ITX6H, decisions
 * 620-623; Codex, delegated by owner, 20 October 2026). A payment keeps its
 * bank date and gets IRD's effective date once known. An allocation puts a
 * payment, or part of one, towards an instalment or the end-of-year tax,
 * and says how sure that is:
 * - confirmed: IRD's own record, so it needs one of the IRD documents (ITX30);
 * - evidenced: a person's allocation, with the evidence they relied on;
 * - forecast: an assumption, shown but never counted as paid.
 * A payment with no confirmed or evidenced allocation is awaiting
 * reconciliation. Allocations never add up to more than the payment.
 * Reallocating or taking one off keeps the old one, with the reason.
 * Owners and admins only (the routes check). Nothing posts.
 */

export { APPLIES_TO, APPLIES_TO_LABELS, type AppliesToKey, appliesToNumber, type TaxAllocation };

type AllocationRow = {
  id: string;
  request_hash: string;
  payment_id: string;
  applies_to: AppliesToKey;
  amount: string;
  status: AllocationStatus;
  basis: string;
  ird_document_id: string | null;
  ird_document_name: string | null;
  created_by_email: string | null;
  created_at: string;
  replaced_at: string | null;
  replaced_by_email: string | null;
  replaced_reason: string | null;
};

const COLUMNS = `a.id::text, a.request_hash, a.payment_id::text, a.applies_to, a.amount::text, a.status, a.basis, a.ird_document_id::text,
  d.file_name as ird_document_name, a.created_by_email, a.created_at, a.replaced_at, a.replaced_by_email, a.replaced_reason`;
const FROM = "income_tax_payment_allocations a left join ird_documents d on d.id = a.ird_document_id";

function toAllocation(row: AllocationRow): TaxAllocation {
  return {
    id: row.id,
    paymentId: row.payment_id,
    appliesTo: row.applies_to,
    amount: row.amount,
    status: row.status,
    basis: row.basis,
    irdDocumentId: row.ird_document_id,
    irdDocumentName: row.ird_document_name,
    createdByEmail: row.created_by_email,
    createdAt: new Date(row.created_at).toISOString(),
    replaced: row.replaced_at ? { at: new Date(row.replaced_at).toISOString(), byEmail: row.replaced_by_email, reason: row.replaced_reason! } : null,
  };
}

/** Every allocation of these payments, current and replaced, oldest first. */
export async function allocationsFor(tx: OrgTx, paymentIds: readonly string[]): Promise<TaxAllocation[]> {
  if (paymentIds.length === 0) return [];
  const result = await tx.query<AllocationRow>(`select ${COLUMNS} from ${FROM} where a.payment_id = any($1::bigint[]) order by a.created_at, a.id`, [paymentIds]);
  return result.rows.map(toAllocation);
}

/**
 * SQL: a payment counted from the books whose journal was reversed (voided)
 * afterwards, so it counts for nothing (ITX6F). `p` is income_tax_payments.
 */
export const PAYMENT_REVERSED_SQL = `exists (
  select 1 from ledger_journal_lines rl join ledger_journals rj on rj.id = rl.journal_id
   where rl.id = p.journal_line_id
     and (rj.correction_kind = 'reversal'
          or exists (select 1 from ledger_journals rr where rr.related_journal_id = rj.id and rr.correction_kind = 'reversal')))`;

type PaymentLock = { id: string; income_year: number; amount: string; reversed: boolean };

async function lockPayment(tx: OrgTx, paymentId: string): Promise<PaymentLock> {
  const result = await tx.query<PaymentLock>(`select p.id::text, p.income_year, p.amount::text, ${PAYMENT_REVERSED_SQL} as reversed from income_tax_payments p where p.id = $1 for update of p`, [paymentId]);
  const row = result.rows[0];
  if (!row) throw new NotFoundError("Payment not found.");
  return row;
}

type AllocationInput = { appliesTo: AppliesToKey; amount: string; status: AllocationStatus; basis: string; irdDocumentId: string | null };

async function parseAllocation(tx: OrgTx, input: { appliesTo: unknown; amount: unknown; status: unknown; basis: unknown; irdDocumentId?: unknown }): Promise<AllocationInput> {
  if (typeof input.appliesTo !== "string" || !(APPLIES_TO as readonly string[]).includes(input.appliesTo)) {
    throw new ValidationError("Choose an instalment or the end-of-year tax.");
  }
  const appliesTo = input.appliesTo as AppliesToKey;
  if (typeof input.status !== "string" || !(ALLOCATION_STATUSES as readonly string[]).includes(input.status)) {
    throw new ValidationError("Choose how sure the allocation is: confirmed by IRD, allocated with evidence, or a forecast assumption.");
  }
  const status = input.status as AllocationStatus;
  const amount = parseDecimalInput(input.amount, "amount", { maxScale: 2 });
  if (cmp(dec(amount), ZERO_DECIMAL) <= 0) throw new ValidationError("The amount must be more than nil.");
  const basis = requireString(input.basis, "basis", { maxLength: 300 });
  const settings = await tx.query<{ gst_period_months: number | null }>("select gst_period_months from organisation_settings where id = true");
  if (appliesTo === "instalment_3" && settings.rows[0]?.gst_period_months === 6) {
    throw new ValidationError("Six-monthly GST filers have two instalments, so there's no instalment 3.");
  }
  let irdDocumentId: string | null = null;
  if (input.irdDocumentId != null && input.irdDocumentId !== "") irdDocumentId = requireId(input.irdDocumentId, "irdDocumentId");
  if (status === "confirmed") {
    if (!irdDocumentId) throw new ValidationError("A confirmed allocation needs the IRD document that shows it (a statement or letter). Without one, allocate it with your evidence instead.");
  }
  if (irdDocumentId) {
    const document = await tx.query<{ removed_at: string | null }>("select removed_at from ird_documents where id = $1", [irdDocumentId]);
    if (!document.rows[0]) throw new NotFoundError("That IRD document doesn't exist.");
    if (document.rows[0].removed_at) throw new ValidationError("That IRD document was removed. Choose another.");
  }
  return { appliesTo, amount, status, basis, irdDocumentId };
}

async function assertFits(tx: OrgTx, payment: PaymentLock, amount: string, exceptAllocationId: string | null): Promise<void> {
  const current = await tx.query<{ amount: string }>("select amount::text from income_tax_payment_allocations where payment_id = $1 and replaced_at is null and ($2::bigint is null or id <> $2::bigint)", [payment.id, exceptAllocationId]);
  const allocated = current.rows.reduce((total, row) => add(total, dec(row.amount)), ZERO_DECIMAL);
  const left = sub(dec(payment.amount), allocated);
  if (cmp(dec(amount), left) > 0) {
    throw new ValidationError(`Only ${money(left)} of this ${money(dec(payment.amount))} payment isn't allocated yet. A payment is counted once.`);
  }
}

async function insertAllocation(tx: OrgTx, key: string, hash: string, paymentId: string, input: AllocationInput): Promise<TaxAllocation> {
  const inserted = await tx.query<{ id: string }>(
    `insert into income_tax_payment_allocations (idempotency_key, request_hash, payment_id, applies_to, amount, status, basis, ird_document_id, created_by_email)
     values ($1, $2, $3, $4, $5::numeric, $6, $7, $8, $9) returning id::text`,
    [key, hash, paymentId, input.appliesTo, input.amount, input.status, input.basis, input.irdDocumentId, tx.actor.email],
  );
  return (await byId(tx, inserted.rows[0].id))!;
}

async function byId(tx: OrgTx, id: string): Promise<TaxAllocation | null> {
  const result = await tx.query<AllocationRow>(`select ${COLUMNS} from ${FROM} where a.id = $1`, [id]);
  return result.rows[0] ? toAllocation(result.rows[0]) : null;
}

async function existing(tx: OrgTx, key: string, hash: string): Promise<TaxAllocation | null> {
  const found = await tx.query<AllocationRow>(`select ${COLUMNS} from ${FROM} where a.idempotency_key = $1`, [key]);
  if (!found.rows[0]) return null;
  assertSameRequest(found.rows[0].request_hash, hash, "payment allocation");
  return toAllocation(found.rows[0]);
}

/** Allocates a payment, or part of it, to an instalment or the end-of-year tax (ITX6A-ITX6H). */
export async function addAllocation(
  tx: OrgTx,
  input: { idempotencyKey: unknown; paymentId: unknown; appliesTo: unknown; amount: unknown; status: unknown; basis: unknown; irdDocumentId?: unknown },
): Promise<{ created: boolean; allocation: TaxAllocation }> {
  const key = requireIdempotencyKey(input.idempotencyKey);
  const paymentId = requireId(input.paymentId, "paymentId");
  const parsed = await parseAllocation(tx, input);
  const hash = requestHash("income_tax_allocation", { paymentId, ...parsed });
  const again = await existing(tx, key, hash);
  if (again) return { created: false, allocation: again };
  const payment = await lockPayment(tx, paymentId);
  if (payment.reversed) throw new ConflictError("That payment's journal was reversed, so it can't be allocated.");
  await assertFits(tx, payment, parsed.amount, null);
  const allocation = await insertAllocation(tx, key, hash, paymentId, parsed);
  await writeAuditEvent(tx, { eventType: "income_tax.payment_allocated", entityType: "income_tax_payment", entityId: paymentId, details: { allocationId: allocation.id, ...parsed } });
  return { created: true, allocation };
}

async function lockAllocation(tx: OrgTx, allocationId: string): Promise<{ id: string; payment_id: string; replaced_at: string | null; applies_to: string; amount: string; status: string }> {
  const result = await tx.query<{ id: string; payment_id: string; replaced_at: string | null; applies_to: string; amount: string; status: string }>(
    "select id::text, payment_id::text, replaced_at, applies_to, amount::text, status from income_tax_payment_allocations where id = $1 for update",
    [allocationId],
  );
  const row = result.rows[0];
  if (!row) throw new NotFoundError("Allocation not found.");
  return row;
}

/** Reallocates: the old allocation is kept as replaced, with the reason, and the new one takes its place (ITX6G). */
export async function reallocate(
  tx: OrgTx,
  input: { idempotencyKey: unknown; allocationId: unknown; appliesTo: unknown; amount: unknown; status: unknown; basis: unknown; irdDocumentId?: unknown; reason: unknown },
): Promise<{ created: boolean; allocation: TaxAllocation }> {
  const key = requireIdempotencyKey(input.idempotencyKey);
  const allocationId = requireId(input.allocationId, "allocationId");
  const reason = requireString(input.reason, "reason", { maxLength: 300 });
  const parsed = await parseAllocation(tx, input);
  const hash = requestHash("income_tax_reallocation", { allocationId, reason, ...parsed });
  const again = await existing(tx, key, hash);
  if (again) return { created: false, allocation: again };
  const old = await lockAllocation(tx, allocationId);
  if (old.replaced_at) throw new ConflictError("That allocation was already changed. Reload to see the current one.");
  const payment = await lockPayment(tx, old.payment_id);
  if (payment.reversed) throw new ConflictError("That payment's journal was reversed, so it can't be allocated.");
  await assertFits(tx, payment, parsed.amount, allocationId);
  await tx.query("update income_tax_payment_allocations set replaced_at = now(), replaced_by_email = $2, replaced_reason = $3 where id = $1", [allocationId, tx.actor.email, reason]);
  const allocation = await insertAllocation(tx, key, hash, old.payment_id, parsed);
  await writeAuditEvent(tx, {
    eventType: "income_tax.payment_reallocated",
    entityType: "income_tax_payment",
    entityId: old.payment_id,
    details: { reason, from: { allocationId, appliesTo: old.applies_to, amount: old.amount, status: old.status }, to: { allocationId: allocation.id, ...parsed } },
  });
  return { created: true, allocation };
}

/** Takes an allocation off: kept as replaced with the reason; that part of the payment is awaiting reconciliation again. */
export async function removeAllocation(tx: OrgTx, input: { allocationId: unknown; reason: unknown }): Promise<TaxAllocation> {
  const allocationId = requireId(input.allocationId, "allocationId");
  const reason = requireString(input.reason, "reason", { maxLength: 300 });
  const old = await lockAllocation(tx, allocationId);
  if (old.replaced_at) throw new ConflictError("That allocation was already changed. Reload to see the current one.");
  await tx.query("update income_tax_payment_allocations set replaced_at = now(), replaced_by_email = $2, replaced_reason = $3 where id = $1", [allocationId, tx.actor.email, reason]);
  await writeAuditEvent(tx, { eventType: "income_tax.payment_allocation_removed", entityType: "income_tax_payment", entityId: old.payment_id, details: { allocationId, reason, appliesTo: old.applies_to, amount: old.amount, status: old.status } });
  return (await byId(tx, allocationId))!;
}

/** Sets (or clears) IRD's effective date for a payment; the bank date stays as it is (ITX6C). */
export async function setEffectiveDate(tx: OrgTx, input: { paymentId: unknown; irdEffectiveOn: unknown }): Promise<{ paymentId: string; irdEffectiveOn: string | null }> {
  const paymentId = requireId(input.paymentId, "paymentId");
  const irdEffectiveOn = input.irdEffectiveOn == null || input.irdEffectiveOn === "" ? null : parseIsoDate(input.irdEffectiveOn, "irdEffectiveOn");
  const before = await tx.query<{ ird_effective_on: string | null }>("select ird_effective_on::text from income_tax_payments where id = $1 for update", [paymentId]);
  if (!before.rows[0]) throw new NotFoundError("Payment not found.");
  await tx.query("update income_tax_payments set ird_effective_on = $2 where id = $1", [paymentId, irdEffectiveOn]);
  await writeAuditEvent(tx, { eventType: "income_tax.payment_effective_date_set", entityType: "income_tax_payment", entityId: paymentId, details: { from: before.rows[0].ird_effective_on, to: irdEffectiveOn } });
  return { paymentId, irdEffectiveOn };
}
