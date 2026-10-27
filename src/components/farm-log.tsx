"use client";

import { useSearchParams } from "next/navigation";
import { type ReactNode, useState } from "react";
import { DateInput } from "@/components/date-input";
import { operationId, useFarmDrafts } from "@/components/farm-drafts";
import { LogSafetyReport } from "@/components/farm-safety-reports";
import { useCanRecordFarmWork } from "@/components/farm-selector";
import type { FarmContext } from "@/components/farm-workspace";
import { useApiData } from "@/components/hooks";
import { Badge, Button, Card, Notice, ui } from "@/components/ui";
import { addDraft, type Draft, type DraftKind, type DraftStatus, dismissDraft, draftStatusLabel, draftsFor, moveWalk, openWalk, saveWalkReading, startWalk, type Walk, waitingElsewhere, walkReading } from "@/lib/farming/drafts";
import { addDays, coverText, mobText, shortDate } from "@/lib/farming/farm-words";
import type { PaddockStatus } from "@/lib/farming/paddock-status";
import type { GrazingRecord, Supplement } from "@/lib/farming/pasture";
import { PASTURE_METHOD_LABELS, PASTURE_METHODS, parseCover, type PastureMethod, SUPPLEMENT_UNIT_LABELS, SUPPLEMENT_UNITS, type SupplementUnit } from "@/lib/farming/pasture-rules";
import { formatDate, todayInBrowser } from "@/lib/format";
import styles from "./farm-workspace.module.css";

/*
 * The Log tab (#447, decisions 911-913): quick logs, one question a screen
 * like LIC MINDA, with today and the paddock or mob already filled in where
 * known, and a farm walk saved on the phone reading by reading. Everything
 * is a draft on the phone first and is sent with its own operation id, so
 * no signal loses nothing and a resend makes nothing twice. Only records
 * Tohyee already keeps: cover readings, grazings (mob in and out) and feed.
 */

const NATURAL = new Intl.Collator("en-NZ", { numeric: true, sensitivity: "base" });

type Flow = { kind: "cover" | "in" | "out" | "feed"; paddockId?: string | null; grazingId?: string | null } | { kind: "walk" } | { kind: "safety"; type: "hazard" | "near_miss" | "incident" };

const STATUS_TONE: Record<DraftStatus, "neutral" | "green" | "amber"> = { saved: "neutral", synced: "green", attention: "amber" };

export function StatusBadge({ status, stored = true }: { status: DraftStatus; stored?: boolean }) {
  return <Badge tone={status === "saved" && !stored ? "amber" : STATUS_TONE[status]}>{draftStatusLabel(status, stored)}</Badge>;
}

/** When the phone's storage refused the records (full or blocked): they're only on this page until sent (#463). */
function StorageWarning({ stored, waiting, onRetry, onSend }: { stored: boolean; waiting: number; onRetry: () => boolean; onSend: () => void }) {
  const [failedAgain, setFailedAgain] = useState(false);
  if (stored || !waiting) return null;
  return (
    <Notice tone="warning">
      <p>
        This phone couldn&apos;t save {waiting === 1 ? "a record" : `${waiting} records`}: its storage is full or blocked (private browsing can do this). {waiting === 1 ? "It's" : "They're"} kept on this page only. Don&apos;t close or reload the page until {waiting === 1 ? "it shows" : "they show"} Synced.
      </p>
      {failedAgain ? <p>Still couldn&apos;t save. Free up space on the phone or leave private browsing, then try again.</p> : null}
      <div className={styles.actions}>
        <Button variant="secondary" onClick={() => setFailedAgain(!onRetry())}>
          Try saving on this phone again
        </Button>
        <Button onClick={onSend}>Send now</Button>
      </div>
    </Notice>
  );
}

export function FarmLog(context: FarmContext) {
  const params = useSearchParams();
  const record = params.get("record");
  const initial: Flow | null =
    record === "cover" || record === "in" || record === "out" || record === "feed"
      ? { kind: record, paddockId: params.get("paddock"), grazingId: params.get("grazing") }
      : record === "walk"
        ? { kind: "walk" }
        : record === "hazard" || record === "near_miss" || record === "incident"
          ? { kind: "safety", type: record }
          : null;
  const [flow, setFlow] = useState<Flow | null>(initial);
  const canRecord = useCanRecordFarmWork();
  if (!canRecord) return <Notice tone="info">Recording farm work needs the farm staff or bookkeeper role. An owner or admin can change your role.</Notice>;
  if (flow?.kind === "walk") return <FarmWalk {...context} onClose={() => setFlow(null)} />;
  // Safety reports (#446, decision 962): the Safety page's report, saved on the phone first.
  if (flow?.kind === "safety") return <LogSafetyReport organisationId={context.organisationId} farm={context.farm} type={flow.type} onClose={() => setFlow(null)} />;
  if (flow) return <QuickLog {...context} flow={flow} onClose={() => setFlow(null)} />;
  return <LogHome {...context} onStart={setFlow} />;
}

function LogHome({ organisationId, farm, onStart }: FarmContext & { onStart: (flow: Flow) => void }) {
  const { store, change, sync, stored, retryStorage } = useFarmDrafts(organisationId);
  const walk = openWalk(store, farm.id);
  const mine = draftsFor(store, farm.id).slice(-12).reverse();
  const elsewhere = waitingElsewhere(store, farm.id);
  const waiting = mine.filter((draft) => draft.status === "saved").length;
  return (
    <div className={styles.grid}>
      <Card title={`Log on ${farm.name}`}>
        <div className={styles.bigButtons}>
          <button type="button" className={styles.bigButton} onClick={() => onStart({ kind: "walk" })}>
            {walk ? "Carry on the farm walk" : "Farm walk"}
            <small>{walk ? `${Math.min(walk.position + 1, walk.order.length)} of ${walk.order.length} paddocks` : "A cover for each paddock"}</small>
          </button>
          <button type="button" className={styles.bigButton} onClick={() => onStart({ kind: "in" })}>
            Mob in
            <small>A grazing starts</small>
          </button>
          <button type="button" className={styles.bigButton} onClick={() => onStart({ kind: "out" })}>
            Mob out
            <small>The day out</small>
          </button>
          <button type="button" className={styles.bigButton} onClick={() => onStart({ kind: "cover" })}>
            Cover reading
            <small>One paddock</small>
          </button>
          <button type="button" className={styles.bigButton} onClick={() => onStart({ kind: "feed" })}>
            Feed
            <small>Supplements fed</small>
          </button>
        </div>
        <h3>Safety</h3>
        <div className={styles.bigButtons}>
          <button type="button" className={styles.bigButton} onClick={() => onStart({ kind: "safety", type: "hazard" })}>
            Report a hazard
            <small>Something that could hurt someone</small>
          </button>
          <button type="button" className={styles.bigButton} onClick={() => onStart({ kind: "safety", type: "near_miss" })}>
            Near miss
            <small>Nobody hurt, but it nearly happened</small>
          </button>
          <button type="button" className={styles.bigButton} onClick={() => onStart({ kind: "safety", type: "incident" })}>
            Incident
            <small>Someone hurt, or damage done</small>
          </button>
        </div>
        <p className={ui.muted}>Not kept in Tohyee yet: rainfall, voice notes, animal treatments, and births and deaths.</p>
      </Card>
      <Card title="On this phone" description="Each record is saved here first, then sent. Nothing is lost without a signal.">
        <StorageWarning stored={stored} waiting={store.drafts.filter((draft) => draft.status === "saved").length} onRetry={retryStorage} onSend={() => void sync()} />
        {!mine.length ? <p className={ui.muted}>Nothing recorded on this phone for {farm.name} lately.</p> : null}
        {mine.length ? <DraftList drafts={mine} stored={stored} onDismiss={(id) => change((current) => dismissDraft(current, id))} /> : null}
        {waiting ? (
          <Button variant="secondary" onClick={() => void sync()}>
            Send {waiting} now
          </Button>
        ) : null}
        {elsewhere.map((entry) => (
          <Notice key={entry.farmId} tone="info">
            {entry.count} record{entry.count === 1 ? "" : "s"} for {entry.farmName} {entry.count === 1 ? "is" : "are"} kept with {entry.farmName}, not this farm.
          </Notice>
        ))}
      </Card>
    </div>
  );
}

function DraftList({ drafts, stored, onDismiss }: { drafts: Draft[]; stored: boolean; onDismiss?: (operationId: string) => void }) {
  return (
    <ul className={styles.links}>
      {drafts.map((draft) => (
        <li key={draft.operationId} style={{ display: "grid", gap: 4, padding: "8px 0", borderBottom: "1px solid var(--border)" }}>
          <span>
            {draft.label} <StatusBadge status={draft.status} stored={stored} />
          </span>
          {draft.error ? (
            <span className={ui.muted}>
              {draft.error}{" "}
              {onDismiss ? (
                <button type="button" className={ui.linkButton} onClick={() => onDismiss(draft.operationId)}>
                  Checked: let it go
                </button>
              ) : null}
            </span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

// One question a screen ------------------------------------------------------------------------------------------

function Step({ title, question, step, steps, children, onBack, onNext, nextLabel = "Next", nextDisabled, onSkip }: { title: string; question: string; step: number; steps: number; children: ReactNode; onBack: () => void; onNext?: () => void; nextLabel?: string; nextDisabled?: boolean; onSkip?: () => void }) {
  return (
    <Card title={title} description={`Step ${step} of ${steps}`}>
      <form
        style={{ display: "grid", gap: 16 }}
        onSubmit={(event) => {
          event.preventDefault();
          if (onNext && !nextDisabled) onNext();
        }}
      >
        <h3 style={{ margin: 0, fontSize: "var(--text-xl, 20px)" }}>{question}</h3>
        {children}
        <div className={styles.actions}>
          <Button variant="secondary" onClick={onBack}>
            Back
          </Button>
          {onSkip ? (
            <Button variant="secondary" onClick={onSkip}>
              Skip
            </Button>
          ) : null}
          {onNext ? (
            <Button type="submit" disabled={nextDisabled}>
              {nextLabel}
            </Button>
          ) : null}
        </div>
      </form>
    </Card>
  );
}

function Choices<T extends string>({ options, value, onPick }: { options: Array<{ value: T; label: ReactNode; note?: string }>; value: T | null; onPick: (value: T) => void }) {
  return (
    <div className={styles.bigButtons}>
      {options.map((option) => (
        <button key={option.value} type="button" className={styles.bigButton} aria-pressed={option.value === value} style={option.value === value ? { borderColor: "var(--accent)", boxShadow: "inset 0 0 0 2px var(--accent)" } : undefined} onClick={() => onPick(option.value)}>
          {option.label}
          {option.note ? <small>{option.note}</small> : null}
        </button>
      ))}
    </div>
  );
}

function BigNumber({ value, onChange, label, unit }: { value: string; onChange: (value: string) => void; label: string; unit: string }) {
  return (
    <label style={{ display: "grid", gap: 6 }}>
      <span className={ui.muted}>{label}</span>
      <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <input inputMode="numeric" autoFocus value={value} onChange={(event) => onChange(event.target.value)} style={{ fontSize: 32, minHeight: 64, width: "8ch", textAlign: "right" }} />
        <span>{unit}</span>
      </span>
    </label>
  );
}

function DayChoice({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const today = todayInBrowser();
  const yesterday = addDays(today, -1);
  return (
    <>
      <Choices
        options={[
          { value: today, label: "Today", note: shortDate(today, today) },
          { value: yesterday, label: "Yesterday", note: shortDate(yesterday, today) },
        ]}
        value={value === today || value === yesterday ? value : null}
        onPick={onChange}
      />
      <label style={{ display: "grid", gap: 4 }}>
        <span className={ui.muted}>Another day</span>
        <DateInput value={value} onChange={(event) => onChange(event.target.value || today)} />
      </label>
    </>
  );
}

function PaddockChoice({ statuses, value, onPick, show }: { statuses: PaddockStatus[]; value: string | null; onPick: (id: string) => void; show: (status: PaddockStatus) => string }) {
  return <Choices options={[...statuses].sort((a, b) => NATURAL.compare(a.name, b.name)).map((status) => ({ value: status.paddockId, label: status.name, note: show(status) }))} value={value} onPick={onPick} />;
}

type Answers = { paddockId: string | null; grazingId: string | null; cover: string; method: PastureMethod; day: string; mob: string; head: string; feed: string; quantity: string; unit: SupplementUnit; kgDm: string; postCover: string };

/** The steps of a quick log, each one question. */
function stepsFor(kind: "cover" | "in" | "out" | "feed", given: { paddock: boolean; grazing: boolean }): string[] {
  if (kind === "cover") return [...(given.paddock ? [] : ["paddock"]), "cover", "method", "day", "review"];
  if (kind === "in") return [...(given.paddock ? [] : ["paddock"]), "mob", "head", "day", "preCover", "review"];
  if (kind === "out") return [...(given.grazing ? [] : ["grazing"]), "day", "postCover", "review"];
  return ["feed", "quantity", "unit", "paddockOptional", "day", "review"];
}

const TITLES = { cover: "Cover reading", in: "Mob in", out: "Mob out", feed: "Feed" } as const;

function QuickLog({ organisationId, farm, flow, onClose }: FarmContext & { flow: Exclude<Flow, { kind: "walk" } | { kind: "safety" }>; onClose: () => void }) {
  const today = todayInBrowser();
  const { store, change, sync, stored, retryStorage } = useFarmDrafts(organisationId);
  const statuses = useApiData<{ paddocks: PaddockStatus[] }>(`/api/farming/farms/${farm.id}/paddock-status`, { organisationId, onDate: today });
  const recentGrazings = useApiData<{ grazings: GrazingRecord[] }>(flow.kind === "in" ? `/api/farming/farms/${farm.id}/grazings` : null, { organisationId, limit: 50 });
  const recentFeed = useApiData<{ supplements: Supplement[] }>(flow.kind === "feed" ? `/api/farming/farms/${farm.id}/supplements` : null, { organisationId, limit: 50 });
  const paddocks = statuses.data?.paddocks ?? [];
  const givenPaddock = flow.paddockId && paddocks.some((status) => status.paddockId === flow.paddockId) ? flow.paddockId : null;
  const givenGrazing = flow.grazingId && paddocks.some((status) => status.inNow?.grazingId === flow.grazingId) ? flow.grazingId : null;
  const steps = stepsFor(flow.kind, { paddock: Boolean(givenPaddock), grazing: Boolean(givenGrazing) });
  const [index, setIndex] = useState(0);
  const [saved, setSaved] = useState<string | null>(null);
  const [answers, setAnswers] = useState<Answers>({ paddockId: givenPaddock, grazingId: givenGrazing, cover: "", method: "plate_meter", day: today, mob: "", head: "", feed: "", quantity: "", unit: "kg_dm", kgDm: "", postCover: "" });
  const set = (patch: Partial<Answers>) => setAnswers((current) => ({ ...current, ...patch }));
  const step = steps[index];
  const next = () => setIndex((value) => Math.min(value + 1, steps.length - 1));
  const back = () => (index === 0 ? onClose() : setIndex((value) => value - 1));
  const paddock = paddocks.find((status) => status.paddockId === (answers.paddockId ?? givenPaddock));
  const inNow = paddocks.filter((status) => status.inNow).sort((a, b) => NATURAL.compare(a.name, b.name));
  const grazing = inNow.find((status) => status.inNow!.grazingId === (answers.grazingId ?? givenGrazing));
  const coverValue = parseCover(answers.cover);
  const frame = { title: `${TITLES[flow.kind]} · ${farm.name}`, step: index + 1, steps: steps.length, onBack: back };

  if (!statuses.data) return <p className={ui.muted}>{statuses.error ?? "Loading…"}</p>;

  if (saved) {
    const draft = store.drafts.find((entry) => entry.operationId === saved);
    return (
      <Card title={`${TITLES[flow.kind]} recorded`}>
        <p>
          {draft?.label} {draft ? <StatusBadge status={draft.status} stored={stored} /> : null}
        </p>
        {draft?.error ? <Notice tone="warning">{draft.error}</Notice> : null}
        <StorageWarning stored={stored} waiting={draft?.status === "saved" ? 1 : 0} onRetry={retryStorage} onSend={() => void sync()} />
        <div className={styles.actions}>
          <Button onClick={onClose}>Done</Button>
        </div>
      </Card>
    );
  }

  const save = () => {
    const id = operationId();
    const base = { operationId: id, farmId: farm.id, farmName: farm.name, createdAt: new Date().toISOString(), walkId: null };
    let kind: DraftKind;
    let payload: Record<string, unknown>;
    let label: string;
    if (flow.kind === "cover") {
      kind = "reading";
      payload = { paddockId: paddock!.paddockId, measuredOn: answers.day, cover: coverValue, method: answers.method };
      label = `Paddock ${paddock!.name}: ${coverText(coverValue!)}, ${shortDate(answers.day, today)}`;
    } else if (flow.kind === "in") {
      kind = "grazing_in";
      payload = { paddockId: paddock!.paddockId, mob: answers.mob.trim(), head: answers.head || null, inOn: answers.day, preCover: answers.cover || null };
      label = `${mobText(answers.mob.trim(), Number(answers.head) || null)} into ${paddock!.name}, ${shortDate(answers.day, today)}`;
    } else if (flow.kind === "out") {
      kind = "grazing_out";
      payload = { grazingId: grazing!.inNow!.grazingId, farmId: farm.id, outOn: answers.day, postCover: answers.postCover || null };
      label = `${grazing!.inNow!.mob} out of ${grazing!.name}, ${shortDate(answers.day, today)}`;
    } else {
      kind = "feed";
      payload = { fedOn: answers.day, feed: answers.feed.trim(), quantity: answers.quantity, unit: answers.unit, kgDm: answers.unit === "kg_dm" ? null : answers.kgDm || null, paddockId: answers.paddockId };
      label = `${answers.quantity} ${SUPPLEMENT_UNIT_LABELS[answers.unit]} ${answers.feed.trim()}, ${shortDate(answers.day, today)}`;
    }
    change((current) => addDraft(current, { ...base, kind, payload, label, paddockId: (payload.paddockId as string | null) ?? null }));
    setSaved(id);
    void sync();
  };

  switch (step) {
    case "paddock":
    case "paddockOptional":
      return (
        <Step {...frame} question={step === "paddock" ? "Which paddock?" : "Fed in a paddock?"} onSkip={step === "paddockOptional" ? () => (set({ paddockId: null }), next()) : undefined}>
          <PaddockChoice
            statuses={flow.kind === "in" ? paddocks.filter((status) => !status.inNow) : paddocks}
            value={answers.paddockId}
            onPick={(paddockId) => {
              set({ paddockId });
              next();
            }}
            show={(status) => (status.inNow ? `${status.inNow.mob} in` : status.cover ? `${status.cover.cover.toLocaleString("en-NZ")} · ${shortDate(status.cover.measuredOn, today)}` : "")}
          />
        </Step>
      );
    case "grazing":
      return (
        <Step {...frame} question="Which mob is coming out?">
          {!inNow.length ? <p>No mob is recorded in a paddock on {farm.name}.</p> : null}
          <Choices
            options={inNow.map((status) => ({ value: status.inNow!.grazingId, label: `${status.inNow!.mob} in ${status.name}`, note: `since ${shortDate(status.inNow!.inOn, today)}` }))}
            value={answers.grazingId}
            onPick={(grazingId) => {
              set({ grazingId });
              next();
            }}
          />
        </Step>
      );
    case "cover":
    case "preCover":
    case "postCover": {
      const field = step === "postCover" ? "postCover" : "cover";
      const value = answers[field];
      const ok = value === "" ? step !== "cover" : parseCover(value) !== null;
      return (
        <Step
          {...frame}
          question={step === "cover" ? `Cover in ${paddock?.name ?? "the paddock"}?` : step === "preCover" ? "Cover before they went in?" : "Cover after they came out?"}
          onNext={next}
          nextDisabled={!ok || (step === "cover" && value === "")}
          onSkip={step === "cover" ? undefined : () => (set({ [field]: "" }), next())}
        >
          <BigNumber value={value} onChange={(text) => set({ [field]: text })} label="kg DM/ha" unit="kg DM/ha" />
          {value !== "" && parseCover(value) === null ? <p role="alert">A whole number from 0 to 20,000.</p> : null}
        </Step>
      );
    }
    case "method":
      return (
        <Step {...frame} question="How was it measured?">
          <Choices
            options={PASTURE_METHODS.map((method) => ({ value: method, label: PASTURE_METHOD_LABELS[method] }))}
            value={answers.method}
            onPick={(method) => {
              set({ method });
              next();
            }}
          />
        </Step>
      );
    case "day":
      return (
        <Step {...frame} question={flow.kind === "in" ? "Which day did they go in?" : flow.kind === "out" ? "Which day did they come out?" : flow.kind === "feed" ? "Which day was it fed?" : "Which day was it read?"} onNext={next}>
          <DayChoice value={answers.day} onChange={(day) => set({ day })} />
        </Step>
      );
    case "mob": {
      const names = new Map<string, number | null>();
      for (const entry of recentGrazings.data?.grazings ?? []) if (!names.has(entry.mob)) names.set(entry.mob, entry.head);
      return (
        <Step {...frame} question="Which mob?" onNext={next} nextDisabled={!answers.mob.trim()}>
          <Choices
            options={[...names.entries()].slice(0, 8).map(([name, head]) => ({ value: name, label: name, note: head ? `${head.toLocaleString("en-NZ")} head last time` : undefined }))}
            value={answers.mob || null}
            onPick={(mob) => {
              set({ mob, head: answers.head || String(names.get(mob) ?? "") });
              next();
            }}
          />
          <label style={{ display: "grid", gap: 4 }}>
            <span className={ui.muted}>Or another mob</span>
            <input value={answers.mob} maxLength={100} onChange={(event) => set({ mob: event.target.value })} />
          </label>
        </Step>
      );
    }
    case "head":
      return (
        <Step {...frame} question={`How many in ${answers.mob}?`} onNext={next} onSkip={() => (set({ head: "" }), next())} nextDisabled={answers.head !== "" && !/^\d{1,6}$/.test(answers.head)}>
          <BigNumber value={answers.head} onChange={(head) => set({ head })} label="Head" unit="head" />
        </Step>
      );
    case "feed": {
      const feeds = [...new Set((recentFeed.data?.supplements ?? []).map((line) => line.feed))].slice(0, 8);
      return (
        <Step {...frame} question="What was fed?" onNext={next} nextDisabled={!answers.feed.trim()}>
          <Choices
            options={feeds.map((feed) => ({ value: feed, label: feed }))}
            value={answers.feed || null}
            onPick={(feed) => {
              const last = (recentFeed.data?.supplements ?? []).find((line) => line.feed === feed);
              set({ feed, unit: last?.unit ?? answers.unit });
              next();
            }}
          />
          <label style={{ display: "grid", gap: 4 }}>
            <span className={ui.muted}>Or another feed</span>
            <input value={answers.feed} maxLength={100} onChange={(event) => set({ feed: event.target.value })} />
          </label>
        </Step>
      );
    }
    case "quantity":
      return (
        <Step {...frame} question={`How much ${answers.feed}?`} onNext={next} nextDisabled={!/^\d+(\.\d{1,2})?$/.test(answers.quantity.replace(/,/g, ""))}>
          <BigNumber value={answers.quantity} onChange={(quantity) => set({ quantity: quantity.replace(/,/g, "") })} label="Quantity" unit={SUPPLEMENT_UNIT_LABELS[answers.unit]} />
        </Step>
      );
    case "unit":
      return (
        <Step {...frame} question="In what?" onNext={next} nextDisabled={answers.unit !== "kg_dm" && answers.kgDm !== "" && !/^\d+(\.\d{1,2})?$/.test(answers.kgDm)}>
          <Choices options={SUPPLEMENT_UNITS.map((unit) => ({ value: unit, label: SUPPLEMENT_UNIT_LABELS[unit] }))} value={answers.unit} onPick={(unit) => set({ unit })} />
          {answers.unit !== "kg_dm" ? (
            <label style={{ display: "grid", gap: 4 }}>
              <span className={ui.muted}>kg DM, if you know it (only then is it added up)</span>
              <input inputMode="decimal" value={answers.kgDm} onChange={(event) => set({ kgDm: event.target.value })} />
            </label>
          ) : null}
        </Step>
      );
    default: {
      const lines: Array<[string, string]> = [["Farm", farm.name]];
      if (flow.kind === "cover") lines.push(["Paddock", paddock?.name ?? "–"], ["Cover", coverValue === null ? "–" : coverText(coverValue)], ["Measured by", PASTURE_METHOD_LABELS[answers.method]], ["Day", formatDate(answers.day)]);
      if (flow.kind === "in") lines.push(["Paddock", paddock?.name ?? "–"], ["Mob", mobText(answers.mob.trim(), Number(answers.head) || null)], ["Day in", formatDate(answers.day)], ["Cover before", answers.cover ? coverText(Number(answers.cover)) : "Not recorded"]);
      if (flow.kind === "out") lines.push(["Mob", grazing ? `${grazing.inNow!.mob} in ${grazing.name}` : "–"], ["Day out", formatDate(answers.day)], ["Cover after", answers.postCover ? coverText(Number(answers.postCover)) : "Not recorded"]);
      if (flow.kind === "feed") lines.push(["Feed", answers.feed], ["How much", `${answers.quantity} ${SUPPLEMENT_UNIT_LABELS[answers.unit]}${answers.unit !== "kg_dm" && answers.kgDm ? ` (${answers.kgDm} kg DM)` : ""}`], ["Paddock", paddocks.find((status) => status.paddockId === answers.paddockId)?.name ?? "None"], ["Day", formatDate(answers.day)]);
      const ready = flow.kind === "out" ? Boolean(grazing) : flow.kind === "feed" ? Boolean(answers.feed.trim() && answers.quantity) : Boolean(paddock) && (flow.kind !== "cover" || coverValue !== null) && (flow.kind !== "in" || Boolean(answers.mob.trim()));
      return (
        <Step {...frame} question="Check and save" onNext={save} nextLabel="Save" nextDisabled={!ready}>
          <dl className={styles.facts}>
            {lines.map(([label, value]) => (
              <div key={label} style={{ display: "contents" }}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        </Step>
      );
    }
  }
}

// The farm walk ------------------------------------------------------------------------------------------------

function FarmWalk({ organisationId, farm, onClose }: FarmContext & { onClose: () => void }) {
  const today = todayInBrowser();
  const { store, change, sync, stored, retryStorage } = useFarmDrafts(organisationId);
  const statuses = useApiData<{ paddocks: PaddockStatus[] }>(`/api/farming/farms/${farm.id}/paddock-status`, { organisationId, onDate: today });
  const walk = openWalk(store, farm.id);
  const [method, setMethod] = useState<PastureMethod>("plate_meter");
  const [day, setDay] = useState(today);
  const [typed, setTyped] = useState<{ key: string; value: string } | null>(null);

  if (!walk) {
    return (
      <Card title={`Farm walk · ${farm.name}`} description="A cover for each paddock, in order. Each one is saved on this phone as you go, and sent when there's a signal. You can close the app and carry on later.">
        <h3>How are you measuring?</h3>
        <Choices options={PASTURE_METHODS.map((value) => ({ value, label: PASTURE_METHOD_LABELS[value] }))} value={method} onPick={setMethod} />
        <h3>Which day?</h3>
        <DayChoice value={day} onChange={setDay} />
        <div className={styles.actions}>
          <Button variant="secondary" onClick={onClose}>
            Back
          </Button>
          <Button
            disabled={!statuses.data?.paddocks.length}
            onClick={() => {
              const order = [...(statuses.data?.paddocks ?? [])].sort((a, b) => NATURAL.compare(a.name, b.name)).map((status) => ({ paddockId: status.paddockId, name: status.name }));
              const started: Walk = { walkId: operationId(), farmId: farm.id, farmName: farm.name, measuredOn: day, method, order, position: 0, startedAt: new Date().toISOString(), finishedAt: null };
              change((current) => startWalk(current, started));
            }}
          >
            Start the walk
          </Button>
        </div>
      </Card>
    );
  }

  const walkDrafts = store.drafts.filter((draft) => draft.walkId === walk.walkId);
  const finish = () => {
    change((current) => moveWalk(current, walk.walkId, walk.order.length, new Date().toISOString()));
    void sync();
  };

  if (walk.position >= walk.order.length) {
    return (
      <Card title={`Farm walk · ${farm.name}`} description={`${walkDrafts.length} reading${walkDrafts.length === 1 ? "" : "s"}, ${formatDate(walk.measuredOn)}, ${PASTURE_METHOD_LABELS[walk.method as PastureMethod] ?? walk.method}.`}>
        <StorageWarning stored={stored} waiting={walkDrafts.filter((draft) => draft.status === "saved").length} onRetry={retryStorage} onSend={() => void sync()} />
        <DraftList drafts={walkDrafts} stored={stored} />
        <div className={styles.actions}>
          <Button variant="secondary" onClick={() => change((current) => moveWalk(current, walk.walkId, walk.order.length - 1))}>
            Back to the last paddock
          </Button>
          <Button onClick={finish}>Finish the walk</Button>
        </div>
      </Card>
    );
  }

  const paddock = walk.order[walk.position];
  const status = statuses.data?.paddocks.find((entry) => entry.paddockId === paddock.paddockId);
  const draft = walkReading(store, walk.walkId, paddock.paddockId);
  const key = `${walk.walkId}:${paddock.paddockId}`;
  const value = typed?.key === key ? typed.value : draft ? String(draft.payload.cover) : "";
  const cover = parseCover(value);
  const go = (position: number) => {
    setTyped(null);
    change((current) => moveWalk(current, walk.walkId, position));
  };
  const saveAndNext = () => {
    if (cover === null) return;
    // Saved on the phone straight away (decision 911), then sent when it can be.
    change((current) => moveWalk(saveWalkReading(current, walk, paddock, cover, operationId, new Date().toISOString()), walk.walkId, walk.position + 1));
    setTyped(null);
    void sync();
  };
  const done = walkDrafts.length;
  return (
    <Card
      title={`Farm walk · Paddock ${paddock.name}`}
      description={`${walk.position + 1} of ${walk.order.length} · ${done} saved · ${formatDate(walk.measuredOn)}, ${PASTURE_METHOD_LABELS[walk.method as PastureMethod] ?? walk.method}`}
    >
      <StorageWarning stored={stored} waiting={walkDrafts.filter((entry) => entry.status === "saved").length} onRetry={retryStorage} onSend={() => void sync()} />
      <form
        style={{ display: "grid", gap: 16 }}
        onSubmit={(event) => {
          event.preventDefault();
          saveAndNext();
        }}
      >
        {status?.cover ? (
          <p className={ui.muted}>
            Last: {coverText(status.cover.cover)} on {shortDate(status.cover.measuredOn, today)}
            {status.inNow ? ` · ${status.inNow.mob} in now` : ""}
          </p>
        ) : null}
        <BigNumber key={key} value={value} onChange={(text) => setTyped({ key, value: text })} label="Cover" unit="kg DM/ha" />
        {value !== "" && cover === null ? <p role="alert">A whole number from 0 to 20,000.</p> : null}
        {draft ? (
          <p>
            {draft.label} <StatusBadge status={draft.status} stored={stored} />
            {draft.error ? <span className={ui.muted}> {draft.error}</span> : null}
          </p>
        ) : null}
        <div className={styles.actions}>
          <Button type="submit" disabled={cover === null}>
            Save and next
          </Button>
          <Button variant="secondary" onClick={() => go(walk.position + 1)}>
            Skip
          </Button>
          <Button variant="secondary" disabled={walk.position === 0} onClick={() => go(walk.position - 1)}>
            Back
          </Button>
          <Button variant="secondary" onClick={() => go(walk.order.length)}>
            Finish
          </Button>
          <Button variant="secondary" onClick={onClose}>
            Leave for now
          </Button>
        </div>
      </form>
    </Card>
  );
}
