"use client";

import Link from "next/link";
import { FarmSelector, useSelectedFarm } from "@/components/farm-selector";
import { type FormEvent, useState } from "react";
import { DateInput } from "@/components/date-input";
import { useApiData } from "@/components/hooks";
import { Badge, Button, Card, Empty, Field, Notice, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { useCanRecordFarmWork } from "@/components/farm-selector";
import { api, errorMessage } from "@/lib/client/api";
import type { Farm, Paddock } from "@/lib/farming/paddocks";
import type { GrazingRecord, PastureReading, PastureSummary, ReadingImportPreview, Supplement } from "@/lib/farming/pasture";
import { type Growth, PASTURE_METHOD_LABELS, PASTURE_METHODS, type PastureMethod, SUPPLEMENT_UNIT_LABELS, SUPPLEMENT_UNITS, type SupplementUnit } from "@/lib/farming/pasture-rules";
import { formatDate, todayInBrowser } from "@/lib/format";
import { coverText, daysAgo, mobText, shortDate } from "@/lib/farming/farm-words";
import { PhotoCalibrationCard, PhotoEstimates } from "@/components/pasture-photos";
import { CoverBar, FarmRowList, farmRowStyles, HistoryFilters, type HistoryFilterValues, HistoryFooter, NO_FILTERS, RemoveAction, useHistory } from "@/components/farm-rows";

/**
 * Pasture and feed (#249 stage 4; PF1-PF8): cover readings, the farm's cover
 * and feed wedge, grazings and supplements fed. Records only: no cover is
 * judged high or low, and no feed plan or target is drawn. Histories load a
 * page at a time from the server; on a phone each record is one line that
 * opens (#447, decisions 901 and 903).
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

const kg = (value: number) => value.toLocaleString("en-NZ");
const methodLabel = (method: PastureMethod) => PASTURE_METHOD_LABELS[method];

export function growthText(growth: Growth | null): string {
  if (!growth) return "–";
  if (growth.kind === "rate") return `${growth.kgDmPerHaPerDay} kg DM/ha/day`;
  if (growth.reason === "grazed") return "Grazed in between";
  if (growth.reason === "different_methods") return "Different methods";
  return "Same day";
}

export function PastureHome({ organisationId, farmId = null }: { organisationId: string; farmId?: string | null }) {
  const farms = useApiData<{ farms: Farm[] }>("/api/farming/farms", {
    organisationId,
  });
  const { farm, stale, deciding, selectFarm } = useSelectedFarm(organisationId, farms.data?.farms ?? [], farmId);
  if (farms.error) return <Notice tone="error">{farms.error}</Notice>;
  if (!farms.data) return <p className={ui.muted}>Loading…</p>;
  const active = farms.data.farms.filter((farm) => farm.isActive);
  if (!active.length) {
    return (
      <Empty>
        Add your farm and its paddocks first, under <Link href="/operations/farming">Farms and paddocks</Link>.
      </Empty>
    );
  }
  return (
    <>
      <FarmSelector farms={active} farm={farm} stale={stale} deciding={deciding} onChange={selectFarm} />
      {farm ? <FarmPasture key={farm.id} organisationId={organisationId} farm={farm} /> : null}
    </>
  );
}

function FarmPasture({ organisationId, farm }: { organisationId: string; farm: Farm }) {
  const { can } = useWorkspace();
  // Farm staff record field work too (decision 904); removing a record stays with bookkeepers.
  const canRecord = useCanRecordFarmWork();
  const today = todayInBrowser();
  const [onDate, setOnDate] = useState(today);
  // Bumped after any change, so the histories start again from the newest.
  const [version, setVersion] = useState(0);
  const summary = useApiData<{ summary: PastureSummary }>(`/api/farming/farms/${farm.id}/pasture`, { organisationId, onDate });
  const paddocks = useApiData<{ paddocks: Paddock[] }>(`/api/farming/farms/${farm.id}/paddocks`, { organisationId });
  const active = (paddocks.data?.paddocks ?? []).filter((paddock) => paddock.status === "active");
  const reload = () => {
    summary.reload();
    setVersion((value) => value + 1);
  };
  const data = summary.data?.summary;
  const maxCover = Math.max(1, ...(data?.cover.wedge.map((row) => row.cover) ?? []));
  return (
    <div className={farmRowStyles.tapTargets}>
      <Card title={`Pasture cover on ${farm.name}`} description="Each paddock's latest reading, averaged by area. Satellite, model and photo readings are marked as estimates.">
        <div className={ui.inlineForm}>
          <Field label="On">
            <DateInput value={onDate} onChange={(event) => setOnDate(event.target.value || todayInBrowser())} />
          </Field>
        </div>
        {summary.error ? <Notice tone="error">{summary.error}</Notice> : null}
        {data ? (
          <>
            {data.cover.averageKgDmPerHa === null ? (
              <Empty>No readings on or before {formatDate(onDate)} yet.</Empty>
            ) : (
              <p>
                <strong>{coverText(data.cover.averageKgDmPerHa)}</strong> average over {data.cover.hectares} ha, {kg(data.cover.totalKgDm)} kg DM in all, from {data.cover.readings} reading
                {data.cover.readings === 1 ? "" : "s"}
                {data.cover.oldestReading ? `, the oldest ${formatDate(data.cover.oldestReading)}` : ""}
                {data.cover.estimates ? ` (${data.cover.estimates} ${data.cover.estimates === 1 ? "is an estimate" : "are estimates"})` : ""}.
              </p>
            )}
            {data.cover.noReading.length ? <p className={ui.muted}>No reading yet: {data.cover.noReading.join(", ")}.</p> : null}
            {data.cover.noArea.length ? <p className={ui.muted}>Left out because they have no area: {data.cover.noArea.join(", ")}.</p> : null}
            {data.cover.wedge.length ? <h3>Feed wedge: highest cover first</h3> : null}
            {data.cover.wedge.length ? (
              <>
                <div className={farmRowStyles.phoneOnly}>
                  <FarmRowList
                    label="Feed wedge"
                    rows={data.cover.wedge.map((entry) => {
                      const paddock = data.paddocks.find((row) => row.paddockId === entry.paddockId);
                      return {
                        key: entry.paddockId,
                        title: entry.name,
                        parts: [
                          <span key="cover">
                            <CoverBar value={entry.cover} max={maxCover} /> {kg(entry.cover)}
                          </span>,
                          shortDate(entry.measuredOn, today),
                          paddock?.inNow ? `${paddock.inNow.mob} in` : null,
                        ],
                        details: (
                          <p>
                            {coverText(entry.cover)} on {formatDate(entry.measuredOn)} ({daysAgo(entry.measuredOn, today)}), {methodLabel(entry.method)}
                            {entry.estimate ? " (estimate)" : ""}. {entry.hectares} ha. Growth since the reading before: {growthText(paddock?.growth ?? null)}.
                            {paddock?.inNow ? ` ${mobText(paddock.inNow.mob, paddock.inNow.head)} in since ${formatDate(paddock.inNow.inOn)}.` : ""}
                          </p>
                        ),
                      };
                    })}
                  />
                </div>
                <div className={`${ui.tableWrap} ${farmRowStyles.wideOnly}`}>
                  <table className={ui.table}>
                    <thead>
                      <tr>
                        <th>Paddock</th>
                        <th className={ui.num}>Cover</th>
                        <th>Read</th>
                        <th>Growth since the reading before</th>
                        <th>Mob in now</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.cover.wedge.map((entry) => {
                        const paddock = data.paddocks.find((row) => row.paddockId === entry.paddockId);
                        return (
                          <tr key={entry.paddockId}>
                            <td>
                              <strong>{entry.name}</strong> <span className={ui.muted}>{entry.hectares} ha</span>
                            </td>
                            <td className={ui.num}>
                              <CoverBar value={entry.cover} max={maxCover} /> {coverText(entry.cover)}
                            </td>
                            <td>
                              {formatDate(entry.measuredOn)} · {methodLabel(entry.method)} {entry.estimate ? <Badge tone="amber">Estimate</Badge> : null}
                            </td>
                            <td>{growthText(paddock?.growth ?? null)}</td>
                            <td>{paddock?.inNow ? `${mobText(paddock.inNow.mob, paddock.inNow.head)}, in ${formatDate(paddock.inNow.inOn)}` : "–"}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </>
            ) : null}
          </>
        ) : null}
      </Card>
      <PhotoEstimates organisationId={organisationId} farm={farm} canDecide={canRecord} onDecided={reload} />
      <PhotoCalibrationCard organisationId={organisationId} farm={farm} />
      {canRecord ? <AddReading organisationId={organisationId} farmId={farm.id} paddocks={active} onAdded={reload} /> : null}
      {can("bookkeeper") ? <ImportReadings organisationId={organisationId} farm={farm} onImported={reload} /> : null}
      <Grazings organisationId={organisationId} farmId={farm.id} paddocks={active} canEdit={canRecord} canRemove={can("bookkeeper")} version={version} onChanged={reload} />
      <Supplements organisationId={organisationId} farm={farm} paddocks={active} months={data?.supplementMonths ?? []} canEdit={canRecord} canRemove={can("bookkeeper")} version={version} onChanged={reload} />
      <Readings organisationId={organisationId} farmId={farm.id} paddocks={active} canEdit={can("bookkeeper")} version={version} onChanged={reload} />
    </div>
  );
}

/** Cover readings, a page at a time from the server (decision 901). */
function Readings({ organisationId, farmId, paddocks, canEdit, version, onChanged }: { organisationId: string; farmId: string; paddocks: Paddock[]; canEdit: boolean; version: number; onChanged: () => void }) {
  const today = todayInBrowser();
  const [filters, setFilters] = useState<HistoryFilterValues>(NO_FILTERS);
  const history = useHistory<PastureReading>(`/api/farming/farms/${farmId}/pasture/readings`, "readings", organisationId, filters, version);
  const remove = (reading: PastureReading) => (canEdit ? <RemoveAction organisationId={organisationId} path={`/api/farming/pasture-readings/${reading.id}`} what="reading" onRemoved={onChanged} /> : null);
  return (
    <Card title="Cover readings" description="Newest first.">
      <HistoryFilters value={filters} onChange={setFilters} paddocks={paddocks} />
      {!history.loading && history.rows.length === 0 && !history.error ? (
        <Empty>
          No readings
          {filters.from || filters.to || filters.paddockId ? " for that choice" : " yet"}.
        </Empty>
      ) : null}
      {history.rows.length ? (
        <>
          <div className={farmRowStyles.phoneOnly}>
            <FarmRowList
              label="Cover readings"
              rows={history.rows.map((reading) => ({
                key: reading.id,
                title: reading.paddockName,
                parts: [kg(reading.cover), shortDate(reading.measuredOn, today), reading.estimate ? "estimate" : methodLabel(reading.method)],
                details: (
                  <p>
                    {coverText(reading.cover)} on {formatDate(reading.measuredOn)}, {methodLabel(reading.method)}. {reading.source}
                    {reading.note ? `. ${reading.note}` : ""}.
                  </p>
                ),
                more: remove(reading),
              }))}
            />
          </div>
          <div className={`${ui.tableWrap} ${farmRowStyles.wideOnly}`}>
            <table className={ui.table}>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Paddock</th>
                  <th className={ui.num}>Cover</th>
                  <th>Method</th>
                  <th>From</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {history.rows.map((reading) => (
                  <tr key={reading.id}>
                    <td>{formatDate(reading.measuredOn)}</td>
                    <td>{reading.paddockName}</td>
                    <td className={ui.num}>{coverText(reading.cover)}</td>
                    <td>
                      {methodLabel(reading.method)} {reading.estimate ? <Badge tone="amber">Estimate</Badge> : null}
                    </td>
                    <td>
                      {reading.source}
                      {reading.note ? <span className={ui.muted}> · {reading.note}</span> : null}
                    </td>
                    <td>{remove(reading)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
      <HistoryFooter shown={history.rows.length} hasMore={history.hasMore} loading={history.loading} error={history.error} onMore={history.loadMore} offline={history.offline} noun={history.rows.length === 1 ? "reading" : "readings"} />
    </Card>
  );
}

function PaddockSelect({ paddocks, value, onChange, optional }: { paddocks: Paddock[]; value: string; onChange: (value: string) => void; optional?: boolean }) {
  return (
    <select value={value} onChange={(event) => onChange(event.target.value)} required={!optional}>
      <option value="">{optional ? "No paddock" : "Choose…"}</option>
      {paddocks.map((paddock) => (
        <option key={paddock.id} value={paddock.id}>
          {paddock.name}
        </option>
      ))}
    </select>
  );
}

function AddReading({ organisationId, farmId, paddocks, onAdded }: { organisationId: string; farmId: string; paddocks: Paddock[]; onAdded: () => void }) {
  const [form, setForm] = useState({
    paddockId: "",
    measuredOn: todayInBrowser(),
    cover: "",
    method: "plate_meter" as PastureMethod,
    note: "",
  });
  const { busy, error, run } = useRun();
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void run(
      () =>
        api(`/api/farming/farms/${farmId}/pasture/readings`, {
          method: "POST",
          body: { organisationId, ...form, note: form.note || null },
        }),
      () => {
        setForm((current) => ({ ...current, cover: "", note: "" }));
        onAdded();
      },
    );
  };
  return (
    <Card title="Add a cover reading" description="Type the cover in kg DM/ha that the plate meter, app or eye gives. Plate meter clicks aren't converted.">
      {error ? <Notice tone="error">{error}</Notice> : null}
      <form className={ui.inlineForm} onSubmit={submit}>
        <Field label="Paddock">
          <PaddockSelect paddocks={paddocks} value={form.paddockId} onChange={(paddockId) => setForm((current) => ({ ...current, paddockId }))} />
        </Field>
        <Field label="Date">
          <DateInput
            value={form.measuredOn}
            onChange={(event) =>
              setForm((current) => ({
                ...current,
                measuredOn: event.target.value,
              }))
            }
            required
          />
        </Field>
        <Field label="Cover (kg DM/ha)">
          <input inputMode="numeric" value={form.cover} onChange={(event) => setForm((current) => ({ ...current, cover: event.target.value }))} required />
        </Field>
        <Field label="Method">
          <select
            value={form.method}
            onChange={(event) =>
              setForm((current) => ({
                ...current,
                method: event.target.value as PastureMethod,
              }))
            }
          >
            {PASTURE_METHODS.map((method) => (
              <option key={method} value={method}>
                {methodLabel(method)}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Note">
          <input value={form.note} maxLength={200} onChange={(event) => setForm((current) => ({ ...current, note: event.target.value }))} />
        </Field>
        <Button type="submit" disabled={busy}>
          Add reading
        </Button>
      </form>
    </Card>
  );
}

function ImportReadings({ organisationId, farm, onImported }: { organisationId: string; farm: Farm; onImported: () => void }) {
  const [file, setFile] = useState<{
    name: string;
    content?: string;
    contentBase64?: string;
  } | null>(null);
  const [method, setMethod] = useState<PastureMethod | "">("plate_meter");
  const [preview, setPreview] = useState<ReadingImportPreview | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [picker, setPicker] = useState(0);
  const { busy, error, run } = useRun();
  const path = `/api/farming/farms/${farm.id}/pasture/readings/import`;
  const body = (extra: Record<string, unknown>) => ({
    organisationId,
    fileName: file?.name,
    content: file?.content,
    contentBase64: file?.contentBase64,
    method: method || null,
    columns: preview?.columns,
    ...extra,
  });
  const pick = async (picked: File | undefined) => {
    setPreview(null);
    setDone(null);
    if (!picked) return setFile(null);
    if (/\.xlsx$/i.test(picked.name)) {
      const bytes = new Uint8Array(await picked.arrayBuffer());
      let binary = "";
      for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      setFile({ name: picked.name, contentBase64: btoa(binary) });
    } else {
      setFile({ name: picked.name, content: await picked.text() });
    }
  };
  const column = (key: "paddock" | "date" | "cover" | "method") => (
    <Field label={key[0].toUpperCase() + key.slice(1)}>
      <select
        value={preview?.columns[key] ?? ""}
        onChange={(event) => {
          if (!preview) return;
          const columns = {
            ...preview.columns,
            [key]: event.target.value === "" ? null : Number(event.target.value),
          };
          void run(
            () =>
              api<{ preview: ReadingImportPreview }>(path, {
                method: "POST",
                body: { ...body({ preview: true }), columns },
              }),
            (result) => setPreview(result.preview),
          );
        }}
      >
        <option value="">None</option>
        {preview?.headings.map((heading, index) => (
          <option key={index} value={index}>
            {heading || `Column ${index + 1}`}
          </option>
        ))}
      </select>
    </Field>
  );
  return (
    <Card title="Import cover readings" description="From a plate meter or app's CSV or Excel file.">
      <details>
        <summary className={ui.linkButton}>Import a file</summary>
        <p className={ui.muted}>A row per reading: paddock, date and cover in kg DM/ha, and optionally the method. Paddocks are matched by their current name. Check the preview; nothing is saved until you import.</p>
        {error ? <Notice tone="error">{error}</Notice> : null}
        {done ? <Notice tone="success">{done}</Notice> : null}
        <div className={ui.inlineForm}>
          <Field label="File">
            <input key={picker} type="file" accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={(event) => void pick(event.target.files?.[0])} />
          </Field>
          <Field label="Method, for rows without one">
            <select value={method} onChange={(event) => setMethod(event.target.value as PastureMethod | "")}>
              <option value="">None</option>
              {PASTURE_METHODS.map((entry) => (
                <option key={entry} value={entry}>
                  {methodLabel(entry)}
                </option>
              ))}
            </select>
          </Field>
          <Button
            variant="secondary"
            disabled={!file || busy}
            onClick={() =>
              void run(
                () =>
                  api<{ preview: ReadingImportPreview }>(path, {
                    method: "POST",
                    body: body({ preview: true, columns: undefined }),
                  }),
                (result) => setPreview(result.preview),
              )
            }
          >
            Preview
          </Button>
        </div>
        {preview ? (
          <>
            <div className={ui.inlineForm}>
              {column("paddock")}
              {column("date")}
              {column("cover")}
              {column("method")}
            </div>
            {preview.alreadyImportedOn ? <Notice tone="warning">This file was already imported on {formatDate(preview.alreadyImportedOn.slice(0, 10))}.</Notice> : null}
            <p>
              {preview.counts.readings} reading
              {preview.counts.readings === 1 ? "" : "s"} to import
              {preview.counts.errors ? `, ${preview.counts.errors} skipped` : ""}.
            </p>
            <div className={ui.tableWrap}>
              <table className={`${ui.table} ${ui.stackOnPhone}`}>
                <thead>
                  <tr>
                    <th>Line</th>
                    <th>Paddock</th>
                    <th>Date</th>
                    <th className={ui.num}>Cover</th>
                    <th>Method</th>
                    <th>Problem</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.rows.slice(0, 200).map((row) => (
                    <tr key={row.line}>
                      <td data-label="Line">{row.line}</td>
                      <td data-label="Paddock">{row.paddockText}</td>
                      <td data-label="Date">{row.measuredOn ? formatDate(row.measuredOn) : "–"}</td>
                      <td data-label="Cover" className={ui.num}>
                        {row.cover === null ? "–" : kg(row.cover)}
                      </td>
                      <td data-label="Method">{row.method ? methodLabel(row.method) : "–"}</td>
                      <td data-label="Problem">{row.error ?? ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Button
              disabled={busy || preview.counts.readings === 0 || Boolean(preview.alreadyImportedOn)}
              onClick={() =>
                void run(
                  () =>
                    api<{ imported: number; skipped: number }>(path, {
                      method: "POST",
                      body: body({}),
                    }),
                  (result) => {
                    setDone(`Imported ${result.imported} reading${result.imported === 1 ? "" : "s"}${result.skipped ? `; ${result.skipped} skipped` : ""}.`);
                    setPreview(null);
                    setFile(null);
                    setPicker((value) => value + 1);
                    onImported();
                  },
                )
              }
            >
              Import
            </Button>
          </>
        ) : null}
      </details>
    </Card>
  );
}

function Grazings({ organisationId, farmId, paddocks, canEdit, canRemove, version, onChanged }: { organisationId: string; farmId: string; paddocks: Paddock[]; canEdit: boolean; canRemove: boolean; version: number; onChanged: () => void }) {
  const today = todayInBrowser();
  const [form, setForm] = useState({
    paddockId: "",
    mob: "",
    head: "",
    inOn: today,
    outOn: "",
    preCover: "",
    postCover: "",
  });
  const [closing, setClosing] = useState<{
    id: string;
    outOn: string;
    postCover: string;
  } | null>(null);
  const [filters, setFilters] = useState<HistoryFilterValues>(NO_FILTERS);
  const { busy, error: runError, run } = useRun();
  // Mobs in now come on their own, so the day out can be recorded whatever page of history is showing.
  const open = useApiData<{ grazings: GrazingRecord[] }>(`/api/farming/farms/${farmId}/grazings`, { organisationId, open: 1, version });
  const history = useHistory<GrazingRecord>(`/api/farming/farms/${farmId}/grazings`, "grazings", organisationId, filters, version);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void run(
      () =>
        api(`/api/farming/farms/${farmId}/grazings`, {
          method: "POST",
          body: {
            organisationId,
            ...form,
            head: form.head || null,
            outOn: form.outOn || null,
            preCover: form.preCover || null,
            postCover: form.postCover || null,
          },
        }),
      () => {
        setForm((current) => ({
          ...current,
          mob: "",
          head: "",
          outOn: "",
          preCover: "",
          postCover: "",
        }));
        onChanged();
      },
    );
  };
  const dayOut = (grazing: GrazingRecord) =>
    closing?.id === grazing.id ? (
      <span className={ui.inlineForm}>
        <Field label="Day out">
          <DateInput value={closing.outOn} onChange={(event) => setClosing({ ...closing, outOn: event.target.value })} />
        </Field>
        <Field label="Cover after">
          <input inputMode="numeric" value={closing.postCover} onChange={(event) => setClosing({ ...closing, postCover: event.target.value })} />
        </Field>
        <Button
          disabled={busy}
          onClick={() =>
            void run(
              () =>
                api(`/api/farming/grazings/${grazing.id}`, {
                  method: "PATCH",
                  body: {
                    organisationId,
                    outOn: closing.outOn,
                    postCover: closing.postCover || null,
                  },
                }),
              () => {
                setClosing(null);
                onChanged();
              },
            )
          }
        >
          Save day out
        </Button>
        <Button variant="secondary" onClick={() => setClosing(null)}>
          Cancel
        </Button>
      </span>
    ) : (
      <Button variant="secondary" onClick={() => setClosing({ id: grazing.id, outOn: today, postCover: "" })}>
        Record day out
      </Button>
    );
  const remove = (grazing: GrazingRecord) => (canRemove ? <RemoveAction organisationId={organisationId} path={`/api/farming/grazings/${grazing.id}`} what="grazing" onRemoved={onChanged} /> : null);
  const eaten = (grazing: GrazingRecord) =>
    grazing.eaten ? `${kg(grazing.eaten.perHa)} kg DM/ha${grazing.eaten.totalKgDm !== null ? `, ${kg(grazing.eaten.totalKgDm)} kg DM` : ""}${grazing.eaten.perHead ? `, ${grazing.eaten.perHead} a head` : ""}` : null;
  const inNow = open.data?.grazings ?? [];
  return (
    <Card title="Grazings" description="Which mob was in which paddock, from the day in to the day out. With the covers before and after, Tohyee works out what was eaten.">
      {open.error ? <Notice tone="error">{open.error}</Notice> : null}
      {runError ? <Notice tone="error">{runError}</Notice> : null}
      {inNow.length ? (
        <>
          <h3>In now</h3>
          <FarmRowList
            label="Mobs in now"
            rows={inNow.map((grazing) => ({
              key: grazing.id,
              title: grazing.paddockName,
              parts: [mobText(grazing.mob, grazing.head), `in ${shortDate(grazing.inOn, today)}`, daysAgo(grazing.inOn, today)],
              details: grazing.preCover !== null ? <p>Cover before: {coverText(grazing.preCover)}.</p> : undefined,
              actions: canEdit ? dayOut(grazing) : undefined,
              more: remove(grazing),
            }))}
          />
        </>
      ) : null}
      {canEdit ? (
        <details>
          <summary className={ui.linkButton}>Add a grazing</summary>
          <form className={ui.inlineForm} onSubmit={submit}>
            <Field label="Paddock">
              <PaddockSelect paddocks={paddocks} value={form.paddockId} onChange={(paddockId) => setForm((current) => ({ ...current, paddockId }))} />
            </Field>
            <Field label="Mob">
              <input
                value={form.mob}
                maxLength={100}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    mob: event.target.value,
                  }))
                }
                required
              />
            </Field>
            <Field label="Head">
              <input
                inputMode="numeric"
                value={form.head}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    head: event.target.value,
                  }))
                }
              />
            </Field>
            <Field label="Day in">
              <DateInput
                value={form.inOn}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    inOn: event.target.value,
                  }))
                }
                required
              />
            </Field>
            <Field label="Day out" hint="Blank while still in.">
              <DateInput
                value={form.outOn}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    outOn: event.target.value,
                  }))
                }
              />
            </Field>
            <Field label="Cover before">
              <input
                inputMode="numeric"
                value={form.preCover}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    preCover: event.target.value,
                  }))
                }
              />
            </Field>
            <Field label="Cover after">
              <input
                inputMode="numeric"
                value={form.postCover}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    postCover: event.target.value,
                  }))
                }
              />
            </Field>
            <Button type="submit" disabled={busy}>
              Add grazing
            </Button>
          </form>
        </details>
      ) : null}
      <h3>History</h3>
      <HistoryFilters value={filters} onChange={setFilters} paddocks={paddocks} />
      {!history.loading && history.rows.length === 0 && !history.error ? (
        <Empty>
          No grazings
          {filters.from || filters.to || filters.paddockId ? " for that choice" : " yet"}.
        </Empty>
      ) : null}
      {history.rows.length ? (
        <>
          <div className={farmRowStyles.phoneOnly}>
            <FarmRowList
              label="Grazings"
              rows={history.rows.map((grazing) => ({
                key: grazing.id,
                title: grazing.paddockName,
                parts: [mobText(grazing.mob, grazing.head), `${shortDate(grazing.inOn, today)}${grazing.outOn ? ` to ${shortDate(grazing.outOn, today)}` : ""}`, grazing.outOn ? null : "in now"],
                details: (
                  <p>
                    Cover before {grazing.preCover === null ? "not recorded" : coverText(grazing.preCover)}, after {grazing.postCover === null ? "not recorded" : coverText(grazing.postCover)}.{eaten(grazing) ? ` Eaten: ${eaten(grazing)}.` : ""}
                  </p>
                ),
                actions: canEdit && !grazing.outOn ? dayOut(grazing) : undefined,
                more: remove(grazing),
              }))}
            />
          </div>
          <div className={`${ui.tableWrap} ${farmRowStyles.wideOnly}`}>
            <table className={ui.table}>
              <thead>
                <tr>
                  <th>Paddock</th>
                  <th>Mob</th>
                  <th>In</th>
                  <th>Out</th>
                  <th className={ui.num}>Cover before → after</th>
                  <th className={ui.num}>Eaten</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {history.rows.map((grazing) => (
                  <tr key={grazing.id}>
                    <td>{grazing.paddockName}</td>
                    <td>{mobText(grazing.mob, grazing.head)}</td>
                    <td>{formatDate(grazing.inOn)}</td>
                    <td>{grazing.outOn ? formatDate(grazing.outOn) : <Badge tone="green">In now</Badge>}</td>
                    <td className={ui.num}>
                      {grazing.preCover === null ? "–" : kg(grazing.preCover)} → {grazing.postCover === null ? "–" : kg(grazing.postCover)}
                    </td>
                    <td className={ui.num}>{eaten(grazing) ?? "–"}</td>
                    <td>{remove(grazing)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
      <HistoryFooter shown={history.rows.length} hasMore={history.hasMore} loading={history.loading} error={history.error} onMore={history.loadMore} offline={history.offline} noun={history.rows.length === 1 ? "grazing" : "grazings"} />
    </Card>
  );
}

function Supplements({
  organisationId,
  farm,
  paddocks,
  months,
  canEdit,
  canRemove,
  version,
  onChanged,
}: {
  organisationId: string;
  farm: Farm;
  paddocks: Paddock[];
  months: PastureSummary["supplementMonths"];
  canEdit: boolean;
  canRemove: boolean;
  version: number;
  onChanged: () => void;
}) {
  const today = todayInBrowser();
  const [form, setForm] = useState({
    fedOn: today,
    feed: "",
    quantity: "",
    unit: "kg_dm" as SupplementUnit,
    kgDm: "",
    paddockId: "",
    mob: "",
  });
  const [filters, setFilters] = useState<HistoryFilterValues>(NO_FILTERS);
  const { busy, error: runError, run } = useRun();
  const history = useHistory<Supplement>(`/api/farming/farms/${farm.id}/supplements`, "supplements", organisationId, filters, version);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void run(
      () =>
        api(`/api/farming/farms/${farm.id}/supplements`, {
          method: "POST",
          body: {
            organisationId,
            ...form,
            kgDm: form.unit === "kg_dm" ? null : form.kgDm || null,
            paddockId: form.paddockId || null,
            mob: form.mob || null,
          },
        }),
      () => {
        setForm((current) => ({ ...current, quantity: "", kgDm: "" }));
        onChanged();
      },
    );
  };
  const quantity = (line: Supplement) => `${Number(line.quantity).toLocaleString("en-NZ")} ${SUPPLEMENT_UNIT_LABELS[line.unit]}`;
  const remove = (line: Supplement) => (canRemove ? <RemoveAction organisationId={organisationId} path={`/api/farming/supplements/${line.id}`} what="feed" onRemoved={onChanged} /> : null);
  return (
    <Card title="Supplements fed" description="What was fed out, and how much. Only kg DM is added up; anything else counts once its kg DM is typed. Buying feed stays a bill.">
      {runError ? <Notice tone="error">{runError}</Notice> : null}
      {months.length ? (
        <ul style={{ margin: "0 0 12px" }}>
          {months.slice(0, 6).map((month) => (
            <li key={month.month}>
              {formatDate(`${month.month}-01`).replace(/^\d+\s/, "")}: <strong>{Number(month.kgDm).toLocaleString("en-NZ")} kg DM</strong>
              {month.notCounted.length ? (
                <span className={ui.muted}> · not counted (no kg DM): {month.notCounted.map((line) => `${Number(line.quantity).toLocaleString("en-NZ")} ${SUPPLEMENT_UNIT_LABELS[line.unit]} ${line.feed}`).join(", ")}</span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {canEdit ? (
        <details>
          <summary className={ui.linkButton}>Add feed</summary>
          <form className={ui.inlineForm} onSubmit={submit}>
            <Field label="Fed on">
              <DateInput
                value={form.fedOn}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    fedOn: event.target.value,
                  }))
                }
                required
              />
            </Field>
            <Field label="Feed">
              <input
                value={form.feed}
                maxLength={100}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    feed: event.target.value,
                  }))
                }
                required
              />
            </Field>
            <Field label="Quantity">
              <input
                inputMode="decimal"
                value={form.quantity}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    quantity: event.target.value,
                  }))
                }
                required
              />
            </Field>
            <Field label="Unit">
              <select
                value={form.unit}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    unit: event.target.value as SupplementUnit,
                  }))
                }
              >
                {SUPPLEMENT_UNITS.map((unit) => (
                  <option key={unit} value={unit}>
                    {SUPPLEMENT_UNIT_LABELS[unit]}
                  </option>
                ))}
              </select>
            </Field>
            {form.unit !== "kg_dm" ? (
              <Field label="kg DM" hint="Optional: only then does it count.">
                <input
                  inputMode="decimal"
                  value={form.kgDm}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      kgDm: event.target.value,
                    }))
                  }
                />
              </Field>
            ) : null}
            <Field label="Paddock">
              <PaddockSelect paddocks={paddocks} value={form.paddockId} optional onChange={(paddockId) => setForm((current) => ({ ...current, paddockId }))} />
            </Field>
            <Field label="Mob">
              <input
                value={form.mob}
                maxLength={100}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    mob: event.target.value,
                  }))
                }
              />
            </Field>
            <Button type="submit" disabled={busy}>
              Add
            </Button>
          </form>
        </details>
      ) : null}
      <h3>History</h3>
      <HistoryFilters value={filters} onChange={setFilters} paddocks={paddocks} />
      {!history.loading && history.rows.length === 0 && !history.error ? (
        <Empty>
          None recorded
          {filters.from || filters.to || filters.paddockId ? " for that choice" : " yet"}.
        </Empty>
      ) : null}
      {history.rows.length ? (
        <>
          <div className={farmRowStyles.phoneOnly}>
            <FarmRowList
              label="Supplements fed"
              rows={history.rows.map((line) => ({
                key: line.id,
                title: shortDate(line.fedOn, today),
                parts: [line.feed, quantity(line), line.paddockName],
                details: (
                  <p>
                    {quantity(line)} of {line.feed} on {formatDate(line.fedOn)}
                    {line.unit === "kg_dm" ? "" : line.kgDm === null ? " (not counted: no kg DM)" : ` (${Number(line.kgDm).toLocaleString("en-NZ")} kg DM)`}
                    {[line.paddockName, line.mob].filter(Boolean).length ? `, ${[line.paddockName, line.mob].filter(Boolean).join(" · ")}` : ""}.
                  </p>
                ),
                more: remove(line),
              }))}
            />
          </div>
          <div className={`${ui.tableWrap} ${farmRowStyles.wideOnly}`}>
            <table className={ui.table}>
              <thead>
                <tr>
                  <th>Fed on</th>
                  <th>Feed</th>
                  <th className={ui.num}>Quantity</th>
                  <th className={ui.num}>kg DM</th>
                  <th>Where</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {history.rows.map((line) => (
                  <tr key={line.id}>
                    <td>{formatDate(line.fedOn)}</td>
                    <td>{line.feed}</td>
                    <td className={ui.num}>{quantity(line)}</td>
                    <td className={ui.num}>{line.unit === "kg_dm" ? Number(line.quantity).toLocaleString("en-NZ") : line.kgDm === null ? <span className={ui.muted}>Not counted</span> : Number(line.kgDm).toLocaleString("en-NZ")}</td>
                    <td>{[line.paddockName, line.mob].filter(Boolean).join(" · ") || "–"}</td>
                    <td>{remove(line)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
      <HistoryFooter shown={history.rows.length} hasMore={history.hasMore} loading={history.loading} error={history.error} onMore={history.loadMore} offline={history.offline} noun="lines" />
    </Card>
  );
}

/** A paddock's latest cover and growth, for its panel on the map. */
export function PaddockPastureSummary({ organisationId, paddockId }: { organisationId: string; paddockId: string }) {
  const pasture = useApiData<{
    pasture: {
      readings: Array<PastureReading & { growth: Growth | null }>;
      grazings: GrazingRecord[];
    };
  }>(`/api/farming/paddocks/${paddockId}/pasture`, { organisationId });
  if (!pasture.data) return null;
  const latest = pasture.data.pasture.readings[0];
  const grazing = pasture.data.pasture.grazings[0];
  return (
    <>
      <h3>Pasture</h3>
      {latest ? (
        <p>
          {kg(latest.cover)} kg DM/ha on {formatDate(latest.measuredOn)} ({methodLabel(latest.method)}){latest.growth?.kind === "rate" ? `, growing ${latest.growth.kgDmPerHaPerDay} kg DM/ha/day` : ""}.{" "}
          {grazing ? `Last grazed by ${grazing.mob} from ${formatDate(grazing.inOn)}${grazing.outOn ? ` to ${formatDate(grazing.outOn)}` : " (still in)"}. ` : ""}
          <Link href="/operations/farming/pasture">Pasture and feed</Link>
        </p>
      ) : (
        <p className={ui.muted}>
          No readings yet. <Link href="/operations/farming/pasture">Pasture and feed</Link>
        </p>
      )}
    </>
  );
}
