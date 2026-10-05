"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { approvalBlocksApproving, DocumentApprovalPanel, useDocumentApproval } from "@/components/approvals";
import { AccountSelect, Money, useAccounts } from "@/components/books";
import { useApiData } from "@/components/hooks";
import { RdLineTags } from "@/components/rd";
import { RecordExtrasPanel } from "@/components/records/record-extras";
import { TrackingSelects, TrackingTagsText, useTracking } from "@/components/tracking";
import { Badge, Button, Card, Empty, Field, Notice, Stat, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import type { Account } from "@/lib/accounts/service";
import { billLineAccountProblem } from "@/lib/bills/accounts";
import { api, errorMessage, newIdempotencyKey } from "@/lib/client/api";
import { formatKmRate, incomeYearLabel, VEHICLE_TYPE_LABELS, VEHICLE_TYPES, type VehicleType } from "@/lib/expense-claims/mileage-types";
import type { ExpenseClaim, ExpenseClaimMileage, ExpenseClaimStatus, ExpenseClaimSummary } from "@/lib/expense-claims/service";
import { formatDate, formatDateTime, formatGstNumber, todayInBrowser, personName } from "@/lib/format";
import { calculateInvoice, PAID_STATUS_LABELS } from "@/lib/invoices/amounts";
import { isDecimalString } from "@/lib/money/decimal";
import type { TaxCode } from "@/lib/tax/codes";
import { codesForSide } from "@/lib/tax/available-on";
import type { TrackingTags } from "@/lib/tracking/service";
import { useConfirm } from "@/components/confirm-dialog";

/**
 * Expense claims (examples EC1-EC12): a member's receipts, submitted for
 * approval; approving posts the claim's journal, paying it clears expense
 * claims payable, declining returns it with a reason.
 */

const STATUS_LABELS: Record<ExpenseClaimStatus, { label: string; tone: "neutral" | "blue" | "green" | "red" }> = {
  draft: { label: "Draft", tone: "neutral" },
  submitted: { label: "Awaiting approval", tone: "blue" },
  approved: { label: "Approved", tone: "green" },
  voided: { label: "Voided", tone: "red" },
};

export function ClaimStatusBadge({ claim }: { claim: ExpenseClaimSummary }) {
  const status = STATUS_LABELS[claim.status];
  return (
    <>
      <Badge tone={status.tone}>{status.label}</Badge>
      {claim.paidStatus ? <> <Badge tone={claim.paidStatus === "paid" ? "green" : "amber"}>{PAID_STATUS_LABELS[claim.paidStatus]}</Badge></> : null}
      {claim.status === "draft" && claim.declineReason ? <> <Badge tone="amber">Declined</Badge></> : null}
    </>
  );
}

/** Accounts a receipt can go to: those a bill line can, except stock (EC1). */
function takesReceipts(account: Account): boolean {
  return billLineAccountProblem(account) === null && account.accountType !== "inventory";
}

type ReceiptDraft = {
  receiptDate: string;
  supplierName: string;
  /** Needed over $200 with GST claimed (decision 293). */
  supplierGstNumber: string;
  description: string;
  accountCode: string;
  taxCode: string;
  amount: string;
  tracking: TrackingTags;
};

function blankReceipt(taxCode: string): ReceiptDraft {
  return { receiptDate: todayInBrowser(), supplierName: "", supplierGstNumber: "", description: "", accountCode: "", taxCode, amount: "", tracking: {} };
}

/** A mileage line as typed (MI2): its amount is worked out by Tohyee when it's saved. */
type MileageDraft = {
  receiptDate: string;
  fromPlace: string;
  toPlace: string;
  description: string;
  km: string;
  vehicleType: VehicleType;
  accountCode: string;
  tracking: TrackingTags;
};

function blankMileage(accountCode: string, vehicleType: VehicleType = "petrol"): MileageDraft {
  return { receiptDate: todayInBrowser(), fromPlace: "", toPlace: "", description: "", km: "", vehicleType, accountCode, tracking: {} };
}

/** "123.4 km, petrol: 50 km x 1.2 + 73.4 km x 0.37" */
export function mileageWorking(mileage: ExpenseClaimMileage): string {
  const parts = [
    ...(mileage.tier1Km !== "0" ? [`${mileage.tier1Km} km x ${formatKmRate(mileage.tier1Rate)}`] : []),
    ...(mileage.tier2Km !== "0" ? [`${mileage.tier2Km} km x ${formatKmRate(mileage.tier2Rate)} (tier 2)`] : []),
  ];
  return `${mileage.km} km, ${VEHICLE_TYPE_LABELS[mileage.vehicleType].toLowerCase()}: ${parts.join(" + ")} · ${mileage.rateNote ?? `${incomeYearLabel(mileage.rateYearEnding)} rates`}${mileage.tierOverride ? ` · ${mileage.tierOverride === "tier1" ? "tier 1" : "tier 2"} chosen by an admin` : ""}`;
}

/** Enter or change a draft claim's receipts (tax inclusive). Totals are worked out with the same code as the server. */
export function ExpenseClaimEditor({
  organisationId,
  claim,
  onSaved,
  onCancel,
}: {
  organisationId: string;
  claim?: ExpenseClaim;
  onSaved: (claim: ExpenseClaim) => void;
  onCancel: () => void;
}) {
  const accounts = useAccounts(organisationId);
  const taxCodes = useApiData<{ taxCodes: TaxCode[] }>("/api/tax/codes", { organisationId });
  const tracking = useTracking(organisationId);
  // Receipts are purchases: only codes available on purchases (TAO6).
  const active = codesForSide(taxCodes.data?.taxCodes ?? [], "purchases").filter((taxCode) => taxCode.isActive);
  const defaultTax = (active.find((taxCode) => taxCode.category === "standard") ?? active[0])?.code ?? "";
  const [description, setDescription] = useState(claim?.description ?? "");
  const [receipts, setReceipts] = useState<ReceiptDraft[] | null>(
    claim
      ? claim.receipts.filter((receipt) => receipt.kind !== "mileage").map((receipt) => ({
          receiptDate: receipt.receiptDate,
          supplierName: receipt.supplierName,
          supplierGstNumber: receipt.supplierGstNumber ?? "",
          description: receipt.description,
          accountCode: receipt.accountCode,
          taxCode: receipt.taxCode ?? "",
          amount: receipt.amount,
          tracking: receipt.tracking,
        }))
      : null,
  );
  const motor = accounts.data?.accounts.find((account) => account.code === "6120" && account.isActive && takesReceipts(account))?.code ?? "";
  const [mileage, setMileage] = useState<MileageDraft[]>(
    (claim?.receipts ?? []).flatMap((receipt) =>
      receipt.mileage
        ? [
            {
              receiptDate: receipt.receiptDate,
              fromPlace: receipt.mileage.fromPlace,
              toPlace: receipt.mileage.toPlace,
              description: receipt.description,
              km: receipt.mileage.km,
              vehicleType: receipt.mileage.vehicleType,
              accountCode: receipt.accountCode,
              tracking: receipt.tracking,
            },
          ]
        : [],
    ),
  );
  const [createKey] = useState(() => newIdempotencyKey("claim"));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!taxCodes.data || !accounts.data) return <p className={ui.muted}>Loading…</p>;
  const rows = receipts ?? (claim ? [] : [blankReceipt(defaultTax)]);
  const setTrip = (index: number, change: Partial<MileageDraft>) => setMileage(mileage.map((row, i) => (i === index ? { ...row, ...change } : row)));
  const set = (index: number, change: Partial<ReceiptDraft>) => setReceipts(rows.map((row, i) => (i === index ? { ...row, ...change } : row)));
  const rate = (code: string) => active.find((taxCode) => taxCode.code === code)?.rate ?? "0";
  const totals = calculateInvoice(
    "inclusive",
    rows.map((row) => ({ quantity: "1", unitPrice: isDecimalString(row.amount) ? row.amount.trim() : "0", taxRate: row.taxCode ? rate(row.taxCode) : "0" })),
    2,
  );

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const body = {
      organisationId,
      description: description.trim() || null,
      receipts: [
        ...rows.map((row) => ({ ...row, taxCode: row.taxCode || null, supplierGstNumber: row.supplierGstNumber.trim() || null })),
        ...mileage.map((row) => ({ kind: "mileage", ...row })),
      ],
    };
    try {
      const result = claim
        ? await api<{ claim: ExpenseClaim }>(`/api/expense-claims/${claim.id}`, { method: "PUT", body })
        : await api<{ claim: ExpenseClaim }>("/api/expense-claims", { method: "POST", body: { ...body, source: "ui", idempotencyKey: createKey } });
      onSaved(result.claim);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(event) => void save(event)}>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <Field label="What it's for" hint="Optional, e.g. June market trip.">
        <input value={description} maxLength={500} onChange={(event) => setDescription(event.target.value)} />
      </Field>
      <div className={ui.tableWrap}>
        <table className={`${ui.table} ${ui.stackOnPhone}`}>
          <thead>
            <tr>
              <th>Date</th>
              <th>Supplier</th>
              <th>Description</th>
              <th>Account</th>
              <th>GST</th>
              <th className={ui.num}>Amount incl. GST</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={index}>
                <td data-label="Date">
                  <input type="date" aria-label={`Receipt ${index + 1} date`} value={row.receiptDate} onChange={(event) => set(index, { receiptDate: event.target.value })} required />
                </td>
                <td data-label="Supplier">
                  <input aria-label={`Receipt ${index + 1} supplier`} value={row.supplierName} maxLength={200} onChange={(event) => set(index, { supplierName: event.target.value })} required />
                  <input
                    aria-label={`Receipt ${index + 1} supplier GST number`}
                    placeholder="GST number (over $200)"
                    title="The supplier's GST number from the receipt: needed to claim GST on a receipt over $200 (IRD)."
                    value={row.supplierGstNumber}
                    maxLength={20}
                    onChange={(event) => set(index, { supplierGstNumber: event.target.value })}
                  />
                </td>
                <td data-label="Description">
                  <input aria-label={`Receipt ${index + 1} description`} value={row.description} maxLength={500} onChange={(event) => set(index, { description: event.target.value })} required />
                  <TrackingSelects setup={tracking.data} value={row.tracking} onChange={(tags) => set(index, { tracking: tags })} labelPrefix={`Receipt ${index + 1} `} />
                </td>
                <td data-label="Account">
                  <AccountSelect
                    accounts={accounts.data!.accounts}
                    value={row.accountCode}
                    onChange={(code) => set(index, { accountCode: code })}
                    filter={takesReceipts}
                    ariaLabel={`Receipt ${index + 1} account`}
                    required
                  />
                </td>
                <td data-label="GST">
                  <select aria-label={`Receipt ${index + 1} tax code`} value={row.taxCode} onChange={(event) => set(index, { taxCode: event.target.value })}>
                    <option value="">No GST (not a GST receipt)</option>
                    {active.map((taxCode) => (
                      <option key={taxCode.id} value={taxCode.code}>
                        {taxCode.code} · {taxCode.label}
                      </option>
                    ))}
                  </select>
                </td>
                <td data-label="Amount" className={ui.num}>
                  <input aria-label={`Receipt ${index + 1} amount`} inputMode="decimal" size={9} value={row.amount} onChange={(event) => set(index, { amount: event.target.value })} required />
                  <div className={ui.muted}>GST {totals.lines[index]?.taxAmount}</div>
                </td>
                <td>
                  <Button size="small" variant="secondary" onClick={() => setReceipts(rows.filter((_, i) => i !== index))} disabled={rows.length + mileage.length === 1}>
                    Remove
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {mileage.length > 0 ? (
        <div className={ui.tableWrap}>
          <table className={`${ui.table} ${ui.stackOnPhone}`}>
            <thead>
              <tr>
                <th>Date</th>
                <th>From</th>
                <th>To</th>
                <th>Purpose</th>
                <th>Vehicle</th>
                <th className={ui.num}>Kilometres</th>
                <th>Account</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {mileage.map((row, index) => (
                <tr key={index}>
                  <td data-label="Date">
                    <input type="date" aria-label={`Mileage ${index + 1} date`} value={row.receiptDate} onChange={(event) => setTrip(index, { receiptDate: event.target.value })} required />
                  </td>
                  <td data-label="From">
                    <input aria-label={`Mileage ${index + 1} from`} value={row.fromPlace} maxLength={200} onChange={(event) => setTrip(index, { fromPlace: event.target.value })} required />
                  </td>
                  <td data-label="To">
                    <input aria-label={`Mileage ${index + 1} to`} value={row.toPlace} maxLength={200} onChange={(event) => setTrip(index, { toPlace: event.target.value })} required />
                  </td>
                  <td data-label="Purpose">
                    <input aria-label={`Mileage ${index + 1} purpose`} value={row.description} maxLength={500} onChange={(event) => setTrip(index, { description: event.target.value })} required />
                    <TrackingSelects setup={tracking.data} value={row.tracking} onChange={(tags) => setTrip(index, { tracking: tags })} labelPrefix={`Mileage ${index + 1} `} />
                  </td>
                  <td data-label="Vehicle">
                    <select aria-label={`Mileage ${index + 1} vehicle`} style={{ minWidth: 130 }} value={row.vehicleType} onChange={(event) => setTrip(index, { vehicleType: event.target.value as VehicleType })}>
                      {VEHICLE_TYPES.map((type) => (
                        <option key={type} value={type}>
                          {VEHICLE_TYPE_LABELS[type]}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td data-label="Kilometres" className={ui.num}>
                    <input aria-label={`Mileage ${index + 1} kilometres`} inputMode="decimal" size={7} value={row.km} onChange={(event) => setTrip(index, { km: event.target.value })} required />
                  </td>
                  <td data-label="Account">
                    <AccountSelect
                      accounts={accounts.data!.accounts}
                      value={row.accountCode}
                      onChange={(code) => setTrip(index, { accountCode: code })}
                      filter={takesReceipts}
                      ariaLabel={`Mileage ${index + 1} account`}
                      required
                    />
                  </td>
                  <td>
                    <Button size="small" variant="secondary" onClick={() => setMileage(mileage.filter((_, i) => i !== index))} disabled={rows.length + mileage.length === 1}>
                      Remove
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      <div className={ui.actions}>
        <Button variant="secondary" onClick={() => setReceipts([...rows, blankReceipt(defaultTax)])} disabled={rows.length + mileage.length >= 100}>
          Add a receipt
        </Button>
        <Button
          variant="secondary"
          onClick={() => setMileage([...mileage, blankMileage(mileage.at(-1)?.accountCode ?? motor, mileage.at(-1)?.vehicleType)])}
          disabled={rows.length + mileage.length >= 100}
        >
          Add mileage
        </Button>
      </div>
      <div className={ui.grid3}>
        <Stat label="Excluding GST" value={<Money value={totals.subtotal} />} />
        <Stat label="GST" value={<Money value={totals.taxTotal} />} />
        <Stat label={mileage.length > 0 ? "Receipts total" : "Total"} value={<Money value={totals.total} />} />
      </div>
      {mileage.length > 0 ? (
        <p className={ui.muted}>
          Plus mileage, worked out when you save: kilometres times IRD&apos;s kilometre rate for the vehicle (tier 2 after 14,000 km of your mileage
          in the income year), with no GST. See the <Link href="/operations/settings/kilometre-rates">kilometre rates</Link>.
        </p>
      ) : null}
      <p className={ui.muted}>Choose &quot;No GST&quot; when the receipt isn&apos;t a valid GST receipt or the supplier isn&apos;t GST registered. Attach photos of the receipts after saving.</p>
      <div className={ui.actions}>
        <Button type="submit" disabled={busy}>
          {busy ? "Saving…" : "Save draft"}
        </Button>
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

type Filter = { label: string; query: Record<string, string | null>; empty: string };

const FILTERS: Filter[] = [
  { label: "Mine", query: { mine: "true" }, empty: "You haven't made any expense claims." },
  { label: "Awaiting approval", query: { status: "submitted" }, empty: "No claims are waiting for approval." },
  { label: "Awaiting payment", query: { status: "awaiting_payment" }, empty: "No approved claims are waiting to be paid." },
  { label: "All", query: {}, empty: "No expense claims yet." },
];

export function ExpenseClaimList({ organisationId }: { organisationId: string }) {
  const { can } = useWorkspace();
  const router = useRouter();
  const [filter, setFilter] = useState(FILTERS[can("bookkeeper") ? 0 : 3]);
  const list = useApiData<{ claims: ExpenseClaimSummary[] }>("/api/expense-claims", { organisationId, ...filter.query });
  return (
    <Card
      title="Expense claims"
      description="Receipts people paid for themselves. Approving posts the claim; paying it clears expense claims payable."
      actions={can("bookkeeper") ? <Button onClick={() => router.push("/operations/expense-claims/new")}>New expense claim</Button> : null}
    >
      <div className={ui.tabs} role="tablist" aria-label="Expense claims">
        {FILTERS.map((entry) => (
          <button
            key={entry.label}
            type="button"
            role="tab"
            aria-selected={filter === entry}
            className={`${ui.tab} ${filter === entry ? ui.tabActive : ""}`}
            onClick={() => setFilter(entry)}
          >
            {entry.label}
          </button>
        ))}
      </div>
      {list.error ? <Notice tone="error">{list.error}</Notice> : null}
      {!list.data && !list.error ? <p className={ui.muted}>Loading…</p> : null}
      {list.data && list.data.claims.length === 0 ? <Empty>{filter.empty}</Empty> : null}
      {list.data && list.data.claims.length > 0 ? (
        <div className={ui.tableWrap}>
          <table className={`${ui.table} ${ui.stackOnPhone}`}>
            <thead>
              <tr>
                <th>Claim</th>
                <th>Who</th>
                <th>For</th>
                <th>Status</th>
                <th className={ui.num}>Total</th>
                <th className={ui.num}>Due</th>
              </tr>
            </thead>
            <tbody>
              {list.data.claims.map((claim) => (
                <tr key={claim.id}>
                  <td data-label="Claim">
                    <Link href={`/operations/expense-claims/${claim.id}`}>{claim.reference}</Link>
                  </td>
                  <td data-label="Who">{personName(claim, "claimant")}</td>
                  <td data-label="For" className={ui.muted}>
                    {claim.description ?? `${claim.receiptCount} receipt${claim.receiptCount === 1 ? "" : "s"}`}
                  </td>
                  <td data-label="Status">
                    <ClaimStatusBadge claim={claim} />
                  </td>
                  <td data-label="Total" className={ui.num}>
                    <Money value={claim.total} />
                  </td>
                  <td data-label="Due" className={ui.num}>
                    {claim.amountDue ? <Money value={claim.amountDue} /> : ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </Card>
  );
}

function isPaymentAccount(account: Account): boolean {
  return (account.accountType === "bank" || account.accountType === "credit_card") && account.currencyCode === null;
}

/** Submit, decline, approve, pay, void (EC2-EC7). Each posting action has its own idempotency key. */
function ClaimActions({ organisationId, claim, onChanged }: { organisationId: string; claim: ExpenseClaim; onChanged: (claim: ExpenseClaim, message: string) => void }) {
  const confirm = useConfirm();
  const { user, can, current } = useWorkspace();
  const router = useRouter();
  const accounts = useAccounts(organisationId);
  const [approveKey] = useState(() => newIdempotencyKey("claim-approve"));
  const [voidKey] = useState(() => newIdempotencyKey("claim-void"));
  const [payKey, setPayKey] = useState(() => newIdempotencyKey("claim-pay"));
  const latest = claim.receipts.reduce((date, receipt) => (receipt.receiptDate > date ? receipt.receiptDate : date), "");
  const today = todayInBrowser();
  const [claimDate, setClaimDate] = useState(latest > today ? latest : today);
  const [reason, setReason] = useState("");
  const [paymentDate, setPaymentDate] = useState(today);
  const [amount, setAmount] = useState(claim.amountDue ?? "");
  const [bankCode, setBankCode] = useState<string | null>(null);
  const [voidDate, setVoidDate] = useState(today);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mine = claim.claimantUserId ? claim.claimantUserId === user.id : claim.claimantEmail.toLowerCase() === user.email.toLowerCase();
  const canApprove = can("bookkeeper") && (!mine || can("admin"));
  // Under an approval rule its steps' approvers approve or decline it on its approval page (AW15).
  const approval = useDocumentApproval(organisationId, "expense_claim", claim.id);
  const approvalState = approval.data?.approval;
  const underRule = approvalBlocksApproving(approvalState) && claim.status === "submitted";
  const banks = (accounts.data?.accounts ?? []).filter((account) => account.isActive && isPaymentAccount(account));
  const bank = bankCode ?? (banks.find((account) => account.systemKey === "bank") ?? banks[0])?.code ?? "";

  async function run(action: () => Promise<{ claim: ExpenseClaim } | null>, message: string) {
    setBusy(true);
    setError(null);
    try {
      const result = await action();
      if (result) onChanged(result.claim, message);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }
  const post = (path: string, body: Record<string, unknown>) =>
    api<{ claim: ExpenseClaim }>(`/api/expense-claims/${claim.id}${path}`, { method: "POST", body: { organisationId, source: "ui", ...body } });

  return (
    <Card title="Actions">
      {error ? <Notice tone="error">{error}</Notice> : null}
      {claim.status === "draft" || claim.status === "submitted" ? (
        <DocumentApprovalPanel
          organisationId={organisationId}
          documentType="expense_claim"
          documentId={claim.id}
          documentStatus={claim.status}
          approval={approvalState}
          canSubmit={claim.status === "submitted" && mine}
          onChanged={async (text) => {
            approval.reload();
            const fresh = await api<{ claim: ExpenseClaim }>(`/api/expense-claims/${claim.id}`, { query: { organisationId } });
            onChanged(fresh.claim, text);
          }}
        />
      ) : null}
      {claim.status === "draft" && mine ? (
        <div className={ui.actions}>
          <Button onClick={() => void run(() => post("/submit", {}), "Submitted for approval.")} disabled={busy || claim.receipts.length === 0}>
            Submit for approval
          </Button>
          <Button variant="secondary" onClick={() => router.push(`/operations/expense-claims/${claim.id}/edit`)}>
            Edit
          </Button>
          <Button
            variant="danger"
            disabled={busy}
            onClick={async () => {
              if (!(await confirm("Delete this draft claim?"))) return;
              void run(async () => {
                await api(`/api/expense-claims/${claim.id}`, { method: "DELETE", query: { organisationId } });
                router.push("/operations/expense-claims");
                return null;
              }, "");
            }}
          >
            Delete
          </Button>
        </div>
      ) : null}
      {claim.status === "draft" && !mine ? <p className={ui.muted}>Only {personName(claim, "claimant")} can change or submit this draft.</p> : null}
      {claim.status === "submitted" && can("bookkeeper") && (approval.data || approval.error) && !underRule ? (
        <>
          {canApprove ? (
            <div className={ui.inlineForm}>
              <Field label="Claim date" hint="The journal's date: on or after the latest receipt.">
                <input type="date" value={claimDate} min={latest} onChange={(event) => setClaimDate(event.target.value)} />
              </Field>
              <Button onClick={() => void run(() => post("/approve", { idempotencyKey: approveKey, claimDate }), "Approved and posted.")} disabled={busy}>
                Approve
              </Button>
            </div>
          ) : (
            <p className={ui.muted}>You can&apos;t approve your own claim. Another bookkeeper or an admin can.</p>
          )}
          <div className={ui.inlineForm}>
            <Field label="Reason for declining">
              <input value={reason} maxLength={500} onChange={(event) => setReason(event.target.value)} />
            </Field>
            <Button variant="secondary" onClick={() => void run(() => post("/decline", { reason }), "Declined and returned to its claimant.")} disabled={busy || !reason.trim()}>
              Decline
            </Button>
          </div>
        </>
      ) : null}
      {claim.status === "approved" && can("bookkeeper") && claim.amountDue !== "0.00" ? (
        <div className={ui.inlineForm}>
          <Field label="Paid on">
            <input type="date" value={paymentDate} min={claim.claimDate ?? undefined} onChange={(event) => setPaymentDate(event.target.value)} />
          </Field>
          <Field label={`Amount (${current?.baseCurrency ?? ""})`}>
            <input inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} />
          </Field>
          <Field label="From">
            <AccountSelect accounts={accounts.data?.accounts ?? []} value={bank} onChange={setBankCode} filter={isPaymentAccount} ariaLabel="Bank account" />
          </Field>
          <Button
            onClick={() =>
              void run(async () => {
                const result = await post("/payments", { idempotencyKey: payKey, paymentDate, amount, bankAccountCode: bank });
                setPayKey(newIdempotencyKey("claim-pay"));
                return result;
              }, "Payment recorded.")
            }
            disabled={busy || !amount.trim() || !bank}
          >
            Record payment
          </Button>
        </div>
      ) : null}
      {claim.status === "approved" && can("bookkeeper") && claim.amountPaid === "0.00" ? (
        <div className={ui.inlineForm}>
          <Field label="Void on">
            <input type="date" value={voidDate} min={claim.claimDate ?? undefined} onChange={(event) => setVoidDate(event.target.value)} />
          </Field>
          <Button
            variant="danger"
            onClick={async () => {
              if (!(await confirm("Void this claim? It posts the exact reversal of its journal."))) return;
              void run(() => post("/void", { idempotencyKey: voidKey, voidDate }), "Voided.");
            }}
            disabled={busy}
          >
            Void claim
          </Button>
        </div>
      ) : null}
    </Card>
  );
}

function PaymentRows({ organisationId, claim, onChanged }: { organisationId: string; claim: ExpenseClaim; onChanged: (claim: ExpenseClaim, message: string) => void }) {
  const { can } = useWorkspace();
  const [error, setError] = useState<string | null>(null);
  const [keys] = useState(() => new Map<string, string>());
  if (claim.payments.length === 0) return null;
  async function voidPayment(paymentId: string) {
    const voidDate = window.prompt("Void this payment on (YYYY-MM-DD)?", todayInBrowser());
    if (!voidDate) return;
    const idempotencyKey = keys.get(paymentId) ?? newIdempotencyKey("claim-pay-void");
    keys.set(paymentId, idempotencyKey);
    try {
      const result = await api<{ claim: ExpenseClaim }>(`/api/expense-claims/${claim.id}/payments/${paymentId}/void`, {
        method: "POST",
        body: { organisationId, source: "ui", idempotencyKey, voidDate },
      });
      onChanged(result.claim, "Payment voided.");
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }
  return (
    <Card title="Payments">
      {error ? <Notice tone="error">{error}</Notice> : null}
      <div className={ui.tableWrap}>
        <table className={`${ui.table} ${ui.stackOnPhone}`}>
          <thead>
            <tr>
              <th>Date</th>
              <th>From</th>
              <th>Status</th>
              <th className={ui.num}>Amount</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {claim.payments.map((payment) => (
              <tr key={payment.id}>
                <td data-label="Date">{formatDate(payment.paymentDate)}</td>
                <td data-label="From">
                  {payment.bankAccountCode} · {payment.bankAccountName}
                </td>
                <td data-label="Status">{payment.status === "voided" ? <Badge tone="red">Voided {formatDate(payment.voidDate)}</Badge> : <Badge tone="green">Paid</Badge>}</td>
                <td data-label="Amount" className={ui.num}>
                  <Money value={payment.amount} />
                </td>
                <td>
                  {payment.status === "active" && can("bookkeeper") ? (
                    <Button size="small" variant="secondary" onClick={() => void voidPayment(payment.id)}>
                      Void
                    </Button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

/** An admin's tier for a draft claim's mileage line (question 3). */
function TierChoice({
  organisationId,
  claim,
  lineOrder,
  tier,
  onChanged,
}: {
  organisationId: string;
  claim: ExpenseClaim;
  lineOrder: number;
  tier: "tier1" | "tier2" | null;
  onChanged: (claim: ExpenseClaim, message: string) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  return (
    <div>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <select
        aria-label={`Mileage line ${lineOrder} tier`}
        value={tier ?? ""}
        onChange={async (event) => {
          setError(null);
          try {
            const result = await api<{ claim: ExpenseClaim }>(`/api/expense-claims/${claim.id}/mileage-tier`, {
              method: "POST",
              body: { organisationId, lineOrder, tier: event.target.value || null },
            });
            onChanged(result.claim, "Mileage tier changed.");
          } catch (caught) {
            setError(errorMessage(caught));
          }
        }}
      >
        <option value="">Tier worked out</option>
        <option value="tier1">All at tier 1</option>
        <option value="tier2">All at tier 2</option>
      </select>
    </div>
  );
}

export function ExpenseClaimView({ organisationId, claimId }: { organisationId: string; claimId: string }) {
  const { can } = useWorkspace();
  const loaded = useApiData<{ claim: ExpenseClaim }>(`/api/expense-claims/${encodeURIComponent(claimId)}`, { organisationId });
  const tracking = useTracking(organisationId);
  const [updated, setUpdated] = useState<ExpenseClaim | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  if (loaded.error) return <Notice tone="error">{loaded.error}</Notice>;
  const claim = updated ?? loaded.data?.claim;
  if (!claim) return <p className={ui.muted}>Loading…</p>;
  const changed = (next: ExpenseClaim, text: string) => {
    setUpdated(next);
    setMessage(text);
  };
  return (
    <>
      {message ? <Notice tone="success">{message}</Notice> : null}
      {claim.status === "draft" && claim.declineReason ? (
        <Notice tone="warning">
          Declined by {personName(claim, "declinedBy")} on {formatDateTime(claim.declinedAt)}: {claim.declineReason}
        </Notice>
      ) : null}
      <Card title={`${claim.reference}${claim.description ? ` · ${claim.description}` : ""}`} actions={<ClaimStatusBadge claim={claim} />}>
        <div className={ui.grid3}>
          <Stat label="Claimed by" value={personName(claim, "claimant")} />
          <Stat label="Total" value={<Money value={claim.total} />} />
          <Stat label="GST" value={<Money value={claim.taxTotal} />} />
          {claim.claimDate ? <Stat label="Claim date" value={formatDate(claim.claimDate)} /> : null}
          {personName(claim, "approvedBy") ? <Stat label="Approved by" value={personName(claim, "approvedBy")} /> : null}
          {claim.amountDue ? <Stat label="Due" value={<Money value={claim.amountDue} />} /> : null}
        </div>
        <div className={ui.tableWrap}>
          <table className={`${ui.table} ${ui.stackOnPhone}`}>
            <thead>
              <tr>
                <th>Date</th>
                <th>Supplier</th>
                <th>Description</th>
                <th>Account</th>
                <th>GST</th>
                <th className={ui.num}>Amount</th>
              </tr>
            </thead>
            <tbody>
              {claim.receipts.map((receipt) => (
                <tr key={receipt.id}>
                  <td data-label="Date">{formatDate(receipt.receiptDate)}</td>
                  <td data-label="Supplier">
                    {receipt.supplierName}
                    {receipt.supplierGstNumber ? <><br /><small>GST {formatGstNumber(receipt.supplierGstNumber)}</small></> : null}
                  </td>
                  <td data-label="Description">
                    {receipt.description}
                    {receipt.mileage ? (
                      <div className={ui.muted}>
                        {receipt.mileage.fromPlace} to {receipt.mileage.toPlace} · {mileageWorking(receipt.mileage)}
                      </div>
                    ) : null}
                    {receipt.mileage && claim.status === "draft" && can("admin") ? (
                      <TierChoice organisationId={organisationId} claim={claim} lineOrder={receipt.lineOrder} tier={receipt.mileage.tierOverride} onChanged={changed} />
                    ) : null}
                    <TrackingTagsText setup={tracking.data} tags={receipt.tracking} />
                  </td>
                  <td data-label="Account">
                    {receipt.accountCode} · {receipt.accountName}
                  </td>
                  <td data-label="GST">
                    {receipt.taxCode ?? "No GST"} <Money value={receipt.taxAmount} />
                  </td>
                  <td data-label="Amount" className={ui.num}>
                    <Money value={receipt.amount} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {claim.approvalJournalId ? (
          <p className={ui.muted}>
            <Link href={`/operations/ledger-journals?journal=${claim.approvalJournalId}`}>Its journal</Link>
            {claim.voidJournalId ? (
              <>
                {" "}
                · <Link href={`/operations/ledger-journals?journal=${claim.voidJournalId}`}>Void journal</Link> ({formatDate(claim.voidDate)})
              </>
            ) : null}
          </p>
        ) : null}
      </Card>
      <ClaimActions key={`${claim.status}-${claim.amountDue ?? ""}`} organisationId={organisationId} claim={claim} onChanged={changed} />
      <PaymentRows organisationId={organisationId} claim={claim} onChanged={changed} />
      {claim.approvalJournalId ? <RdLineTags key={`rd-${claim.status}`} organisationId={organisationId} documentType="expense_claim" documentId={claim.id} /> : null}
      <RecordExtrasPanel key={`${claim.status}-${message ?? ""}`} organisationId={organisationId} recordType="expense_claim" recordId={claim.id} title="Receipt files, notes and history" />
      <p>
        <Link href="/operations/expense-claims">Back to expense claims</Link>
      </p>
    </>
  );
}
