"use client";

import Link from "next/link";
import { useState } from "react";
import { useApiData } from "@/components/hooks";
import { Badge, Button, Card, Empty, Notice, ui } from "@/components/ui";
import { GoCardlessSettingsCard } from "@/components/direct-debit";
import { useWorkspace } from "@/components/workspace";
import { api, errorMessage } from "@/lib/client/api";
import { formatDate, formatDateTime, formatMoney } from "@/lib/format";
import type { InvoicePayPal, PayPalCheck, PayPalPayNowStatus } from "@/lib/payments/paypal";
import type { InvoicePayNow, OnlinePaymentCheck, OnlinePaymentStatus } from "@/lib/payments/stripe";

type Statuses = { payments: OnlinePaymentStatus; paypal: PayPalPayNowStatus };

/**
 * Online invoice payments with Stripe (PN1-PN12): the settings page (turn
 * Pay now on or off, Check now, payments waiting for a person) and the Pay
 * now card on an invoice.
 */

export function OnlinePaymentsSettings({ organisationId }: { organisationId: string }) {
  const { can } = useWorkspace();
  const loaded = useApiData<Statuses>("/api/online-payments", { organisationId });
  const [statuses, setStatuses] = useState<Statuses | null>(null);
  const [message, setMessage] = useState<{ tone: "success" | "error" | "warning"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const both = statuses ?? loaded.data ?? null;
  const current = both?.payments ?? null;
  const paypal = both?.paypal ?? null;
  async function run(work: () => Promise<void>) {
    setBusy(true);
    setMessage(null);
    try {
      await work();
    } catch (caught) {
      setMessage({ tone: "error", text: errorMessage(caught) });
    } finally {
      setBusy(false);
    }
  }
  if (loaded.error) return <Notice tone="error">{loaded.error}</Notice>;
  if (!current || !paypal) return <p className={ui.muted}>Loading…</p>;
  const toggle = (provider: "stripe" | "paypal", enabled: boolean) =>
    void run(async () => {
      const result = await api<Statuses & { linksNotSwitchedOff: string[] }>("/api/online-payments", {
        method: "PUT",
        body: { organisationId, provider, enabled },
      });
      setStatuses(result);
      const name = provider === "paypal" ? "Pay with PayPal" : "Pay now with Stripe";
      setMessage(
        result.linksNotSwitchedOff.length
          ? {
              tone: "warning",
              text: `Turned off. ${provider === "paypal" ? "PayPal" : "Stripe"} couldn't be reached to switch off: ${result.linksNotSwitchedOff.join(", ")}. Switch them off in its dashboard.`,
            }
          : { tone: "success", text: enabled ? `${name} is on.` : `${name} is off. Open links were switched off.` },
      );
    });
  return (
    <>
      {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
      <Card
        title="Pay now with Stripe"
        description="Approved invoices with something due get a Stripe payment link in their email and PDF. Customers pay by card on Stripe's page, and Tohyee records the payment into your Stripe bank account. Card fees come in through the Stripe feed; they're never added to what the customer pays."
        actions={<Badge tone={current.enabled ? "green" : "neutral"}>{current.enabled ? "On" : "Off"}</Badge>}
      >
        {!current.stripeConnected ? (
          <Notice tone="info">
            Connect Stripe first, on <Link href="/operations/bank-accounts">Bank accounts</Link>. The restricted key also needs write access to payment links (and the
            prices and products they make), and read access to Checkout Sessions.
          </Notice>
        ) : null}
        {current.lastCheckAt ? (
          <p className={ui.muted}>
            Last checked {formatDateTime(current.lastCheckAt)}
            {current.lastCheckStatus === "failed" ? `: ${current.lastCheckError}` : ""}. Tohyee checks every 15 minutes.
          </p>
        ) : current.enabled ? (
          <p className={ui.muted}>Not checked yet. Tohyee checks every 15 minutes.</p>
        ) : null}
        <div className={ui.actions} style={{ justifyContent: "flex-start" }}>
          {can("admin") ? (
            <Button variant={current.enabled ? "secondary" : "primary"} disabled={busy || (!current.enabled && !current.stripeConnected)} onClick={() => toggle("stripe", !current.enabled)}>
              {current.enabled ? "Turn off" : "Turn on"}
            </Button>
          ) : null}
          {can("bookkeeper") && (current.enabled || paypal.enabled) ? (
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const result = await api<Statuses & { check: OnlinePaymentCheck | null; paypalCheck: PayPalCheck | null }>("/api/online-payments/check", {
                    method: "POST",
                    body: { organisationId },
                  });
                  setStatuses(result);
                  const failed = [result.check, result.paypalCheck].find((entry) => entry?.status === "failed");
                  const recorded = (result.check?.recorded ?? 0) + (result.paypalCheck?.recorded ?? 0);
                  setMessage(
                    failed
                      ? { tone: "error", text: failed.error ?? "The check failed." }
                      : { tone: "success", text: `${recorded} ${recorded === 1 ? "payment" : "payments"} recorded.` },
                  );
                })
              }
            >
              {busy ? "Checking…" : "Check now"}
            </Button>
          ) : null}
        </div>
      </Card>
      <Card
        title="Pay with PayPal"
        description="Tohyee makes a copy of the invoice in your own PayPal account (one line for the amount due; PayPal doesn't email the customer) and links to PayPal's page to pay it. Payments are recorded into the PayPal bank account for the invoice's currency. Only invoices in a currency whose PayPal balance is linked offer it."
        actions={<Badge tone={paypal.enabled ? "green" : "neutral"}>{paypal.enabled ? "On" : "Off"}</Badge>}
      >
        {!paypal.payPalConnected ? (
          <Notice tone="info">
            Connect PayPal first, on <Link href="/operations/bank-accounts">Bank accounts</Link>, and give its app Invoicing in PayPal&apos;s developer dashboard.
          </Notice>
        ) : null}
        {paypal.lastCheckAt ? (
          <p className={ui.muted}>
            Last checked {formatDateTime(paypal.lastCheckAt)}
            {paypal.lastCheckStatus === "failed" ? `: ${paypal.lastCheckError}` : ""}.
          </p>
        ) : null}
        {can("admin") ? (
          <div className={ui.actions} style={{ justifyContent: "flex-start" }}>
            <Button variant={paypal.enabled ? "secondary" : "primary"} disabled={busy || (!paypal.enabled && !paypal.payPalConnected)} onClick={() => toggle("paypal", !paypal.enabled)}>
              {paypal.enabled ? "Turn off" : "Turn on"}
            </Button>
          </div>
        ) : null}
      </Card>
      <GoCardlessSettingsCard organisationId={organisationId} />
      <Card title="Payments waiting for you" description="Stripe and PayPal payments Tohyee couldn't record by itself. Deal with each, then put it away.">
        {current.notices.length === 0 ? <Empty>Nothing is waiting.</Empty> : null}
        {current.notices.map((notice) => (
          <div key={notice.id} className={ui.actions} style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
            <div>
              <div>{notice.notice}</div>
              <div className={ui.muted}>
                Paid {formatDate(notice.paidDate)}
                {notice.invoiceId ? (
                  <>
                    {" "}
                    · <Link href={`/operations/invoices/${notice.invoiceId}`}>{notice.invoiceNumber ?? "the invoice"}</Link>
                  </>
                ) : null}
                {notice.waitingForLink ? " · tried again at each check" : ""}
              </div>
            </div>
            {can("bookkeeper") ? (
              <Button
                size="small"
                variant="secondary"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    const result = await api<{ payments: OnlinePaymentStatus }>(`/api/online-payments/notices/${notice.id}/dismiss`, {
                      method: "POST",
                      body: { organisationId },
                    });
                    setStatuses({ payments: result.payments, paypal });
                  })
                }
              >
                Done
              </Button>
            ) : null}
          </div>
        ))}
      </Card>
      <Card
        title="Refunds and disputes"
        description="Tohyee only ever takes money in through Stripe and PayPal. Refunds and disputes are dealt with in their own dashboards, and come into Tohyee through the bank feed (examples PN8, PN9, PPN8)."
      >
        <ol style={{ margin: 0, paddingLeft: 20, display: "grid", gap: 6 }}>
          <li>
            <strong>A refund</strong> made in Stripe or PayPal arrives as a minus line on its bank account. The invoice doesn&apos;t change by itself:
            make a credit note for the invoice, refund it from that bank account, and reconcile the minus line against that refund.
          </li>
          <li>
            <strong>A dispute (chargeback)</strong> arrives as a minus line, with Stripe&apos;s fee as its own line; the invoice stays paid.
            Whoever reconciles decides how to code it: a credit note for the invoice if the dispute is lost, for example. If it&apos;s won, the money
            coming back is a plus line.
          </li>
          <li>Tohyee doesn&apos;t watch disputes or their deadlines; keep an eye on them in Stripe or PayPal.</li>
        </ol>
      </Card>
    </>
  );
}

/** The Pay now card on an invoice (PN2, PN5, PN12, question 5). Shown only when online payments are on. */
export function InvoicePayNowCard({ organisationId, invoiceId, refreshKey }: { organisationId: string; invoiceId: string; refreshKey?: string }) {
  const { can } = useWorkspace();
  const loaded = useApiData<{ payNow: InvoicePayNow; paypal: InvoicePayPal }>(`/api/invoices/${encodeURIComponent(invoiceId)}/pay-now`, {
    organisationId,
    refreshKey: refreshKey ?? "",
  });
  const [state, setState] = useState<{ payNow: InvoicePayNow; paypal: InvoicePayPal } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<"stripe" | "paypal" | null>(null);
  const payNow = state?.payNow ?? loaded.data?.payNow ?? null;
  const paypal = state?.paypal ?? loaded.data?.paypal ?? null;
  if (!payNow || !paypal || (!payNow.available && !paypal.available && payNow.payments.length === 0)) return null;
  const copy = (provider: "stripe" | "paypal") =>
    void run(async () => {
      const result = await api<{ url: string | null; payNow: InvoicePayNow; paypal: InvoicePayPal }>(`/api/invoices/${invoiceId}/pay-now/link`, {
        method: "POST",
        body: { organisationId, provider },
      });
      setState({ payNow: result.payNow, paypal: result.paypal });
      if (result.url) {
        try {
          await navigator.clipboard.writeText(result.url);
          setCopied(provider);
        } catch {
          setCopied(null);
        }
      }
    });
  async function run(work: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card title="Pay now" description="Links for the amount due (Stripe, PayPal), in the invoice's email and PDF. What's paid through them is recorded as payments by itself.">
      {error ? <Notice tone="error">{error}</Notice> : null}
      {payNow.payments.map((payment) => (
        <Notice key={payment.id} tone={payment.status === "recorded" && !payment.notice ? "success" : "warning"}>
          {payment.status === "recorded"
            ? `Paid online with ${payment.provider === "paypal" ? "PayPal" : "Stripe"}: ${payment.currencyCode} ${formatMoney(payment.amount)} on ${formatDate(payment.paidDate)}.`
            : null}
          {payment.notice ? ` ${payment.notice}` : null}
        </Notice>
      ))}
      {([
        ["stripe", "Stripe", payNow] as const,
        ["paypal", "PayPal", paypal] as const,
      ]).map(([provider, name, entry]) =>
        entry.available ? (
          <p key={provider} style={{ overflowWrap: "anywhere" }}>
            <strong>{name}: </strong>
            {entry.link ? (
              <>
                <a href={entry.link.url} target="_blank" rel="noreferrer">
                  {entry.link.url}
                </a>{" "}
                <span className={ui.muted}>
                  for {entry.link.currencyCode} {formatMoney(entry.link.amount)}
                </span>
              </>
            ) : (
              <span className={ui.muted}>{entry.offered ? "The link is made when the invoice is emailed, printed or copied." : entry.reason}</span>
            )}
            {can("bookkeeper") && entry.offered ? (
              <>
                {" "}
                <Button size="small" variant="secondary" disabled={busy} onClick={() => copy(provider)}>
                  {copied === provider ? "Copied" : `Copy ${name} link`}
                </Button>
              </>
            ) : null}
          </p>
        ) : null,
      )}
      {can("bookkeeper") && (payNow.available || paypal.available) ? (
        <div className={ui.actions} style={{ justifyContent: "flex-start" }}>
          <label className={ui.muted} style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
            <input
              type="checkbox"
              checked={!payNow.payNow}
              disabled={busy}
              onChange={(event) =>
                void run(async () => {
                  const result = await api<{ payNow: InvoicePayNow; paypal: InvoicePayPal }>(`/api/invoices/${invoiceId}/pay-now`, {
                    method: "PUT",
                    body: { organisationId, payNow: !event.target.checked },
                  });
                  setState(result);
                })
              }
            />
            Leave Pay now off on this invoice
          </label>
        </div>
      ) : null}
    </Card>
  );
}
