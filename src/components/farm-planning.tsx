"use client";

import { useState } from "react";
import { Choices, DayChoice, Step } from "@/components/farm-log";
import { FarmRowList } from "@/components/farm-rows";
import { useCanRecordFarmWork } from "@/components/farm-selector";
import type { FarmContext } from "@/components/farm-workspace";
import { useApiData } from "@/components/hooks";
import { InfoTip } from "@/components/info-tip";
import { submitThroughQueue, useOfflineQueue } from "@/components/offline-queue";
import { Button, Card, Field, Notice, ui } from "@/components/ui";
import { api, errorMessage } from "@/lib/client/api";
import { daysAgo, shortDate } from "@/lib/farming/farm-words";
import { paddockLabel } from "@/lib/farming/mob-rules";
import type { Mob } from "@/lib/farming/mobs";
import type { PaddockStatus } from "@/lib/farming/paddock-status";
import type { BreedingRecord, PlannedMove, RotationPlan } from "@/lib/farming/planning";
import { BREEDING_LABELS, type BreedingType, birthsFrom, inCalfPercent, type PlannedStop, roundText, scanningPercent } from "@/lib/farming/planning-rules";
import { formatDate, todayInBrowser } from "@/lib/format";
import { newOperationId } from "@/lib/offline/queue";
import styles from "./farm-workspace.module.css";

/*
 * Breeding records and rotation planning on the Mobs page (decisions
 * 1439-1444): mating, AI, scanning and pregnancy tests per mob, and a
 * farm's round length with each mob's planned moves.
 */

const NATURAL = new Intl.Collator("en-NZ", { numeric: true, sensitivity: "base" });

export function breedingText(record: BreedingRecord): string {
  switch (record.recordType) {
    case "joining":
      return `Mated ${record.head}${record.sire ? ` to ${record.sire}` : ""}${record.untilOn ? `, out ${formatDate(record.untilOn)}` : ""}${record.birthsFrom ? `; births from about ${formatDate(record.birthsFrom)}` : ""}`;
    case "ai":
      return `AI ${record.head}${record.sire ? `, ${record.sire}` : ""}${record.technician ? ` (${record.technician})` : ""}`;
    case "scanning":
      return `Scanned ${record.head}: ${record.scanningPercent}%${record.scanningPercentJoined ? ` (${record.scanningPercentJoined}% of ewes mated)` : ""} · ${record.empty} empty, ${record.singles} singles, ${record.twins} twins, ${record.triplets} triplets`;
    case "pregnancy_test":
      return `Tested ${record.head}: ${record.inCalf} in calf (${record.inCalfPercent}%)`;
  }
}

/** The mob's breeding records, on its card. */
export function MobBreeding({ organisationId, mob, version }: { organisationId: string; mob: Mob; version: string }) {
  const breeding = useApiData<{ breeding: BreedingRecord[] }>(`/api/farming/mobs/${mob.id}/breeding`, { organisationId, version });
  const list = breeding.data?.breeding ?? [];
  if (!list.length) return null;
  const today = todayInBrowser();
  return (
    <>
      <h3>Breeding</h3>
      <FarmRowList label={`${mob.name} breeding`} rows={list.slice(0, 6).map((record) => ({ key: record.id, title: shortDate(record.onDate, today), parts: [breedingText(record)] }))} />
    </>
  );
}

/** Which breeding records a mob can have: scanning for sheep, goats and deer; pregnancy tests for cattle. */
export function breedingTypesFor(mob: Mob): BreedingType[] {
  const cattle = mob.kind === "dairy_cattle" || mob.kind === "beef_cattle";
  return cattle ? ["joining", "ai", "pregnancy_test"] : ["joining", "ai", "scanning"];
}

type BreedingAnswers = { head: string; sire: string; sireMobId: string | null; untilOn: string; technician: string; empty: string; singles: string; twins: string; triplets: string; inCalf: string; day: string };

/** Recording mating, AI, scanning or a pregnancy test (BR1-BR4), a question a screen. */
export function BreedingFlow({ organisationId, farm, mob, mobs, recordType, onClose }: Pick<FarmContext, "organisationId" | "farm"> & { mob: Mob; mobs: Mob[]; recordType: BreedingType; onClose: (message: string | null) => void }) {
  const { queue } = useOfflineQueue(organisationId);
  const steps = recordType === "joining" ? ["sire", "head", "day", "review"] : recordType === "ai" ? ["sire", "head", "day", "review"] : ["result", "day", "review"];
  const [index, setIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [answers, setAnswers] = useState<BreedingAnswers>({ head: String(mob.head), sire: "", sireMobId: null, untilOn: "", technician: "", empty: "", singles: "", twins: "", triplets: "0", inCalf: "", day: todayInBrowser() });
  const set = (patch: Partial<BreedingAnswers>) => setAnswers((current) => ({ ...current, ...patch }));
  const step = steps[index];
  const next = () => setIndex((value) => Math.min(value + 1, steps.length - 1));
  const back = () => (index === 0 ? onClose(null) : setIndex((value) => value - 1));
  const frame = { title: `${BREEDING_LABELS[recordType]} · ${mob.name}`, step: index + 1, steps: steps.length, onBack: back };
  const n = (text: string) => (/^\d{1,6}$/.test(text) ? Number(text) : null);
  const males = mobs.filter((entry) => entry.kind === mob.kind && entry.id !== mob.id && /bull|ram|stag|buck/.test(entry.classCode));
  const scanTotal = (n(answers.empty) ?? 0) + (n(answers.singles) ?? 0) + (n(answers.twins) ?? 0) + (n(answers.triplets) ?? 0);

  const save = async () => {
    setBusy(true);
    setError(null);
    const body: Record<string, unknown> = { farmId: farm.id, recordType, onDate: answers.day, technician: answers.technician || null };
    if (recordType === "joining" || recordType === "ai") Object.assign(body, { head: answers.head, sire: answers.sire.trim() || null, sireMobId: answers.sireMobId, untilOn: answers.untilOn || null });
    if (recordType === "scanning") Object.assign(body, { head: scanTotal, empty: answers.empty, singles: answers.singles, twins: answers.twins, triplets: answers.triplets || 0 });
    if (recordType === "pregnancy_test") Object.assign(body, { head: answers.head, inCalf: answers.inCalf });
    try {
      const outcome = await submitThroughQueue(queue, { operationId: newOperationId(), kind: "farm.breeding", label: `${BREEDING_LABELS[recordType]}: ${mob.name}`, farmId: farm.id, farmName: farm.name, request: { method: "POST", path: `/api/farming/mobs/${mob.id}/breeding`, body } });
      onClose(outcome.state === "synced" ? `${BREEDING_LABELS[recordType]} recorded for ${mob.name}.` : "Kept on this device. It goes when Tohyee can be reached.");
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  switch (step) {
    case "sire":
      return (
        <Step {...frame} question={recordType === "joining" ? "Which rams or bulls?" : "Which sire?"} onNext={next} onSkip={() => (set({ sire: "", sireMobId: null }), next())}>
          {recordType === "joining" && males.length ? <Choices options={males.map((entry) => ({ value: entry.id, label: entry.name, note: `${entry.head} head` }))} value={answers.sireMobId} onPick={(sireMobId) => set({ sireMobId, sire: answers.sire || (males.find((entry) => entry.id === sireMobId)?.name ?? "") })} /> : null}
          <Field label={recordType === "ai" ? "Bull or semen code" : "Sire"}>
            <input value={answers.sire} maxLength={150} placeholder={recordType === "ai" ? "e.g. 114HO" : "e.g. Romney rams"} onChange={(event) => set({ sire: event.target.value })} />
          </Field>
          {recordType === "ai" ? (
            <Field label="Technician">
              <input value={answers.technician} maxLength={100} onChange={(event) => set({ technician: event.target.value })} />
            </Field>
          ) : null}
        </Step>
      );
    case "head":
      return (
        <Step {...frame} question={recordType === "joining" ? "How many were mated, and when did they come out?" : "How many were inseminated?"} onNext={next} nextDisabled={!n(answers.head)}>
          <Field label="Head">
            <input inputMode="numeric" value={answers.head} onChange={(event) => set({ head: event.target.value })} />
          </Field>
          {recordType === "joining" ? (
            <Field label="Rams or bulls out (if known)">
              <input type="date" value={answers.untilOn} onChange={(event) => set({ untilOn: event.target.value })} />
            </Field>
          ) : null}
        </Step>
      );
    case "result":
      return recordType === "scanning" ? (
        <Step {...frame} question="What did the scanner find?" onNext={next} nextDisabled={[answers.empty, answers.singles, answers.twins].some((value) => n(value) === null) || n(answers.triplets || "0") === null || scanTotal < 1}>
          <div className={ui.inlineForm}>
            {(["empty", "singles", "twins", "triplets"] as const).map((key) => (
              <Field key={key} label={key === "triplets" ? "Triplets or more" : key[0].toUpperCase() + key.slice(1)}>
                <input inputMode="numeric" style={{ width: "8ch" }} value={answers[key]} onChange={(event) => set({ [key]: event.target.value })} />
              </Field>
            ))}
          </div>
          <p>
            {scanTotal} scanned{scanTotal ? `: ${scanningPercent({ head: scanTotal, singles: n(answers.singles) ?? 0, twins: n(answers.twins) ?? 0, triplets: n(answers.triplets) ?? 0 })}%` : ""}{" "}
            <InfoTip label="Scanning %">Lambs (foetuses) scanned for every 100 ewes scanned. If a mating is recorded, it&apos;s also given per ewe mated.</InfoTip>
          </p>
          <Field label="Scanner">
            <input value={answers.technician} maxLength={100} onChange={(event) => set({ technician: event.target.value })} />
          </Field>
        </Step>
      ) : (
        <Step {...frame} question="How many are in calf?" onNext={next} nextDisabled={!n(answers.head) || n(answers.inCalf) === null || (n(answers.inCalf) ?? 0) > (n(answers.head) ?? 0)}>
          <div className={ui.inlineForm}>
            <Field label="Tested">
              <input inputMode="numeric" value={answers.head} onChange={(event) => set({ head: event.target.value })} />
            </Field>
            <Field label="In calf">
              <input inputMode="numeric" value={answers.inCalf} onChange={(event) => set({ inCalf: event.target.value })} />
            </Field>
          </div>
          {n(answers.head) && n(answers.inCalf) !== null ? <p>{inCalfPercent(n(answers.head)!, n(answers.inCalf)!)}% in calf</p> : null}
          <Field label="Tested by">
            <input value={answers.technician} maxLength={100} onChange={(event) => set({ technician: event.target.value })} />
          </Field>
        </Step>
      );
    case "day":
      return (
        <Step {...frame} question={recordType === "joining" ? "Which day did they go in?" : "Which day?"} onNext={next}>
          <DayChoice value={answers.day} onChange={(day) => set({ day })} />
        </Step>
      );
    default: {
      const births = recordType === "joining" ? birthsFrom(mob.kind, answers.day) : null;
      return (
        <Step {...frame} question="Check and save" onNext={() => void save()} nextLabel={busy ? "Saving…" : "Save"} nextDisabled={busy}>
          {error ? <Notice tone="error">Not saved: {error}</Notice> : null}
          <dl className={styles.facts}>
            <dt>Mob</dt>
            <dd>{mob.name}</dd>
            <dt>Day</dt>
            <dd>{formatDate(answers.day)}</dd>
            {recordType === "scanning" ? (
              <>
                <dt>Scanned</dt>
                <dd>
                  {scanTotal}: {answers.empty} empty, {answers.singles} singles, {answers.twins} twins, {answers.triplets || 0} triplets
                </dd>
              </>
            ) : recordType === "pregnancy_test" ? (
              <>
                <dt>In calf</dt>
                <dd>
                  {answers.inCalf} of {answers.head}
                </dd>
              </>
            ) : (
              <>
                <dt>Head</dt>
                <dd>{answers.head}</dd>
                <dt>Sire</dt>
                <dd>{answers.sire || "Not said"}</dd>
              </>
            )}
            {births ? (
              <>
                <dt>Births from about</dt>
                <dd>{formatDate(births)}</dd>
              </>
            ) : null}
          </dl>
        </Step>
      );
    }
  }
}

// Rotation ------------------------------------------------------------------------------------------

export function useRotation(organisationId: string, farmId: string, version: number | string) {
  return useApiData<{ plan: RotationPlan }>(`/api/farming/farms/${farmId}/rotation`, { organisationId, version });
}

/** The farm's round length and planned moves (BR5-BR6). */
export function RotationCard({ organisationId, farmId, plan, onChanged, onPlan }: { organisationId: string; farmId: string; plan: RotationPlan | null; onChanged: () => void; onPlan: () => void }) {
  const today = todayInBrowser();
  const canRecord = useCanRecordFarmWork();
  const [round, setRound] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const value = round ?? (plan?.roundDays ? String(plan.roundDays) : "");
  const save = async () => {
    setError(null);
    try {
      await api(`/api/farming/farms/${farmId}/rotation`, { method: "PUT", body: { organisationId, roundDays: value || null } });
      setRound(null);
      onChanged();
    } catch (caught) {
      setError(errorMessage(caught));
    }
  };
  const cancel = async (move: PlannedMove) => {
    try {
      await api(`/api/farming/rotation/${move.id}`, { method: "DELETE", query: { organisationId } });
      onChanged();
    } catch (caught) {
      setError(errorMessage(caught));
    }
  };
  return (
    <Card
      title="Rotation plan"
      description={
        <>
          {plan?.roundDays ? `${plan.roundDays}-day round.` : "No round length yet."}{" "}
          <InfoTip label="Rotation">The round is the days you aim for between grazings. A planned round shares it between the paddocks by area. A move to the planned paddock ticks the plan off. Plans don&apos;t move anything themselves.</InfoTip>
        </>
      }
      actions={canRecord ? <Button variant="secondary" onClick={onPlan}>Plan a round</Button> : null}
    >
      {error ? <Notice tone="error">{error}</Notice> : null}
      {canRecord ? (
        <div className={ui.inlineForm}>
          <Field label="Round length (days)">
            <input inputMode="numeric" style={{ width: "8ch" }} value={value} onChange={(event) => setRound(event.target.value)} />
          </Field>
          <Button variant="secondary" disabled={round === null || (value !== "" && !/^\d{1,3}$/.test(value))} onClick={() => void save()}>
            Save
          </Button>
        </div>
      ) : null}
      {plan?.planned.length ? (
        <FarmRowList
          label="Planned moves"
          rows={plan.planned.slice(0, 20).map((move) => ({
            key: move.id,
            title: shortDate(move.plannedOn, today),
            parts: [move.mobName, `to ${paddockLabel(move.paddockName)}`, move.days ? `${move.days} days` : ""],
            actions: canRecord ? (
              <Button variant="secondary" size="small" onClick={() => void cancel(move)}>
                Cancel this move
              </Button>
            ) : undefined,
          }))}
        />
      ) : (
        <p className={ui.muted}>No moves planned.</p>
      )}
    </Card>
  );
}

/** Planning a mob's round (BR5): the mob, its paddocks in order, the start and the round. */
export function PlanRoundFlow({ organisationId, farm, mobs, roundDays, onClose }: Pick<FarmContext, "organisationId" | "farm"> & { mobs: Mob[]; roundDays: number | null; onClose: (message: string | null) => void }) {
  const today = todayInBrowser();
  const statuses = useApiData<{ paddocks: PaddockStatus[] }>(`/api/farming/farms/${farm.id}/paddock-status`, { organisationId, onDate: today });
  const steps = ["mob", "paddocks", "round", "day", "review"];
  const [index, setIndex] = useState(0);
  const [mobId, setMobId] = useState<string | null>(null);
  const [chosen, setChosen] = useState<string[]>([]);
  const [round, setRound] = useState(roundDays ? String(roundDays) : "");
  const [day, setDay] = useState(today);
  const [preview, setPreview] = useState<PlannedStop[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const next = () => setIndex((value) => Math.min(value + 1, steps.length - 1));
  const back = () => (index === 0 ? onClose(null) : setIndex((value) => value - 1));
  const frame = { title: `Plan a round · ${farm.name}`, step: index + 1, steps: steps.length, onBack: back };
  // Longest since grazed first: the usual order for a round.
  const paddocks = [...(statuses.data?.paddocks ?? [])].sort((a, b) => (a.lastGrazedOn ?? "0000") === (b.lastGrazedOn ?? "0000") ? NATURAL.compare(a.name, b.name) : (a.lastGrazedOn ?? "0000").localeCompare(b.lastGrazedOn ?? "0000"));
  const send = async (save: boolean) => {
    setError(null);
    try {
      const result = await api<{ stops: PlannedStop[]; saved: boolean }>(`/api/farming/farms/${farm.id}/rotation`, { method: "POST", body: { organisationId, mobId, paddockIds: chosen, startOn: day, roundDays: round, preview: !save } });
      if (save) onClose(`Round planned: ${result.stops.length} moves.`);
      else setPreview(result.stops);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  };
  switch (steps[index]) {
    case "mob":
      return (
        <Step {...frame} question="Which mob?">
          <Choices options={mobs.map((mob) => ({ value: mob.id, label: mob.name, note: `${mob.head} head` }))} value={mobId} onPick={(value) => (setMobId(value), next())} />
        </Step>
      );
    case "paddocks":
      return (
        <Step {...frame} question="Which paddocks, in order?" onNext={next} nextDisabled={!chosen.length}>
          <p className={ui.muted}>Tap them in the order the mob goes. Longest since grazed are first.</p>
          <div className={styles.bigButtons}>
            {paddocks.map((status) => {
              const at = chosen.indexOf(status.paddockId);
              return (
                <button key={status.paddockId} type="button" className={styles.bigButton} aria-pressed={at >= 0} style={at >= 0 ? { borderColor: "var(--accent)", boxShadow: "inset 0 0 0 2px var(--accent)" } : undefined} onClick={() => setChosen((current) => (at >= 0 ? current.filter((id) => id !== status.paddockId) : [...current, status.paddockId]))}>
                  {at >= 0 ? `${at + 1}. ` : ""}
                  {paddockLabel(status.name)}
                  <small>{[status.lastGrazedOn ? `grazed ${daysAgo(status.lastGrazedOn, today)}` : "not grazed yet", status.hectares ? `${status.hectares} ha` : ""].filter(Boolean).join(" · ")}</small>
                </button>
              );
            })}
          </div>
        </Step>
      );
    case "round":
      return (
        <Step {...frame} question="How many days in the round?" onNext={next} nextDisabled={!/^\d{1,3}$/.test(round) || Number(round) < chosen.length}>
          <Field label="Round length (days)">
            <input inputMode="numeric" value={round} onChange={(event) => setRound(event.target.value)} />
          </Field>
        </Step>
      );
    case "day":
      return (
        <Step
          {...frame}
          question="Which day does it start?"
          onNext={() => {
            next();
            void send(false);
          }}
        >
          <DayChoice value={day} onChange={setDay} />
        </Step>
      );
    default:
      return (
        <Step {...frame} question="Check and save" onNext={() => void send(true)} nextLabel="Save the plan" nextDisabled={!preview}>
          {error ? <Notice tone="error">Not saved: {error}</Notice> : null}
          {preview ? <FarmRowList label="Planned moves" rows={preview.map((stop) => ({ key: stop.paddockId, title: shortDate(stop.plannedOn, today), parts: [paddockLabel(stop.name), `${stop.days} days`] }))} /> : <p className={ui.muted}>Working it out…</p>}
          <p className={ui.muted}>Any moves already planned for this mob are cancelled.</p>
        </Step>
      );
  }
}

/** "18 of 25 days · next: Milkers 11 Nov", for a paddock line. */
export function paddockPlanText(status: PaddockStatus, plan: RotationPlan | null, today: string): string {
  const next = plan?.nextByPaddock[status.paddockId];
  return [status.inNow ? null : roundText(status.lastGrazedOn, plan?.roundDays ?? null, today), next ? `next: ${next.mobName} ${shortDate(next.plannedOn, today)}` : null].filter(Boolean).join(" · ");
}
