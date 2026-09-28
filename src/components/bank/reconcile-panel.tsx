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
import { AccountSelect, Money } from "@/components/books";
import { useApiData } from "@/components/hooks";
import { TrackingSelects, useTracking } from "@/components/tracking";
import { formatRate } from "@/components/invoices/invoice-editor";
import { Badge, Button, Empty, Field, Notice, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import type { Account } from "@/lib/accounts/service";
import type { BankAccount, StatementLine } from "@/lib/bank/accounts";
import type { LineSuggestions } from "@/lib/bank/reconcile";
import type { BillSummary } from "@/lib/bills/service";
import { api, errorMessage, newIdempotencyKey } from "@/lib/client/api";
import type { Contact } from "@/lib/contacts/service";
import { formatDate, formatMoney } from "@/lib/format";
import { AMOUNTS_MODE_LABELS, AMOUNTS_MODES, type AmountsMode, calculateInvoice } from "@/lib/invoices/amounts";
import type { InvoiceSummary } from "@/lib/invoices/service";
import { isDecimalString } from "@/lib/money/decimal";
import type { TaxCode } from "@/lib/tax/codes";
import type { TrackingSetup, TrackingTags } from "@/lib/tracking/service";

const PAGE_SIZE = 50;

type Mode = "match" | "payments" | "bank_transaction" | "transfer";

type Lookups = { accounts: Account[]; contacts: Contact[]; taxCodes: TaxCode[]; tracking: TrackingSetup };

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

function MatchForm({ line, suggestions, submit, busy }: { line: StatementLine; suggestions: LineSuggestions; submit: Submit; busy: boolean }) {
  const [chosen, setChosen] = useState<string[]>(() => {
    const exact = suggestions.matches.find((match) => match.exact);
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
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void submit({ kind: "match", journalLineIds: chosen });
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
      <div className={ui.actions}>
        <Button type="submit" disabled={busy || chosen.length === 0}>
          {busy ? "Reconciling…" : "Match"}
        </Button>
      </div>
    </form>
  );
}

function PaymentsForm({
  organisationId,
  line,
  suggestions,
  contacts,
  submit,
  busy,
}: {
  organisationId: string;
  line: StatementLine;
  suggestions: LineSuggestions;
  contacts: Contact[];
  submit: Submit;
  busy: boolean;
}) {
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
  const base = current?.baseCurrency;
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

  function submitChosen(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void submit({ kind: "payments", allocations: entered.map(([id, amount]) => allocation(id, amount.trim())) });
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
                onClick={() => void submit({ kind: "payments", allocations: [allocation(document.id, document.amountDue)] })}
              >
                Pay {document.number} · {document.contactName} · {formatDate(document.date)}
              </Button>
            ))}
          </div>
        </div>
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
          <div className={ui.actions}>
            <Button type="submit" disabled={busy || entered.length === 0}>
              {busy ? "Reconciling…" : `Record ${entered.length === 1 ? "payment" : "payments"} and reconcile`}
            </Button>
          </div>
        </form>
      ) : null}
    </div>
  );
}

type EditorLine = { key: number; description: string; accountCode: string; taxCode: string; amount: string; tracking: TrackingTags };
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
  const activeTaxCodes = lookups.taxCodes.filter((taxCode) => taxCode.isActive);
  const defaultTaxCode = (activeTaxCodes.find((taxCode) => taxCode.category === "standard") ?? activeTaxCodes[0])?.code ?? "";
  const [contactId, setContactId] = useState(rule?.contactId ?? "");
  const [reference, setReference] = useState(line.reference ?? line.particulars ?? "");
  const [amountsMode, setAmountsMode] = useState<AmountsMode>(rule?.amountsMode ?? "inclusive");
  const [lines, setLines] = useState<EditorLine[]>(() => [
    {
      key: ++lineKey,
      description: rule?.suggestedLine.description ?? line.description,
      accountCode: rule?.suggestedLine.accountCode ?? "",
      taxCode: rule?.suggestedLine.taxCode ?? defaultTaxCode,
      amount: unsigned,
      tracking: {},
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
      contactId,
      reference: reference || undefined,
      amountsMode,
      lines: lines.map((entry) => ({
        description: entry.description,
        accountCode: entry.accountCode,
        taxCode: hasTax ? entry.taxCode : undefined,
        amount: entry.amount.trim(),
        tracking: entry.tracking,
      })),
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
          <select value={contactId} onChange={(event) => setContactId(event.target.value)} required>
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
                </td>
                {hasTax ? (
                  <td>
                    <select
                      aria-label={`Line ${index + 1} tax code`}
                      value={entry.taxCode}
                      onChange={(event) => update(entry.key, { taxCode: event.target.value })}
                      required
                    >
                      <option value="">Choose</option>
                      {lookups.taxCodes
                        .filter((taxCode) => taxCode.isActive || taxCode.code === entry.taxCode)
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
            setLines((current) => [...current, { key: ++lineKey, description: line.description, accountCode: "", taxCode: defaultTaxCode, amount: "", tracking: {} }])
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
        <Button type="submit" disabled={busy}>
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
  submit,
  busy,
}: {
  account: BankAccount;
  line: StatementLine;
  accounts: Account[];
  submit: Submit;
  busy: boolean;
}) {
  const moneyIn = !line.amount.startsWith("-");
  const [other, setOther] = useState("");
  const [reference, setReference] = useState(line.reference ?? "");
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void submit({ kind: "transfer", otherAccountCode: other, reference: reference || undefined });
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
            filter={(candidate) => isStatementAccount(candidate) && candidate.id !== account.id && candidate.currencyCode === null}
            value={other}
            onChange={setOther}
            required
          />
        </Field>
        <Field label="Reference">
          <input value={reference} onChange={(event) => setReference(event.target.value)} maxLength={100} />
        </Field>
      </div>
      <div className={ui.actions}>
        <Button type="submit" disabled={busy || !other}>
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
  lookups,
  onDone,
}: {
  organisationId: string;
  account: BankAccount;
  line: StatementLine;
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
    (suggestions.matches.some((match) => match.exact)
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
      {mode === "match" ? <MatchForm line={line} suggestions={suggestions} submit={submit} busy={busy} /> : null}
      {mode === "payments" ? (
        <PaymentsForm
          organisationId={organisationId}
          line={line}
          suggestions={suggestions}
          contacts={lookups.contacts}
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
      {mode === "transfer" ? <TransferForm account={account} line={line} accounts={lookups.accounts} submit={submit} busy={busy} /> : null}
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
  const { can } = useWorkspace();
  const [offset, setOffset] = useState(0);
  const [open, setOpen] = useState<string | null>(null);
  const list = useApiData<{ lines: StatementLine[]; total: number }>(`/api/bank-accounts/${account.id}/statement-lines`, {
    organisationId,
    status: "unreconciled",
    limit: PAGE_SIZE,
    offset,
  });
  const accounts = useApiData<{ accounts: Account[] }>("/api/accounts", { organisationId });
  const contacts = useApiData<{ contacts: Contact[] }>("/api/contacts", { organisationId });
  const taxCodes = useApiData<{ taxCodes: TaxCode[] }>("/api/tax/codes", { organisationId });
  const tracking = useTracking(organisationId);
  const lookupError = accounts.error ?? contacts.error ?? taxCodes.error ?? tracking.error;
  const lookups: Lookups | null =
    accounts.data && contacts.data && taxCodes.data && tracking.data
      ? { accounts: accounts.data.accounts, contacts: contacts.data.contacts, taxCodes: taxCodes.data.taxCodes, tracking: tracking.data }
      : null;

  function finished() {
    setOpen(null);
    list.reload();
    onChanged();
  }

  if (list.error) return <Notice tone="error">{list.error}</Notice>;
  if (lookupError) return <Notice tone="error">{lookupError}</Notice>;
  if (!list.data) return <p className={ui.muted}>Loading…</p>;
  const { lines, total } = list.data;
  if (total === 0) {
    return <Empty>Everything is reconciled. Import a statement or sync the bank feed to bring in new lines.</Empty>;
  }
  return (
    <div style={{ display: "grid", gap: 12 }}>
      <p className={ui.muted}>
        {total} {total === 1 ? "line" : "lines"} to reconcile, oldest first. Reconciling says what each line is: something already
        posted, a payment of invoices or bills, a new bank transaction, or a transfer.
      </p>
      <div className={ui.tableWrap}>
        <table className={ui.table}>
          <thead>
            <tr>
              <th>Date</th>
              <th>Description</th>
              <th className={ui.num}>Money in</th>
              <th className={ui.num}>Money out</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {lines.map((line) => (
              <LineRow
                key={line.id}
                line={line}
                open={open === line.id}
                canReconcile={can("bookkeeper")}
                onToggle={() => setOpen((current) => (current === line.id ? null : line.id))}
              >
                {lookups ? (
                  <LineReconciler organisationId={organisationId} account={account} line={line} lookups={lookups} onDone={finished} />
                ) : (
                  <p className={ui.muted}>Loading…</p>
                )}
              </LineRow>
            ))}
          </tbody>
        </table>
      </div>
      <Pager offset={offset} pageSize={PAGE_SIZE} total={total} onChange={setOffset} />
    </div>
  );
}

function LineRow({
  line,
  open,
  canReconcile,
  onToggle,
  children,
}: {
  line: StatementLine;
  open: boolean;
  canReconcile: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <>
      <tr>
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
          <td colSpan={5}>{children}</td>
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
