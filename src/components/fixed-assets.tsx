"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { AccountSelect, Money, useAccounts } from "@/components/books";
import { useApiData } from "@/components/hooks";
import { RdAssetPanel } from "@/components/rd";
import { RecordExtrasPanel } from "@/components/records/record-extras";
import { PrintButton } from "@/components/reports/ledger-reports";
import { TrackingSelects, TrackingTagsText, useTracking } from "@/components/tracking";
import { Badge, Button, Card, Empty, Field, Notice, Stat, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import type { Account } from "@/lib/accounts/service";
import { api, errorMessage, newIdempotencyKey } from "@/lib/client/api";
import { addMonths, DEPRECIATION_METHOD_LABELS, type DepreciationMethod, isMonthEnd, monthEnd, monthOf } from "@/lib/fixed-assets/depreciation";
import type { FixedAssetRegister } from "@/lib/fixed-assets/register";
import type { DepreciationRun, DisposalPreview, JournalPreviewLine, RunPreview } from "@/lib/fixed-assets/runs";
import type { AssetBillLine, FixedAsset, FixedAssetSettings, FixedAssetStatus, FixedAssetSummary, FixedAssetType } from "@/lib/fixed-assets/service";
import { formatDate, formatDateTime, todayInBrowser, personName } from "@/lib/format";
import { add, dec, toFixedString } from "@/lib/money/decimal";
import type { TrackingTags } from "@/lib/tracking/service";
import { useConfirm } from "@/components/confirm-dialog";

/**
 * Accounting › Fixed assets (examples FA1-FA14): the register, asset types,
 * depreciation runs and disposals. Registering an asset posts nothing; runs
 * and disposals post journals and can be rolled back or undone.
 */

const STATUS_BADGES: Record<FixedAssetStatus, { label: string; tone: "green" | "neutral" | "red" }> = {
  registered: { label: "Registered", tone: "green" },
  disposed: { label: "Disposed", tone: "neutral" },
  archived: { label: "Archived", tone: "red" },
};

function methodText(method: DepreciationMethod, rate: string | null): string {
  return method === "none" ? DEPRECIATION_METHOD_LABELS.none : `${DEPRECIATION_METHOD_LABELS[method]} ${rate}%`;
}

/** The last month end on or before today. */
function lastMonthEnd(): string {
  const today = todayInBrowser();
  return isMonthEnd(today) ? today : monthEnd(addMonths(monthOf(today), -1));
}

function JournalLines({ lines }: { lines: JournalPreviewLine[] }) {
  if (lines.length === 0) return <p className={ui.muted}>Nothing to post.</p>;
  return (
    <div className={ui.tableWrap}>
      <table className={`${ui.table} ${ui.stackOnPhone}`}>
        <thead>
          <tr>
            <th>Account</th>
            <th>Description</th>
            <th className={ui.num}>Debit</th>
            <th className={ui.num}>Credit</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((line, index) => (
            <tr key={index}>
              <td data-label="Account">{line.accountCode}</td>
              <td data-label="Description">{line.description}</td>
              <td data-label="Debit" className={ui.num}>
                <Money value={line.debitAmount} blankZero />
              </td>
              <td data-label="Credit" className={ui.num}>
                <Money value={line.creditAmount} blankZero />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const LIST_TABS: Array<{ status: string; label: string; empty: string }> = [
  { status: "registered", label: "Registered", empty: "No assets registered yet." },
  { status: "disposed", label: "Disposed", empty: "No assets have been disposed of." },
  { status: "archived", label: "Archived", empty: "No archived assets." },
];

export function FixedAssetList({ organisationId }: { organisationId: string }) {
  const { can } = useWorkspace();
  const router = useRouter();
  const [tab, setTab] = useState(LIST_TABS[0]);
  const list = useApiData<{ assets: FixedAssetSummary[] }>("/api/fixed-assets", { organisationId, status: tab.status });
  return (
    <Card
      title="Fixed assets"
      description="Registering an asset records its cost (already in the ledger from its bill or journal); depreciation runs and disposals post."
      actions={
        <>
          {can("bookkeeper") ? <Button onClick={() => router.push("/operations/fixed-assets/new")}>New asset</Button> : null}
          <Button variant="secondary" onClick={() => router.push("/operations/fixed-assets/depreciation")}>
            Depreciation
          </Button>
          <Button variant="secondary" onClick={() => router.push("/operations/fixed-assets/register")}>
            Register report
          </Button>
          <Button variant="secondary" onClick={() => router.push("/operations/fixed-assets/types")}>
            Asset types
          </Button>
        </>
      }
    >
      <div className={ui.tabs} role="tablist" aria-label="Fixed assets">
        {LIST_TABS.map((entry) => (
          <button
            key={entry.status}
            type="button"
            role="tab"
            aria-selected={tab === entry}
            className={`${ui.tab} ${tab === entry ? ui.tabActive : ""}`}
            onClick={() => setTab(entry)}
          >
            {entry.label}
          </button>
        ))}
      </div>
      {list.error ? <Notice tone="error">{list.error}</Notice> : null}
      {!list.data && !list.error ? <p className={ui.muted}>Loading…</p> : null}
      {list.data && list.data.assets.length === 0 ? <Empty>{tab.empty}</Empty> : null}
      {list.data && list.data.assets.length > 0 ? (
        <div className={ui.tableWrap}>
          <table className={`${ui.table} ${ui.stackOnPhone}`}>
            <thead>
              <tr>
                <th>Asset</th>
                <th>Type</th>
                <th>Bought</th>
                <th>Method</th>
                <th className={ui.num}>Cost</th>
                <th className={ui.num}>Accumulated depreciation</th>
                <th className={ui.num}>Book value</th>
              </tr>
            </thead>
            <tbody>
              {list.data.assets.map((asset) => (
                <tr key={asset.id}>
                  <td data-label="Asset">
                    <Link href={`/operations/fixed-assets/${asset.id}`}>{asset.assetNumber}</Link> {asset.name}
                  </td>
                  <td data-label="Type">{asset.typeName}</td>
                  <td data-label="Bought">{formatDate(asset.purchaseDate)}</td>
                  <td data-label="Method">{methodText(asset.method, asset.rate)}</td>
                  <td data-label="Cost" className={ui.num}>
                    <Money value={asset.cost} />
                  </td>
                  <td data-label="Accumulated depreciation" className={ui.num}>
                    <Money value={asset.accumulatedDepreciation} />
                  </td>
                  <td data-label="Book value" className={ui.num}>
                    <Money value={asset.bookValue} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </Card>
  );
}

type AssetDraft = {
  name: string;
  description: string;
  typeId: string;
  billLineId: string;
  purchaseDate: string;
  cost: string;
  method: "" | DepreciationMethod;
  rate: string;
  residualValue: string;
  openingDate: string;
  openingAccumulatedDepreciation: string;
  tracking: TrackingTags;
};

/** Register or change an asset (FA2, FA14). With a bill line, the cost and date come from it unless typed. */
export function FixedAssetForm({
  organisationId,
  asset,
  onSaved,
  onCancel,
}: {
  organisationId: string;
  asset?: FixedAsset;
  onSaved: (asset: FixedAsset) => void;
  onCancel: () => void;
}) {
  const { can } = useWorkspace();
  const types = useApiData<{ types: FixedAssetType[] }>("/api/fixed-asset-types", { organisationId });
  const billLines = useApiData<{ lines: AssetBillLine[] }>(asset ? null : "/api/fixed-asset-bill-lines", { organisationId });
  const tracking = useTracking(organisationId);
  const [draft, setDraft] = useState<AssetDraft>(() => ({
    name: asset?.name ?? "",
    description: asset?.description ?? "",
    typeId: asset?.typeId ?? "",
    billLineId: asset?.billLineId ?? "",
    purchaseDate: asset?.purchaseDate ?? "",
    cost: asset?.cost ?? "",
    method: asset?.method ?? "",
    rate: asset?.rate ?? "",
    residualValue: asset && asset.residualValue !== "0.00" ? asset.residualValue : "",
    openingDate: asset?.openingDate ?? "",
    openingAccumulatedDepreciation: asset && asset.openingAccumulatedDepreciation !== "0.00" ? asset.openingAccumulatedDepreciation : "",
    tracking: asset?.tracking ?? {},
  }));
  const [createKey] = useState(() => newIdempotencyKey("asset"));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!types.data) return types.error ? <Notice tone="error">{types.error}</Notice> : <p className={ui.muted}>Loading…</p>;
  // A new organisation has no asset types, and an asset can't be registered without one: say so
  // plainly, with the way there, rather than a form that can't be saved.
  if (!asset && types.data.types.length === 0) {
    return (
      <div style={{ display: "grid", gap: 12 }}>
        <Notice tone="warning">
          Add an asset type first. Every asset belongs to a type (for example &ldquo;Computer equipment&rdquo;), which says which accounts it uses and how it&apos;s
          depreciated. This organisation doesn&apos;t have any yet.
          {can("admin") ? null : " An admin of this organisation needs to add them."}
        </Notice>
        <div className={ui.rowButtons}>
          {can("admin") ? (
            <Link className={`${ui.button} ${ui.primary}`} href="/operations/fixed-assets/types">
              Add an asset type
            </Link>
          ) : null}
          <Button variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </div>
    );
  }
  const set = (change: Partial<AssetDraft>) => setDraft({ ...draft, ...change });
  const locked = asset?.hasHistory ?? false;
  const type = types.data.types.find((entry) => entry.id === draft.typeId);
  const lines = (billLines.data?.lines ?? []).filter((line) => !type || line.accountCode === type.assetAccountCode);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const body: Record<string, unknown> = {
      organisationId,
      name: draft.name,
      description: draft.description.trim() || null,
      tracking: draft.tracking,
    };
    if (!locked) {
      Object.assign(body, {
        typeId: draft.typeId,
        billLineId: draft.billLineId || null,
        purchaseDate: draft.purchaseDate || null,
        cost: draft.cost || null,
        method: draft.method || null,
        rate: draft.method && draft.method !== "none" ? draft.rate : null,
        residualValue: draft.residualValue || null,
        openingDate: draft.openingDate || null,
        openingAccumulatedDepreciation: draft.openingAccumulatedDepreciation || null,
      });
    }
    try {
      const result = asset
        ? await api<{ asset: FixedAsset }>(`/api/fixed-assets/${asset.id}`, { method: "PUT", body })
        : await api<{ asset: FixedAsset }>("/api/fixed-assets", { method: "POST", body: { ...body, source: "ui", idempotencyKey: createKey } });
      onSaved(result.asset);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(event) => void save(event)}>
      {error ? <Notice tone="error">{error}</Notice> : null}
      {locked ? <Notice tone="info">This asset has depreciation or a disposal, so only its name, description and tracking can change. Roll back its depreciation to change the rest.</Notice> : null}
      <div className={ui.grid2}>
        <Field label="Name">
          <input value={draft.name} maxLength={200} onChange={(event) => set({ name: event.target.value })} required />
        </Field>
        <Field label="Asset type">
          <select value={draft.typeId} disabled={locked} onChange={(event) => set({ typeId: event.target.value, billLineId: "" })} required>
            <option value="">Choose a type</option>
            {types.data.types.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.name} ({entry.assetAccountCode}, {methodText(entry.method, entry.rate)})
              </option>
            ))}
          </select>
        </Field>
      </div>
      <Field label="Description" hint="Optional: serial number, where it is.">
        <input value={draft.description} maxLength={1000} onChange={(event) => set({ description: event.target.value })} />
      </Field>
      {!asset ? (
        <Field label="From a bill" hint="Optional. The bill already posted the cost to the asset account; this just records it. Leave the cost blank to use what's left of the line.">
          <select value={draft.billLineId} onChange={(event) => set({ billLineId: event.target.value })}>
            <option value="">Not from a bill (typed in)</option>
            {lines.map((line) => (
              <option key={line.billLineId} value={line.billLineId}>
                {formatDate(line.billDate)} · {line.supplierName} {line.supplierInvoiceNumber} · {line.description} · {line.unregistered} of {line.netAmount}
              </option>
            ))}
          </select>
        </Field>
      ) : null}
      <div className={ui.grid3}>
        <Field label="Purchase date">
          <input type="date" value={draft.purchaseDate} disabled={locked} onChange={(event) => set({ purchaseDate: event.target.value })} required={!draft.billLineId} />
        </Field>
        <Field label="Cost excluding GST">
          <input inputMode="decimal" value={draft.cost} disabled={locked} onChange={(event) => set({ cost: event.target.value })} required={!draft.billLineId} />
        </Field>
        <Field label="Residual value" hint="Optional: depreciation stops here.">
          <input inputMode="decimal" value={draft.residualValue} disabled={locked} onChange={(event) => set({ residualValue: event.target.value })} />
        </Field>
      </div>
      <div className={ui.grid2}>
        <Field label="Depreciation method" hint={type ? `Blank uses the type's: ${methodText(type.method, type.rate)}.` : undefined}>
          <select value={draft.method} disabled={locked} onChange={(event) => set({ method: event.target.value as AssetDraft["method"] })}>
            <option value="">The asset type&apos;s</option>
            <option value="dv">Diminishing value</option>
            <option value="sl">Straight line</option>
            <option value="none">No depreciation (e.g. land)</option>
          </select>
        </Field>
        {draft.method === "dv" || draft.method === "sl" ? (
          <Field label="Annual rate %" hint="Check IRD's current rates for this kind of asset.">
            <input inputMode="decimal" value={draft.rate} disabled={locked} onChange={(event) => set({ rate: event.target.value })} required />
          </Field>
        ) : null}
      </div>
      <details>
        <summary>Bringing in an existing register (opening balance)</summary>
        <div className={ui.grid2}>
          <Field label="Opening balance date" hint="A month end: depreciation starts the month after.">
            <input type="date" value={draft.openingDate} disabled={locked} onChange={(event) => set({ openingDate: event.target.value })} />
          </Field>
          <Field label="Accumulated depreciation at that date">
            <input inputMode="decimal" value={draft.openingAccumulatedDepreciation} disabled={locked} onChange={(event) => set({ openingAccumulatedDepreciation: event.target.value })} />
          </Field>
        </div>
      </details>
      <TrackingSelects setup={tracking.data} value={draft.tracking} onChange={(tags) => set({ tracking: tags })} labelPrefix="Asset" />
      <div className={ui.actions}>
        <Button type="submit" disabled={busy}>
          {busy ? "Saving…" : asset ? "Save changes" : "Register asset"}
        </Button>
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function isClearingAccount(account: Account): boolean {
  return (
    account.currencyCode === null &&
    account.accountType !== "bank" &&
    account.accountType !== "credit_card" &&
    !["accounts_receivable", "accounts_payable", "expense_claims_payable", "gst", "inventory"].includes(account.systemKey ?? "")
  );
}

function isProfitAndLoss(account: Account): boolean {
  return account.currencyCode === null && (account.accountClass === "revenue" || account.accountClass === "expense");
}

/** Sell or write off an asset, with what it will post shown first (FA8-FA10). */
function DisposeForm({ organisationId, asset, onDone }: { organisationId: string; asset: FixedAsset; onDone: (asset: FixedAsset, message: string) => void }) {
  const confirm = useConfirm();
  const accounts = useAccounts(organisationId);
  const [disposalDate, setDisposalDate] = useState(todayInBrowser);
  const [proceeds, setProceeds] = useState("");
  const [proceedsAccountCode, setProceedsAccountCode] = useState("");
  const [gainLossAccountCode, setGainLossAccountCode] = useState("");
  const [capitalGainAccountCode, setCapitalGainAccountCode] = useState("");
  const [idempotencyKey] = useState(() => newIdempotencyKey("dispose"));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const query = {
    organisationId,
    disposalDate,
    proceeds: proceeds || null,
    proceedsAccountCode: proceeds ? proceedsAccountCode || null : null,
    gainLossAccountCode: gainLossAccountCode || null,
    capitalGainAccountCode: capitalGainAccountCode || null,
  };
  const ready = /^\d{4}-\d{2}-\d{2}$/.test(disposalDate) && (!proceeds || proceedsAccountCode !== "");
  const preview = useApiData<{ preview: DisposalPreview }>(ready ? `/api/fixed-assets/${asset.id}/disposal` : null, query);
  const all = accounts.data?.accounts ?? [];

  async function dispose() {
    if (!(await confirm(`Dispose of ${asset.assetNumber}? It posts the journal shown.`))) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api<{ asset: FixedAsset }>(`/api/fixed-assets/${asset.id}/disposal`, {
        method: "POST",
        body: { ...query, source: "ui", idempotencyKey },
      });
      onDone(result.asset, proceeds ? "Sold: the disposal is posted." : "Written off: the disposal is posted.");
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Sell or write off" description="Depreciation to the disposal is charged (by the disposal month setting), the cost and accumulated depreciation come off, and the gain or loss is posted.">
      {error ? <Notice tone="error">{error}</Notice> : null}
      <div className={ui.grid3}>
        <Field label="Disposal date">
          <input type="date" value={disposalDate} onChange={(event) => setDisposalDate(event.target.value)} />
        </Field>
        <Field label="Proceeds excluding GST" hint="Blank for a write-off.">
          <input inputMode="decimal" value={proceeds} onChange={(event) => setProceeds(event.target.value)} />
        </Field>
        {proceeds ? (
          <Field label="Sale was coded to" hint="The account the sale's invoice or receive money went to; the proceeds are cleared from it.">
            <AccountSelect accounts={all} value={proceedsAccountCode} onChange={setProceedsAccountCode} filter={isClearingAccount} ariaLabel="Sale was coded to" />
          </Field>
        ) : null}
      </div>
      <details>
        <summary>Gain and loss accounts</summary>
        <div className={ui.grid2}>
          <Field label="Gain or loss (and depreciation recovered)">
            <AccountSelect accounts={all} value={gainLossAccountCode} onChange={setGainLossAccountCode} filter={isProfitAndLoss} placeholder="Default (7030)" ariaLabel="Gain or loss account" />
          </Field>
          <Field label="Capital gain (above cost)">
            <AccountSelect accounts={all} value={capitalGainAccountCode} onChange={setCapitalGainAccountCode} filter={isProfitAndLoss} placeholder="Default (7040)" ariaLabel="Capital gain account" />
          </Field>
        </div>
      </details>
      {preview.error ? <Notice tone="warning">{preview.error}</Notice> : null}
      {preview.data ? (
        <>
          <div className={ui.grid4}>
            <Stat label="Depreciation to disposal" value={<Money value={preview.data.preview.depreciation} />} />
            <Stat label="Book value" value={<Money value={preview.data.preview.bookValue} />} />
            <Stat label="Proceeds" value={<Money value={preview.data.preview.proceeds} />} />
            <Stat
              label={preview.data.preview.loss !== "0.00" ? "Loss" : "Gain"}
              value={
                <Money
                  value={
                    preview.data.preview.loss !== "0.00"
                      ? preview.data.preview.loss
                      : toFixedString(add(dec(preview.data.preview.depreciationRecovered), dec(preview.data.preview.capitalGain)), 2)
                  }
                />
              }
            />
          </div>
          <JournalLines lines={preview.data.preview.journalLines} />
        </>
      ) : null}
      <div className={ui.actions}>
        <Button variant="danger" onClick={() => void dispose()} disabled={busy || !preview.data}>
          {proceeds ? "Record the sale" : "Write it off"}
        </Button>
      </div>
    </Card>
  );
}

export function FixedAssetView({ organisationId, assetId }: { organisationId: string; assetId: string }) {
  const confirm = useConfirm();
  const { can } = useWorkspace();
  const loaded = useApiData<{ asset: FixedAsset }>(`/api/fixed-assets/${encodeURIComponent(assetId)}`, { organisationId });
  const tracking = useTracking(organisationId);
  const [updated, setUpdated] = useState<FixedAsset | null>(null);
  const [editing, setEditing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [undoKey] = useState(() => newIdempotencyKey("undo"));
  if (loaded.error) return <Notice tone="error">{loaded.error}</Notice>;
  const asset = updated ?? loaded.data?.asset;
  if (!asset) return <p className={ui.muted}>Loading…</p>;
  const changed = (next: FixedAsset, text: string) => {
    setUpdated(next);
    setMessage(text);
    setEditing(false);
    setError(null);
  };
  async function action(path: string, body: Record<string, unknown>, text: string, confirmText: string) {
    if (!(await confirm(confirmText))) return;
    try {
      const result = await api<{ asset: FixedAsset }>(`/api/fixed-assets/${asset!.id}${path}`, { method: "POST", body: { organisationId, source: "ui", ...body } });
      changed(result.asset, text);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }
  const status = STATUS_BADGES[asset.status];
  return (
    <>
      {message ? <Notice tone="success">{message}</Notice> : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
      <Card
        title={`${asset.assetNumber} · ${asset.name}`}
        actions={
          <>
            <Badge tone={status.tone}>{status.label}</Badge>
            {can("bookkeeper") && asset.status !== "archived" && !editing ? (
              <Button size="small" variant="secondary" onClick={() => setEditing(true)}>
                Edit
              </Button>
            ) : null}
          </>
        }
      >
        {editing ? (
          <FixedAssetForm organisationId={organisationId} asset={asset} onSaved={(next) => changed(next, "Saved.")} onCancel={() => setEditing(false)} />
        ) : (
          <>
            {asset.description ? <p>{asset.description}</p> : null}
            <TrackingTagsText setup={tracking.data} tags={asset.tracking} />
            <div className={ui.grid4}>
              <Stat label="Type" value={asset.typeName} />
              <Stat label="Bought" value={formatDate(asset.purchaseDate)} />
              <Stat label="Method" value={methodText(asset.method, asset.rate)} />
              <Stat label="Cost" value={<Money value={asset.cost} />} />
              <Stat label="Accumulated depreciation" value={<Money value={asset.accumulatedDepreciation} />} />
              <Stat label="Book value" value={<Money value={asset.bookValue} />} />
              <Stat label="Depreciated to" value={asset.depreciatedTo ? formatDate(asset.depreciatedTo) : "Not yet"} />
              {asset.residualValue !== "0.00" ? <Stat label="Residual value" value={<Money value={asset.residualValue} />} /> : null}
              {asset.openingDate ? (
                <Stat label={`Opening at ${formatDate(asset.openingDate)}`} value={<Money value={asset.openingAccumulatedDepreciation} />} />
              ) : null}
            </div>
            <p className={ui.muted}>
              Accounts: cost {asset.assetAccountCode}, accumulated depreciation {asset.accumulatedDepreciationAccountCode}, depreciation{" "}
              {asset.depreciationExpenseAccountCode}.{asset.billId ? <> From <Link href={`/operations/bills/${asset.billId}`}>its bill</Link>.</> : null}
            </p>
          </>
        )}
      </Card>
      <Card title="Depreciation">
        {asset.history.length === 0 ? (
          <Empty>No depreciation charged yet.</Empty>
        ) : (
          <div className={ui.tableWrap}>
            <table className={`${ui.table} ${ui.stackOnPhone}`}>
              <thead>
                <tr>
                  <th>Posted</th>
                  <th>By</th>
                  <th>Months</th>
                  <th className={ui.num}>Amount</th>
                </tr>
              </thead>
              <tbody>
                {asset.history.map((line, index) => (
                  <tr key={index}>
                    <td data-label="Posted">{formatDate(line.date)}</td>
                    <td data-label="By">
                      {line.kind === "run" ? "Depreciation run" : "Disposal"}
                      {line.counts ? null : <> <Badge tone="neutral">{line.kind === "run" ? "Rolled back" : "Undone"}</Badge></>}
                    </td>
                    <td data-label="Months">
                      {line.fromMonth} to {line.toMonth} ({line.months})
                    </td>
                    <td data-label="Amount" className={ui.num}>
                      <Money value={line.amount} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {asset.disposals.map((entry) => (
        <Card key={entry.id} title={`${entry.proceeds === "0.00" ? "Written off" : "Sold"} ${formatDate(entry.disposalDate)}`} actions={entry.status === "undone" ? <Badge tone="neutral">Undone</Badge> : null}>
          <div className={ui.grid4}>
            <Stat label="Cost" value={<Money value={entry.cost} />} />
            <Stat label="Accumulated depreciation" value={<Money value={entry.accumulatedDepreciation} />} />
            <Stat label="Book value" value={<Money value={entry.bookValue} />} />
            <Stat label="Proceeds" value={<Money value={entry.proceeds} />} />
            {entry.loss !== "0.00" ? <Stat label="Loss" value={<Money value={entry.loss} />} /> : null}
            {entry.depreciationRecovered !== "0.00" ? <Stat label="Depreciation recovered" value={<Money value={entry.depreciationRecovered} />} /> : null}
            {entry.capitalGain !== "0.00" ? <Stat label="Capital gain" value={<Money value={entry.capitalGain} />} /> : null}
          </div>
          <p className={ui.muted}>
            <Link href={`/operations/ledger-journals?journal=${entry.journalId}`}>Its journal</Link>
            {entry.undoJournalId ? (
              <>
                {" "}
                · <Link href={`/operations/ledger-journals?journal=${entry.undoJournalId}`}>Undo journal</Link> ({personName(entry, "undoneBy")}, {formatDateTime(entry.undoneAt)})
              </>
            ) : (
              <> · by {personName(entry, "createdBy")}</>
            )}
          </p>
          {entry.status === "active" && can("bookkeeper") ? (
            <Button
              variant="secondary"
              onClick={() =>
                void action("/disposal/undo", { idempotencyKey: undoKey }, "Disposal undone.", "Undo this disposal? It posts the exact reversal on the disposal date.")
              }
            >
              Undo disposal
            </Button>
          ) : null}
        </Card>
      ))}
      {asset.status === "registered" && can("bookkeeper") ? <DisposeForm organisationId={organisationId} asset={asset} onDone={changed} /> : null}
      {asset.status === "registered" && !asset.hasHistory && can("bookkeeper") ? (
        <p>
          <Button variant="danger" size="small" onClick={() => void action("/archive", {}, "Archived.", "Archive this asset? Use this for an asset registered by mistake.")}>
            Archive (registered by mistake)
          </Button>
        </p>
      ) : null}
      {asset.status !== "archived" ? <RdAssetPanel organisationId={organisationId} assetId={asset.id} /> : null}
      <RecordExtrasPanel key={`${asset.status}-${message ?? ""}`} organisationId={organisationId} recordType="fixed_asset" recordId={asset.id} />
      <p>
        <Link href="/operations/fixed-assets">Back to fixed assets</Link>
      </p>
    </>
  );
}

/** Preview and post a depreciation run; roll back the latest (FA3-FA7). */
export function DepreciationRuns({ organisationId }: { organisationId: string }) {
  const confirm = useConfirm();
  const { can } = useWorkspace();
  const [periodEnd, setPeriodEnd] = useState(lastMonthEnd);
  const [runKey, setRunKey] = useState(() => newIdempotencyKey("run"));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const runs = useApiData<{ runs: DepreciationRun[] }>("/api/depreciation-runs", { organisationId });
  const preview = useApiData<{ preview: RunPreview }>(isMonthEnd(periodEnd) ? "/api/depreciation-runs" : null, { organisationId, periodEnd });
  const latest = runs.data?.runs.find((run) => run.status === "active");

  async function post(path: string, body: Record<string, unknown>, text: string) {
    setBusy(true);
    setError(null);
    try {
      await api(path, { method: "POST", body: { organisationId, source: "ui", ...body } });
      setMessage(text);
      runs.reload();
      preview.reload();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {message ? <Notice tone="success">{message}</Notice> : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
      <Card
        title="Run depreciation"
        description="Charges each registered asset for the months since it was last charged, to a month end, in one journal. Runs go forward one after another; the latest can be rolled back."
      >
        <div className={ui.inlineForm}>
          <Field label="To month end" hint={latest ? `Last run to ${formatDate(latest.periodEnd)}.` : "No runs yet."}>
            <input type="date" value={periodEnd} onChange={(event) => setPeriodEnd(event.target.value)} />
          </Field>
          {can("bookkeeper") ? (
            <Button
              disabled={busy || !preview.data}
              onClick={() =>
                void post("/api/depreciation-runs", { idempotencyKey: runKey, periodEnd }, `Depreciation run to ${formatDate(periodEnd)}.`).then(() =>
                  setRunKey(newIdempotencyKey("run")),
                )
              }
            >
              Post depreciation
            </Button>
          ) : null}
        </div>
        {!isMonthEnd(periodEnd) ? <Notice tone="warning">Choose the last day of a month.</Notice> : null}
        {preview.error ? <Notice tone="warning">{preview.error}</Notice> : null}
        {preview.data ? (
          preview.data.preview.lines.length === 0 ? (
            <Empty>Nothing to charge to {formatDate(periodEnd)}.</Empty>
          ) : (
            <>
              <div className={ui.tableWrap}>
                <table className={`${ui.table} ${ui.stackOnPhone}`}>
                  <thead>
                    <tr>
                      <th>Asset</th>
                      <th>Type</th>
                      <th>Months</th>
                      <th className={ui.num}>Depreciation</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.data.preview.lines.map((line, index) => (
                      <tr key={index}>
                        <td data-label="Asset">
                          <Link href={`/operations/fixed-assets/${line.assetId}`}>{line.assetNumber}</Link> {line.assetName}
                        </td>
                        <td data-label="Type">{line.typeName}</td>
                        <td data-label="Months">
                          {line.fromMonth} to {line.toMonth} ({line.months})
                        </td>
                        <td data-label="Depreciation" className={ui.num}>
                          <Money value={line.amount} />
                        </td>
                      </tr>
                    ))}
                    <tr className={ui.reportTotal}>
                      <td colSpan={3}>Total</td>
                      <td className={ui.num}>
                        <Money value={preview.data.preview.total} />
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <h3>Journal</h3>
              <JournalLines lines={preview.data.preview.journalLines} />
            </>
          )
        ) : null}
      </Card>
      <Card title="Runs">
        {runs.data && runs.data.runs.length === 0 ? <Empty>No depreciation runs yet.</Empty> : null}
        {runs.data && runs.data.runs.length > 0 ? (
          <div className={ui.tableWrap}>
            <table className={`${ui.table} ${ui.stackOnPhone}`}>
              <thead>
                <tr>
                  <th>To</th>
                  <th>Status</th>
                  <th>By</th>
                  <th className={ui.num}>Total</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {runs.data.runs.map((run) => (
                  <tr key={run.id}>
                    <td data-label="To">
                      {run.journalId ? <Link href={`/operations/ledger-journals?journal=${run.journalId}`}>{run.reference}</Link> : run.reference} ·{" "}
                      {formatDate(run.periodEnd)}
                    </td>
                    <td data-label="Status">{run.status === "active" ? <Badge tone="green">Posted</Badge> : <Badge tone="neutral">Rolled back</Badge>}</td>
                    <td data-label="By">{run.status === "active" ? personName(run, "createdBy") : personName(run, "rolledBackBy")}</td>
                    <td data-label="Total" className={ui.num}>
                      <Money value={run.total} />
                    </td>
                    <td>
                      {latest && run.id === latest.id && can("bookkeeper") ? (
                        <Button
                          size="small"
                          variant="secondary"
                          disabled={busy}
                          onClick={async () => {
                            if (!(await confirm(`Roll back the run to ${formatDate(run.periodEnd)}? It posts the exact reversal on the same date.`))) return;
                            void post(`/api/depreciation-runs/${run.id}/rollback`, { idempotencyKey: newIdempotencyKey("rollback") }, "Rolled back.");
                          }}
                        >
                          Roll back
                        </Button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </Card>
    </>
  );
}

type TypeDraft = {
  name: string;
  assetAccountCode: string;
  accumulatedDepreciationAccountCode: string;
  depreciationExpenseAccountCode: string;
  method: DepreciationMethod;
  rate: string;
};

function isAssetSide(account: Account): boolean {
  return (account.accountType === "fixed_asset" || account.accountType === "non_current_asset") && account.systemKey === null && account.currencyCode === null;
}

function isExpense(account: Account): boolean {
  return account.accountClass === "expense" && account.systemKey === null && account.currencyCode === null;
}

function TypeForm({ organisationId, type, onSaved, onCancel }: { organisationId: string; type?: FixedAssetType; onSaved: (text: string) => void; onCancel?: () => void }) {
  const accounts = useAccounts(organisationId);
  const [draft, setDraft] = useState<TypeDraft>({
    name: type?.name ?? "",
    assetAccountCode: type?.assetAccountCode ?? "",
    accumulatedDepreciationAccountCode: type?.accumulatedDepreciationAccountCode ?? "",
    depreciationExpenseAccountCode: type?.depreciationExpenseAccountCode ?? "",
    method: type?.method ?? "dv",
    rate: type?.rate ?? "",
  });
  const [key, setKey] = useState(() => newIdempotencyKey("asset-type"));
  const [error, setError] = useState<string | null>(null);
  const all = accounts.data?.accounts ?? [];
  const set = (change: Partial<TypeDraft>) => setDraft({ ...draft, ...change });
  async function save(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    const body = { organisationId, ...draft, rate: draft.method === "none" ? null : draft.rate };
    try {
      if (type) await api(`/api/fixed-asset-types/${type.id}`, { method: "PUT", body });
      else await api("/api/fixed-asset-types", { method: "POST", body: { ...body, source: "ui", idempotencyKey: key } });
      setKey(newIdempotencyKey("asset-type"));
      onSaved(type ? `${draft.name} saved.` : `${draft.name} added.`);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }
  const lockedAccounts = (type?.assetCount ?? 0) > 0;
  return (
    <form onSubmit={(event) => void save(event)}>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <div className={ui.grid3}>
        <Field label="Name">
          <input value={draft.name} maxLength={100} onChange={(event) => set({ name: event.target.value })} required />
        </Field>
        <Field label="Default method">
          <select value={draft.method} onChange={(event) => set({ method: event.target.value as DepreciationMethod })}>
            <option value="dv">Diminishing value</option>
            <option value="sl">Straight line</option>
            <option value="none">No depreciation</option>
          </select>
        </Field>
        {draft.method !== "none" ? (
          <Field label="Default annual rate %" hint="Check IRD's current rates.">
            <input inputMode="decimal" value={draft.rate} onChange={(event) => set({ rate: event.target.value })} required />
          </Field>
        ) : null}
      </div>
      <div className={ui.grid3}>
        <Field label="Asset account" hint={lockedAccounts ? "Fixed: this type has assets." : undefined}>
          {lockedAccounts ? (
            <input value={draft.assetAccountCode} disabled />
          ) : (
            <AccountSelect accounts={all} value={draft.assetAccountCode} onChange={(code) => set({ assetAccountCode: code })} filter={isAssetSide} ariaLabel="Asset account" required />
          )}
        </Field>
        <Field label="Accumulated depreciation account">
          {lockedAccounts ? (
            <input value={draft.accumulatedDepreciationAccountCode} disabled />
          ) : (
            <AccountSelect
              accounts={all}
              value={draft.accumulatedDepreciationAccountCode}
              onChange={(code) => set({ accumulatedDepreciationAccountCode: code })}
              filter={isAssetSide}
              ariaLabel="Accumulated depreciation account"
              required
            />
          )}
        </Field>
        <Field label="Depreciation expense account">
          {lockedAccounts ? (
            <input value={draft.depreciationExpenseAccountCode} disabled />
          ) : (
            <AccountSelect
              accounts={all}
              value={draft.depreciationExpenseAccountCode}
              onChange={(code) => set({ depreciationExpenseAccountCode: code })}
              filter={isExpense}
              ariaLabel="Depreciation expense account"
              required
            />
          )}
        </Field>
      </div>
      <div className={ui.actions}>
        <Button type="submit">{type ? "Save" : "Add asset type"}</Button>
        {onCancel ? (
          <Button variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
      </div>
    </form>
  );
}

/** Asset types and the part-month settings (admins change them; FA1, FA7, FA8). */
export function FixedAssetTypes({ organisationId }: { organisationId: string }) {
  const { can } = useWorkspace();
  const types = useApiData<{ types: FixedAssetType[] }>("/api/fixed-asset-types", { organisationId, includeArchived: "true" });
  const settings = useApiData<{ settings: FixedAssetSettings }>("/api/fixed-asset-settings", { organisationId });
  const [editing, setEditing] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const admin = can("admin");
  const saved = (text: string) => {
    setMessage(text);
    setEditing(null);
    types.reload();
  };
  async function archive(type: FixedAssetType, archived: boolean) {
    try {
      await api(`/api/fixed-asset-types/${type.id}/archive`, { method: "POST", body: { organisationId, archived } });
      saved(archived ? `${type.name} archived.` : `${type.name} brought back.`);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }
  async function saveSettings(change: Partial<FixedAssetSettings>) {
    try {
      await api("/api/fixed-asset-settings", { method: "PUT", body: { organisationId, ...change } });
      settings.reload();
      setMessage("Settings saved. They apply to depreciation worked out from now on.");
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }
  return (
    <>
      {message ? (
        <Notice tone="success">
          {message}
          {message.endsWith(" added.") ? (
            <>
              {" "}
              <Link href="/operations/fixed-assets/new">Register an asset</Link>
            </>
          ) : null}
        </Notice>
      ) : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
      <Notice tone="info">
        Tohyee has no built-in IRD depreciation rates. Enter the method and rate for each type (and change them per asset when needed); check IRD&apos;s current rates
        and rules for each kind of asset first.
      </Notice>
      <Card title="Asset types" description="Which accounts each kind of asset uses, and its default method and rate.">
        {types.error ? <Notice tone="error">{types.error}</Notice> : null}
        {types.data && types.data.types.length === 0 ? <Empty>No asset types yet.</Empty> : null}
        {types.data && types.data.types.length > 0 ? (
          <div className={ui.tableWrap}>
            <table className={`${ui.table} ${ui.stackOnPhone}`}>
              <thead>
                <tr>
                  <th>Type</th>
                  <th>Accounts</th>
                  <th>Default</th>
                  <th>Assets</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {types.data.types.map((type) =>
                  editing === type.id ? (
                    <tr key={type.id}>
                      <td colSpan={5}>
                        <TypeForm organisationId={organisationId} type={type} onSaved={saved} onCancel={() => setEditing(null)} />
                      </td>
                    </tr>
                  ) : (
                    <tr key={type.id}>
                      <td data-label="Type">
                        {type.name} {type.isArchived ? <Badge tone="neutral">Archived</Badge> : null}
                      </td>
                      <td data-label="Accounts">
                        {type.assetAccountCode} / {type.accumulatedDepreciationAccountCode} / {type.depreciationExpenseAccountCode}
                      </td>
                      <td data-label="Default">{methodText(type.method, type.rate)}</td>
                      <td data-label="Assets">{type.assetCount}</td>
                      <td>
                        {admin ? (
                          <span className={ui.rowButtons}>
                            {!type.isArchived ? (
                              <Button size="small" variant="secondary" onClick={() => setEditing(type.id)}>
                                Edit
                              </Button>
                            ) : null}
                            <Button size="small" variant="secondary" onClick={() => void archive(type, !type.isArchived)}>
                              {type.isArchived ? "Bring back" : "Archive"}
                            </Button>
                          </span>
                        ) : null}
                      </td>
                    </tr>
                  ),
                )}
              </tbody>
            </table>
          </div>
        ) : null}
      </Card>
      {admin ? (
        <Card title="Add an asset type">
          <TypeForm key={message ?? ""} organisationId={organisationId} onSaved={saved} />
        </Card>
      ) : null}
      {settings.data ? (
        <Card title="Part months" description="Depreciation is worked out in whole months.">
          <div className={ui.grid2}>
            <Field label="The month an asset is bought">
              <select
                value={settings.data.settings.firstMonth}
                disabled={!admin}
                onChange={(event) => void saveSettings({ firstMonth: event.target.value as FixedAssetSettings["firstMonth"] })}
              >
                <option value="full_month">Counts as a whole month</option>
                <option value="next_month">Isn&apos;t depreciated (starts the month after)</option>
              </select>
            </Field>
            <Field label="The month an asset is disposed of">
              <select
                value={settings.data.settings.disposalMonth}
                disabled={!admin}
                onChange={(event) => void saveSettings({ disposalMonth: event.target.value as FixedAssetSettings["disposalMonth"] })}
              >
                <option value="exclude">Isn&apos;t depreciated</option>
                <option value="include">Counts as a whole month</option>
              </select>
            </Field>
          </div>
        </Card>
      ) : null}
    </>
  );
}

/** The register as at a date, grouped by type, tied to the ledger (FA13). */
export function FixedAssetRegisterReport({ organisationId }: { organisationId: string }) {
  const [asOf, setAsOf] = useState(todayInBrowser);
  const report = useApiData<{ register: FixedAssetRegister }>("/api/reports/fixed-asset-register", { organisationId, asOf });
  const data = report.data?.register;
  return (
    <Card
      title="Fixed asset register"
      description="Each asset held with its cost, accumulated depreciation, book value and this financial year's depreciation, tied to the ledger."
      actions={
        <div className={ui.inlineForm} data-print="hide">
          <Field label="As at">
            <input type="date" value={asOf} onChange={(event) => setAsOf(event.target.value)} />
          </Field>
          <PrintButton />
        </div>
      }
    >
      {report.error ? <Notice tone="error">{report.error}</Notice> : null}
      {report.loading ? <p className={ui.muted}>Loading…</p> : null}
      {data ? (
        <>
          <p className={ui.muted}>
            As at {formatDate(data.asOf)}; this year is from {formatDate(data.financialYearStart)}.
          </p>
          {data.groups.length === 0 ? <Empty>No assets held on this date.</Empty> : null}
          {data.groups.length > 0 ? (
            <div className={ui.tableWrap}>
              <table className={ui.table}>
                <thead>
                  <tr>
                    <th>Asset</th>
                    <th>Bought</th>
                    <th>Method</th>
                    <th className={ui.num}>Cost</th>
                    <th className={ui.num}>Accumulated depreciation</th>
                    <th className={ui.num}>Book value</th>
                    <th className={ui.num}>Depreciation this year</th>
                  </tr>
                </thead>
                <tbody>
                  {data.groups.map((group) => (
                    <RegisterGroupRows key={group.typeId} group={group} />
                  ))}
                  <tr className={ui.reportTotal}>
                    <td colSpan={3}>Total</td>
                    <td className={ui.num}>
                      <Money value={data.totals.cost} />
                    </td>
                    <td className={ui.num}>
                      <Money value={data.totals.accumulatedDepreciation} />
                    </td>
                    <td className={ui.num}>
                      <Money value={data.totals.bookValue} />
                    </td>
                    <td className={ui.num}>
                      <Money value={data.totals.depreciationThisYear} />
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          ) : null}
          {data.disposals.length > 0 ? (
            <>
              <h3>Disposed of this year</h3>
              <div className={ui.tableWrap}>
                <table className={ui.table}>
                  <thead>
                    <tr>
                      <th>Asset</th>
                      <th>Disposed</th>
                      <th className={ui.num}>Cost</th>
                      <th className={ui.num}>Accumulated depreciation</th>
                      <th className={ui.num}>Proceeds</th>
                      <th className={ui.num}>Gain (loss)</th>
                      <th className={ui.num}>Depreciation this year</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.disposals.map((entry) => (
                      <tr key={entry.id}>
                        <td>
                          <Link href={`/operations/fixed-assets/${entry.id}`}>{entry.assetNumber}</Link> {entry.name} ({entry.typeName})
                        </td>
                        <td>{formatDate(entry.disposalDate)}</td>
                        <td className={ui.num}>
                          <Money value={entry.cost} />
                        </td>
                        <td className={ui.num}>
                          <Money value={entry.accumulatedDepreciation} />
                        </td>
                        <td className={ui.num}>
                          <Money value={entry.proceeds} />
                        </td>
                        <td className={ui.num}>
                          <Money value={entry.gainOrLoss} />
                        </td>
                        <td className={ui.num}>
                          <Money value={entry.depreciationThisYear} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : null}
          <h3>Ties to the ledger</h3>
          {data.ties ? null : (
            <Notice tone="warning">The ledger doesn&apos;t match the register on some accounts: look for journals posted straight to them (Account transactions).</Notice>
          )}
          <div className={ui.tableWrap}>
            <table className={ui.table}>
              <thead>
                <tr>
                  <th>Account</th>
                  <th className={ui.num}>Register</th>
                  <th className={ui.num}>Ledger</th>
                  <th className={ui.num}>Difference</th>
                </tr>
              </thead>
              <tbody>
                {data.ledger.map((entry) => (
                  <tr key={`${entry.accountCode}-${entry.role}`}>
                    <td>
                      {entry.accountCode} · {entry.accountName}
                    </td>
                    <td className={ui.num}>
                      <Money value={entry.register} />
                    </td>
                    <td className={ui.num}>
                      <Money value={entry.ledger} />
                    </td>
                    <td className={ui.num}>
                      <Money value={entry.difference} blankZero />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
    </Card>
  );
}

function RegisterGroupRows({ group }: { group: FixedAssetRegister["groups"][number] }) {
  return (
    <>
      <tr className={ui.reportSection}>
        <td colSpan={7}>
          <strong>{group.typeName}</strong>
        </td>
      </tr>
      {group.assets.map((asset) => (
        <tr key={asset.id}>
          <td>
            <Link href={`/operations/fixed-assets/${asset.id}`}>{asset.assetNumber}</Link> {asset.name}
          </td>
          <td>{formatDate(asset.purchaseDate)}</td>
          <td>{methodText(asset.method, asset.rate)}</td>
          <td className={ui.num}>
            <Money value={asset.cost} />
          </td>
          <td className={ui.num}>
            <Money value={asset.accumulatedDepreciation} />
          </td>
          <td className={ui.num}>
            <Money value={asset.bookValue} />
          </td>
          <td className={ui.num}>
            <Money value={asset.depreciationThisYear} />
          </td>
        </tr>
      ))}
      <tr className={ui.reportTotal}>
        <td colSpan={3}>Total {group.typeName}</td>
        <td className={ui.num}>
          <Money value={group.totals.cost} />
        </td>
        <td className={ui.num}>
          <Money value={group.totals.accumulatedDepreciation} />
        </td>
        <td className={ui.num}>
          <Money value={group.totals.bookValue} />
        </td>
        <td className={ui.num}>
          <Money value={group.totals.depreciationThisYear} />
        </td>
      </tr>
    </>
  );
}
