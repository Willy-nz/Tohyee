"use client";

import Link from "next/link";
import { type FormEvent, useState } from "react";
import { AccountSelect, useAccounts } from "@/components/books";
import { useApiData } from "@/components/hooks";
import { TrackingSelects, useTracking } from "@/components/tracking";
import { formatRate, InvoiceStatusBadge } from "@/components/invoices/invoice-editor";
import { Button, Field, Notice, Stat, ui } from "@/components/ui";
import type { Account } from "@/lib/accounts/service";
import { billLineAccountProblem } from "@/lib/bills/accounts";
import type { Bill, BillStatus } from "@/lib/bills/service";
import { api, errorMessage, newIdempotencyKey } from "@/lib/client/api";
import type { Contact } from "@/lib/contacts/service";
import { formatMoney, todayInBrowser } from "@/lib/format";
import { AMOUNTS_MODE_LABELS, AMOUNTS_MODES, type AmountsMode, calculateInvoice } from "@/lib/invoices/amounts";
import { currencyMinorUnits } from "@/lib/money/currency";
import { isDecimalString } from "@/lib/money/decimal";
import type { TaxCode } from "@/lib/tax/codes";
import type { TrackingSetup, TrackingTags } from "@/lib/tracking/service";

/** Bills have the same statuses as invoices: draft, approved and voided. */
export function BillStatusBadge({ status }: { status: BillStatus }) {
  return <InvoiceStatusBadge status={status} />;
}

type EditorLine = {
  key: number;
  description: string;
  quantity: string;
  unitPrice: string;
  accountCode: string;
  taxCode: string;
  tracking: TrackingTags;
};

let lineKey = 0;
function nextLineKey(): number {
  lineKey += 1;
  return lineKey;
}

/** New lines have no account, so each cost is put somewhere on purpose. */
function blankLine(taxCode: string): EditorLine {
  return { key: nextLineKey(), description: "", quantity: "1", unitPrice: "", accountCode: "", taxCode, tracking: {} };
}

/** The accounts bill lines can go to, the same rule the server checks. */
function takesBillLines(account: Account): boolean {
  return billLineAccountProblem(account) === null;
}

type FormProps = {
  organisationId: string;
  baseCurrency: string;
  accounts: Account[];
  contacts: Contact[];
  taxCodes: TaxCode[];
  tracking: TrackingSetup;
  bill?: Bill;
  onSaved: (bill: Bill) => void;
  onCancel: () => void;
};

function BillForm({ organisationId, baseCurrency, accounts, contacts, taxCodes, tracking, bill, onSaved, onCancel }: FormProps) {
  const scale = currencyMinorUnits(baseCurrency);
  const activeTaxCodes = taxCodes.filter((taxCode) => taxCode.isActive);
  const defaultTaxCode = (activeTaxCodes.find((taxCode) => taxCode.category === "standard") ?? activeTaxCodes[0])?.code ?? "";
  const [contactId, setContactId] = useState(bill?.contactId ?? "");
  const [supplierInvoiceNumber, setSupplierInvoiceNumber] = useState(bill?.supplierInvoiceNumber ?? "");
  const [billDate, setBillDate] = useState(bill?.billDate ?? todayInBrowser());
  const [dueDate, setDueDate] = useState(bill?.dueDate ?? "");
  const [amountsMode, setAmountsMode] = useState<AmountsMode>(bill?.amountsMode ?? "exclusive");
  const [lines, setLines] = useState<EditorLine[]>(() =>
    bill
      ? bill.lines.map((line) => ({
          key: nextLineKey(),
          description: line.description,
          quantity: line.quantity,
          unitPrice: line.unitPrice,
          accountCode: line.accountCode,
          taxCode: line.taxCode ?? defaultTaxCode,
          tracking: line.tracking ?? {},
        }))
      : [blankLine(defaultTaxCode)],
  );
  // One key per new bill, so a double click or a retry can't save it twice.
  const [idempotencyKey] = useState(() => newIdempotencyKey("bill"));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const hasTax = amountsMode !== "no_tax";
  const rates = new Map(taxCodes.map((taxCode) => [taxCode.code, taxCode.rate]));
  const usable = (value: string) => isDecimalString(value) && !value.trim().startsWith("-");
  // Live totals use the same calculation the server does when it saves.
  const complete = lines.map(
    (line) => usable(line.quantity) && usable(line.unitPrice) && (!hasTax || rates.has(line.taxCode)),
  );
  const amounts = calculateInvoice(
    amountsMode,
    lines.map((line, index) =>
      complete[index]
        ? { quantity: line.quantity, unitPrice: line.unitPrice, taxRate: hasTax ? (rates.get(line.taxCode) ?? "0") : "0" }
        : { quantity: "0", unitPrice: "0", taxRate: "0" },
    ),
    scale,
  );
  const money = (value: string) => formatMoney(value, scale);

  const supplierOptions = contacts.filter((contact) => contact.isSupplier && !contact.isArchived);
  const savedSupplier = bill && !supplierOptions.some((contact) => contact.id === bill.contactId) ? bill : null;

  function update(key: number, patch: Partial<EditorLine>) {
    setLines((current) => current.map((line) => (line.key === key ? { ...line, ...patch } : line)));
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const fields = {
      contactId,
      supplierInvoiceNumber,
      billDate,
      dueDate,
      amountsMode,
      lines: lines.map((line) => ({
        description: line.description,
        quantity: line.quantity,
        unitPrice: line.unitPrice,
        accountCode: line.accountCode,
        taxCode: hasTax ? line.taxCode || null : null,
        tracking: line.tracking,
      })),
    };
    try {
      const result = bill
        ? await api<{ bill: Bill }>(`/api/bills/${bill.id}`, {
            method: "PATCH",
            body: { organisationId, ...fields },
          })
        : await api<{ bill: Bill }>("/api/bills", {
            method: "POST",
            body: { organisationId, source: "ui", idempotencyKey, ...fields },
          });
      onSaved(result.bill);
    } catch (caught) {
      setError(errorMessage(caught));
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(event) => void submit(event)} autoComplete="off" style={{ display: "grid", gap: 14 }}>
      {error ? <Notice tone="error">{error}</Notice> : null}
      {supplierOptions.length === 0 ? (
        <Notice tone="warning">
          There are no suppliers yet. Add one in <Link href="/operations/contacts">Contacts</Link> (tick Supplier) first.
        </Notice>
      ) : null}
      {hasTax && activeTaxCodes.length === 0 ? (
        <Notice tone="warning">
          There are no active tax codes. An admin can add them in <Link href="/operations/tax">Tax codes</Link>, or set
          the amounts to &quot;No tax&quot;.
        </Notice>
      ) : null}
      <div className={ui.grid3}>
        <Field label="Supplier">
          <select value={contactId} onChange={(event) => setContactId(event.target.value)} required>
            <option value="">Choose a supplier</option>
            {savedSupplier ? (
              <option value={savedSupplier.contactId}>{savedSupplier.contactName} (archived or not a supplier)</option>
            ) : null}
            {supplierOptions.map((contact) => (
              <option key={contact.id} value={contact.id}>
                {contact.name}
              </option>
            ))}
          </select>
        </Field>
        <Field
          label="Supplier's invoice number"
          hint="As it's shown on their invoice. A supplier can't have two bills with the same number."
        >
          <input
            value={supplierInvoiceNumber}
            onChange={(event) => setSupplierInvoiceNumber(event.target.value)}
            maxLength={100}
            required
          />
        </Field>
        <Field label="Amounts are">
          <select value={amountsMode} onChange={(event) => setAmountsMode(event.target.value as AmountsMode)}>
            {AMOUNTS_MODES.map((mode) => (
              <option key={mode} value={mode}>
                {AMOUNTS_MODE_LABELS[mode]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Bill date" hint="The date on the supplier's invoice. Approving posts the bill on this date.">
          <input type="date" value={billDate} onChange={(event) => setBillDate(event.target.value)} required />
        </Field>
        <Field label="Due date">
          <input
            type="date"
            value={dueDate}
            min={billDate || undefined}
            onChange={(event) => setDueDate(event.target.value)}
            required
          />
        </Field>
      </div>
      <div className={ui.tableWrap}>
        <table className={`${ui.table} ${ui.stackOnPhone}`}>
          <thead>
            <tr>
              <th style={{ minWidth: 220 }}>Description</th>
              <th className={ui.num} style={{ width: 100 }}>
                Quantity
              </th>
              <th className={ui.num} style={{ width: 130 }}>
                Unit price
              </th>
              <th style={{ width: "20%" }}>Account</th>
              {hasTax ? <th style={{ width: "14%" }}>Tax code</th> : null}
              {hasTax ? <th className={ui.num}>GST</th> : null}
              <th className={ui.num}>
                {amountsMode === "inclusive" ? "Amount (incl. GST)" : amountsMode === "exclusive" ? "Amount (excl. GST)" : "Amount"}
              </th>
              <th style={{ width: 44 }} />
            </tr>
          </thead>
          <tbody>
            {lines.map((line, index) => (
              <tr key={line.key}>
                <td data-label="Description">
                  <input
                    aria-label={`Line ${index + 1} description`}
                    value={line.description}
                    onChange={(event) => update(line.key, { description: event.target.value })}
                    maxLength={500}
                    required
                  />
                </td>
                <td data-label="Quantity">
                  <input
                    aria-label={`Line ${index + 1} quantity`}
                    inputMode="decimal"
                    className={ui.num}
                    value={line.quantity}
                    onChange={(event) => update(line.key, { quantity: event.target.value })}
                    required
                  />
                </td>
                <td data-label="Unit price">
                  <input
                    aria-label={`Line ${index + 1} unit price`}
                    inputMode="decimal"
                    className={ui.num}
                    value={line.unitPrice}
                    onChange={(event) => update(line.key, { unitPrice: event.target.value })}
                    required
                  />
                </td>
                <td data-label="Account">
                  <AccountSelect
                    ariaLabel={`Line ${index + 1} account`}
                    accounts={accounts}
                    filter={takesBillLines}
                    value={line.accountCode}
                    onChange={(code) => update(line.key, { accountCode: code })}
                    required
                  />
                  <TrackingSelects
                    setup={tracking}
                    labelPrefix={`Line ${index + 1}`}
                    value={line.tracking}
                    onChange={(tags) => update(line.key, { tracking: tags })}
                  />
                </td>
                {hasTax ? (
                  <td data-label="Tax code">
                    <select
                      aria-label={`Line ${index + 1} tax code`}
                      value={line.taxCode}
                      onChange={(event) => update(line.key, { taxCode: event.target.value })}
                      required
                    >
                      <option value="">Choose</option>
                      {taxCodes
                        .filter((taxCode) => taxCode.isActive || taxCode.code === line.taxCode)
                        .map((taxCode) => (
                          <option key={taxCode.id} value={taxCode.code}>
                            {taxCode.code} ({formatRate(taxCode.rate)}){taxCode.isActive ? "" : " (inactive)"}
                          </option>
                        ))}
                    </select>
                  </td>
                ) : null}
                {hasTax ? <td data-label="GST" className={ui.num}>{complete[index] ? money(amounts.lines[index].taxAmount) : ""}</td> : null}
                <td data-label="Amount" className={ui.num}>{complete[index] ? money(amounts.lines[index].lineAmount) : ""}</td>
                <td data-label="">
                  <Button
                    variant="secondary"
                    size="small"
                    aria-label={`Remove line ${index + 1}`}
                    disabled={lines.length <= 1}
                    onClick={() => setLines((current) => current.filter((entry) => entry.key !== line.key))}
                  >
                    ×
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={hasTax ? 8 : 6}>
                <Button
                  variant="secondary"
                  size="small"
                  onClick={() => setLines((current) => [...current, blankLine(defaultTaxCode)])}
                >
                  Add line
                </Button>
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
      <div className={ui.statRow} aria-live="polite">
        <Stat label={hasTax ? "Subtotal (excl. GST)" : "Subtotal"} value={money(amounts.subtotal)} />
        {hasTax ? <Stat label="GST" value={money(amounts.taxTotal)} /> : null}
        <Stat label={`Total (${baseCurrency})`} value={money(amounts.total)} />
      </div>
      <div className={ui.actions}>
        <Button type="submit" disabled={busy}>
          {busy ? "Saving…" : "Save draft"}
        </Button>
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <span className={ui.muted}>A draft posts nothing. Approve it to post it to the ledger.</span>
      </div>
    </form>
  );
}

/**
 * Creates a draft bill, or edits one when `bill` is given. Loads the
 * suppliers, the accounts bill lines can go to and the tax codes to choose from.
 */
export function BillEditor({
  organisationId,
  baseCurrency,
  bill,
  onSaved,
  onCancel,
}: {
  organisationId: string;
  baseCurrency: string;
  bill?: Bill;
  onSaved: (bill: Bill) => void;
  onCancel: () => void;
}) {
  const accounts = useAccounts(organisationId);
  const contacts = useApiData<{ contacts: Contact[] }>("/api/contacts", { organisationId });
  const taxCodes = useApiData<{ taxCodes: TaxCode[] }>("/api/tax/codes", { organisationId });
  const tracking = useTracking(organisationId);
  const error = accounts.error ?? contacts.error ?? taxCodes.error ?? tracking.error;
  if (error) {
    return <Notice tone="error">{error}</Notice>;
  }
  if (!accounts.data || !contacts.data || !taxCodes.data || !tracking.data) {
    return <p className={ui.muted}>Loading…</p>;
  }
  return (
    <BillForm
      organisationId={organisationId}
      baseCurrency={baseCurrency}
      accounts={accounts.data.accounts}
      contacts={contacts.data.contacts}
      taxCodes={taxCodes.data.taxCodes}
      tracking={tracking.data}
      bill={bill}
      onSaved={onSaved}
      onCancel={onCancel}
    />
  );
}
