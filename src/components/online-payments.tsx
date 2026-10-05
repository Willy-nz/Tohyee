"use client";

import Link from "next/link";
import { useState } from "react";
import { useApiData } from "@/components/hooks";
import { Badge, Button, Card, Empty, Notice, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { api, errorMessage } from "@/lib/client/api";
import { formatDate, formatDateTime, formatMoney } from "@/lib/format";
import type { InvoicePayNow, OnlinePaymentCheck, OnlinePaymentStatus } from "@/lib/payments/stripe";

/**
 * Online invoice payments with Stripe (PN1-PN12): the settings page (turn
 * Pay now on or off, Check now, payments waiting for a person) and the Pay
 * now card on an invoice.
 */

export function OnlinePaymentsSettings({ organisationId }: { organisationId: string }) {
  const { can } = useWorkspace();
  const loaded = useApiData<{ payments: OnlinePaymentStatus }>("/api/online-payments", { organisationId });
  const [status, setStatus] = useState<OnlinePaymentStatus | null>(null);
  const [message, setMessage] = useState<{ tone: "success" | "error" | "warning"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const current = status ?? loaded.data?.payments ?? null;
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
  if (!current) return <p className={ui.muted}>Loading…</p>;
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
            <Button
              variant={current.enabled ? "secondary" : "primary"}
              disabled={busy || (!current.enabled && !current.stripeConnected)}
              onClick={() =>
                void run(async () => {
                  const result = await api<{ payments: OnlinePaymentStatus; linksNotSwitchedOff: string[] }>("/api/online-payments", {
                    method: "PUT",
                    body: { organisationId, enabled: !current.enabled },
                  });
                  setStatus(result.payments);
                  setMessage(
                    result.linksNotSwitchedOff.length
                      ? { tone: "warning", text: `Turned off. Stripe couldn't be reached to switch off: ${result.linksNotSwitchedOff.join(", ")}. Switch them off in Stripe's dashboard.` }
                      : { tone: "success", text: result.payments.enabled ? "Pay now is on." : "Pay now is off. Open links were switched off." },
                  );
                })
              }
            >
              {current.enabled ? "Turn off" : "Turn on"}
            </Button>
          ) : null}
          {can("bookkeeper") && current.enabled ? (
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const result = await api<{ check: OnlinePaymentCheck; payments: OnlinePaymentStatus }>("/api/online-payments/check", {
                    method: "POST",
                    body: { organisationId },
                  });
                  setStatus(result.payments);
                  setMessage(
                    result.check.status === "failed"
                      ? { tone: "error", text: result.check.error ?? "The check failed." }
                      : { tone: "success", text: `${result.check.recorded} ${result.check.recorded === 1 ? "payment" : "payments"} recorded.` },
                  );
                })
              }
            >
              {busy ? "Checking…" : "Check now"}
            </Button>
          ) : null}
        </div>
      </Card>
      <Card title="Payments waiting for you" description="Stripe payments Tohyee couldn't record by itself. Deal with each, then put it away.">
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
                    setStatus(result.payments);
                  })
                }
              >
                Done
              </Button>
            ) : null}
          </div>
        ))}
      </Card>
    </>
  );
}

/** The Pay now card on an invoice (PN2, PN5, PN12, question 5). Shown only when online payments are on. */
export function InvoicePayNowCard({ organisationId, invoiceId, refreshKey }: { organisationId: string; invoiceId: string; refreshKey?: string }) {
  const { can } = useWorkspace();
  const loaded = useApiData<{ payNow: InvoicePayNow }>(`/api/invoices/${encodeURIComponent(invoiceId)}/pay-now`, { organisationId, refreshKey: refreshKey ?? "" });
  const [state, setState] = useState<InvoicePayNow | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const payNow = state ?? loaded.data?.payNow ?? null;
  if (!payNow || (!payNow.available && payNow.payments.length === 0)) return null;
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
    <Card title="Pay now" description="A Stripe payment link for the amount due, in the invoice's email and PDF. Paid links are recorded as payments by themselves.">
      {error ? <Notice tone="error">{error}</Notice> : null}
      {payNow.payments.map((payment) => (
        <Notice key={payment.id} tone={payment.status === "recorded" && !payment.notice ? "success" : "warning"}>
          {payment.status === "recorded" ? `Paid online with Stripe: ${payment.currencyCode} ${formatMoney(payment.amount)} on ${formatDate(payment.paidDate)}.` : null}
          {payment.notice ? ` ${payment.notice}` : null}
        </Notice>
      ))}
      {payNow.link ? (
        <p style={{ overflowWrap: "anywhere" }}>
          <a href={payNow.link.url} target="_blank" rel="noreferrer">
            {payNow.link.url}
          </a>{" "}
          <span className={ui.muted}>
            for {payNow.link.currencyCode} {formatMoney(payNow.link.amount)}
          </span>
        </p>
      ) : payNow.offered ? (
        <p className={ui.muted}>The link is made when the invoice is emailed, printed or copied.</p>
      ) : payNow.reason ? (
        <p className={ui.muted}>{payNow.reason}</p>
      ) : null}
      {can("bookkeeper") && payNow.available ? (
        <div className={ui.actions} style={{ justifyContent: "flex-start" }}>
          {payNow.offered ? (
            <Button
              size="small"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const result = await api<{ url: string | null; payNow: InvoicePayNow }>(`/api/invoices/${invoiceId}/pay-now/link`, {
                    method: "POST",
                    body: { organisationId },
                  });
                  setState(result.payNow);
                  if (result.url) {
                    try {
                      await navigator.clipboard.writeText(result.url);
                      setCopied(true);
                    } catch {
                      setCopied(false);
                    }
                  }
                })
              }
            >
              {copied ? "Copied" : "Copy payment link"}
            </Button>
          ) : null}
          <label className={ui.muted} style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
            <input
              type="checkbox"
              checked={!payNow.payNow}
              disabled={busy}
              onChange={(event) =>
                void run(async () => {
                  const result = await api<{ payNow: InvoicePayNow }>(`/api/invoices/${invoiceId}/pay-now`, {
                    method: "PUT",
                    body: { organisationId, payNow: !event.target.checked },
                  });
                  setState(result.payNow);
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
