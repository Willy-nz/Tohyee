"use client";

import { useEffect, useState } from "react";
import { DateInput } from "@/components/date-input";
import { EnteredLine, newOperationId, SafetyHistory } from "@/components/farm-safety";
import { useApiData } from "@/components/hooks";
import { Badge, Button, Card, Empty, Field, Notice, ui } from "@/components/ui";
import { type PickedFile, pickSafetyFile, QueuedWork, submitThroughQueue, useOfflineQueue, waitForFiles } from "@/components/offline-queue";
import { useOnline } from "@/components/offline-support";
import { placeText } from "@/lib/offline/photos";
import { nativePhoto } from "@/lib/native/camera";
import { useNativeFeatures } from "@/components/native-app";
import { useWorkspace } from "@/components/workspace";
import { api, errorMessage } from "@/lib/client/api";
import type { Farm, Paddock } from "@/lib/farming/paddocks";
import { formatDate, formatDateTime, todayInBrowser } from "@/lib/format";
import type { ReportView } from "@/lib/safety/reports";
import { createFormMemory, formMemoryKey, recordAnchor, unansweredQuestions } from "@/lib/safety/screens";
import {
  ACTION_STATE_LABELS,
  type ActionData,
  actionState,
  ASSIGNED_NOT_TOLD,
  type CurrentRecord,
  FIXED_NUMBERS,
  mayBeNotifiable,
  NOTIFIABLE_QUESTIONS,
  notifiableKeepText,
  type NotifiableAnswers,
  NOBODY_MESSAGED,
  type Position,
  REPORT_TYPE_LABELS,
  REPORTED_ACCOUNT,
  reportStateText,
  type ReportType,
  type SafetyAccess,
  SEVERITIES,
  SEVERITY_LABELS,
  type Severity,
  sentLaterText,
  SITE_EXCEPTIONS,
  WORKSAFE_NOTIFIABLE_GUIDE_URL,
  WORKSAFE_NOTIFY_URL,
} from "@/lib/safety/shared";
import styles from "./farm-safety.module.css";

/*
 * Reporting a hazard, near miss or incident on a phone, and following it
 * through: restricted injury details, WorkSafe's questions, photos with
 * their own dates, and actions to a checked close (#446, decisions
 * 942-947). Reports are saved on the phone first and sent once.
 */

type Person = { userId: string; name: string; role: string };
export type ReportsData = { reports: ReportView[]; otherActions: Array<CurrentRecord<ActionData>>; access: SafetyAccess; people: Person[] };

/** A farm's reports, actions and people, for the Safety page. */
export function useReports(organisationId: string, farmId: string, includeWithdrawn: boolean) {
  return useApiData<ReportsData>("/api/farming/safety/reports", { organisationId, farmId, includeWithdrawn });
}

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

const tel = (phone: string) => `tel:${phone.replace(/[^0-9+]/g, "")}`;

/** WorkSafe's prompt when an answer says it may be notifiable (decision 943). Tohyee never notifies itself. */
export function NotifiablePrompt() {
  return (
    <div role="alert" style={{ border: "2px solid var(--danger, #c81e1e)", borderRadius: 8, padding: 12, margin: "8px 0" }}>
      <strong>This may need to be told to WorkSafe as soon as possible.</strong>
      <ul style={{ margin: "6px 0", paddingLeft: 20 }}>
        <li>
          If someone has died, phone WorkSafe straight away on{" "}
          <a href={tel(FIXED_NUMBERS[1].phone)} style={{ fontWeight: 700 }}>
            {FIXED_NUMBERS[1].phone}
          </a>{" "}
          (24 hours). In an emergency, 111 first.
        </li>
        <li>
          Otherwise use{" "}
          <a href={WORKSAFE_NOTIFY_URL} target="_blank" rel="noreferrer">
            Notify WorkSafe
          </a>
          , which asks the questions that decide it.
        </li>
        <li>
          Leave the site as it is until WorkSafe says otherwise. You may disturb it only:
          <ul style={{ margin: "2px 0", paddingLeft: 20 }}>
            {SITE_EXCEPTIONS.map((exception) => (
              <li key={exception}>{exception}</li>
            ))}
          </ul>
        </li>
        <li>{notifiableKeepText(null)}</li>
      </ul>
      <span className={ui.muted}>Tohyee doesn&apos;t tell WorkSafe for you. When you have, record it on the report.</span>
    </div>
  );
}

/**
 * Photo picker (decision 1012): each photo is kept as soon as it's chosen,
 * as a compressed copy with the phone's time and, if asked, where it was
 * taken. With no connection it's kept on this device and sent before the
 * record that uses it.
 */
export function PhotoPicker({ organisationId, farmId, farmName = "", restricted = false, files, onChange, label = "Photos" }: { organisationId: string; farmId: string; farmName?: string; restricted?: boolean; files: PickedFile[]; onChange: (files: PickedFile[]) => void; label?: string }) {
  const { busy, error, run } = useRun();
  const { queue } = useOfflineQueue(organisationId);
  const [withPlace, setWithPlace] = useState(false);
  const pending = files.filter((file) => file.pending).length;
  const native = useNativeFeatures();
  const takeNative = (source: "camera" | "gallery") =>
    void run(
      async () => {
        const photo = await nativePhoto(source);
        if (!photo) return null;
        return pickSafetyFile(queue, { farm: { id: farmId, name: farmName }, file: photo.file, restricted, place: withPlace, cameraPlace: photo.exifPlace, chosen: source === "gallery" });
      },
      (file) => {
        if (file) onChange([...files, file]);
      },
    );
  return (
    <div style={{ margin: "8px 0" }}>
      {native.camera ? (
        // The Android app: its own camera and photo picker (#502, decision 1149), into the same path as a browser's file.
        <div className={ui.fieldLabel} role="group" aria-label={label}>
          {label}
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 4 }}>
            <Button type="button" variant="secondary" disabled={busy} onClick={() => takeNative("camera")}>
              Take a photo
            </Button>
            <Button type="button" variant="secondary" disabled={busy} onClick={() => takeNative("gallery")}>
              Choose a photo
            </Button>
          </div>
        </div>
      ) : (
      <label className={ui.fieldLabel}>
        {label}
        <input
          type="file"
          accept="image/jpeg,image/png,image/webp"
          capture="environment"
          disabled={busy}
          style={{ display: "block", marginTop: 4 }}
          onChange={(event) => {
            const chosen = event.target.files?.[0];
            event.target.value = "";
            if (!chosen) return;
            void run(
              () => pickSafetyFile(queue, { farm: { id: farmId, name: farmName }, file: chosen, restricted, place: withPlace }),
              (file) => onChange([...files, file]),
            );
          }}
        />
      </label>
      )}
      <label className={styles.check}>
        <input type="checkbox" checked={withPlace} onChange={(event) => setWithPlace(event.target.checked)} /> Add where I am to the photo
      </label>
      {busy ? <p className={ui.muted}>Keeping the photo…</p> : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
      {files.length ? (
        <p className={ui.muted}>
          {files.length} photo{files.length === 1 ? "" : "s"} kept{pending ? ` (${pending} on this device, sent with the record)` : ""}{files.some((file) => file.photoTaken) ? `; camera date ${files.find((file) => file.photoTaken)?.photoTaken}` : ""}.
        </p>
      ) : null}
    </div>
  );
}

export function Thumbnails({ organisationId, files }: { organisationId: string; files: PickedFile[] }) {
  if (!files.length) return null;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 8, margin: "6px 0" }}>
      {files.map((file) => {
        if (file.pending) {
          return (
            <span key={file.id} className={styles.pendingPhoto}>
              Photo on this device
            </span>
          );
        }
        const href = `/api/farming/safety/files/${file.id}?organisationId=${encodeURIComponent(organisationId)}`;
        return (
          <a key={file.id} href={href} target="_blank" rel="noreferrer" title={`Received ${formatDateTime(file.receivedAt)}${file.photoTaken ? `; camera date ${file.photoTaken}` : ""}${file.phoneFileTime ? `; phone time ${formatDateTime(file.phoneFileTime)}` : ""}${file.place ? `; where the phone said: ${placeText(file.place)}` : ""}`}>
            {/* eslint-disable-next-line @next/next/no-img-element -- a private, signed-in file; next/image would cache it */}
            <img src={href} alt={`${file.name}${file.restricted ? " (restricted)" : ""}`} style={{ width: 88, height: 88, objectFit: "cover", borderRadius: 6, border: file.restricted ? "2px solid var(--danger, #c81e1e)" : "1px solid var(--border)" }} />
          </a>
        );
      })}
    </div>
  );
}

// Reporting ----------------------------------------------------------------------------------------

/**
 * Report something (decision 980): choose what it is with large buttons,
 * then a short first step (photo, what, where, what happened) and a second
 * with the follow-up questions.
 */
export function ReportSomething({ organisationId, farm, paddocks, people, access, onSent }: { organisationId: string; farm: Farm; paddocks: Paddock[]; people: Person[]; access: SafetyAccess; onSent: () => void }) {
  const { user } = useWorkspace();
  const [type, setType] = useState<ReportType | null>(() => (typeof window === "undefined" ? null : memory.read<{ type: ReportType }>(memoryKey(user.id, organisationId, farm.id, "type"))?.type ?? null));
  const [result, setResult] = useState<{ tone: "success" | "warning" | "error"; text: string; notifiable: boolean } | null>(null);
  const choose = (next: ReportType | null) => {
    setType(next);
    if (next) memory.write(memoryKey(user.id, organisationId, farm.id, "type"), { type: next });
    else memory.clear(memoryKey(user.id, organisationId, farm.id, "type"));
  };
  if (!access.canReport) return <Notice tone="info">Your role on {farm.name} doesn&apos;t record safety reports. Tell the farm manager, or phone 111 in an emergency.</Notice>;
  return (
    <Card title={type ? REPORT_TYPE_LABELS[type] : "What are you reporting?"} description={`On ${farm.name}. It's saved on this phone first, then sent.`}>
      {result ? (
        <>
          <Notice tone={result.tone}>{result.text}</Notice>
          {result.notifiable ? <NotifiablePrompt /> : null}
        </>
      ) : null}
      {type ? (
        <ReportForm
          key={type}
          organisationId={organisationId}
          farm={farm}
          type={type}
          paddocks={paddocks}
          people={people}
          onCancel={() => choose(null)}
          onDone={(outcome) => {
            choose(null);
            setResult(outcome);
            onSent();
          }}
        />
      ) : (
        <div className={styles.typeChoices}>
          {(["hazard", "near_miss", "incident"] as const).map((each) => (
            <button key={each} type="button" className={styles.typeChoice} data-type={each} onClick={() => { setResult(null); choose(each); }}>
              <strong>{REPORT_TYPE_LABELS[each]}</strong>
              <small>{each === "hazard" ? "Something that could hurt someone" : each === "near_miss" ? "It nearly hurt someone" : "Someone was hurt or made ill, or damage was done"}</small>
            </button>
          ))}
        </div>
      )}
    </Card>
  );
}

/** Half-filled reports, kept in this tab while the person moves around Safety (decision 985). */
const memory = createFormMemory(() => (typeof window === "undefined" ? null : window.sessionStorage));
const memoryKey = (userId: string, organisationId: string, farmId: string, form: string) => formMemoryKey({ userId, organisationId, farmId, form: `report.${form}` });

type ReportDraftForm = { title: string; happenedOn: string; time: string; whatHappened: string; where: string; paddockIds: string[]; immediateAction: string; severity: Severity };
type ReportMemory = { operationId: string; step: 1 | 2; form: ReportDraftForm; point: Position | null; photos: PickedFile[]; injured: boolean; details: { injuredPerson: string; injury: string; treatment: string }; detailPhotos: PickedFile[]; answers: NotifiableAnswers; action: { title: string; assignedToUserId: string; assignedToName: string; due: string } };

export function ReportForm({ organisationId, farm, type, paddocks, people, onCancel, onDone }: { organisationId: string; farm: Farm; type: ReportType; paddocks: Paddock[]; people: Person[]; onCancel: () => void; onDone: (outcome: { tone: "success" | "warning" | "error"; text: string; notifiable: boolean }) => void }) {
  const { user } = useWorkspace();
  const key = memoryKey(user.id, organisationId, farm.id, type);
  const [kept] = useState(() => memory.read<ReportMemory>(key));
  // The same id after moving away and back, so the report is still kept once (decision 933).
  const [operationId] = useState(() => kept?.operationId ?? newOperationId());
  const [step, setStep] = useState<1 | 2>(kept?.step ?? 1);
  const [form, setForm] = useState<ReportDraftForm>(kept?.form ?? { title: "", happenedOn: todayInBrowser(), time: "", whatHappened: "", where: "", paddockIds: [], immediateAction: "", severity: type === "incident" ? "moderate" : "minor" });
  const [point, setPoint] = useState<Position | null>(kept?.point ?? null);
  const [photos, setPhotos] = useState<PickedFile[]>(kept?.photos ?? []);
  const [injured, setInjured] = useState(kept?.injured ?? type === "incident");
  const [details, setDetails] = useState(kept?.details ?? { injuredPerson: "", injury: "", treatment: "" });
  const [detailPhotos, setDetailPhotos] = useState<PickedFile[]>(kept?.detailPhotos ?? []);
  const { queue } = useOfflineQueue(organisationId);
  const [problem, setProblem] = useState<string | null>(null);
  const [answers, setAnswers] = useState<NotifiableAnswers>(kept?.answers ?? {});
  const [action, setAction] = useState(kept?.action ?? { title: "", assignedToUserId: "", assignedToName: "", due: "" });
  const [locating, setLocating] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Whether this tab is holding the half-filled report; said truthfully (decision 985).
  const [held, setHeld] = useState<boolean | null>(kept ? true : null);
  const notifiable = mayBeNotifiable(answers);
  const unanswered = type === "hazard" ? 0 : unansweredQuestions(NOTIFIABLE_QUESTIONS.map((question) => question.key), answers);
  useEffect(() => {
    const started = form.title || form.whatHappened || form.where || photos.length || form.immediateAction;
    if (!started) return;
    const value: ReportMemory = { operationId, step, form, point, photos, injured, details, detailPhotos, answers, action };
    const ok = memory.write(key, value);
    let current = true;
    // Shown after the write, as the browser's answer about it.
    void Promise.resolve().then(() => {
      if (current) setHeld(ok);
    });
    return () => {
      current = false;
    };
  }, [key, operationId, step, form, point, photos, injured, details, detailPhotos, answers, action]);
  const locate = () => {
    if (!navigator.geolocation) return setLocating("This phone can't share its location.");
    setLocating("Finding where you are…");
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setLocating("Your place is marked.");
        setPoint([position.coords.longitude, position.coords.latitude]);
      },
      () => setLocating("The location wasn't shared."),
      { enableHighAccuracy: true, timeout: 15_000 },
    );
  };
  const submit = async () => {
    setBusy(true);
    setProblem(null);
    const body: Record<string, unknown> = {
      farmId: farm.id,
      type,
      ...form,
      time: form.time || null,
      point,
      injured,
      notifiable: answers,
      files: photos.map((file) => ({ id: file.id })),
      details: injured ? { ...details, files: detailPhotos.map((file) => ({ id: file.id })) } : undefined,
      action: action.title ? { title: action.title, assignedToUserId: action.assignedToUserId || null, assignedToName: action.assignedToUserId ? null : action.assignedToName || null, due: action.due || null } : undefined,
      // When it was saved here: if it waits for a connection, both times show (#491).
      phoneTime: new Date().toISOString(),
    };
    // Kept on this device first, then sent once (decisions 944 and 1010); photos still on the device go first.
    const refs = [...waitForFiles(photos, ["files"]), ...(injured ? waitForFiles(detailPhotos, ["details", "files"]) : [])];
    try {
      const outcome = await submitThroughQueue(queue, { operationId, kind: "safety.report", label: `${REPORT_TYPE_LABELS[type]}: ${form.title}`, farmId: farm.id, farmName: farm.name, request: { method: "POST", path: "/api/farming/safety/reports", body, refs } });
      memory.clear(key);
      if (outcome.state === "synced") onDone({ tone: "success", text: `Recorded for ${farm.name}. ${NOBODY_MESSAGED}${notifiable ? " Tohyee hasn't told WorkSafe." : ""}`, notifiable });
      else if (outcome.state === "waiting") onDone({ tone: "warning", text: `Saved on this device, waiting to send. Nobody has been told yet. It goes by itself when Tohyee can be reached.${notifiable ? " Tohyee never tells WorkSafe." : ""}`, notifiable });
      else onDone({ tone: "warning", text: "This device's storage wouldn't keep it. Keep Tohyee open until it shows Synced below, or write it down.", notifiable });
    } catch (caught) {
      setProblem(`Not recorded: ${errorMessage(caught)}`);
    } finally {
      setBusy(false);
    }
  };
  const cancel = () => {
    const started = form.title || form.whatHappened || form.where || photos.length;
    if (started && !window.confirm("Throw away this report? It hasn't been sent.")) return;
    memory.clear(key);
    onCancel();
  };
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (step === 1) setStep(2);
        else void submit();
      }}
      aria-label={REPORT_TYPE_LABELS[type]}
    >
      <p style={{ marginTop: 0 }}>
        <Badge tone={type === "incident" ? "red" : type === "near_miss" ? "amber" : "neutral"}>{REPORT_TYPE_LABELS[type]}</Badge> on <strong>{farm.name}</strong> · step {step} of 2
      </p>
      <p className={ui.muted} role="status" style={{ marginTop: 0, fontSize: "var(--text-sm)" }}>
        {held === null ? "Not sent yet." : held ? "Not sent yet. Kept in this browser tab while you move around Safety." : "Not sent yet, and this browser isn't keeping a copy: stay on this screen until it's saved."}
      </p>
      {problem ? <Notice tone="error">{problem}</Notice> : null}
      {step === 1 ? (
        <>
          <PhotoPicker organisationId={organisationId} farmId={farm.id} farmName={farm.name} files={photos} onChange={setPhotos} label="Photo (take it now if you can)" />
          <Field label="What it was, in a few words">
            <input value={form.title} required maxLength={150} onChange={(event) => setForm({ ...form, title: event.target.value })} />
          </Field>
          <Field label="Where">
            <input value={form.where} maxLength={300} onChange={(event) => setForm({ ...form, where: event.target.value })} placeholder="e.g. the yard gate by the shed" />
          </Field>
          <div className={ui.actions} style={{ justifyContent: "flex-start" }}>
            <Button variant="secondary" onClick={locate}>
              Where I am now
            </Button>
            {point ? (
              <Button variant="secondary" onClick={() => { setPoint(null); setLocating(null); }}>
                Clear place
              </Button>
            ) : null}
          </div>
          {locating || point ? <p className={ui.muted}>{locating ?? "Your place is marked."}</p> : null}
          {paddocks.length ? (
            <Field label="Paddock">
              <select value={form.paddockIds[0] ?? ""} onChange={(event) => setForm({ ...form, paddockIds: event.target.value ? [event.target.value] : [] })}>
                <option value="">Not in a paddock / not sure</option>
                {paddocks.filter((paddock) => paddock.status === "active").map((paddock) => (
                  <option key={paddock.id} value={paddock.id}>
                    {paddock.name}
                  </option>
                ))}
              </select>
            </Field>
          ) : null}
          <Field label="What happened">
            <textarea value={form.whatHappened} rows={3} maxLength={4000} onChange={(event) => setForm({ ...form, whatHappened: event.target.value })} />
          </Field>
          <div className={ui.inlineForm}>
            <Field label="When">
              <DateInput value={form.happenedOn} max={todayInBrowser()} onChange={(event) => setForm({ ...form, happenedOn: event.target.value })} />
            </Field>
            <Field label="Time">
              <input type="time" value={form.time} onChange={(event) => setForm({ ...form, time: event.target.value })} />
            </Field>
          </div>
          <div className={ui.actions}>
            <Button type="submit" disabled={!form.title.trim()}>
              Next: a few more questions
            </Button>
            <Button variant="secondary" onClick={cancel}>
              Cancel
            </Button>
          </div>
        </>
      ) : (
        <>
          <p style={{ margin: "0 0 8px" }}>
            <strong>{form.title}</strong>
            {form.where ? <span className={ui.muted}> · {form.where}</span> : null}{" "}
            <Button variant="secondary" size="small" onClick={() => setStep(1)}>
              Change
            </Button>
          </p>
          <Field label="What was done straight away">
            <textarea value={form.immediateAction} rows={2} maxLength={2000} onChange={(event) => setForm({ ...form, immediateAction: event.target.value })} />
          </Field>
          <Field label="How bad">
            <select value={form.severity} onChange={(event) => setForm({ ...form, severity: event.target.value as Severity })}>
              {SEVERITIES.map((severity) => (
                <option key={severity} value={severity}>
                  {SEVERITY_LABELS[severity]}
                </option>
              ))}
            </select>
          </Field>
          {type !== "hazard" ? (
            <>
              <label className={ui.checkbox} style={{ minHeight: 44 }}>
                <input type="checkbox" checked={injured} onChange={(event) => setInjured(event.target.checked)} /> Someone was hurt or made ill
              </label>
              {injured ? (
                <fieldset style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 10, margin: "8px 0" }}>
                  <legend className={ui.fieldLabel}>Injury details (restricted)</legend>
                  <p className={ui.muted} style={{ marginTop: 0 }}>
                    Only you, the owner and people the owner chooses see these. The rest of the farm team sees the report without them.
                  </p>
                  <Field label="Who">
                    <input value={details.injuredPerson} maxLength={150} onChange={(event) => setDetails({ ...details, injuredPerson: event.target.value })} />
                  </Field>
                  <Field label="Injury or illness">
                    <textarea value={details.injury} rows={2} maxLength={2000} onChange={(event) => setDetails({ ...details, injury: event.target.value })} />
                  </Field>
                  <Field label="Treatment">
                    <textarea value={details.treatment} rows={2} maxLength={2000} onChange={(event) => setDetails({ ...details, treatment: event.target.value })} />
                  </Field>
                  <PhotoPicker organisationId={organisationId} farmId={farm.id} farmName={farm.name} restricted files={detailPhotos} onChange={setDetailPhotos} label="Photo of the injury (restricted)" />
                </fieldset>
              ) : null}
              {notifiable ? <NotifiablePrompt /> : null}
              <fieldset style={{ border: 0, padding: 0, margin: "8px 0" }}>
                <legend className={ui.fieldLabel}>WorkSafe&apos;s questions</legend>
                <p className={ui.muted} style={{ margin: "0 0 6px", fontSize: "var(--text-sm)" }}>
                  From WorkSafe&apos;s quick guide.{" "}
                  <a href={WORKSAFE_NOTIFIABLE_GUIDE_URL} target="_blank" rel="noreferrer">
                    Check WorkSafe&apos;s current guide
                  </a>{" "}
                  if you&apos;re not sure. A question left unanswered is kept as not answered, not as No.
                </p>
                {NOTIFIABLE_QUESTIONS.map((question) => (
                  <fieldset key={question.key} className={styles.question}>
                    <legend>{question.text}</legend>
                    <div className={styles.choices}>
                      {([true, false] as const).map((value) => (
                        <label key={String(value)} className={styles.choice} data-result={value ? "yes" : "no"}>
                          <input type="radio" name={`${operationId}-${question.key}`} checked={answers[question.key] === value} onChange={() => setAnswers({ ...answers, [question.key]: value })} />
                          <span>{value ? "Yes" : "No"}</span>
                        </label>
                      ))}
                      {answers[question.key] !== undefined ? (
                        <button type="button" className={ui.linkButton} onClick={() => { const next = { ...answers }; delete next[question.key]; setAnswers(next); }}>
                          Clear
                        </button>
                      ) : null}
                    </div>
                  </fieldset>
                ))}
                {unanswered ? <p className={ui.muted}>{unanswered} not answered yet.</p> : null}
              </fieldset>
            </>
          ) : null}
          <details>
            <summary>Who&apos;ll put it right (optional; it can be added later)</summary>
            <Field label="What needs doing">
              <input value={action.title} maxLength={200} onChange={(event) => setAction({ ...action, title: event.target.value })} />
            </Field>
            {action.title ? (
              <div className={ui.inlineForm}>
                <Field label="Who">
                  <select value={action.assignedToUserId} onChange={(event) => setAction({ ...action, assignedToUserId: event.target.value })}>
                    <option value="">Someone without a login…</option>
                    {people.map((person) => (
                      <option key={person.userId} value={person.userId}>
                        {person.name}
                      </option>
                    ))}
                  </select>
                </Field>
                {!action.assignedToUserId ? (
                  <Field label="Their name">
                    <input value={action.assignedToName} maxLength={150} onChange={(event) => setAction({ ...action, assignedToName: event.target.value })} />
                  </Field>
                ) : null}
                <Field label="By">
                  <DateInput value={action.due} onChange={(event) => setAction({ ...action, due: event.target.value })} />
                </Field>
              </div>
            ) : null}
          </details>
          <div className={ui.actions}>
            <Button type="submit" disabled={busy || !form.title.trim()}>
              {busy ? "Saving…" : `Save the report for ${farm.name}`}
            </Button>
            <Button variant="secondary" disabled={busy} onClick={() => setStep(1)}>
              Back
            </Button>
          </div>
        </>
      )}
    </form>
  );
}

/** Safety recorded on this device and not yet in Tohyee (decisions 944, 1009): reports, checks, sign-offs, sign-ins and photos. */
export function WaitingToSend({ organisationId, farmId, onSent }: { organisationId: string; farmId: string; onSent: () => void }) {
  return <QueuedWork organisationId={organisationId} farmId={farmId} kinds={["safety."]} title="Safety recorded on this device" onSynced={onSent} />;
}

// Following reports through -------------------------------------------------------------------------------

export function ReportsCard({
  organisationId,
  data,
  openReport = null,
  paddockNames,
  showWithdrawn,
  onShowWithdrawn,
  onChanged,
}: {
  organisationId: string;
  data: ReportsData;
  /** A report to open, from a link (Today, Needs doing). */
  openReport?: string | null;
  paddockNames: ReadonlyMap<string, string>;
  showWithdrawn: boolean;
  onShowWithdrawn: (value: boolean) => void;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState<string | null>(openReport);
  const { reports, access, people } = data;
  const openCount = reports.filter((report) => report.state === "open" || report.state === "actions").length;
  return (
    <>
      <Card title={`Reports (${openCount} open)`} description="Hazards spotted, near misses and incidents, newest first, with what's being done about them.">
        {!reports.length ? <Empty>Nothing reported on this farm yet.</Empty> : null}
        <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
          {reports.map((report) => (
            <li key={report.recordId} id={recordAnchor("report", report.recordId)} style={{ borderTop: "1px solid var(--border)", padding: "10px 0", scrollMarginTop: 72 }}>
              <button type="button" className={ui.linkButton} style={{ fontWeight: 600, textAlign: "left" }} aria-expanded={open === report.recordId} onClick={() => setOpen(open === report.recordId ? null : report.recordId)}>
                {report.data.title}
              </button>{" "}
              <Badge tone={report.data.type === "incident" ? "red" : report.data.type === "near_miss" ? "amber" : "neutral"}>{REPORT_TYPE_LABELS[report.data.type]}</Badge>{" "}
              <Badge tone={report.state === "closed" ? "green" : report.state === "withdrawn" ? "neutral" : "blue"}>{reportStateText(report.state, report.actions)}</Badge>
              {report.mayBeNotifiable && !report.data.workSafeNotified ? (
                <>
                  {" "}
                  <Badge tone="red">May need notifying</Badge>
                </>
              ) : null}
              <div className={ui.muted} style={{ fontSize: "var(--text-sm)" }}>
                {report.happenedOn ? formatDate(report.happenedOn) : ""}
                {report.data.time ? ` ${report.data.time}` : ""} · {SEVERITY_LABELS[report.data.severity]} · {report.actions.filter((action) => action.change !== "withdrawn").length} action(s)
              </div>
              {open === report.recordId ? <ReportDetail organisationId={organisationId} report={report} access={access} people={people} paddockNames={paddockNames} onChanged={onChanged} /> : null}
            </li>
          ))}
        </ul>
        <label className={ui.checkbox} style={{ marginTop: 8 }}>
          <input type="checkbox" checked={showWithdrawn} onChange={(event) => onShowWithdrawn(event.target.checked)} /> Show reports withdrawn as mistakes
        </label>
      </Card>
      {data.otherActions.length ? (
        <Card title={`Other actions (${data.otherActions.length})`} description="Actions on a hazard, from a failed pre-start check, or on their own, not yet checked and closed.">
          <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {data.otherActions.map((each) => (
              <ActionRow key={each.recordId} organisationId={organisationId} action={each} access={access} people={people} onChanged={onChanged} />
            ))}
          </ul>
        </Card>
      ) : null}
    </>
  );
}

function ReportDetail({ organisationId, report, access, people, paddockNames, onChanged }: { organisationId: string; report: ReportView; access: SafetyAccess; people: Person[]; paddockNames: ReadonlyMap<string, string>; onChanged: () => void }) {
  const [step, setStep] = useState<"worksafe" | "close" | "withdraw" | "action" | null>(null);
  const [form, setForm] = useState({ on: todayInBrowser(), how: "phone", reference: "", why: "" });
  const [action, setAction] = useState({ title: "", assignedToUserId: "", assignedToName: "", due: "" });
  const [operationId, setOperationId] = useState(newOperationId);
  const { busy, error, run } = useRun();
  const live = report.state !== "closed" && report.state !== "withdrawn";
  const send = (path: string, body: Record<string, unknown>) =>
    void run(
      () => api(path, { method: "POST", body: { organisationId, operationId, ...body } }),
      () => {
        setStep(null);
        setOperationId(newOperationId());
        onChanged();
      },
    );
  const reportFiles = report.files.filter((file) => !file.restricted);
  const detailFiles = report.files.filter((file) => file.restricted);
  return (
    <div style={{ marginTop: 8 }}>
      <p style={{ margin: "4px 0" }}>
        <EnteredLine record={report} />
        {sentLaterText(report.data.phoneTime, report.firstEnteredAt, formatDateTime) ? (
          <>
            <br />
            <span className={ui.muted}>{sentLaterText(report.data.phoneTime, report.firstEnteredAt, formatDateTime)}</span>
          </>
        ) : null}
      </p>
      <p className={ui.muted} style={{ margin: "4px 0" }}>
        {REPORTED_ACCOUNT}
      </p>
      <dl style={{ display: "grid", gridTemplateColumns: "minmax(100px, max-content) 1fr", gap: "2px 12px", margin: "6px 0" }}>
        {(
          [
            ["What happened", report.data.whatHappened],
            ["Where", [report.data.where, report.data.paddockIds.map((id) => paddockNames.get(id) ?? id).join(", "), report.data.point ? "marked on the map" : null].filter(Boolean).join(" · ")],
            ["Done straight away", report.data.immediateAction],
            ["WorkSafe told", report.data.workSafeNotified ? `${formatDate(report.data.workSafeNotified.on)} by ${report.data.workSafeNotified.how}${report.data.workSafeNotified.reference ? `, reference ${report.data.workSafeNotified.reference}` : ""}` : null],
            ["Closed", report.data.closed?.why ?? null],
          ] as Array<[string, string | null]>
        )
          .filter(([, value]) => value)
          .map(([label, value]) => (
            <div key={label} style={{ display: "contents" }}>
              <dt className={ui.muted}>{label}</dt>
              <dd style={{ margin: 0, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{value}</dd>
            </div>
          ))}
      </dl>
      <Thumbnails organisationId={organisationId} files={reportFiles} />
      {report.details ? (
        <div style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 10, margin: "8px 0" }}>
          <strong>Injury details (restricted)</strong>
          <div>{[report.details.data.injuredPerson, report.details.data.injury, report.details.data.treatment, report.details.data.notes].filter(Boolean).join(" · ")}</div>
          <Thumbnails organisationId={organisationId} files={detailFiles} />
        </div>
      ) : report.detailsHidden ? (
        <p className={ui.muted}>Injury details are restricted: the owner chooses who sees them.</p>
      ) : null}
      {report.mayBeNotifiable && !report.data.workSafeNotified && live ? <NotifiablePrompt /> : null}
      {report.mayBeNotifiable && report.data.workSafeNotified ? <p className={ui.muted}>{notifiableKeepText(report.data.workSafeNotified, formatDate)}</p> : null}

      <h4 style={{ margin: "10px 0 4px" }}>Actions</h4>
      {!report.actions.length ? <p className={ui.muted}>None yet.</p> : <p className={ui.muted} style={{ margin: "0 0 4px" }}>{ASSIGNED_NOT_TOLD}</p>}
      <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
        {report.actions.map((each) => (
          <ActionRow key={each.recordId} organisationId={organisationId} action={each} access={access} people={people} onChanged={onChanged} />
        ))}
      </ul>

      {error ? <Notice tone="error">{error}</Notice> : null}
      {access.canRecord && live ? (
        <div className={ui.actions} style={{ justifyContent: "flex-start", flexWrap: "wrap", marginTop: 8 }}>
          <Button variant="secondary" size="small" aria-pressed={step === "action"} onClick={() => setStep(step === "action" ? null : "action")}>
            Add an action
          </Button>
          {report.mayBeNotifiable || report.data.type === "incident" ? (
            <Button variant="secondary" size="small" aria-pressed={step === "worksafe"} onClick={() => setStep(step === "worksafe" ? null : "worksafe")}>
              Record telling WorkSafe
            </Button>
          ) : null}
          <Button variant="secondary" size="small" aria-pressed={step === "close"} onClick={() => setStep(step === "close" ? null : "close")}>
            Close
          </Button>
          <Button variant="danger" size="small" aria-pressed={step === "withdraw"} onClick={() => setStep(step === "withdraw" ? null : "withdraw")}>
            Withdraw (entered by mistake)
          </Button>
        </div>
      ) : null}
      {step === "action" ? (
        <form onSubmit={(event) => { event.preventDefault(); send("/api/farming/safety/actions", { reportId: report.recordId, title: action.title, assignedToUserId: action.assignedToUserId || null, assignedToName: action.assignedToUserId ? null : action.assignedToName, due: action.due || null }); }}>
          <Field label="What needs doing">
            <input value={action.title} required maxLength={200} onChange={(event) => setAction({ ...action, title: event.target.value })} />
          </Field>
          <div className={ui.inlineForm}>
            <Field label="Who">
              <select value={action.assignedToUserId} onChange={(event) => setAction({ ...action, assignedToUserId: event.target.value })}>
                <option value="">Someone without a login…</option>
                {people.map((person) => (
                  <option key={person.userId} value={person.userId}>
                    {person.name}
                  </option>
                ))}
              </select>
            </Field>
            {!action.assignedToUserId ? (
              <Field label="Their name">
                <input value={action.assignedToName} maxLength={150} onChange={(event) => setAction({ ...action, assignedToName: event.target.value })} />
              </Field>
            ) : null}
            <Field label="By">
              <DateInput value={action.due} onChange={(event) => setAction({ ...action, due: event.target.value })} />
            </Field>
          </div>
          <Button type="submit" disabled={busy || !action.title.trim()}>
            Add action
          </Button>
        </form>
      ) : null}
      {step === "worksafe" ? (
        <form onSubmit={(event) => { event.preventDefault(); send(`/api/farming/safety/reports/${report.recordId}`, { step: "worksafe", expectedVersion: report.version, on: form.on, how: form.how, reference: form.reference }); }}>
          <p className={ui.muted}>Record that you told WorkSafe. Tohyee doesn&apos;t tell them itself.</p>
          <div className={ui.inlineForm}>
            <Field label="When">
              <DateInput value={form.on} onChange={(event) => setForm({ ...form, on: event.target.value })} />
            </Field>
            <Field label="How">
              <select value={form.how} onChange={(event) => setForm({ ...form, how: event.target.value })}>
                <option value="phone">Phone</option>
                <option value="online">Online</option>
              </select>
            </Field>
            <Field label="WorkSafe's reference">
              <input value={form.reference} maxLength={100} onChange={(event) => setForm({ ...form, reference: event.target.value })} />
            </Field>
          </div>
          <Button type="submit" disabled={busy}>
            Save
          </Button>
        </form>
      ) : null}
      {step === "close" || step === "withdraw" ? (
        <form onSubmit={(event) => { event.preventDefault(); send(`/api/farming/safety/reports/${report.recordId}`, { step, expectedVersion: report.version, why: form.why }); }}>
          <Field label={step === "close" ? "Why it's closed (what was put right)" : "Why it's withdrawn"}>
            <textarea value={form.why} required rows={2} maxLength={1000} onChange={(event) => setForm({ ...form, why: event.target.value })} />
          </Field>
          <Button type="submit" variant={step === "withdraw" ? "danger" : "primary"} disabled={busy || !form.why.trim()}>
            {step === "close" ? "Close report" : "Withdraw"}
          </Button>
        </form>
      ) : null}
      <details style={{ marginTop: 8 }}>
        <summary>History</summary>
        <SafetyHistory organisationId={organisationId} recordId={report.recordId} paddockNames={paddockNames} />
      </details>
    </div>
  );
}

function ActionRow({ organisationId, action, access, people, onChanged }: { organisationId: string; action: CurrentRecord<ActionData>; access: SafetyAccess; people: Person[]; onChanged: () => void }) {
  const { user } = useWorkspace();
  const today = todayInBrowser();
  // Farm staff mark their own actions done; checking and reopening are for bookkeepers and above (decision 960).
  const mineToDo = access.canReport && action.data.assignedToUserId === user.id;
  const state = actionState(action, today);
  const [step, setStep] = useState<"done" | "verify" | "reopen" | null>(null);
  const [note, setNote] = useState("");
  const [photos, setPhotos] = useState<PickedFile[]>([]);
  const [operationId, setOperationId] = useState(newOperationId);
  const { busy, error, run } = useRun();
  const { queue, items } = useOfflineQueue(organisationId);
  const online = useOnline();
  const doneHere = items.find((item) => item.kind === "safety.action.done" && item.meta.actionId === action.recordId && item.status !== "synced");
  const who = action.data.assignedToUserId ? (people.find((person) => person.userId === action.data.assignedToUserId)?.name ?? "a member") : action.data.assignedToName;
  const submit = () =>
    void run(
      // Marking done can wait on this device (with the version it was done against); checking and reopening are approvals and always go to Tohyee (decision 1015).
      () =>
        step === "done"
          ? submitThroughQueue(queue, {
              operationId,
              kind: "safety.action.done",
              label: `Done: ${action.data.title}`,
              farmId: action.farmId,
              farmName: null,
              meta: { actionId: action.recordId },
              request: { method: "POST", path: `/api/farming/safety/actions/${action.recordId}`, body: { step, expectedVersion: action.version, note, files: photos.map((file) => ({ id: file.id })) }, refs: waitForFiles(photos, ["files"]) },
            })
          : api(`/api/farming/safety/actions/${action.recordId}`, { method: "POST", body: { organisationId, operationId, step, expectedVersion: action.version, note: step === "reopen" ? undefined : note, why: step === "reopen" ? note : undefined } }),
      () => {
        setStep(null);
        setNote("");
        setOperationId(newOperationId());
        onChanged();
      },
    );
  return (
    <li id={recordAnchor("action", action.recordId)} style={{ padding: "6px 0", borderTop: "1px dashed var(--border)", scrollMarginTop: 72 }}>
      <strong>{action.data.title}</strong> <Badge tone={state === "overdue" ? "red" : state === "verified" ? "green" : state === "done" ? "blue" : "neutral"}>{ACTION_STATE_LABELS[state]}</Badge>
      <div className={ui.muted} style={{ fontSize: "var(--text-sm)" }}>
        {who}
        {action.data.due ? ` · by ${formatDate(action.data.due)}` : ""}
        {action.data.done ? ` · done: ${action.data.done.note}` : ""}
        {action.data.verified ? ` · checked${action.data.verified.note ? `: ${action.data.verified.note}` : ""} by ${action.enteredByName || action.enteredByEmail}` : ""}
      </div>
      {error ? <Notice tone="error">{error}</Notice> : null}
      {doneHere ? <p className={ui.muted}>Marked done on this device: waiting to send. It isn&apos;t done in Tohyee until it&apos;s sent.</p> : null}
      {(access.canRecord || mineToDo) && state !== "withdrawn" && !doneHere ? (
        <div className={ui.actions} style={{ justifyContent: "flex-start" }}>
          {!action.data.done ? (
            <Button variant="secondary" size="small" onClick={() => setStep(step === "done" ? null : "done")}>
              Mark done
            </Button>
          ) : null}
          {action.data.done && !action.data.verified ? (
            <Button variant="secondary" size="small" onClick={() => setStep(step === "verify" ? null : "verify")}>
              Check and close
            </Button>
          ) : null}
          {action.data.done ? (
            <Button variant="secondary" size="small" onClick={() => setStep(step === "reopen" ? null : "reopen")}>
              Reopen
            </Button>
          ) : null}
        </div>
      ) : null}
      {step ? (
        <form onSubmit={(event) => { event.preventDefault(); submit(); }}>
          <Field label={step === "done" ? "What was done" : step === "verify" ? "What you checked (optional)" : "Why it's reopened"}>
            <textarea value={note} rows={2} maxLength={2000} required={step !== "verify"} onChange={(event) => setNote(event.target.value)} />
          </Field>
          {step === "done" && action.farmId ? <PhotoPicker organisationId={organisationId} farmId={action.farmId} files={photos} onChange={setPhotos} label="Photo of what was done" /> : null}
          {step !== "done" && !online ? <p className={ui.muted}>Checking and reopening need a connection: Tohyee checks who may do it at the time.</p> : null}
          <Button type="submit" disabled={busy || (step !== "verify" && !note.trim()) || (step !== "done" && !online)}>
            Save
          </Button>
        </form>
      ) : null}
    </li>
  );
}

/** Owners choose who else sees incident and medical details (decision 936). */
export function RestrictedAccessCard({ organisationId, people }: { organisationId: string; people: Person[] }) {
  const granted = useApiData<{ members: Array<{ userId: string }> }>("/api/farming/safety/restricted", { organisationId });
  const { busy, error, run } = useRun();
  const allowed = new Set((granted.data?.members ?? []).map((member) => member.userId));
  return (
    <Card title="Who sees injury and medical details" description="Owners always do, and so does whoever entered them. Choose anyone else who needs to (e.g. a health and safety lead). Admins don't, unless chosen.">
      {granted.error || error ? <Notice tone="error">{granted.error ?? error}</Notice> : null}
      {!people.some((person) => person.role !== "owner") ? <p className={ui.muted}>There&apos;s nobody else in this organisation yet.</p> : null}
      {people.filter((person) => person.role !== "owner").map((person) => (
        <label key={person.userId} className={ui.checkbox} style={{ display: "flex" }}>
          <input
            type="checkbox"
            disabled={busy || !granted.data}
            checked={allowed.has(person.userId)}
            onChange={(event) => void run(() => api("/api/farming/safety/restricted", { method: "POST", body: { organisationId, userId: person.userId, allowed: event.target.checked } }), () => granted.reload())}
          />{" "}
          {person.name}
        </label>
      ))}
    </Card>
  );
}

/**
 * The Log tab's safety report (#447's workspace, decision 962): the same
 * report as the Safety page, for the farm being worked on, opened from Log.
 */
export function LogSafetyReport({ organisationId, farm, type, onClose }: { organisationId: string; farm: Farm; type: ReportType; onClose: () => void }) {
  const paddocks = useApiData<{ paddocks: Paddock[] }>(`/api/farming/farms/${farm.id}/paddocks`, { organisationId });
  const reports = useReports(organisationId, farm.id, false);
  const [result, setResult] = useState<{ tone: "success" | "warning" | "error"; text: string; notifiable: boolean } | null>(null);
  if (result) {
    return (
      <Card title={REPORT_TYPE_LABELS[type]}>
        <Notice tone={result.tone}>{result.text}</Notice>
        {result.notifiable ? <NotifiablePrompt /> : null}
        <Button onClick={onClose}>Done</Button>
      </Card>
    );
  }
  if (!paddocks.data || !reports.data) return <p className={ui.muted}>Loading…</p>;
  return (
    <Card title={`${REPORT_TYPE_LABELS[type]} on ${farm.name}`} description="Saved on this phone first, then sent.">
      <ReportForm organisationId={organisationId} farm={farm} type={type} paddocks={paddocks.data.paddocks} people={reports.data.people} onCancel={onClose} onDone={setResult} />
    </Card>
  );
}
