"use client";

import { type FormEvent, useState } from "react";
import { AccountSelect, Money, RequireOrganisation, useAccounts } from "@/components/books";
import { useApiData } from "@/components/hooks";
import { Button, Card, Empty, Field, Notice, Page, PageHeader, ui } from "@/components/ui";
import type { Account } from "@/lib/accounts/service";
import { api, errorMessage, newIdempotencyKey } from "@/lib/client/api";
import { formatDate, formatMoney, todayInBrowser } from "@/lib/format";
import type { FxRevaluationRun } from "@/lib/ledger/fx-revaluation";

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

  if (foreignAccounts.length === 0) {
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
          balances: rows.map((row) => ({
            accountCode: row.accountCode,
            foreignAmount: row.foreignAmount,
            closingRate: row.closingRate,
          })),
        },
      });
      setKey(newIdempotencyKey("fx"));
      setRows([blankRow()]);
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
              <th className={ui.num}>Balance in that currency</th>
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
                    onChange={(code) => setRows((current) => current.map((entry) => (entry.key === row.key ? { ...entry, accountCode: code } : entry)))}
                    required
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
                    required
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
                    required
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
      <div className={ui.actions}>
        <Button variant="secondary" onClick={() => setRows((current) => [...current, blankRow()])}>
          Add account
        </Button>
        <Button type="submit" disabled={busy}>
          {busy ? "Posting…" : "Post revaluation"}
        </Button>
        <span className={ui.muted}>The carrying amount comes from the ledger; you only give the foreign balance and the rate.</span>
      </div>
    </form>
  );
}

function FxRevaluation({ organisationId }: { organisationId: string }) {
  const accounts = useAccounts(organisationId);
  const runs = useApiData<{ revaluations: FxRevaluationRun[] }>("/api/ledger/revaluations", { organisationId });
  const [message, setMessage] = useState<string | null>(null);
  return (
    <>
      {message ? <Notice tone="success">{message}</Notice> : null}
      <Card title="Revalue foreign-currency balances">
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
                    {run.reference} · {formatDate(run.revaluationDate)} · {run.rateSource} · by {run.operatorEmail}
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
                  <tr key={item.lineOrder}>
                    <td>
                      {item.accountCode} · {item.accountName}
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
                      <Money value={item.balanceType === "asset" ? item.deltaAmount : item.deltaAmount.startsWith("-") ? item.deltaAmount.slice(1) : `-${item.deltaAmount}`} />
                    </td>
                  </tr>
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
