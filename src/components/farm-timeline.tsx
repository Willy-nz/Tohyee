"use client";

import Link from "next/link";
import { useState } from "react";
import { FarmRowList } from "@/components/farm-rows";
import type { FarmContext } from "@/components/farm-workspace";
import { useApiData } from "@/components/hooks";
import { InfoTip } from "@/components/info-tip";
import { Badge, Button, Card, Field, Notice, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { api, errorMessage } from "@/lib/client/api";
import { type FarmTerms, TERM_ENTRIES, term } from "@/lib/farming/farm-terms";
import { shortDate } from "@/lib/farming/farm-words";
import { paddockLabel } from "@/lib/farming/mob-rules";
import type { Mob } from "@/lib/farming/mobs";
import type { Paddock } from "@/lib/farming/paddocks";
import type { GrazingImportPreview, TimelineItem, TimelineKind } from "@/lib/farming/timeline";
import { formatDate, todayInBrowser } from "@/lib/format";
import styles from "./farm-workspace.module.css";

/*
 * The farm's timeline (decisions 1445-1446): moves, sales and other mob
 * events, treatments, weights, scanning and sprays in one list, by mob and
 * paddock; the grazing history import (decision 1447) and farm words
 * (decision 1448).
 */

const NATURAL = new Intl.Collator("en-NZ", { numeric: true, sensitivity: "base" });

const KIND_LABELS: Record<TimelineKind, string> = { mob: "Mob events", grazing: "Typed grazings", treatment: "Treatments", breeding: "Breeding", spray: "Sprays" };

export function useFarmTerms(organisationId: string): FarmTerms {
  return useApiData<{ terms: Record<string, string> }>("/api/farming/farm-terms", { organisationId }).data?.terms ?? {};
}

export function FarmTimeline({ organisationId, farm, mobId: givenMob = null, paddockId: givenPaddock = null }: FarmContext & { mobId?: string | null; paddockId?: string | null }) {
  const today = todayInBrowser();
  const { can } = useWorkspace();
  const terms = useFarmTerms(organisationId);
  const [mobId, setMobId] = useState(givenMob ?? "");
  const [paddockId, setPaddockId] = useState(givenPaddock ?? "");
  const [kinds, setKinds] = useState<TimelineKind[]>(["mob", "grazing", "treatment", "breeding", "spray"]);
  const [version, setVersion] = useState(0);
  const mobs = useApiData<{ mobs: Mob[] }>(`/api/farming/farms/${farm.id}/mobs`, { organisationId, includeClosed: "1" });
  const paddocks = useApiData<{ paddocks: Paddock[] }>(`/api/farming/farms/${farm.id}/paddocks`, { organisationId });
  const timeline = useApiData<{ items: TimelineItem[]; more: boolean }>(`/api/farming/farms/${farm.id}/timeline`, { organisationId, mobId: mobId || null, paddockId: paddockId || null, kinds: kinds.join(","), version });
  const items = timeline.data?.items ?? [];
  return (
    <div className={styles.grid}>
      <div style={{ display: "grid", gap: 16, minWidth: 0 }}>
        <Card title="What happened">
          <div className={ui.inlineForm}>
            <Field label={term(terms, "mob")}>
              <select value={mobId} onChange={(event) => setMobId(event.target.value)}>
                <option value="">All</option>
                {[...(mobs.data?.mobs ?? [])].sort((a, b) => NATURAL.compare(a.name, b.name)).map((mob) => (
                  <option key={mob.id} value={mob.id}>
                    {mob.name}
                    {mob.status === "closed" ? " (closed)" : ""}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={term(terms, "paddock")}>
              <select value={paddockId} onChange={(event) => setPaddockId(event.target.value)}>
                <option value="">All</option>
                {[...(paddocks.data?.paddocks ?? [])].sort((a, b) => NATURAL.compare(a.name, b.name)).map((paddock) => (
                  <option key={paddock.id} value={paddock.id}>
                    {paddockLabel(paddock.name)}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <div className={ui.tabs} role="group" aria-label="Show">
            {(Object.keys(KIND_LABELS) as TimelineKind[]).map((kind) => (
              <button key={kind} type="button" aria-pressed={kinds.includes(kind)} className={`${ui.tab} ${kinds.includes(kind) ? ui.tabActive : ""}`} onClick={() => setKinds((current) => (current.includes(kind) ? current.filter((entry) => entry !== kind) : [...current, kind]))}>
                {KIND_LABELS[kind]}
              </button>
            ))}
          </div>
          {timeline.error ? <Notice tone="error">{timeline.error}</Notice> : null}
          {timeline.data && !items.length ? <p>Nothing recorded for this choice.</p> : null}
          {items.length ? (
            <FarmRowList
              label="Farm timeline"
              rows={items.map((item) => ({
                key: item.key,
                title: shortDate(item.date, today),
                parts: [item.title, item.inHeadCount ? <Badge key="b" tone="blue">Head count</Badge> : null],
                details: item.detail ? <p>{item.detail}</p> : undefined,
              }))}
            />
          ) : null}
          {timeline.data?.more ? <p className={ui.muted}>Showing the latest 500. Choose a {term(terms, "mob").toLowerCase()} or {term(terms, "paddock").toLowerCase()} to see further back.</p> : null}
          {!timeline.data && !timeline.error ? <p className={ui.muted}>Loading…</p> : null}
        </Card>
      </div>
      <div style={{ display: "grid", gap: 16, minWidth: 0 }}>
        <p>
          <Link href={`/operations/farm/mobs?farm=${farm.id}`}>{term(terms, "mobs")}</Link>
        </p>
        {can("bookkeeper") ? <ImportGrazings organisationId={organisationId} farmId={farm.id} onImported={() => setVersion((value) => value + 1)} /> : null}
      </div>
    </div>
  );
}

function ImportGrazings({ organisationId, farmId, onImported }: { organisationId: string; farmId: string; onImported: () => void }) {
  const [file, setFile] = useState<{ name: string; content?: string; contentBase64?: string } | null>(null);
  const [preview, setPreview] = useState<GrazingImportPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [picker, setPicker] = useState(0);
  const path = `/api/farming/farms/${farmId}/grazings/import`;
  const send = <T,>(previewOnly: boolean) => api<T>(path, { method: "POST", body: { organisationId, fileName: file?.name, content: file?.content, contentBase64: file?.contentBase64, preview: previewOnly } });
  const pick = async (picked: File | undefined) => {
    setPreview(null);
    setDone(null);
    if (!picked) return setFile(null);
    if (/\.xlsx$/i.test(picked.name)) {
      const bytes = new Uint8Array(await picked.arrayBuffer());
      let binary = "";
      for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      setFile({ name: picked.name, contentBase64: btoa(binary) });
    } else setFile({ name: picked.name, content: await picked.text() });
  };
  const run = async (work: () => Promise<void>) => {
    setError(null);
    try {
      await work();
    } catch (caught) {
      setError(errorMessage(caught));
    }
  };
  return (
    <Card title="Import grazing history">
      <details>
        <summary className={ui.linkButton}>Import a file</summary>
        <p className={ui.muted}>
          A row per grazing: mob, paddock, day in, day out, and head if you have it.{" "}
          <InfoTip label="Grazing history">A mob named like a mob record becomes that mob&apos;s moves; others stay as typed grazings. Every row needs a day out. Sales, deaths and births aren&apos;t imported here: they change the books&apos; head count, so record them on the mob. Nothing is saved until you import.</InfoTip>
        </p>
        {error ? <Notice tone="error">{error}</Notice> : null}
        {done ? <Notice tone="success">{done}</Notice> : null}
        <div className={ui.inlineForm}>
          <Field label="File">
            <input key={picker} type="file" accept=".csv,.xlsx,text/csv" onChange={(event) => void pick(event.target.files?.[0])} />
          </Field>
          <Button variant="secondary" disabled={!file} onClick={() => void run(async () => setPreview((await send<{ preview: GrazingImportPreview }>(true)).preview))}>
            Preview
          </Button>
        </div>
        {preview ? (
          <>
            {preview.alreadyImportedOn ? <Notice tone="warning">This file was already imported on {formatDate(preview.alreadyImportedOn.slice(0, 10))}.</Notice> : null}
            <p>
              {preview.counts.grazings} grazing{preview.counts.grazings === 1 ? "" : "s"} to import ({preview.counts.mobRecords} for mob records){preview.counts.errors ? `, ${preview.counts.errors} skipped` : ""}.
            </p>
            <div className={ui.tableWrap}>
              <table className={`${ui.table} ${ui.stackOnPhone}`}>
                <thead>
                  <tr>
                    <th>Line</th>
                    <th>Mob</th>
                    <th>Paddock</th>
                    <th>In</th>
                    <th>Out</th>
                    <th>Problem</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.rows.slice(0, 200).map((row) => (
                    <tr key={row.line}>
                      <td data-label="Line">{row.line}</td>
                      <td data-label="Mob">
                        {row.mob}
                        {row.mobId ? " (mob record)" : ""}
                      </td>
                      <td data-label="Paddock">{row.paddockName}</td>
                      <td data-label="In">{row.inOn ? formatDate(row.inOn) : "–"}</td>
                      <td data-label="Out">{row.outOn ? formatDate(row.outOn) : "–"}</td>
                      <td data-label="Problem">{row.error ?? ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Button
              disabled={!preview.counts.grazings || Boolean(preview.alreadyImportedOn)}
              onClick={() =>
                void run(async () => {
                  const result = await send<{ imported: number; skipped: number }>(false);
                  setDone(`Imported ${result.imported} grazing${result.imported === 1 ? "" : "s"}${result.skipped ? `; ${result.skipped} skipped` : ""}.`);
                  setPreview(null);
                  setFile(null);
                  setPicker((value) => value + 1);
                  onImported();
                })
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

/** Farm words (decision 1448): admins rename words on the screens; IRD's classes stay underneath. */
export function FarmTermsCard({ organisationId }: { organisationId: string }) {
  const { can } = useWorkspace();
  const loaded = useApiData<{ terms: Record<string, string> }>("/api/farming/farm-terms", { organisationId });
  const [group, setGroup] = useState<(typeof TERM_ENTRIES)[number]["group"]>("Words");
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  if (!can("admin")) return null;
  const terms = loaded.data?.terms ?? {};
  const shown = TERM_ENTRIES.filter((entry) => entry.group === group);
  const save = async () => {
    setError(null);
    try {
      await api("/api/farming/farm-terms", { method: "PUT", body: { organisationId, terms: Object.entries(values).map(([key, label]) => ({ key, label })) } });
      setValues({});
      setSaved(true);
      loaded.reload();
    } catch (caught) {
      setError(errorMessage(caught));
    }
  };
  return (
    <Card
      title="Farm words"
      description={
        <>
          Your own names on the farm screens.{" "}
          <InfoTip label="Farm words">Change what the screens call mobs, actions, kinds of stock and classes. It changes the words only: the books, IRD&apos;s classes and the files Tohyee makes keep the standard names.</InfoTip>
        </>
      }
    >
      <details onToggle={() => setSaved(false)}>
        <summary className={ui.linkButton}>Change words</summary>
        {error ? <Notice tone="error">{error}</Notice> : null}
        {saved ? <Notice tone="success">Saved.</Notice> : null}
        <Field label="Words for">
          <select value={group} onChange={(event) => (setGroup(event.target.value as typeof group), setValues({}))}>
            {[...new Set(TERM_ENTRIES.map((entry) => entry.group))].map((entry) => (
              <option key={entry}>{entry}</option>
            ))}
          </select>
        </Field>
        <div className={ui.tableWrap}>
          <table className={`${ui.table} ${ui.stackOnPhone}`}>
            <thead>
              <tr>
                <th>Standard</th>
                <th>Your word</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((entry) => (
                <tr key={entry.key}>
                  <td data-label="Standard">{entry.standard}</td>
                  <td data-label="Your word">
                    <input aria-label={`Your word for ${entry.standard}`} maxLength={60} value={values[entry.key] ?? terms[entry.key] ?? ""} placeholder={entry.standard} onChange={(event) => setValues((current) => ({ ...current, [entry.key]: event.target.value }))} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <Button variant="secondary" disabled={!Object.keys(values).length} onClick={() => void save()}>
          Save words
        </Button>
      </details>
    </Card>
  );
}
