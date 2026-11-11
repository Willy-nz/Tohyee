"use client";

import { useState } from "react";
import { AccountSelect, Money, useAccounts } from "@/components/books";
import { useApiData } from "@/components/hooks";
import { Button, Card, Field, Notice, ui } from "@/components/ui";
import { api, errorMessage, newIdempotencyKey } from "@/lib/client/api";
import type { RecodeChange, RecodePlan } from "@/lib/bank/recode";
import type { BankTransaction } from "@/lib/bank/transactions";
import type { Contact } from "@/lib/contacts/service";
import { formatDate } from "@/lib/format";

type Change = { fromAccountCode: string; accountCode: string; taxCode: string; contactId: string; description: string };
const asChange = (change: Change): Partial<RecodeChange> => ({
  ...(change.fromAccountCode ? { fromAccountCode: change.fromAccountCode } : {}),
  ...(change.accountCode ? { accountCode: change.accountCode } : {}),
  ...(change.taxCode ? { taxCode: change.taxCode } : {}),
  ...(change.contactId ? { contactId: change.contactId } : {}),
  ...(change.description ? { description: change.description } : {}),
});

/** The change, its preview by account and month, and Recode (RC1-RC5). */
function ChangeAndPreview({
  organisationId,
  ids,
  fromChoices,
  initialFrom,
  onDone,
  onCancel,
}: {
  organisationId: string;
  ids: string[];
  fromChoices: string[];
  initialFrom: string;
  onDone: (message: string) => void;
  onCancel?: () => void;
}) {
  const accounts = useAccounts(organisationId);
  const contacts = useApiData<{ contacts: Contact[] }>("/api/contacts", { organisationId });
  const [change, setChangeState] = useState<Change>({ fromAccountCode: initialFrom, accountCode: "", taxCode: "", contactId: "", description: "" });
  const [plan, setPlan] = useState<RecodePlan | null>(null);
  // A changed form needs a fresh preview.
  const setChange = (next: Change) => {
    setChangeState(next);
    setPlan(null);
  };
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [key] = useState(() => newIdempotencyKey("recode"));
  const wanted = asChange(change);
  const something = Boolean(wanted.accountCode || wanted.taxCode || wanted.contactId || wanted.description);
  async function preview() {
    setBusy(true);
    setError(null);
    try {
      setPlan(await api<RecodePlan>("/api/bank-transactions/recode", { method: "POST", body: { organisationId, bankTransactionIds: ids, change: wanted } }));
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }
  async function go() {
    if (!plan) return;
    setBusy(true);
    setError(null);
    try {
      const done = await api<{ recoded: unknown[] }>("/api/bank-transactions/recode", {
        method: "POST",
        body: { organisationId, bankTransactionIds: ids, change: wanted, previewHash: plan.hash, idempotencyKey: key },
      });
      onDone(`${done.recoded.length === 1 ? "It's" : `${done.recoded.length} are`} recoded: each corrected on its own date, and still reconciled.`);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }
  const stuck = plan?.items.filter((item) => item.blocked) ?? [];
  return (
    <div style={{ display: "grid", gap: 12 }}>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <div className={ui.inlineForm}>
        <Field label="Lines on" hint="Only lines on this account change. Blank: every line.">
          <select value={change.fromAccountCode} onChange={(event) => setChange({ ...change, fromAccountCode: event.target.value })}>
            <option value="">Every line</option>
            {fromChoices.map((code) => (
              <option key={code} value={code}>
                {code}
              </option>
            ))}
          </select>
        </Field>
        <Field label="New account">
          <AccountSelect accounts={(accounts.data?.accounts ?? []).filter((account) => account.isActive)} value={change.accountCode} onChange={(value) => setChange({ ...change, accountCode: value })} placeholder="Keep" />
        </Field>
        <Field label="New GST code">
          <input value={change.taxCode} maxLength={20} placeholder="Keep" onChange={(event) => setChange({ ...change, taxCode: event.target.value.toUpperCase() })} />
        </Field>
        <Field label="New contact">
          <select value={change.contactId} onChange={(event) => setChange({ ...change, contactId: event.target.value })}>
            <option value="">Keep</option>
            {(contacts.data?.contacts ?? []).map((contact) => (
              <option key={contact.id} value={contact.id}>
                {contact.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="New description">
          <input value={change.description} maxLength={500} placeholder="Keep" onChange={(event) => setChange({ ...change, description: event.target.value })} />
        </Field>
      </div>
      {plan ? (
        <>
          {stuck.length > 0 ? (
            <Notice tone="warning">
              {stuck.map((item) => (
                <div key={item.bankTransactionId}>
                  {formatDate(item.date)} {item.contactName} {item.total}: {item.blocked}
                </div>
              ))}
              Take {stuck.length === 1 ? "it" : "them"} out to recode the rest.
            </Notice>
          ) : null}
          {plan.effect.length > 0 ? (
            <table className={ui.table}>
              <thead>
                <tr>
                  <th>Month</th>
                  <th>Account</th>
                  <th className={ui.num}>Change</th>
                </tr>
              </thead>
              <tbody>
                {plan.effect.map((row) => (
                  <tr key={`${row.month}-${row.accountCode}`}>
                    <td>{row.month}</td>
                    <td>{row.accountCode}</td>
                    <td className={ui.num}>
                      <Money value={row.amount} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className={ui.muted}>No account changes: only the GST code, contact or description.</p>
          )}
        </>
      ) : null}
      <div className={ui.actions}>
        {plan ? (
          <Button disabled={busy || stuck.length > 0} onClick={() => void go()}>
            {busy ? "Recoding…" : ids.length === 1 ? "Recode it" : `Recode ${ids.length}`}
          </Button>
        ) : (
          <Button disabled={busy || !something || ids.length === 0} onClick={() => void preview()}>
            {busy ? "Working…" : "Preview"}
          </Button>
        )}
        {onCancel ? (
          <Button variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/** Edit one spend or receive money in place (RC1). */
export function EditInPlace({ organisationId, transaction, onDone, onCancel }: { organisationId: string; transaction: BankTransaction; onDone: (message: string) => void; onCancel: () => void }) {
  const codes = [...new Set(transaction.lines.map((line) => line.accountCode))];
  return (
    <Card title="Edit" description="Corrects this transaction itself on its own date: it's voided and posted again with the new coding, and stays reconciled. No recoding journal.">
      <ChangeAndPreview organisationId={organisationId} ids={[transaction.id]} fromChoices={codes} initialFrom={codes.length === 1 ? "" : codes[0]} onDone={onDone} onCancel={onCancel} />
    </Card>
  );
}

/** Recode several (RC6): find them, tick them, change them. */
export function BulkRecode({ organisationId }: { organisationId: string }) {
  const [filters, setFilters] = useState({ accountCode: "", text: "", from: "", to: "" });
  const [applied, setApplied] = useState(filters);
  const found = useApiData<{ transactions: BankTransaction[] }>("/api/bank-transactions/recode", { organisationId, ...applied });
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [message, setMessage] = useState<string | null>(null);
  const list = found.data?.transactions ?? [];
  const codes = [...new Set(list.flatMap((transaction) => transaction.lines.map((line) => line.accountCode)))].sort();
  return (
    <Card title="Recode spend and receive money" description="Change the account, GST code, contact or description of many at once. Each is corrected on its own date and stays reconciled.">
      {message ? <Notice tone="success">{message}</Notice> : null}
      <form
        className={ui.inlineForm}
        onSubmit={(event) => {
          event.preventDefault();
          setTicked(new Set());
          setApplied(filters);
        }}
      >
        <Field label="Coded to account">
          <input value={filters.accountCode} maxLength={20} onChange={(event) => setFilters({ ...filters, accountCode: event.target.value })} />
        </Field>
        <Field label="Text" hint="In the description, contact or reference.">
          <input value={filters.text} maxLength={100} onChange={(event) => setFilters({ ...filters, text: event.target.value })} />
        </Field>
        <Field label="From">
          <input type="date" value={filters.from} onChange={(event) => setFilters({ ...filters, from: event.target.value })} />
        </Field>
        <Field label="To">
          <input type="date" value={filters.to} onChange={(event) => setFilters({ ...filters, to: event.target.value })} />
        </Field>
        <Button type="submit" variant="secondary">
          Find
        </Button>
      </form>
      {found.error ? <Notice tone="error">{found.error}</Notice> : null}
      {list.length > 0 ? (
        <div className={ui.tableWrap}>
          <table className={ui.table}>
            <thead>
              <tr>
                <th>
                  <input
                    type="checkbox"
                    aria-label="Select all"
                    checked={ticked.size === Math.min(list.length, 100)}
                    onChange={(event) => setTicked(event.target.checked ? new Set(list.slice(0, 100).map((entry) => entry.id)) : new Set())}
                  />
                </th>
                <th>Date</th>
                <th>Contact</th>
                <th>Lines</th>
                <th className={ui.num}>Total</th>
              </tr>
            </thead>
            <tbody>
              {list.map((transaction) => (
                <tr key={transaction.id}>
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`Select ${transaction.contactName} ${transaction.date}`}
                      checked={ticked.has(transaction.id)}
                      onChange={(event) => {
                        const next = new Set(ticked);
                        if (event.target.checked) next.add(transaction.id);
                        else next.delete(transaction.id);
                        setTicked(next);
                      }}
                    />
                  </td>
                  <td style={{ whiteSpace: "nowrap" }}>{formatDate(transaction.date)}</td>
                  <td>{transaction.contactName}</td>
                  <td>
                    {transaction.lines.map((line) => (
                      <div key={line.lineOrder}>
                        {line.description} <span className={ui.muted}>({line.accountCode}{line.taxCode ? `, ${line.taxCode}` : ""})</span>
                      </div>
                    ))}
                  </td>
                  <td className={ui.num}>
                    <Money value={transaction.kind === "spend" ? `-${transaction.total}` : transaction.total} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : found.data ? (
        <p className={ui.muted}>None found.</p>
      ) : null}
      {ticked.size > 0 ? (
        <ChangeAndPreview
          key={[...ticked].join(",")}
          organisationId={organisationId}
          ids={[...ticked]}
          fromChoices={codes}
          initialFrom={applied.accountCode}
          onDone={(text) => {
            setMessage(text);
            setTicked(new Set());
            found.reload();
          }}
        />
      ) : null}
    </Card>
  );
}
