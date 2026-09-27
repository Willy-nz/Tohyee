"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useState } from "react";
import { BillStatusBadge } from "@/components/bills/bill-editor";
import { Money, RequireOrganisation } from "@/components/books";
import { useApiData } from "@/components/hooks";
import { formatRate, formatUnitPrice } from "@/components/invoices/invoice-editor";
import { Button, Card, Field, Notice, Page, PageHeader, Stat, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import type { Bill } from "@/lib/bills/service";
import { api, errorMessage, newIdempotencyKey } from "@/lib/client/api";
import { formatDate, formatDateTime, formatQuantity, todayInBrowser } from "@/lib/format";
import { AMOUNTS_MODE_LABELS } from "@/lib/invoices/amounts";

function journalHref(journalId: string): string {
  return `/operations/ledger-journals?journal=${journalId}`;
}

function BillActions({
  organisationId,
  bill,
  onChanged,
}: {
  organisationId: string;
  bill: Bill;
  onChanged: (bill: Bill, message: string) => void;
}) {
  const router = useRouter();
  // One key per action on this page, so a retry after a dropped connection
  // returns the first result instead of posting again.
  const [approveKey] = useState(() => newIdempotencyKey("bill-approve"));
  const [voidKey] = useState(() => newIdempotencyKey("bill-void"));
  const [voidDate, setVoidDate] = useState(todayInBrowser());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  function approve() {
    if (!window.confirm(`Approve this bill? It's posted to the ledger on ${formatDate(bill.billDate)}, owing ${bill.contactName} through accounts payable. After that it can only be voided.`)) {
      return;
    }
    void run(async () => {
      const result = await api<{ bill: Bill }>(`/api/bills/${bill.id}/approve`, {
        method: "POST",
        body: { organisationId, source: "ui", idempotencyKey: approveKey },
      });
      onChanged(result.bill, `Approved bill ${result.bill.supplierInvoiceNumber} and posted it to the ledger.`);
    });
  }

  function remove() {
    if (!window.confirm("Delete this draft? This can't be undone.")) {
      return;
    }
    void run(async () => {
      await api(`/api/bills/${bill.id}`, { method: "DELETE", query: { organisationId } });
      router.push("/operations/bills");
    });
  }

  function voidBill() {
    if (!window.confirm(`Void bill ${bill.supplierInvoiceNumber}? This posts a reversal of its journal on ${formatDate(voidDate)}, and can't be undone.`)) {
      return;
    }
    void run(async () => {
      const result = await api<{ bill: Bill }>(`/api/bills/${bill.id}/void`, {
        method: "POST",
        body: { organisationId, source: "ui", idempotencyKey: voidKey, voidDate },
      });
      onChanged(
        result.bill,
        `Voided bill ${result.bill.supplierInvoiceNumber}. Its journal was reversed on ${formatDate(result.bill.voidDate)}.`,
      );
    });
  }

  if (bill.status === "voided") {
    return null;
  }
  return (
    <Card
      title={bill.status === "draft" ? "Draft" : "Void"}
      description={
        bill.status === "draft"
          ? "Drafts post nothing. Approving posts the bill on its bill date, if that date is in an open period."
          : "Voiding posts the exact reversal of the bill's journal on the void date, which must be in an open period."
      }
    >
      {error ? <Notice tone="error">{error}</Notice> : null}
      {bill.status === "draft" ? (
        <div className={ui.actions}>
          <Button onClick={approve} disabled={busy}>
            {busy ? "Working…" : "Approve"}
          </Button>
          <Button variant="secondary" onClick={() => router.push(`/operations/bills/${bill.id}/edit`)} disabled={busy}>
            Edit
          </Button>
          <Button variant="danger" onClick={remove} disabled={busy}>
            Delete draft
          </Button>
        </div>
      ) : (
        <div className={ui.inlineForm}>
          <Field label="Void date">
            <input
              type="date"
              value={voidDate}
              min={bill.billDate}
              onChange={(event) => setVoidDate(event.target.value)}
              required
            />
          </Field>
          <Button variant="danger" onClick={voidBill} disabled={busy || !voidDate}>
            {busy ? "Working…" : "Void bill"}
          </Button>
        </div>
      )}
    </Card>
  );
}

function BillView({ organisationId, billId }: { organisationId: string; billId: string }) {
  const { can } = useWorkspace();
  const details = useApiData<{ bill: Bill }>(`/api/bills/${encodeURIComponent(billId)}`, { organisationId });
  // Approving and voiding return the updated bill, which is shown straight away.
  const [updated, setUpdated] = useState<Bill | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  if (details.error) {
    return (
      <>
        <Notice tone="error">{details.error}</Notice>
        <p>
          <Link href="/operations/bills">Back to bills</Link>
        </p>
      </>
    );
  }
  if (!details.data) {
    return <p className={ui.muted}>Loading…</p>;
  }
  const bill = updated ?? details.data.bill;
  const hasTax = bill.amountsMode !== "no_tax";
  return (
    <>
      {message ? <Notice tone="success">{message}</Notice> : null}
      <Card
        title={`Bill ${bill.supplierInvoiceNumber}`}
        description={`From ${bill.contactName} · ${AMOUNTS_MODE_LABELS[bill.amountsMode]} · ${bill.currencyCode}`}
        actions={<BillStatusBadge status={bill.status} />}
      >
        <div className={ui.grid4}>
          <Stat label="Bill date" value={formatDate(bill.billDate)} />
          <Stat label="Due date" value={formatDate(bill.dueDate)} />
          <Stat label="Supplier's invoice number" value={bill.supplierInvoiceNumber} />
          <Stat label="Supplier" value={bill.contactName} />
        </div>
        <div className={ui.tableWrap}>
          <table className={ui.table}>
            <thead>
              <tr>
                <th>Description</th>
                <th className={ui.num}>Quantity</th>
                <th className={ui.num}>Unit price</th>
                <th>Account</th>
                {hasTax ? <th>Tax code</th> : null}
                {hasTax ? <th className={ui.num}>GST</th> : null}
                <th className={ui.num}>
                  {bill.amountsMode === "inclusive"
                    ? "Amount (incl. GST)"
                    : bill.amountsMode === "exclusive"
                      ? "Amount (excl. GST)"
                      : "Amount"}
                </th>
              </tr>
            </thead>
            <tbody>
              {bill.lines.map((line) => (
                <tr key={line.lineOrder}>
                  <td>{line.description}</td>
                  <td className={ui.num}>{formatQuantity(line.quantity)}</td>
                  <td className={ui.num}>{formatUnitPrice(line.unitPrice)}</td>
                  <td>
                    {line.accountCode} · {line.accountName}
                  </td>
                  {hasTax ? (
                    <td>
                      {line.taxCode} ({formatRate(line.taxRate)})
                    </td>
                  ) : null}
                  {hasTax ? (
                    <td className={ui.num}>
                      <Money value={line.taxAmount} />
                    </td>
                  ) : null}
                  <td className={ui.num}>
                    <Money value={line.lineAmount} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className={ui.statRow}>
          <Stat label={hasTax ? "Subtotal (excl. GST)" : "Subtotal"} value={<Money value={bill.subtotal} />} />
          {hasTax ? <Stat label="GST" value={<Money value={bill.taxTotal} />} /> : null}
          <Stat label={`Total (${bill.currencyCode})`} value={<Money value={bill.total} />} />
        </div>
        <p className={ui.muted}>
          Bill #{bill.id}, saved by {bill.createdByEmail ?? "unknown"} on {formatDateTime(bill.createdAt)}.
          {bill.approvalJournalId ? (
            <>
              {" "}
              Approved by {bill.approvedByEmail ?? "unknown"} on {formatDateTime(bill.approvedAt)} and posted as{" "}
              <Link href={journalHref(bill.approvalJournalId)}>journal #{bill.approvalJournalId}</Link>.
            </>
          ) : null}
          {bill.voidJournalId ? (
            <>
              {" "}
              Voided by {bill.voidedByEmail ?? "unknown"} on {formatDateTime(bill.voidedAt)}, reversed on{" "}
              {formatDate(bill.voidDate)} by <Link href={journalHref(bill.voidJournalId)}>journal #{bill.voidJournalId}</Link>.
            </>
          ) : null}
        </p>
      </Card>
      {can("bookkeeper") ? (
        <BillActions
          key={bill.status}
          organisationId={organisationId}
          bill={bill}
          onChanged={(next, text) => {
            setUpdated(next);
            setMessage(text);
          }}
        />
      ) : null}
      <p>
        <Link href="/operations/bills">Back to bills</Link>
      </p>
    </>
  );
}

export default function BillPage() {
  const { billId } = useParams<{ billId: string }>();
  return (
    <Page>
      <PageHeader title="Bill" />
      <RequireOrganisation>{(organisationId) => <BillView organisationId={organisationId} billId={billId} />}</RequireOrganisation>
    </Page>
  );
}
