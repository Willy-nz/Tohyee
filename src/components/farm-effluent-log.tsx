"use client";

import Link from "next/link";
import { useState } from "react";
import { useEffluentSetup, setupOverlays } from "@/components/farm-effluent";
import { SafetyHistory } from "@/components/farm-safety";
import { PhotoPicker, Thumbnails } from "@/components/farm-safety-reports";
import { type MapOverlay, PaddockMap } from "@/components/farming";
import { useApiData } from "@/components/hooks";
import { type PickedFile, QueuedWork, submitThroughQueue, useOfflineQueue, waitForFiles } from "@/components/offline-queue";
import { Badge, Button, Card, Empty, Field, Notice, ui } from "@/components/ui";
import { errorMessage } from "@/lib/client/api";
import type { ApplicationView, EffluentLog, LastMoved, PondView } from "@/lib/effluent/log";
import { COMPARISON_NOTE, DEFERRAL_LABELS, DEFERRAL_REASONS, type DeferralReason, flagTexts, hasFlags, PONDING_LABELS, PONDING_RESULTS, type PondingResult, summaryLines } from "@/lib/effluent/rules";
import { effluentHref } from "@/lib/effluent/screens";
import { activeConsent, SYSTEM_TYPE_LABELS } from "@/lib/effluent/shared";
import type { Farm, FarmingSettings, Paddock } from "@/lib/farming/paddocks";
import type { TractorJobListItem } from "@/lib/farming/tractor-shared";
import { formatDate, formatDateTime } from "@/lib/format";
import { newOperationId, type QueueItem } from "@/lib/offline/queue";
import type { Position } from "@/lib/safety/shared";
import styles from "./farm-safety.module.css";

/*
 * Effluent's daily log on the phone (#487, decisions 1080-1089): start a
 * run (pods or irrigator placed, with photos and where the phone is),
 * shift it, stop it with the ponding and runoff check; read the pond;
 * say effluent wasn't applied today and why. Everything goes through the
 * device's one queue, so it works with no signal and is kept once.
 */

type Ctx = { organisationId: string; farm: Farm };

export function useEffluentLog(organisationId: string, farmId: string) {
  return useApiData<EffluentLog>("/api/farming/effluent/log", { organisationId, farmId });
}

function nowLocal(): string {
  const now = new Date();
  now.setSeconds(0, 0);
  return new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

/** A datetime-local value (the phone's own time zone) as an ISO time. */
function toIso(local: string): string {
  return new Date(local).toISOString();
}

function time(iso: string) {
  return new Date(iso).toLocaleString("en-NZ", { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
}

function where(): Promise<Position | null> {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      (position) => resolve([Math.round(position.coords.longitude * 1e6) / 1e6, Math.round(position.coords.latitude * 1e6) / 1e6]),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: 15_000, maximumAge: 60_000 },
    );
  });
}

/** Runs started on this device and not yet with Tohyee, and the changes queued for each run. */
function pendingRuns(items: QueueItem[], farmId: string) {
  return items.filter((item) => item.kind === "effluent.application" && item.farmId === farmId && item.status !== "synced");
}

function queuedChanges(items: QueueItem[], runKey: string) {
  return items.filter((item) => item.kind === "effluent.application.change" && item.status !== "synced" && item.meta.run === runKey);
}

function outcomeText(state: string) {
  return state === "synced" ? "Saved." : state === "waiting" ? "Saved on this device, waiting to send. It goes by itself when Tohyee can be reached." : "This device's storage wouldn't keep it. Keep Tohyee open until it shows Synced.";
}

/** Map overlays for the log: the setup's, plus each system's pods or irrigator where they were last moved. */
export function lastMovedOverlays(lastMoved: LastMoved[]): MapOverlay[] {
  return lastMoved
    .filter((each) => each.point)
    .map((each) => ({ id: `m${each.systemId}`, label: `${each.systemName}${each.label ? ` (${each.label})` : ""}: last moved ${time(each.movedAt)}${each.running ? ", running" : ", stopped"}`, tone: "effluent" as const, point: each.point, marker: "dot" as const, short: each.systemName.slice(0, 1).toUpperCase() }));
}

// Log screen ---------------------------------------------------------------------------------------------

export function LogScreen({ organisationId, farm }: Ctx) {
  const log = useEffluentLog(organisationId, farm.id);
  const paddocks = useApiData<{ paddocks: Paddock[] }>(`/api/farming/farms/${farm.id}/paddocks`, { organisationId });
  const imageryKey = useApiData<{ settings: FarmingSettings }>("/api/farming/settings", { organisationId }).data?.settings.imageryKey ?? null;
  const [starting, setStarting] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  if (log.error) return <Notice tone="error">{log.error}</Notice>;
  if (!log.data || !paddocks.data) return <p className={ui.muted}>Loading…</p>;
  const data = log.data;
  const active = paddocks.data.paddocks.filter((paddock) => paddock.status === "active");
  const names = new Map(active.map((paddock) => [paddock.id, paddock.name]));
  const consent = activeConsent(data.setup.consents)?.data ?? null;
  const { overlays, fills } = setupOverlays(data.setup, active, { consent });
  overlays.push(...lastMovedOverlays(data.lastMoved));
  const running = data.applications.filter((application) => application.running);
  const finished = data.applications.filter((application) => !application.running);
  const canLog = data.setup.access.canLog;
  return (
    <div className={styles.overview}>
      <div className={styles.column}>
        {done ? <Notice tone="success">{done}</Notice> : null}
        <QueuedWork organisationId={organisationId} farmId={farm.id} kinds={["effluent."]} title="Effluent on this device" onSynced={log.reload} />
        {canLog && !starting ? (
          <div className={styles.bigActions}>
            <button type="button" className={styles.bigAction} onClick={() => setStarting(true)}>
              <span className={styles.icon} aria-hidden="true">+</span>
              <span>
                Start or record a run
                <small>Pods, irrigator, tanker or sprinklers</small>
              </span>
            </button>
          </div>
        ) : null}
        {starting ? (
          <StartForm
            organisationId={organisationId}
            farm={farm}
            log={data}
            paddocks={active}
            onDone={(text) => {
              setStarting(false);
              setDone(text);
              log.reload();
            }}
            onCancel={() => setStarting(false)}
          />
        ) : null}
        <RunningCard organisationId={organisationId} farm={farm} log={data} running={running} paddocks={active} canLog={canLog} onSaved={(text) => { setDone(text); log.reload(); }} />
        <Card title="Last 30 days" description={COMPARISON_NOTE}>
          <ul style={{ margin: "0 0 8px", paddingLeft: 18 }}>
            {summaryLines(data.summary, consent).map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          {!finished.length ? <Empty>No runs recorded in the last 30 days.</Empty> : null}
          <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {finished.map((application) => (
              <RunRow key={application.recordId} organisationId={organisationId} application={application} log={data} names={names} />
            ))}
          </ul>
        </Card>
      </div>
      <div className={styles.column}>
        <Card title="Map" description="Dots: where each system's pods or irrigator were last moved. Blue: effluent blocks. Red: no-apply zones and buffers.">
          <PaddockMap paddocks={active} selected={null} imageryKey={imageryKey} fills={fills} overlays={overlays} label={`Map of ${farm.name}: effluent blocks, no-apply zones and where pods and irrigators were last moved`} />
          {data.lastMoved.length ? (
            <ul style={{ margin: "8px 0 0", paddingLeft: 18 }}>
              {data.lastMoved.map((each) => (
                <li key={each.systemId}>
                  <strong>{each.systemName}</strong>: last moved {time(each.movedAt)}
                  {each.label ? ` (${each.label})` : ""}
                  {each.paddockId ? `, paddock ${names.get(each.paddockId) ?? each.paddockId}` : ""}
                  {each.running ? "" : ", stopped"}
                  {each.shiftDue ? <> · shift due {time(each.shiftDue)}</> : null}
                </li>
              ))}
            </ul>
          ) : null}
        </Card>
        <DeferralCard organisationId={organisationId} farm={farm} log={data} onSaved={(text) => { setDone(text); log.reload(); }} />
      </div>
    </div>
  );
}

function RunRow({ organisationId, application, log, names }: { organisationId: string; application: ApplicationView; log: EffluentLog; names: ReadonlyMap<string, string> }) {
  const [open, setOpen] = useState(false);
  const system = log.setup.systems.find((each) => each.recordId === application.data.systemId);
  const consent = activeConsent(log.setup.consents)?.data ?? null;
  const flags = flagTexts(application.flags, consent, names);
  const data = application.data;
  return (
    <li style={{ borderTop: "1px solid var(--border)", padding: "10px 0" }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
        <strong>{system?.data.name ?? "System"}</strong>
        <span className={ui.muted}>{time(data.startedAt)}{data.stoppedAt ? ` to ${time(data.stoppedAt)}` : ""}</span>
        {application.change === "withdrawn" ? <Badge>Withdrawn</Badge> : application.change === "corrected" ? <Badge tone="amber">Corrected</Badge> : null}
        {hasFlags(application.flags) ? <Badge tone="amber">{flags.length} to look at</Badge> : null}
      </div>
      <div style={{ overflowWrap: "anywhere" }}>
        {[data.paddockIds.length ? `Paddock${data.paddockIds.length === 1 ? "" : "s"} ${data.paddockIds.map((id) => names.get(id) ?? id).join(", ")}` : null, data.depthEnteredMm ? `${data.depthEnteredMm} mm as entered` : null, data.depthWorkedOut ? `${data.depthWorkedOut.mm} mm estimated from the settings` : null, data.ponding ? PONDING_LABELS[data.ponding.result] : null, data.loads ? `${data.loads} loads` : null].filter(Boolean).join(" · ")}
      </div>
      {flags.length ? (
        <ul style={{ margin: "4px 0", paddingLeft: 18 }}>
          {flags.map((text) => (
            <li key={text}>{text}</li>
          ))}
        </ul>
      ) : null}
      <Button variant="secondary" size="small" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? "Less" : "More"}
      </Button>
      {open ? (
        <div>
          {data.depthWorkedOut ? <p className={ui.muted}>Estimate from the system&apos;s settings: {data.depthWorkedOut.how}. The depth as entered is what the person measured or said.</p> : null}
          {data.positions.length ? <p>Positions: {data.positions.map((position) => `${position.label ?? "set"} ${time(position.movedAt)}${position.paddockId ? ` (paddock ${names.get(position.paddockId) ?? position.paddockId})` : ""}`).join("; ")}</p> : null}
          {data.ponding?.note ? <p>Ponding check: {data.ponding.note}</p> : null}
          {data.weather || data.soil ? <p>{[data.weather ? `Weather: ${data.weather}` : null, data.soil ? `Soil: ${data.soil}` : null].filter(Boolean).join(" · ")}</p> : null}
          <Thumbnails organisationId={organisationId} files={data.files as PickedFile[]} />
          <SafetyHistory organisationId={organisationId} recordId={application.recordId} paddockNames={names} />
        </div>
      ) : null}
    </li>
  );
}

// Starting a run ------------------------------------------------------------------------------------------

function StartForm({ organisationId, farm, log, paddocks, onDone, onCancel }: Ctx & { log: EffluentLog; paddocks: Paddock[]; onDone: (text: string) => void; onCancel: () => void }) {
  const systems = log.setup.systems.filter((system) => system.change !== "withdrawn" && !system.data.retired);
  const { queue } = useOfflineQueue(organisationId);
  const [operationId] = useState(newOperationId);
  const [form, setForm] = useState({ systemId: systems[0]?.recordId ?? "", blockId: "", paddockId: "", label: "", startedAt: nowLocal(), finished: false, stoppedAt: nowLocal(), depthEnteredMm: "", loads: "", areaHa: "", ponding: "none" as PondingResult, pondingNote: "", weather: "", soil: "" });
  const [point, setPoint] = useState<Position | null>(null);
  const [locating, setLocating] = useState<string | null>(null);
  const [photos, setPhotos] = useState<PickedFile[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const system = systems.find((each) => each.recordId === form.systemId);
  const tanker = system?.data.type === "slurry_tanker";
  // A tanker or spreader run driven in tractor mode (decision 1099d): its paddocks, times and worked area come from the job.
  const jobs = useApiData<{ jobs: TractorJobListItem[] }>(tanker ? "/api/farming/tractor/jobs" : null, { organisationId, farmId: farm.id, limit: 20 });
  const [jobId, setJobId] = useState("");
  const usedJobs = new Set(log.applications.map((application) => application.data.tractorJobId).filter(Boolean));
  const effluentJobs = (jobs.data?.jobs ?? []).filter((job) => job.status === "active" && (job.operation === "effluent" || job.operation === "spreading") && !usedJobs.has(job.id));
  const job = effluentJobs.find((each) => each.id === jobId) ?? null;
  const set = (patch: Partial<typeof form>) => setForm({ ...form, ...patch });
  if (!systems.length) return <Notice tone="info">No effluent systems on {farm.name} yet. An owner or admin adds them under Systems, map and consent.</Notice>;
  const blocks = log.setup.blocks.filter((block) => block.change !== "withdrawn" && !block.data.retired);
  const submit = async () => {
    setBusy(true);
    setError(null);
    const startedAt = job ? job.startedAt : toIso(form.startedAt);
    const body: Record<string, unknown> = {
      tractorJobId: job?.id ?? null,
      farmId: farm.id,
      systemId: form.systemId,
      blockId: form.blockId || null,
      paddockIds: job ? job.paddockIds : form.paddockId ? [form.paddockId] : [],
      startedAt,
      stoppedAt: job ? job.finishedAt : form.finished || tanker ? toIso(form.stoppedAt) : null,
      positions: tanker ? [] : [{ label: form.label || null, paddockId: form.paddockId || null, point, movedAt: startedAt }],
      depthEnteredMm: form.depthEnteredMm || null,
      loads: tanker ? form.loads || null : null,
      areaHa: tanker ? form.areaHa || (job ? job.workedHa : null) : null,
      ponding: form.finished || tanker ? { result: form.ponding, note: form.pondingNote || null, checkedAt: new Date().toISOString() } : null,
      weather: form.weather || null,
      soil: form.soil || null,
      files: photos.map((photo) => ({ id: photo.id })),
    };
    try {
      const outcome = await submitThroughQueue(queue, { operationId, kind: "effluent.application", label: `${system?.data.name ?? "Effluent"}: ${form.finished || tanker ? "run" : "started"} ${time(startedAt)}`, farmId: farm.id, farmName: farm.name, meta: { systemId: form.systemId, systemName: system?.data.name, startedAt }, request: { method: "POST", path: "/api/farming/effluent/applications", body, refs: waitForFiles(photos, ["files"]) } });
      onDone(`${outcomeText(outcome.state)}${form.ponding !== "none" ? " Ponding or runoff: record it as an incident too, and check your consent about telling the council. Tohyee doesn't tell them." : ""}`);
    } catch (caught) {
      setError(`Not saved: ${errorMessage(caught)}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title="A run">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
        aria-label="Record an effluent run"
      >
        {error ? <Notice tone="error">{error}</Notice> : null}
        {system && !system.available ? <Notice tone="warning">{system.data.name} is out of use in Safety: {system.outOfUseBecause}. It can&apos;t be recorded running until someone allowed releases it in Safety.</Notice> : null}
        <Field label="System">
          <select value={form.systemId} onChange={(event) => set({ systemId: event.target.value })}>
            {systems.map((each) => (
              <option key={each.recordId} value={each.recordId}>
                {each.data.name} ({SYSTEM_TYPE_LABELS[each.data.type]})
              </option>
            ))}
          </select>
        </Field>
        <div className={ui.inlineForm}>
          {blocks.length ? (
            <Field label="Block">
              <select value={form.blockId} onChange={(event) => set({ blockId: event.target.value })}>
                <option value="">Not said</option>
                {blocks.map((block) => (
                  <option key={block.recordId} value={block.recordId}>
                    {block.data.name}
                  </option>
                ))}
              </select>
            </Field>
          ) : null}
          <Field label="Paddock">
            <select value={form.paddockId} onChange={(event) => set({ paddockId: event.target.value })}>
              <option value="">Not said</option>
              {paddocks.map((paddock) => (
                <option key={paddock.id} value={paddock.id}>
                  {paddock.name}
                </option>
              ))}
            </select>
          </Field>
          {!tanker ? (
            <Field label="Run or line" hint="As on the run sheet, e.g. Line 3.">
              <input value={form.label} maxLength={60} onChange={(event) => set({ label: event.target.value })} />
            </Field>
          ) : null}
        </div>
        {!tanker ? (
          <div className={ui.actions} style={{ justifyContent: "flex-start" }}>
            <Button
              variant="secondary"
              onClick={async () => {
                setLocating("Finding where you are…");
                const found = await where();
                setPoint(found);
                setLocating(found ? "Where you are is marked as the position." : "The location wasn't shared.");
              }}
            >
              Use where I am for the position
            </Button>
            {locating ? <span className={ui.muted}>{locating}</span> : null}
          </div>
        ) : null}
        {tanker ? (
          <>
            <Field label="From tractor mode" hint="Drive the run in tractor mode (operation: Effluent) for its coverage on the map; its paddocks, times and worked area then come from the job.">
              <select value={jobId} onChange={(event) => setJobId(event.target.value)}>
                <option value="">Not from tractor mode: I&apos;ll enter it</option>
                {effluentJobs.map((each) => (
                  <option key={each.id} value={each.id}>
                    {time(each.startedAt)} · {each.paddockNames.join(", ") || "no paddock"} · {each.workedHa} ha
                  </option>
                ))}
              </select>
            </Field>
            <p className={ui.muted} style={{ marginTop: 0 }}>
              <Link href={`/operations/farm/tractor?farm=${farm.id}`}>Open tractor mode</Link>
            </p>
          </>
        ) : null}
        {job ? (
          <p>
            {time(job.startedAt)} to {time(job.finishedAt)} · {job.paddockNames.join(", ") || "no paddock"} · about {job.workedHa} ha worked (a phone GPS estimate)
          </p>
        ) : null}
        {!job ? (
          <Field label="Started">
            <input type="datetime-local" value={form.startedAt} max={nowLocal()} required onChange={(event) => set({ startedAt: event.target.value })} />
          </Field>
        ) : null}
        {!tanker ? (
          <label className={ui.checkbox} style={{ minHeight: 44 }}>
            <input type="checkbox" checked={form.finished} onChange={(event) => set({ finished: event.target.checked })} /> It&apos;s already finished
          </label>
        ) : null}
        {form.finished || tanker ? (
          <>
            {!job ? (
              <Field label="Stopped">
                <input type="datetime-local" value={form.stoppedAt} max={nowLocal()} required onChange={(event) => set({ stoppedAt: event.target.value })} />
              </Field>
            ) : null}
            {tanker ? (
              <div className={ui.inlineForm}>
                <Field label="Loads">
                  <input inputMode="numeric" value={form.loads} onChange={(event) => set({ loads: event.target.value })} />
                </Field>
                <Field label="Area they went on (ha)" hint={job ? `Empty: the job's ${job.workedHa} ha.` : undefined}>
                  <input inputMode="decimal" value={form.areaHa} onChange={(event) => set({ areaHa: event.target.value })} />
                </Field>
              </div>
            ) : null}
            <PondingFields value={form.ponding} note={form.pondingNote} onChange={(ponding, pondingNote) => set({ ponding, pondingNote })} />
          </>
        ) : null}
        <Field label="Depth (mm), if you measured it" hint="As entered. Tohyee also works it out from the system's settings, and shows both.">
          <input inputMode="decimal" value={form.depthEnteredMm} onChange={(event) => set({ depthEnteredMm: event.target.value })} />
        </Field>
        <div className={ui.inlineForm}>
          <Field label="Weather">
            <input value={form.weather} maxLength={500} onChange={(event) => set({ weather: event.target.value })} placeholder="e.g. Fine, light westerly" />
          </Field>
          <Field label="Soil">
            <input value={form.soil} maxLength={500} onChange={(event) => set({ soil: event.target.value })} placeholder="e.g. Boot print dry; probe 28%" />
          </Field>
        </div>
        <PhotoPicker organisationId={organisationId} farmId={farm.id} farmName={farm.name} files={photos} onChange={setPhotos} label="Photos (the pods, irrigator or paddock)" />
        <div className={ui.actions}>
          <Button type="submit" disabled={busy || !form.systemId}>
            {form.finished || tanker ? "Save the run" : "Start"}
          </Button>
          <Button variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </form>
    </Card>
  );
}

function PondingFields({ value, note, onChange }: { value: PondingResult; note: string; onChange: (value: PondingResult, note: string) => void }) {
  return (
    <fieldset style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 10, margin: "8px 0" }}>
      <legend className={ui.fieldLabel}>Ponding and runoff check</legend>
      {PONDING_RESULTS.map((result) => (
        <label key={result} className={ui.checkbox} style={{ minHeight: 40 }}>
          <input type="radio" name="ponding" checked={value === result} onChange={() => onChange(result, note)} /> {PONDING_LABELS[result]}
        </label>
      ))}
      {value !== "none" ? (
        <Field label="What was seen, and what was done">
          <textarea rows={2} value={note} required maxLength={1000} onChange={(event) => onChange(value, event.target.value)} />
        </Field>
      ) : null}
    </fieldset>
  );
}

// Running runs: shift and stop -------------------------------------------------------------------------

type RunningRun = { key: string; recordId: string | null; operationId: string | null; systemId: string; systemName: string; startedAt: string; version: number; pending: boolean };

function RunningCard({ organisationId, farm, log, running, paddocks, canLog, onSaved }: Ctx & { log: EffluentLog; running: ApplicationView[]; paddocks: Paddock[]; canLog: boolean; onSaved: (text: string) => void }) {
  const { queue, items } = useOfflineQueue(organisationId);
  const fromServer: RunningRun[] = running.map((run) => ({ key: run.recordId, recordId: run.recordId, operationId: null, systemId: run.data.systemId, systemName: log.setup.systems.find((system) => system.recordId === run.data.systemId)?.data.name ?? "System", startedAt: run.data.startedAt, version: run.version, pending: false }));
  const onDevice: RunningRun[] = pendingRuns(items, farm.id)
    .filter((item) => !(item.request.body as { stoppedAt?: unknown }).stoppedAt)
    .map((item) => ({ key: item.operationId, recordId: null, operationId: item.operationId, systemId: String(item.meta.systemId ?? ""), systemName: String(item.meta.systemName ?? "System"), startedAt: String(item.meta.startedAt ?? item.createdAt), version: 1, pending: true }));
  const all = [...onDevice, ...fromServer].map((run) => ({ ...run, queued: queuedChanges(items, run.key) })).filter((run) => !run.queued.some((item) => item.meta.step === "stop"));
  const [acting, setActing] = useState<{ run: string; step: "shift" | "stop" } | null>(null);
  // When the card was shown: "Due" compares with this, so it doesn't change while someone reads it.
  const [now] = useState(() => Date.now());
  return (
    <Card title={`Running now (${all.length})`} description="Shift the pods or irrigator, or stop with the ponding and runoff check.">
      {!all.length ? <p className={ui.muted}>Nothing running.</p> : null}
      <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
        {all.map((run) => {
          const moved = log.lastMoved.find((each) => each.applicationId === run.recordId);
          return (
            <li key={run.key} style={{ borderTop: "1px solid var(--border)", padding: "10px 0" }}>
              <strong>{run.systemName}</strong> <span className={ui.muted}>started {time(run.startedAt)}</span> {run.pending ? <Badge tone="amber">On this device</Badge> : null}
              {moved ? (
                <div>
                  Last moved {time(moved.movedAt)}
                  {moved.shiftDue ? (
                    <>
                      {" "}
                      · shift due {time(moved.shiftDue)} {Date.parse(moved.shiftDue) < now ? <Badge tone="amber">Due</Badge> : null}
                    </>
                  ) : null}
                </div>
              ) : null}
              {run.queued.length ? <div className={ui.muted}>{run.queued.length} change{run.queued.length === 1 ? "" : "s"} on this device, waiting to send.</div> : null}
              {canLog ? (
                <div className={ui.actions} style={{ justifyContent: "flex-start" }}>
                  <Button variant="secondary" onClick={() => setActing({ run: run.key, step: "shift" })}>
                    Shifted
                  </Button>
                  <Button onClick={() => setActing({ run: run.key, step: "stop" })}>Stopped</Button>
                </div>
              ) : null}
              {acting?.run === run.key ? (
                <ChangeForm
                  step={acting.step}
                  paddocks={paddocks}
                  onCancel={() => setActing(null)}
                  onSubmit={async (body, label) => {
                    const expectedVersion = run.version + run.queued.length;
                    const refs = run.recordId ? [] : [{ path: ["recordId"], from: run.operationId!, field: ["record", "recordId"] }];
                    const outcome = await submitThroughQueue(queue, { operationId: newOperationId(), kind: "effluent.application.change", label: `${run.systemName}: ${label}`, farmId: farm.id, farmName: farm.name, meta: { run: run.key, step: acting.step }, request: { method: "POST", path: "/api/farming/effluent/applications/changes", body: { ...body, recordId: run.recordId, expectedVersion }, refs } });
                    setActing(null);
                    onSaved(outcomeText(outcome.state));
                  }}
                />
              ) : null}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

function ChangeForm({ step, paddocks, onSubmit, onCancel }: { step: "shift" | "stop"; paddocks: Paddock[]; onSubmit: (body: Record<string, unknown>, label: string) => Promise<void>; onCancel: () => void }) {
  const [at, setAt] = useState(nowLocal());
  const [paddockId, setPaddockId] = useState("");
  const [label, setLabel] = useState("");
  const [point, setPoint] = useState<Position | null>(null);
  const [ponding, setPonding] = useState<{ result: PondingResult; note: string }>({ result: "none", note: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      style={{ margin: "8px 0", padding: 10, border: "1px solid var(--border)", borderRadius: 8 }}
      aria-label={step === "shift" ? "Shifted" : "Stopped"}
      onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true);
        setError(null);
        try {
          const iso = toIso(at);
          await onSubmit(
            step === "shift" ? { step, position: { label: label || null, paddockId: paddockId || null, point, movedAt: iso } } : { step, stoppedAt: iso, ponding: { result: ponding.result, note: ponding.note || null, checkedAt: new Date().toISOString() } },
            step === "shift" ? `shifted ${time(iso)}` : `stopped ${time(iso)}`,
          );
        } catch (caught) {
          setError(`Not saved: ${errorMessage(caught)}`);
        } finally {
          setBusy(false);
        }
      }}
    >
      {error ? <Notice tone="error">{error}</Notice> : null}
      <Field label={step === "shift" ? "Moved at" : "Stopped at"}>
        <input type="datetime-local" value={at} max={nowLocal()} required onChange={(event) => setAt(event.target.value)} />
      </Field>
      {step === "shift" ? (
        <>
          <div className={ui.inlineForm}>
            <Field label="Paddock">
              <select value={paddockId} onChange={(event) => setPaddockId(event.target.value)}>
                <option value="">Not said</option>
                {paddocks.map((paddock) => (
                  <option key={paddock.id} value={paddock.id}>
                    {paddock.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Run or line">
              <input value={label} maxLength={60} onChange={(event) => setLabel(event.target.value)} />
            </Field>
          </div>
          <Button variant="secondary" onClick={async () => setPoint(await where())}>
            {point ? "Where I am: marked" : "Use where I am"}
          </Button>
        </>
      ) : (
        <PondingFields value={ponding.result} note={ponding.note} onChange={(result, note) => setPonding({ result, note })} />
      )}
      <div className={ui.actions}>
        <Button type="submit" disabled={busy}>
          Save
        </Button>
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

// Not applied today --------------------------------------------------------------------------------------

function DeferralCard({ organisationId, farm, log, onSaved }: Ctx & { log: EffluentLog; onSaved: (text: string) => void }) {
  const { queue } = useOfflineQueue(organisationId);
  const [reason, setReason] = useState<DeferralReason>("too_wet");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [operationId, setOperationId] = useState(newOperationId);
  return (
    <Card title="Not applied today" description="Deferred irrigation: say why effluent was stored instead. DairyNZ suggests recording the days you didn't irrigate.">
      {log.setup.access.canLog ? (
        <form
          onSubmit={async (event) => {
            event.preventDefault();
            setBusy(true);
            setError(null);
            try {
              const outcome = await submitThroughQueue(queue, { operationId, kind: "effluent.deferral", label: `Not applied: ${DEFERRAL_LABELS[reason]}`, farmId: farm.id, farmName: farm.name, request: { method: "POST", path: "/api/farming/effluent/deferrals", body: { farmId: farm.id, reason, note: note || null } } });
              setNote("");
              setOperationId(newOperationId());
              onSaved(outcomeText(outcome.state));
            } catch (caught) {
              setError(`Not saved: ${errorMessage(caught)}`);
            } finally {
              setBusy(false);
            }
          }}
        >
          {error ? <Notice tone="error">{error}</Notice> : null}
          <Field label="Why">
            <select value={reason} onChange={(event) => setReason(event.target.value as DeferralReason)}>
              {DEFERRAL_REASONS.map((each) => (
                <option key={each} value={each}>
                  {DEFERRAL_LABELS[each]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Note">
            <input value={note} maxLength={1000} required={reason === "other"} onChange={(event) => setNote(event.target.value)} placeholder="e.g. 18 mm overnight, boot prints filling" />
          </Field>
          <Button type="submit" disabled={busy}>
            Save for today
          </Button>
        </form>
      ) : null}
      {log.deferrals.length ? (
        <ul style={{ margin: "8px 0 0", paddingLeft: 18 }}>
          {log.deferrals.slice(0, 10).map((deferral) => (
            <li key={deferral.recordId}>
              <strong>{formatDate(deferral.data.on)}</strong> {DEFERRAL_LABELS[deferral.data.reason]}
              {deferral.data.note ? `: ${deferral.data.note}` : ""}
              {deferral.change === "withdrawn" ? " (withdrawn)" : ""}
            </li>
          ))}
        </ul>
      ) : null}
    </Card>
  );
}

// Ponds screen ------------------------------------------------------------------------------------------

export function PondsScreen({ organisationId, farm }: Ctx) {
  const log = useEffluentLog(organisationId, farm.id);
  const [done, setDone] = useState<string | null>(null);
  if (log.error) return <Notice tone="error">{log.error}</Notice>;
  if (!log.data) return <p className={ui.muted}>Loading…</p>;
  const data = log.data;
  return (
    <div className={styles.overview}>
      <div className={styles.column}>
        {done ? <Notice tone="success">{done}</Notice> : null}
        <QueuedWork organisationId={organisationId} farmId={farm.id} kinds={["effluent.pond", "effluent.deferral"]} title="Pond readings on this device" onSynced={log.reload} />
        {!data.ponds.length ? <Empty>No ponds or sumps yet. An owner or admin adds them under Systems, map and consent.</Empty> : null}
        {data.ponds.map((pond) => (
          <PondCard key={pond.recordId} organisationId={organisationId} farm={farm} pond={pond} canLog={data.setup.access.canLog} onSaved={(text) => { setDone(text); log.reload(); }} />
        ))}
      </div>
      <div className={styles.column}>
        <DeferralCard organisationId={organisationId} farm={farm} log={data} onSaved={(text) => { setDone(text); log.reload(); }} />
        <Card title="Readings, last 30 days">
          {!data.readings.length ? <Empty>No readings in the last 30 days.</Empty> : null}
          <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {data.readings.map((reading) => (
              <li key={reading.recordId} style={{ borderTop: "1px solid var(--border)", padding: "8px 0" }}>
                <strong>{data.ponds.find((pond) => pond.recordId === reading.data.pondId)?.data.name ?? "Pond"}</strong> {reading.data.levelMm} mm <span className={ui.muted}>{time(reading.data.readAt)}</span> {reading.state?.warning === "high" ? <Badge tone="red">High</Badge> : reading.state?.warning === "low" ? <Badge tone="amber">Low</Badge> : null}
                {reading.change === "withdrawn" ? <Badge>Withdrawn</Badge> : null}
                {reading.data.note ? <div>{reading.data.note}</div> : null}
                <Thumbnails organisationId={organisationId} files={reading.data.files as PickedFile[]} />
                <div className={ui.muted} style={{ fontSize: "var(--text-sm)" }}>
                  Entered {formatDateTime(reading.enteredAt)} by {reading.enteredByName || reading.enteredByEmail}
                </div>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </div>
  );
}

function PondCard({ organisationId, farm, pond, canLog, onSaved }: Ctx & { pond: PondView; canLog: boolean; onSaved: (text: string) => void }) {
  const { queue } = useOfflineQueue(organisationId);
  const [levelMm, setLevelMm] = useState("");
  const [note, setNote] = useState("");
  const [photos, setPhotos] = useState<PickedFile[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [operationId, setOperationId] = useState(newOperationId);
  const state = pond.latest?.state ?? null;
  return (
    <Card title={pond.data.name} description={`Holds ${pond.data.capacityM3} m³${pond.data.markers.length ? ` · gauge marks ${pond.data.markers.map((marker) => `${marker.label} ${marker.mm} mm`).join(", ")}` : ""}`}>
      {pond.latest ? (
        <>
          <p style={{ margin: "0 0 6px" }}>
            <strong>{pond.latest.data.levelMm} mm</strong>
            {state?.percentFull ? ` · about ${state.percentFull}% full` : ""}
            {state?.mark ? ` · at or above ${state.mark}` : ""} <span className={ui.muted}>{time(pond.latest.data.readAt)}</span>{" "}
            {state?.warning === "high" ? <Badge tone="red">High</Badge> : state?.warning === "low" ? <Badge tone="amber">Low</Badge> : null} {!pond.readToday ? <Badge tone="amber">Not read today</Badge> : null}
          </p>
          {state?.storageLeftM3 ? (
            <p className={ui.muted} style={{ marginTop: 0 }}>
              About {state.storageLeftM3} m³ of storage left{state.daysLeft ? `: about ${state.daysLeft} days at ${pond.data.dailyInflowM3} m³ a day` : ""}. Worked out as if the pond&apos;s sides were straight, so it&apos;s a guide.
            </p>
          ) : null}
          {state?.warning === "high" ? <Notice tone="warning">At or above the high warning. Irrigate when the soil can take it, or stop more going in; check your consent about full ponds.</Notice> : null}
        </>
      ) : (
        <p>No reading yet.</p>
      )}
      {canLog ? (
        <form
          aria-label={`Read ${pond.data.name}`}
          onSubmit={async (event) => {
            event.preventDefault();
            setBusy(true);
            setError(null);
            try {
              const outcome = await submitThroughQueue(queue, { operationId, kind: "effluent.pond_reading", label: `${pond.data.name}: ${levelMm} mm`, farmId: farm.id, farmName: farm.name, request: { method: "POST", path: "/api/farming/effluent/pond-readings", body: { farmId: farm.id, pondId: pond.recordId, levelMm, readAt: new Date().toISOString(), note: note || null, files: photos.map((photo) => ({ id: photo.id })) }, refs: waitForFiles(photos, ["files"]) } });
              setLevelMm("");
              setNote("");
              setPhotos([]);
              setOperationId(newOperationId());
              onSaved(outcomeText(outcome.state));
            } catch (caught) {
              setError(`Not saved: ${errorMessage(caught)}`);
            } finally {
              setBusy(false);
            }
          }}
        >
          {error ? <Notice tone="error">{error}</Notice> : null}
          <div className={ui.inlineForm}>
            <Field label="Level on the gauge (mm)">
              <input inputMode="numeric" value={levelMm} required onChange={(event) => setLevelMm(event.target.value)} />
            </Field>
            <Field label="Note">
              <input value={note} maxLength={1000} onChange={(event) => setNote(event.target.value)} placeholder="e.g. Before milking" />
            </Field>
          </div>
          <PhotoPicker organisationId={organisationId} farmId={farm.id} farmName={farm.name} files={photos} onChange={setPhotos} label="Photo of the gauge" />
          <Button type="submit" disabled={busy || !levelMm.trim()}>
            Save the reading
          </Button>
        </form>
      ) : null}
    </Card>
  );
}

// Log tab buttons ---------------------------------------------------------------------------------------

/** Effluent's quick entries on the Log tab (decision 1070), shown only on a farm with an effluent system. */
export function EffluentLogButtons({ organisationId, farm, buttonClass, itemClass }: Ctx & { buttonClass: string; itemClass: string }) {
  const setup = useEffluentSetup(organisationId, farm.id);
  if (!setup.data?.systems.some((system) => system.change !== "withdrawn" && !system.data.retired)) return null;
  return (
    <>
      <h3>Effluent</h3>
      <div className={buttonClass}>
        <Link className={itemClass} href={effluentHref({ farmId: farm.id, screen: "log" })}>
          Irrigation
          <small>Start, shift or stop a run</small>
        </Link>
        <Link className={itemClass} href={effluentHref({ farmId: farm.id, screen: "ponds" })}>
          Pond level
          <small>Read the gauge, or not applied today</small>
        </Link>
      </div>
    </>
  );
}
