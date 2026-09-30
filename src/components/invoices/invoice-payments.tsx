"use client";

import Link from "next/link";
import { type FormEvent, useState } from "react";
import { AccountSelect, Money, useAccounts } from "@/components/books";
import { useApiData } from "@/components/hooks";
import { Badge, Button, Card, Empty, Field, Notice, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import type { Account } from "@/lib/accounts/service";
import { api, errorMessage, newIdempotencyKey } from "@/lib/client/api";
import { formatDate, formatMoney, todayInBrowser } from "@/lib/format";
import type { CustomerPayment } from "@/lib/invoices/payments";
import type { Invoice } from "@/lib/invoices/service";
import { dec, isPositive, sub, toPlainString } from "@/lib/money/decimal";
import { convertAtRate, isRateText } from "@/lib/money/fx";
import { ExchangeRateField, effectiveRate, useLastRate } from "@/components/fx";

type PaymentResult = { payment: CustomerPayment; invoice: Invoice };

/** How much an amount typed in is over what's due, or null if it isn't (or isn't a number yet). */
function amountBeyondDue(amount: string, due: string): string | null {
  try {
    const extra = sub(dec(amount.trim()), dec(due));
    return isPositive(extra) ? toPlainString(extra) : null;
  } catch {
    return null;
  }
}

/** Amounts arrive as fixed strings like "0.00". */
function isZeroAmount(amount: string): boolean {
  return /^0(\.0+)?$/.test(amount);
}

function journalHref(journalId: string): string {
  return `/operations/ledger-journals?journal=${journalId}`;
}

/**
 * Payments go into active bank accounts in the base currency (example CP8),
 * or for a foreign-currency invoice also into one in its currency (MC5).
 */
function paymentAccountFilter(currencyCode: string | null) {
  return (account: Account): boolean =>
    (account.accountType === "bank" || account.accountType === "credit_card") &&
    (account.currencyCode === null || (currencyCode !== null && account.currencyCode === currencyCode));
}

function RecordPaymentForm({
  organisationId,
  invoice,
  onRecorded,
}: {
  organisationId: string;
  invoice: Invoice;
  onRecorded: (result: PaymentResult) => void;
}) {
  const accounts = useAccounts(organisationId);
  // One key per payment, so a retry after a dropped connection returns the
  // payment instead of recording it twice.
  const [key, setKey] = useState(() => newIdempotencyKey("payment"));
  const [fields, setFields] = useState({ paymentDate: todayInBrowser(), amount: invoice.amountDue ?? "", reference: "" });
  const [chosenAccount, setChosenAccount] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A foreign-currency invoice is paid in its currency at the payment's own rate (MC5, MC6).
  const foreign = invoice.exchangeRate !== null;
  const baseCurrency = useWorkspace().current?.baseCurrency ?? "NZD";
  const [typedRate, setTypedRate] = useState<string | null>(null);
  const suggestedRate = useLastRate(organisationId, invoice.currencyCode, baseCurrency, fields.paymentDate);
  const rate = effectiveRate(typedRate, suggestedRate);
  const isPaymentAccount = paymentAccountFilter(foreign ? invoice.currencyCode : null);

  const bankAccounts = (accounts.data?.accounts ?? []).filter((account) => account.isActive && isPaymentAccount(account));
  const defaultAccount = bankAccounts.find((account) => account.systemKey === "bank") ?? bankAccounts[0];
  const bankAccountCode = chosenAccount ?? defaultAccount?.code ?? "";

  function set<K extends keyof typeof fields>(name: K, value: string) {
    setFields((current) => ({ ...current, [name]: value }));
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const extra = amountBeyondDue(fields.amount, invoice.amountDue ?? "0");
    if (
      !foreign &&
      extra !== null &&
      !window.confirm(
        invoice.paidStatus === "paid"
          ? `${invoice.invoiceNumber} is already paid. Record ${formatMoney(fields.amount)} anyway? All of it will be kept as credit for ${invoice.contactName}, to apply to their other invoices or refund.`
          : `This is ${formatMoney(extra)} more than is due. Record it? The extra will be kept as credit for ${invoice.contactName}, to apply to their other invoices or refund.`,
      )
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await api<PaymentResult>(`/api/invoices/${invoice.id}/payments`, {
        method: "POST",
        body: {
          organisationId,
          source: "ui",
          idempotencyKey: key,
          paymentDate: fields.paymentDate,
          amount: fields.amount,
          bankAccountCode,
          reference: fields.reference,
          ...(foreign && typedRate !== null ? { exchangeRate: typedRate } : {}),
        },
      });
      setKey(newIdempotencyKey("payment"));
      onRecorded(result);
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
        There&apos;s no active bank account in {invoice.currencyCode} to record a payment into. Add one in{" "}
        <Link href="/operations/accounts">Accounts</Link>.
      </Notice>
    );
  }
  return (
    <form onSubmit={(event) => void submit(event)} style={{ display: "grid", gap: 12 }}>
      <h3 className={ui.cardTitle}>Record payment</h3>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <div className={ui.grid4}>
        <Field label="Payment date">
          <input
            type="date"
            value={fields.paymentDate}
            min={invoice.invoiceDate}
            onChange={(event) => set("paymentDate", event.target.value)}
            required
          />
        </Field>
        <Field
          label={`Amount (${invoice.currencyCode})`}
          hint={
            foreign
              ? `${invoice.currencyCode} ${formatMoney(invoice.amountDue)} is due (${baseCurrency} ${formatMoney(invoice.amountDueBase)} at the invoice's rate). Anything more is kept as an overpayment in ${invoice.currencyCode}: credit for ${invoice.contactName}.`
              : `${formatMoney(invoice.amountDue)} is due. Anything more is kept as an overpayment: credit for ${invoice.contactName}.`
          }
        >
          <input inputMode="decimal" value={fields.amount} onChange={(event) => set("amount", event.target.value)} required />
        </Field>
        {foreign ? (
          <ExchangeRateField currencyCode={invoice.currencyCode} baseCurrency={baseCurrency} suggested={suggestedRate} value={typedRate} onChange={setTypedRate} />
        ) : null}
        <Field label="Bank account">
          <AccountSelect
            accounts={accounts.data?.accounts ?? []}
            value={bankAccountCode}
            onChange={setChosenAccount}
            filter={isPaymentAccount}
            placeholder={accounts.data ? "Choose a bank account" : "Loading accounts…"}
            required
          />
        </Field>
        <Field label="Reference" hint="Optional, e.g. the customer's bank reference.">
          <input value={fields.reference} onChange={(event) => set("reference", event.target.value)} maxLength={100} />
        </Field>
      </div>
      <div className={ui.actions}>
        <Button type="submit" disabled={busy || !accounts.data}>
          {busy ? "Recording…" : "Record payment"}
        </Button>
        <span className={ui.muted}>
          {foreign
            ? `${
                isRateText(rate) && /^\d+(\.\d+)?$/.test(fields.amount.trim())
                  ? `${invoice.currencyCode} ${formatMoney(fields.amount)} at ${rate} is ${baseCurrency} ${formatMoney(convertAtRate(fields.amount.trim(), rate))}. `
                  : ""
              }Accounts receivable is cleared at the invoice's rate; the difference is a realised currency gain or loss.`
            : "Posts the whole payment on its date: debit the bank account, credit accounts receivable."}
        </span>
      </div>
    </form>
  );
}

function VoidPaymentForm({
  organisationId,
  invoice,
  payment,
  onCancel,
  onVoided,
}: {
  organisationId: string;
  invoice: Invoice;
  payment: CustomerPayment;
  onCancel: () => void;
  onVoided: (result: PaymentResult) => void;
}) {
  const [key] = useState(() => newIdempotencyKey("payment-void"));
  const [voidDate, setVoidDate] = useState(() => {
    const today = todayInBrowser();
    return today < payment.paymentDate ? payment.paymentDate : today;
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      !window.confirm(
        `Void the payment of ${formatMoney(payment.amount)} received on ${formatDate(payment.paymentDate)}? This posts a reversal of its journal on ${formatDate(voidDate)}, so the amount is due again${payment.overpaymentStatus ? " and its overpayment is cancelled" : ""}. It can't be undone.`,
      )
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await api<PaymentResult>(`/api/invoices/${invoice.id}/payments/${payment.id}/void`, {
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
        Void the payment of {formatMoney(payment.amount)} from {formatDate(payment.paymentDate)}
      </h3>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <div className={ui.inlineForm}>
        <Field label="Void date" hint="Must be in an open period.">
          <input
            type="date"
            value={voidDate}
            min={payment.paymentDate}
            onChange={(event) => setVoidDate(event.target.value)}
            required
          />
        </Field>
        <Button type="submit" variant="danger" disabled={busy || !voidDate}>
          {busy ? "Working…" : "Void payment"}
        </Button>
        <Button variant="secondary" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/**
 * An approved or voided invoice's payments. Bookkeepers can record a payment
 * while something is still due, and void a payment, which posts its reversal.
 */
export function InvoicePayments({
  organisationId,
  invoice,
  onChanged,
}: {
  organisationId: string;
  invoice: Invoice;
  onChanged: (invoice: Invoice, message: string) => void;
}) {
  const { can } = useWorkspace();
  const list = useApiData<{ payments: CustomerPayment[] }>(`/api/invoices/${encodeURIComponent(invoice.id)}/payments`, {
    organisationId,
  });
  const [voiding, setVoiding] = useState<CustomerPayment | null>(null);
  const bookkeeper = can("bookkeeper");
  // A paid invoice can still take a payment (example OP4: the customer paid twice); it's all kept as credit.
  const canRecord = bookkeeper && invoice.status === "approved";
  const payments = list.data?.payments ?? [];

  return (
    <Card
      title="Payments"
      description={
        invoice.status === "approved"
          ? `Paid ${formatMoney(invoice.amountPaid)} of ${formatMoney(invoice.total)}; ${formatMoney(invoice.amountDue)} is due. A payment can't be edited: void it and record it again.`
          : "This invoice was voided. Any payments against it were voided first."
      }
    >
      {list.error ? <Notice tone="error">{list.error}</Notice> : null}
      {!list.data && !list.error ? <p className={ui.muted}>Loading payments…</p> : null}
      {list.data && payments.length === 0 ? <Empty>No payments yet.</Empty> : null}
      {payments.length > 0 ? (
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
                <th>Overpaid</th>
                {bookkeeper ? <th /> : null}
              </tr>
            </thead>
            <tbody>
              {payments.map((payment) => (
                <tr key={payment.id}>
                  <td>{formatDate(payment.paymentDate)}</td>
                  <td>
                    {payment.bankAccountCode} · {payment.bankAccountName}
                  </td>
                  <td className={ui.muted}>{payment.reference}</td>
                  <td>
                    {payment.status === "active" ? <Badge tone="green">Active</Badge> : <Badge tone="red">Voided</Badge>}
                  </td>
                  <td>
                    <Link href={journalHref(payment.journalId)}>#{payment.journalId}</Link>
                    {payment.voidJournalId ? (
                      <span className={ui.muted}>
                        {" "}
                        · reversed on {formatDate(payment.voidDate)} by{" "}
                        <Link href={journalHref(payment.voidJournalId)}>#{payment.voidJournalId}</Link>
                      </span>
                    ) : null}
                  </td>
                  <td className={ui.num}>
                    <Money value={payment.amount} />
                    {payment.exchangeRate ? (
                      <div className={ui.muted}>
                        at {payment.exchangeRate} = {formatMoney(payment.baseAmount)}; realised {payment.realisedGain?.startsWith("-") ? `loss ${formatMoney(payment.realisedGain.slice(1))}` : `gain ${formatMoney(payment.realisedGain)}`}
                      </div>
                    ) : null}
                    {payment.batchId ? (
                      <div className={ui.muted}>
                        <Link href={`/operations/customer-payments/${payment.batchId}`}>part of a payment for several invoices</Link>
                      </div>
                    ) : null}
                  </td>
                  <td>
                    {isZeroAmount(payment.overpaymentAmount) ? null : (
                      <Link href={`/operations/overpayments/${payment.id}`}>
                        {formatMoney(payment.overpaymentAmount)}
                        {payment.status === "active" ? ` (${formatMoney(payment.overpaymentRemaining)} left)` : ""}
                      </Link>
                    )}
                  </td>
                  {bookkeeper ? (
                    <td>
                      {payment.status === "active" && payment.batchId ? (
                        <Link href={`/operations/customer-payments/${payment.batchId}`}>Void the whole payment…</Link>
                      ) : payment.status === "active" ? (
                        <Button size="small" variant="secondary" onClick={() => setVoiding(payment)} disabled={voiding !== null}>
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
        <VoidPaymentForm
          key={voiding.id}
          organisationId={organisationId}
          invoice={invoice}
          payment={voiding}
          onCancel={() => setVoiding(null)}
          onVoided={(result) => {
            setVoiding(null);
            list.reload();
            onChanged(
              result.invoice,
              `Voided the payment of ${formatMoney(result.payment.amount)}. Its journal was reversed on ${formatDate(result.payment.voidDate)}; ${formatMoney(result.invoice.amountDue)} is due.`,
            );
          }}
        />
      ) : null}
      {canRecord && !voiding ? (
        <RecordPaymentForm
          key={invoice.amountDue}
          organisationId={organisationId}
          invoice={invoice}
          onRecorded={(result) => {
            list.reload();
            onChanged(
              result.invoice,
              result.payment.overpaymentStatus
                ? `Recorded a payment of ${formatMoney(result.payment.amount)} on ${formatDate(result.payment.paymentDate)} and posted it to the ledger. It paid ${formatMoney(result.payment.invoiceAmount)} on this invoice; the other ${formatMoney(result.payment.overpaymentAmount)} is an overpayment. Apply it to ${result.invoice.contactName}'s other invoices or refund it from the Overpaid link.`
                : `Recorded a payment of ${formatMoney(result.payment.amount)} on ${formatDate(result.payment.paymentDate)} and posted it to the ledger; ${formatMoney(result.invoice.amountDue)} is due.`,
            );
          }}
        />
      ) : null}
    </Card>
  );
}
