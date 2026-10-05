"use client";

import { type FormEvent, Fragment, useState } from "react";
import { AccountSelect, Money, RequireOrganisation, useAccounts } from "@/components/books";
import { useConfirm } from "@/components/confirm-dialog";
import { useApiData } from "@/components/hooks";
import { Badge, Button, Card, Empty, Field, Notice, Page, PageHeader, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import type { Account } from "@/lib/accounts/service";
import { api, errorMessage, newIdempotencyKey } from "@/lib/client/api";
import { formatDate, formatMoney, todayInBrowser, personName } from "@/lib/format";
import { rateInEffect } from "@/lib/fx/rate-text";
import type { ExchangeRatesList } from "@/lib/fx/rates";
import type { FxRevaluationDocument, FxRevaluationRun, OpenForeignDocument } from "@/lib/ledger/fx-revaluation";

type BalanceDraft = { key: number; accountCode: string; foreignAmount: string; closingRate: string };

let rowKey = 0;
const blankRow = (): BalanceDraft => {
  rowKey += 1;
  return { key: rowKey, accountCode: "", foreignAmount: "", closingRate: "" };
};

function nextDay(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  const next = new Date(Date.UTC(year, month - 1, day + 1));
  return next.toISOString().slice(0, 10);
}

type OpenBalance = {
  accountId: string;
  accountCode: string;
  accountName: string;
  currencyCode: string;
  foreign: string;
  base: string;
  documents: OpenForeignDocument[];
};

/** A document's revaluation as a gain (positive) or loss (negative): on payables, a larger amount owed is a loss. */
function asGain(delta: string, balanceType: "asset" | "liability"): string {
  if (balanceType === "asset") return delta;
  return delta.startsWith("-") ? delta.slice(1) : delta === "0.00" ? delta : `-${delta}`;
}

function documentLabel(document: { kind: string; documentNumber: string | null; documentId: string }): string {
  const nouns: Record<string, string> = {
    invoice: "Invoice",
    credit_note: "Credit note",
    overpayment: "",
    bill: "Bill",
    supplier_credit_note: "Supplier credit note",
  };
  return [nouns[document.kind], document.documentNumber ?? `#${document.documentId}`].filter(Boolean).join(" ");
}

function RevaluationForm({
  organisationId,
  accounts,
  onPosted,
}: {
  organisationId: string;
  accounts: Account[];
  onPosted: (run: FxRevaluationRun) => void;
}) {
  const foreignAccounts = accounts.filter((account) => account.currencyCode && account.isActive);
  const bySystem = (key: string) => accounts.find((account) => account.systemKey === key)?.code ?? "";
  const [date, setDate] = useState(todayInBrowser);
  const [reference, setReference] = useState("");
  const [rateSource, setRateSource] = useState("");
  const [gain, setGain] = useState(() => bySystem("unrealised_fx_gain"));
  const [loss, setLoss] = useState(() => bySystem("unrealised_fx_loss"));
  const [rows, setRows] = useState<BalanceDraft[]>([blankRow()]);
  const [key, setKey] = useState(() => newIdempotencyKey("fx"));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Open foreign-currency invoices and bills on accounts receivable and payable (MC8), one closing rate each.
  const open = useApiData<{ balances: OpenBalance[] }>(date ? "/api/ledger/revaluations/open-balances" : null, { organisationId, asAt: date });
  const [openRates, setOpenRates] = useState<Record<string, string>>({});
  const openKey = (balance: OpenBalance) => `${balance.accountCode}|${balance.currencyCode}`;
  const openBalances = open.data?.balances ?? [];
  // The exchange rates list's rate in effect on the revaluation date is suggested as the closing rate (MC53).
  const listed = useApiData<ExchangeRatesList>("/api/fx/rates", { organisationId });
  const listRate = (currencyCode: string | null | undefined) =>
    currencyCode && /^\d{4}-\d{2}-\d{2}$/.test(date) ? (rateInEffect(listed.data?.rates ?? [], currencyCode, date)?.rate ?? "") : "";
  const openRate = (balance: OpenBalance) => openRates[openKey(balance)] ?? listRate(balance.currencyCode);

  if (foreignAccounts.length === 0 && openBalances.length === 0) {
    return (
      <Empty>
        There are no foreign-currency accounts yet. In the chart of accounts, set a currency on the bank, receivable or
        payable accounts that hold foreign money.
      </Empty>
    );
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await api<{ run: FxRevaluationRun }>("/api/ledger/revaluations", {
        method: "POST",
        body: {
          organisationId,
          source: "ui",
          idempotencyKey: key,
          reference,
          revaluationDate: date,
          reversalPostingDate: nextDay(date),
          rateDate: date,
          rateSource,
          unrealisedGainAccountCode: gain,
          unrealisedLossAccountCode: loss,
          balances: [
            ...rows
              .filter((row) => row.accountCode || row.closingRate)
              .map((row) => ({
                accountCode: row.accountCode,
                // Blank: the ledger's foreign balance (FXB7).
                foreignAmount: row.foreignAmount.trim() || undefined,
                closingRate: row.closingRate,
              })),
            ...openBalances
              .filter((balance) => openRate(balance).trim())
              .map((balance) => ({ accountCode: balance.accountCode, currencyCode: balance.currencyCode, closingRate: openRate(balance).trim() })),
          ],
        },
      });
      setKey(newIdempotencyKey("fx"));
      setRows([blankRow()]);
      setOpenRates({});
      setReference("");
      onPosted(result.run);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(event) => void submit(event)} style={{ display: "grid", gap: 12 }}>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <div className={ui.grid4}>
        <Field label="Revaluation date" hint={`Reverses automatically on ${formatDate(nextDay(date))}.`}>
          <input type="date" value={date} onChange={(event) => setDate(event.target.value)} required />
        </Field>
        <Field label="Reference">
          <input value={reference} onChange={(event) => setReference(event.target.value)} maxLength={100} required />
        </Field>
        <Field label="Rate source" hint="e.g. RBNZ closing rate">
          <input value={rateSource} onChange={(event) => setRateSource(event.target.value)} maxLength={100} required />
        </Field>
      </div>
      <div className={ui.grid2}>
        <Field label="Unrealised gain account">
          <AccountSelect
            accounts={accounts}
            value={gain}
            onChange={setGain}
            filter={(account) => account.accountClass === "revenue" || account.accountClass === "expense"}
            required
          />
        </Field>
        <Field label="Unrealised loss account">
          <AccountSelect
            accounts={accounts}
            value={loss}
            onChange={setLoss}
            filter={(account) => account.accountClass === "revenue" || account.accountClass === "expense"}
            required
          />
        </Field>
      </div>
      <div className={ui.tableWrap}>
        <table className={ui.table}>
          <thead>
            <tr>
              <th>Foreign-currency account</th>
              <th className={ui.num}>
                Balance in that currency
                <div className={ui.muted} style={{ fontWeight: "normal" }}>
                  Blank: the ledger&apos;s
                </div>
              </th>
              <th className={ui.num}>Closing rate (base per 1)</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key}>
                <td>
                  <AccountSelect
                    ariaLabel="Account"
                    accounts={foreignAccounts}
                    value={row.accountCode}
                    onChange={(code) =>
                      setRows((current) =>
                        current.map((entry) =>
                          entry.key === row.key
                            ? {
                                ...entry,
                                accountCode: code,
                                closingRate: entry.closingRate || listRate(foreignAccounts.find((account) => account.code === code)?.currencyCode),
                              }
                            : entry,
                        ),
                      )
                    }
                    required={openBalances.length === 0}
                  />
                </td>
                <td>
                  <input
                    aria-label="Foreign balance"
                    className={ui.num}
                    inputMode="decimal"
                    value={row.foreignAmount}
                    onChange={(event) =>
                      setRows((current) => current.map((entry) => (entry.key === row.key ? { ...entry, foreignAmount: event.target.value } : entry)))
                    }
                    placeholder="From the ledger"
                  />
                </td>
                <td>
                  <input
                    aria-label="Closing rate"
                    className={ui.num}
                    inputMode="decimal"
                    value={row.closingRate}
                    onChange={(event) =>
                      setRows((current) => current.map((entry) => (entry.key === row.key ? { ...entry, closingRate: event.target.value } : entry)))
                    }
                    required={openBalances.length === 0 || row.accountCode !== ""}
                  />
                </td>
                <td>
                  <Button
                    variant="secondary"
                    size="small"
                    disabled={rows.length === 1}
                    onClick={() => setRows((current) => current.filter((entry) => entry.key !== row.key))}
                  >
                    ×
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {openBalances.length > 0 ? (
        <div className={ui.tableWrap}>
          <table className={ui.table}>
            <thead>
              <tr>
                <th>Open foreign-currency invoices and bills</th>
                <th className={ui.num}>Open in that currency</th>
                <th className={ui.num}>At their own rates</th>
                <th className={ui.num}>Closing rate (base per 1)</th>
              </tr>
            </thead>
            <tbody>
              {openBalances.map((balance) => (
                <Fragment key={openKey(balance)}>
                <tr>
                  <td>
                    {balance.accountCode} · {balance.accountName} · {balance.currencyCode}
                  </td>
                  <td className={ui.num}>
                    {balance.currencyCode} {formatMoney(balance.foreign)}
                  </td>
                  <td className={ui.num}>
                    <Money value={balance.base} />
                  </td>
                  <td>
                    <input
                      aria-label={`Closing rate for ${balance.accountCode} ${balance.currencyCode}`}
                      className={ui.num}
                      inputMode="decimal"
                      value={openRate(balance)}
                      onChange={(event) => setOpenRates((current) => ({ ...current, [openKey(balance)]: event.target.value }))}
                      placeholder="Leave blank to skip"
                    />
                  </td>
                </tr>
                {/* Each open document is revalued on its own (MC39), like NetSuite's Open Receivables and Open Payables. */}
                {balance.documents.map((document) => (
                  <tr key={`${document.kind}-${document.documentId}`} className={ui.muted}>
                    <td>
                      {documentLabel(document)} · {formatDate(document.documentDate)} · at {document.rate}
                    </td>
                    <td className={ui.num}>
                      {balance.currencyCode} {formatMoney(document.foreign)}
                    </td>
                    <td className={ui.num}>
                      <Money value={document.base} />
                    </td>
                    <td />
                  </tr>
                ))}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      <div className={ui.actions}>
        <Button variant="secondary" onClick={() => setRows((current) => [...current, blankRow()])}>
          Add account
        </Button>
        <Button type="submit" disabled={busy}>
          {busy ? "Posting…" : "Post revaluation"}
        </Button>
        <span className={ui.muted}>
          The carrying amount comes from the ledger; you give the closing rate (and the foreign balance only when the ledger doesn&apos;t have it).
          Closing rates start as the exchange rates list&apos;s rate in effect on the revaluation date, if there is one.
        </span>
      </div>
    </form>
  );
}

/**
 * Voids a revaluation, the whole run (FXB12): the server posts the exact
 * reversal of its journal and of its reversal journal, and refuses it once a
 * later revaluation of its accounts exists.
 */
function VoidRevaluation({ organisationId, run, onVoided }: { organisationId: string; run: FxRevaluationRun; onVoided: (run: FxRevaluationRun) => void }) {
  const confirm = useConfirm();
  const [key] = useState(() => newIdempotencyKey("fx-void"));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function voidRun() {
    const accounts = run.items.map((item) => `${item.accountCode} ${item.currencyCode}`).join(", ");
    const message = `Void ${run.reference}? It posts the exact reversal of its journal on ${formatDate(run.revaluationDate)} and of its reversal on ${formatDate(run.reversalPostingDate)}, for every account it revalued (${accounts}).`;
    if (!(await confirm(message, { title: "Void revaluation", confirmLabel: "Void", danger: true }))) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api<{ run: FxRevaluationRun }>(`/api/ledger/revaluations/${run.id}/void`, {
        method: "POST",
        body: { organisationId, source: "ui", idempotencyKey: key },
      });
      onVoided(result.run);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Button variant="danger" size="small" onClick={() => void voidRun()} disabled={busy}>
        {busy ? "Voiding…" : "Void"}
      </Button>
      {error ? <Notice tone="error">{error}</Notice> : null}
    </>
  );
}

function FxRevaluation({ organisationId }: { organisationId: string }) {
  const { can } = useWorkspace();
  const accounts = useAccounts(organisationId);
  const accountsHaveCurrency = (code: string) => Boolean(accounts.data?.accounts.find((account) => account.code === code)?.currencyCode);
  const runs = useApiData<{ revaluations: FxRevaluationRun[] }>("/api/ledger/revaluations", { organisationId });
  const [message, setMessage] = useState<string | null>(null);
  return (
    <>
      {message ? <Notice tone="success">{message}</Notice> : null}
      <Card title="Revalue foreign-currency balances">
        <p className={ui.muted}>
          Tohyee keeps the foreign amount of everything posted to a foreign-currency account, so leave the balance blank to use the
          ledger&apos;s. Type it only for an account with postings from before Tohyee kept foreign amounts and no opening foreign
          balance yet; if you type it for another account, it must agree with the ledger.
        </p>
        {accounts.data ? (
          <RevaluationForm
            organisationId={organisationId}
            accounts={accounts.data.accounts}
            onPosted={(run) => {
              setMessage(`Posted revaluation ${run.reference} (journal #${run.revaluationJournalId}, reversing in #${run.reversalJournalId}).`);
              runs.reload();
            }}
          />
        ) : (
          <p className={ui.muted}>{accounts.error ?? "Loading accounts…"}</p>
        )}
      </Card>
      <Card title="Past revaluations">
        {runs.error ? <Notice tone="error">{runs.error}</Notice> : null}
        {runs.data && runs.data.revaluations.length === 0 ? <Empty>None yet.</Empty> : null}
        {(runs.data?.revaluations ?? []).map((run) => (
          <div key={run.id} className={ui.tableWrap}>
            <table className={ui.table}>
              <thead>
                <tr>
                  <th colSpan={6}>
                    {run.reference} · {formatDate(run.revaluationDate)} · {run.rateSource} · by {personName(run, "operator")}
                    {run.voided ? (
                      <>
                        {" "}
                        <Badge tone="red">Voided</Badge>{" "}
                        <span className={ui.muted} style={{ fontWeight: "normal" }}>
                          by {personName(run.voided, "voidedBy")} on {formatDate(String(run.voided.voidedAt).slice(0, 10))}
                        </span>
                      </>
                    ) : can("bookkeeper") ? (
                      <>
                        {" "}
                        <VoidRevaluation
                          organisationId={organisationId}
                          run={run}
                          onVoided={(voided) => {
                            setMessage(`Voided revaluation ${voided.reference} (journals #${voided.voided?.voidJournalId} and #${voided.voided?.voidReversalJournalId}).`);
                            runs.reload();
                          }}
                        />
                      </>
                    ) : null}
                  </th>
                </tr>
                <tr>
                  <th>Account</th>
                  <th className={ui.num}>Foreign</th>
                  <th className={ui.num}>Rate</th>
                  <th className={ui.num}>Carrying</th>
                  <th className={ui.num}>Revalued</th>
                  <th className={ui.num}>Gain / (loss)</th>
                </tr>
              </thead>
              <tbody>
                {run.items.map((item) => (
                  <Fragment key={item.lineOrder}>
                  <tr>
                    <td>
                      {item.accountCode} · {item.accountName}
                      {item.currencyCode && !accountsHaveCurrency(item.accountCode) ? ` · ${item.currencyCode}` : ""}
                    </td>
                    <td className={ui.num}>
                      {item.currencyCode} {formatMoney(item.foreignAmount)}
                    </td>
                    <td className={ui.num}>{item.closingRate}</td>
                    <td className={ui.num}>
                      <Money value={item.carryingAmount} />
                    </td>
                    <td className={ui.num}>
                      <Money value={item.revaluedAmount} />
                    </td>
                    <td className={ui.num}>
                      <Money value={asGain(item.deltaAmount, item.balanceType)} />
                    </td>
                  </tr>
                  {item.documents.map((document: FxRevaluationDocument) => (
                    <tr key={`${document.kind}-${document.documentId}`} className={ui.muted}>
                      <td>
                        {documentLabel(document)} · at {document.documentRate}
                      </td>
                      <td className={ui.num}>
                        {document.currencyCode} {formatMoney(document.foreignAmount)}
                      </td>
                      <td className={ui.num}>{document.closingRate}</td>
                      <td className={ui.num}>
                        <Money value={document.carryingAmount} />
                      </td>
                      <td />
                      <td className={ui.num}>
                        <Money value={asGain(document.deltaAmount, item.balanceType)} />
                      </td>
                    </tr>
                  ))}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </Card>
    </>
  );
}

export default function FxRevaluationPage() {
  return (
    <Page>
      <PageHeader
        title="FX revaluation"
        description="Month-end revaluation of foreign-currency balances to the closing rate. Each run reverses itself the next day, so unrealised gains and losses aren't double counted."
      />
      <RequireOrganisation>{(organisationId) => <FxRevaluation key={organisationId} organisationId={organisationId} />}</RequireOrganisation>
    </Page>
  );
}
