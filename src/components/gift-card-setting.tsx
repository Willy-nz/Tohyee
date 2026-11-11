"use client";

import { useState } from "react";
import { useConfirm } from "@/components/confirm-dialog";
import { useApiData } from "@/components/hooks";
import { Button, Field, Notice, ui } from "@/components/ui";
import type { Account } from "@/lib/accounts/service";
import { api, errorMessage } from "@/lib/client/api";
import type { SalesPlatformConnection } from "@/lib/sales-platforms/types";

/**
 * Shopify gift cards (GC1-GC5, decision 1590): sold into a liability with no
 * GST, and taken out of it when they're spent. Without an account, orders
 * that sell or are paid with a gift card are refused, as before.
 */
export function GiftCardSetting({
  organisationId,
  connection,
  isAdmin,
  onChanged,
}: {
  organisationId: string;
  connection: SalesPlatformConnection;
  isAdmin: boolean;
  onChanged: () => void;
}) {
  const confirm = useConfirm();
  const on = connection.giftCardAccountCode !== null;
  const [open, setOpen] = useState(false);
  const accounts = useApiData<{ accounts: Account[] }>(open && !on ? "/api/accounts" : null, { organisationId });
  const liabilities = (accounts.data?.accounts ?? []).filter(
    (account) => account.isActive && account.accountClass === "liability" && account.accountType !== "bank" && account.code !== connection.salesWhenSentAccountCode,
  );
  const named = liabilities.find((account) => /gift (card|voucher)/i.test(account.name));
  const [choice, setChoice] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const chosen = choice || named?.code || "__new__";
  const codes = new Set((accounts.data?.accounts ?? []).map((account) => account.code));
  let fresh = 2360;
  while (codes.has(String(fresh))) fresh += 1;

  async function save(body: Record<string, unknown>, done: string) {
    setBusy(true);
    setMessage(null);
    try {
      await api(`/api/sales-platforms/connections/${connection.id}`, { method: "PATCH", body: { organisationId, ...body } });
      setMessage({ tone: "success", text: done });
      setOpen(false);
      onChanged();
    } catch (caught) {
      setMessage({ tone: "error", text: errorMessage(caught) });
    } finally {
      setBusy(false);
    }
  }
  const turnOn = () =>
    save(
      chosen === "__new__" ? { newGiftCardAccount: { code: String(fresh), name: "Gift cards" } } : { giftCardAccountCode: chosen },
      "Saved: gift cards sold are held until they're spent. Orders refused for a gift card are tried again at the next sync.",
    );
  const turnOff = async () => {
    if (!(await confirm("Stop bringing in gift cards? What's already posted stays. New orders that sell or are paid with a gift card will be refused."))) return;
    await save({ giftCardAccountCode: null }, "Saved: orders with gift cards are refused.");
  };

  return (
    <div style={{ display: "grid", gap: 6 }}>
      {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
      <span className={ui.muted}>
        Gift cards:{" "}
        {on
          ? `sold into ${connection.giftCardAccountCode} with no GST, and taken out of it when they're spent (the things bought carry the GST).`
          : "not set up, so orders that sell or are paid with a Shopify gift card are refused."}{" "}
        {isAdmin ? (
          on ? (
            <Button variant="secondary" disabled={busy} onClick={() => void turnOff()}>
              Stop
            </Button>
          ) : (
            <Button variant="secondary" disabled={busy} onClick={() => setOpen(!open)}>
              Set up
            </Button>
          )
        ) : null}
      </span>
      {open && !on ? (
        <div className={ui.actions} style={{ alignItems: "end" }}>
          <Field label="Hold gift cards sold in">
            <select value={chosen} onChange={(event) => setChoice(event.target.value)} disabled={busy}>
              <option value="__new__">Add {fresh} Gift cards (a current liability)</option>
              {liabilities.map((account) => (
                <option key={account.id} value={account.code}>
                  {account.code} {account.name}
                </option>
              ))}
            </select>
          </Field>
          <Button disabled={busy || !accounts.data} onClick={() => void turnOn()}>
            Save
          </Button>
        </div>
      ) : null}
    </div>
  );
}
