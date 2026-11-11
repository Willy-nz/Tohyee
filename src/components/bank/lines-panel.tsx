"use client";

import { DateInput } from "@/components/date-input";
import Link from "next/link";
import { Fragment, useState } from "react";
import { outcomeText, PlanReview } from "@/components/bank/batches";
import { InOutCells, journalHref, LineDetails, LineStatusBadge, originLabel } from "@/components/bank/common";
import { Pager } from "@/components/bank/reconcile-panel";
import { Money } from "@/components/books";
import { LineBaseValue } from "@/components/bank/foreign";
import { useApiData } from "@/components/hooks";
import { CustomValuesText, useCustomFields } from "@/components/custom-fields";
import { RecodeForm } from "@/components/recode";
import { EditInPlace } from "@/components/bank/recode-in-place";
import { TrackingTagsText, useTracking } from "@/components/tracking";
import { Badge, Button, Empty, Field, Notice, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import type { BankAccount, StatementLine } from "@/lib/bank/accounts";
import type { Plan } from "@/lib/bank/batches";
import { toggleAll, toggleSelection } from "@/lib/bank/batch-words";
import type { RunOutcome } from "@/lib/batches/service";
import type { BankTransaction, BankTransfer } from "@/lib/bank/transactions";
import { api, errorMessage, newIdempotencyKey } from "@/lib/client/api";
import { formatDate, formatDateTime, formatMoney, todayInBrowser, personName } from "@/lib/format";

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
  const { can, current } = useWorkspace();
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

  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [plan, setPlan] = useState<Plan | null>(null);
  const [batchKey, setBatchKey] = useState(() => newIdempotencyKey("unreconcile"));
  const [batchBusy, setBatchBusy] = useState(false);
  // Unreconcile selected (BK11), or Remove & redo (BK45): unreconcile and void what each line created.
  const [mode, setMode] = useState<"unreconcile" | "redo">("unreconcile");
  const [removePayments, setRemovePayments] = useState(false);
  const batchPath = mode === "redo" ? "/api/bank-batches/remove-and-redo" : "/api/bank-batches/unreconcile";
  const [batchMessage, setBatchMessage] = useState<{ tone: "success" | "warning" | "error"; text: string; errors: string[] } | null>(null);
  const canChoose = can("bookkeeper");
  const choosable = (list.data?.lines ?? []).filter((line) => line.status === "reconciled").map((line) => line.id);

  function changed() {
    list.reload();
    onChanged();
  }

  async function previewUnreconcile(chosen: "unreconcile" | "redo" = mode, payments = removePayments) {
    setMode(chosen);
    setRemovePayments(payments);
    setBatchBusy(true);
    setBatchMessage(null);
    try {
      const path = chosen === "redo" ? "/api/bank-batches/remove-and-redo" : "/api/bank-batches/unreconcile";
      const answer = await api<{ plan: Plan }>(path, { method: "POST", body: { organisationId, lineIds: [...selected], removePayments: payments } });
      setPlan(answer.plan);
    } catch (caught) {
      setBatchMessage({ tone: "error", text: errorMessage(caught), errors: [] });
    } finally {
      setBatchBusy(false);
    }
  }

  async function confirmUnreconcile() {
    if (!plan) return;
    setBatchBusy(true);
    try {
      const outcome = await api<RunOutcome>(batchPath, {
        method: "POST",
        body: { organisationId, lineIds: [...selected], removePayments, previewHash: plan.hash, idempotencyKey: batchKey },
      });
      const errors = outcome.batch.actions.filter((action) => action.error).map((action) => `Line ${action.targetId}: ${action.error}`);
      setBatchMessage({
        tone: outcome.stopped || outcome.batch.counts.failed ? "warning" : "success",
        text: `${mode === "redo" ? "Remove & redo" : "Unreconcile selected"} (batch ${outcome.batch.id}): ${outcomeText(outcome)}`,
        errors,
      });
      setPlan(null);
      setSelected(new Set());
      setBatchKey(newIdempotencyKey("unreconcile"));
      changed();
    } catch (caught) {
      setBatchMessage({ tone: "error", text: errorMessage(caught), errors: [] });
    } finally {
      setBatchBusy(false);
    }
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
              setSelected(new Set());
              setPlan(null);
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
      {batchMessage ? (
        <Notice tone={batchMessage.tone}>
          {batchMessage.text}
          {batchMessage.errors.length ? (
            <ul style={{ margin: "4px 0 0", paddingLeft: 20 }}>
              {batchMessage.errors.map((text) => (
                <li key={text}>{text}</li>
              ))}
            </ul>
          ) : null}
        </Notice>
      ) : null}
      {canChoose && selected.size > 0 && !plan ? (
        <div className={ui.toolbar} role="region" aria-label="Chosen lines">
          <span>
            {selected.size} line{selected.size === 1 ? "" : "s"} chosen
          </span>
          <Button size="small" disabled={batchBusy} onClick={() => void previewUnreconcile("unreconcile", false)}>
            {batchBusy ? "Checking…" : "Unreconcile selected…"}
          </Button>
          <Button size="small" disabled={batchBusy} onClick={() => void previewUnreconcile("redo", removePayments)}>
            Remove &amp; redo…
          </Button>
          <label className={ui.checkbox}>
            <input type="checkbox" checked={removePayments} onChange={(event) => setRemovePayments(event.target.checked)} /> With Remove &amp; redo, void payments too
          </label>
          <Button size="small" variant="secondary" onClick={() => setSelected(new Set())}>
            Clear
          </Button>
        </div>
      ) : null}
      {plan ? (
        <PlanReview plan={plan} busy={batchBusy} onConfirm={() => void confirmUnreconcile()} onCancel={() => setPlan(null)} />
      ) : null}
      {list.error ? <Notice tone="error">{list.error}</Notice> : null}
      {!list.data && !list.error ? <p className={ui.muted}>Loading…</p> : null}
      {list.data && list.data.total === 0 ? <Empty>No lines here.</Empty> : null}
      {list.data && list.data.total > 0 ? (
        <>
          <div className={ui.tableWrap}>
            <table className={ui.table}>
              <thead>
                <tr>
                  {canChoose ? (
                    <th style={{ width: 36 }}>
                      <input
                        type="checkbox"
                        aria-label="Choose every reconciled line on this page"
                        disabled={choosable.length === 0 || Boolean(plan)}
                        checked={choosable.length > 0 && choosable.every((id) => selected.has(id))}
                        onChange={() => setSelected(toggleAll(selected, choosable))}
                      />
                    </th>
                  ) : null}
                  <th>Date</th>
                  <th>Description</th>
                  <th className={ui.num}>Money in{account.isForeign ? ` (${account.statementCurrency})` : ""}</th>
                  <th className={ui.num}>Money out{account.isForeign ? ` (${account.statementCurrency})` : ""}</th>
                  <th className={ui.num}>Balance</th>
                  <th>Status</th>
                  <th>Reconciled with</th>
                  {can("bookkeeper") ? <th /> : null}
                </tr>
              </thead>
              <tbody>
                {list.data.lines.map((line) => (
                  <tr key={line.id}>
                    {canChoose ? (
                      <td>
                        {line.status === "reconciled" ? (
                          <input
                            type="checkbox"
                            aria-label={`Choose ${formatDate(line.date)} ${line.description} ${formatMoney(line.amount)}`}
                            disabled={Boolean(plan)}
                            checked={selected.has(line.id)}
                            onChange={() => setSelected(toggleSelection(selected, line.id))}
                          />
                        ) : null}
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
                      <div className={ui.muted}>{line.source === "akahu" ? "Bank feed" : line.source === "simplefin" ? "SimpleFIN feed" : line.source === "stripe" ? "Stripe feed" : line.source === "paypal" ? "PayPal feed" : line.source === "wise" ? "Wise feed" : "Imported file"}</div>
                      {account.isForeign ? <LineBaseValue line={line} baseCurrency={current?.baseCurrency ?? "NZD"} /> : null}
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
                          {line.reconciliation.split ? (
                            <span className={ui.muted}>
                              {formatMoney(line.amount)} of {formatMoney(line.reconciliation.split.journalAmount)}, split with{" "}
                              {line.reconciliation.split.lines
                                .filter((other) => other.id !== line.id)
                                .map((other) => `${formatDate(other.date)} (${formatMoney(other.amount)})`)
                                .join(", ")}
                              . Unreconciling unreconciles them all.
                            </span>
                          ) : null}
                          <span className={ui.muted}>
                            {personName(line.reconciliation, "createdBy") ?? "Someone"}, {formatDateTime(line.reconciliation.createdAt)}
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
          {canChoose && choosable.length > 0 && selected.size === 0 ? (
            <p className={ui.muted} style={{ margin: 0 }}>
              Tick reconciled lines to unreconcile several at once. You&apos;ll see what will happen before anything changes.
            </p>
          ) : null}
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
        <DateInput aria-label={`Void date for ${label}`} value={voidDate} onChange={(event) => setVoidDate(event.target.value)} />
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
export function TransactionsPanel({ organisationId, account, focusTransactionId = null }: { organisationId: string; account: BankAccount; focusTransactionId?: string | null }) {
  const { can, current } = useWorkspace();
  const listed = useApiData<{ bankTransactions: BankTransaction[] }>("/api/bank-transactions", {
    organisationId,
    accountId: account.id,
    limit: 200,
  });
  // A transaction opened from a report (decision 1565): shown first, even if it's older than the 200 listed, with Recode open.
  const focus = useApiData<{ bankTransaction: BankTransaction }>(focusTransactionId ? `/api/bank-transactions/${focusTransactionId}` : null, { organisationId });
  const focused = focus.data?.bankTransaction ?? null;
  const transactions = {
    ...listed,
    data: listed.data
      ? { bankTransactions: focused ? [focused, ...listed.data.bankTransactions.filter((entry) => entry.id !== focused.id)] : listed.data.bankTransactions }
      : null,
  };
  const [openedFocus, setOpenedFocus] = useState<string | null>(null);
  const transfers = useApiData<{ transfers: BankTransfer[] }>("/api/bank-transfers", { organisationId, accountId: account.id, limit: 200 });
  const tracking = useTracking(organisationId);
  const customSetup = useCustomFields(organisationId);
  const [recoding, setRecoding] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [recoded, setRecoded] = useState<string | null>(null);
  if (focused && openedFocus !== focused.id) {
    setOpenedFocus(focused.id);
    if (focused.status === "posted" && can("bookkeeper")) setRecoding(focused.id);
  }

  return (
    <div style={{ display: "grid", gap: 16 }}>
      {recoded ? <Notice tone="success">{recoded}</Notice> : null}
      {focus.error ? <Notice tone="error">{focus.error}</Notice> : null}
      <p className={ui.muted}>
        Posted from reconciling. Edit corrects one in place on its own date and keeps it reconciled; Recode posts a correcting journal instead.
        To undo one, unreconcile its line first (Statement lines tab), then void it here: voiding posts the exact reversal on the date you choose.{" "}
        {can("bookkeeper") ? <Link href="/operations/bank-transactions/recode">Recode several at once</Link> : null}
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
                <Fragment key={transaction.id}>
                <tr
                  className={transaction.id === focused?.id ? ui.selectedRow : undefined}
                  ref={transaction.id === focused?.id ? (row) => row?.scrollIntoView({ block: "center" }) : undefined}
                >
                  <td style={{ whiteSpace: "nowrap" }}>{formatDate(transaction.date)}</td>
                  <td>
                    {transaction.contactName}
                    {transaction.reference ? <div className={ui.muted}>{transaction.reference}</div> : null}
                    {transaction.exchangeRate ? (
                      <div className={ui.muted}>
                        {transaction.currencyCode} {formatMoney(transaction.total)} at {transaction.exchangeRate} = {current?.baseCurrency ?? "NZD"}{" "}
                        {formatMoney(transaction.baseTotal)}
                      </div>
                    ) : null}
                    <CustomValuesText setup={customSetup.data} values={transaction.customFields} />
                  </td>
                  <td>
                    {transaction.lines.map((line) => (
                      <div key={line.lineOrder}>
                        {line.description} <span className={ui.muted}>({line.accountCode})</span>
                        <TrackingTagsText setup={tracking.data} tags={line.tracking} />
                        <CustomValuesText setup={customSetup.data} values={line.customFields} />
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
                        <span className={ui.rowButtons}>
                          <Button
                            variant="secondary"
                            size="small"
                            onClick={() => {
                              setRecoding(null);
                              setEditing(editing === transaction.id ? null : transaction.id);
                            }}
                          >
                            Edit
                          </Button>
                          <Button
                            variant="secondary"
                            size="small"
                            onClick={() => {
                              setEditing(null);
                              setRecoding(recoding === transaction.id ? null : transaction.id);
                            }}
                          >
                            Recode
                          </Button>
                          <VoidButton
                            organisationId={organisationId}
                            path={`/api/bank-transactions/${transaction.id}/void`}
                            label={`${transaction.contactName} ${transaction.date}`}
                            onVoided={transactions.reload}
                          />
                        </span>
                      ) : null}
                    </td>
                  ) : null}
                </tr>
                {editing === transaction.id ? (
                  <tr>
                    <td colSpan={8}>
                      <EditInPlace
                        organisationId={organisationId}
                        transaction={transaction}
                        onCancel={() => setEditing(null)}
                        onDone={(text) => {
                          setRecoded(text);
                          setEditing(null);
                          transactions.reload();
                        }}
                      />
                    </td>
                  </tr>
                ) : null}
                {recoding === transaction.id ? (
                  <tr>
                    <td colSpan={8}>
                      <RecodeForm
                        organisationId={organisationId}
                        documentType="bank_transaction"
                        documentId={transaction.id}
                        lines={transaction.lines}
                        onDone={(text) => {
                          setRecoded(text);
                          setRecoding(null);
                          transactions.reload();
                        }}
                      />
                    </td>
                  </tr>
                ) : null}
                </Fragment>
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
                    {transfer.currencyCode !== (current?.baseCurrency ?? "NZD") ? `${transfer.currencyCode} ` : ""}
                    <Money value={transfer.amount} />
                    {transfer.toAmount !== null ? (
                      <div className={ui.muted}>
                        arrived as {transfer.toCurrencyCode} {formatMoney(transfer.toAmount)}
                        {transfer.carryingAmount !== null
                          ? `; carrying value ${formatMoney(transfer.carryingAmount)}, realised ${
                              transfer.realisedGain?.startsWith("-") ? "loss" : "gain"
                            } ${formatMoney(transfer.realisedGain?.replace(/^-/, "") ?? "0")}`
                          : ""}
                      </div>
                    ) : null}
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
