"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useState } from "react";
import { Money, RequireOrganisation } from "@/components/books";
import { CreditNoteStatusBadge, CreditStatusBadge } from "@/components/credit-notes/credit-note-editor";
import { useApiData } from "@/components/hooks";
import { TrackingTagsText, useTracking } from "@/components/tracking";
import { formatRate, formatUnitPrice } from "@/components/invoices/invoice-editor";
import {
  SupplierCreditNoteApplications,
  SupplierCreditNoteRefunds,
} from "@/components/supplier-credit-notes/supplier-credit-note-credit";
import { Button, Card, Field, Notice, Page, PageHeader, Stat, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { api, errorMessage, newIdempotencyKey } from "@/lib/client/api";
import { formatDate, formatDateTime, formatQuantity, todayInBrowser } from "@/lib/format";
import { AMOUNTS_MODE_LABELS } from "@/lib/invoices/amounts";
import type { SupplierCreditNote } from "@/lib/supplier-credit-notes/service";
import { RecordExtrasPanel } from "@/components/records/record-extras";

type CreditNote = SupplierCreditNote;

function journalHref(journalId: string): string {
  return `/operations/ledger-journals?journal=${journalId}`;
}

function CreditNoteActions({
  organisationId,
  creditNote,
  onChanged,
}: {
  organisationId: string;
  creditNote: CreditNote;
  onChanged: (creditNote: CreditNote, message: string) => void;
}) {
  const router = useRouter();
  // One key per action on this page, so a retry after a dropped connection
  // returns the first result instead of posting again.
  const [approveKey] = useState(() => newIdempotencyKey("supplier-credit-note-approve"));
  const [voidKey] = useState(() => newIdempotencyKey("supplier-credit-note-void"));
  const [voidDate, setVoidDate] = useState(() => {
    const today = todayInBrowser();
    return today < creditNote.creditNoteDate ? creditNote.creditNoteDate : today;
  });
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
    if (
      !window.confirm(
        `Approve ${creditNote.supplierCreditNoteNumber}? It's posted to the ledger on ${formatDate(creditNote.creditNoteDate)}. After that it can only be voided.`,
      )
    ) {
      return;
    }
    void run(async () => {
      const result = await api<{ creditNote: CreditNote }>(`/api/supplier-credit-notes/${creditNote.id}/approve`, {
        method: "POST",
        body: { organisationId, source: "ui", idempotencyKey: approveKey },
      });
      onChanged(result.creditNote, `Approved ${result.creditNote.supplierCreditNoteNumber} and posted it to the ledger.`);
    });
  }

  function remove() {
    if (!window.confirm("Delete this draft? This can't be undone.")) {
      return;
    }
    void run(async () => {
      await api(`/api/supplier-credit-notes/${creditNote.id}`, { method: "DELETE", query: { organisationId } });
      router.push("/operations/supplier-credit-notes");
    });
  }

  function voidCreditNote() {
    if (
      !window.confirm(
        `Void ${creditNote.supplierCreditNoteNumber}? This posts a reversal of its journal on ${formatDate(voidDate)}, and can't be undone.`,
      )
    ) {
      return;
    }
    void run(async () => {
      const result = await api<{ creditNote: CreditNote }>(`/api/supplier-credit-notes/${creditNote.id}/void`, {
        method: "POST",
        body: { organisationId, source: "ui", idempotencyKey: voidKey, voidDate },
      });
      onChanged(
        result.creditNote,
        `Voided ${result.creditNote.supplierCreditNoteNumber}. Its journal was reversed on ${formatDate(result.creditNote.voidDate)}.`,
      );
    });
  }

  if (creditNote.status === "voided") {
    return null;
  }
  // Example SCN9: a credit note with active applications or refunds is voided after they're removed.
  const inUse = creditNote.status === "approved" && creditNote.creditStatus !== "open";
  return (
    <Card
      title={creditNote.status === "draft" ? "Draft" : "Void"}
      description={
        creditNote.status === "draft"
          ? "Drafts post nothing. Approving posts the credit note on its date, if that date is in an open period."
          : "Voiding posts the exact reversal of the credit note's journal on the void date, which must be in an open period."
      }
    >
      {error ? <Notice tone="error">{error}</Notice> : null}
      {inUse ? (
        <Notice tone="info">
          This credit note has credit applied or refunded. Remove its applications and void its refunds first, then void
          the credit note.
        </Notice>
      ) : null}
      {creditNote.status === "draft" ? (
        <div className={ui.actions}>
          <Button onClick={approve} disabled={busy}>
            {busy ? "Working…" : "Approve"}
          </Button>
          <Button
            variant="secondary"
            onClick={() => router.push(`/operations/supplier-credit-notes/${creditNote.id}/edit`)}
            disabled={busy}
          >
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
              min={creditNote.creditNoteDate}
              onChange={(event) => setVoidDate(event.target.value)}
              required
            />
          </Field>
          <Button variant="danger" onClick={voidCreditNote} disabled={busy || !voidDate || inUse}>
            {busy ? "Working…" : "Void credit note"}
          </Button>
        </div>
      )}
    </Card>
  );
}

function CreditNoteView({ organisationId, creditNoteId }: { organisationId: string; creditNoteId: string }) {
  const trackingSetup = useTracking(organisationId);
  const { can } = useWorkspace();
  const details = useApiData<{ creditNote: CreditNote }>(
    `/api/supplier-credit-notes/${encodeURIComponent(creditNoteId)}`,
    { organisationId },
  );
  // Approving, voiding, applying and refunding return the updated credit note, which is shown straight away.
  const [updated, setUpdated] = useState<CreditNote | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  if (details.error) {
    return (
      <>
        <Notice tone="error">{details.error}</Notice>
        <p>
          <Link href="/operations/supplier-credit-notes">Back to supplier credit notes</Link>
        </p>
      </>
    );
  }
  if (!details.data) {
    return <p className={ui.muted}>Loading…</p>;
  }
  const creditNote = updated ?? details.data.creditNote;
  const hasTax = creditNote.amountsMode !== "no_tax";
  const onChanged = (next: CreditNote, text: string) => {
    setUpdated(next);
    setMessage(text);
  };
  return (
    <>
      {message ? <Notice tone="success">{message}</Notice> : null}
      <Card
        title={creditNote.supplierCreditNoteNumber}
        description={`From ${creditNote.contactName} · ${AMOUNTS_MODE_LABELS[creditNote.amountsMode]} · ${creditNote.currencyCode}`}
        actions={
          <>
            <CreditNoteStatusBadge status={creditNote.status} />
            {creditNote.creditStatus ? <CreditStatusBadge status={creditNote.creditStatus} /> : null}
          </>
        }
      >
        <div className={ui.grid3}>
          <Stat label="Credit note date" value={formatDate(creditNote.creditNoteDate)} />
          <Stat label="Reference" value={creditNote.reference ?? "—"} />
          <Stat label="Supplier" value={creditNote.contactName} />
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
                  {creditNote.amountsMode === "inclusive"
                    ? "Amount (incl. GST)"
                    : creditNote.amountsMode === "exclusive"
                      ? "Amount (excl. GST)"
                      : "Amount"}
                </th>
              </tr>
            </thead>
            <tbody>
              {creditNote.lines.map((line) => (
                <tr key={line.lineOrder}>
                  <td>{line.description}</td>
                  <td className={ui.num}>{formatQuantity(line.quantity)}</td>
                  <td className={ui.num}>{formatUnitPrice(line.unitPrice)}</td>
                  <td>
                    {line.accountCode} · {line.accountName}
                    <TrackingTagsText setup={trackingSetup.data} tags={line.tracking} />
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
          <Stat label={hasTax ? "Subtotal (excl. GST)" : "Subtotal"} value={<Money value={creditNote.subtotal} />} />
          {hasTax ? <Stat label="GST" value={<Money value={creditNote.taxTotal} />} /> : null}
          <Stat label={`Total (${creditNote.currencyCode})`} value={<Money value={creditNote.total} />} />
          {creditNote.status === "approved" ? (
            <>
              <Stat label="Applied" value={<Money value={creditNote.amountApplied} />} />
              <Stat label="Refunded" value={<Money value={creditNote.amountRefunded} />} />
              <Stat label="Remaining credit" value={<Money value={creditNote.remainingCredit} />} />
            </>
          ) : null}
        </div>
        <p className={ui.muted}>
          Saved by {creditNote.createdByEmail ?? "unknown"} on {formatDateTime(creditNote.createdAt)}.
          {creditNote.approvalJournalId ? (
            <>
              {" "}
              Approved by {creditNote.approvedByEmail ?? "unknown"} on {formatDateTime(creditNote.approvedAt)} and posted as{" "}
              <Link href={journalHref(creditNote.approvalJournalId)}>journal #{creditNote.approvalJournalId}</Link>.
            </>
          ) : null}
          {creditNote.voidJournalId ? (
            <>
              {" "}
              Voided by {creditNote.voidedByEmail ?? "unknown"} on {formatDateTime(creditNote.voidedAt)}, reversed on{" "}
              {formatDate(creditNote.voidDate)} by{" "}
              <Link href={journalHref(creditNote.voidJournalId)}>journal #{creditNote.voidJournalId}</Link>.
            </>
          ) : null}
        </p>
        {creditNote.status === "approved" && creditNote.creditStatus !== "used" ? (
          <p className={ui.muted}>
            Unused credit from {creditNote.contactName} stays on the credit note until it&apos;s applied to a bill or
            refunded by the supplier.
          </p>
        ) : null}
      </Card>
      {creditNote.status !== "draft" ? (
        <>
          <SupplierCreditNoteApplications organisationId={organisationId} creditNote={creditNote} onChanged={onChanged} />
          <SupplierCreditNoteRefunds organisationId={organisationId} creditNote={creditNote} onChanged={onChanged} />
        </>
      ) : null}
      {can("bookkeeper") ? (
        <CreditNoteActions key={creditNote.status} organisationId={organisationId} creditNote={creditNote} onChanged={onChanged} />
      ) : null}
      <RecordExtrasPanel
        key={`${creditNote.status}-${message ?? ""}`}
        organisationId={organisationId}
        recordType="supplier_credit_note"
        recordId={creditNote.id}
      />
      <p>
        <Link href="/operations/supplier-credit-notes">Back to supplier credit notes</Link>
      </p>
    </>
  );
}

export default function SupplierCreditNotePage() {
  const { creditNoteId } = useParams<{ creditNoteId: string }>();
  return (
    <Page>
      <PageHeader title="Supplier credit note" />
      <RequireOrganisation>
        {(organisationId) => <CreditNoteView organisationId={organisationId} creditNoteId={creditNoteId} />}
      </RequireOrganisation>
    </Page>
  );
}
