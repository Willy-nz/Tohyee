"use client";

import { useState } from "react";
import { InfoTip } from "@/components/info-tip";
import { useApiData } from "@/components/hooks";
import { Badge, Button, Card, Empty, Notice, ui } from "@/components/ui";
import { formatDateTime } from "@/lib/format";
import type { StockDifference, StockView } from "@/lib/sales-platforms/extras-store";
import { SHOPIFY_PARTS, SHOPIFY_SCOPES_LINE, shopifyPartStates } from "@/lib/sales-platforms/parts";

/**
 * Settings › Sales platforms, Shopify's parts (decisions 1237-1245): the
 * scopes to paste into Shopify's Dev Dashboard, which parts a store has on,
 * and Shopify's stock beside Tohyee's. Read only.
 */

/** Every scope Tohyee can use, in one line to copy, and what each part needs. */
export function ShopifyScopesCard() {
  const [copied, setCopied] = useState<"yes" | "no" | null>(null);
  async function copy() {
    try {
      await navigator.clipboard.writeText(SHOPIFY_SCOPES_LINE);
      setCopied("yes");
    } catch {
      setCopied("no");
    }
  }
  return (
    <Card
      title="Shopify access scopes"
      description={<>Paste this line into your app&apos;s Scopes in Shopify&apos;s Dev Dashboard. All are read only.{" "}
        <InfoTip label="After changing scopes">Release a new version of the app and install it on the store again, then press Test connection here. A part is on once the store has given every scope it needs; leave a scope out and Tohyee skips that part and says so in the sync log.</InfoTip></>}
    >
      <div style={{ display: "grid", gap: 8 }}>
        <label className={ui.muted} htmlFor="shopify-scopes-line">Scopes</label>
        <div className={ui.actions} style={{ alignItems: "stretch", flexWrap: "wrap" }}>
          <textarea
            id="shopify-scopes-line"
            readOnly
            rows={4}
            value={SHOPIFY_SCOPES_LINE}
            onFocus={(event) => event.currentTarget.select()}
            style={{ flex: "1 1 260px", minWidth: 0, resize: "vertical", wordBreak: "break-all", fontFamily: "var(--font-mono, monospace)", fontSize: "0.85rem" }}
          />
          <Button variant="secondary" onClick={() => void copy()}>
            {copied === "yes" ? "Copied" : "Copy"}
          </Button>
        </div>
        {copied === "no" ? <p className={ui.muted} role="status">Couldn&apos;t copy. Select the line and copy it yourself.</p> : null}
        {copied === "yes" ? <p className={ui.muted} role="status">Copied to the clipboard.</p> : null}
        <h3 style={{ margin: "8px 0 0", fontSize: "1rem" }}>What each part needs</h3>
        <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "grid", gap: 6 }}>
          {SHOPIFY_PARTS.map((part) => (
            <li key={part.key} style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "4px 8px", paddingBottom: 6, borderBottom: "1px solid var(--border)" }}>
              <span style={{ minWidth: 200 }}>
                {part.label}{" "}
                <InfoTip label={part.label}>
                  {part.brings}
                  {part.needsApproval ? ` ${part.needsApproval}` : ""}
                </InfoTip>
              </span>
              <span style={{ overflowWrap: "anywhere", minWidth: 0 }}>
                <code>{part.scopes.join(", ")}</code>
                {part.optionalScopes?.length ? (
                  <>
                    {" "}
                    <span className={ui.muted}>(and optionally <code>{part.optionalScopes.join(", ")}</code>)</span>
                  </>
                ) : null}
                {part.needsApproval ? <> <Badge tone="amber">Shopify approval</Badge></> : null}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </Card>
  );
}

/** Which parts are on for this store, from the scopes it gave the app. */
export function ShopifyPartsList({ grantedScopes }: { grantedScopes: string[] }) {
  const states = shopifyPartStates(grantedScopes);
  return (
    <div>
      <h3 style={{ margin: "0 0 6px", fontSize: "1rem" }}>
        What comes in{" "}
        <InfoTip label="What comes in">From the scopes the store gave the app when it was last tested. To turn a part on, add its scopes in Shopify, then press Test connection.</InfoTip>
      </h3>
      <ul style={{ display: "flex", flexWrap: "wrap", gap: 6, margin: 0, padding: 0, listStyle: "none" }} aria-label="Shopify parts">
        {states.map((state) => (
          <li key={state.key}>
            <Badge tone={state.on ? "green" : "neutral"}>
              {state.label}: {state.on ? "on" : "off"}
            </Badge>
            {!state.on ? <span className={ui.muted}> needs {state.missing.join(", ")}</span> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

const quantity = (value: string | null) => (value === null ? "—" : value);

function differenceBadge(row: StockDifference) {
  if (!row.itemCode) return <Badge tone="neutral">No matching item</Badge>;
  if (row.difference === null) return <Badge tone="neutral">Tohyee doesn&apos;t count its stock</Badge>;
  if (row.difference === "0") return <Badge tone="green">Same</Badge>;
  const more = !row.difference.startsWith("-");
  return <Badge tone="amber">{more ? `Shopify has ${row.difference} more` : `Shopify has ${row.difference.slice(1)} fewer`}</Badge>;
}

/** Shopify's stock beside Tohyee's for matched items (SPD2). Never changes either. */
export function StockDifferences({ organisationId, connectionId }: { organisationId: string; connectionId: string }) {
  const [onlyDifferent, setOnlyDifferent] = useState(true);
  const { data, error, loading } = useApiData<StockView & { stockPartOn: boolean }>(`/api/sales-platforms/connections/${connectionId}/stock`, { organisationId });
  if (error) return <Notice tone="error">{error}</Notice>;
  if (loading || !data) return <p className={ui.muted}>Loading stock…</p>;
  if (!data.stockPartOn && data.rows.length === 0) {
    return <p className={ui.muted}>Stock levels are off for this store: it needs read_inventory and read_locations.</p>;
  }
  if (data.rows.length === 0) return <Empty>Shopify&apos;s stock hasn&apos;t been read yet. It&apos;s read at the next sync.</Empty>;
  const different = data.rows.filter((row) => row.difference !== null && row.difference !== "0");
  const shown = onlyDifferent ? different : data.rows;
  return (
    <div style={{ display: "grid", gap: 8 }}>
      <p className={ui.muted} style={{ margin: 0 }}>
        {different.length === 0 ? "Shopify and Tohyee agree for every matched stock item." : `${different.length} of ${data.rows.length} differ.`}{" "}
        {data.syncedAt ? `Shopify read ${formatDateTime(data.syncedAt)}.` : null}{" "}
        <InfoTip label="How stock is compared">On hand in Shopify (all its locations) against on hand in Tohyee (all its locations). Items are matched by the link from the product sync, else by SKU and item code. Tohyee&apos;s stock is the book of record: nothing here changes it, or Shopify&apos;s.</InfoTip>
      </p>
      <label className={ui.checkbox}>
        <input type="checkbox" checked={onlyDifferent} onChange={(event) => setOnlyDifferent(event.target.checked)} /> Only items that differ
      </label>
      {shown.length === 0 ? (
        <Empty>Nothing differs.</Empty>
      ) : (
        <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "grid", gap: 0 }} aria-label="Stock by item">
          {shown.map((row) => (
            <li key={row.variantId} style={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", gap: "6px 16px", padding: "8px 0", borderBottom: "1px solid var(--border)" }}>
              <div style={{ minWidth: 0, flex: "1 1 240px" }}>
                {row.itemCode ? <strong>{row.itemCode}</strong> : null} {row.itemName ?? row.shopifyName}
                <div className={ui.muted}>
                  {row.sku ? `SKU ${row.sku}` : "No SKU"}
                  {row.locations.length > 1 ? ` · ${row.locations.map((l) => `${l.name} ${l.onHand}`).join(", ")}` : row.locations[0] ? ` · ${row.locations[0].name}` : ""}
                </div>
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "4px 16px" }}>
                <span>
                  Shopify <strong>{row.shopifyOnHand}</strong> <span className={ui.muted}>({row.shopifyAvailable} available)</span>
                </span>
                <span>
                  Tohyee <strong>{quantity(row.tohyeeOnHand)}</strong>
                </span>
                {differenceBadge(row)}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The stock comparison, behind a button so the connection card stays short. */
export function StockSection({ organisationId, connectionId }: { organisationId: string; connectionId: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ display: "grid", gap: 8 }}>
      <h3 style={{ margin: 0, fontSize: "1rem" }}>Stock: Shopify and Tohyee</h3>
      {open ? (
        <StockDifferences organisationId={organisationId} connectionId={connectionId} />
      ) : (
        <div>
          <Button variant="secondary" size="small" onClick={() => setOpen(true)}>
            Compare stock
          </Button>
        </div>
      )}
    </div>
  );
}
