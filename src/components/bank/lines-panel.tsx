"use client";

import Link from "next/link";
import { useState } from "react";
import { InOutCells, journalHref, LineDetails, LineStatusBadge, originLabel } from "@/components/bank/common";
import { Pager } from "@/components/bank/reconcile-panel";
import { Money } from "@/components/books";
import { useApiData } from "@/components/hooks";
import { Badge, Button, Empty, Field, Notice, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import type { BankAccount, StatementLine } from "@/lib/bank/accounts";
import type { BankTransaction, BankTransfer } from "@/lib/bank/transactions";
import { api, errorMessage, newIdempotencyKey } from "@/lib/client/api";
import { formatDate, formatDateTime, todayInBrowser } from "@/lib/format";

const PAGE_SIZE = 100;

const FILTERS = [
  { status: "all", label: "All" },
  { status: "unreconciled", label: "To reconcile" },
  { status: "reconciled", label: "Reconciled" },
  { status: "excluded", label: "Excluded" },
  { status: "deleted", label: "Deleted" },
] as const;

function LineActions({ organisationId, line, onChanged }: { organisationId: string; line: StatementLine; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(path: string, body: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    try {
      await api(path, { method: "POST", body: { organisationId, ...body } });
      onChanged();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: "grid", gap: 6, justifyItems: "end" }}>
      {line.status === "reconciled" ? (
        <Button
          variant="secondary"
          size="small"
          disabled={busy}
          onClick={() =>
            void run(`/api/statement-lines/${line.id}/unreconcile`, { source: "ui", idempotencyKey: newIdempotencyKey("unreconcile") })
          }
          title="The line goes back to be reconciled. Nothing posted is changed; void it separately if it was wrong."
        >
          Unreconcile
        </Button>
      ) : null}
      {line.status === "excluded" ? (
        <Button variant="secondary" size="small" disabled={busy} onClick={() => void run(`/api/statement-lines/${line.id}/exclude`, { excluded: false })}>
          Include again
        </Button>
      ) : null}
      {line.status === "unreconciled" ? (
        <Button variant="secondary" size="small" disabled={busy} onClick={() => void run(`/api/statement-lines/${line.id}/exclude`, { excluded: true })}>
          Exclude
        </Button>
      ) : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
    </div>
  );
}

/** Every statement line on the account, with what each was reconciled with. */
export function StatementLinesPanel({
  organisationId,
  account,
  onChanged,
}: {
  organisationId: string;
  account: BankAccount;
  onChanged: () => void;
}) {
  const { can } = useWorkspace();
  const [status, setStatus] = useState<(typeof FILTERS)[number]["status"]>("all");
  const [search, setSearch] = useState("");
  const [appliedSearch, setAppliedSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const list = useApiData<{ lines: StatementLine[]; total: number }>(`/api/bank-accounts/${account.id}/statement-lines`, {
    organisationId,
    status,
    search: appliedSearch || null,
    limit: PAGE_SIZE,
    offset,
  });

  function changed() {
    list.reload();
    onChanged();
  }

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div className={ui.tabs} role="tablist" aria-label="Line status">
        {FILTERS.map((filter) => (
          <button
            key={filter.status}
            type="button"
            role="tab"
            aria-selected={status === filter.status}
            className={`${ui.tab} ${status === filter.status ? ui.tabActive : ""}`}
            onClick={() => {
              setStatus(filter.status);
              setOffset(0);
            }}
          >
            {filter.label}
          </button>
        ))}
      </div>
      <form
        className={ui.inlineForm}
        onSubmit={(event) => {
          event.preventDefault();
          setAppliedSearch(search.trim());
          setOffset(0);
        }}
      >
        <Field label="Search" hint="Part of the description, or an exact amount like -45.00.">
          <input value={search} onChange={(event) => setSearch(event.target.value)} maxLength={100} />
        </Field>
        <Button type="submit" variant="secondary">
          Search
        </Button>
      </form>
      {list.error ? <Notice tone="error">{list.error}</Notice> : null}
      {!list.data && !list.error ? <p className={ui.muted}>Loading…</p> : null}
      {list.data && list.data.total === 0 ? <Empty>No lines here.</Empty> : null}
      {list.data && list.data.total > 0 ? (
        <>
          <div className={ui.tableWrap}>
            <table className={ui.table}>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Description</th>
                  <th className={ui.num}>Money in</th>
                  <th className={ui.num}>Money out</th>
                  <th className={ui.num}>Balance</th>
                  <th>Status</th>
                  <th>Reconciled with</th>
                  {can("bookkeeper") ? <th /> : null}
                </tr>
              </thead>
              <tbody>
                {list.data.lines.map((line) => (
                  <tr key={line.id}>
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
                      <div className={ui.muted}>{line.source === "akahu" ? "Bank feed" : "Imported file"}</div>
                    </td>
                    <InOutCells amount={line.amount} />
                    <td className={ui.num}>{line.balance !== null ? <Money value={line.balance} /> : null}</td>
                    <td>
                      <LineStatusBadge status={line.status} />
                    </td>
                    <td>
                      {line.reconciliation ? (
                        <div style={{ display: "grid", gap: 2 }}>
                          {line.reconciliation.items.map((item) => (
                            <span key={item.journalLineId}>
                              {originLabel(item.origin)} <Link href={journalHref(item.journalId)}>#{item.journalId}</Link>{" "}
                              <span className={ui.muted}>{item.reference}</span>
                            </span>
                          ))}
                          <span className={ui.muted}>
                            {line.reconciliation.createdByEmail ?? "Someone"}, {formatDateTime(line.reconciliation.createdAt)}
                          </span>
                        </div>
                      ) : null}
                    </td>
                    {can("bookkeeper") ? (
                      <td>
                        <LineActions organisationId={organisationId} line={line} onChanged={changed} />
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pager offset={offset} pageSize={PAGE_SIZE} total={list.data.total} onChange={setOffset} />
        </>
      ) : null}
    </div>
  );
}

function VoidButton({ path, label, onVoided, organisationId }: { path: string; label: string; onVoided: () => void; organisationId: string }) {
  const [asking, setAsking] = useState(false);
  const [voidDate, setVoidDate] = useState(() => todayInBrowser());
  const [key] = useState(() => newIdempotencyKey("void"));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      await api(path, { method: "POST", body: { organisationId, source: "ui", idempotencyKey: key, voidDate } });
      onVoided();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  if (!asking) {
    return (
      <Button variant="secondary" size="small" onClick={() => setAsking(true)}>
        Void
      </Button>
    );
  }
  return (
    <div style={{ display: "grid", gap: 6 }}>
      <label className={ui.muted}>
        Void date{" "}
        <input type="date" aria-label={`Void date for ${label}`} value={voidDate} onChange={(event) => setVoidDate(event.target.value)} />
      </label>
      <span style={{ display: "flex", gap: 6 }}>
        <Button variant="danger" size="small" disabled={busy} onClick={() => void run()}>
          {busy ? "Voiding…" : "Post the reversal"}
        </Button>
        <Button variant="secondary" size="small" onClick={() => setAsking(false)}>
          Cancel
        </Button>
      </span>
      {error ? <Notice tone="error">{error}</Notice> : null}
    </div>
  );
}

/** Spend and receive money and transfers posted on the account. */
export function TransactionsPanel({ organisationId, account }: { organisationId: string; account: BankAccount }) {
  const { can } = useWorkspace();
  const transactions = useApiData<{ bankTransactions: BankTransaction[] }>("/api/bank-transactions", {
    organisationId,
    accountId: account.id,
    limit: 200,
  });
  const transfers = useApiData<{ transfers: BankTransfer[] }>("/api/bank-transfers", { organisationId, accountId: account.id, limit: 200 });

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <p className={ui.muted}>
        Posted from reconciling. To undo one, unreconcile its line first (Statement lines tab), then void it here: voiding posts the exact
        reversal on the date you choose.
      </p>
      <h3 className={ui.cardTitle}>Spend and receive money</h3>
      {transactions.error ? <Notice tone="error">{transactions.error}</Notice> : null}
      {transactions.data && transactions.data.bankTransactions.length === 0 ? <Empty>None yet.</Empty> : null}
      {transactions.data && transactions.data.bankTransactions.length > 0 ? (
        <div className={ui.tableWrap}>
          <table className={ui.table}>
            <thead>
              <tr>
                <th>Date</th>
                <th>Contact</th>
                <th>Lines</th>
                <th className={ui.num}>GST</th>
                <th className={ui.num}>Money in</th>
                <th className={ui.num}>Money out</th>
                <th>Status</th>
                {can("bookkeeper") ? <th /> : null}
              </tr>
            </thead>
            <tbody>
              {transactions.data.bankTransactions.map((transaction) => (
                <tr key={transaction.id}>
                  <td style={{ whiteSpace: "nowrap" }}>{formatDate(transaction.date)}</td>
                  <td>
                    {transaction.contactName}
                    {transaction.reference ? <div className={ui.muted}>{transaction.reference}</div> : null}
                  </td>
                  <td>
                    {transaction.lines.map((line) => (
                      <div key={line.lineOrder}>
                        {line.description} <span className={ui.muted}>({line.accountCode})</span>
                      </div>
                    ))}
                  </td>
                  <td className={ui.num}>
                    <Money value={transaction.taxTotal} />
                  </td>
                  <InOutCells amount={transaction.kind === "receive" ? transaction.total : `-${transaction.total}`} />
                  <td>
                    {transaction.status === "voided" ? (
                      <Badge tone="red">Voided {formatDate(transaction.voidDate)}</Badge>
                    ) : (
                      <Link href={journalHref(transaction.journalId)}>Journal #{transaction.journalId}</Link>
                    )}
                  </td>
                  {can("bookkeeper") ? (
                    <td>
                      {transaction.status === "posted" ? (
                        <VoidButton
                          organisationId={organisationId}
                          path={`/api/bank-transactions/${transaction.id}/void`}
                          label={`${transaction.contactName} ${transaction.date}`}
                          onVoided={transactions.reload}
                        />
                      ) : null}
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      <h3 className={ui.cardTitle}>Transfers</h3>
      {transfers.error ? <Notice tone="error">{transfers.error}</Notice> : null}
      {transfers.data && transfers.data.transfers.length === 0 ? <Empty>None yet.</Empty> : null}
      {transfers.data && transfers.data.transfers.length > 0 ? (
        <div className={ui.tableWrap}>
          <table className={ui.table}>
            <thead>
              <tr>
                <th>Date</th>
                <th>From</th>
                <th>To</th>
                <th>Reference</th>
                <th className={ui.num}>Amount</th>
                <th>Status</th>
                {can("bookkeeper") ? <th /> : null}
              </tr>
            </thead>
            <tbody>
              {transfers.data.transfers.map((transfer) => (
                <tr key={transfer.id}>
                  <td style={{ whiteSpace: "nowrap" }}>{formatDate(transfer.date)}</td>
                  <td>{transfer.fromAccountCode}</td>
                  <td>{transfer.toAccountCode}</td>
                  <td>{transfer.reference}</td>
                  <td className={ui.num}>
                    <Money value={transfer.amount} />
                  </td>
                  <td>
                    {transfer.status === "voided" ? (
                      <Badge tone="red">Voided {formatDate(transfer.voidDate)}</Badge>
                    ) : (
                      <Link href={journalHref(transfer.journalId)}>Journal #{transfer.journalId}</Link>
                    )}
                  </td>
                  {can("bookkeeper") ? (
                    <td>
                      {transfer.status === "posted" ? (
                        <VoidButton
                          organisationId={organisationId}
                          path={`/api/bank-transfers/${transfer.id}/void`}
                          label={`transfer ${transfer.date}`}
                          onVoided={transfers.reload}
                        />
                      ) : null}
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}
