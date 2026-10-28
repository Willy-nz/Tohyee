"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useConfirm } from "@/components/confirm-dialog";
import type { FarmContext } from "@/components/farm-workspace";
import { useCanRecordFarmWork } from "@/components/farm-selector";
import { useApiData } from "@/components/hooks";
import { useOfflineQueue } from "@/components/offline-queue";
import { useOnline } from "@/components/offline-support";
import { TractorLegend, TractorMap } from "@/components/tractor-map";
import { Badge, Button, Card, Empty, Field, Notice, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { api, errorMessage, offlineServedSnapshot } from "@/lib/client/api";
import { computeCoverage, type CoverageResult, gpsQuality, THRESHOLDS, type TrackPoint } from "@/lib/farming/coverage";
import type { FarmingSettings, Paddock } from "@/lib/farming/paddocks";
import {
  finish as finishRecorder,
  onFix,
  onPermissionDenied,
  onTick,
  onVisibility,
  pause,
  reopenRecorder,
  resume,
  setSettings,
  setWorking,
  startRecorder,
  type Step,
  statusBanner,
} from "@/lib/farming/tractor-recorder";
import {
  distanceText,
  durationText,
  EQUIPMENT_KIND_LABELS,
  EQUIPMENT_KINDS,
  type EquipmentKind,
  EVENT_LABELS,
  hectares,
  type JobSettings,
  OPERATION_LABELS,
  type Operation,
  OPERATIONS,
  paddockLabel,
  QUANTITY_UNITS,
  RATE_UNITS,
  TRACTOR_NOTICE,
  type TractorEquipment,
  type TractorJob,
  type TractorJobListItem,
} from "@/lib/farming/tractor-shared";
import { hazardNote, hazardsForMap, type PackHazards, SEND_STATE_LABELS, sendState, shownHazards, TRACTOR_QUEUE_KIND, tractorQueueItem } from "@/lib/farming/tractor-queue";
import { forgetSent, localJobs, localPoints, type LocalJob, removeLocal, saveLocal, tractorStoreAvailable } from "@/lib/farming/tractor-store";
import { answerOffline } from "@/lib/offline/packs";
import type { OfflineQueue, QueueItem } from "@/lib/offline/queue";
import type { CurrentRecord, HazardData } from "@/lib/safety/shared";
import styles from "./tractor.module.css";

/*
 * Tractor and spreader mode (#472 stage 5, decisions 1020-1027): choose the
 * farm and paddocks (or none: "Unassigned paddock"), the equipment and its
 * width, Start, switch Working ON and OFF, Pause and Resume, Finish, check
 * and send. Recording happens only while Tohyee is on screen (Jess, 28
 * October 2026: the phone is mounted and kept awake); the screen says so
 * plainly whenever it isn't recording.
 */

const NATURAL = new Intl.Collator("en-NZ", { numeric: true, sensitivity: "base" });

function useImageryKey(organisationId: string) {
  return useApiData<{ settings: FarmingSettings }>("/api/farming/settings", { organisationId }).data?.settings.imageryKey ?? null;
}

function newId(): string {
  // randomUUID needs a secure page (HTTPS or localhost); getRandomValues works everywhere.
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function settingsText(settings: { widthM: number | string; lateralM: number | string; backM: number | string }): string {
  const lateral = Number(settings.lateralM);
  const back = Number(settings.backM);
  const parts = [`${Number(settings.widthM)} m wide`];
  if (back) parts.push(`${Math.abs(back)} m ${back > 0 ? "behind" : "in front of"} the phone`);
  if (lateral) parts.push(`${Math.abs(lateral)} m to the ${lateral > 0 ? "right" : "left"}`);
  return parts.join(", ");
}

/** The phone's clock (outside render). */
function clockNow(): number {
  return Date.now();
}

// Sending ---------------------------------------------------------------------------------------------------

/**
 * Hands a finished job to the device's queue (decision 1028), which sends
 * it once, by the job's id, whenever Tohyee can be reached. The track stays
 * in tractor mode's own store until Tohyee has it.
 */
async function handOver(queue: OfflineQueue, job: LocalJob): Promise<LocalJob> {
  const points = await localPoints(job.id);
  const { stored } = await queue.add(tractorQueueItem(job, points));
  // Not stored: only this page has it (the device's storage refused it); the job stays "finished" and is handed over again.
  return stored ? saveLocal({ ...job, state: "queued", problem: null }) : job;
}

/** The farm's hazards from its offline copy on this device, read again when the connection changes (decision 1030). */
function usePackHazards(job: Pick<LocalJob, "organisationId" | "userId" | "farmId">, online: boolean): PackHazards | null {
  const [pack, setPack] = useState<PackHazards | null>(null);
  useEffect(() => {
    let cancelled = false;
    answerOffline({ server: window.location.origin, userId: job.userId, organisationId: job.organisationId }, "/api/farming/safety", { farmId: job.farmId }).then(
      (answer) => {
        if (cancelled || !answer.found) return;
        const body = answer.body as { hazards?: Array<CurrentRecord<HazardData>> };
        setPack({ hazards: hazardsForMap(body.hazards ?? []), savedAt: answer.savedAt });
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [job.organisationId, job.userId, job.farmId, online]);
  return pack;
}

// The tractor page ------------------------------------------------------------------------------------------

export function TractorHome({ organisationId, farm }: FarmContext) {
  const { user } = useWorkspace();
  const scope = `${organisationId}:${user.id}`;
  const canRecord = useCanRecordFarmWork();
  const imageryKey = useImageryKey(organisationId);
  const [jobs, setJobs] = useState<LocalJob[] | null>(null);
  const [storageProblem, setStorageProblem] = useState<string | null>(null);
  const [driving, setDriving] = useState<LocalJob | null>(null);
  const { queue, items, problem: queueProblem } = useOfflineQueue(organisationId);
  const confirm = useConfirm();
  const server = useApiData<{ jobs: TractorJobListItem[] }>("/api/farming/tractor/jobs", { organisationId, farmId: farm.id });
  const reloadServer = server.reload;

  const refresh = useCallback(async () => {
    if (!tractorStoreAvailable()) {
      setStorageProblem("This browser can't keep jobs on the device, so tractor mode can't be used here.");
      setJobs([]);
      return;
    }
    try {
      await forgetSent(scope, Date.now() - 7 * 86_400_000);
      setJobs(await localJobs(scope));
    } catch (error) {
      setStorageProblem(`This device's storage isn't working: ${errorMessage(error)}`);
      setJobs([]);
    }
  }, [scope]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loading from the device's storage once
    void refresh();
  }, [refresh]);

  // Finished jobs go to the queue; jobs the queue has sent are marked sent. The queue sends them (OfflineSupport, or Send now).
  const drivingId = driving?.id ?? null;
  const tractorItems = useMemo(() => items.filter((item) => item.kind === TRACTOR_QUEUE_KIND), [items]);
  // Jobs this page has handed over; one the device's storage refused isn't handed over again and again.
  const handedOver = useRef(new Set<string>());
  const syncedIds = tractorItems.filter((item) => item.status === "synced").map((item) => item.operationId).join(",");
  useEffect(() => {
    if (!queue || !jobs) return;
    const synced = new Set(syncedIds.split(",").filter(Boolean));
    const toHandOver = jobs.filter((job) => job.id !== drivingId && !handedOver.current.has(job.id) && (job.state === "finished" || job.state === "sending" || job.state === "needs_attention"));
    const toMarkSent = jobs.filter((job) => job.state !== "sent" && job.state !== "recording" && synced.has(job.id));
    if (!toHandOver.length && !toMarkSent.length) return;
    let cancelled = false;
    void (async () => {
      try {
        for (const job of toMarkSent) await saveLocal({ ...job, state: "sent", sentAt: Date.now(), problem: null });
        for (const job of toHandOver) {
          handedOver.current.add(job.id);
          if (!synced.has(job.id)) await handOver(queue, job);
        }
      } catch (error) {
        if (!cancelled) setStorageProblem(`This device's storage isn't working: ${errorMessage(error)}`);
      }
      if (cancelled) return;
      await refresh();
      if (toMarkSent.length) reloadServer();
      if (toHandOver.length && navigator.onLine) void queue.sync();
    })();
    return () => {
      cancelled = true;
    };
  }, [queue, jobs, syncedIds, drivingId, refresh, reloadServer]);

  if (driving) {
    return (
      <TractorDrive
        initial={driving}
        imageryKey={imageryKey}
        onClose={async (sent) => {
          setDriving(null);
          await refresh();
          if (sent) reloadServer();
        }}
      />
    );
  }

  const here = (jobs ?? []).filter((job) => job.farmId === farm.id);
  const unfinished = here.filter((job) => job.state === "recording");
  const waiting = here.filter((job) => job.state !== "recording" && job.state !== "sent");
  const itemFor = (job: LocalJob): QueueItem | undefined => tractorItems.find((item) => item.operationId === job.id);
  return (
    <div className={styles.home}>
      <Notice tone="info">{TRACTOR_NOTICE} Recording only happens while Tohyee is on screen: mount the phone and keep the screen on.</Notice>
      {storageProblem ? <Notice tone="error">{storageProblem}</Notice> : null}
      {queueProblem ? <Notice tone="error">{queueProblem}</Notice> : null}
      {unfinished.map((job) => (
        <Card key={job.id} title="A job isn't finished" description={`${OPERATION_LABELS[job.operation]} · ${paddockLabel(job.paddockNames)} · started ${new Date(job.startedAt).toLocaleString("en-NZ")}`}>
          <p>Tohyee stopped while this job was recording (the app closed, the phone restarted or the page reloaded). What was recorded is safe on this device. The time it was stopped is a gap.</p>
          <div className={styles.row}>
            <Button onClick={() => setDriving(job)}>Carry on</Button>
          </div>
        </Card>
      ))}
      {waiting.length ? (
        <Card title="On this device" description="Finished jobs stay here until Tohyee has them. They're sent with the rest of the work on this device, whenever Tohyee can be reached.">
          <ul className={styles.list}>
            {waiting.map((job) => {
              const item = itemFor(job);
              const state = sendState(job, item, item && queue ? queue.shownStatus(item) : undefined);
              const stuck = state.status === "attention" || state.status === "let_go";
              return (
                <li key={job.id}>
                  <div>
                    <strong>{OPERATION_LABELS[job.operation]}</strong> · {paddockLabel(job.paddockNames)} · {new Date(job.startedAt).toLocaleString("en-NZ")}
                    <div>
                      <Badge tone={stuck || state.status === "unsaved" ? "red" : state.status === "synced" ? "green" : "amber"}>{SEND_STATE_LABELS[state.status]}</Badge>
                    </div>
                    {state.problem ? <p className={ui.muted}>{state.status === "attention" ? `Tohyee said: ${state.problem}` : state.problem}</p> : null}
                  </div>
                  <div className={styles.row}>
                    {stuck && queue ? (
                      <Button
                        variant="secondary"
                        onClick={async () => {
                          if (item) await queue.dismiss(item.operationId);
                          await handOver(queue, { ...job, state: "finished" });
                          await refresh();
                          if (navigator.onLine) await queue.sync();
                        }}
                      >
                        Send again
                      </Button>
                    ) : null}
                    {!stuck && queue && item?.status === "waiting" ? (
                      <Button variant="secondary" onClick={() => void queue.sync()}>
                        Send now
                      </Button>
                    ) : null}
                    {stuck && queue ? (
                      <Button
                        variant="secondary"
                        onClick={async () => {
                          if (!(await confirm("The job and its track are removed from this device. Tohyee hasn't got it, so it will be lost.", { title: "Remove this job?", confirmLabel: "Remove", danger: true }))) return;
                          if (item) await queue.dismiss(item.operationId);
                          await removeLocal(job.id);
                          await refresh();
                        }}
                      >
                        Remove from this device
                      </Button>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        </Card>
      ) : null}
      {canRecord && jobs && !storageProblem ? (
        <TractorSetup
          organisationId={organisationId}
          farm={farm}
          userId={user.id}
          onStart={async (job) => {
            setDriving(job);
          }}
        />
      ) : null}
      {!canRecord ? <Notice tone="info">Recording tractor jobs needs the farm staff or bookkeeper role. You can look at jobs below.</Notice> : null}
      <Card title="Jobs on the server" description={`${farm.name}. Open one to see its map, numbers and exports.`}>
        {server.error ? <Notice tone="error">{server.error}</Notice> : null}
        {!server.data ? <p className={ui.muted}>Loading…</p> : null}
        {server.data && server.data.jobs.length === 0 ? <Empty>No tractor jobs yet.</Empty> : null}
        {server.data?.jobs.length ? (
          <ul className={styles.list}>
            {server.data.jobs.map((job) => (
              <li key={job.id}>
                <Link href={`/operations/farm/tractor/${job.id}?farm=${job.farmId}`}>
                  <strong>{OPERATION_LABELS[job.operation]}</strong> · {paddockLabel(job.paddockNames)} · {new Date(job.startedAt).toLocaleString("en-NZ", { dateStyle: "medium", timeStyle: "short" })}
                </Link>
                <span>
                  {hectares(job.workedHa)} worked (est.){job.status === "withdrawn" ? <Badge>Withdrawn</Badge> : null}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </Card>
    </div>
  );
}

// Setting up a job -------------------------------------------------------------------------------------------

function TractorSetup({ organisationId, farm, userId, onStart }: { organisationId: string; farm: FarmContext["farm"]; userId: string; onStart: (job: LocalJob) => void }) {
  const paddocks = useApiData<{ paddocks: Paddock[] }>(`/api/farming/farms/${farm.id}/paddocks`, { organisationId });
  const equipment = useApiData<{ equipment: TractorEquipment[] }>("/api/farming/tractor/equipment", { organisationId });
  const hazards = useApiData<{ hazards: Array<CurrentRecord<HazardData>> }>("/api/farming/safety", { organisationId, farmId: farm.id });
  const machines = useApiData<{ equipment: Array<{ recordId: string; data: { name: string }; available: boolean }> }>("/api/farming/safety/equipment", { organisationId, farmId: farm.id });
  const [operation, setOperation] = useState<Operation>("spreading");
  const [chosen, setChosen] = useState<string[]>([]);
  const [equipmentId, setEquipmentId] = useState<string>("");
  const [adding, setAdding] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const active = (paddocks.data?.paddocks ?? []).filter((paddock) => paddock.status === "active").sort((a, b) => NATURAL.compare(a.name, b.name));
  const list = (equipment.data?.equipment ?? []).filter((entry) => entry.isActive);
  const selected = list.find((entry) => entry.id === equipmentId) ?? null;
  const machine = selected?.safetyEquipmentId ? machines.data?.equipment.find((entry) => entry.recordId === selected.safetyEquipmentId) : null;
  const unmapped = chosen.filter((id) => !active.find((paddock) => paddock.id === id)?.geometry);

  const start = async () => {
    if (!selected?.current) return setProblem("Choose the equipment and check its width.");
    setStarting(true);
    setProblem(null);
    try {
      const now = clockNow();
      const step = startRecorder(now);
      const job: LocalJob = {
        id: newId(),
        scope: `${organisationId}:${userId}`,
        organisationId,
        userId,
        farmId: farm.id,
        farmName: farm.name,
        paddockIds: chosen,
        paddockNames: active.filter((paddock) => chosen.includes(paddock.id)).map((paddock) => paddock.name),
        boundaries: active.filter((paddock) => chosen.includes(paddock.id) && paddock.geometry).map((paddock) => ({ paddockId: paddock.id, geometry: paddock.geometry! })),
        hazards: hazardsForMap(hazards.data?.hazards ?? []),
        // Read from the farm's offline copy when there was no connection: its age, not now (decision 1030).
        hazardsAt: hazards.data ? (offlineServedSnapshot().get("/api/farming/safety") ?? new Date(now).toISOString()) : null,
        hazardsFrom: hazards.data && offlineServedSnapshot().has("/api/farming/safety") ? "device" : "job",
        operation,
        equipmentId: selected.id,
        equipmentName: selected.name,
        settings: [{ widthM: Number(selected.current.widthM), lateralM: Number(selected.current.lateralM), backM: Number(selected.current.backM), settingsId: selected.current.id }],
        recorder: step.state,
        events: step.events,
        state: "recording",
        startedAt: now,
        finishedAt: null,
        notes: null,
        product: null,
        declaredRate: null,
        declaredRateUnit: "kg/ha",
        declaredQuantity: null,
        declaredQuantityUnit: "t",
        problem: null,
        sentAt: null,
        pointCount: 0,
      };
      onStart(await saveLocal(job));
    } catch (error) {
      setProblem(`The job couldn't be saved on this device, so it didn't start: ${errorMessage(error)}`);
    } finally {
      setStarting(false);
    }
  };

  return (
    <Card title="Start a job" description="Choose what you're doing, where and with what. Nothing is recorded until you tap Start.">
      <fieldset className={styles.choices}>
        <legend>What</legend>
        {OPERATIONS.map((value) => (
          <label key={value} className={styles.choice}>
            <input type="radio" name="operation" checked={operation === value} onChange={() => setOperation(value)} />
            {OPERATION_LABELS[value]}
          </label>
        ))}
      </fieldset>
      <fieldset className={styles.choices}>
        <legend>Paddocks</legend>
        {paddocks.error ? <Notice tone="error">{paddocks.error}</Notice> : null}
        {!paddocks.data ? <p className={ui.muted}>Loading…</p> : null}
        {active.map((paddock) => (
          <label key={paddock.id} className={styles.choice}>
            <input type="checkbox" checked={chosen.includes(paddock.id)} onChange={(event) => setChosen(event.target.checked ? [...chosen, paddock.id] : chosen.filter((id) => id !== paddock.id))} />
            {paddock.name}
            {paddock.geometry ? null : <span className={ui.muted}> (no map shape)</span>}
          </label>
        ))}
        <p className={ui.muted}>
          {chosen.length === 0 ? "None chosen: this will be an Unassigned paddock job. Only the swept area is worked out; you can choose its paddocks later." : `${chosen.length} chosen. Area outside them is shown separately.`}
          {unmapped.length ? " Paddocks with no map shape can't be clipped to." : ""}
        </p>
      </fieldset>
      <Field label="Equipment" hint="Its working width and offsets are used for this job. Change them below if they're wrong.">
        <select value={equipmentId} onChange={(event) => setEquipmentId(event.target.value)}>
          <option value="">Choose…</option>
          {list.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.name} ({EQUIPMENT_KIND_LABELS[entry.kind]})
            </option>
          ))}
        </select>
      </Field>
      {selected?.current ? (
        <div className={styles.profile}>
          <strong>{selected.name}:</strong> {settingsText(selected.current)} <span className={ui.muted}>(set {new Date(selected.current.createdAt).toLocaleDateString("en-NZ")} by {selected.current.createdByEmail})</span>
          {machine && !machine.available ? <Notice tone="warning">Safety shows {machine.data.name} as out of use after a failed pre-start check. Check it before you start.</Notice> : null}
          <EquipmentSettingsForm organisationId={organisationId} equipment={selected} onSaved={() => equipment.reload()} />
        </div>
      ) : null}
      {adding ? (
        <AddEquipment
          organisationId={organisationId}
          machines={machines.data?.equipment ?? []}
          onDone={(added) => {
            setAdding(false);
            if (added) {
              equipment.reload();
              setEquipmentId(added.id);
            }
          }}
        />
      ) : (
        <p>
          <Button variant="secondary" onClick={() => setAdding(true)}>
            Add equipment
          </Button>
        </p>
      )}
      {hazards.data && hazardsForMap(hazards.data.hazards).length ? <p className={ui.muted}>{hazardsForMap(hazards.data.hazards).length} hazards and no-go zones will be shown on the map. They&apos;re a reminder only.</p> : null}
      {problem ? <Notice tone="error">{problem}</Notice> : null}
      <Button className={styles.startButton} disabled={!selected?.current || starting} onClick={start}>
        {starting ? "Starting…" : "Start"}
      </Button>
    </Card>
  );
}

function EquipmentSettingsForm({ organisationId, equipment, onSaved }: { organisationId: string; equipment: TractorEquipment; onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  const [width, setWidth] = useState(equipment.current?.widthM ?? "");
  const [lateral, setLateral] = useState(equipment.current?.lateralM ?? "0");
  const [back, setBack] = useState(equipment.current?.backM ?? "0");
  const [problem, setProblem] = useState<string | null>(null);
  if (!open) {
    return (
      <Button variant="secondary" size="small" onClick={() => setOpen(true)}>
        Change width or offsets
      </Button>
    );
  }
  return (
    <form
      className={styles.inlineForm}
      onSubmit={async (event) => {
        event.preventDefault();
        try {
          await api(`/api/farming/tractor/equipment/${equipment.id}`, { method: "PATCH", body: { organisationId, widthM: width, lateralM: lateral, backM: back } });
          setOpen(false);
          onSaved();
        } catch (error) {
          setProblem(errorMessage(error));
        }
      }}
    >
      <p className={ui.muted}>Saved as a new version with today&apos;s date. Jobs already recorded keep the width they were driven with.</p>
      <Field label="Working width (m)">
        <input inputMode="decimal" value={width} onChange={(event) => setWidth(event.target.value)} required />
      </Field>
      <Field label="Implement behind the phone (m)" hint="Negative if it's in front, like a front-mounted mower.">
        <input inputMode="decimal" value={back} onChange={(event) => setBack(event.target.value)} />
      </Field>
      <Field label="Implement to the right (m)" hint="Negative for left. 0 if it's centred behind the tractor.">
        <input inputMode="decimal" value={lateral} onChange={(event) => setLateral(event.target.value)} />
      </Field>
      {problem ? <Notice tone="error">{problem}</Notice> : null}
      <div className={styles.row}>
        <Button type="submit">Save</Button>
        <Button variant="secondary" type="button" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function AddEquipment({ organisationId, machines, onDone }: { organisationId: string; machines: Array<{ recordId: string; data: { name: string } }>; onDone: (added: TractorEquipment | null) => void }) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<EquipmentKind>("spreader");
  const [width, setWidth] = useState("");
  const [back, setBack] = useState("0");
  const [lateral, setLateral] = useState("0");
  const [machine, setMachine] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <form
      className={styles.inlineForm}
      onSubmit={async (event) => {
        event.preventDefault();
        try {
          const result = await api<{ equipment: TractorEquipment }>("/api/farming/tractor/equipment", { method: "POST", body: { organisationId, name, kind, widthM: width, backM: back, lateralM: lateral, safetyEquipmentId: machine || null } });
          onDone(result.equipment);
        } catch (error) {
          setProblem(errorMessage(error));
        }
      }}
    >
      <h3>Add equipment</h3>
      <Field label="Name">
        <input value={name} onChange={(event) => setName(event.target.value)} required maxLength={100} />
      </Field>
      <Field label="Kind">
        <select value={kind} onChange={(event) => setKind(event.target.value as EquipmentKind)}>
          {EQUIPMENT_KINDS.map((value) => (
            <option key={value} value={value}>
              {EQUIPMENT_KIND_LABELS[value]}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Working width (m)" hint="The spread or boom width that gets product, not the machine's width.">
        <input inputMode="decimal" value={width} onChange={(event) => setWidth(event.target.value)} required />
      </Field>
      <Field label="Implement behind the phone (m)" hint="Negative if it's in front.">
        <input inputMode="decimal" value={back} onChange={(event) => setBack(event.target.value)} />
      </Field>
      <Field label="Implement to the right (m)" hint="Negative for left.">
        <input inputMode="decimal" value={lateral} onChange={(event) => setLateral(event.target.value)} />
      </Field>
      {machines.length ? (
        <Field label="The machine in Safety (optional)" hint="Links its pre-start checks.">
          <select value={machine} onChange={(event) => setMachine(event.target.value)}>
            <option value="">None</option>
            {machines.map((entry) => (
              <option key={entry.recordId} value={entry.recordId}>
                {entry.data.name}
              </option>
            ))}
          </select>
        </Field>
      ) : null}
      {problem ? <Notice tone="error">{problem}</Notice> : null}
      <div className={styles.row}>
        <Button type="submit">Add</Button>
        <Button variant="secondary" type="button" onClick={() => onDone(null)}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

// Driving -------------------------------------------------------------------------------------------------

type WakeState = "on" | "off" | "unsupported";

/** Working stretches after the last worked-out fix, for drawing straight away. */
function recentStretches(points: TrackPoint[], from: number, settings: JobSettings[]) {
  const out: Array<{ points: Array<[number, number]>; widthM: number }> = [];
  let current: { points: Array<[number, number]>; widthM: number; s: number } | null = null;
  for (let i = Math.max(0, from - 1); i < points.length; i += 1) {
    const point = points[i];
    const usable = point.w && point.acc != null && point.acc <= THRESHOLDS.maxAccuracyM && !point.b;
    if (!usable || !current || current.s !== point.s) {
      if (current && current.points.length > 1) out.push(current);
      current = usable || (point.w && point.b) ? { points: [[point.lon, point.lat]], widthM: settings[point.s]?.widthM ?? 0, s: point.s } : null;
      continue;
    }
    current.points.push([point.lon, point.lat]);
  }
  if (current && current.points.length > 1) out.push(current);
  return out;
}

function TractorDrive({ initial, imageryKey, onClose }: { initial: LocalJob; imageryKey: string | null; onClose: (sent: boolean) => void }) {
  const [job, setJob] = useState<LocalJob>(initial);
  const [points, setPoints] = useState<TrackPoint[]>([]);
  const [coverage, setCoverage] = useState<{ result: CoverageResult; upTo: number } | null>(null);
  const [wake, setWake] = useState<WakeState>("off");
  const [saveProblem, setSaveProblem] = useState<string | null>(null);
  const [online, setOnline] = useState(true);
  const [follow, setFollow] = useState(true);
  const [now, setNow] = useState(() => Date.now());
  const pack = usePackHazards(initial, online);
  const mapHazards = shownHazards(job, pack, online);
  const [reviewing, setReviewing] = useState(initial.recorder.status === "finished");
  const [askFinish, setAskFinish] = useState(false);
  const [widthOpen, setWidthOpen] = useState(false);
  const jobRef = useRef(job);
  const pointsRef = useRef<TrackPoint[]>([]);
  const writes = useRef<Promise<unknown>>(Promise.resolve());
  const [loaded, setLoaded] = useState(false);

  /** Applies a recorder step: keeps it in memory and on the device, in order. */
  const apply = useCallback((step: Step) => {
    if (!step.points.length && !step.events.length && step.state === jobRef.current.recorder) return;
    const before = jobRef.current;
    const next: LocalJob = { ...before, recorder: step.state, events: [...before.events, ...step.events], pointCount: before.pointCount };
    jobRef.current = { ...next, pointCount: before.pointCount + step.points.length };
    setJob(jobRef.current);
    if (step.points.length) {
      pointsRef.current = [...pointsRef.current, ...step.points];
      setPoints(pointsRef.current);
    }
    writes.current = writes.current
      .then(() => saveLocal(next, step.points))
      .then(
        () => setSaveProblem(null),
        (error) => setSaveProblem(`NOT SAVED ON THIS DEVICE: ${errorMessage(error)} Free up space; what's on screen will be lost if Tohyee closes.`),
      );
  }, []);

  // Load what's already recorded; a job that was recording when Tohyee closed comes back paused.
  useEffect(() => {
    let cancelled = false;
    void localPoints(initial.id).then((stored) => {
      if (cancelled) return;
      pointsRef.current = stored;
      setPoints(stored);
      setLoaded(true);
      if (initial.pointCount > 0 || initial.events.length > 1) {
        if (initial.recorder.status !== "finished") apply(reopenRecorder(jobRef.current.recorder, Date.now()));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [initial, apply]);

  const recording = job.recorder.status !== "finished" && !reviewing;

  // GPS, while the driving screen is open.
  useEffect(() => {
    if (!recording || !loaded) return;
    if (!navigator.geolocation) {
      apply(onPermissionDenied(jobRef.current.recorder, Date.now()));
      return;
    }
    const watch = navigator.geolocation.watchPosition(
      (position) => apply(onFix(jobRef.current.recorder, { t: position.timestamp || Date.now(), lon: position.coords.longitude, lat: position.coords.latitude, acc: position.coords.accuracy, heading: position.coords.heading, speed: position.coords.speed }, Date.now())),
      (error) => {
        if (error.code === error.PERMISSION_DENIED) apply(onPermissionDenied(jobRef.current.recorder, Date.now()));
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 15_000 },
    );
    let status: PermissionStatus | null = null;
    const changed = () => {
      if (status?.state === "denied") apply(onPermissionDenied(jobRef.current.recorder, Date.now()));
    };
    navigator.permissions
      ?.query({ name: "geolocation" as PermissionName })
      .then((result) => {
        status = result;
        result.addEventListener("change", changed);
      })
      .catch(() => undefined);
    return () => {
      navigator.geolocation.clearWatch(watch);
      status?.removeEventListener("change", changed);
    };
  }, [recording, loaded, apply]);

  // The screen going off or another app: recording stops and says so.
  useEffect(() => {
    if (!recording) return;
    const changed = () => apply(onVisibility(jobRef.current.recorder, document.visibilityState === "visible", Date.now()));
    document.addEventListener("visibilitychange", changed);
    window.addEventListener("pagehide", changed);
    return () => {
      document.removeEventListener("visibilitychange", changed);
      window.removeEventListener("pagehide", changed);
    };
  }, [recording, apply]);

  // Keep the screen on (Screen Wake Lock), and ask again when Tohyee is back on screen.
  useEffect(() => {
    if (!recording) return;
    const nav = navigator as Navigator & { wakeLock?: { request: (type: "screen") => Promise<{ released: boolean; release: () => Promise<void>; addEventListener: (type: "release", listener: () => void) => void }> } };
    if (!nav.wakeLock) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- what the browser supports, once
      setWake("unsupported");
      return;
    }
    let lock: { release: () => Promise<void> } | null = null;
    let stopped = false;
    const request = async () => {
      if (document.visibilityState !== "visible" || stopped) return;
      try {
        const next = await nav.wakeLock!.request("screen");
        lock = next;
        setWake("on");
        next.addEventListener("release", () => {
          setWake("off");
          if (!stopped && document.visibilityState === "visible") apply({ state: jobRef.current.recorder, points: [], events: [{ t: Date.now(), kind: "wake_lock_lost" }] });
        });
      } catch {
        setWake("off");
      }
    };
    void request();
    const again = () => void request();
    document.addEventListener("visibilitychange", again);
    return () => {
      stopped = true;
      document.removeEventListener("visibilitychange", again);
      void lock?.release().catch(() => undefined);
    };
  }, [recording, apply]);

  // Once a second: GPS lost?
  useEffect(() => {
    if (!recording) return;
    const timer = window.setInterval(() => {
      const time = Date.now();
      setNow(time);
      apply(onTick(jobRef.current.recorder, time));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [recording, apply]);

  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);

  // The worked area, worked out again every few seconds (less often on a long job, so the phone keeps up).
  const boundaries = useMemo(() => job.boundaries.map((entry) => entry.geometry), [job.boundaries]);
  useEffect(() => {
    let timer = 0;
    let wait = 3000;
    let stopped = false;
    const run = () => {
      if (stopped) return;
      const snapshot = pointsRef.current;
      const started = performance.now();
      const result = computeCoverage({ settings: jobRef.current.settings, points: snapshot }, boundaries);
      setCoverage({ result, upTo: snapshot.length });
      wait = Math.max(3000, (performance.now() - started) * 5);
      timer = window.setTimeout(run, wait);
    };
    timer = window.setTimeout(run, 500);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [boundaries]);

  const state = job.recorder;
  const banner = statusBanner(state, { now, wakeLock: wake });
  const last = state.lastFix;
  const quality = gpsQuality(last?.acc);
  const settings = job.settings[state.settings];
  const summary = coverage?.result.summary;
  // The device's own speed, or worked out from the last two fixes when it doesn't give one.
  const speed = (() => {
    if (last?.speed != null && Number.isFinite(last.speed)) return last.speed;
    const [a, b] = points.slice(-2);
    if (!a || !b || b.b || b.t <= a.t || now - b.t > 5000) return null;
    const metres = Math.hypot((b.lon - a.lon) * 111_320 * Math.cos((b.lat * Math.PI) / 180), (b.lat - a.lat) * 110_950);
    return metres / ((b.t - a.t) / 1000);
  })();
  const recent = coverage ? recentStretches(points, coverage.upTo, job.settings) : recentStretches(points, 0, job.settings);
  const where = paddockLabel(job.paddockNames);

  if (reviewing) {
    return <FinishReview job={job} points={points} imageryKey={imageryKey} onSaved={(next) => setJob(next)} onClose={onClose} />;
  }

  return (
    <div className={styles.drive} data-tone={banner.tone}>
      <header className={styles.driveHeader}>
        <div className={styles.banner} data-tone={banner.tone} role="status" aria-live="assertive">
          <strong>{banner.title}</strong>
          <span>{banner.detail}</span>
        </div>
        <div className={styles.headerFacts}>
          <span className={styles.gps} data-quality={quality}>
            GPS {last?.acc != null ? `±${Math.round(last.acc)} m` : "—"}
          </span>
          <span>
            {job.farmName} · {where}
          </span>
          <span>{online ? "Online" : "Offline: saved on this device"}</span>
        </div>
        {saveProblem ? (
          <div className={styles.banner} data-tone="danger" role="alert">
            <strong>{saveProblem}</strong>
          </div>
        ) : null}
      </header>
      <div className={styles.driveMap}>
        <TractorMap
          label={`Map: ${where}, worked area so far and where the tractor is`}
          paddocks={job.boundaries.map((entry, index) => ({ id: entry.paddockId, name: job.paddockNames[index] ?? "", geometry: entry.geometry, chosen: true }))}
          hazards={mapHazards.hazards}
          footprint={coverage?.result.footprint}
          overlap={coverage?.result.overlap}
          lines={coverage?.result.lines}
          gaps={coverage?.result.gaps}
          recent={recent}
          position={last ? { lon: last.lon, lat: last.lat, acc: last.acc, heading: last.heading } : null}
          follow={follow}
          onFollowChange={setFollow}
          imageryKey={imageryKey}
          large
        />
        {hazardNote(mapHazards, now) ? <p className={styles.mapNote}>{hazardNote(mapHazards, now)}</p> : null}
      </div>
      <section className={styles.panel} aria-label="Controls">
        <dl className={styles.stats}>
          <div>
            <dt>Worked (est.)</dt>
            <dd>{summary ? hectares(summary.workedHa) : "—"}</dd>
          </div>
          <div>
            <dt>Overlap</dt>
            <dd>{summary ? hectares(summary.overlapHa) : "—"}</dd>
          </div>
          <div>
            <dt>Speed</dt>
            <dd>{speed != null ? `${Math.round(speed * 3.6)} km/h` : "—"}</dd>
          </div>
          <div>
            <dt>Width</dt>
            <dd>
              <button type="button" className={styles.linkButton} onClick={() => setWidthOpen(true)}>
                {settings ? `${settings.widthM} m` : "—"}
              </button>
            </dd>
          </div>
          {summary?.coveredPct != null ? (
            <div>
              <dt>Of paddocks</dt>
              <dd>{summary.coveredPct}%</dd>
            </div>
          ) : null}
        </dl>
        <button
          type="button"
          className={styles.workingButton}
          data-on={state.working ? "true" : "false"}
          aria-pressed={state.working}
          disabled={state.status !== "recording"}
          onClick={() => apply(setWorking(jobRef.current.recorder, !jobRef.current.recorder.working, Date.now()))}
        >
          <span>Working {state.working ? "ON" : "OFF"}</span>
          <small>{state.working ? "Tap when you stop spreading" : "Tap when you start spreading"}</small>
        </button>
        <div className={styles.controlRow}>
          {state.status === "paused" ? (
            <button type="button" className={styles.bigControl} onClick={() => apply(resume(jobRef.current.recorder, Date.now()))}>
              Resume
            </button>
          ) : (
            <button type="button" className={styles.bigControl} onClick={() => apply(pause(jobRef.current.recorder, Date.now()))}>
              Pause
            </button>
          )}
          <button type="button" className={`${styles.bigControl} ${styles.finishControl}`} onClick={() => setAskFinish(true)}>
            Finish
          </button>
        </div>
        <TractorLegend withPaddocks={job.boundaries.length > 0} />
      </section>
      {askFinish ? (
        <div className={styles.sheet} role="dialog" aria-modal="true" aria-labelledby="finish-title">
          <h2 id="finish-title">Finish this job?</h2>
          <p>Recording stops. You can check the map and numbers, add notes, and send it.</p>
          <div className={styles.controlRow}>
            <button type="button" className={styles.bigControl} onClick={() => setAskFinish(false)} autoFocus>
              Keep going
            </button>
            <button
              type="button"
              className={`${styles.bigControl} ${styles.finishControl}`}
              onClick={() => {
                const step = finishRecorder(jobRef.current.recorder, Date.now());
                apply(step);
                const done: LocalJob = { ...jobRef.current, finishedAt: Date.now(), state: "finished" };
                jobRef.current = done;
                setJob(done);
                writes.current = writes.current.then(() => saveLocal({ ...done, pointCount: done.pointCount }, []));
                setAskFinish(false);
                setReviewing(true);
              }}
            >
              Finish
            </button>
          </div>
        </div>
      ) : null}
      {widthOpen ? (
        <WidthSheet
          current={settings}
          onClose={() => setWidthOpen(false)}
          onSave={(next) => {
            const before = jobRef.current;
            const index = before.settings.length;
            const withSettings = { ...before, settings: [...before.settings, next] };
            jobRef.current = withSettings;
            setJob(withSettings);
            apply(setSettings(withSettings.recorder, index, Date.now()));
            setWidthOpen(false);
          }}
        />
      ) : null}
    </div>
  );
}

function WidthSheet({ current, onClose, onSave }: { current: JobSettings | undefined; onClose: () => void; onSave: (settings: JobSettings) => void }) {
  const [width, setWidth] = useState(String(current?.widthM ?? ""));
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <form
      className={styles.sheet}
      role="dialog"
      aria-modal="true"
      aria-labelledby="width-title"
      onSubmit={(event) => {
        event.preventDefault();
        const value = Number(width);
        if (!Number.isFinite(value) || value <= 0 || value > 60 || Math.round(value * 100) !== value * 100) return setProblem("Enter a width from 0.1 to 60 metres, with up to 2 decimal places.");
        onSave({ widthM: value, lateralM: current?.lateralM ?? 0, backM: current?.backM ?? 0, settingsId: null });
      }}
    >
      <h2 id="width-title">Width for the rest of this job</h2>
      <p>Applies from now on. The equipment&apos;s saved width doesn&apos;t change.</p>
      <Field label="Working width (m)">
        <input inputMode="decimal" value={width} onChange={(event) => setWidth(event.target.value)} autoFocus />
      </Field>
      {problem ? <Notice tone="error">{problem}</Notice> : null}
      <div className={styles.controlRow}>
        <button type="button" className={styles.bigControl} onClick={onClose}>
          Cancel
        </button>
        <button type="submit" className={styles.bigControl}>
          Use this width
        </button>
      </div>
    </form>
  );
}

// Finishing ------------------------------------------------------------------------------------------------

function FinishReview({ job, points, imageryKey, onSaved, onClose }: { job: LocalJob; points: TrackPoint[]; imageryKey: string | null; onSaved: (job: LocalJob) => void; onClose: (sent: boolean) => void }) {
  // The numbers from every fix, not the last few seconds' estimate.
  const shown = useMemo(() => computeCoverage({ settings: job.settings, points }, job.boundaries.map((entry) => entry.geometry)), [job.settings, job.boundaries, points]);
  const [notes, setNotes] = useState(job.notes ?? "");
  const [product, setProduct] = useState(job.product ?? "");
  const [rate, setRate] = useState(job.declaredRate ?? "");
  const [rateUnit, setRateUnit] = useState(job.declaredRateUnit ?? "kg/ha");
  const [quantity, setQuantity] = useState(job.declaredQuantity ?? "");
  const [quantityUnit, setQuantityUnit] = useState(job.declaredQuantityUnit ?? "t");
  const [sending, setSending] = useState(false);
  const [outcome, setOutcome] = useState<{ sent: boolean; tone: "warning" | "error"; text: string } | null>(null);
  const { queue } = useOfflineQueue(job.organisationId);
  const online = useOnline();
  const pack = usePackHazards(job, online);
  const hazards = shownHazards(job, pack, online);
  const [reviewedAt] = useState(() => Date.now());
  const summary = shown.summary;
  const send = async () => {
    setSending(true);
    try {
      const saved = await saveLocal({ ...job, notes: notes || null, product: product || null, declaredRate: rate || null, declaredRateUnit: rateUnit, declaredQuantity: quantity || null, declaredQuantityUnit: quantityUnit, state: "finished" });
      onSaved(saved);
      if (!queue) {
        setOutcome({ sent: false, tone: "warning", text: "Saved on this device. It will be sent from the tractor page when the device's list of work to send opens." });
        return;
      }
      const queued = await handOver(queue, saved);
      onSaved(queued);
      if (navigator.onLine) await queue.sync();
      const item = queue.items({ kind: TRACTOR_QUEUE_KIND }).find((entry) => entry.operationId === job.id);
      if (item?.status === "synced") {
        onSaved(await saveLocal({ ...queued, state: "sent", sentAt: Date.now() }));
        setOutcome({ sent: true, tone: "warning", text: "" });
      } else if (item?.status === "attention") {
        // Refused straight away: taken back off the queue so it can be fixed here and sent again.
        await queue.dismiss(item.operationId);
        onSaved(await saveLocal({ ...queued, state: "finished" }));
        setOutcome({ sent: false, tone: "error", text: `Tohyee refused it: ${item.error ?? "no reason given"}. The job is still on this device.` });
      } else {
        setOutcome({ sent: false, tone: "warning", text: item && queue.shownStatus(item) === "unsaved" ? "Not sent yet, and this device's storage wouldn't keep it. Keep Tohyee open until it's sent." : "Not sent yet: no connection to Tohyee. It's saved on this device and goes with the rest of the work on this device when there's a connection." });
      }
    } catch (error) {
      setOutcome({ sent: false, tone: "error", text: `It couldn't be saved on this device: ${errorMessage(error)}` });
    } finally {
      setSending(false);
    }
  };
  return (
    <div className={styles.review}>
      <h2>Check and send</h2>
      <p>
        {OPERATION_LABELS[job.operation]} · {job.farmName} · {paddockLabel(job.paddockNames)} · {job.equipmentName}
      </p>
      <div className={styles.reviewMap}>
        <TractorMap
          label="The job's track and estimated worked area"
          paddocks={job.boundaries.map((entry, index) => ({ id: entry.paddockId, name: job.paddockNames[index] ?? "", geometry: entry.geometry, chosen: true }))}
          hazards={hazards.hazards}
          footprint={shown.footprint}
          overlap={shown.overlap}
          missed={shown.missed}
          lines={shown.lines}
          gaps={shown.gaps}
          imageryKey={imageryKey}
        />
      </div>
      {hazardNote(hazards, reviewedAt) ? <p className={ui.muted}>{hazardNote(hazards, reviewedAt)}</p> : null}
      <TractorLegend withPaddocks={job.boundaries.length > 0} />
      <SummaryFacts summary={summary} />
      <Notice tone="info">{TRACTOR_NOTICE}</Notice>
      <h3>What you put on (entered, not measured)</h3>
      <Field label="Product">
        <input value={product} onChange={(event) => setProduct(event.target.value)} maxLength={150} />
      </Field>
      <div className={styles.pair}>
        <Field label="Rate">
          <input inputMode="decimal" value={rate} onChange={(event) => setRate(event.target.value)} />
        </Field>
        <Field label="Rate unit">
          <select value={rateUnit} onChange={(event) => setRateUnit(event.target.value)}>
            {RATE_UNITS.map((unit) => (
              <option key={unit}>{unit}</option>
            ))}
          </select>
        </Field>
      </div>
      <div className={styles.pair}>
        <Field label="Quantity used">
          <input inputMode="decimal" value={quantity} onChange={(event) => setQuantity(event.target.value)} />
        </Field>
        <Field label="Quantity unit">
          <select value={quantityUnit} onChange={(event) => setQuantityUnit(event.target.value)}>
            {QUANTITY_UNITS.map((unit) => (
              <option key={unit}>{unit}</option>
            ))}
          </select>
        </Field>
      </div>
      <Field label="Notes">
        <textarea value={notes} onChange={(event) => setNotes(event.target.value)} maxLength={2000} rows={3} />
      </Field>
      {outcome?.sent ? <Notice tone="success">Sent. The job is on the server and can be seen on the website.</Notice> : null}
      {outcome && !outcome.sent ? <Notice tone={outcome.tone}>{outcome.text}</Notice> : null}
      <div className={styles.row}>
        {outcome?.sent ? (
          <>
            <Link className={styles.linkAsButton} href={`/operations/farm/tractor/${job.id}?farm=${job.farmId}`}>
              Open the job
            </Link>
            <Button variant="secondary" onClick={() => onClose(true)}>
              Done
            </Button>
          </>
        ) : (
          <>
            <Button onClick={send} disabled={sending}>
              {sending ? "Sending…" : "Send"}
            </Button>
            <Button variant="secondary" onClick={() => onClose(false)}>
              Send later
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

function SummaryFacts({ summary }: { summary: CoverageResult["summary"] }) {
  return (
    <dl className={styles.facts}>
      <div>
        <dt>Worked (estimated)</dt>
        <dd>{hectares(summary.workedHa)}</dd>
      </div>
      <div>
        <dt>Overlap</dt>
        <dd>{hectares(summary.overlapHa)}</dd>
      </div>
      {summary.paddockHa != null ? (
        <>
          <div>
            <dt>Paddocks (mapped)</dt>
            <dd>{hectares(summary.paddockHa)}</dd>
          </div>
          <div>
            <dt>Not covered</dt>
            <dd>{hectares(summary.missedHa)}</dd>
          </div>
          <div>
            <dt>Worked outside them</dt>
            <dd>{hectares(summary.outsideHa)}</dd>
          </div>
          <div>
            <dt>Share of paddocks</dt>
            <dd>{summary.coveredPct}%</dd>
          </div>
        </>
      ) : (
        <div>
          <dt>Paddock</dt>
          <dd>Unassigned: swept area only</dd>
        </div>
      )}
      <div>
        <dt>Distance</dt>
        <dd>
          {distanceText(summary.distanceM)} ({distanceText(summary.workingDistanceM)} working)
        </dd>
      </div>
      <div>
        <dt>Time recorded</dt>
        <dd>
          {durationText(summary.recordedSeconds)} ({durationText(summary.workingSeconds)} working)
        </dd>
      </div>
      <div>
        <dt>Gaps</dt>
        <dd>{summary.gapSeconds ? durationText(summary.gapSeconds) : "None"}</dd>
      </div>
      <div>
        <dt>GPS accuracy</dt>
        <dd>{summary.accuracy.median != null ? `±${Math.round(summary.accuracy.median)} m typical, ±${Math.round(summary.accuracy.worst ?? 0)} m worst used` : "—"}</dd>
      </div>
      <div>
        <dt>GPS points</dt>
        <dd>
          {summary.points.used.toLocaleString("en-NZ")} used of {summary.points.total.toLocaleString("en-NZ")}
          {summary.points.poorAccuracy ? `, ${summary.points.poorAccuracy} too vague` : ""}
          {summary.points.jumps ? `, ${summary.points.jumps} jumps dropped` : ""}
        </dd>
      </div>
    </dl>
  );
}

// A saved job on the website ------------------------------------------------------------------------------

export function TractorJobReview({ organisationId, jobId }: { organisationId: string; jobId: string }) {
  const loaded = useApiData<{ job: TractorJob }>(`/api/farming/tractor/jobs/${jobId}`, { organisationId });
  const imageryKey = useImageryKey(organisationId);
  const job = loaded.data?.job ?? null;
  const paddocks = useApiData<{ paddocks: Paddock[] }>(job ? `/api/farming/farms/${job.farmId}/paddocks` : null, { organisationId });
  if (loaded.error) return <Notice tone="error">{loaded.error}</Notice>;
  if (!job) return <p className={ui.muted}>Loading…</p>;
  const exportHref = (format: "geojson" | "gpx") => `/api/farming/tractor/jobs/${job.id}/export?format=${format}&organisationId=${encodeURIComponent(organisationId)}`;
  const shapes = (paddocks.data?.paddocks ?? []).filter((paddock) => paddock.status === "active");
  const chosenShapes = job.boundaries.map((entry) => entry.paddockId);
  return (
    <div className={styles.home}>
      <p>
        <Link href={`/operations/farm/tractor?farm=${job.farmId}`}>← Tractor jobs</Link>
      </p>
      {job.status === "withdrawn" ? <Notice tone="warning">Withdrawn: {job.withdrawnReason}</Notice> : null}
      <Card
        title={`${OPERATION_LABELS[job.operation]} · ${paddockLabel(job.paddockNames)}`}
        description={`${new Date(job.startedAt).toLocaleString("en-NZ", { dateStyle: "medium", timeStyle: "short" })} to ${new Date(job.finishedAt).toLocaleTimeString("en-NZ", { timeStyle: "short" })} · ${job.operatorEmail}${job.equipmentName ? ` · ${job.equipmentName}` : ""}`}
        actions={
          <div className={styles.row}>
            <a className={styles.linkAsButton} href={exportHref("geojson")} download>
              GeoJSON
            </a>
            <a className={styles.linkAsButton} href={exportHref("gpx")} download>
              GPX
            </a>
          </div>
        }
      >
        <div className={styles.reviewMap}>
          <TractorMap
            label="The job's travelled track and estimated worked footprint"
            paddocks={[
              ...job.boundaries.map((entry) => ({ id: entry.paddockId, name: "", geometry: entry.geometry, chosen: true })),
              ...shapes.filter((paddock) => !chosenShapes.includes(paddock.id)).map((paddock) => ({ id: paddock.id, name: paddock.name, geometry: paddock.geometry, chosen: false })),
            ]}
            footprint={job.coverage.footprint}
            overlap={job.coverage.overlap}
            missed={job.coverage.missed}
            lines={job.coverage.lines}
            gaps={job.coverage.gaps}
            imageryKey={imageryKey}
          />
        </div>
        <TractorLegend withPaddocks={job.boundaries.length > 0} />
        <SummaryFacts summary={job.summary} />
        <Notice tone="info">{TRACTOR_NOTICE}</Notice>
        <h3>Settings used</h3>
        <ul>
          {job.track.settings.map((entry, index) => (
            <li key={index}>{settingsText(entry)}</li>
          ))}
        </ul>
        <h3>What happened</h3>
        <ul className={styles.events}>
          {job.track.events.map((event, index) => (
            <li key={index} data-kind={event.kind}>
              {new Date(event.t).toLocaleTimeString("en-NZ", { timeStyle: "medium" })} · {EVENT_LABELS[event.kind]}
            </li>
          ))}
        </ul>
        <p className={ui.muted}>
          Device times. The server received it {new Date(job.receivedAt).toLocaleString("en-NZ")}.
        </p>
      </Card>
      <JobDetails organisationId={organisationId} job={job} paddocks={shapes} onSaved={loaded.reload} />
    </div>
  );
}

function JobDetails({ organisationId, job, paddocks, onSaved }: { organisationId: string; job: TractorJob; paddocks: Paddock[]; onSaved: () => void }) {
  const chemicals = useApiData<{ chemicals: Array<{ recordId: string; data: { name: string; removed: boolean } }> }>("/api/farming/safety/chemicals", { organisationId, farmId: job.farmId });
  const plans = useApiData<{ plans: Array<{ id: string; name: string }> }>(job.canLink ? `/api/farming/farms/${job.farmId}/plans` : null, { organisationId });
  const [notes, setNotes] = useState(job.notes ?? "");
  const [product, setProduct] = useState(job.product ?? "");
  const [rate, setRate] = useState(job.declaredRate ?? "");
  const [rateUnit, setRateUnit] = useState(job.declaredRateUnit ?? "kg/ha");
  const [quantity, setQuantity] = useState(job.declaredQuantity ?? "");
  const [quantityUnit, setQuantityUnit] = useState(job.declaredQuantityUnit ?? "t");
  const [chemical, setChemical] = useState(job.chemicalRecordId ?? "");
  const [plan, setPlan] = useState(job.fertiliserPlanId ?? "");
  const [chosen, setChosen] = useState<string[]>(job.paddockIds);
  const [why, setWhy] = useState("");
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const editable = job.canChange && job.status === "active";
  const patch = async (body: Record<string, unknown>, done: string) => {
    try {
      await api(`/api/farming/tractor/jobs/${job.id}`, { method: "PATCH", body: { organisationId, ...body } });
      setMessage({ tone: "success", text: done });
      onSaved();
    } catch (error) {
      setMessage({ tone: "error", text: errorMessage(error) });
    }
  };
  if (!editable) {
    return (
      <Card title="Details">
        <dl className={styles.facts}>
          <div>
            <dt>Product (entered)</dt>
            <dd>{job.product ?? "—"}</dd>
          </div>
          <div>
            <dt>Rate (entered)</dt>
            <dd>{job.declaredRate ? `${job.declaredRate} ${job.declaredRateUnit}` : "—"}</dd>
          </div>
          <div>
            <dt>Quantity (entered)</dt>
            <dd>{job.declaredQuantity ? `${job.declaredQuantity} ${job.declaredQuantityUnit}` : "—"}</dd>
          </div>
          <div>
            <dt>Chemical</dt>
            <dd>{job.chemicalName ?? "—"}</dd>
          </div>
          {job.canLink ? (
            <div>
              <dt>Fertiliser plan</dt>
              <dd>{job.fertiliserPlanName ?? "—"}</dd>
            </div>
          ) : null}
        </dl>
        {job.notes ? <p>{job.notes}</p> : null}
      </Card>
    );
  }
  return (
    <>
      <Card title="Details" description="Product, rate and quantity are what someone entered, not measured. Nothing here posts to the books.">
        <form
          className={styles.inlineForm}
          onSubmit={(event) => {
            event.preventDefault();
            void patch(
              {
                notes,
                product,
                declaredRate: rate || null,
                declaredRateUnit: rate ? rateUnit : null,
                declaredQuantity: quantity || null,
                declaredQuantityUnit: quantity ? quantityUnit : null,
                chemicalRecordId: chemical || null,
                ...(job.canLink ? { fertiliserPlanId: plan || null, fertiliserApplicationId: plan && plan === job.fertiliserPlanId ? job.fertiliserApplicationId : null } : {}),
              },
              "Saved.",
            );
          }}
        >
          <Field label="Product (entered)">
            <input value={product} onChange={(event) => setProduct(event.target.value)} maxLength={150} />
          </Field>
          <div className={styles.pair}>
            <Field label="Rate (entered)">
              <input inputMode="decimal" value={rate} onChange={(event) => setRate(event.target.value)} />
            </Field>
            <Field label="Rate unit">
              <select value={rateUnit} onChange={(event) => setRateUnit(event.target.value)}>
                {RATE_UNITS.map((unit) => (
                  <option key={unit}>{unit}</option>
                ))}
              </select>
            </Field>
          </div>
          <div className={styles.pair}>
            <Field label="Quantity (entered)">
              <input inputMode="decimal" value={quantity} onChange={(event) => setQuantity(event.target.value)} />
            </Field>
            <Field label="Quantity unit">
              <select value={quantityUnit} onChange={(event) => setQuantityUnit(event.target.value)}>
                {QUANTITY_UNITS.map((unit) => (
                  <option key={unit}>{unit}</option>
                ))}
              </select>
            </Field>
          </div>
          <Field label="Chemical (from Safety's register)">
            <select value={chemical} onChange={(event) => setChemical(event.target.value)}>
              <option value="">None</option>
              {(chemicals.data?.chemicals ?? [])
                .filter((entry) => !entry.data.removed || entry.recordId === job.chemicalRecordId)
                .map((entry) => (
                  <option key={entry.recordId} value={entry.recordId}>
                    {entry.data.name}
                  </option>
                ))}
            </select>
          </Field>
          {job.canLink ? (
            <Field label="Fertiliser plan" hint="A link only: the plan's applications and the books don't change.">
              <select value={plan} onChange={(event) => setPlan(event.target.value)}>
                <option value="">None</option>
                {(plans.data?.plans ?? []).map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.name}
                  </option>
                ))}
              </select>
            </Field>
          ) : null}
          <Field label="Notes">
            <textarea value={notes} onChange={(event) => setNotes(event.target.value)} rows={3} maxLength={2000} />
          </Field>
          {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
          <div className={styles.row}>
            <Button type="submit">Save</Button>
          </div>
        </form>
      </Card>
      <Card title="Paddocks" description="Choose the paddocks this job was in. The same track is clipped to their current shapes; the track itself never changes.">
        <fieldset className={styles.choices}>
          <legend className={ui.muted}>Paddocks</legend>
          {paddocks.map((paddock) => (
            <label key={paddock.id} className={styles.choice}>
              <input type="checkbox" checked={chosen.includes(paddock.id)} onChange={(event) => setChosen(event.target.checked ? [...chosen, paddock.id] : chosen.filter((id) => id !== paddock.id))} />
              {paddock.name}
            </label>
          ))}
        </fieldset>
        <Button variant="secondary" onClick={() => void patch({ paddockIds: chosen }, "Paddocks changed and the area worked out again.")}>
          Use these paddocks
        </Button>
      </Card>
      <Card title="Withdraw" description="For a job recorded by mistake. It's kept, marked withdrawn, with why.">
        <Field label="Why">
          <input value={why} onChange={(event) => setWhy(event.target.value)} maxLength={1000} />
        </Field>
        <Button variant="danger" disabled={!why.trim()} onClick={() => void patch({ withdraw: why }, "Withdrawn.")}>
          Withdraw
        </Button>
      </Card>
    </>
  );
}
