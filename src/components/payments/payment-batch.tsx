"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useMemo, useState } from "react";
import { AccountSelect, Money, useAccounts } from "@/components/books";
import { ExchangeRateField, useLastRate } from "@/components/fx";
import { useApiData } from "@/components/hooks";

import { Badge, Button, Card, Empty, Field, Notice, Stat, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import type { Account } from "@/lib/accounts/service";
import type { BillSummary } from "@/lib/bills/service";
import { api, errorMessage, newIdempotencyKey } from "@/lib/client/api";
import type { Contact } from "@/lib/contacts/service";
import { formatDate, formatMoney, todayInBrowser } from "@/lib/format";
import type { InvoiceSummary } from "@/lib/invoices/service";
import { add, cmp, dec, isDecimalString, sub, toFixedString, ZERO_DECIMAL } from "@/lib/money/decimal";
import type { BatchKind, PaymentBatch } from "@/lib/payments/batches";

/**
 * One payment for several of a customer's invoices or a supplier's bills
 * (examples MP1-MP10, SMP1-SMP6): one bank line for the whole amount, and a
 * typed amount for each document.
 */
type Words = {
  contact: string;
  contacts: string;
  document: string;
  documents: string;
  money: string;
  api: string;
  page: string;
  listApi: string;
  documentHref: (id: string) => string;
};

export const WORDS: Record<BatchKind, Words> = {
  customer: {
    contact: "customer",
    contacts: "customers",
    document: "invoice",
    documents: "invoices",
    money: "received",
    api: "/api/customer-payment-batches",
    page: "/operations/customer-payments",
    listApi: "/api/invoices",
    documentHref: (id) => `/operations/invoices/${id}`,
  },
  supplier: {
    contact: "supplier",
    contacts: "suppliers",
    document: "bill",
    documents: "bills",
    money: "paid",
    api: "/api/supplier-payment-batches",
    page: "/operations/supplier-payments",
    listApi: "/api/bills",
    documentHref: (id) => `/operations/bills/${id}`,
  },
};

type Due = { id: string; number: string; date: string; dueDate: string; total: string; amountDue: string };

/**
 * Bank accounts a payment can go through: the base currency's, or, for a
 * contact in another currency, that currency's (MC20-MC24; a third currency is
 * refused, MC30).
 */
function paymentAccountFilter(currencyCode: string | null) {
  return (account: Account): boolean =>
    (account.accountType === "bank" || account.accountType === "credit_card") &&
    (account.currencyCode === null || (currencyCode !== null && account.currencyCode === currencyCode));
}

function money(value: string): string {
  return isDecimalString(value.trim()) ? value.trim() : "";
}

function useDocuments(kind: BatchKind, organisationId: string, contactId: string) {
  const words = WORDS[kind];
  const list = useApiData<{ invoices?: InvoiceSummary[]; bills?: BillSummary[] }>(contactId ? words.listApi : null, {
    organisationId,
    contactId,
    awaitingPayment: "true",
    limit: "200",
  });
  const documents: Due[] = useMemo(() => {
    if (kind === "customer") {
      return (list.data?.invoices ?? []).map((invoice) => ({
        id: invoice.id,
        number: invoice.invoiceNumber ?? "",
        date: invoice.invoiceDate,
        dueDate: invoice.dueDate,
        total: invoice.total,
        amountDue: invoice.amountDue ?? "0.00",
      }));
    }
    return (list.data?.bills ?? []).map((bill) => ({
      id: bill.id,
      number: bill.supplierInvoiceNumber ?? "",
      date: bill.billDate,
      dueDate: bill.dueDate,
      total: bill.total,
      amountDue: bill.amountDue ?? "0.00",
    }));
  }, [kind, list.data]);
  // Oldest first, the way they're usually paid.
  const sorted = [...documents].sort((a, b) => (a.date === b.date ? Number(a.id) - Number(b.id) : a.date < b.date ? -1 : 1));
  return { list, documents: sorted };
}

export function NewPaymentBatch({ kind, organisationId }: { kind: BatchKind; organisationId: string }) {
  const words = WORDS[kind];
  const router = useRouter();
  const accounts = useAccounts(organisationId);
  const contacts = useApiData<{ contacts: Contact[] }>("/api/contacts", { organisationId });
  const [contactId, setContactId] = useState("");
  const { list, documents } = useDocuments(kind, organisationId, contactId);
  // Ticked documents and the amount typed for each (their amount due when ticked).
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [received, setReceived] = useState<string | null>(null);
  const [fields, setFields] = useState({ paymentDate: todayInBrowser(), reference: "" });
  const [chosenAccount, setChosenAccount] = useState<string | null>(null);
  const [key, setKey] = useState(() => newIdempotencyKey("payment-batch"));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const people = (contacts.data?.contacts ?? []).filter((c) => !c.isArchived && (kind === "customer" ? c.isCustomer : c.isSupplier));
  // A contact in another currency is paid in it, at the payment's one rate (MC20-MC24).
  const baseCurrency = useWorkspace().current?.baseCurrency ?? "NZD";
  const currency = people.find((c) => c.id === contactId)?.currencyCode ?? baseCurrency;
  const foreign = currency !== baseCurrency;
  const [typedRate, setTypedRate] = useState<string | null>(null);
  const suggestedRate = useLastRate(organisationId, currency, baseCurrency, fields.paymentDate);
  const isPaymentAccount = paymentAccountFilter(foreign ? currency : null);
  const bankAccounts = (accounts.data?.accounts ?? []).filter((account) => account.isActive && isPaymentAccount(account));
  const bankAccountCode = chosenAccount ?? (bankAccounts.find((a) => a.systemKey === "bank") ?? bankAccounts[0])?.code ?? "";
  const ticked = documents.filter((document) => amounts[document.id] !== undefined);
  const total = ticked.reduce((acc, document) => add(acc, money(amounts[document.id]) ? dec(money(amounts[document.id])) : ZERO_DECIMAL), ZERO_DECIMAL);
  const totalText = toFixedString(total, 2);
  const amount = received ?? totalText;
  const extra = money(amount) ? sub(dec(money(amount)), total) : ZERO_DECIMAL;
  const allInFull = ticked.every((document) => money(amounts[document.id]) && cmp(dec(money(amounts[document.id])), dec(document.amountDue)) === 0);

  function chooseContact(id: string) {
    setContactId(id);
    setAmounts({});
    setReceived(null);
    setChosenAccount(null);
    setTypedRate(null);
    setError(null);
  }
  function toggle(document: Due) {
    setAmounts((current) => {
      const next = { ...current };
      if (next[document.id] === undefined) next[document.id] = document.amountDue;
      else delete next[document.id];
      return next;
    });
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (ticked.length === 0) {
      setError(`Tick the ${words.documents} this payment is for.`);
      return;
    }
    if (kind === "customer" && cmp(extra, ZERO_DECIMAL) > 0 && allInFull) {
      const name = people.find((c) => c.id === contactId)?.name ?? "the customer";
      if (!window.confirm(`${formatMoney(amount)} is ${formatMoney(toFixedString(extra, 2))} more than these invoices. Record it? The extra will be kept as an overpayment: credit for ${name}.`)) {
        return;
      }
    }
    setBusy(true);
    setError(null);
    try {
      const result = await api<{ batch: PaymentBatch }>(words.api, {
        method: "POST",
        body: {
          organisationId,
          source: "ui",
          idempotencyKey: key,
          paymentDate: fields.paymentDate,
          amount,
          bankAccountCode,
          reference: fields.reference,
          ...(foreign && typedRate !== null ? { exchangeRate: typedRate } : {}),
          // In the order they're listed (oldest first); any overpayment is kept on the last one.
          documents: ticked.map((document) => ({ id: document.id, amount: amounts[document.id] })),
        },
      });
      setKey(newIdempotencyKey("payment-batch"));
      router.push(`${words.page}/${result.batch.id}?recorded=1`);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  if (contacts.error || accounts.error) return <Notice tone="error">{contacts.error ?? accounts.error}</Notice>;
  if (!contacts.data || !accounts.data) return <p className={ui.muted}>Loading…</p>;
  if (people.length === 0) {
    return (
      <Notice tone="warning">
        There are no {words.contacts} yet. Add one in <Link href="/operations/contacts">Contacts</Link> first.
      </Notice>
    );
  }
  return (
    <form onSubmit={(event) => void submit(event)} style={{ display: "grid", gap: 16 }}>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <Card title={`Which ${words.contact}?`}>
        <Field label={words.contact.charAt(0).toUpperCase() + words.contact.slice(1)}>
          <select value={contactId} onChange={(event) => chooseContact(event.target.value)} required>
            <option value="">Choose a {words.contact}</option>
            {people.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>
      </Card>
      {contactId ? (
        <Card
          title={`${words.documents.charAt(0).toUpperCase() + words.documents.slice(1)} with something due`}
          description={`Tick each ${words.document} this payment is for. The amount starts at what's due; change it for a part payment.`}
        >
          {list.error ? <Notice tone="error">{list.error}</Notice> : null}
          {!list.data && !list.error ? <p className={ui.muted}>Loading…</p> : null}
          {list.data && documents.length === 0 ? <Empty>Nothing is due from this {words.contact}.</Empty> : null}
          {documents.length > 0 ? (
            <div className={ui.tableWrap}>
              <table className={`${ui.table} ${ui.stackOnPhone}`}>
                <thead>
                  <tr>
                    <th />
                    <th>{kind === "customer" ? "Invoice" : "Bill"}</th>
                    <th>Date</th>
                    <th>Due</th>
                    <th className={ui.num}>Total</th>
                    <th className={ui.num}>Amount due</th>
                    <th className={ui.num}>Paying</th>
                  </tr>
                </thead>
                <tbody>
                  {documents.map((document) => {
                    const on = amounts[document.id] !== undefined;
                    return (
                      <tr key={document.id}>
                        <td>
                          <input type="checkbox" checked={on} onChange={() => toggle(document)} aria-label={`Pay ${document.number}`} />
                        </td>
                        <td>
                          <Link href={words.documentHref(document.id)}>{document.number}</Link>
                        </td>
                        <td data-label="Date">{formatDate(document.date)}</td>
                        <td data-label="Due">{formatDate(document.dueDate)}</td>
                        <td className={ui.num} data-label="Total">
                          <Money value={document.total} />
                        </td>
                        <td className={ui.num} data-label="Amount due">
                          <Money value={document.amountDue} />
                        </td>
                        <td className={ui.num} data-label={on ? "Paying" : ""}>
                          {on ? (
                            <input
                              inputMode="decimal"
                              value={amounts[document.id]}
                              onChange={(event) => setAmounts((current) => ({ ...current, [document.id]: event.target.value }))}
                              style={{ width: 110, textAlign: "right" }}
                              aria-label={`Amount for ${document.number}`}
                            />
                          ) : null}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : null}
          <p>
            {ticked.length} {ticked.length === 1 ? words.document : words.documents}: <strong><Money value={totalText} /></strong>
          </p>
        </Card>
      ) : null}
      {contactId ? (
        <Card title="The payment">
          <div className={ui.grid4}>
            <Field label="Date">
              <input type="date" value={fields.paymentDate} onChange={(event) => setFields((f) => ({ ...f, paymentDate: event.target.value }))} required />
            </Field>
            <Field
              label={`Amount ${words.money} (${currency})`}
              hint={
                kind === "customer"
                  ? "The amounts above add up to this. If every invoice is paid in full, anything more is kept as an overpayment."
                  : "The amounts above must add up to exactly this."
              }
            >
              <input inputMode="decimal" value={amount} onChange={(event) => setReceived(event.target.value)} required />
            </Field>
            {foreign ? (
              <ExchangeRateField currencyCode={currency} baseCurrency={baseCurrency} suggested={suggestedRate} value={typedRate} onChange={setTypedRate} />
            ) : null}
            <Field label="Bank account">
              <AccountSelect
                accounts={accounts.data.accounts}
                value={bankAccountCode}
                onChange={setChosenAccount}
                filter={isPaymentAccount}
                placeholder="Choose a bank account"
                required
              />
            </Field>
            <Field label="Reference" hint="Optional, e.g. the bank reference.">
              <input value={fields.reference} maxLength={100} onChange={(event) => setFields((f) => ({ ...f, reference: event.target.value }))} />
            </Field>
          </div>
          {cmp(extra, ZERO_DECIMAL) !== 0 && ticked.length > 0 ? (
            <Notice tone={kind === "customer" && cmp(extra, ZERO_DECIMAL) > 0 && allInFull ? "info" : "warning"}>
              {cmp(extra, ZERO_DECIMAL) < 0
                ? `The ${words.documents} add up to ${formatMoney(totalText)}, more than ${formatMoney(amount)}.`
                : kind === "customer" && allInFull
                  ? `${formatMoney(toFixedString(extra, 2))} more than the invoices: it will be kept as an overpayment (credit for the customer) on the last invoice ticked.`
                  : kind === "customer"
                    ? `${formatMoney(toFixedString(extra, 2))} more than the amounts above. Pay every invoice in full to keep the extra as an overpayment, or change the amounts.`
                    : `${formatMoney(toFixedString(extra, 2))} more than the bills. Payments to suppliers can't be more than what's due.`}
            </Notice>
          ) : null}
          <div className={ui.actions}>
            <Button type="submit" disabled={busy}>
              {busy ? "Recording…" : "Record payment"}
            </Button>
            <span className={ui.muted}>
              Posts one journal on the date: one bank line for the whole amount, and one line for each {words.document}
              {foreign ? `, each with its own realised currency gain or loss (${baseCurrency} at the payment's rate less its value at the ${words.document}'s)` : ""}.
            </span>
          </div>
        </Card>
      ) : null}
    </form>
  );
}

function journalHref(journalId: string): string {
  return `/operations/ledger-journals?journal=${journalId}`;
}

export function PaymentBatchView({ kind, organisationId, batchId, recorded }: { kind: BatchKind; organisationId: string; batchId: string; recorded: boolean }) {
  const words = WORDS[kind];
  const { can } = useWorkspace();
  const details = useApiData<{ batch: PaymentBatch }>(`${words.api}/${encodeURIComponent(batchId)}`, { organisationId });
  const [updated, setUpdated] = useState<PaymentBatch | null>(null);
  const [voiding, setVoiding] = useState(false);
  const [voidDate, setVoidDate] = useState(todayInBrowser());
  const [key] = useState(() => newIdempotencyKey("payment-batch-void"));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(recorded ? "Recorded the payment and posted it to the ledger." : null);

  if (details.error) return <Notice tone="error">{details.error}</Notice>;
  if (!details.data) return <p className={ui.muted}>Loading…</p>;
  const batch = updated ?? details.data.batch;

  async function voidIt(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!window.confirm(`Void the whole payment of ${formatMoney(batch.amount)}? This posts a reversal of its journal on ${formatDate(voidDate)}, and every ${words.document} is due again. It can't be undone.`)) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api<{ batch: PaymentBatch }>(`${words.api}/${batch.id}/void`, {
        method: "POST",
        body: { organisationId, source: "ui", idempotencyKey: key, voidDate },
      });
      setUpdated(result.batch);
      setVoiding(false);
      setMessage(`Voided the payment. Its journal was reversed on ${formatDate(result.batch.voidDate)}.`);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {message ? <Notice tone="success">{message}</Notice> : null}
      <Card
        title={`${kind === "customer" ? "Payment from" : "Payment to"} ${batch.contactName}`}
        description={`For ${batch.parts.length} ${batch.parts.length === 1 ? words.document : words.documents}, posted as one journal with one bank line.`}
        actions={batch.status === "active" ? <Badge tone="green">Active</Badge> : <Badge tone="red">Voided</Badge>}
      >
        <div className={ui.grid4}>
          <Stat label="Date" value={formatDate(batch.paymentDate)} />
          <Stat label={`Amount ${words.money}`} value={<>{batch.exchangeRate ? `${batch.currencyCode} ` : null}<Money value={batch.amount} /></>} />
          <Stat label="Bank account" value={`${batch.bankAccountCode} · ${batch.bankAccountName}`} />
          <Stat label="Reference" value={batch.reference ?? "—"} />
          {batch.exchangeRate ? <Stat label="Exchange rate" value={`${batch.exchangeRate} = ${formatMoney(batch.baseAmount)}`} /> : null}
        </div>
        <p className={ui.muted}>
          Journal <Link href={journalHref(batch.journalId)}>#{batch.journalId}</Link>
          {batch.voidJournalId ? (
            <>
              {" "}
              · reversed on {formatDate(batch.voidDate)} by <Link href={journalHref(batch.voidJournalId)}>#{batch.voidJournalId}</Link>
            </>
          ) : null}
        </p>
        <div className={ui.tableWrap}>
          <table className={ui.table}>
            <thead>
              <tr>
                <th>{kind === "customer" ? "Invoice" : "Bill"}</th>
                <th className={ui.num}>Paid</th>
                {kind === "customer" ? <th>Overpayment</th> : null}
                {batch.exchangeRate ? <th className={ui.num}>Realised gain (loss)</th> : null}
              </tr>
            </thead>
            <tbody>
              {batch.parts.map((part) => (
                <tr key={part.paymentId}>
                  <td>
                    <Link href={words.documentHref(part.documentId)}>{part.documentNumber}</Link>
                  </td>
                  <td className={ui.num}>
                    <Money value={toFixedString(sub(dec(part.amount), dec(part.overpaymentAmount)), 2)} />
                  </td>
                  {kind === "customer" ? (
                    <td>
                      {cmp(dec(part.overpaymentAmount), ZERO_DECIMAL) > 0 ? (
                        <Link href={`/operations/overpayments/${part.paymentId}`}>{formatMoney(part.overpaymentAmount)}</Link>
                      ) : null}
                    </td>
                  ) : null}
                  {batch.exchangeRate ? (
                    <td className={ui.num}>
                      <Money value={part.realisedGain ?? "0.00"} />
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {batch.status === "active" && can("bookkeeper") ? (
          voiding ? (
            <form onSubmit={(event) => void voidIt(event)} style={{ display: "grid", gap: 12 }}>
              {error ? <Notice tone="error">{error}</Notice> : null}
              <Field label="Void date" hint="Must be in an open period, on or after the payment date.">
                <input type="date" value={voidDate} min={batch.paymentDate} onChange={(event) => setVoidDate(event.target.value)} required />
              </Field>
              <div className={ui.actions}>
                <Button type="submit" variant="danger" disabled={busy}>
                  {busy ? "Working…" : "Void the whole payment"}
                </Button>
                <Button type="button" variant="secondary" onClick={() => setVoiding(false)}>
                  Cancel
                </Button>
              </div>
            </form>
          ) : (
            <div className={ui.actions}>
              <Button variant="secondary" onClick={() => setVoiding(true)}>
                Void…
              </Button>
              <span className={ui.muted}>It&apos;s undone as a whole: to change one {words.document}&apos;s part, void it and record it again.</span>
            </div>
          )
        ) : null}
      </Card>
    </>
  );
}

export function PaymentBatchList({ kind, organisationId }: { kind: BatchKind; organisationId: string }) {
  const words = WORDS[kind];
  const list = useApiData<{ batches: PaymentBatch[] }>(words.api, { organisationId });
  if (list.error) return <Notice tone="error">{list.error}</Notice>;
  if (!list.data) return <p className={ui.muted}>Loading…</p>;
  if (list.data.batches.length === 0) {
    return <Empty>No payments for several {words.documents} yet.</Empty>;
  }
  return (
    <div className={ui.tableWrap}>
      <table className={ui.table}>
        <thead>
          <tr>
            <th>Date</th>
            <th>{kind === "customer" ? "Customer" : "Supplier"}</th>
            <th>{kind === "customer" ? "Invoices" : "Bills"}</th>
            <th>Reference</th>
            <th className={ui.num}>Amount</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {list.data.batches.map((batch) => (
            <tr key={batch.id}>
              <td>
                <Link href={`${words.page}/${batch.id}`}>{formatDate(batch.paymentDate)}</Link>
              </td>
              <td>{batch.contactName}</td>
              <td>{batch.parts.map((part) => part.documentNumber).join(", ")}</td>
              <td>{batch.reference ?? ""}</td>
              <td className={ui.num}>
                <Money value={batch.amount} />
              </td>
              <td>{batch.status === "active" ? <Badge tone="green">Active</Badge> : <Badge tone="red">Voided</Badge>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
