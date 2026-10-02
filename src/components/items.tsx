"use client";

import { type FormEvent, useState } from "react";
import { AccountSelect, useAccounts } from "@/components/books";
import { useApiData } from "@/components/hooks";
import { Badge, Button, Card, Empty, Field, Notice, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import type { Account } from "@/lib/accounts/service";
import { billLineAccountProblem } from "@/lib/bills/accounts";
import { api, errorMessage, newIdempotencyKey } from "@/lib/client/api";
import type { Contact } from "@/lib/contacts/service";
import type { CustomerSetup } from "@/lib/customers/service";
import type { ItemLineDefaults } from "@/lib/items/lines";
import { ITEM_TYPE_LABELS, ITEM_TYPES, type ItemType } from "@/lib/items/pricing";
import type { Item, ItemList } from "@/lib/items/service";
import type { TaxCode } from "@/lib/tax/codes";
import { codesForSide, type TaxSide, unavailableNote } from "@/lib/tax/available-on";

/**
 * Products and services on screen (examples IT1-IT9): the list hook, the
 * item and unit selects on invoice, bill and credit note lines, and the
 * Items screen. Units, level prices, supplier prices and kits show while
 * Advanced reporting is on (or an item already has them).
 */
export function useItems(organisationId: string | null) {
  return useApiData<ItemList>(organisationId ? "/api/items" : null, { organisationId, includeArchived: "true" });
}

/** The line fields an item fills. */
export type ItemLinePatch = {
  itemId: string;
  unitId: string;
  description?: string;
  unitPrice?: string;
  accountCode?: string;
  taxCode?: string;
};

/**
 * The item select (and unit select, when the item has units) for a line.
 * Picking an item asks the server what it fills (IT2-IT6: the customer's
 * price level, the supplier's price) and hands it to `onPick`; the line
 * stays editable. "No item" leaves the line as it is.
 */
export function LineItemPicker({
  organisationId,
  items,
  side,
  contactId,
  itemId,
  unitId,
  labelPrefix,
  onPick,
}: {
  organisationId: string;
  items: ItemList | null | undefined;
  side: "sale" | "purchase";
  contactId: string;
  itemId: string;
  unitId: string;
  labelPrefix: string;
  onPick: (patch: ItemLinePatch) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const list = (items?.items ?? []).filter(
    (item) => (item.isActive || item.id === itemId) && !(side === "purchase" && item.itemType === "kit"),
  );
  if (list.length === 0 && !itemId) return null;
  const current = list.find((item) => item.id === itemId);
  const units = (current?.units ?? []).filter((unit) => unit.isActive || unit.id === unitId);

  async function pick(nextItem: string, nextUnit: string | undefined) {
    setError(null);
    if (!nextItem) {
      onPick({ itemId: "", unitId: "" });
      return;
    }
    try {
      const defaults = await api<ItemLineDefaults>("/api/items/line-defaults", {
        query: { organisationId, itemId: nextItem, side, contactId: contactId || null, ...(nextUnit !== undefined ? { unitId: nextUnit || "" } : {}) },
      });
      onPick({
        itemId: nextItem,
        unitId: defaults.unitId ?? "",
        description: defaults.description,
        ...(defaults.unitPrice !== null ? { unitPrice: defaults.unitPrice } : {}),
        ...(defaults.accountCode !== null ? { accountCode: defaults.accountCode } : {}),
        ...(defaults.taxCode !== null ? { taxCode: defaults.taxCode } : {}),
      });
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  return (
    <div className={ui.trackingSelects}>
      <select aria-label={`${labelPrefix} item`} value={itemId} onChange={(event) => void pick(event.target.value, undefined)}>
        <option value="">No item</option>
        {list.map((item) => (
          <option key={item.id} value={item.id}>
            {item.code} · {item.name}
            {item.isActive ? "" : " (archived)"}
          </option>
        ))}
      </select>
      {current && (units.length > 0 || unitId) ? (
        <select aria-label={`${labelPrefix} unit`} value={unitId} onChange={(event) => void pick(itemId, event.target.value)}>
          <option value="">{current.baseUnit}</option>
          {units.map((unit) => (
            <option key={unit.id} value={unit.id}>
              {unit.name} ({unit.factor} {current.baseUnit})
            </option>
          ))}
        </select>
      ) : null}
      {error ? <span className={ui.muted}>{error}</span> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The Items screen (IT1, IT4-IT8)

type Draft = {
  code: string;
  name: string;
  description: string;
  itemType: ItemType;
  baseUnit: string;
  salePrice: string;
  purchasePrice: string;
  incomeAccountCode: string;
  purchaseAccountCode: string;
  salesTaxCode: string;
  purchaseTaxCode: string;
  saleUnitId: string;
  purchaseUnitId: string;
  levelPrices: Record<string, string>;
  suppliers: Array<{ contactId: string; price: string; supplierItemCode: string; isPreferred: boolean }>;
  components: Array<{ itemId: string; quantity: string }>;
};

function draftOf(item: Item | null): Draft {
  return {
    code: item?.code ?? "",
    name: item?.name ?? "",
    description: item?.description ?? "",
    itemType: item?.itemType ?? "service",
    baseUnit: item?.baseUnit ?? "each",
    salePrice: item?.salePrice ?? "",
    purchasePrice: item?.purchasePrice ?? "",
    incomeAccountCode: item?.incomeAccountCode ?? "",
    purchaseAccountCode: item?.purchaseAccountCode ?? "",
    salesTaxCode: item?.salesTaxCode ?? "",
    purchaseTaxCode: item?.purchaseTaxCode ?? "",
    saleUnitId: item?.saleUnitId ?? "",
    purchaseUnitId: item?.purchaseUnitId ?? "",
    levelPrices: Object.fromEntries((item?.levelPrices ?? []).map((entry) => [entry.priceLevelId, entry.price])),
    suppliers: (item?.suppliers ?? []).map((entry) => ({
      contactId: entry.contactId,
      price: entry.price ?? "",
      supplierItemCode: entry.supplierItemCode ?? "",
      isPreferred: entry.isPreferred,
    })),
    components: (item?.components ?? []).map((entry) => ({ itemId: entry.itemId, quantity: entry.quantity })),
  };
}

function bodyOf(draft: Draft, advanced: boolean, item: Item | null): Record<string, unknown> {
  const blankToNull = (value: string) => (value.trim() === "" ? null : value.trim());
  const body: Record<string, unknown> = {
    code: draft.code,
    name: draft.name,
    description: blankToNull(draft.description),
    itemType: draft.itemType,
    baseUnit: draft.baseUnit,
    salePrice: blankToNull(draft.salePrice),
    purchasePrice: blankToNull(draft.purchasePrice),
    incomeAccountCode: blankToNull(draft.incomeAccountCode),
    purchaseAccountCode: blankToNull(draft.purchaseAccountCode),
    salesTaxCode: blankToNull(draft.salesTaxCode),
    purchaseTaxCode: blankToNull(draft.purchaseTaxCode),
  };
  if (item) {
    body.saleUnitId = blankToNull(draft.saleUnitId);
    body.purchaseUnitId = blankToNull(draft.purchaseUnitId);
  }
  // The extras are only sent while Advanced reporting is on, so they're kept as they are when it's off (IT8).
  if (advanced) {
    body.levelPrices = Object.entries(draft.levelPrices)
      .filter(([, price]) => price.trim() !== "")
      .map(([priceLevelId, price]) => ({ priceLevelId, price: price.trim() }));
    body.suppliers = draft.suppliers
      .filter((entry) => entry.contactId)
      .map((entry) => ({
        contactId: entry.contactId,
        price: blankToNull(entry.price),
        supplierItemCode: blankToNull(entry.supplierItemCode),
        isPreferred: entry.isPreferred,
      }));
    body.components = draft.itemType === "kit" ? draft.components.filter((entry) => entry.itemId) : [];
  }
  return body;
}

function ItemForm({
  organisationId,
  item,
  items,
  advanced,
  accounts,
  taxCodes,
  suppliers,
  priceLevels,
  onSaved,
  onCancel,
}: {
  organisationId: string;
  item: Item | null;
  items: Item[];
  advanced: boolean;
  accounts: Account[];
  taxCodes: TaxCode[];
  suppliers: Contact[];
  priceLevels: CustomerSetup["priceLevels"];
  onSaved: (item: Item, message: string) => void;
  onCancel: () => void;
}) {
  // A new item starts with the first revenue account and the standard GST code
  // for sales, as new invoice lines do, so picking it fills them in (2 Oct 2026).
  const [draft, setDraft] = useState<Draft>(() => {
    const start = draftOf(item);
    if (item) return start;
    const revenue = accounts.find((account) => account.isActive && account.accountClass === "revenue");
    const standard = taxCodes.find((taxCode) => taxCode.isActive && taxCode.category === "standard");
    return { ...start, incomeAccountCode: revenue?.code ?? "", salesTaxCode: standard?.code ?? "" };
  });
  const [idempotencyKey] = useState(() => newIdempotencyKey("item"));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [unitName, setUnitName] = useState("");
  const [unitFactor, setUnitFactor] = useState("");
  const set = (patch: Partial<Draft>) => setDraft((current) => ({ ...current, ...patch }));
  const types = ITEM_TYPES.filter((type) => type !== "kit" || advanced || draft.itemType === "kit");
  const activeTaxCodes = taxCodes.filter((taxCode) => taxCode.isActive);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body = { organisationId, ...bodyOf(draft, advanced, item) };
      const result = item
        ? await api<{ item: Item }>(`/api/items/${item.id}`, { method: "PATCH", body })
        : await api<{ item: Item }>("/api/items", { method: "POST", body: { ...body, source: "ui", idempotencyKey } });
      onSaved(result.item, `Saved ${result.item.code}.`);
    } catch (caught) {
      setError(errorMessage(caught));
      setBusy(false);
    }
  }

  async function addUnit() {
    if (!item) return;
    setError(null);
    try {
      const result = await api<{ item: Item }>(`/api/items/${item.id}/units`, { method: "POST", body: { organisationId, name: unitName, factor: unitFactor } });
      setUnitName("");
      setUnitFactor("");
      onSaved(result.item, `Added ${unitName.trim()} to ${item.code}.`);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  async function toggleUnit(unitId: string, isActive: boolean) {
    if (!item) return;
    setError(null);
    try {
      const result = await api<{ item: Item }>(`/api/items/units/${unitId}`, { method: "PATCH", body: { organisationId, isActive } });
      onSaved(result.item, isActive ? "Unit restored." : "Unit archived.");
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  // The sales tax code lists codes available on sales, the purchase one on purchases (TAO7).
  const taxSelect = (value: string, onChange: (code: string) => void, label: string, side: TaxSide) => (
    <Field label={label}>
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">None</option>
        {codesForSide(taxCodes, side)
          .filter((taxCode) => taxCode.isActive || taxCode.code === value)
          .map((taxCode) => (
            <option key={taxCode.id} value={taxCode.code}>
              {taxCode.code}
              {unavailableNote(taxCode)}
            </option>
          ))}
      </select>
    </Field>
  );
  const showUnits = item && (advanced || item.units.length > 0);
  const showLevels = (advanced || Object.keys(draft.levelPrices).length > 0) && priceLevels.length > 0;
  const showSuppliers = advanced || draft.suppliers.length > 0;

  return (
    <form onSubmit={(event) => void submit(event)} style={{ display: "grid", gap: 12 }}>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <div className={ui.grid3}>
        <Field label="Code">
          <input value={draft.code} onChange={(event) => set({ code: event.target.value })} maxLength={50} required />
        </Field>
        <Field label="Name">
          <input value={draft.name} onChange={(event) => set({ name: event.target.value })} maxLength={150} required />
        </Field>
        <Field label="Type" hint={draft.itemType === "stock" ? "Stock items move stock and post cost of sales once stock tracking is on." : undefined}>
          <select value={draft.itemType} onChange={(event) => set({ itemType: event.target.value as ItemType })}>
            {types.map((type) => (
              <option key={type} value={type}>
                {ITEM_TYPE_LABELS[type]}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <Field label="Description" hint="Goes on the line when the item is picked; the name if left blank.">
        <input value={draft.description} onChange={(event) => set({ description: event.target.value })} maxLength={500} />
      </Field>
      <div className={ui.grid4}>
        <Field label="Sale price (excl. GST)">
          <input inputMode="decimal" value={draft.salePrice} onChange={(event) => set({ salePrice: event.target.value })} />
        </Field>
        <Field label="Income account">
          <AccountSelect accounts={accounts} value={draft.incomeAccountCode} onChange={(code) => set({ incomeAccountCode: code })} filter={(account) => account.accountClass === "revenue"} placeholder="None" />
        </Field>
        {taxSelect(draft.salesTaxCode, (code) => set({ salesTaxCode: code }), "Sales tax code", "sales")}
        <Field label="Base unit" hint="What quantities are counted in.">
          <input value={draft.baseUnit} onChange={(event) => set({ baseUnit: event.target.value })} maxLength={30} />
        </Field>
      </div>
      {draft.itemType !== "kit" ? (
        <div className={ui.grid4}>
          <Field label="Purchase price (excl. GST)">
            <input inputMode="decimal" value={draft.purchasePrice} onChange={(event) => set({ purchasePrice: event.target.value })} />
          </Field>
          <Field label="Purchase account">
            <AccountSelect accounts={accounts} value={draft.purchaseAccountCode} onChange={(code) => set({ purchaseAccountCode: code })} filter={(account) => billLineAccountProblem(account) === null} placeholder="None" />
          </Field>
          {taxSelect(draft.purchaseTaxCode, (code) => set({ purchaseTaxCode: code }), "Purchase tax code", "purchases")}
        </div>
      ) : null}
      {activeTaxCodes.length === 0 ? <p className={ui.muted}>There are no active tax codes yet.</p> : null}

      {showUnits && item ? (
        <Card title="Units" description={`Each unit is a fixed number of ${item.baseUnit}. Its size can't change once saved; archive it and add another.`}>
          {item.units.length > 0 ? (
            <table className={ui.table}>
              <tbody>
                {item.units.map((unit) => (
                  <tr key={unit.id}>
                    <td>{unit.name}</td>
                    <td className={ui.num}>
                      {unit.factor} {item.baseUnit}
                    </td>
                    <td>{unit.isActive ? <Badge tone="green">Active</Badge> : <Badge>Archived</Badge>}</td>
                    <td className={ui.num}>
                      <Button size="small" variant="secondary" onClick={() => void toggleUnit(unit.id, !unit.isActive)}>
                        {unit.isActive ? "Archive" : "Restore"}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
          {advanced ? (
            <div className={ui.actions} style={{ alignItems: "end" }}>
              <Field label="Unit name">
                <input value={unitName} onChange={(event) => setUnitName(event.target.value)} maxLength={30} placeholder="Box of 12" />
              </Field>
              <Field label={`How many ${item.baseUnit}`}>
                <input inputMode="decimal" value={unitFactor} onChange={(event) => setUnitFactor(event.target.value)} placeholder="12" />
              </Field>
              <Button size="small" variant="secondary" onClick={() => void addUnit()} disabled={!unitName || !unitFactor}>
                Add unit
              </Button>
            </div>
          ) : null}
          <div className={ui.grid3}>
            <Field label="Sell in">
              <select value={draft.saleUnitId} onChange={(event) => set({ saleUnitId: event.target.value })}>
                <option value="">{item.baseUnit}</option>
                {item.units.filter((unit) => unit.isActive || unit.id === draft.saleUnitId).map((unit) => (
                  <option key={unit.id} value={unit.id}>
                    {unit.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Buy in">
              <select value={draft.purchaseUnitId} onChange={(event) => set({ purchaseUnitId: event.target.value })}>
                <option value="">{item.baseUnit}</option>
                {item.units.filter((unit) => unit.isActive || unit.id === draft.purchaseUnitId).map((unit) => (
                  <option key={unit.id} value={unit.id}>
                    {unit.name}
                  </option>
                ))}
              </select>
            </Field>
          </div>
        </Card>
      ) : !item && advanced ? (
        <p className={ui.muted}>Save the item first to add units like &quot;Box of 12&quot;.</p>
      ) : null}

      {showLevels ? (
        <Card title="Prices for price levels" description="Blank uses the sale price adjusted by the level's percent.">
          <div className={ui.grid4}>
            {priceLevels
              .filter((level) => level.isActive || draft.levelPrices[level.id])
              .map((level) => (
                <Field key={level.id} label={`${level.name} (${level.markupPercent}%)`}>
                  <input
                    inputMode="decimal"
                    disabled={!advanced}
                    value={draft.levelPrices[level.id] ?? ""}
                    onChange={(event) => set({ levelPrices: { ...draft.levelPrices, [level.id]: event.target.value } })}
                  />
                </Field>
              ))}
          </div>
        </Card>
      ) : null}

      {showSuppliers && draft.itemType !== "kit" ? (
        <Card title="Suppliers" description="Their price fills bills from them; otherwise the purchase price is used.">
          {draft.suppliers.map((entry, index) => (
            <div key={index} className={ui.actions} style={{ alignItems: "end" }}>
              <Field label="Supplier">
                <select
                  disabled={!advanced}
                  value={entry.contactId}
                  onChange={(event) => set({ suppliers: draft.suppliers.map((s, i) => (i === index ? { ...s, contactId: event.target.value } : s)) })}
                >
                  <option value="">Choose</option>
                  {suppliers.filter((contact) => !contact.isArchived || contact.id === entry.contactId).map((contact) => (
                    <option key={contact.id} value={contact.id}>
                      {contact.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Their price">
                <input disabled={!advanced} inputMode="decimal" value={entry.price} onChange={(event) => set({ suppliers: draft.suppliers.map((s, i) => (i === index ? { ...s, price: event.target.value } : s)) })} />
              </Field>
              <Field label="Their code">
                <input disabled={!advanced} value={entry.supplierItemCode} maxLength={50} onChange={(event) => set({ suppliers: draft.suppliers.map((s, i) => (i === index ? { ...s, supplierItemCode: event.target.value } : s)) })} />
              </Field>
              <label className={ui.checkbox}>
                <input
                  type="checkbox"
                  disabled={!advanced}
                  checked={entry.isPreferred}
                  onChange={(event) => set({ suppliers: draft.suppliers.map((s, i) => ({ ...s, isPreferred: i === index ? event.target.checked : event.target.checked ? false : s.isPreferred })) })}
                />
                Preferred
              </label>
              {advanced ? (
                <Button size="small" variant="secondary" onClick={() => set({ suppliers: draft.suppliers.filter((_, i) => i !== index) })}>
                  ×
                </Button>
              ) : null}
            </div>
          ))}
          {advanced ? (
            <Button size="small" variant="secondary" onClick={() => set({ suppliers: [...draft.suppliers, { contactId: "", price: "", supplierItemCode: "", isPreferred: draft.suppliers.length === 0 }] })}>
              Add supplier
            </Button>
          ) : null}
        </Card>
      ) : null}

      {draft.itemType === "kit" ? (
        <Card title="What's in the kit" description="Kits can't contain other kits.">
          {draft.components.map((entry, index) => (
            <div key={index} className={ui.actions} style={{ alignItems: "end" }}>
              <Field label="Item">
                <select disabled={!advanced} value={entry.itemId} onChange={(event) => set({ components: draft.components.map((c, i) => (i === index ? { ...c, itemId: event.target.value } : c)) })}>
                  <option value="">Choose</option>
                  {items
                    .filter((other) => other.itemType !== "kit" && other.id !== item?.id && (other.isActive || other.id === entry.itemId))
                    .map((other) => (
                      <option key={other.id} value={other.id}>
                        {other.code} · {other.name}
                      </option>
                    ))}
                </select>
              </Field>
              <Field label="Quantity">
                <input disabled={!advanced} inputMode="decimal" value={entry.quantity} onChange={(event) => set({ components: draft.components.map((c, i) => (i === index ? { ...c, quantity: event.target.value } : c)) })} />
              </Field>
              {advanced ? (
                <Button size="small" variant="secondary" onClick={() => set({ components: draft.components.filter((_, i) => i !== index) })}>
                  ×
                </Button>
              ) : null}
            </div>
          ))}
          {advanced ? (
            <Button size="small" variant="secondary" onClick={() => set({ components: [...draft.components, { itemId: "", quantity: "1" }] })}>
              Add item
            </Button>
          ) : null}
        </Card>
      ) : null}

      <div className={ui.actions}>
        <Button type="submit" disabled={busy}>
          {busy ? "Saving…" : item ? "Save item" : "Add item"}
        </Button>
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

export function ItemsManager({ organisationId }: { organisationId: string }) {
  const { can } = useWorkspace();
  const items = useItems(organisationId);
  const accounts = useAccounts(organisationId);
  const taxCodes = useApiData<{ taxCodes: TaxCode[] }>("/api/tax/codes", { organisationId });
  const contacts = useApiData<{ contacts: Contact[] }>("/api/contacts", { organisationId, includeArchived: "true" });
  const customerSetup = useApiData<CustomerSetup>("/api/customers", { organisationId });
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const error = items.error ?? accounts.error ?? taxCodes.error ?? contacts.error ?? customerSetup.error;
  if (error) return <Notice tone="error">{error}</Notice>;
  if (!items.data || !accounts.data || !taxCodes.data || !contacts.data || !customerSetup.data) return <p className={ui.muted}>Loading…</p>;
  const advanced = items.data.advancedFeatures;
  const list = items.data.items.filter((item) => showArchived || item.isActive);
  const canEdit = can("bookkeeper");
  const form = (item: Item | null) => (
    <ItemForm
      organisationId={organisationId}
      item={item}
      items={items.data!.items}
      advanced={advanced}
      accounts={accounts.data!.accounts}
      taxCodes={taxCodes.data!.taxCodes}
      suppliers={contacts.data!.contacts.filter((contact) => contact.isSupplier)}
      priceLevels={customerSetup.data!.priceLevels}
      onSaved={(saved, text) => {
        setMessage(text);
        items.reload();
        if (!item) setEditing(saved.id);
      }}
      onCancel={() => setEditing(null)}
    />
  );
  const archive = async (item: Item) => {
    try {
      await api(`/api/items/${item.id}`, { method: "PATCH", body: { organisationId, isActive: !item.isActive } });
      setMessage(item.isActive ? `Archived ${item.code}.` : `Restored ${item.code}.`);
      items.reload();
    } catch (caught) {
      setMessage(errorMessage(caught));
    }
  };
  const editingItem = editing && editing !== "new" ? items.data.items.find((item) => item.id === editing) ?? null : null;
  return (
    <>
      {message ? <Notice tone="success">{message}</Notice> : null}
      {editing === "new" ? <Card title="New item">{form(null)}</Card> : null}
      {editingItem ? <Card title={`${editingItem.code} · ${editingItem.name}`}>{form(editingItem)}</Card> : null}
      <Card
        title="Products and services"
        description={
          advanced
            ? "Pick them on invoice, bill and credit note lines. Units, price level prices, supplier prices and kits are on (Advanced reporting)."
            : "Pick them on invoice, bill and credit note lines to fill in the description, price, account and tax code."
        }
        actions={
          canEdit && editing === null ? (
            <Button size="small" onClick={() => setEditing("new")}>
              New item
            </Button>
          ) : null
        }
      >
        <label className={ui.checkbox}>
          <input type="checkbox" checked={showArchived} onChange={(event) => setShowArchived(event.target.checked)} />
          Show archived
        </label>
        {list.length === 0 ? (
          <Empty>No items yet.</Empty>
        ) : (
          <div className={ui.tableWrap}>
            <table className={ui.table}>
              <thead>
                <tr>
                  <th>Code</th>
                  <th>Name</th>
                  <th>Type</th>
                  <th className={ui.num}>Sale price</th>
                  <th className={ui.num}>Purchase price</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {list.map((item) => (
                  <tr key={item.id}>
                    <td>{item.code}</td>
                    <td>
                      {item.name} {item.isActive ? null : <Badge>Archived</Badge>}
                    </td>
                    <td>{ITEM_TYPE_LABELS[item.itemType]}</td>
                    <td className={ui.num}>{item.salePrice ?? ""}</td>
                    <td className={ui.num}>{item.purchasePrice ?? ""}</td>
                    <td className={ui.num}>
                      {canEdit ? (
                        <span className={ui.rowButtons}>
                          <Button size="small" variant="secondary" onClick={() => setEditing(item.id)}>
                            Edit
                          </Button>
                          <Button size="small" variant="secondary" onClick={() => void archive(item)}>
                            {item.isActive ? "Archive" : "Restore"}
                          </Button>
                        </span>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
