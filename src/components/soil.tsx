"use client";

import { DateInput } from "@/components/date-input";
import Link from "next/link";
import { FarmSelector, useSelectedFarm } from "@/components/farm-selector";
import { useState } from "react";
import { useApiData } from "@/components/hooks";
import { RecordExtrasPanel } from "@/components/records/record-extras";
import { Badge, Button, Card, Empty, Field, Notice, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { api, errorMessage } from "@/lib/client/api";
import type { Farm, Paddock } from "@/lib/farming/paddocks";
import type {
  PaddockHistory,
  SoilImportColumn,
  SoilImportPreview,
  SoilResult,
  SoilSummary,
  SoilTest,
} from "@/lib/farming/soil";
import type { SoilSample } from "@/lib/farming/soil-samples";
import { formatDate, todayInBrowser } from "@/lib/format";

/**
 * Soil tests (#249 stage 2): each paddock's latest results, importing a
 * lab's CSV or Excel file with a preview and column choices, entering a test
 * by hand, and the lab's report attached to each test. Results are shown as
 * the lab reported them, with no judgement of high or low.
 */

function useRun() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run<T>(action: () => Promise<T>, done?: (result: T) => void) {
    setBusy(true);
    setError(null);
    try {
      done?.(await action());
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, run };
}

const result = (entry: SoilResult | undefined) =>
  entry ? `${entry.valueText}${entry.unit ? ` ${entry.unit}` : ""}` : "–";

/** How long ago, in whole months or years, so an old test is easy to spot. No threshold is applied. */
function age(date: string): string {
  const then = new Date(`${date}T00:00:00`);
  const now = new Date(`${todayInBrowser()}T00:00:00`);
  const months =
    (now.getFullYear() - then.getFullYear()) * 12 +
    now.getMonth() -
    then.getMonth() -
    (now.getDate() < then.getDate() ? 1 : 0);
  if (months < 1) return "this month";
  if (months < 24) return `${months} month${months === 1 ? "" : "s"} ago`;
  return `${Math.floor(months / 12)} years ago`;
}

export function SoilHome({ organisationId }: { organisationId: string }) {
  const farms = useApiData<{ farms: Farm[] }>("/api/farming/farms", {
    organisationId,
  });
  const { farm, selectFarm } = useSelectedFarm(organisationId, farms.data?.farms ?? []);
  if (farms.error) return <Notice tone="error">{farms.error}</Notice>;
  if (!farms.data) return <p className={ui.muted}>Loading…</p>;
  const active = farms.data.farms.filter((farm) => farm.isActive);
  if (!active.length) {
    return (
      <Empty>
        Add your farm and its paddocks first, under{" "}
        <Link href="/operations/farming">Farms and paddocks</Link>.
      </Empty>
    );
  }
  return (
    <>
      <FarmSelector farms={active} farm={farm} onChange={selectFarm} />
      {farm ? <FarmSoil key={farm.id} organisationId={organisationId} farm={farm} /> : null}
    </>
  );
}

function FarmSoil({
  organisationId,
  farm,
}: {
  organisationId: string;
  farm: Farm;
}) {
  const { can } = useWorkspace();
  const summary = useApiData<{ summary: SoilSummary }>(
    `/api/farming/farms/${farm.id}/soil-summary`,
    { organisationId },
  );
  const tests = useApiData<{ tests: SoilTest[] }>(
    `/api/farming/farms/${farm.id}/soil-tests`,
    { organisationId },
  );
  const paddocks = useApiData<{ paddocks: Paddock[] }>(
    `/api/farming/farms/${farm.id}/paddocks`,
    { organisationId },
  );
  const reload = () => {
    summary.reload();
    tests.reload();
  };
  const shown = summary.data?.summary.measures.slice(0, 6) ?? [];
  return (
    <>
      <Card
        title={`Latest soil tests on ${farm.name}`}
        description="Each current paddock's most recent test, as the lab reported it. Tohyee doesn't judge whether a result is high or low."
      >
        {summary.error ? <Notice tone="error">{summary.error}</Notice> : null}
        {summary.data && summary.data.summary.paddocks.length === 0 ? (
          <Empty>No paddocks yet.</Empty>
        ) : null}
        {summary.data && summary.data.summary.paddocks.length > 0 ? (
          <div className={ui.tableWrap}>
            <table className={`${ui.table} ${ui.stackOnPhone}`}>
              <thead>
                <tr>
                  <th>Paddock</th>
                  <th>Last tested</th>
                  {shown.map((measure) => (
                    <th key={measure} className={ui.num}>
                      {measure}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {summary.data.summary.paddocks.map((row) => (
                  <tr key={row.paddockId}>
                    <td data-label="Paddock">
                      <strong>{row.paddockName}</strong>
                    </td>
                    <td data-label="Last tested">
                      {row.lastSampledOn ? (
                        <>
                          {formatDate(row.lastSampledOn)}{" "}
                          <span className={ui.muted}>
                            ({age(row.lastSampledOn)})
                          </span>
                        </>
                      ) : (
                        <Badge tone="amber">Not tested</Badge>
                      )}
                    </td>
                    {shown.map((measure) => (
                      <td key={measure} data-label={measure} className={ui.num}>
                        {result(row.latest[measure])}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
        {summary.data && summary.data.summary.measures.length > shown.length ? (
          <p className={ui.muted}>Other results are under each test below.</p>
        ) : null}
      </Card>
      {can("bookkeeper") ? (
        <ImportSoil
          organisationId={organisationId}
          farm={farm}
          onImported={reload}
        />
      ) : null}
      {can("bookkeeper") ? (
        <AddSoilTest
          organisationId={organisationId}
          paddocks={(paddocks.data?.paddocks ?? []).filter(
            (p) => p.status === "active",
          )}
          onAdded={reload}
        />
      ) : null}
      <SoilSamples organisationId={organisationId} farm={farm} />
      <Card
        title="All soil tests"
        description="Newest first. Open one to see every result and attach the lab's report."
      >
        {tests.error ? <Notice tone="error">{tests.error}</Notice> : null}
        {tests.data && tests.data.tests.length === 0 ? (
          <Empty>No soil tests yet.</Empty>
        ) : null}
        {tests.data?.tests.map((test) => (
          <SoilTestRow
            key={test.id}
            organisationId={organisationId}
            test={test}
            onRemoved={reload}
          />
        ))}
      </Card>
    </>
  );
}

export function SoilTestRow({
  organisationId,
  test,
  onRemoved,
}: {
  organisationId: string;
  test: SoilTest;
  onRemoved?: () => void;
}) {
  const { can } = useWorkspace();
  const [open, setOpen] = useState(false);
  const { busy, error, run } = useRun();
  const details = [
    test.lab,
    test.labReference ? `ref ${test.labReference}` : null,
    test.depth,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <div
      style={{
        borderTop: "1px solid var(--border, #e3e7ee)",
        padding: "10px 0",
      }}
    >
      <div
        className={ui.inlineForm}
        style={{ justifyContent: "space-between", alignItems: "center" }}
      >
        <div>
          <strong>Paddock {test.paddockName}</strong>, sampled{" "}
          {formatDate(test.sampledOn)}
          {details ? <span className={ui.muted}> · {details}</span> : null}
          <div className={ui.muted}>
            {test.results.length} result{test.results.length === 1 ? "" : "s"} ·{" "}
            {test.source}
          </div>
        </div>
        <Button size="small" variant="secondary" onClick={() => setOpen(!open)}>
          {open ? "Hide" : "Results and report"}
        </Button>
      </div>
      {open ? (
        <>
          {error ? <Notice tone="error">{error}</Notice> : null}
          <div className={ui.tableWrap}>
            <table className={ui.table}>
              <thead>
                <tr>
                  <th>Measure</th>
                  <th className={ui.num}>Result</th>
                  <th>Unit</th>
                </tr>
              </thead>
              <tbody>
                {test.results.map((entry) => (
                  <tr key={entry.measure}>
                    <td>{entry.measure}</td>
                    <td className={ui.num}>{entry.valueText}</td>
                    <td>{entry.unit ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <RecordExtrasPanel
            organisationId={organisationId}
            recordType="soil_test"
            recordId={test.id}
            title="Lab report, files and notes"
          />
          {can("bookkeeper") && onRemoved ? (
            <p>
              <Button
                size="small"
                variant="secondary"
                disabled={busy}
                onClick={() =>
                  void run(
                    () =>
                      api(`/api/farming/soil-tests/${test.id}`, {
                        method: "DELETE",
                        query: { organisationId },
                      }),
                    onRemoved,
                  )
                }
              >
                Remove this test
              </Button>
            </p>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

const ROLE_LABELS: Record<SoilImportColumn["role"], string> = {
  paddock: "Paddock",
  date: "Date sampled",
  sample: "Sample name",
  labReference: "Lab reference",
  depth: "Depth",
  measure: "A result",
  ignore: "Skip",
};

function ImportSoil({
  organisationId,
  farm,
  onImported,
}: {
  organisationId: string;
  farm: Farm;
  onImported: () => void;
}) {
  const [file, setFile] = useState<{
    name: string;
    content?: string;
    contentBase64?: string;
  } | null>(null);
  const [lab, setLab] = useState("");
  const [sampledOn, setSampledOn] = useState("");
  const [columns, setColumns] = useState<SoilImportColumn[] | null>(null);
  const [preview, setPreview] = useState<SoilImportPreview | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [picker, setPicker] = useState(0);
  const { busy, error, run } = useRun();
  const path = `/api/farming/farms/${farm.id}/soil-tests/import`;
  const body = (extra: Record<string, unknown>, chosen = columns) => ({
    organisationId,
    fileName: file?.name,
    content: file?.content,
    contentBase64: file?.contentBase64,
    lab: lab || null,
    sampledOn: sampledOn || null,
    columns: chosen,
    ...extra,
  });
  const check = (chosen = columns) =>
    void run(
      () =>
        api<{ preview: SoilImportPreview }>(path, {
          method: "POST",
          body: body({ preview: true }, chosen),
        }),
      (result) => {
        setPreview(result.preview);
        setColumns(result.preview.columns);
      },
    );
  const pick = async (picked: File | undefined) => {
    setPreview(null);
    setColumns(null);
    setDone(null);
    if (!picked) return setFile(null);
    if (/\.xlsx$/i.test(picked.name)) {
      const bytes = new Uint8Array(await picked.arrayBuffer());
      let binary = "";
      for (let i = 0; i < bytes.length; i += 0x8000)
        binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      setFile({ name: picked.name, contentBase64: btoa(binary) });
    } else {
      setFile({ name: picked.name, content: await picked.text() });
    }
  };
  const change = (index: number, patch: Partial<SoilImportColumn>) => {
    const next = (columns ?? []).map((column) =>
      column.index === index
        ? {
            ...column,
            ...patch,
            measure:
              patch.role && patch.role !== "measure"
                ? null
                : (patch.measure ?? column.measure ?? column.heading),
          }
        : column,
    );
    setColumns(next);
    check(next);
  };
  return (
    <Card
      title="Import a lab's results"
      description="A CSV or Excel (.xlsx) file with one row per sample. Columns are matched by their headings, and units in brackets after a heading are kept. Check the matching before importing; nothing is saved until you do."
    >
      {error ? <Notice tone="error">{error}</Notice> : null}
      {done ? <Notice tone="success">{done}</Notice> : null}
      <div className={ui.inlineForm}>
        <Field label="File">
          <input
            key={picker}
            type="file"
            accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            onChange={(event) => void pick(event.target.files?.[0])}
          />
        </Field>
        <Field label="Lab" hint="Optional">
          <input
            value={lab}
            maxLength={100}
            onChange={(event) => setLab(event.target.value)}
          />
        </Field>
        <Field label="Date sampled" hint="If the file has none">
          <DateInput
            value={sampledOn}
            onChange={(event) => setSampledOn(event.target.value)}
          />
        </Field>
        <Button onClick={() => check(null)} disabled={busy || !file}>
          Check the file
        </Button>
      </div>
      {preview && columns ? (
        <>
          {preview.alreadyImportedOn ? (
            <Notice tone="warning">
              This file was already imported on{" "}
              {formatDate(preview.alreadyImportedOn.slice(0, 10))}.
            </Notice>
          ) : null}
          <h3>Columns</h3>
          <div className={ui.tableWrap}>
            <table className={`${ui.table} ${ui.stackOnPhone}`}>
              <thead>
                <tr>
                  <th>In the file</th>
                  <th>Is</th>
                  <th>Measure</th>
                  <th>Unit</th>
                </tr>
              </thead>
              <tbody>
                {columns.map((column) => (
                  <tr key={column.index}>
                    <td data-label="In the file">
                      {column.heading || (
                        <span className={ui.muted}>(no heading)</span>
                      )}
                    </td>
                    <td data-label="Is">
                      <select
                        value={column.role}
                        onChange={(event) =>
                          change(column.index, {
                            role: event.target
                              .value as SoilImportColumn["role"],
                          })
                        }
                      >
                        {(
                          Object.keys(ROLE_LABELS) as SoilImportColumn["role"][]
                        ).map((role) => (
                          <option key={role} value={role}>
                            {ROLE_LABELS[role]}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td data-label="Measure">
                      {column.role === "measure" ? (
                        <input
                          defaultValue={column.measure ?? ""}
                          maxLength={100}
                          onBlur={(event) =>
                            event.target.value !== column.measure
                              ? change(column.index, {
                                  measure: event.target.value,
                                })
                              : undefined
                          }
                        />
                      ) : null}
                    </td>
                    <td data-label="Unit">
                      {column.role === "measure" ? (
                        <input
                          defaultValue={column.unit ?? ""}
                          maxLength={40}
                          size={10}
                          onBlur={(event) =>
                            (event.target.value || null) !== column.unit
                              ? change(column.index, {
                                  unit: event.target.value || null,
                                })
                              : undefined
                          }
                        />
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <h3>
            {preview.counts.tests} sample{preview.counts.tests === 1 ? "" : "s"}{" "}
            to import, {preview.counts.errors} skipped
          </h3>
          <ul>
            {preview.rows.map((row) => (
              <li key={row.line}>
                Line {row.line}:{" "}
                {row.paddock ? `paddock ${row.paddock}` : "no paddock"}
                {row.sampledOn ? `, ${formatDate(row.sampledOn)}` : ""},{" "}
                {row.results} result{row.results === 1 ? "" : "s"}
                {row.error ? (
                  <>
                    {" "}
                    <Badge tone="red">Skipped</Badge> {row.error}
                  </>
                ) : null}
              </li>
            ))}
          </ul>
          <div className={ui.actions}>
            <Button
              disabled={
                busy ||
                preview.counts.tests === 0 ||
                Boolean(preview.alreadyImportedOn)
              }
              onClick={() =>
                void run(
                  () =>
                    api<{ tests: SoilTest[] }>(path, {
                      method: "POST",
                      body: body({}),
                    }),
                  (result) => {
                    setDone(
                      `Imported ${result.tests.length} soil test${result.tests.length === 1 ? "" : "s"} from ${file?.name}.`,
                    );
                    setPreview(null);
                    setColumns(null);
                    setFile(null);
                    setPicker((count) => count + 1);
                    onImported();
                  },
                )
              }
            >
              Import {preview.counts.tests} sample
              {preview.counts.tests === 1 ? "" : "s"}
            </Button>
          </div>
        </>
      ) : null}
    </Card>
  );
}

type DraftResult = { measure: string; value: string; unit: string };

function AddSoilTest({
  organisationId,
  paddocks,
  onAdded,
}: {
  organisationId: string;
  paddocks: Paddock[];
  onAdded: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({
    paddockId: "",
    sampledOn: todayInBrowser(),
    lab: "",
    labReference: "",
    depth: "",
  });
  const [results, setResults] = useState<DraftResult[]>([
    { measure: "pH", value: "", unit: "" },
    { measure: "Olsen P", value: "", unit: "" },
  ]);
  const { busy, error, run } = useRun();
  const set =
    (key: keyof typeof form) => (event: { target: { value: string } }) =>
      setForm({ ...form, [key]: event.target.value });
  const setResult = (index: number, key: keyof DraftResult, value: string) =>
    setResults(
      results.map((entry, i) =>
        i === index ? { ...entry, [key]: value } : entry,
      ),
    );
  if (!open) {
    return (
      <p>
        <Button variant="secondary" onClick={() => setOpen(true)}>
          Enter a test by hand
        </Button>
      </p>
    );
  }
  return (
    <Card
      title="Enter a soil test"
      description="Type the results as the lab reported them, with the lab's units. Results like <0.5 are kept as written."
    >
      {error ? <Notice tone="error">{error}</Notice> : null}
      <div className={ui.inlineForm}>
        <Field label="Paddock">
          <select value={form.paddockId} onChange={set("paddockId")}>
            <option value="">Choose…</option>
            {paddocks.map((paddock) => (
              <option key={paddock.id} value={paddock.id}>
                {paddock.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Date sampled">
          <DateInput
            value={form.sampledOn}
            onChange={set("sampledOn")}
          />
        </Field>
        <Field label="Lab">
          <input value={form.lab} maxLength={100} onChange={set("lab")} />
        </Field>
        <Field label="Lab reference">
          <input
            value={form.labReference}
            maxLength={100}
            onChange={set("labReference")}
          />
        </Field>
        <Field label="Depth">
          <input
            value={form.depth}
            maxLength={40}
            placeholder="0-75 mm"
            onChange={set("depth")}
          />
        </Field>
      </div>
      {results.map((entry, index) => (
        <div className={ui.inlineForm} key={index}>
          <Field label="Measure">
            <input
              value={entry.measure}
              maxLength={100}
              onChange={(event) =>
                setResult(index, "measure", event.target.value)
              }
            />
          </Field>
          <Field label="Result">
            <input
              value={entry.value}
              maxLength={50}
              size={8}
              onChange={(event) =>
                setResult(index, "value", event.target.value)
              }
            />
          </Field>
          <Field label="Unit">
            <input
              value={entry.unit}
              maxLength={40}
              size={10}
              onChange={(event) => setResult(index, "unit", event.target.value)}
            />
          </Field>
          <Button
            size="small"
            variant="secondary"
            disabled={results.length === 1}
            onClick={() => setResults(results.filter((_, i) => i !== index))}
          >
            Remove
          </Button>
        </div>
      ))}
      <div className={ui.actions}>
        <Button
          size="small"
          variant="secondary"
          onClick={() =>
            setResults([...results, { measure: "", value: "", unit: "" }])
          }
        >
          Add a result
        </Button>
        <Button
          disabled={busy || !form.paddockId}
          onClick={() =>
            void run(
              () =>
                api(
                  `/api/farming/farms/${paddocks.find((p) => p.id === form.paddockId)?.farmId}/soil-tests`,
                  {
                    method: "POST",
                    body: {
                      organisationId,
                      ...form,
                      results: results.filter(
                        (entry) => entry.measure.trim() || entry.value.trim(),
                      ),
                    },
                  },
                ),
              () => {
                setOpen(false);
                setResults([
                  { measure: "pH", value: "", unit: "" },
                  { measure: "Olsen P", value: "", unit: "" },
                ]);
                onAdded();
              },
            )
          }
        >
          Save the test
        </Button>
        <Button variant="secondary" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </Card>
  );
}

/** A paddock's soil tests and fertiliser applications, for its panel on the map page. */
export function PaddockRecords({
  organisationId,
  paddockId,
}: {
  organisationId: string;
  paddockId: string;
}) {
  const history = useApiData<{ history: PaddockHistory }>(
    `/api/farming/paddocks/${paddockId}/history`,
    { organisationId },
  );
  if (history.error) return <Notice tone="error">{history.error}</Notice>;
  if (!history.data) return null;
  const { soilTests, applications } = history.data.history;
  const latest = soilTests[0];
  return (
    <>
      <h3>Soil tests</h3>
      {latest ? (
        <p>
          Latest {formatDate(latest.sampledOn)} ({age(latest.sampledOn)}):{" "}
          {latest.results
            .slice(0, 5)
            .map((entry) => `${entry.measure} ${result(entry)}`)
            .join(", ")}
          {latest.results.length > 5 ? "…" : ""}.{" "}
          {soilTests.length > 1 ? `${soilTests.length} tests in all. ` : ""}
          <Link href="/operations/farming/soil">All soil tests</Link>
        </p>
      ) : (
        <p className={ui.muted}>
          None yet. <Link href="/operations/farming/soil">Soil tests</Link>
        </p>
      )}
      <h3>Fertiliser applied</h3>
      {applications.length === 0 ? (
        <p className={ui.muted}>None recorded.</p>
      ) : (
        <ul
          style={{
            listStyle: "none",
            padding: 0,
            margin: "8px 0 16px",
            display: "grid",
            gap: 4,
          }}
        >
          {applications.map((app) => (
            <li key={app.id}>
              {formatDate(app.appliedOn)} · {app.tonnes} t {app.productName}{" "}
              over {app.treatedHa} ha ·{" "}
              <Link href={`/operations/farming/fertiliser?plan=${app.planId}`}>
                {app.planName}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/** Soil samples taken in the field, before the lab's results (FA4), entered here or by a farm app. */
function SoilSamples({ organisationId, farm }: { organisationId: string; farm: Farm }) {
  const { can } = useWorkspace();
  const samples = useApiData<{ samples: SoilSample[] }>(`/api/farming/farms/${farm.id}/soil-samples`, { organisationId });
  const { busy, error, run } = useRun();
  if (!samples.data || samples.data.samples.length === 0) return null;
  return (
    <Card title="Samples taken" description="Soil samples recorded in the field, waiting for or matched to the lab's results. Apps record them through the Farming API.">
      {error ? <Notice tone="error">{error}</Notice> : null}
      <div className={ui.tableWrap}>
        <table className={`${ui.table} ${ui.stackOnPhone}`}>
          <thead>
            <tr>
              <th>Taken</th>
              <th>Paddock</th>
              <th>Sample</th>
              <th>Depth</th>
              <th>Where</th>
              <th>Recorded by</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {samples.data.samples.map((sample) => (
              <tr key={sample.id}>
                <td data-label="Taken">{formatDate(sample.takenOn)}</td>
                <td data-label="Paddock">{sample.paddockName}</td>
                <td data-label="Sample">{sample.sampleName ?? "–"}</td>
                <td data-label="Depth">{sample.depth ?? "–"}</td>
                <td data-label="Where">
                  {sample.latitude && sample.longitude ? (
                    <a href={`https://www.openstreetmap.org/?mlat=${sample.latitude}&mlon=${sample.longitude}#map=17/${sample.latitude}/${sample.longitude}`} target="_blank" rel="noreferrer">
                      {sample.latitude}, {sample.longitude}
                    </a>
                  ) : (
                    "–"
                  )}
                </td>
                <td data-label="Recorded by">
                  {sample.createdByEmail}
                  {sample.recordedVia ? <span className={ui.muted}>, via {sample.recordedVia}</span> : null}
                  {sample.note ? <div className={ui.muted}>{sample.note}</div> : null}
                </td>
                <td>
                  {can("bookkeeper") ? (
                    <button type="button" className={ui.linkButton} disabled={busy} onClick={() => void run(() => api(`/api/farming/soil-samples/${sample.id}`, { method: "DELETE", query: { organisationId } }), () => samples.reload())}>
                      Remove
                    </button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
