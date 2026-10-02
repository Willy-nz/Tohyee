"use client";

import Link from "next/link";
import { type FormEvent, useState } from "react";
import { AccountSelect, Money, useAccounts } from "@/components/books";
import { useApiData } from "@/components/hooks";
import { Badge, Button, Card, Empty, Field, Notice, ui } from "@/components/ui";
import { ExchangeRateField, useLastRate } from "@/components/fx";
import { useWorkspace } from "@/components/workspace";
import type { Account } from "@/lib/accounts/service";
import { api, errorMessage, newIdempotencyKey } from "@/lib/client/api";
import type { OverpaymentApplication, OverpaymentRefund } from "@/lib/invoices/overpayments";
import type { CustomerPayment } from "@/lib/invoices/payments";
import { formatDate, formatMoney, todayInBrowser } from "@/lib/format";
import type { InvoiceSummary } from "@/lib/invoices/service";
import { useConfirm } from "@/components/confirm-dialog";

type ApplyResult = { applications: OverpaymentApplication[]; payment: CustomerPayment };
type ApplicationResult = { application: OverpaymentApplication; payment: CustomerPayment };
type RefundResult = { refund: OverpaymentRefund; payment: CustomerPayment };

function journalHref(journalId: string): string {
  return `/operations/ledger-journals?journal=${journalId}`;
}

function laterOf(first: string, second: string): string {
  return first < second ? second : first;
}

/**
 * Refunds move through active bank accounts in the base currency, or, for
 * foreign-currency credit, in its own currency (MC16-MC18; a third currency is refused, MC30).
 */
function refundAccountFilter(currencyCode: string | null) {
  return (account: Account): boolean =>
    (account.accountType === "bank" || account.accountType === "credit_card") &&
    (account.currencyCode === null || (currencyCode !== null && account.currencyCode === currencyCode));
}

/**
 * The customer's other approved invoices with something due, one amount box
 * each. Everything entered is applied in one command, or none of it is (OP2, OP5).
 */
function ApplyCreditForm({
  organisationId,
  payment,
  onApplied,
}: {
  organisationId: string;
  payment: CustomerPayment;
  onApplied: (result: ApplyResult) => void;
}) {
  const invoices = useApiData<{ invoices: InvoiceSummary[] }>("/api/invoices", {
    organisationId,
    contactId: payment.contactId,
    awaitingPayment: "true",
    limit: "200",
  });
  // One key per command, so a retry returns the same applications instead of applying twice.
  const [key, setKey] = useState(() => newIdempotencyKey("overpayment-application"));
  const [applicationDate, setApplicationDate] = useState(() => laterOf(todayInBrowser(), payment.paymentDate));
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const candidates = (invoices.data?.invoices ?? []).filter(
    (invoice) => invoice.currencyCode === payment.currencyCode && invoice.id !== payment.invoiceId,
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
      const result = await api<ApplyResult>(`/api/overpayments/${payment.id}/applications`, {
        method: "POST",
        body: { organisationId, source: "ui", idempotencyKey: key, applicationDate, applications },
      });
      setKey(newIdempotencyKey("overpayment-application"));
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
        {payment.contactName} has no other approved {payment.currencyCode} invoices with an amount due. The overpayment
        stays as credit until it&apos;s applied or refunded.
      </Empty>
    );
  }
  return (
    <form onSubmit={(event) => void submit(event)} style={{ display: "grid", gap: 12 }} autoComplete="off">
      <h3 className={ui.cardTitle}>Apply the overpayment</h3>
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
                Apply ({payment.currencyCode})
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
        <Field label="Date applied" hint="On or after the payment date and each invoice date.">
          <input
            type="date"
            value={applicationDate}
            min={payment.paymentDate}
            onChange={(event) => setApplicationDate(event.target.value)}
            required
          />
        </Field>
        <Button type="submit" disabled={busy}>
          {busy ? "Applying…" : "Apply credit"}
        </Button>
        <span className={ui.muted}>
          {formatMoney(payment.overpaymentRemaining)} is left to apply. Applying posts no journal: both sides are accounts
          receivable. It only lowers each invoice&apos;s amount due.
        </span>
      </div>
    </form>
  );
}

function RemoveApplicationForm({
  organisationId,
  payment,
  application,
  onCancel,
  onRemoved,
}: {
  organisationId: string;
  payment: CustomerPayment;
  application: OverpaymentApplication;
  onCancel: () => void;
  onRemoved: (result: ApplicationResult) => void;
}) {
  const confirm = useConfirm();
  const [key] = useState(() => newIdempotencyKey("overpayment-removal"));
  const [removalDate, setRemovalDate] = useState(() => laterOf(todayInBrowser(), application.applicationDate));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      !(await confirm(
        `Remove the ${formatMoney(application.amount)} of credit applied to ${application.invoiceNumber}? That amount is due on the invoice again and back on the overpayment. It can't be undone, but the credit can be applied again.`,
      ))
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await api<ApplicationResult>(
        `/api/overpayments/${payment.id}/applications/${application.id}/remove`,
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
  payment,
  onRefunded,
}: {
  organisationId: string;
  payment: CustomerPayment;
  onRefunded: (result: RefundResult) => void;
}) {
  const accounts = useAccounts(organisationId);
  // One key per refund, so a retry returns the refund instead of paying it twice.
  const [key, setKey] = useState(() => newIdempotencyKey("overpayment-refund"));
  const [fields, setFields] = useState({
    refundDate: laterOf(todayInBrowser(), payment.paymentDate),
    amount: payment.overpaymentRemaining,
    reference: "",
  });
  const [chosenAccount, setChosenAccount] = useState<string | null>(null);
  // Foreign-currency credit is refunded in its currency at the refund's own rate (MC16-MC18).
  const foreign = payment.exchangeRate !== null;
  const baseCurrency = useWorkspace().current?.baseCurrency ?? "NZD";
  const [typedRate, setTypedRate] = useState<string | null>(null);
  const suggestedRate = useLastRate(organisationId, payment.currencyCode, baseCurrency, fields.refundDate);
  const isRefundAccount = refundAccountFilter(foreign ? payment.currencyCode : null);
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
      const result = await api<RefundResult>(`/api/overpayments/${payment.id}/refunds`, {
        method: "POST",
        body: {
          organisationId,
          source: "ui",
          idempotencyKey: key,
          refundDate: fields.refundDate,
          amount: fields.amount,
          bankAccountCode,
          reference: fields.reference,
          ...(foreign && typedRate !== null ? { exchangeRate: typedRate } : {}),
        },
      });
      setKey(newIdempotencyKey("overpayment-refund"));
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
        There&apos;s no active bank account in {payment.currencyCode} to refund from. Add one in{" "}
        <Link href="/operations/accounts">Accounts</Link>.
      </Notice>
    );
  }
  return (
    <form onSubmit={(event) => void submit(event)} style={{ display: "grid", gap: 12 }}>
      <h3 className={ui.cardTitle}>Refund the overpayment</h3>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <div className={ui.grid4}>
        <Field label="Refund date">
          <input
            type="date"
            value={fields.refundDate}
            min={payment.paymentDate}
            onChange={(event) => set("refundDate", event.target.value)}
            required
          />
        </Field>
        <Field
          label={`Amount (${payment.currencyCode})`}
          hint={`${formatMoney(payment.overpaymentRemaining)} of the overpayment is left.`}
        >
          <input inputMode="decimal" value={fields.amount} onChange={(event) => set("amount", event.target.value)} required />
        </Field>
        {foreign ? (
          <ExchangeRateField currencyCode={payment.currencyCode} baseCurrency={baseCurrency} suggested={suggestedRate} value={typedRate} onChange={setTypedRate} />
        ) : null}
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
  payment,
  refund,
  onCancel,
  onVoided,
}: {
  organisationId: string;
  payment: CustomerPayment;
  refund: OverpaymentRefund;
  onCancel: () => void;
  onVoided: (result: RefundResult) => void;
}) {
  const confirm = useConfirm();
  const [key] = useState(() => newIdempotencyKey("overpayment-refund-void"));
  const [voidDate, setVoidDate] = useState(() => laterOf(todayInBrowser(), refund.refundDate));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      !(await confirm(
        `Void the refund of ${formatMoney(refund.amount)} paid on ${formatDate(refund.refundDate)}? This posts a reversal of its journal on ${formatDate(voidDate)}, so the amount is back on the overpayment. It can't be undone.`,
      ))
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await api<RefundResult>(`/api/overpayments/${payment.id}/refunds/${refund.id}/void`, {
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
 * An overpayment's applications to the customer's other invoices. Bookkeepers
 * can apply what's left and remove an application, which puts the amount back
 * on both.
 */
export function OverpaymentApplications({
  organisationId,
  payment,
  onChanged,
}: {
  organisationId: string;
  payment: CustomerPayment;
  onChanged: (payment: CustomerPayment, message: string) => void;
}) {
  const { can } = useWorkspace();
  const list = useApiData<{ applications: OverpaymentApplication[] }>(
    `/api/overpayments/${encodeURIComponent(payment.id)}/applications`,
    { organisationId },
  );
  const [removing, setRemoving] = useState<OverpaymentApplication | null>(null);
  const bookkeeper = can("bookkeeper");
  const canApply = bookkeeper && payment.status === "active" && payment.overpaymentStatus !== "used";
  const applications = list.data?.applications ?? [];

  return (
    <Card
      title="Credit applied to invoices"
      description={
        payment.status === "active"
          ? `Applied ${formatMoney(payment.overpaymentApplied)} of ${formatMoney(payment.overpaymentAmount)}. An application can't be edited: remove it and apply the credit again.`
          : "This payment was voided. Its overpayment's applications were removed first."
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
          payment={payment}
          application={removing}
          onCancel={() => setRemoving(null)}
          onRemoved={(result) => {
            setRemoving(null);
            list.reload();
            onChanged(
              result.payment,
              `Removed the ${formatMoney(result.application.amount)} applied to ${result.application.invoiceNumber} on ${formatDate(result.application.removalDate)}; ${formatMoney(result.payment.overpaymentRemaining)} of the overpayment is left.`,
            );
          }}
        />
      ) : null}
      {canApply && !removing ? (
        <ApplyCreditForm
          key={payment.overpaymentRemaining}
          organisationId={organisationId}
          payment={payment}
          onApplied={(result) => {
            list.reload();
            const applied = result.applications.map((application) => application.invoiceNumber).join(", ");
            onChanged(
              result.payment,
              `Applied the overpayment to ${applied}. No journal was posted; ${formatMoney(result.payment.overpaymentRemaining)} is left.`,
            );
          }}
        />
      ) : null}
    </Card>
  );
}

/**
 * An overpayment's cash refunds. Bookkeepers can refund what's left and void
 * a refund, which posts its reversal.
 */
export function OverpaymentRefunds({
  organisationId,
  payment,
  onChanged,
}: {
  organisationId: string;
  payment: CustomerPayment;
  onChanged: (payment: CustomerPayment, message: string) => void;
}) {
  const { can } = useWorkspace();
  const list = useApiData<{ refunds: OverpaymentRefund[] }>(
    `/api/overpayments/${encodeURIComponent(payment.id)}/refunds`,
    { organisationId },
  );
  const [voiding, setVoiding] = useState<OverpaymentRefund | null>(null);
  const bookkeeper = can("bookkeeper");
  const canRefund = bookkeeper && payment.status === "active" && payment.overpaymentStatus !== "used";
  const refunds = list.data?.refunds ?? [];

  return (
    <Card
      title="Refunds"
      description={
        payment.status === "active"
          ? `Refunded ${formatMoney(payment.overpaymentRefunded)}. A refund can't be edited: void it and record it again.`
          : "This payment was voided. Its overpayment's refunds were voided first."
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
          payment={payment}
          refund={voiding}
          onCancel={() => setVoiding(null)}
          onVoided={(result) => {
            setVoiding(null);
            list.reload();
            onChanged(
              result.payment,
              `Voided the refund of ${formatMoney(result.refund.amount)}. Its journal was reversed on ${formatDate(result.refund.voidDate)}; ${formatMoney(result.payment.overpaymentRemaining)} of the overpayment is left.`,
            );
          }}
        />
      ) : null}
      {canRefund && !voiding ? (
        <RefundForm
          key={payment.overpaymentRemaining}
          organisationId={organisationId}
          payment={payment}
          onRefunded={(result) => {
            list.reload();
            onChanged(
              result.payment,
              `Refunded ${formatMoney(result.refund.amount)} on ${formatDate(result.refund.refundDate)} and posted it to the ledger; ${formatMoney(result.payment.overpaymentRemaining)} of the overpayment is left.`,
            );
          }}
        />
      ) : null}
    </Card>
  );
}
