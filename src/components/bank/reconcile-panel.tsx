"use client";

import Link from "next/link";
import { type FormEvent, type ReactNode, useState } from "react";
import {
  centsToText,
  InOutCells,
  isStatementAccount,
  journalHref,
  LineDetails,
  originLabel,
  takesBankTransactionLines,
  toCents,
} from "@/components/bank/common";
import { CashCodingForm } from "@/components/bank/cash-coding";
import { LineBaseValue, RateField } from "@/components/bank/foreign";
import { OkAllBar, SuggestionBox } from "@/components/bank/confident";
import { AccountSelect, Money } from "@/components/books";
import { useApiData } from "@/components/hooks";
import { CustomFieldInputs, startingValues, useCustomFields } from "@/components/custom-fields";
import { TrackingSelects, useTracking } from "@/components/tracking";
import { formatRate } from "@/components/invoices/invoice-editor";
import { Badge, Button, Empty, Field, Notice, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import type { Account } from "@/lib/accounts/service";
import type { BankAccount, StatementLine } from "@/lib/bank/accounts";
import type { LineConfidence } from "@/lib/bank/confident";
import type { LineSuggestions } from "@/lib/bank/reconcile";
import type { BillSummary } from "@/lib/bills/service";
import { api, errorMessage, newIdempotencyKey } from "@/lib/client/api";
import type { Contact } from "@/lib/contacts/service";
import { formatDate, formatMoney } from "@/lib/format";
import { AMOUNTS_MODE_LABELS, AMOUNTS_MODES, type AmountsMode, calculateInvoice } from "@/lib/invoices/amounts";
import type { InvoiceSummary } from "@/lib/invoices/service";
import { isDecimalString } from "@/lib/money/decimal";
import { isRateText } from "@/lib/money/fx";
import type { TaxCode } from "@/lib/tax/codes";
import { isAvailableOn } from "@/lib/tax/available-on";
import { retaxLines } from "@/lib/tax/exports";
import { contactPurchaseTaxCode } from "@/lib/tax/purchase-defaults";
import type { CustomFieldSetup, CustomValues } from "@/lib/custom-fields/values";
import type { TrackingSetup, TrackingTags } from "@/lib/tracking/service";

const PAGE_SIZE = 50;

type Mode = "match" | "split" | "payments" | "bank_transaction" | "transfer";

type Lookups = {
  accounts: Account[];
  contacts: Contact[];
  taxCodes: TaxCode[];
  tracking: TrackingSetup;
  customSetup: CustomFieldSetup;
  /** The organisation's base currency: lines in another currency are a foreign-currency account's (FXB1-FXB11). */
  baseCurrency: string;
};

type Submit = (command: Record<string, unknown>) => Promise<void>;

function useCommand(organisationId: string, line: StatementLine, onDone: () => void) {
  // One key per line being reconciled, so a double click or retry can't post twice.
  const [key, setKey] = useState(() => newIdempotencyKey("reconcile"));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit: Submit = async (command) => {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/statement-lines/${line.id}/reconcile`, {
        method: "POST",
        body: { organisationId, source: "ui", idempotencyKey: key, ...command },
      });
      onDone();
    } catch (caught) {
      setError(errorMessage(caught));
      // A different command next time needs a different key.
      setKey(newIdempotencyKey("reconcile"));
    } finally {
      setBusy(false);
    }
  };
  return { submit, busy, error, setError };
}

function TotalCheck({ total, target }: { total: bigint | null; target: string }) {
  const targetCents = toCents(target);
  if (total === null || targetCents === null) return null;
  const difference = targetCents - total;
  return (
    <p className={difference === BigInt(0) ? undefined : ui.muted}>
      Total {formatMoney(centsToText(total))} of {formatMoney(target)}
      {difference === BigInt(0) ? (
        <>
          {" "}
          <Badge tone="green">Matches the line</Badge>
        </>
      ) : (
        ` (${formatMoney(centsToText(difference < BigInt(0) ? -difference : difference))} ${difference > BigInt(0) ? "short" : "over"})`
      )}
    </p>
  );
}

type AdjustmentValue = { accountCode: string; taxCode: string; description: string; contactId: string };
const NO_ADJUSTMENT: AdjustmentValue = { accountCode: "", taxCode: "", description: "", contactId: "" };

/**
 * A small difference between the line and what it's matched with or pays,
 * recorded in the same step as spend or receive money to a chosen account
 * (examples BK24, BK25). `difference` is the line less the total, signed like
 * the line.
 */
function AdjustmentFields({
  difference,
  value,
  onChange,
  lookups,
  contactHint,
}: {
  difference: bigint;
  value: AdjustmentValue;
  onChange: (value: AdjustmentValue) => void;
  lookups: Lookups;
  /** Where the contact comes from when none is chosen; without it a contact is required. */
  contactHint?: string;
}) {
  const unsigned = centsToText(difference < BigInt(0) ? -difference : difference);
  // Spend money is purchases, receive money sales: only codes available on that side (TAO8).
  const side = difference < BigInt(0) ? "purchases" : "sales";
  const activeTaxCodes = lookups.taxCodes.filter((taxCode) => taxCode.isActive && isAvailableOn(taxCode.availableOn, side));
  return (
    <div className={ui.suggestion} style={{ display: "grid", gap: 8 }}>
      <span>
        Record the {formatMoney(unsigned)} difference as an adjustment: {difference < BigInt(0) ? "spend money" : "receive money"} of{" "}
        {formatMoney(unsigned)} on the line&apos;s date, reconciled with the rest, so the line ties exactly.
      </span>
      <div className={ui.grid2}>
        <Field label="Adjustment account">
          <AccountSelect
            accounts={lookups.accounts}
            filter={takesBankTransactionLines}
            value={value.accountCode}
            onChange={(accountCode) => onChange({ ...value, accountCode })}
            required
          />
        </Field>
        <Field label="GST" hint="With a GST code the difference includes GST.">
          <select value={value.taxCode} onChange={(event) => onChange({ ...value, taxCode: event.target.value })}>
            <option value="">No GST</option>
            {activeTaxCodes.map((taxCode) => (
              <option key={taxCode.id} value={taxCode.code}>
                {taxCode.code} ({formatRate(taxCode.rate)})
              </option>
            ))}
          </select>
        </Field>
        <Field label="Description">
          <input
            value={value.description}
            placeholder="Adjustment"
            onChange={(event) => onChange({ ...value, description: event.target.value })}
            maxLength={500}
          />
        </Field>
        <Field label="Contact">
          <select value={value.contactId} onChange={(event) => onChange({ ...value, contactId: event.target.value })} required={!contactHint}>
            <option value="">{contactHint ?? "Choose a contact"}</option>
            {lookups.contacts
              .filter((contact) => !contact.isArchived)
              .map((contact) => (
                <option key={contact.id} value={contact.id}>
                  {contact.name}
                </option>
              ))}
          </select>
        </Field>
      </div>
    </div>
  );
}

/** The adjustment to send, or undefined when there's no difference. */
function adjustmentCommand(difference: bigint | null, value: AdjustmentValue): Record<string, unknown> | undefined {
  if (difference === null || difference === BigInt(0)) return undefined;
  return {
    accountCode: value.accountCode,
    taxCode: value.taxCode || undefined,
    description: value.description.trim() || undefined,
    contactId: value.contactId || undefined,
  };
}

function MatchForm({
  line,
  suggestions,
  lookups,
  submit,
  busy,
}: {
  line: StatementLine;
  suggestions: LineSuggestions;
  lookups: Lookups;
  submit: Submit;
  busy: boolean;
}) {
  const [adjustment, setAdjustment] = useState<AdjustmentValue>(NO_ADJUSTMENT);
  const [chosen, setChosen] = useState<string[]>(() => {
    const exact = suggestions.matches.find((match) => match.exact && !match.voided);
    return exact ? [exact.journalLineId] : [];
  });
  if (suggestions.matches.length === 0) {
    return (
      <Empty>
        Nothing posted on this account within 60 days of the line is waiting to be matched. Pay an invoice or bill, or create a
        bank transaction instead.
      </Empty>
    );
  }
  const total = suggestions.matches
    .filter((match) => chosen.includes(match.journalLineId))
    .reduce((sum, match) => sum + (toCents(match.amount) ?? BigInt(0)), BigInt(0));
  const lineCents = toCents(line.amount);
  const difference = chosen.length > 0 && lineCents !== null ? lineCents - total : null;
  const needsAdjustment = difference !== null && difference !== BigInt(0);
  const foreign = line.currencyCode !== lookups.baseCurrency;
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void submit({ kind: "match", journalLineIds: chosen, adjustment: adjustmentCommand(difference, adjustment) });
      }}
      style={{ display: "grid", gap: 10 }}
    >
      <p className={ui.muted}>Already posted in Tohyee and not yet reconciled. Tick what this line is (several can add up to it).</p>
      <div className={ui.tableWrap}>
        <table className={ui.table}>
          <thead>
            <tr>
              <th style={{ width: 36 }} />
              <th>Date</th>
              <th>What</th>
              <th>Reference</th>
              <th className={ui.num}>Amount</th>
            </tr>
          </thead>
          <tbody>
            {suggestions.matches.map((match) => (
              <tr key={match.journalLineId}>
                <td>
                  <input
                    type="checkbox"
                    aria-label={`Match journal ${match.journalId}`}
                    checked={chosen.includes(match.journalLineId)}
                    onChange={(event) =>
                      setChosen((current) =>
                        event.target.checked ? [...current, match.journalLineId] : current.filter((id) => id !== match.journalLineId),
                      )
                    }
                  />
                </td>
                <td>{formatDate(match.postingDate)}</td>
                <td>
                  {originLabel(match.origin)} <Link href={journalHref(match.journalId)}>#{match.journalId}</Link>
                  {match.voided ? <> <Badge tone="amber">Voided</Badge></> : null}
                  {match.description ? <div className={ui.muted}>{match.description}</div> : null}
                </td>
                <td>{match.reference}</td>
                <td className={ui.num}>
                  <Money value={match.amount} /> {match.exact ? <Badge tone="green">Same amount</Badge> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <TotalCheck total={total} target={line.amount} />
      {needsAdjustment && foreign ? (
        <Notice tone="warning">
          Adjustments aren&apos;t available on {line.currencyCode} lines yet. Record the difference as its own spend or receive money
          first, then match both.
        </Notice>
      ) : needsAdjustment ? (
        <AdjustmentFields difference={difference} value={adjustment} onChange={setAdjustment} lookups={lookups} />
      ) : null}
      <div className={ui.actions}>
        <Button
          type="submit"
          disabled={busy || chosen.length === 0 || (needsAdjustment && (foreign || !adjustment.accountCode || !adjustment.contactId))}
        >
          {busy ? "Reconciling…" : needsAdjustment ? "Match with adjustment" : "Match"}
        </Button>
      </div>
    </form>
  );
}

/**
 * One posted transaction that the bank shows as several lines (examples
 * BK26-BK28): pick the transaction, then the other unreconciled lines on this
 * page that make it up with this one. They must add up to it exactly.
 */
function SplitForm({
  line,
  otherLines,
  suggestions,
  submit,
  busy,
}: {
  line: StatementLine;
  otherLines: StatementLine[];
  suggestions: LineSuggestions;
  submit: Submit;
  busy: boolean;
}) {
  const lineCents = toCents(line.amount) ?? BigInt(0);
  const magnitude = (value: bigint) => (value < BigInt(0) ? -value : value);
  // Only transactions bigger than the line can be split across it and others.
  const bigger = suggestions.matches.filter((match) => magnitude(toCents(match.amount) ?? BigInt(0)) > magnitude(lineCents));
  const sameWay = otherLines.filter((other) => other.id !== line.id && other.amount.startsWith("-") === line.amount.startsWith("-"));
  const [journalLineId, setJournalLineId] = useState(bigger.find((match) => !match.voided)?.journalLineId ?? "");
  const [chosen, setChosen] = useState<string[]>([]);
  if (bigger.length === 0) {
    return (
      <Empty>
        Nothing posted on this account within 60 days of the line is bigger than it, so there&apos;s nothing to split across several
        lines. Match it instead.
      </Empty>
    );
  }
  const target = bigger.find((match) => match.journalLineId === journalLineId);
  const total = sameWay.filter((other) => chosen.includes(other.id)).reduce((sum, other) => sum + (toCents(other.amount) ?? BigInt(0)), lineCents);
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void submit({ kind: "split", journalLineId, otherLineIds: chosen });
      }}
      style={{ display: "grid", gap: 10 }}
    >
      <p className={ui.muted}>
        When the bank shows one transaction as several lines. Choose the transaction, then tick the other lines that make it up with
        this one. Nothing is posted, and the lines are unreconciled together.
      </p>
      <Field label="Transaction">
        <select value={journalLineId} onChange={(event) => setJournalLineId(event.target.value)} required>
          <option value="">Choose the transaction</option>
          {bigger.map((match) => (
            <option key={match.journalLineId} value={match.journalLineId}>
              {formatDate(match.postingDate)} · {originLabel(match.origin)} #{match.journalId} · {match.reference} · {formatMoney(match.amount)}
              {match.voided ? " · voided" : ""}
            </option>
          ))}
        </select>
      </Field>
      {sameWay.length === 0 ? (
        <Empty>No other unreconciled lines on this page go the same way as this one.</Empty>
      ) : (
        <div className={ui.tableWrap}>
          <table className={ui.table}>
            <thead>
              <tr>
                <th style={{ width: 36 }} />
                <th>Date</th>
                <th>Description</th>
                <th className={ui.num}>Amount</th>
              </tr>
            </thead>
            <tbody>
              {sameWay.map((other) => (
                <tr key={other.id}>
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`Include ${formatDate(other.date)} ${other.description}`}
                      checked={chosen.includes(other.id)}
                      onChange={(event) =>
                        setChosen((current) => (event.target.checked ? [...current, other.id] : current.filter((id) => id !== other.id)))
                      }
                    />
                  </td>
                  <td>{formatDate(other.date)}</td>
                  <td>{other.description}</td>
                  <td className={ui.num}>
                    <Money value={other.amount} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {target ? <TotalCheck total={total} target={target.amount} /> : null}
      <div className={ui.actions}>
        <Button type="submit" disabled={busy || chosen.length === 0 || !target || toCents(target.amount) !== total}>
          {busy ? "Reconciling…" : "Reconcile these lines together"}
        </Button>
      </div>
    </form>
  );
}

function PaymentsForm({
  organisationId,
  line,
  suggestions,
  lookups,
  submit,
  busy,
}: {
  organisationId: string;
  line: StatementLine;
  suggestions: LineSuggestions;
  lookups: Lookups;
  submit: Submit;
  busy: boolean;
}) {
  const contacts = lookups.contacts;
  const [adjustment, setAdjustment] = useState<AdjustmentValue>(NO_ADJUSTMENT);
  const { current } = useWorkspace();
  const moneyIn = !line.amount.startsWith("-");
  const unsigned = line.amount.replace(/^-/, "");
  const noun = moneyIn ? "invoice" : "bill";
  const [contactId, setContactId] = useState("");
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const invoices = useApiData<{ invoices: InvoiceSummary[] }>(moneyIn && contactId ? "/api/invoices" : null, {
    organisationId,
    contactId,
    awaitingPayment: "true",
    limit: "200",
  });
  const bills = useApiData<{ bills: BillSummary[] }>(!moneyIn && contactId ? "/api/bills" : null, {
    organisationId,
    contactId,
    awaitingPayment: "true",
    limit: "200",
  });
  // A line pays documents in its own currency (MC5): a USD line pays USD invoices and bills, at a rate.
  const base = line.currencyCode ?? current?.baseCurrency;
  const foreign = line.currencyCode !== lookups.baseCurrency;
  const [rate, setRate] = useState(line.suggestedRate?.rate ?? "");
  const documents = moneyIn
    ? (invoices.data?.invoices ?? [])
        .filter((invoice) => invoice.currencyCode === base)
        .map((invoice) => ({ id: invoice.id, number: invoice.invoiceNumber ?? "Invoice", date: invoice.invoiceDate, amountDue: invoice.amountDue ?? "0" }))
    : (bills.data?.bills ?? [])
        .filter((bill) => bill.currencyCode === base)
        .map((bill) => ({ id: bill.id, number: bill.supplierInvoiceNumber, date: bill.billDate, amountDue: bill.amountDue ?? "0" }));
  const loading = contactId !== "" && (moneyIn ? invoices.loading : bills.loading);
  const loadError = moneyIn ? invoices.error : bills.error;
  const options = contacts.filter((contact) => !contact.isArchived && (moneyIn ? contact.isCustomer : contact.isSupplier));

  const entered = Object.entries(amounts).filter(([, amount]) => amount.trim() !== "");
  const allValid = entered.every(([, amount]) => toCents(amount) !== null);
  const total = allValid ? entered.reduce((sum, [, amount]) => sum + (toCents(amount) ?? BigInt(0)), BigInt(0)) : null;
  const allocation = (id: string, amount: string) => (moneyIn ? { invoiceId: id, amount } : { billId: id, amount });
  const unsignedCents = toCents(unsigned);
  // The line less the payments, signed like the line.
  const difference =
    total !== null && entered.length > 0 && unsignedCents !== null ? (moneyIn ? unsignedCents - total : total - unsignedCents) : null;
  const needsAdjustment = difference !== null && difference !== BigInt(0);

  function submitChosen(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void submit({
      kind: "payments",
      allocations: entered.map(([id, amount]) => allocation(id, amount.trim())),
      adjustment: adjustmentCommand(difference, adjustment),
      ...(foreign ? { exchangeRate: rate.trim() } : {}),
    });
  }

  return (
    <div style={{ display: "grid", gap: 12 }}>
      {suggestions.documents.length > 0 ? (
        <div style={{ display: "grid", gap: 8 }}>
          <p className={ui.muted}>
            {suggestions.documents.length === 1 ? `This ${noun} has` : `These ${noun}s have`} exactly {formatMoney(unsigned)} due:
          </p>
          <div className={ui.actions} style={{ justifyContent: "flex-start", flexWrap: "wrap" }}>
            {suggestions.documents.map((document) => (
              <Button
                key={document.id}
                variant="secondary"
                disabled={busy}
                onClick={() =>
                  void submit({ kind: "payments", allocations: [allocation(document.id, document.amountDue)], ...(foreign ? { exchangeRate: rate.trim() } : {}) })
                }
              >
                Pay {document.number} · {document.contactName} · {formatDate(document.date)}
              </Button>
            ))}
          </div>
        </div>
      ) : null}
      {foreign ? (
        <RateField
          currency={line.currencyCode}
          baseCurrency={lookups.baseCurrency}
          rate={rate}
          onChange={setRate}
          amount={unsigned}
          suggested={line.suggestedRate}
        />
      ) : null}
      <Field label={moneyIn ? "Customer" : "Supplier"} hint={`Pay one or more of their approved ${noun}s from this line.`}>
        <select
          value={contactId}
          onChange={(event) => {
            setContactId(event.target.value);
            setAmounts({});
          }}
        >
          <option value="">Choose</option>
          {options.map((contact) => (
            <option key={contact.id} value={contact.id}>
              {contact.name}
            </option>
          ))}
        </select>
      </Field>
      {loadError ? <Notice tone="error">{loadError}</Notice> : null}
      {loading ? <p className={ui.muted}>Loading…</p> : null}
      {contactId && !loading && !loadError && documents.length === 0 ? (
        <Empty>
          No approved {base} {noun}s with an amount due for this {moneyIn ? "customer" : "supplier"}.
        </Empty>
      ) : null}
      {documents.length > 0 ? (
        <form onSubmit={submitChosen} style={{ display: "grid", gap: 10 }} autoComplete="off">
          <div className={ui.tableWrap}>
            <table className={ui.table}>
              <thead>
                <tr>
                  <th>{moneyIn ? "Invoice" : "Supplier's invoice number"}</th>
                  <th>Date</th>
                  <th className={ui.num}>Amount due</th>
                  <th className={ui.num} style={{ width: 150 }}>
                    Pay
                  </th>
                </tr>
              </thead>
              <tbody>
                {documents.map((document) => (
                  <tr key={document.id}>
                    <td>
                      <Link href={`/operations/${moneyIn ? "invoices" : "bills"}/${document.id}`}>{document.number}</Link>
                    </td>
                    <td>{formatDate(document.date)}</td>
                    <td className={ui.num}>
                      <button
                        type="button"
                        className={ui.linkButton}
                        onClick={() => setAmounts((current) => ({ ...current, [document.id]: document.amountDue }))}
                        title="Pay the full amount due"
                      >
                        {formatMoney(document.amountDue)}
                      </button>
                    </td>
                    <td>
                      <input
                        aria-label={`Amount to pay on ${document.number}`}
                        inputMode="decimal"
                        className={ui.num}
                        value={amounts[document.id] ?? ""}
                        onChange={(event) => setAmounts((current) => ({ ...current, [document.id]: event.target.value }))}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <TotalCheck total={total} target={unsigned} />
          {needsAdjustment ? (
            <AdjustmentFields
              difference={difference}
              value={adjustment}
              onChange={setAdjustment}
              lookups={lookups}
              contactHint={moneyIn ? "The invoice's customer" : "The bill's supplier"}
            />
          ) : null}
          <div className={ui.actions}>
            <Button type="submit" disabled={busy || entered.length === 0 || (needsAdjustment && !adjustment.accountCode)}>
              {busy
                ? "Reconciling…"
                : `Record ${entered.length === 1 ? "payment" : "payments"}${needsAdjustment ? " and adjustment" : ""} and reconcile`}
            </Button>
          </div>
        </form>
      ) : null}
    </div>
  );
}

type EditorLine = {
  key: number;
  description: string;
  accountCode: string;
  taxCode: string;
  amount: string;
  tracking: TrackingTags;
  customFields: CustomValues;
  /** The organisation's usual code, before the contact's default purchase tax code (EX23). */
  usualTaxCode?: string;
  /** Chosen by hand or by a bank rule: the contact's default leaves it alone. */
  taxTyped?: boolean;
};
let lineKey = 0;

function BankTransactionForm({
  organisationId,
  account,
  line,
  suggestions,
  lookups,
  submit,
  busy,
}: {
  organisationId: string;
  account: BankAccount;
  line: StatementLine;
  suggestions: LineSuggestions;
  lookups: Lookups;
  submit: Submit;
  busy: boolean;
}) {
  const moneyIn = !line.amount.startsWith("-");
  const unsigned = line.amount.replace(/^-/, "");
  const rule = suggestions.rule;
  // A foreign-currency line (FXB2-FXB4): converted at a rate, and only zero-rated, exempt or no-GST codes.
  const foreign = line.currencyCode !== lookups.baseCurrency;
  // Receive money is sales, spend money purchases: only codes available on that side (TAO8).
  const usableTaxCode = (taxCode: TaxCode) =>
    (!foreign || taxCode.category !== "standard") && isAvailableOn(taxCode.availableOn, moneyIn ? "sales" : "purchases");
  const activeTaxCodes = lookups.taxCodes.filter((taxCode) => taxCode.isActive && usableTaxCode(taxCode));
  const defaultTaxCode = (activeTaxCodes.find((taxCode) => taxCode.category === "standard") ?? activeTaxCodes[0])?.code ?? "";
  const [contactId, setContactId] = useState(rule?.contactId ?? "");
  // Spend money starts with the contact's default purchase tax code, if it's one the line can take (EX23).
  const contactTaxCode = (id: string) =>
    moneyIn ? null : contactPurchaseTaxCode(lookups.contacts.find((contact) => contact.id === id), activeTaxCodes);
  const [reference, setReference] = useState(line.reference ?? line.particulars ?? "");
  const [amountsMode, setAmountsMode] = useState<AmountsMode>(rule?.amountsMode ?? (foreign ? "no_tax" : "inclusive"));
  const [rate, setRate] = useState(line.suggestedRate?.rate ?? "");
  const kind = moneyIn ? "receive" : "spend";
  const lineDefaults = startingValues(lookups.customSetup, "line", [kind]);
  const [customFields, setCustomFields] = useState<CustomValues>(() => startingValues(lookups.customSetup, "document", [kind]));
  const [lines, setLines] = useState<EditorLine[]>(() => [
    {
      key: ++lineKey,
      description: rule?.suggestedLine.description ?? line.description,
      accountCode: rule?.suggestedLine.accountCode ?? "",
      taxCode: rule?.suggestedLine.taxCode ?? contactTaxCode(rule?.contactId ?? "") ?? defaultTaxCode,
      usualTaxCode: defaultTaxCode,
      taxTyped: Boolean(rule?.suggestedLine.taxCode),
      amount: unsigned,
      tracking: {},
      customFields: lineDefaults,
    },
  ]);
  const [saveRule, setSaveRule] = useState(false);
  const [ruleText, setRuleText] = useState(line.payee ?? line.description);
  const [ruleError, setRuleError] = useState<string | null>(null);

  const hasTax = amountsMode !== "no_tax";
  const rates = new Map(lookups.taxCodes.map((taxCode) => [taxCode.code, taxCode.rate]));
  const complete = lines.map((entry) => isDecimalString(entry.amount) && (!hasTax || rates.has(entry.taxCode)));
  const amounts = calculateInvoice(
    amountsMode,
    lines.map((entry, index) =>
      complete[index]
        ? { quantity: "1", unitPrice: entry.amount, taxRate: hasTax ? (rates.get(entry.taxCode) ?? "0") : "0" }
        : { quantity: "0", unitPrice: "0", taxRate: "0" },
    ),
    2,
  );
  const total = complete.every(Boolean) ? toCents(amounts.total) : null;
  const contacts = lookups.contacts.filter((contact) => !contact.isArchived);

  function update(key: number, patch: Partial<EditorLine>) {
    setLines((current) => current.map((entry) => (entry.key === key ? { ...entry, ...patch } : entry)));
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setRuleError(null);
    await submit({
      kind: "bank_transaction",
      ...(foreign ? { exchangeRate: rate.trim() } : {}),
      contactId,
      reference: reference || undefined,
      amountsMode,
      lines: lines.map((entry) => ({
        description: entry.description,
        accountCode: entry.accountCode,
        taxCode: hasTax ? entry.taxCode : undefined,
        amount: entry.amount.trim(),
        tracking: entry.tracking,
        customFields: entry.customFields,
      })),
      customFields,
    });
    if (saveRule && ruleText.trim()) {
      try {
        await api("/api/bank-rules", {
          method: "POST",
          body: {
            organisationId,
            name: ruleText.trim().slice(0, 100),
            accountId: account.id,
            direction: moneyIn ? "in" : "out",
            matchField: "any",
            matchText: ruleText.trim(),
            contactId,
            targetAccountCode: lines[0].accountCode,
            taxCode: hasTax ? lines[0].taxCode : undefined,
            amountsMode,
          },
        });
      } catch (caught) {
        setRuleError(`The line is reconciled, but the rule wasn't saved: ${errorMessage(caught)}`);
      }
    }
  }

  return (
    <form onSubmit={(event) => void onSubmit(event)} style={{ display: "grid", gap: 12 }} autoComplete="off">
      {rule ? (
        <Notice tone="info">
          Filled in by the bank rule “{rule.name}”. Check it before saving.
        </Notice>
      ) : null}
      {ruleError ? <Notice tone="warning">{ruleError}</Notice> : null}
      <p className={ui.muted}>
        {moneyIn ? "Receive money" : "Spend money"}: posts the line straight to the accounts you choose, with GST from the tax codes,
        on the line&apos;s date ({formatDate(line.date)}).
      </p>
      <div className={ui.grid3}>
        <Field label={moneyIn ? "Received from" : "Paid to"}>
          <select
            value={contactId}
            onChange={(event) => {
              setContactId(event.target.value);
              setLines((current) => retaxLines(current, contactTaxCode(event.target.value)));
            }}
            required
          >
            <option value="">Choose a contact</option>
            {contacts.map((contact) => (
              <option key={contact.id} value={contact.id}>
                {contact.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Reference">
          <input value={reference} onChange={(event) => setReference(event.target.value)} maxLength={100} />
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
      </div>
      {foreign ? (
        <RateField
          currency={line.currencyCode}
          baseCurrency={lookups.baseCurrency}
          rate={rate}
          onChange={setRate}
          amount={unsigned}
          suggested={line.suggestedRate}
        />
      ) : null}
      {foreign ? (
        <p className={ui.muted}>
          Amounts are in {line.currencyCode}. GST on {line.currencyCode} transactions isn&apos;t supported yet, so only zero-rated,
          exempt and no-GST codes are listed.
        </p>
      ) : null}
      <CustomFieldInputs setup={lookups.customSetup} record="document" uses={[kind]} value={customFields} onChange={setCustomFields} />
      <div className={ui.tableWrap}>
        <table className={ui.table}>
          <thead>
            <tr>
              <th style={{ minWidth: 200 }}>Description</th>
              <th style={{ width: "26%" }}>Account</th>
              {hasTax ? <th style={{ width: "16%" }}>Tax code</th> : null}
              {hasTax ? <th className={ui.num}>GST</th> : null}
              <th className={ui.num} style={{ width: 140 }}>
                {amountsMode === "inclusive" ? "Amount (incl. GST)" : amountsMode === "exclusive" ? "Amount (excl. GST)" : "Amount"}
              </th>
              <th style={{ width: 44 }} />
            </tr>
          </thead>
          <tbody>
            {lines.map((entry, index) => (
              <tr key={entry.key}>
                <td>
                  <input
                    aria-label={`Line ${index + 1} description`}
                    value={entry.description}
                    onChange={(event) => update(entry.key, { description: event.target.value })}
                    maxLength={500}
                    required
                  />
                </td>
                <td>
                  <AccountSelect
                    ariaLabel={`Line ${index + 1} account`}
                    accounts={lookups.accounts}
                    filter={takesBankTransactionLines}
                    value={entry.accountCode}
                    onChange={(code) => update(entry.key, { accountCode: code })}
                    required
                  />
                  <TrackingSelects
                    setup={lookups.tracking}
                    labelPrefix={`Line ${index + 1}`}
                    value={entry.tracking}
                    onChange={(tags) => update(entry.key, { tracking: tags })}
                  />
                  <CustomFieldInputs
                    compact
                    setup={lookups.customSetup}
                    record="line"
                    uses={[kind]}
                    labelPrefix={`Line ${index + 1}`}
                    value={entry.customFields}
                    onChange={(values) => update(entry.key, { customFields: values })}
                  />
                </td>
                {hasTax ? (
                  <td>
                    <select
                      aria-label={`Line ${index + 1} tax code`}
                      value={entry.taxCode}
                      onChange={(event) => update(entry.key, { taxCode: event.target.value, taxTyped: true })}
                      required
                    >
                      <option value="">Choose</option>
                      {lookups.taxCodes
                        .filter((taxCode) => (taxCode.isActive && usableTaxCode(taxCode)) || taxCode.code === entry.taxCode)
                        .map((taxCode) => (
                          <option key={taxCode.id} value={taxCode.code}>
                            {taxCode.code} ({formatRate(taxCode.rate)})
                          </option>
                        ))}
                    </select>
                  </td>
                ) : null}
                {hasTax ? <td className={ui.num}>{complete[index] ? formatMoney(amounts.lines[index].taxAmount) : ""}</td> : null}
                <td>
                  <input
                    aria-label={`Line ${index + 1} amount`}
                    inputMode="decimal"
                    className={ui.num}
                    value={entry.amount}
                    onChange={(event) => update(entry.key, { amount: event.target.value })}
                    required
                  />
                </td>
                <td>
                  {lines.length > 1 ? (
                    <Button
                      variant="secondary"
                      size="small"
                      aria-label={`Remove line ${index + 1}`}
                      onClick={() => setLines((current) => current.filter((other) => other.key !== entry.key))}
                    >
                      ×
                    </Button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div>
        <Button
          variant="secondary"
          size="small"
          onClick={() =>
            setLines((current) => [
              ...current,
              {
                key: ++lineKey,
                description: line.description,
                accountCode: "",
                taxCode: contactTaxCode(contactId) ?? defaultTaxCode,
                usualTaxCode: defaultTaxCode,
                amount: "",
                tracking: {},
                customFields: lineDefaults,
              },
            ])
          }
        >
          Add a line
        </Button>
      </div>
      <TotalCheck total={total} target={unsigned} />
      {hasTax && complete.every(Boolean) ? <p className={ui.muted}>GST {formatMoney(amounts.taxTotal)}</p> : null}
      {!rule ? (
        <div style={{ display: "grid", gap: 8 }}>
          <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input type="checkbox" checked={saveRule} onChange={(event) => setSaveRule(event.target.checked)} />
            Save a bank rule so lines like this are filled in next time
          </label>
          {saveRule ? (
            <Field label="When a line contains" hint="Matched in the description, payee, particulars, code or reference, ignoring case.">
              <input value={ruleText} onChange={(event) => setRuleText(event.target.value)} maxLength={200} required />
            </Field>
          ) : null}
        </div>
      ) : null}
      <div className={ui.actions}>
        <Button type="submit" disabled={busy || (foreign && !isRateText(rate))}>
          {busy ? "Reconciling…" : `Save ${moneyIn ? "receive" : "spend"} money and reconcile`}
        </Button>
      </div>
    </form>
  );
}

function TransferForm({
  account,
  line,
  accounts,
  baseCurrency,
  submit,
  busy,
}: {
  account: BankAccount;
  line: StatementLine;
  accounts: Account[];
  baseCurrency: string;
  submit: Submit;
  busy: boolean;
}) {
  const moneyIn = !line.amount.startsWith("-");
  const unsigned = line.amount.replace(/^-/, "");
  const [other, setOther] = useState("");
  const [otherAmount, setOtherAmount] = useState("");
  const [reference, setReference] = useState(line.reference ?? "");
  const currencyOf = (candidate: Account) => candidate.currencyCode ?? baseCurrency;
  const otherAccount = accounts.find((candidate) => candidate.code === other);
  // Across currencies (FXB5, FXB6) both amounts are given: the base side is what really moved.
  const otherCurrency = otherAccount ? currencyOf(otherAccount) : null;
  const across = otherCurrency !== null && otherCurrency !== line.currencyCode;
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void submit({
          kind: "transfer",
          otherAccountCode: other,
          ...(across ? { otherAmount: otherAmount.trim() } : {}),
          reference: reference || undefined,
        });
      }}
      style={{ display: "grid", gap: 12 }}
      autoComplete="off"
    >
      <p className={ui.muted}>
        Money moved {moneyIn ? "in from" : "out to"} another of your accounts, such as a credit card repayment or a move to savings.
        When the other account&apos;s statement shows the same transfer, match it there.
      </p>
      <div className={ui.grid2}>
        <Field label={moneyIn ? "From account" : "To account"}>
          <AccountSelect
            accounts={accounts}
            // Between two foreign-currency accounts isn't supported yet.
            filter={(candidate) =>
              isStatementAccount(candidate) && candidate.id !== account.id && (currencyOf(candidate) === baseCurrency || line.currencyCode === baseCurrency)
            }
            value={other}
            onChange={setOther}
            required
          />
        </Field>
        <Field label="Reference">
          <input value={reference} onChange={(event) => setReference(event.target.value)} maxLength={100} />
        </Field>
      </div>
      {across ? (
        <Field
          label={`${otherCurrency} amount ${moneyIn ? "that left" : "that arrived in"} ${other}`}
          hint={
            line.currencyCode !== baseCurrency && !moneyIn
              ? `The ${line.currencyCode} ${unsigned} leaves this account at its carrying value (its ${baseCurrency} balance x ${unsigned} / its ${line.currencyCode} balance); the difference from the ${baseCurrency} that arrived is a realised currency gain or loss.`
              : line.currencyCode !== baseCurrency
                ? `This account is booked at the ${baseCurrency} that left.`
                : `The ${otherCurrency} account is booked at this line's ${baseCurrency} ${unsigned}.`
          }
        >
          <input inputMode="decimal" value={otherAmount} onChange={(event) => setOtherAmount(event.target.value)} required />
        </Field>
      ) : null}
      <div className={ui.actions}>
        <Button type="submit" disabled={busy || !other || (across && !isDecimalString(otherAmount.trim()))}>
          {busy ? "Reconciling…" : "Save transfer and reconcile"}
        </Button>
      </div>
    </form>
  );
}

function LineReconciler({
  organisationId,
  account,
  line,
  otherLines,
  lookups,
  onDone,
}: {
  organisationId: string;
  account: BankAccount;
  line: StatementLine;
  /** The other unreconciled lines shown, for a split. */
  otherLines: StatementLine[];
  lookups: Lookups;
  onDone: () => void;
}) {
  const detail = useApiData<{ line: StatementLine; suggestions: LineSuggestions }>(`/api/statement-lines/${line.id}`, { organisationId });
  const { submit, busy, error, setError } = useCommand(organisationId, line, onDone);
  const [chosenMode, setMode] = useState<Mode | null>(null);
  const moneyIn = !line.amount.startsWith("-");

  async function exclude() {
    setError(null);
    try {
      await api(`/api/statement-lines/${line.id}/exclude`, { method: "POST", body: { organisationId, excluded: true } });
      onDone();
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  if (detail.error) return <Notice tone="error">{detail.error}</Notice>;
  if (!detail.data) return <p className={ui.muted}>Looking for matches…</p>;
  const suggestions = detail.data.suggestions;
  const mode: Mode =
    chosenMode ??
    (suggestions.matches.some((match) => match.exact && !match.voided)
      ? "match"
      : suggestions.documents.length > 0
        ? "payments"
        : suggestions.rule
          ? "bank_transaction"
          : suggestions.matches.length > 0
            ? "match"
            : "bank_transaction");
  const modes: Array<{ mode: Mode; label: string }> = [
    { mode: "match", label: `Match${suggestions.matches.length ? ` (${suggestions.matches.length})` : ""}` },
    { mode: "split", label: "Part of one transaction" },
    { mode: "payments", label: moneyIn ? "Customer payment" : "Pay bills" },
    { mode: "bank_transaction", label: moneyIn ? "Receive money" : "Spend money" },
    { mode: "transfer", label: "Transfer" },
  ];

  return (
    <div style={{ display: "grid", gap: 12, padding: "8px 0" }}>
      {line.possibleDuplicateOf ? (
        <Notice tone="warning">
          This may be a duplicate: a line from another source has the same date and amount. If it is, exclude it.
        </Notice>
      ) : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
      <div className={ui.tabs} role="tablist" aria-label="How to reconcile">
        {modes.map((entry) => (
          <button
            key={entry.mode}
            type="button"
            role="tab"
            aria-selected={mode === entry.mode}
            className={`${ui.tab} ${mode === entry.mode ? ui.tabActive : ""}`}
            onClick={() => setMode(entry.mode)}
          >
            {entry.label}
          </button>
        ))}
      </div>
      {mode === "match" ? <MatchForm line={line} suggestions={suggestions} lookups={lookups} submit={submit} busy={busy} /> : null}
      {mode === "split" ? <SplitForm line={line} otherLines={otherLines} suggestions={suggestions} submit={submit} busy={busy} /> : null}
      {mode === "payments" ? (
        <PaymentsForm
          organisationId={organisationId}
          line={line}
          suggestions={suggestions}
          lookups={lookups}
          submit={submit}
          busy={busy}
        />
      ) : null}
      {mode === "bank_transaction" ? (
        <BankTransactionForm
          organisationId={organisationId}
          account={account}
          line={line}
          suggestions={suggestions}
          lookups={lookups}
          submit={submit}
          busy={busy}
        />
      ) : null}
      {mode === "transfer" ? (
        <TransferForm account={account} line={line} accounts={lookups.accounts} baseCurrency={lookups.baseCurrency} submit={submit} busy={busy} />
      ) : null}
      <div className={ui.actions} style={{ justifyContent: "flex-start" }}>
        <Button variant="secondary" size="small" onClick={() => void exclude()} disabled={busy}>
          Exclude this line
        </Button>
        <span className={ui.muted}>For a duplicate or a line that isn&apos;t a real transaction. Nothing is posted.</span>
      </div>
    </div>
  );
}

/** The account's unreconciled lines, oldest first, each opened to reconcile it. */
export function ReconcilePanel({
  organisationId,
  account,
  onChanged,
}: {
  organisationId: string;
  account: BankAccount;
  onChanged: () => void;
}) {
  const { can, current } = useWorkspace();
  const [offset, setOffset] = useState(0);
  const [open, setOpen] = useState<string | null>(null);
  const [ticked, setTicked] = useState<string[]>([]);
  const [coded, setCoded] = useState<number | null>(null);
  const list = useApiData<{ lines: StatementLine[]; total: number }>(`/api/bank-accounts/${account.id}/statement-lines`, {
    organisationId,
    status: "unreconciled",
    limit: PAGE_SIZE,
    offset,
  });
  const confident = useApiData<{ lines: LineConfidence[]; confidentCount: number }>(`/api/bank-accounts/${account.id}/confident-matches`, {
    organisationId,
  });
  const accounts = useApiData<{ accounts: Account[] }>("/api/accounts", { organisationId });
  const contacts = useApiData<{ contacts: Contact[] }>("/api/contacts", { organisationId });
  const taxCodes = useApiData<{ taxCodes: TaxCode[] }>("/api/tax/codes", { organisationId });
  const tracking = useTracking(organisationId);
  const customSetup = useCustomFields(organisationId);
  const lookupError = accounts.error ?? contacts.error ?? taxCodes.error ?? tracking.error ?? customSetup.error;
  const lookups: Lookups | null =
    accounts.data && contacts.data && taxCodes.data && tracking.data && customSetup.data
      ? {
          accounts: accounts.data.accounts,
          contacts: contacts.data.contacts,
          taxCodes: taxCodes.data.taxCodes,
          tracking: tracking.data,
          customSetup: customSetup.data,
          baseCurrency: current?.baseCurrency ?? "NZD",
        }
      : null;

  function finished() {
    setOpen(null);
    list.reload();
    confident.reload();
    onChanged();
  }

  function cashCoded(reconciledIds: string[]) {
    setTicked((current) => current.filter((id) => !reconciledIds.includes(id)));
    setCoded(reconciledIds.length);
    if (reconciledIds.length > 0) finished();
  }

  if (list.error) return <Notice tone="error">{list.error}</Notice>;
  if (lookupError) return <Notice tone="error">{lookupError}</Notice>;
  if (!list.data) return <p className={ui.muted}>Loading…</p>;
  const { lines, total } = list.data;
  if (total === 0) {
    return <Empty>Everything is reconciled. Import a statement or sync the bank feed to bring in new lines.</Empty>;
  }
  const confidence = new Map((confident.data?.lines ?? []).map((entry) => [entry.lineId, entry]));
  const canReconcile = can("bookkeeper");
  const tickedLines = lines.filter((line) => ticked.includes(line.id));
  const allTicked = lines.length > 0 && tickedLines.length === lines.length;
  return (
    <div style={{ display: "grid", gap: 12 }}>
      <p className={ui.muted}>
        {total} {total === 1 ? "line" : "lines"} to reconcile, oldest first. Reconciling says what each line is: something already
        posted, a payment of invoices or bills, a new bank transaction, or a transfer. A highlighted suggestion is the only match with
        the exact amount; <strong>OK</strong> reconciles it in one click. Tick several lines to code them to an account all at once.
      </p>
      {confident.error ? <Notice tone="error">{confident.error}</Notice> : null}
      {can("bookkeeper") && confident.data ? (
        <OkAllBar organisationId={organisationId} accountId={account.id} confidences={confident.data.lines} lines={lines} onDone={finished} />
      ) : null}
      {canReconcile && coded !== null && tickedLines.length === 0 ? (
        <Notice tone="success">
          {coded} {coded === 1 ? "line" : "lines"} coded and reconciled.
        </Notice>
      ) : null}
      {canReconcile && tickedLines.length > 0 ? (
        <div className={ui.suggestion} style={{ display: "grid", gap: 8 }}>
          <strong>
            Bulk code {tickedLines.length} ticked {tickedLines.length === 1 ? "line" : "lines"}
          </strong>
          {lookups ? (
            <CashCodingForm
              organisationId={organisationId}
              accountId={account.id}
              lines={tickedLines}
              lookups={lookups}
              onDone={cashCoded}
            />
          ) : (
            <p className={ui.muted}>Loading…</p>
          )}
        </div>
      ) : null}
      <div className={ui.tableWrap}>
        <table className={ui.table}>
          <thead>
            <tr>
              {canReconcile ? (
                <th style={{ width: 36 }}>
                  <input
                    type="checkbox"
                    aria-label="Tick every line on this page to bulk code"
                    checked={allTicked}
                    onChange={(event) => {
                      setCoded(null);
                      setTicked(event.target.checked ? lines.map((line) => line.id) : []);
                    }}
                  />
                </th>
              ) : null}
              <th>Date</th>
              <th>Description</th>
              <th className={ui.num}>Money in{account.isForeign ? ` (${account.statementCurrency})` : ""}</th>
              <th className={ui.num}>Money out{account.isForeign ? ` (${account.statementCurrency})` : ""}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {lines.map((line) => (
              <LineRow
                key={line.id}
                line={line}
                baseCurrency={current?.baseCurrency}
                open={open === line.id}
                canReconcile={canReconcile}
                ticked={ticked.includes(line.id)}
                onTick={(on) => {
                  setCoded(null);
                  setTicked((current) => (on ? [...current, line.id] : current.filter((id) => id !== line.id)));
                }}
                onToggle={() => setOpen((current) => (current === line.id ? null : line.id))}
                suggestion={
                  <SuggestionBox
                    organisationId={organisationId}
                    confidence={confidence.get(line.id)}
                    canReconcile={canReconcile}
                    onDone={finished}
                  />
                }
              >
                {lookups ? (
                  <LineReconciler
                    organisationId={organisationId}
                    account={account}
                    line={line}
                    otherLines={lines}
                    lookups={lookups}
                    onDone={finished}
                  />
                ) : (
                  <p className={ui.muted}>Loading…</p>
                )}
              </LineRow>
            ))}
          </tbody>
        </table>
      </div>
      <Pager
        offset={offset}
        pageSize={PAGE_SIZE}
        total={total}
        onChange={(next) => {
          setTicked([]);
          setOffset(next);
        }}
      />
    </div>
  );
}

function LineRow({
  line,
  open,
  canReconcile,
  ticked,
  onTick,
  onToggle,
  suggestion,
  children,
  baseCurrency,
}: {
  line: StatementLine;
  open: boolean;
  canReconcile: boolean;
  ticked: boolean;
  onTick: (ticked: boolean) => void;
  onToggle: () => void;
  suggestion?: ReactNode;
  children: ReactNode;
  baseCurrency?: string;
}) {
  return (
    <>
      <tr>
        {canReconcile ? (
          <td>
            <input
              type="checkbox"
              aria-label={`Tick ${formatDate(line.date)} ${line.description} to bulk code`}
              checked={ticked}
              onChange={(event) => onTick(event.target.checked)}
            />
          </td>
        ) : null}
        <td style={{ whiteSpace: "nowrap" }}>{formatDate(line.date)}</td>
        <td>
          {line.description}
          {line.possibleDuplicateOf ? (
            <>
              {" "}
              <Badge tone="amber">Possible duplicate</Badge>
            </>
          ) : null}
          <LineDetails line={line} />
          {baseCurrency ? <LineBaseValue line={line} baseCurrency={baseCurrency} /> : null}
          {open ? null : suggestion}
        </td>
        <InOutCells amount={line.amount} />
        <td style={{ textAlign: "right" }}>
          {canReconcile ? (
            <Button size="small" variant={open ? "secondary" : "primary"} onClick={onToggle} aria-expanded={open}>
              {open ? "Close" : "Reconcile"}
            </Button>
          ) : null}
        </td>
      </tr>
      {open ? (
        <tr>
          <td colSpan={canReconcile ? 6 : 5}>{children}</td>
        </tr>
      ) : null}
    </>
  );
}

export function Pager({
  offset,
  pageSize,
  total,
  onChange,
}: {
  offset: number;
  pageSize: number;
  total: number;
  onChange: (offset: number) => void;
}) {
  if (total <= pageSize) return null;
  return (
    <div className={ui.actions} style={{ justifyContent: "space-between" }}>
      <span className={ui.muted}>
        {offset + 1}–{Math.min(offset + pageSize, total)} of {total}
      </span>
      <span style={{ display: "flex", gap: 8 }}>
        <Button variant="secondary" size="small" disabled={offset === 0} onClick={() => onChange(Math.max(0, offset - pageSize))}>
          Previous
        </Button>
        <Button variant="secondary" size="small" disabled={offset + pageSize >= total} onClick={() => onChange(offset + pageSize)}>
          Next
        </Button>
      </span>
    </div>
  );
}
