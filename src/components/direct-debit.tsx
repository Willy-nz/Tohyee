"use client";

import { useState } from "react";
import { AccountSelect, useAccounts } from "@/components/books";
import { useApiData } from "@/components/hooks";
import { Badge, Button, Card, Field, Notice, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import Link from "next/link";
import { api, errorMessage } from "@/lib/client/api";
import { formatDate, formatDateTime, formatMoney } from "@/lib/format";
import type { ContactDirectDebit, GoCardlessCheck, GoCardlessStatus, InvoiceDirectDebit } from "@/lib/payments/gocardless";

/**
 * Direct debit with GoCardless (GC1-GC10, decision 482): the settings card,
 * the card on a contact (asking for an authority) and the card on an invoice
 * ("don't collect this one", "Try again").
 */

function useRunner() {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "error" | "warning"; text: string } | null>(null);
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
  return { busy, message, setMessage, run };
}

export function GoCardlessSettingsCard({ organisationId }: { organisationId: string }) {
  const { can } = useWorkspace();
  const loaded = useApiData<{ gocardless: GoCardlessStatus }>("/api/online-payments/gocardless", { organisationId });
  const accounts = useAccounts(organisationId);
  const [status, setStatus] = useState<GoCardlessStatus | null>(null);
  const [token, setToken] = useState("");
  const [environment, setEnvironment] = useState<"live" | "sandbox">("live");
  const [codes, setCodes] = useState<{ clearing: string; payout: string; fees: string } | null>(null);
  const { busy, message, setMessage, run } = useRunner();
  const current = status ?? loaded.data?.gocardless ?? null;
  if (loaded.error) return <Notice tone="error">{loaded.error}</Notice>;
  if (!current) return null;
  const chosen = codes ?? { clearing: current.clearingAccountCode ?? "", payout: current.payoutAccountCode ?? "", fees: current.feesAccountCode ?? "" };
  const list = accounts.data?.accounts ?? [];
  const bank = (account: { accountType: string; currencyCode: string | null }) => account.accountType === "bank";
  const save = (enabled: boolean) =>
    void run(async () => {
      const result = await api<{ gocardless: GoCardlessStatus }>("/api/online-payments/gocardless", {
        method: "PATCH",
        body: { organisationId, enabled, clearingAccountCode: chosen.clearing || null, payoutAccountCode: chosen.payout || null, feesAccountCode: chosen.fees || null },
      });
      setStatus(result.gocardless);
      setCodes(null);
      setMessage({ tone: "success", text: enabled ? "Direct debit is on." : current.enabled ? "Direct debit is off. Collections already asked for still go ahead." : "Saved." });
    });
  return (
    <Card
      title="Direct debit with GoCardless"
      description="Customers sign a direct debit authority on GoCardless's page. Then every approved NZD invoice of theirs is collected on its due date, unless you tick “Don't collect this one” on the invoice. Collected money is recorded into a clearing bank account; GoCardless's payouts move it, less its fees, to your bank account. A failed collection isn't retried by itself: it shows on the invoice and in the top bar with “Try again”."
      actions={<Badge tone={current.enabled ? "green" : "neutral"}>{current.enabled ? "On" : current.connected ? "Connected, off" : "Not connected"}</Badge>}
    >
      {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
      {!current.secretsAvailable ? <Notice tone="warning">This server has no TOHYEE_SECRET_KEY, so a GoCardless token can&apos;t be stored. The server admin needs to set it.</Notice> : null}
      {current.connected ? (
        <p className={ui.muted}>
          Connected to {current.creditorName ?? "GoCardless"}
          {current.environment === "sandbox" ? " (sandbox, for testing)" : ""}
          {current.connectedAt ? ` on ${formatDate(current.connectedAt.slice(0, 10))}` : ""}
          {current.connectedByEmail ? ` by ${current.connectedByEmail}` : ""}.{" "}
          {current.lastCheckAt
            ? `Last checked ${formatDateTime(current.lastCheckAt)}${current.lastCheckStatus === "failed" ? `: ${current.lastCheckError}` : ""}.`
            : "Not checked yet."}{" "}
          Tohyee checks every 15 minutes.
        </p>
      ) : can("admin") ? (
        <div style={{ display: "grid", gap: 12, maxWidth: 520 }}>
          <Field label="Access token" hint="From your GoCardless dashboard: Developers, Create, Access token (read-write). It's stored encrypted and never shown again.">
            <input type="password" autoComplete="off" value={token} onChange={(event) => setToken(event.target.value)} />
          </Field>
          <Field label="Account">
            <select value={environment} onChange={(event) => setEnvironment(event.target.value === "sandbox" ? "sandbox" : "live")}>
              <option value="live">Live</option>
              <option value="sandbox">Sandbox (testing)</option>
            </select>
          </Field>
          <div className={ui.actions} style={{ justifyContent: "flex-start" }}>
            <Button
              disabled={busy || !token.trim() || !current.secretsAvailable}
              onClick={() =>
                void run(async () => {
                  const result = await api<{ gocardless: GoCardlessStatus }>("/api/online-payments/gocardless", {
                    method: "POST",
                    body: { organisationId, token, environment },
                  });
                  setStatus(result.gocardless);
                  setToken("");
                  setMessage({ tone: "success", text: `Connected to ${result.gocardless.creditorName ?? "GoCardless"}. Choose the accounts below, then turn direct debit on.` });
                })
              }
            >
              {busy ? "Connecting…" : "Connect GoCardless"}
            </Button>
          </div>
        </div>
      ) : (
        <p className={ui.muted}>An admin can connect GoCardless here.</p>
      )}
      {current.connected ? (
        <>
          <div style={{ display: "grid", gap: 12, maxWidth: 520 }}>
            <Field label="Clearing account" hint="A bank account of its own (e.g. 1070 GoCardless) where collected money waits until GoCardless pays it out.">
              <AccountSelect accounts={list} filter={bank} value={chosen.clearing} onChange={(code) => setCodes({ ...chosen, clearing: code })} />
            </Field>
            <Field label="Paid out to" hint="Your bank account GoCardless's payouts arrive in.">
              <AccountSelect accounts={list} filter={bank} value={chosen.payout} onChange={(code) => setCodes({ ...chosen, payout: code })} />
            </Field>
            <Field label="Fees" hint="GoCardless's fees are posted here, without GST (it isn't known yet whether their NZ fees include GST).">
              <AccountSelect accounts={list} filter={(account) => account.accountClass === "expense"} value={chosen.fees} onChange={(code) => setCodes({ ...chosen, fees: code })} />
            </Field>
          </div>
          <div className={ui.actions} style={{ justifyContent: "flex-start" }}>
            {can("admin") ? (
              <>
                <Button variant={current.enabled ? "secondary" : "primary"} disabled={busy} onClick={() => save(!current.enabled)}>
                  {current.enabled ? "Turn off" : "Turn on"}
                </Button>
                {codes ? (
                  <Button variant="secondary" disabled={busy} onClick={() => save(current.enabled)}>
                    Save accounts
                  </Button>
                ) : null}
              </>
            ) : null}
            {can("bookkeeper") ? (
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    const result = await api<{ check: GoCardlessCheck; gocardless: GoCardlessStatus }>("/api/online-payments/gocardless/check", {
                      method: "POST",
                      body: { organisationId },
                    });
                    setStatus(result.gocardless);
                    const check = result.check;
                    setMessage(
                      check.error
                        ? { tone: "error", text: check.error }
                        : {
                            tone: "success",
                            text: `${check.collected} asked for, ${check.recorded} recorded, ${check.failed} failed, ${check.payouts} ${check.payouts === 1 ? "payout" : "payouts"} posted.`,
                          },
                    );
                  })
                }
              >
                {busy ? "Checking…" : "Check now"}
              </Button>
            ) : null}
            {can("admin") ? (
              <Button
                variant="danger"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    const result = await api<{ gocardless: GoCardlessStatus }>(
                      `/api/online-payments/gocardless?organisationId=${encodeURIComponent(organisationId)}`,
                      { method: "DELETE" },
                    );
                    setStatus(result.gocardless);
                    setMessage({ tone: "success", text: "GoCardless is disconnected. Authorities stay in GoCardless." });
                  })
                }
              >
                Disconnect
              </Button>
            ) : null}
          </div>
        </>
      ) : null}
      {current.failed.length ? (
        <Notice tone="warning">
          <strong>Failed direct debits:</strong>
          <ul style={{ margin: "4px 0 0", paddingLeft: 20 }}>
            {current.failed.map((entry) => (
              <li key={entry.invoiceId}>
                <Link href={`/operations/invoices/${entry.invoiceId}`}>{entry.invoiceNumber ?? "Invoice"}</Link> · {entry.contactName} · {formatMoney(entry.amount)}
                {entry.reason ? ` · ${entry.reason}` : ""}
              </li>
            ))}
          </ul>
        </Notice>
      ) : null}
    </Card>
  );
}

const AUTHORITY_LABEL: Record<"pending" | "active" | "ended", string> = { pending: "Waiting for the customer", active: "Active", ended: "Ended" };

/** GC2, GC7: the direct debit card on a contact. Hidden when GoCardless isn't connected and there's no history. */
export function ContactDirectDebitCard({ organisationId, contactId }: { organisationId: string; contactId: string }) {
  const { can } = useWorkspace();
  const loaded = useApiData<{ directDebit: ContactDirectDebit }>(`/api/contacts/${encodeURIComponent(contactId)}/direct-debit`, { organisationId });
  const [state, setState] = useState<ContactDirectDebit | null>(null);
  const [copied, setCopied] = useState(false);
  const { busy, message, run } = useRunner();
  const current = state ?? loaded.data?.directDebit ?? null;
  if (!current || (!current.available && !current.current)) return null;
  const authority = current.current;
  return (
    <Card
      title="Direct debit"
      description="With an active authority, every approved invoice for this customer is collected by GoCardless on its due date."
      actions={authority ? <Badge tone={authority.status === "active" ? "green" : authority.status === "ended" ? "neutral" : "amber"}>{AUTHORITY_LABEL[authority.status]}</Badge> : undefined}
    >
      {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
      {current.reason ? <p className={ui.muted}>{current.reason}</p> : null}
      {authority?.status === "pending" && authority.url ? (
        <p style={{ overflowWrap: "anywhere" }}>
          Send the customer this link to sign the authority on GoCardless&apos;s page
          {authority.urlExpiresAt ? ` (it works until ${formatDate(authority.urlExpiresAt.slice(0, 10))})` : ""}:{" "}
          <a href={authority.url} target="_blank" rel="noreferrer">
            {authority.url}
          </a>{" "}
          <Button
            size="small"
            variant="secondary"
            onClick={() =>
              void navigator.clipboard.writeText(authority.url ?? "").then(
                () => setCopied(true),
                () => setCopied(false),
              )
            }
          >
            {copied ? "Copied" : "Copy link"}
          </Button>
        </p>
      ) : null}
      {authority?.status === "ended" && authority.endedReason ? <p className={ui.muted}>{authority.endedReason}</p> : null}
      {can("bookkeeper") && current.canStart ? (
        <div className={ui.actions} style={{ justifyContent: "flex-start" }}>
          <Button
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const result = await api<{ directDebit: ContactDirectDebit }>(`/api/contacts/${encodeURIComponent(contactId)}/direct-debit`, {
                  method: "POST",
                  body: { organisationId },
                });
                setState(result.directDebit);
              })
            }
          >
            {busy ? "Asking GoCardless…" : "Get a link to set up direct debit"}
          </Button>
        </div>
      ) : null}
    </Card>
  );
}

const COLLECTION_LABEL: Record<InvoiceDirectDebit["collections"][number]["status"], string> = {
  scheduled: "Collecting",
  confirmed: "Collected",
  failed: "Failed",
  cancelled: "Cancelled",
};

/** GC3-GC9: the direct debit card on an invoice. Hidden when the customer has no active authority and nothing was collected. */
export function InvoiceDirectDebitCard({ organisationId, invoiceId, refreshKey }: { organisationId: string; invoiceId: string; refreshKey?: string }) {
  const { can } = useWorkspace();
  const loaded = useApiData<{ directDebit: InvoiceDirectDebit }>(`/api/invoices/${encodeURIComponent(invoiceId)}/direct-debit`, {
    organisationId,
    refreshKey: refreshKey ?? "",
  });
  const [state, setState] = useState<InvoiceDirectDebit | null>(null);
  const { busy, message, run } = useRunner();
  const current = state ?? loaded.data?.directDebit ?? null;
  if (!current || (!current.available && current.collections.length === 0)) return null;
  return (
    <Card title="Direct debit" description="GoCardless collects the amount due on the due date, from the customer's direct debit authority.">
      {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
      {current.collections.map((collection, index) => (
        <Notice key={index} tone={collection.status === "failed" ? "error" : collection.status === "confirmed" && !collection.notice ? "success" : collection.notice ? "warning" : "info"}>
          {COLLECTION_LABEL[collection.status]} {formatMoney(collection.amount)}
          {collection.chargeDate ? ` on ${formatDate(collection.chargeDate)}` : ""}.
          {collection.failureReason ? ` ${collection.failureReason}` : ""}
          {collection.notice ? ` ${collection.notice}` : ""}
          {collection.retries ? ` Tried again ${collection.retries} ${collection.retries === 1 ? "time" : "times"}.` : ""}
        </Notice>
      ))}
      {can("bookkeeper") ? (
        <div className={ui.actions} style={{ justifyContent: "flex-start" }}>
          {current.canRetry ? (
            <Button
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const result = await api<{ directDebit: InvoiceDirectDebit }>(`/api/invoices/${encodeURIComponent(invoiceId)}/direct-debit`, {
                    method: "POST",
                    body: { organisationId },
                  });
                  setState(result.directDebit);
                })
              }
            >
              Try again
            </Button>
          ) : null}
          {current.available || current.skipped ? (
            <label className={ui.muted} style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
              <input
                type="checkbox"
                checked={current.skipped}
                disabled={busy}
                onChange={(event) =>
                  void run(async () => {
                    const result = await api<{ directDebit: InvoiceDirectDebit }>(`/api/invoices/${encodeURIComponent(invoiceId)}/direct-debit`, {
                      method: "PUT",
                      body: { organisationId, skip: event.target.checked },
                    });
                    setState(result.directDebit);
                  })
                }
              />
              Don&apos;t collect this one by direct debit
            </label>
          ) : null}
        </div>
      ) : null}
    </Card>
  );
}
