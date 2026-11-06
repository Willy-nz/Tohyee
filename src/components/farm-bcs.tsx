"use client";

import { useState } from "react";
import { BigNumber, Choices, DayChoice } from "@/components/farm-log";
import { FarmRowList } from "@/components/farm-rows";
import { PhotoPicker } from "@/components/farm-safety-reports";
import { useApiData } from "@/components/hooks";
import { InfoTip } from "@/components/info-tip";
import { type PickedFile, submitThroughQueue, useOfflineQueue, waitForFiles } from "@/components/offline-queue";
import { Badge, Button, Card, Field, Notice, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { api, errorMessage } from "@/lib/client/api";
import type { BcsPhoto, BcsRecord, BcsSuggestion, MobBcsPoint, ScaleSetting } from "@/lib/farming/bcs";
import { AI_ESTIMATE_LABEL, type BcsScale, type BcsTargets, bcsText, SCALE_LABELS, SCALE_WORDS, scoreSteps } from "@/lib/farming/bcs-rules";
import { shortDate } from "@/lib/farming/farm-words";
import { formatDate, todayInBrowser } from "@/lib/format";
import { newOperationId } from "@/lib/offline/queue";
import styles from "./farm-workspace.module.css";

/*
 * Body condition scores on an animal or a mob (decisions 1487-1494): the
 * trend with NZ targets where a recognised source gives them, recording a
 * score (an animal's, or a mob's average or tally) with photos, photos to
 * score later, reference photos and AI suggestions to accept or decline.
 */

export type BcsSubject = { animalId?: string; mobId?: string; name: string; farm: { id: string; name: string }; head?: number };

const fileUrl = (organisationId: string, fileId: string) => `/api/farming/safety/files/${fileId}?organisationId=${encodeURIComponent(organisationId)}`;

/** The trend as a small line chart, with target lines; each point has its value on hover and in the list below. */
export function BcsTrend({ points, scale, targets }: { points: Array<{ date: string; score: string; label?: string }>; scale: BcsScale; targets: BcsTargets | null }) {
  if (points.length < 2) return null;
  const top = scale === "1_10" ? 10 : 5;
  const values = points.map((point) => Number(point.score));
  const lines = (targets?.targets ?? []).map((target) => Number(target.score)).concat(targets?.floor ? [Number(targets.floor.score)] : []);
  const lo = Math.max(1, Math.floor(Math.min(...values, ...lines) - 0.5));
  const hi = Math.min(top, Math.ceil(Math.max(...values, ...lines) + 0.5));
  const width = 320;
  const height = 140;
  const pad = { left: 28, right: 64, top: 10, bottom: 22 };
  const x = (index: number) => pad.left + (index * (width - pad.left - pad.right)) / (points.length - 1);
  const y = (value: number) => pad.top + ((hi - value) * (height - pad.top - pad.bottom)) / Math.max(hi - lo, 1);
  const ticks: number[] = [];
  for (let tick = lo; tick <= hi; tick += 1) ticks.push(tick);
  const unique = [...new Map((targets?.targets ?? []).map((target) => [target.score, target])).values()];
  return (
    <figure style={{ margin: "8px 0" }}>
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`BCS trend: ${points.map((point) => `${point.score} on ${point.date}`).join(", ")}`} style={{ width: "100%", maxWidth: 520, height: "auto", display: "block" }}>
        {ticks.map((tick) => (
          <g key={tick}>
            <line x1={pad.left} x2={width - pad.right} y1={y(tick)} y2={y(tick)} stroke="var(--chart-grid)" strokeWidth={1} />
            <text x={pad.left - 6} y={y(tick) + 4} textAnchor="end" fontSize={10} fill="var(--chart-text-muted)">
              {tick}
            </text>
          </g>
        ))}
        {unique.map((target) => (
          <g key={`t${target.score}`}>
            <line x1={pad.left} x2={width - pad.right} y1={y(Number(target.score))} y2={y(Number(target.score))} stroke="var(--chart-muted)" strokeWidth={1} strokeDasharray="4 3" />
            <text x={width - pad.right + 4} y={y(Number(target.score)) + 3} fontSize={9} fill="var(--chart-text-muted)">
              target {target.score}
            </text>
          </g>
        ))}
        {targets?.floor && !unique.some((target) => target.score === targets.floor!.score) ? (
          <g>
            <line x1={pad.left} x2={width - pad.right} y1={y(Number(targets.floor.score))} y2={y(Number(targets.floor.score))} stroke="var(--chart-muted)" strokeWidth={1} strokeDasharray="2 3" />
            <text x={width - pad.right + 4} y={y(Number(targets.floor.score)) + 3} fontSize={9} fill="var(--chart-text-muted)">
              {targets.floor.score} floor
            </text>
          </g>
        ) : null}
        <polyline fill="none" stroke="var(--chart-1)" strokeWidth={2} strokeLinejoin="round" points={points.map((point, index) => `${x(index)},${y(Number(point.score))}`).join(" ")} />
        {points.map((point, index) => (
          <g key={`${point.date}-${index}`}>
            <circle cx={x(index)} cy={y(Number(point.score))} r={4} fill="var(--chart-1)" stroke="var(--chart-surface)" strokeWidth={2}>
              <title>{`${point.score} on ${point.date}${point.label ? ` (${point.label})` : ""}`}</title>
            </circle>
            <circle cx={x(index)} cy={y(Number(point.score))} r={12} fill="transparent">
              <title>{`${point.score} on ${point.date}${point.label ? ` (${point.label})` : ""}`}</title>
            </circle>
          </g>
        ))}
        <text x={pad.left} y={height - 6} fontSize={10} fill="var(--chart-text-muted)">
          {points[0].date}
        </text>
        <text x={width - pad.right} y={height - 6} textAnchor="end" fontSize={10} fill="var(--chart-text-muted)">
          {points[points.length - 1].date}
        </text>
      </svg>
    </figure>
  );
}

export function TargetsNote({ targets, scale }: { targets: BcsTargets | null; scale: BcsScale }) {
  if (!targets) {
    return (
      <p className={ui.muted}>
        Scale {SCALE_LABELS[scale]}. No targets shown.{" "}
        <InfoTip label="No targets">No recognised New Zealand source gives targets for this kind of stock on this scale, so Tohyee doesn&apos;t show any.</InfoTip>
      </p>
    );
  }
  return (
    <div className={ui.muted} style={{ fontSize: "var(--text-sm, 14px)" }}>
      <p style={{ margin: "4px 0" }}>
        Scale {SCALE_LABELS[scale]}. Targets from {targets.source}.{" "}
        <InfoTip label="Targets">These are the source&apos;s own targets, as a guide. Your vet or advisor may set others for your stock.</InfoTip>
      </p>
      <ul style={{ margin: "4px 0", paddingLeft: 18 }}>
        {targets.targets.map((target) => (
          <li key={`${target.when}${target.score}${target.who}`}>
            {target.when}: {target.score}
            {target.who ? ` (${target.who})` : ""}
          </li>
        ))}
        {targets.floor ? (
          <li>
            Below {targets.floor.score}: {targets.floor.words}
          </li>
        ) : null}
      </ul>
    </div>
  );
}

function PhotoThumb({ organisationId, fileId, alt }: { organisationId: string; fileId: string; alt: string }) {
  return (
    <a href={fileUrl(organisationId, fileId)} target="_blank" rel="noreferrer">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={fileUrl(organisationId, fileId)} alt={alt} width={96} height={72} style={{ objectFit: "cover", borderRadius: 6, border: "1px solid var(--border)" }} />
    </a>
  );
}

/** "Use as a reference" on a photo of a score given by eye (decision 1493). */
function ReferenceButton({ organisationId, photo, needsScore, scale, onDone }: { organisationId: string; photo: BcsPhoto; needsScore: boolean; scale: BcsScale; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [score, setScore] = useState("");
  const [error, setError] = useState<string | null>(null);
  const send = async (body: Record<string, unknown>) => {
    setError(null);
    try {
      await api(`/api/farming/bcs/photos/${photo.id}`, { method: "PATCH", body: { organisationId, ...body } });
      setOpen(false);
      onDone();
    } catch (caught) {
      setError(errorMessage(caught));
    }
  };
  if (photo.reference) {
    return (
      <span>
        <Badge tone="green">Reference {photo.reference.score}</Badge>{" "}
        <button type="button" className={ui.linkButton} onClick={() => void send({ reference: false })}>
          Stop using
        </button>
      </span>
    );
  }
  if (!open) {
    return (
      <button type="button" className={ui.linkButton} onClick={() => (needsScore ? setOpen(true) : void send({ reference: true }))}>
        Use as a reference
      </button>
    );
  }
  return (
    <span style={{ display: "inline-flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
      <label>
        Score by eye{" "}
        <select value={score} onChange={(event) => setScore(event.target.value)}>
          <option value="">Choose…</option>
          {scoreSteps(scale).map((step) => (
            <option key={step} value={step}>
              {step}
            </option>
          ))}
        </select>
      </label>
      <Button variant="secondary" disabled={!score} onClick={() => void send({ reference: true, score })}>
        Save
      </Button>
      {error ? <span role="alert">{error}</span> : null}
    </span>
  );
}

/** The BCS part of an animal's or mob's card. */
export function BcsPanel({
  organisationId,
  subject,
  records,
  trend,
  scale,
  targets,
  photos,
  suggestions,
  onChanged,
}: {
  organisationId: string;
  subject: BcsSubject;
  records: BcsRecord[];
  trend: Array<{ date: string; score: string; label?: string }>;
  scale: BcsScale;
  targets: BcsTargets | null;
  photos: BcsPhoto[];
  suggestions: BcsSuggestion[];
  onChanged: () => void;
}) {
  const today = todayInBrowser();
  const { can, current } = useWorkspace();
  const canRecord = current?.role === "farm_worker" || can("bookkeeper");
  const [mode, setMode] = useState<null | "record" | "photos">(null);
  const [done, setDone] = useState<string | null>(null);
  const waiting = photos.filter((photo) => !photo.recordId && !photo.reference && !suggestions.some((entry) => entry.photo.id === photo.id && entry.status !== "declined"));
  const finish = (message: string | null) => {
    setMode(null);
    if (message) setDone(message);
    onChanged();
  };
  return (
    <section aria-label="Body condition">
      <h3>
        Body condition{" "}
        <InfoTip label="Body condition score">
          A score by eye and feel of the fat an animal carries, in half points. Cattle are scored 1 to 10 and sheep, deer and goats 1 to 5 unless the farm changed it. Scores from other tools can be imported on Animals.
        </InfoTip>
      </h3>
      {done ? <Notice tone="success">{done}</Notice> : null}
      {records.length ? <p>Latest: {bcsText(records[0])} on {shortDate(records[0].scoredOn, today)}.</p> : <p className={ui.muted}>No scores yet.</p>}
      <BcsTrend points={trend} scale={scale} targets={targets} />
      <TargetsNote targets={targets} scale={scale} />
      {canRecord && !mode ? (
        <div className={styles.actions}>
          <Button onClick={() => (setDone(null), setMode("record"))}>Record a BCS</Button>
          <Button variant="secondary" onClick={() => (setDone(null), setMode("photos"))}>
            Add photos to score later
          </Button>
        </div>
      ) : null}
      {mode === "record" ? <RecordBcsForm organisationId={organisationId} subject={subject} scale={scale} onClose={finish} /> : null}
      {mode === "photos" ? <PhotosLater organisationId={organisationId} subject={subject} onClose={finish} /> : null}
      <Suggestions organisationId={organisationId} subject={subject} suggestions={suggestions} scale={scale} onChanged={onChanged} />
      {waiting.length ? (
        <>
          <h4>Photos waiting for a score</h4>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {waiting.map((photo) => (
              <PhotoThumb key={photo.id} organisationId={organisationId} fileId={photo.fileId} alt={`${subject.name} on ${photo.takenOn}`} />
            ))}
          </div>
          <p className={ui.muted}>Score them by eye with Record a BCS, or ask your connected AI to suggest scores.</p>
        </>
      ) : null}
      {records.length ? (
        <FarmRowList
          label={`${subject.name} scores`}
          rows={records.slice(0, 20).map((record) => ({
            key: record.id,
            title: shortDate(record.scoredOn, today),
            parts: [bcsText(record), record.source === "ai_suggestion" ? "from an AI suggestion, accepted" : record.source === "import" ? "imported" : ""].filter(Boolean),
            // The tally and photos open under the line, so a long tally never widens the card on a phone.
            details: record.photos.length || record.tally ? (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
                {record.tally ? <p style={{ margin: 0, flexBasis: "100%" }}>{Object.entries(record.tally).map(([score, n]) => `${n} at ${score}`).join(", ")}</p> : null}
                {record.photos.map((photo) => (
                  <div key={photo.id} style={{ display: "grid", gap: 4 }}>
                    <PhotoThumb organisationId={organisationId} fileId={photo.fileId} alt={`${subject.name}, BCS ${record.score}`} />
                    {record.source !== "ai_suggestion" && canRecord ? <ReferenceButton organisationId={organisationId} photo={photo} needsScore={!subject.animalId} scale={record.scale} onDone={onChanged} /> : null}
                  </div>
                ))}
              </div>
            ) : undefined,
          }))}
        />
      ) : null}
    </section>
  );
}

function RecordBcsForm({ organisationId, subject, scale, onClose }: { organisationId: string; subject: BcsSubject; scale: BcsScale; onClose: (message: string | null) => void }) {
  const today = todayInBrowser();
  const { queue } = useOfflineQueue(organisationId);
  const [kind, setKind] = useState<"average" | "tally">(subject.mobId ? "tally" : "average");
  const [score, setScore] = useState<string | null>(null);
  const [average, setAverage] = useState("");
  const [headScored, setHeadScored] = useState("");
  const [tally, setTally] = useState<Record<string, string>>({});
  const [day, setDay] = useState(today);
  const [photos, setPhotos] = useState<PickedFile[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const steps = scoreSteps(scale);
  const tallyHead = Object.values(tally).reduce((sum, value) => sum + (/^\d+$/.test(value) ? Number(value) : 0), 0);
  const ready = subject.animalId ? Boolean(score) : kind === "tally" ? tallyHead > 0 : /^\d{1,2}(\.\d)?$/.test(average);
  const save = async () => {
    setBusy(true);
    setError(null);
    const operationId = newOperationId();
    const body: Record<string, unknown> = { animalId: subject.animalId ?? null, mobId: subject.mobId ?? null, onDate: day, files: photos.map((photo) => ({ id: photo.id })) };
    if (subject.animalId) body.score = score;
    else if (kind === "tally") body.tally = Object.fromEntries(Object.entries(tally).filter(([, value]) => /^\d+$/.test(value) && Number(value) > 0).map(([key, value]) => [key, Number(value)]));
    else Object.assign(body, { average, headScored: headScored || null });
    try {
      // Kept on the device first, so it's saved with no signal (decision 1490).
      const outcome = await submitThroughQueue(queue, { operationId, kind: "bcs.record", label: `BCS: ${subject.name}`, farmId: subject.farm.id, farmName: subject.farm.name, request: { method: "POST", path: "/api/farming/bcs/records", body, refs: waitForFiles(photos, ["files"]) } });
      onClose(outcome.state === "synced" ? ((outcome.result as { message?: string } | undefined)?.message ?? "Saved.") : "Kept on this device. It goes when Tohyee can be reached.");
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title={`Record a BCS · ${subject.name}`}>
      <div style={{ display: "grid", gap: 12 }}>
        {error ? <Notice tone="error">Not saved: {error}</Notice> : null}
        {subject.mobId ? (
          <Choices
            options={[
              { value: "tally", label: "Count at each score", note: "the average is worked out" },
              { value: "average", label: "Type the average", note: "and how many you scored" },
            ]}
            value={kind}
            onPick={setKind}
          />
        ) : null}
        {subject.animalId ? (
          <>
            <p style={{ margin: 0 }}>
              Score ({SCALE_LABELS[scale]}){" "}
              <InfoTip label="What the scores look like">
                {SCALE_WORDS[scale].map((entry) => `${entry.score}: ${entry.words}`).join(" ")}
              </InfoTip>
            </p>
            <ScoreButtons steps={steps} value={score} onPick={setScore} />
          </>
        ) : kind === "tally" ? (
          <div>
            <p className={ui.muted} style={{ marginTop: 0 }}>
              How many at each score? Leave the rest blank. {tallyHead ? `${tallyHead} counted${subject.head ? ` of ${subject.head}` : ""}.` : ""}
            </p>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(84px, 1fr))", gap: 8 }}>
              {steps.map((step) => (
                <label key={step} style={{ display: "grid", gap: 2 }}>
                  <span>{step}</span>
                  <input inputMode="numeric" value={tally[step] ?? ""} onChange={(event) => setTally((current) => ({ ...current, [step]: event.target.value.replace(/\D/g, "") }))} style={{ minHeight: 44, fontSize: 18 }} />
                </label>
              ))}
            </div>
          </div>
        ) : (
          <>
            <BigNumber value={average} onChange={setAverage} label={`Average (${SCALE_LABELS[scale]})`} unit="BCS" />
            <Field label="How many were scored (optional)">
              <input inputMode="numeric" value={headScored} onChange={(event) => setHeadScored(event.target.value.replace(/\D/g, ""))} />
            </Field>
          </>
        )}
        <div>
          <p style={{ margin: "0 0 4px" }}>Which day?</p>
          <DayChoice value={day} onChange={setDay} />
        </div>
        <PhotoPicker organisationId={organisationId} farmId={subject.farm.id} farmName={subject.farm.name} files={photos} onChange={setPhotos} label="Photos (optional)" />
        <div className={styles.actions}>
          <Button disabled={!ready || busy} onClick={() => void save()}>
            {busy ? "Saving…" : "Save"}
          </Button>
          <Button variant="secondary" onClick={() => onClose(null)}>
            Cancel
          </Button>
        </div>
      </div>
    </Card>
  );
}

export function ScoreButtons({ steps, value, onPick }: { steps: string[]; value: string | null; onPick: (value: string) => void }) {
  return (
    <div role="group" aria-label="Score" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(56px, 1fr))", gap: 6 }}>
      {steps.map((step) => (
        <button key={step} type="button" className={styles.bigButton} aria-pressed={value === step} onClick={() => onPick(step)} style={{ minHeight: 52, padding: 4, justifyContent: "center", textAlign: "center", ...(value === step ? { borderColor: "var(--accent)", boxShadow: "inset 0 0 0 2px var(--accent)" } : {}) }}>
          {step}
        </button>
      ))}
    </div>
  );
}

function PhotosLater({ organisationId, subject, onClose }: { organisationId: string; subject: BcsSubject; onClose: (message: string | null) => void }) {
  const { queue } = useOfflineQueue(organisationId);
  const [photos, setPhotos] = useState<PickedFile[]>([]);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    setError(null);
    try {
      const outcome = await submitThroughQueue(queue, {
        operationId: newOperationId(),
        kind: "bcs.photos",
        label: `BCS photos: ${subject.name}`,
        farmId: subject.farm.id,
        farmName: subject.farm.name,
        request: { method: "POST", path: "/api/farming/bcs/photos", body: { animalId: subject.animalId ?? null, mobId: subject.mobId ?? null, onDate: todayInBrowser(), files: photos.map((photo) => ({ id: photo.id })) }, refs: waitForFiles(photos, ["files"]) },
      });
      onClose(outcome.state === "synced" ? "Photos kept to score." : "Kept on this device. It goes when Tohyee can be reached.");
    } catch (caught) {
      setError(errorMessage(caught));
    }
  };
  return (
    <Card title={`Photos to score · ${subject.name}`}>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <p className={ui.muted}>
        Side-on and from behind, in good light, show the spine, ribs, hips and tail head best.{" "}
        <InfoTip label="Scoring from photos">A person can score them later by eye. Your own connected AI can suggest a score from them, but that&apos;s an estimate from a photo, not a trained BCS assessment: check it by eye.</InfoTip>
      </p>
      <PhotoPicker organisationId={organisationId} farmId={subject.farm.id} farmName={subject.farm.name} files={photos} onChange={setPhotos} />
      <div className={styles.actions}>
        <Button disabled={!photos.length} onClick={() => void save()}>
          Keep photos
        </Button>
        <Button variant="secondary" onClick={() => onClose(null)}>
          Cancel
        </Button>
      </div>
    </Card>
  );
}

/** "Suggested scores" (decision 1492): the photo beside each AI suggestion, with Accept, Change and Decline. */
function Suggestions({ organisationId, subject, suggestions, scale, onChanged }: { organisationId: string; subject: BcsSubject; suggestions: BcsSuggestion[]; scale: BcsScale; onChanged: () => void }) {
  const waiting = suggestions.filter((entry) => entry.status === "waiting");
  const decided = suggestions.filter((entry) => entry.status !== "waiting").slice(0, 5);
  if (!suggestions.length) return null;
  return (
    <div>
      <h4>
        Suggested scores{" "}
        <InfoTip label="AI suggestions">
          Your own connected AI suggested these from photos. An AI estimate from a photo isn&apos;t a trained BCS assessment, and a liveweight from a photo is rough. Check each animal by eye before you accept. A suggestion counts for nothing until you accept it.
        </InfoTip>
      </h4>
      {waiting.map((entry) => (
        <SuggestionRow key={entry.id} organisationId={organisationId} subject={subject} suggestion={entry} scale={scale} onChanged={onChanged} />
      ))}
      {decided.length ? (
        <p className={ui.muted}>
          Decided:{" "}
          {decided.map((entry) => `${shortDate(entry.photo.takenOn, todayInBrowser())} ${entry.score} ${entry.status === "accepted" ? `accepted as ${entry.decidedScore}` : "declined"}`).join("; ")}.
        </p>
      ) : null}
    </div>
  );
}

function SuggestionRow({ organisationId, subject, suggestion, scale, onChanged }: { organisationId: string; subject: BcsSubject; suggestion: BcsSuggestion; scale: BcsScale; onChanged: () => void }) {
  const [changing, setChanging] = useState(false);
  const [score, setScore] = useState<string | null>(null);
  const [withWeight, setWithWeight] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const send = async (body: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/farming/bcs/suggestions/${suggestion.id}`, { method: "POST", body: { organisationId, ...body } });
      onChanged();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div style={{ display: "flex", gap: 12, alignItems: "flex-start", flexWrap: "wrap", padding: "8px 0", borderTop: "1px solid var(--border)" }}>
      <PhotoThumb organisationId={organisationId} fileId={suggestion.photo.fileId} alt={`${subject.name} on ${suggestion.photo.takenOn}`} />
      <div style={{ display: "grid", gap: 6, flex: "1 1 200px", minWidth: 0 }}>
        <div>
          <Badge tone="amber">AI estimate</Badge> <strong>BCS {suggestion.score}</strong>
          {suggestion.estimatedKg ? ` · about ${suggestion.estimatedKg} kg` : ""} · photo {formatDate(suggestion.photo.takenOn)}
        </div>
        <p className={ui.muted} style={{ margin: 0 }}>
          {suggestion.reasoning} {suggestion.referencePhotoIds.length ? `Compared with ${suggestion.referencePhotoIds.length} of the farm's reference photos.` : "No reference photos used."}
        </p>
        <p className={ui.muted} style={{ margin: 0, fontSize: "var(--text-sm, 14px)" }}>
          {AI_ESTIMATE_LABEL}. Check it by eye{suggestion.estimatedKg ? ", and weigh to be sure of the weight" : ""}.
        </p>
        {error ? <Notice tone="error">{error}</Notice> : null}
        {changing ? <ScoreButtons steps={scoreSteps(scale)} value={score} onPick={setScore} /> : null}
        {suggestion.estimatedKg ? (
          <label className={styles.check}>
            <input type="checkbox" checked={withWeight} onChange={(event) => setWithWeight(event.target.checked)} /> Also save the weight estimate ({suggestion.estimatedKg} kg, marked as from a photo)
          </label>
        ) : null}
        <div className={styles.actions}>
          {changing ? (
            <Button disabled={!score || busy} onClick={() => void send({ action: "accept", score, acceptWeight: withWeight })}>
              Save {score ?? ""}
            </Button>
          ) : (
            <Button disabled={busy} onClick={() => void send({ action: "accept", acceptWeight: withWeight })}>
              Accept {suggestion.score}
            </Button>
          )}
          <Button variant="secondary" disabled={busy} onClick={() => setChanging((value) => !value)}>
            {changing ? "Keep it" : "Change"}
          </Button>
          <Button variant="secondary" disabled={busy} onClick={() => void send({ action: "decline" })}>
            Decline
          </Button>
        </div>
      </div>
    </div>
  );
}

/** A mob's BCS, loaded for its card. */
export function MobBcsPanel({ organisationId, mob, farm }: { organisationId: string; mob: { id: string; name: string; head: number }; farm: { id: string; name: string } }) {
  const data = useApiData<{ records: BcsRecord[]; trend: MobBcsPoint[]; scale: BcsScale; targets: BcsTargets | null; photos: BcsPhoto[]; suggestions: BcsSuggestion[] }>(`/api/farming/mobs/${mob.id}/bcs`, { organisationId });
  if (data.error) return <Notice tone="error">{data.error}</Notice>;
  if (!data.data) return <p className={ui.muted}>Loading body condition…</p>;
  return (
    <BcsPanel
      organisationId={organisationId}
      subject={{ mobId: mob.id, name: mob.name, farm, head: mob.head }}
      records={data.data.records}
      trend={data.data.trend.map((point) => ({ date: point.date, score: point.score, label: point.from === "tags" ? `average of ${point.head} tagged` : point.head ? `${point.head} scored` : "mob average" }))}
      scale={data.data.scale}
      targets={data.data.targets}
      photos={data.data.photos}
      suggestions={data.data.suggestions}
      onChanged={data.reload}
    />
  );
}

/** Each kind's scale on the farm (decision 1487), with which scores have reference photos (decision 1493). */
export function ScalesCard({ organisationId, farmId }: { organisationId: string; farmId: string }) {
  const { can } = useWorkspace();
  const data = useApiData<{ scales: ScaleSetting[] }>(`/api/farming/farms/${farmId}/bcs-scales`, { organisationId });
  const [error, setError] = useState<string | null>(null);
  const change = async (kind: string, scale: BcsScale) => {
    setError(null);
    try {
      await api(`/api/farming/farms/${farmId}/bcs-scales`, { method: "PUT", body: { organisationId, kind, scale } });
      data.reload();
    } catch (caught) {
      setError(errorMessage(caught));
    }
  };
  return (
    <Card title="BCS scales and reference photos">
      <details>
        <summary className={ui.linkButton}>Scales, targets and references</summary>
        <p className={ui.muted}>
          Reference photos are photos of your own stock that someone scored by eye. Mark them on a score&apos;s photo with &quot;Use as a reference&quot;. The more you have, at more scores, the better your AI&apos;s suggestions are.{" "}
          <InfoTip label="Scales">
            Dairy cows: DairyNZ&apos;s 1 to 10 scale (see DairyNZ&apos;s Body condition score reference guide). Beef cows: Beef + Lamb New Zealand&apos;s 1 to 10. Sheep: Beef + Lamb New Zealand&apos;s 1 to 5. Deer: Deer Industry New Zealand&apos;s 1 to 5. Goats: 1 to 5 (no NZ body publishes a scale). Old scores keep the scale they were given on.
          </InfoTip>
        </p>
        {error ? <Notice tone="error">{error}</Notice> : null}
        {data.error ? <Notice tone="error">{data.error}</Notice> : null}
        <ul style={{ paddingLeft: 0, listStyle: "none", display: "grid", gap: 10 }}>
          {(data.data?.scales ?? []).map((entry) => {
            const missing = entry.steps.filter((step) => !entry.references.includes(step));
            return (
              <li key={entry.kind}>
                <strong>{entry.kindName}</strong>: {SCALE_LABELS[entry.scale]}
                {entry.isDefault ? "" : " (changed for this farm)"}.{" "}
                {entry.references.length ? `References for ${entry.references.join(", ")}` : "No reference photos yet"}
                {entry.references.length && missing.length ? `; none for ${missing.length > 4 ? `${missing.slice(0, 3).join(", ")} and ${missing.length - 3} more` : missing.join(", ")}` : ""}.
                {can("admin") ? (
                  <label style={{ marginLeft: 8 }}>
                    <select value={entry.scale} onChange={(event) => void change(entry.kind, event.target.value as BcsScale)} aria-label={`Scale for ${entry.kindName}`}>
                      <option value="1_10">1 to 10</option>
                      <option value="1_5">1 to 5</option>
                    </select>
                  </label>
                ) : null}
              </li>
            );
          })}
        </ul>
      </details>
    </Card>
  );
}
