"use client";

import Link from "next/link";
import { type FormEvent, useState } from "react";
import { AccountSelect, Money, useAccounts } from "@/components/books";
import { useApiData } from "@/components/hooks";
import { Badge, Button, Card, Empty, Field, Notice, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import type { Account } from "@/lib/accounts/service";
import { api, errorMessage, newIdempotencyKey } from "@/lib/client/api";
import type { CreditNoteApplication } from "@/lib/credit-notes/applications";
import type { CreditNoteRefund } from "@/lib/credit-notes/refunds";
import type { CreditNote } from "@/lib/credit-notes/service";
import { formatDate, formatMoney, todayInBrowser } from "@/lib/format";
import type { InvoiceSummary } from "@/lib/invoices/service";

type ApplyResult = { applications: CreditNoteApplication[]; creditNote: CreditNote };
type ApplicationResult = { application: CreditNoteApplication; creditNote: CreditNote };
type RefundResult = { refund: CreditNoteRefund; creditNote: CreditNote };

function journalHref(journalId: string): string {
  return `/operations/ledger-journals?journal=${journalId}`;
}

function laterOf(first: string, second: string): string {
  return first < second ? second : first;
}

/** Refunds are paid from active bank accounts in the base currency (example CN8). */
function isRefundAccount(account: Account): boolean {
  return account.accountType === "bank" && account.currencyCode === null;
}

/**
 * The customer's approved invoices with something due, one amount box each.
 * Everything entered is applied in one command, or none of it is (CN4, CN5).
 */
function ApplyCreditForm({
  organisationId,
  creditNote,
  onApplied,
}: {
  organisationId: string;
  creditNote: CreditNote;
  onApplied: (result: ApplyResult) => void;
}) {
  const invoices = useApiData<{ invoices: InvoiceSummary[] }>("/api/invoices", {
    organisationId,
    contactId: creditNote.contactId,
    awaitingPayment: "true",
    limit: "200",
  });
  // One key per command, so a retry returns the same applications instead of applying twice.
  const [key, setKey] = useState(() => newIdempotencyKey("credit-application"));
  const [applicationDate, setApplicationDate] = useState(() => laterOf(todayInBrowser(), creditNote.creditNoteDate));
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const candidates = (invoices.data?.invoices ?? []).filter(
    (invoice) => invoice.currencyCode === creditNote.currencyCode,
  );

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const applications = candidates
      .filter((invoice) => (amounts[invoice.id] ?? "").trim() !== "")
      .map((invoice) => ({ invoiceId: invoice.id, amount: amounts[invoice.id].trim() }));
    if (applications.length === 0) {
      setError("Enter an amount against at least one invoice.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await api<ApplyResult>(`/api/credit-notes/${creditNote.id}/applications`, {
        method: "POST",
        body: { organisationId, source: "ui", idempotencyKey: key, applicationDate, applications },
      });
      setKey(newIdempotencyKey("credit-application"));
      setAmounts({});
      invoices.reload();
      onApplied(result);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  if (invoices.error) {
    return <Notice tone="error">{invoices.error}</Notice>;
  }
  if (!invoices.data) {
    return <p className={ui.muted}>Loading the customer&apos;s invoices…</p>;
  }
  if (candidates.length === 0) {
    return (
      <Empty>
        {creditNote.contactName} has no approved {creditNote.currencyCode} invoices with an amount due. The credit stays on
        the credit note until it&apos;s applied or refunded.
      </Empty>
    );
  }
  return (
    <form onSubmit={(event) => void submit(event)} style={{ display: "grid", gap: 12 }} autoComplete="off">
      <h3 className={ui.cardTitle}>Apply credit</h3>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <div className={ui.tableWrap}>
        <table className={ui.table}>
          <thead>
            <tr>
              <th>Invoice</th>
              <th>Date</th>
              <th>Reference</th>
              <th className={ui.num}>Total</th>
              <th className={ui.num}>Amount due</th>
              <th className={ui.num} style={{ width: 150 }}>
                Apply ({creditNote.currencyCode})
              </th>
            </tr>
          </thead>
          <tbody>
            {candidates.map((invoice) => (
              <tr key={invoice.id}>
                <td>
                  <Link href={`/operations/invoices/${invoice.id}`}>{invoice.invoiceNumber}</Link>
                </td>
                <td>{formatDate(invoice.invoiceDate)}</td>
                <td className={ui.muted}>{invoice.reference}</td>
                <td className={ui.num}>
                  <Money value={invoice.total} />
                </td>
                <td className={ui.num}>
                  <Money value={invoice.amountDue ?? "0"} />
                </td>
                <td>
                  <input
                    aria-label={`Amount to apply to ${invoice.invoiceNumber ?? "invoice"}`}
                    inputMode="decimal"
                    className={ui.num}
                    value={amounts[invoice.id] ?? ""}
                    onChange={(event) => setAmounts((current) => ({ ...current, [invoice.id]: event.target.value }))}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className={ui.inlineForm}>
        <Field label="Date applied" hint="On or after the credit note date and each invoice date.">
          <input
            type="date"
            value={applicationDate}
            min={creditNote.creditNoteDate}
            onChange={(event) => setApplicationDate(event.target.value)}
            required
          />
        </Field>
        <Button type="submit" disabled={busy}>
          {busy ? "Applying…" : "Apply credit"}
        </Button>
        <span className={ui.muted}>
          {formatMoney(creditNote.remainingCredit)} is left to apply. Applying posts no journal: both sides are accounts
          receivable. It only lowers each invoice&apos;s amount due.
        </span>
      </div>
    </form>
  );
}

function RemoveApplicationForm({
  organisationId,
  creditNote,
  application,
  onCancel,
  onRemoved,
}: {
  organisationId: string;
  creditNote: CreditNote;
  application: CreditNoteApplication;
  onCancel: () => void;
  onRemoved: (result: ApplicationResult) => void;
}) {
  const [key] = useState(() => newIdempotencyKey("credit-removal"));
  const [removalDate, setRemovalDate] = useState(() => laterOf(todayInBrowser(), application.applicationDate));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      !window.confirm(
        `Remove the ${formatMoney(application.amount)} of credit applied to ${application.invoiceNumber}? That amount is due on the invoice again and back on the credit note. It can't be undone, but the credit can be applied again.`,
      )
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await api<ApplicationResult>(
        `/api/credit-notes/${creditNote.id}/applications/${application.id}/remove`,
        { method: "POST", body: { organisationId, source: "ui", idempotencyKey: key, removalDate } },
      );
      onRemoved(result);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(event) => void submit(event)} style={{ display: "grid", gap: 12 }}>
      <h3 className={ui.cardTitle}>
        Remove the {formatMoney(application.amount)} applied to {application.invoiceNumber}
      </h3>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <div className={ui.inlineForm}>
        <Field label="Removal date" hint="Must be in an open period.">
          <input
            type="date"
            value={removalDate}
            min={application.applicationDate}
            onChange={(event) => setRemovalDate(event.target.value)}
            required
          />
        </Field>
        <Button type="submit" variant="danger" disabled={busy || !removalDate}>
          {busy ? "Working…" : "Remove credit"}
        </Button>
        <Button variant="secondary" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function RefundForm({
  organisationId,
  creditNote,
  onRefunded,
}: {
  organisationId: string;
  creditNote: CreditNote;
  onRefunded: (result: RefundResult) => void;
}) {
  const accounts = useAccounts(organisationId);
  // One key per refund, so a retry returns the refund instead of paying it twice.
  const [key, setKey] = useState(() => newIdempotencyKey("credit-refund"));
  const [fields, setFields] = useState({
    refundDate: laterOf(todayInBrowser(), creditNote.creditNoteDate),
    amount: creditNote.remainingCredit ?? "",
    reference: "",
  });
  const [chosenAccount, setChosenAccount] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const bankAccounts = (accounts.data?.accounts ?? []).filter((account) => account.isActive && isRefundAccount(account));
  const defaultAccount = bankAccounts.find((account) => account.systemKey === "bank") ?? bankAccounts[0];
  const bankAccountCode = chosenAccount ?? defaultAccount?.code ?? "";

  function set<K extends keyof typeof fields>(name: K, value: string) {
    setFields((current) => ({ ...current, [name]: value }));
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await api<RefundResult>(`/api/credit-notes/${creditNote.id}/refunds`, {
        method: "POST",
        body: {
          organisationId,
          source: "ui",
          idempotencyKey: key,
          refundDate: fields.refundDate,
          amount: fields.amount,
          bankAccountCode,
          reference: fields.reference,
        },
      });
      setKey(newIdempotencyKey("credit-refund"));
      onRefunded(result);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  if (accounts.error) {
    return <Notice tone="error">{accounts.error}</Notice>;
  }
  if (accounts.data && bankAccounts.length === 0) {
    return (
      <Notice tone="warning">
        There&apos;s no active bank account in {creditNote.currencyCode} to refund from. Add one in{" "}
        <Link href="/operations/accounts">Accounts</Link>.
      </Notice>
    );
  }
  return (
    <form onSubmit={(event) => void submit(event)} style={{ display: "grid", gap: 12 }}>
      <h3 className={ui.cardTitle}>Refund credit</h3>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <div className={ui.grid4}>
        <Field label="Refund date">
          <input
            type="date"
            value={fields.refundDate}
            min={creditNote.creditNoteDate}
            onChange={(event) => set("refundDate", event.target.value)}
            required
          />
        </Field>
        <Field
          label={`Amount (${creditNote.currencyCode})`}
          hint={`${formatMoney(creditNote.remainingCredit)} of credit is left.`}
        >
          <input inputMode="decimal" value={fields.amount} onChange={(event) => set("amount", event.target.value)} required />
        </Field>
        <Field label="Bank account">
          <AccountSelect
            accounts={accounts.data?.accounts ?? []}
            value={bankAccountCode}
            onChange={setChosenAccount}
            filter={isRefundAccount}
            placeholder={accounts.data ? "Choose a bank account" : "Loading accounts…"}
            required
          />
        </Field>
        <Field label="Reference" hint="Optional, e.g. the bank transfer reference.">
          <input value={fields.reference} onChange={(event) => set("reference", event.target.value)} maxLength={100} />
        </Field>
      </div>
      <div className={ui.actions}>
        <Button type="submit" disabled={busy || !accounts.data}>
          {busy ? "Refunding…" : "Record refund"}
        </Button>
        <span className={ui.muted}>
          Posts the refund on its date: debit accounts receivable, credit the bank account.
        </span>
      </div>
    </form>
  );
}

function VoidRefundForm({
  organisationId,
  creditNote,
  refund,
  onCancel,
  onVoided,
}: {
  organisationId: string;
  creditNote: CreditNote;
  refund: CreditNoteRefund;
  onCancel: () => void;
  onVoided: (result: RefundResult) => void;
}) {
  const [key] = useState(() => newIdempotencyKey("credit-refund-void"));
  const [voidDate, setVoidDate] = useState(() => laterOf(todayInBrowser(), refund.refundDate));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      !window.confirm(
        `Void the refund of ${formatMoney(refund.amount)} paid on ${formatDate(refund.refundDate)}? This posts a reversal of its journal on ${formatDate(voidDate)}, so the credit is back on the credit note. It can't be undone.`,
      )
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await api<RefundResult>(`/api/credit-notes/${creditNote.id}/refunds/${refund.id}/void`, {
        method: "POST",
        body: { organisationId, source: "ui", idempotencyKey: key, voidDate },
      });
      onVoided(result);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(event) => void submit(event)} style={{ display: "grid", gap: 12 }}>
      <h3 className={ui.cardTitle}>
        Void the refund of {formatMoney(refund.amount)} from {formatDate(refund.refundDate)}
      </h3>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <div className={ui.inlineForm}>
        <Field label="Void date" hint="Must be in an open period.">
          <input
            type="date"
            value={voidDate}
            min={refund.refundDate}
            onChange={(event) => setVoidDate(event.target.value)}
            required
          />
        </Field>
        <Button type="submit" variant="danger" disabled={busy || !voidDate}>
          {busy ? "Working…" : "Void refund"}
        </Button>
        <Button variant="secondary" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/**
 * An approved or voided credit note's applications to invoices. Bookkeepers
 * can apply remaining credit to the customer's invoices and remove an
 * application, which puts the amount back on both.
 */
export function CreditNoteApplications({
  organisationId,
  creditNote,
  onChanged,
}: {
  organisationId: string;
  creditNote: CreditNote;
  onChanged: (creditNote: CreditNote, message: string) => void;
}) {
  const { can } = useWorkspace();
  const list = useApiData<{ applications: CreditNoteApplication[] }>(
    `/api/credit-notes/${encodeURIComponent(creditNote.id)}/applications`,
    { organisationId },
  );
  const [removing, setRemoving] = useState<CreditNoteApplication | null>(null);
  const bookkeeper = can("bookkeeper");
  const canApply = bookkeeper && creditNote.status === "approved" && creditNote.creditStatus !== "used";
  const applications = list.data?.applications ?? [];

  return (
    <Card
      title="Credit applied to invoices"
      description={
        creditNote.status === "approved"
          ? `Applied ${formatMoney(creditNote.amountApplied)} of ${formatMoney(creditNote.total)}. An application can't be edited: remove it and apply the credit again.`
          : "This credit note was voided. Its applications were removed first."
      }
    >
      {list.error ? <Notice tone="error">{list.error}</Notice> : null}
      {!list.data && !list.error ? <p className={ui.muted}>Loading applications…</p> : null}
      {list.data && applications.length === 0 ? <Empty>No credit applied yet.</Empty> : null}
      {applications.length > 0 ? (
        <div className={ui.tableWrap}>
          <table className={ui.table}>
            <thead>
              <tr>
                <th>Date</th>
                <th>Invoice</th>
                <th>Status</th>
                <th className={ui.num}>Amount</th>
                {bookkeeper ? <th /> : null}
              </tr>
            </thead>
            <tbody>
              {applications.map((application) => (
                <tr key={application.id}>
                  <td>{formatDate(application.applicationDate)}</td>
                  <td>
                    <Link href={`/operations/invoices/${application.invoiceId}`}>{application.invoiceNumber}</Link>
                  </td>
                  <td>
                    {application.status === "active" ? (
                      <Badge tone="green">Active</Badge>
                    ) : (
                      <>
                        <Badge tone="red">Removed</Badge>
                        <span className={ui.muted}> on {formatDate(application.removalDate)}</span>
                      </>
                    )}
                  </td>
                  <td className={ui.num}>
                    <Money value={application.amount} />
                  </td>
                  {bookkeeper ? (
                    <td>
                      {application.status === "active" ? (
                        <Button
                          size="small"
                          variant="secondary"
                          onClick={() => setRemoving(application)}
                          disabled={removing !== null}
                        >
                          Remove…
                        </Button>
                      ) : null}
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {removing ? (
        <RemoveApplicationForm
          key={removing.id}
          organisationId={organisationId}
          creditNote={creditNote}
          application={removing}
          onCancel={() => setRemoving(null)}
          onRemoved={(result) => {
            setRemoving(null);
            list.reload();
            onChanged(
              result.creditNote,
              `Removed the ${formatMoney(result.application.amount)} applied to ${result.application.invoiceNumber} on ${formatDate(result.application.removalDate)}; ${formatMoney(result.creditNote.remainingCredit)} of credit is left.`,
            );
          }}
        />
      ) : null}
      {canApply && !removing ? (
        <ApplyCreditForm
          key={creditNote.remainingCredit}
          organisationId={organisationId}
          creditNote={creditNote}
          onApplied={(result) => {
            list.reload();
            const applied = result.applications.map((application) => application.invoiceNumber).join(", ");
            onChanged(
              result.creditNote,
              `Applied credit to ${applied}. No journal was posted; ${formatMoney(result.creditNote.remainingCredit)} of credit is left.`,
            );
          }}
        />
      ) : null}
    </Card>
  );
}

/**
 * An approved or voided credit note's cash refunds. Bookkeepers can refund
 * remaining credit and void a refund, which posts its reversal.
 */
export function CreditNoteRefunds({
  organisationId,
  creditNote,
  onChanged,
}: {
  organisationId: string;
  creditNote: CreditNote;
  onChanged: (creditNote: CreditNote, message: string) => void;
}) {
  const { can } = useWorkspace();
  const list = useApiData<{ refunds: CreditNoteRefund[] }>(
    `/api/credit-notes/${encodeURIComponent(creditNote.id)}/refunds`,
    { organisationId },
  );
  const [voiding, setVoiding] = useState<CreditNoteRefund | null>(null);
  const bookkeeper = can("bookkeeper");
  const canRefund = bookkeeper && creditNote.status === "approved" && creditNote.creditStatus !== "used";
  const refunds = list.data?.refunds ?? [];

  return (
    <Card
      title="Refunds"
      description={
        creditNote.status === "approved"
          ? `Refunded ${formatMoney(creditNote.amountRefunded)}. A refund can't be edited: void it and record it again.`
          : "This credit note was voided. Its refunds were voided first."
      }
    >
      {list.error ? <Notice tone="error">{list.error}</Notice> : null}
      {!list.data && !list.error ? <p className={ui.muted}>Loading refunds…</p> : null}
      {list.data && refunds.length === 0 ? <Empty>No refunds yet.</Empty> : null}
      {refunds.length > 0 ? (
        <div className={ui.tableWrap}>
          <table className={ui.table}>
            <thead>
              <tr>
                <th>Date</th>
                <th>Bank account</th>
                <th>Reference</th>
                <th>Status</th>
                <th>Journal</th>
                <th className={ui.num}>Amount</th>
                {bookkeeper ? <th /> : null}
              </tr>
            </thead>
            <tbody>
              {refunds.map((refund) => (
                <tr key={refund.id}>
                  <td>{formatDate(refund.refundDate)}</td>
                  <td>
                    {refund.bankAccountCode} · {refund.bankAccountName}
                  </td>
                  <td className={ui.muted}>{refund.reference}</td>
                  <td>{refund.status === "active" ? <Badge tone="green">Active</Badge> : <Badge tone="red">Voided</Badge>}</td>
                  <td>
                    <Link href={journalHref(refund.journalId)}>#{refund.journalId}</Link>
                    {refund.voidJournalId ? (
                      <span className={ui.muted}>
                        {" "}
                        · reversed on {formatDate(refund.voidDate)} by{" "}
                        <Link href={journalHref(refund.voidJournalId)}>#{refund.voidJournalId}</Link>
                      </span>
                    ) : null}
                  </td>
                  <td className={ui.num}>
                    <Money value={refund.amount} />
                  </td>
                  {bookkeeper ? (
                    <td>
                      {refund.status === "active" ? (
                        <Button size="small" variant="secondary" onClick={() => setVoiding(refund)} disabled={voiding !== null}>
                          Void…
                        </Button>
                      ) : null}
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {voiding ? (
        <VoidRefundForm
          key={voiding.id}
          organisationId={organisationId}
          creditNote={creditNote}
          refund={voiding}
          onCancel={() => setVoiding(null)}
          onVoided={(result) => {
            setVoiding(null);
            list.reload();
            onChanged(
              result.creditNote,
              `Voided the refund of ${formatMoney(result.refund.amount)}. Its journal was reversed on ${formatDate(result.refund.voidDate)}; ${formatMoney(result.creditNote.remainingCredit)} of credit is left.`,
            );
          }}
        />
      ) : null}
      {canRefund && !voiding ? (
        <RefundForm
          key={creditNote.remainingCredit}
          organisationId={organisationId}
          creditNote={creditNote}
          onRefunded={(result) => {
            list.reload();
            onChanged(
              result.creditNote,
              `Refunded ${formatMoney(result.refund.amount)} on ${formatDate(result.refund.refundDate)} and posted it to the ledger; ${formatMoney(result.creditNote.remainingCredit)} of credit is left.`,
            );
          }}
        />
      ) : null}
    </Card>
  );
}
