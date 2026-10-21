"use client";

import { useState } from "react";
import { Money } from "@/components/books";
import { useApiData } from "@/components/hooks";
import { ReportExport } from "@/components/reports/report-export";
import { Button, Card, Field, Notice, ui } from "@/components/ui";
import { FarmReportingSetupCard, FarmSplitCard } from "@/components/farm-reporting";
import { useWorkspace } from "@/components/workspace";
import { api, errorMessage } from "@/lib/client/api";
import { formatDate } from "@/lib/format";
import type { ExpenseGrouping, FarmBenchmarks, FweGroup, PerUnit, YearFigures } from "@/lib/farming/benchmarks";

const GROUPS: Array<{ key: FweGroup; label: string }> = [
  { key: "wages", label: "Wages" },
  { key: "animal_health", label: "Animal health" },
  { key: "breeding", label: "Breeding and herd testing" },
  { key: "farm_dairy", label: "Farm dairy" },
  { key: "electricity", label: "Electricity" },
  { key: "feed", label: "Feed (supplements)" },
  { key: "grazing", label: "Grazing" },
  { key: "fertiliser", label: "Fertiliser, nitrogen and lime" },
  { key: "irrigation", label: "Irrigation" },
  { key: "regrassing", label: "Regrassing and cropping" },
  { key: "weed_pest", label: "Weed and pest" },
  { key: "vehicles", label: "Vehicles and fuel" },
  { key: "repairs", label: "Repairs and maintenance" },
  { key: "freight", label: "Freight" },
  { key: "administration", label: "Administration" },
  { key: "insurance", label: "Insurance" },
  { key: "rates", label: "Rates" },
  { key: "other", label: "Other working expenses" },
];

function Cell({ value }: { value: string | null }) {
  return <td className={ui.num}>{value === null ? <span className={ui.muted}>–</span> : <Money value={value} />}</td>;
}

function Row({ label, values, total }: { label: string; values: PerUnit; total?: boolean }) {
  return (
    <tr className={total ? ui.reportTotal : ui.reportSection}>
      <td>{label}</td>
      <Cell value={values.amount} />
      <Cell value={values.perKgMs} />
      <Cell value={values.perHa} />
      <Cell value={values.perCow} />
      <Cell value={values.perSu} />
    </tr>
  );
}

/** Farm benchmarks (FK1-FK4): working expenses by group, per kgMS, ha, cow and stock unit. */
export function FarmBenchmarksView({ organisationId }: { organisationId: string }) {
  const { can } = useWorkspace();
  const [yearEnd, setYearEnd] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const report = useApiData<FarmBenchmarks>("/api/farming/benchmarks", { organisationId, yearEnd });
  const data = report.data;
  return (
    <>
      <Card
        title="Farm benchmarks"
        description="Gross farm revenue and farm working expenses for the year, in total and per kg of milk solids, effective hectare, peak cow milked and stock unit. Only expense accounts put in a group below are working expenses."
        actions={
          data ? (
            <Field label="Year ending">
              <select value={data.yearEnd} onChange={(event) => setYearEnd(event.target.value)}>
                {data.yearEnds.map((end) => (
                  <option key={end} value={end}>
                    {formatDate(end)}
                  </option>
                ))}
              </select>
            </Field>
          ) : null
        }
      >
        {report.error ? <Notice tone="error">{report.error}</Notice> : null}
        {report.loading ? <p className={ui.muted}>Loading…</p> : null}
        {data ? (
          <>
            <ReportExport
              organisationId={organisationId}
              report="farm-benchmarks"
              title="Farm benchmarks"
              period={`${formatDate(data.yearStart)} to ${formatDate(data.yearEnd)}`}
              tables={[{ id: "farm-benchmarks-report" }]}
            />
            <div className={ui.tableWrap}>
              <table id="farm-benchmarks-report" className={ui.table}>
                <thead>
                  <tr>
                    <th />
                    <th className={ui.num}>Total</th>
                    <th className={ui.num}>per kgMS</th>
                    <th className={ui.num}>per ha</th>
                    <th className={ui.num}>per cow</th>
                    <th className={ui.num}>per su</th>
                  </tr>
                </thead>
                <tbody>
                  <Row label="Gross farm revenue" values={data.grossFarmRevenue} total />
                  {data.groups.map((group) => (
                    <Row key={group.key} label={group.label} values={group} />
                  ))}
                  <Row label="Farm working expenses" values={data.workingExpenses} total />
                  <Row label="Operating surplus" values={data.operatingSurplus} total />
                </tbody>
              </table>
            </div>
            {data.ungrouped.length > 0 ? (
              <Notice tone="info">
                Not in a working expense group, so left out:{" "}
                {data.ungrouped.map((account, index) => (
                  <span key={account.code}>
                    {index > 0 ? "; " : ""}
                    {account.code} {account.name} <Money value={account.amount} />
                  </span>
                ))}
                . Depreciation, interest, rent and tax usually stay out.
              </Notice>
            ) : null}
            <YearFiguresCard key={data.yearEnd} organisationId={organisationId} yearEnd={data.yearEnd} canEdit={can("bookkeeper")} onSaved={report.reload} />
          </>
        ) : null}
      </Card>
      {data ? <FarmSplitCard organisationId={organisationId} yearEnd={data.yearEnd} version={version} /> : null}
      <ExpenseGroupsCard
        organisationId={organisationId}
        canEdit={can("bookkeeper")}
        onSaved={() => {
          report.reload();
          setVersion((current) => current + 1);
        }}
      />
      {data ? <FarmReportingSetupCard organisationId={organisationId} yearEnd={data.yearEnd} canEdit={can("bookkeeper")} onSaved={() => setVersion((current) => current + 1)} /> : null}
    </>
  );
}

function YearFiguresCard({ organisationId, yearEnd, canEdit, onSaved }: { organisationId: string; yearEnd: string; canEdit: boolean; onSaved: () => void }) {
  const figures = useApiData<{ figures: YearFigures }>("/api/farming/year-figures", { organisationId, yearEnd });
  const loaded = figures.data?.figures;
  if (!loaded) return null;
  return (
    <YearFiguresForm
      key={JSON.stringify(loaded)}
      organisationId={organisationId}
      loaded={loaded}
      canEdit={canEdit}
      onSaved={() => {
        figures.reload();
        onSaved();
      }}
    />
  );
}

function YearFiguresForm({ organisationId, loaded, canEdit, onSaved }: { organisationId: string; loaded: YearFigures; canEdit: boolean; onSaved: () => void }) {
  const yearEnd = loaded.yearEnd;
  const [form, setForm] = useState(() => ({
    effectiveHa: loaded.effectiveHa ?? loaded.paddockHa ?? "",
    peakCows: loaded.peakCows === null ? "" : String(loaded.peakCows),
    stockUnits: loaded.stockUnits ?? "",
    milkSolidsKg: loaded.milkSolidsKg ?? "",
  }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await api("/api/farming/year-figures", { method: "PUT", body: { organisationId, yearEnd, ...form } });
      setSaved(true);
      onSaved();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={save} style={{ display: "grid", gap: 8, marginTop: 16 }}>
      <h3 className={ui.cardTitle}>The year&apos;s figures</h3>
      {error ? <Notice tone="error">{error}</Notice> : null}
      {saved ? <Notice tone="success">Saved.</Notice> : null}
      <div className={ui.inlineForm}>
        <Field label="Effective hectares" hint={loaded.effectiveHa === null && loaded.paddockHa ? "From the active paddocks; save to keep it for this year." : undefined}>
          <input inputMode="decimal" disabled={!canEdit} value={form.effectiveHa} onChange={(event) => setForm({ ...form, effectiveHa: event.target.value })} />
        </Field>
        <Field label="Peak cows milked">
          <input inputMode="numeric" disabled={!canEdit} value={form.peakCows} onChange={(event) => setForm({ ...form, peakCows: event.target.value })} />
        </Field>
        <Field label="Stock units">
          <input inputMode="decimal" disabled={!canEdit} value={form.stockUnits} onChange={(event) => setForm({ ...form, stockUnits: event.target.value })} />
        </Field>
        <Field label="Milk solids (kg)">
          <input inputMode="decimal" disabled={!canEdit} value={form.milkSolidsKg} onChange={(event) => setForm({ ...form, milkSolidsKg: event.target.value })} />
        </Field>
        {canEdit ? (
          <Button type="submit" disabled={busy}>
            {busy ? "Saving…" : "Save figures"}
          </Button>
        ) : null}
      </div>
    </form>
  );
}

function ExpenseGroupsCard({ organisationId, canEdit, onSaved }: { organisationId: string; canEdit: boolean; onSaved: () => void }) {
  const grouping = useApiData<{ accounts: ExpenseGrouping }>("/api/farming/expense-groups", { organisationId });
  const [error, setError] = useState<string | null>(null);
  async function choose(accountCode: string, group: string) {
    setError(null);
    try {
      await api("/api/farming/expense-groups", { method: "PUT", body: { organisationId, accountCode, group: group || null } });
      grouping.reload();
      onSaved();
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }
  return (
    <Card title="Working expense groups" description="Which expense accounts are farm working expenses, and in which group. Leave depreciation, interest, rent and tax out.">
      {error ? <Notice tone="error">{error}</Notice> : null}
      {grouping.error ? <Notice tone="error">{grouping.error}</Notice> : null}
      {grouping.data ? (
        <div className={ui.tableWrap}>
          <table className={`${ui.table} ${ui.stackOnPhone}`}>
            <thead>
              <tr>
                <th>Account</th>
                <th>Group</th>
              </tr>
            </thead>
            <tbody>
              {grouping.data.accounts.map((account) => (
                <tr key={account.code}>
                  <td data-label="Account">
                    {account.code} · {account.name}
                  </td>
                  <td data-label="Group">
                    <select aria-label={`${account.code} group`} disabled={!canEdit} value={account.group ?? ""} onChange={(event) => void choose(account.code, event.target.value)}>
                      <option value="">Not a working expense</option>
                      {GROUPS.map((group) => (
                        <option key={group.key} value={group.key}>
                          {group.label}
                        </option>
                      ))}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </Card>
  );
}
