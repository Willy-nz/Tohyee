"use client";

import Link from "next/link";
import { useState } from "react";
import { useConfirm } from "@/components/confirm-dialog";
import { useApiData } from "@/components/hooks";
import { Card, Field, Notice, ui } from "@/components/ui";
import type { Account } from "@/lib/accounts/service";
import { api, errorMessage } from "@/lib/client/api";
import type { SalesPlatformConnection } from "@/lib/sales-platforms/types";
import { SALES_PLATFORMS_HREF } from "@/components/navigation";

/**
 * Revenue recognition (SWS1-SWS11, decisions 1569-1571, 1573): when a
 * Shopify store's sales count as revenue. When paid suits things delivered
 * straight away (a game, a download); when fulfilled suits goods that are
 * sent, with the money held in Income in advance until Shopify marks them
 * sent. GST is counted when it's paid either way. One choice per store.
 */
export function RevenueRecognitionCard({ organisationId }: { organisationId: string }) {
  const stores = useApiData<{ connections: SalesPlatformConnection[] }>("/api/sales-platforms/connections", { organisationId });
  const shopify = (stores.data?.connections ?? []).filter((connection) => connection.platform === "shopify" && connection.status !== "disconnected");
  return (
    <Card
      title="Revenue recognition"
      description="When online store sales count as revenue. GST is counted when the order's paid either way. A change applies to orders that come in from then on."
    >
      {stores.error ? <Notice tone="error">{stores.error}</Notice> : null}
      {stores.data && shopify.length === 0 ? (
        <p className={ui.muted}>
          No Shopify store is connected. Online sales count as revenue when they&apos;re paid. <Link href={SALES_PLATFORMS_HREF}>Sales platforms</Link>
        </p>
      ) : null}
      {shopify.map((connection) => (
        <StoreRecognition key={connection.id} organisationId={organisationId} connection={connection} onChanged={stores.reload} />
      ))}
    </Card>
  );
}

function StoreRecognition({ organisationId, connection, onChanged }: { organisationId: string; connection: SalesPlatformConnection; onChanged: () => void }) {
  const confirm = useConfirm();
  const fulfilled = connection.salesWhenSentAccountCode !== null;
  const accounts = useApiData<{ accounts: Account[] }>(fulfilled ? null : "/api/accounts", { organisationId });
  const liabilities = (accounts.data?.accounts ?? []).filter((account) => account.isActive && account.accountClass === "liability" && account.accountType !== "bank");
  const named = liabilities.find((account) => /income in advance|unearned|deferred (income|revenue)/i.test(account.name));
  const [choice, setChoice] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const chosen = choice || named?.code || "__new__";
  const codes = new Set((accounts.data?.accounts ?? []).map((account) => account.code));
  let fresh = 2350;
  while (codes.has(String(fresh))) fresh += 1;
  const save = async (body: Record<string, unknown>, done: string) => {
    setBusy(true);
    setMessage(null);
    try {
      await api(`/api/sales-platforms/connections/${connection.id}`, { method: "PATCH", body: { organisationId, ...body } });
      setMessage({ tone: "success", text: done });
      onChanged();
    } catch (caught) {
      setMessage({ tone: "error", text: errorMessage(caught) });
    } finally {
      setBusy(false);
    }
  };
  const toPaid = async () => {
    if (!(await confirm("Recognise revenue when paid? Orders that come in from now count as revenue when they're paid. Orders already held still count when they're fulfilled."))) return;
    await save({ salesWhenSentAccountCode: null }, "Revenue is recognised when paid for new orders.");
  };
  const toFulfilled = () =>
    save(
      chosen === "__new__" ? { newSalesWhenSentAccount: { code: String(fresh), name: "Income in advance" } } : { salesWhenSentAccountCode: chosen },
      "Revenue is recognised when fulfilled for orders that come in from now.",
    );
  if (!connection.postToAccounts) {
    return (
      <p className={ui.muted}>
        {connection.storeName ?? connection.storeDomain}: orders aren&apos;t posted to the accounts, so there&apos;s nothing to recognise. <Link href={SALES_PLATFORMS_HREF}>Sales platforms</Link>
      </p>
    );
  }
  return (
    <div style={{ display: "grid", gap: 8 }}>
      {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
      <Field label={`${connection.storeName ?? connection.storeDomain} (Shopify)`}>
        <div style={{ display: "grid", gap: 6 }}>
          <label className={ui.checkbox}>
            <input type="radio" name={`recognise-${connection.id}`} checked={!fulfilled} disabled={busy || !fulfilled} onChange={() => void toPaid()} /> When paid
            <span className={ui.muted}> · for things delivered straight away, like a game or a download</span>
          </label>
          <label className={ui.checkbox}>
            <input type="radio" name={`recognise-${connection.id}`} checked={fulfilled} disabled={busy || fulfilled} onChange={() => void toFulfilled()} /> When fulfilled
            <span className={ui.muted}>
              {" "}
              · for goods that are sent: the money waits in {fulfilled ? connection.salesWhenSentAccountCode : "Income in advance"} until Shopify marks each line fulfilled
            </span>
          </label>
        </div>
      </Field>
      {!fulfilled ? (
        <Field label="Income in advance account (for when fulfilled)">
          <select value={chosen} onChange={(event) => setChoice(event.target.value)} disabled={busy}>
            <option value="__new__">Add {fresh} Income in advance</option>
            {liabilities.map((account) => (
              <option key={account.id} value={account.code}>
                {account.code} {account.name}
              </option>
            ))}
          </select>
        </Field>
      ) : (
        <p className={ui.muted} style={{ margin: 0 }}>
          <Link href="/operations/to-send">Sales › To send</Link> shows the orders not yet fulfilled and what&apos;s held for each.
        </p>
      )}
    </div>
  );
}
