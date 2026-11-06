"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { ScoreButtons } from "@/components/farm-bcs";
import { Choices, DayChoice } from "@/components/farm-log";
import type { FarmContext } from "@/components/farm-workspace";
import { useApiData } from "@/components/hooks";
import { InfoTip } from "@/components/info-tip";
import { QueuedWork, submitThroughQueue, useOfflineQueue } from "@/components/offline-queue";
import { Button, Card, Notice, ui } from "@/components/ui";
import { errorMessage } from "@/lib/client/api";
import { findAnimal } from "@/lib/farming/animal-rules";
import type { Animal } from "@/lib/farming/animals";
import type { ScaleSetting } from "@/lib/farming/bcs";
import { SCALE_LABELS, SCALE_WORDS } from "@/lib/farming/bcs-rules";
import type { Mob } from "@/lib/farming/mobs";
import { shortDate } from "@/lib/farming/farm-words";
import { todayInBrowser } from "@/lib/format";
import { add, dec, divide, toFixedString, ZERO_DECIMAL } from "@/lib/money/decimal";
import { newOperationId } from "@/lib/offline/queue";
import styles from "./farm-workspace.module.css";

/*
 * Quick entry (decision 1486): a phone screen for the yards. Type a tag (an
 * EID reader that types like a keyboard works too), enter a score and/or a
 * weight, and go to the next animal. Each entry goes through the device's
 * queue, so it keeps with no signal. With a mob chosen, "Finish" records
 * the mob's weighing from the tags weighed that day.
 */

type What = "score" | "weight" | "both";
type Entry = { tag: string; score: string | null; kg: string | null; state: "saved" | "kept" };

export function FarmQuickEntry({ organisationId, farm, mobId: initialMob }: FarmContext & { mobId?: string | null }) {
  const today = todayInBrowser();
  const { queue } = useOfflineQueue(organisationId);
  const [what, setWhat] = useState<What | null>(null);
  const [mobId, setMobId] = useState<string>(initialMob ?? "");
  const [day, setDay] = useState(today);
  const [typed, setTyped] = useState("");
  const [animal, setAnimal] = useState<Animal | null>(null);
  const [notFound, setNotFound] = useState<string | null>(null);
  const [score, setScore] = useState<string | null>(null);
  const [kg, setKg] = useState("");
  const [entries, setEntries] = useState<Entry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const tagInput = useRef<HTMLInputElement>(null);
  const animals = useApiData<{ animals: Animal[] }>(`/api/farming/farms/${farm.id}/animals`, { organisationId });
  const mobs = useApiData<{ mobs: Mob[] }>(`/api/farming/farms/${farm.id}/mobs`, { organisationId });
  const scales = useApiData<{ scales: ScaleSetting[] }>(`/api/farming/farms/${farm.id}/bcs-scales`, { organisationId });
  const pool = (animals.data?.animals ?? []).filter((entry) => !mobId || entry.mob?.id === mobId);
  const mob = (mobs.data?.mobs ?? []).find((entry) => entry.id === mobId) ?? null;
  const scale = animal ? (scales.data?.scales.find((entry) => entry.kind === animal.kind) ?? null) : null;
  const wantScore = what === "score" || what === "both";
  const wantKg = what === "weight" || what === "both";
  const kgOk = /^\d{1,4}(\.\d)?$/.test(kg);
  const ready = animal && (wantScore ? Boolean(score) : true) && (wantKg ? kgOk : true) && (score || kgOk);

  const lookUp = () => {
    setError(null);
    setDone(null);
    const found = findAnimal(pool, typed);
    setAnimal(found);
    setNotFound(found ? null : typed.trim());
    setScore(null);
    setKg("");
  };
  const nextAnimal = () => {
    setTyped("");
    setAnimal(null);
    setScore(null);
    setKg("");
    requestAnimationFrame(() => tagInput.current?.focus());
  };
  const save = async () => {
    if (!animal) return;
    setBusy(true);
    setError(null);
    try {
      const outcome = await submitThroughQueue(queue, {
        operationId: newOperationId(),
        kind: "animal.readings",
        label: `${animal.tag}: ${[score ? `BCS ${score}` : "", kgOk ? `${kg} kg` : ""].filter(Boolean).join(", ")}`,
        farmId: farm.id,
        farmName: farm.name,
        request: { method: "POST", path: `/api/farming/animals/${animal.id}/actions`, body: { action: "readings", farmId: farm.id, onDate: day, score: wantScore ? score : null, kg: wantKg && kgOk ? kg : null } },
      });
      setEntries((current) => [{ tag: animal.tag, score: wantScore ? score : null, kg: wantKg && kgOk ? kg : null, state: outcome.state === "synced" ? "saved" : "kept" }, ...current]);
      nextAnimal();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };
  const finish = async () => {
    if (!mob) return;
    setError(null);
    try {
      const outcome = await submitThroughQueue(queue, { operationId: newOperationId(), kind: "mob.weigh", label: `Weigh session: ${mob.name}`, farmId: farm.id, farmName: farm.name, request: { method: "POST", path: `/api/farming/mobs/${mob.id}/actions`, body: { action: "weigh", farmId: farm.id, onDate: day, fromTagWeights: true } } });
      setDone(outcome.state === "synced" ? ((outcome.result as { message?: string } | undefined)?.message ?? "Saved.") : "Kept on this device. The mob's average is worked out when it reaches Tohyee.");
      setEntries([]);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  };

  if (!what) {
    return (
      <Card title={`Quick entry · ${farm.name}`} description="Tag, score, weight, next">
        <div style={{ display: "grid", gap: 16 }}>
          <h3 style={{ margin: 0 }}>What are you recording?</h3>
          <Choices
            options={[
              { value: "score" as const, label: "Body condition scores" },
              { value: "weight" as const, label: "Weights" },
              { value: "both" as const, label: "Both" },
            ]}
            value={null}
            onPick={setWhat}
          />
          <label style={{ display: "grid", gap: 4 }}>
            <span>Which mob? (optional)</span>
            <select value={mobId} onChange={(event) => setMobId(event.target.value)} style={{ minHeight: 44 }}>
              <option value="">Any animal on {farm.name}</option>
              {(mobs.data?.mobs ?? []).map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.name} ({entry.tagged} of {entry.head} tagged)
                </option>
              ))}
            </select>
          </label>
          <div>
            <p style={{ margin: "0 0 4px" }}>Which day?</p>
            <DayChoice value={day} onChange={setDay} />
          </div>
          {animals.error ? <Notice tone="warning">{animals.error}</Notice> : null}
          <p className={ui.muted} style={{ margin: 0 }}>
            Works with no signal: entries stay on this phone and go when Tohyee can be reached.{" "}
            <InfoTip label="Tags">Type the visual tag or EID. An EID reader that types into the phone like a keyboard works too. Tags are matched to the animal register; nothing new is added here.</InfoTip>
          </p>
        </div>
      </Card>
    );
  }

  const weighed = entries.filter((entry) => entry.kg);
  let total = ZERO_DECIMAL;
  for (const entry of weighed) total = add(total, dec(entry.kg!));
  const average = weighed.length ? toFixedString(divide(total, dec(String(weighed.length)), 1), 1) : null;

  return (
    <div style={{ display: "grid", gap: 16, maxWidth: 560 }}>
      {done ? <Notice tone="success">{done}</Notice> : null}
      <Card title={`Quick entry · ${mob ? mob.name : farm.name}`} description={`${shortDate(day, today)} · ${entries.length} done`} actions={<Button variant="secondary" onClick={() => setWhat(null)}>Change</Button>}>
        <form
          style={{ display: "grid", gap: 12 }}
          onSubmit={(event) => {
            event.preventDefault();
            if (animal && ready) void save();
            else lookUp();
          }}
        >
          <label style={{ display: "grid", gap: 4 }}>
            <span>Tag or EID</span>
            <input ref={tagInput} autoFocus value={typed} onChange={(event) => (setTyped(event.target.value), setAnimal(null), setNotFound(null))} autoComplete="off" autoCapitalize="characters" enterKeyHint="go" style={{ fontSize: 28, minHeight: 60 }} />
          </label>
          {!animal ? (
            <Button type="submit" disabled={!typed.trim()}>
              Find
            </Button>
          ) : null}
          {notFound ? (
            <Notice tone="warning">
              No animal tagged {notFound}
              {mob ? ` in ${mob.name}` : ` on ${farm.name}`}. Check the tag, or <Link href={`/operations/farm/animals?farm=${farm.id}`}>add it on Animals</Link>.
            </Notice>
          ) : null}
          {animal ? (
            <>
              <p style={{ margin: 0, fontSize: 18 }}>
                <strong>{animal.tag}</strong> · {animal.kindName}
                {animal.mob ? ` · ${animal.mob.name}` : ""}
                {animal.lastBcs ? ` · last BCS ${animal.lastBcs.score}` : ""}
                {animal.lastWeight ? ` · last ${animal.lastWeight.kg} kg` : ""}
              </p>
              {wantScore && scale ? (
                <div>
                  <p style={{ margin: "0 0 4px" }}>
                    Score ({SCALE_LABELS[scale.scale]}){" "}
                    <InfoTip label="What the scores look like">{SCALE_WORDS[scale.scale].map((entry) => `${entry.score}: ${entry.words}`).join(" ")}</InfoTip>
                  </p>
                  <ScoreButtons steps={scale.steps} value={score} onPick={setScore} />
                </div>
              ) : null}
              {wantKg ? (
                <label style={{ display: "grid", gap: 4 }}>
                  <span>Weight (kg)</span>
                  <input inputMode="decimal" value={kg} onChange={(event) => setKg(event.target.value.trim())} style={{ fontSize: 28, minHeight: 60, width: "8ch" }} autoFocus={!wantScore} />
                </label>
              ) : null}
              {error ? <Notice tone="error">Not saved: {error}</Notice> : null}
              <div className={styles.actions}>
                <Button type="submit" disabled={!ready || busy}>
                  {busy ? "Saving…" : "Save and next"}
                </Button>
                <Button type="button" variant="secondary" onClick={nextAnimal}>
                  Skip
                </Button>
              </div>
            </>
          ) : null}
        </form>
      </Card>
      {entries.length ? (
        <Card title="Done this session">
          {average ? (
            <p>
              {weighed.length} weighed, {average} kg average.
            </p>
          ) : null}
          {mob && weighed.length ? (
            <>
              <Button onClick={() => void finish()}>Finish: record {mob.name}&apos;s weighing</Button>
              <p className={ui.muted}>The mob&apos;s average is worked out from every tag weighed today in {mob.name}, on Tohyee.</p>
            </>
          ) : null}
          <ul style={{ paddingLeft: 18 }}>
            {entries.slice(0, 50).map((entry, index) => (
              <li key={`${entry.tag}-${index}`}>
                {entry.tag}: {[entry.score ? `BCS ${entry.score}` : "", entry.kg ? `${entry.kg} kg` : ""].filter(Boolean).join(", ")} {entry.state === "kept" ? "(on this device)" : ""}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
      <QueuedWork organisationId={organisationId} farmId={farm.id} kinds={["animal.", "mob.weigh", "bcs."]} />
    </div>
  );
}
