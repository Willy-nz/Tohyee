"use client";

import Link from "next/link";
import { useState } from "react";
import { Money } from "@/components/books";
import { useApiData } from "@/components/hooks";
import { ReportExport } from "@/components/reports/report-export";
import { Button, Card, Empty, Field, Notice, ui } from "@/components/ui";
import { api, errorMessage } from "@/lib/client/api";
import { formatDate } from "@/lib/format";
import type { FarmBenchmarksByFarm, FarmReportingSetup, FarmYearFigures } from "@/lib/farming/farm-reporting";
import type { PerUnit } from "@/lib/farming/farm-reporting-rules";

const MEASURES: Array<{ key: keyof PerUnit; label: string }> = [
  { key: "amount", label: "Amount" },
  { key: "perKgMs", label: "per kgMS" },
  { key: "perHa", label: "per ha" },
  { key: "perCow", label: "per cow" },
  { key: "perSu", label: "per su" },
];

/** The year's benchmarks by farm (FR2-FR7): each farm, Not allocated and the total. */
export function FarmSplitCard({ organisationId, yearEnd, version }: { organisationId: string; yearEnd: string; version: number }) {
  const loaded = useApiData<{ report: FarmBenchmarksByFarm }>("/api/farming/benchmarks/by-farm", { organisationId, yearEnd, version: String(version) });
  const [measure, setMeasure] = useState<keyof PerUnit>("amount");
  const report = loaded.data?.report;
  const fwe = report?.rows.find((row) => row.key === "fwe");
  const shared = fwe?.cells.none?.amount;
  return (
    <Card
      title="By farm"
      description="Each farm's lines are the ones tagged with its value in the tracking category below, as Xero tracking does. Lines with no farm are Not allocated: shown, never spread. The farms and Not allocated add up to the total, which is the figures above. A farm's per-unit amounts use only that farm's own figures."
      actions={
        report && report.category ? (
          <Field label="Show">
            <select value={measure} onChange={(event) => setMeasure(event.target.value as keyof PerUnit)}>
              {MEASURES.map((entry) => (
                <option key={entry.key} value={entry.key}>
                  {entry.label}
                </option>
              ))}
            </select>
          </Field>
        ) : null
      }
    >
      {loaded.error ? <Notice tone="error">{loaded.error}</Notice> : null}
      {!report && !loaded.error ? <p className={ui.muted}>Loading…</p> : null}
      {report && !report.category ? <Empty>Choose the tracking category that says which farm a line is for, under Farm reporting below.</Empty> : null}
      {report && report.category ? (
        <>
          <ReportExport
            organisationId={organisationId}
            report="farm-benchmarks-by-farm"
            title="Farm benchmarks by farm"
            period={`${formatDate(report.yearStart)} to ${formatDate(report.yearEnd)}`}
            tables={[{ id: "farm-benchmarks-by-farm" }]}
          />
          <div className={ui.tableWrap}>
            <table id="farm-benchmarks-by-farm" className={ui.table}>
              <thead>
                <tr>
                  <th />
                  {report.columns.map((column) => (
                    <th key={column.key} className={ui.num}>
                      {column.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {report.rows.map((row) => (
                  <tr key={row.key} className={row.total ? ui.reportTotal : ui.reportSection}>
                    <td>{row.label}</td>
                    {report.columns.map((column) => {
                      const value = row.cells[column.key][measure];
                      return (
                        <td key={column.key} className={ui.num}>
                          {value === null ? <span className={ui.muted}>–</span> : <Money value={value} />}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {shared && shared !== "0.00" ? (
            <Notice tone="info">
              <Money value={shared} /> of working expenses has no farm. It isn&apos;t shared out to the farms, so each farm&apos;s operating surplus is before it. To charge it to farms, post a journal moving it to their values.
            </Notice>
          ) : null}
          {measure !== "amount" ? <p className={ui.muted}>A dash means that farm&apos;s figure for the year isn&apos;t entered. Not allocated has no figures to divide by.</p> : null}
          {report.unlinkedFarms.length ? <p className={ui.muted}>Not linked to a value, so not shown: {report.unlinkedFarms.join(", ")}.</p> : null}
        </>
      ) : null}
    </Card>
  );
}

/** Which tracking category carries the farm, each farm's value, and each farm's figures for the year (FR1, FR4). */
export function FarmReportingSetupCard({ organisationId, yearEnd, canEdit, onSaved }: { organisationId: string; yearEnd: string; canEdit: boolean; onSaved: () => void }) {
  const setup = useApiData<{ setup: FarmReportingSetup }>("/api/farming/farm-reporting", { organisationId });
  const figures = useApiData<{ figures: FarmYearFigures[] }>("/api/farming/farm-year-figures", { organisationId, yearEnd });
  const [error, setError] = useState<string | null>(null);
  async function change(method: "PUT" | "PATCH", body: Record<string, unknown>) {
    setError(null);
    try {
      await api("/api/farming/farm-reporting", { method, body: { organisationId, ...body } });
      setup.reload();
      onSaved();
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }
  const data = setup.data?.setup;
  return (
    <Card title="Farm reporting" description="A tracking category carries the farm, as in Xero: tag each income and expense line with its farm. Choose the category, link each farm to its value, and enter each farm's own figures for the year.">
      {error ? <Notice tone="error">{error}</Notice> : null}
      {setup.error ? <Notice tone="error">{setup.error}</Notice> : null}
      {data && !data.advancedFeatures ? (
        <Notice tone="info">
          Tracking categories are off. Turn on Advanced features under <Link href="/operations/settings">Settings</Link>, then add a category such as Farm with a value for each farm.
        </Notice>
      ) : null}
      {data && data.advancedFeatures ? (
        <>
          <div className={ui.inlineForm}>
            <Field label="Tracking category for the farm" hint={data.category ? "Changing it unlinks the farms." : undefined}>
              <select disabled={!canEdit} value={data.category?.id ?? ""} onChange={(event) => void change("PUT", { categoryId: event.target.value || null })}>
                <option value="">None</option>
                {data.categories.map((category) => (
                  <option key={category.id} value={category.id}>
                    {category.name}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          {data.category ? (
            <div className={ui.tableWrap}>
              <table className={`${ui.table} ${ui.stackOnPhone}`}>
                <thead>
                  <tr>
                    <th>Farm</th>
                    <th>{data.category.name} value</th>
                    <th>Figures for the year to {formatDate(yearEnd)}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.farms
                    .filter((farm) => farm.isActive || farm.trackingValueId)
                    .map((farm) => (
                      <tr key={farm.id}>
                        <td data-label="Farm">
                          {farm.name}
                          {farm.isActive ? null : <small className={ui.muted}> (archived)</small>}
                        </td>
                        <td data-label={`${data.category!.name} value`}>
                          <select aria-label={`${farm.name}: ${data.category!.name} value`} disabled={!canEdit} value={farm.trackingValueId ?? ""} onChange={(event) => void change("PATCH", { farmId: farm.id, valueId: event.target.value || null })}>
                            <option value="">Not linked</option>
                            {data.values
                              .filter((value) => value.isActive || value.id === farm.trackingValueId)
                              .map((value) => (
                                <option key={value.id} value={value.id}>
                                  {value.path}
                                </option>
                              ))}
                          </select>
                        </td>
                        <td data-label="Figures">
                          {figures.data ? (
                            <FarmFiguresForm
                              key={`${farm.id}:${yearEnd}:${JSON.stringify(figures.data.figures.find((row) => row.farmId === farm.id) ?? null)}`}
                              organisationId={organisationId}
                              farmId={farm.id}
                              farmName={farm.name}
                              yearEnd={yearEnd}
                              loaded={figures.data.figures.find((row) => row.farmId === farm.id) ?? null}
                              canEdit={canEdit}
                              onSaved={() => {
                                figures.reload();
                                onSaved();
                              }}
                            />
                          ) : null}
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </>
      ) : null}
    </Card>
  );
}

function FarmFiguresForm({
  organisationId,
  farmId,
  farmName,
  yearEnd,
  loaded,
  canEdit,
  onSaved,
}: {
  organisationId: string;
  farmId: string;
  farmName: string;
  yearEnd: string;
  loaded: FarmYearFigures | null;
  canEdit: boolean;
  onSaved: () => void;
}) {
  const [form, setForm] = useState(() => ({
    effectiveHa: loaded?.effectiveHa ?? "",
    peakCows: loaded?.peakCows === null || loaded?.peakCows === undefined ? "" : String(loaded.peakCows),
    stockUnits: loaded?.stockUnits ?? "",
    milkSolidsKg: loaded?.milkSolidsKg ?? "",
  }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("/api/farming/farm-year-figures", { method: "PUT", body: { organisationId, farmId, yearEnd, ...form } });
      onSaved();
    } catch (caught) {
      setError(errorMessage(caught));
      setBusy(false);
    }
  }
  const input = (key: keyof typeof form, label: string, mode: "decimal" | "numeric") => (
    <Field label={label}>
      <input aria-label={`${farmName}: ${label}`} inputMode={mode} size={8} disabled={!canEdit} value={form[key]} onChange={(event) => setForm({ ...form, [key]: event.target.value })} />
    </Field>
  );
  return (
    <form onSubmit={save}>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <div className={ui.inlineForm}>
        {input("effectiveHa", "Effective ha", "decimal")}
        {input("peakCows", "Peak cows", "numeric")}
        {input("stockUnits", "Stock units", "decimal")}
        {input("milkSolidsKg", "kg MS", "decimal")}
        {canEdit ? (
          <Button type="submit" size="small" variant="secondary" disabled={busy}>
            {busy ? "Saving…" : "Save"}
          </Button>
        ) : null}
      </div>
    </form>
  );
}
