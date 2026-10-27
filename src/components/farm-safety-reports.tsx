"use client";

import { useState, useSyncExternalStore } from "react";
import { DateInput } from "@/components/date-input";
import { EnteredLine, newOperationId, SafetyHistory } from "@/components/farm-safety";
import { useApiData } from "@/components/hooks";
import { Badge, Button, Card, Empty, Field, Notice, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { api, errorMessage } from "@/lib/client/api";
import { createDraftStore, type SafetyDraft, sendDraft } from "@/lib/client/safety-drafts";
import type { Farm, Paddock } from "@/lib/farming/paddocks";
import { formatDate, formatDateTime, todayInBrowser } from "@/lib/format";
import type { SafetyFile } from "@/lib/safety/files";
import type { ReportView } from "@/lib/safety/reports";
import {
  ACTION_STATE_LABELS,
  type ActionData,
  actionState,
  type CurrentRecord,
  FIXED_NUMBERS,
  mayBeNotifiable,
  NOTIFIABLE_QUESTIONS,
  notifiableKeepText,
  type NotifiableAnswers,
  type Position,
  REPORT_STATE_LABELS,
  REPORT_TYPE_LABELS,
  type ReportType,
  type SafetyAccess,
  SEVERITIES,
  SEVERITY_LABELS,
  type Severity,
  SITE_EXCEPTIONS,
  WORKSAFE_NOTIFIABLE_GUIDE_URL,
  WORKSAFE_NOTIFY_URL,
} from "@/lib/safety/shared";

/*
 * Reporting a hazard, near miss or incident on a phone, and following it
 * through: restricted injury details, WorkSafe's questions, photos with
 * their own dates, and actions to a checked close (#446, decisions
 * 942-947). Reports are saved on the phone first and sent once.
 */

type Person = { userId: string; name: string; role: string };
export type ReportsData = { reports: ReportView[]; access: SafetyAccess; people: Person[] };

/** A farm's reports, actions and people, for the Safety page. */
export function useReports(organisationId: string, farmId: string, includeWithdrawn: boolean) {
  return useApiData<ReportsData>("/api/farming/safety/reports", { organisationId, farmId, includeWithdrawn });
}

const drafts = createDraftStore(() => (typeof window === "undefined" ? null : window.localStorage));
let draftVersion = 0;
const draftListeners = new Set<() => void>();
function draftsChanged() {
  draftVersion += 1;
  for (const listener of draftListeners) listener();
}
function useDraftVersion() {
  return useSyncExternalStore(
    (listener) => {
      draftListeners.add(listener);
      window.addEventListener("storage", listener);
      return () => {
        draftListeners.delete(listener);
        window.removeEventListener("storage", listener);
      };
    },
    () => draftVersion,
    () => 0,
  );
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

async function readAsBase64(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  let binary = "";
  const bytes = new Uint8Array(buffer);
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
}

/** Photo picker that keeps each photo as soon as it's chosen (needs a connection). */
function PhotoPicker({ organisationId, farmId, restricted = false, files, onChange, label = "Photos" }: { organisationId: string; farmId: string; restricted?: boolean; files: SafetyFile[]; onChange: (files: SafetyFile[]) => void; label?: string }) {
  const { busy, error, run } = useRun();
  return (
    <div style={{ margin: "8px 0" }}>
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
              async () =>
                (
                  await api<{ file: SafetyFile }>("/api/farming/safety/files", {
                    method: "POST",
                    body: { organisationId, farmId, restricted, fileName: chosen.name, contentType: chosen.type, contentBase64: await readAsBase64(chosen), phoneFileTime: new Date(chosen.lastModified).toISOString() },
                  })
                ).file,
              (file) => onChange([...files, file]),
            );
          }}
        />
      </label>
      {busy ? <p className={ui.muted}>Keeping the photo…</p> : null}
      {error ? <Notice tone="error">{error} Photos need a connection; the report itself can be saved on this phone.</Notice> : null}
      {files.length ? (
        <p className={ui.muted}>
          {files.length} photo{files.length === 1 ? "" : "s"} kept{files.some((file) => file.photoTaken) ? `; camera date ${files.find((file) => file.photoTaken)?.photoTaken}` : ""}.
        </p>
      ) : null}
    </div>
  );
}

function Thumbnails({ organisationId, files }: { organisationId: string; files: SafetyFile[] }) {
  if (!files.length) return null;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 8, margin: "6px 0" }}>
      {files.map((file) => {
        const href = `/api/farming/safety/files/${file.id}?organisationId=${encodeURIComponent(organisationId)}`;
        return (
          <a key={file.id} href={href} target="_blank" rel="noreferrer" title={`Received ${formatDateTime(file.receivedAt)}${file.photoTaken ? `; camera date ${file.photoTaken}` : ""}`}>
            {/* eslint-disable-next-line @next/next/no-img-element -- a private, signed-in file; next/image would cache it */}
            <img src={href} alt={`${file.name}${file.restricted ? " (restricted)" : ""}`} style={{ width: 88, height: 88, objectFit: "cover", borderRadius: 6, border: file.restricted ? "2px solid var(--danger, #c81e1e)" : "1px solid var(--border)" }} />
          </a>
        );
      })}
    </div>
  );
}

// Reporting ----------------------------------------------------------------------------------------

export function ReportSomething({ organisationId, farm, paddocks, people, access, onSent }: { organisationId: string; farm: Farm; paddocks: Paddock[]; people: Person[]; access: SafetyAccess; onSent: () => void }) {
  const [type, setType] = useState<ReportType | null>(null);
  const [result, setResult] = useState<{ tone: "success" | "warning" | "error"; text: string; notifiable: boolean } | null>(null);
  if (!access.canReport) return null;
  return (
    <Card title="Report something" description="A hazard you've spotted, a near miss, or someone hurt. It's saved on this phone first, then sent.">
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
          onCancel={() => setType(null)}
          onDone={(outcome) => {
            setType(null);
            setResult(outcome);
            onSent();
          }}
        />
      ) : (
        <div className={ui.actions} style={{ justifyContent: "flex-start", flexWrap: "wrap" }}>
          {(["hazard", "near_miss", "incident"] as const).map((each) => (
            <Button key={each} variant={each === "incident" ? "danger" : "secondary"} onClick={() => { setResult(null); setType(each); }}>
              {REPORT_TYPE_LABELS[each]}
            </Button>
          ))}
        </div>
      )}
    </Card>
  );
}

export function ReportForm({ organisationId, farm, type, paddocks, people, onCancel, onDone }: { organisationId: string; farm: Farm; type: ReportType; paddocks: Paddock[]; people: Person[]; onCancel: () => void; onDone: (outcome: { tone: "success" | "warning" | "error"; text: string; notifiable: boolean }) => void }) {
  const { user } = useWorkspace();
  const [operationId] = useState(newOperationId);
  const [form, setForm] = useState({ title: "", happenedOn: todayInBrowser(), time: "", whatHappened: "", where: "", paddockIds: [] as string[], immediateAction: "", severity: (type === "incident" ? "moderate" : "minor") as Severity });
  const [point, setPoint] = useState<Position | null>(null);
  const [photos, setPhotos] = useState<SafetyFile[]>([]);
  const [injured, setInjured] = useState(type === "incident");
  const [details, setDetails] = useState({ injuredPerson: "", injury: "", treatment: "" });
  const [detailPhotos, setDetailPhotos] = useState<SafetyFile[]>([]);
  const [answers, setAnswers] = useState<NotifiableAnswers>({});
  const [action, setAction] = useState({ title: "", assignedToUserId: "", assignedToName: "", due: "" });
  const [locating, setLocating] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const notifiable = mayBeNotifiable(answers);
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
    const body: Record<string, unknown> = {
      organisationId,
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
    };
    const draft: Omit<SafetyDraft, "savedAt" | "status" | "problem"> = { operationId, userId: user.id, organisationId, farmId: farm.id, farmName: farm.name, label: `${REPORT_TYPE_LABELS[type]}: ${form.title}`, path: "/api/farming/safety/reports", body };
    const kept = drafts.save(draft);
    draftsChanged();
    const outcome = await sendDraft(drafts, { ...draft, savedAt: new Date().toISOString(), status: "saved", problem: null }, (path, payload) => api(path, { method: "POST", body: payload }));
    draftsChanged();
    setBusy(false);
    if (outcome.result === "sent") onDone({ tone: "success", text: `Recorded for ${farm.name}.${notifiable ? " Tohyee hasn't told WorkSafe." : ""}`, notifiable });
    else if (outcome.result === "kept") onDone({ tone: "warning", text: kept ? `Saved on this phone, not sent yet (${outcome.reason}). It's sent when you press Send now with a connection.` : `Not sent (${outcome.reason}) and this phone couldn't keep a copy. Write it down and try again.`, notifiable });
    else onDone({ tone: "error", text: `Not recorded: ${outcome.reason} It's kept on this phone under Waiting to send.`, notifiable });
  };
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
      aria-label={REPORT_TYPE_LABELS[type]}
    >
      <p style={{ marginTop: 0 }}>
        <Badge tone={type === "incident" ? "red" : type === "near_miss" ? "amber" : "neutral"}>{REPORT_TYPE_LABELS[type]}</Badge> on <strong>{farm.name}</strong>
      </p>
      <PhotoPicker organisationId={organisationId} farmId={farm.id} files={photos} onChange={setPhotos} label="Photo (take it now if you can)" />
      <Field label="What it was, in a few words">
        <input value={form.title} required maxLength={150} onChange={(event) => setForm({ ...form, title: event.target.value })} />
      </Field>
      <div className={ui.inlineForm}>
        <Field label="When">
          <DateInput value={form.happenedOn} max={todayInBrowser()} onChange={(event) => setForm({ ...form, happenedOn: event.target.value })} />
        </Field>
        <Field label="Time">
          <input type="time" value={form.time} onChange={(event) => setForm({ ...form, time: event.target.value })} />
        </Field>
      </div>
      <Field label="Where">
        <input value={form.where} maxLength={300} onChange={(event) => setForm({ ...form, where: event.target.value })} placeholder="e.g. the yard gate by the shed" />
      </Field>
      <div className={ui.actions} style={{ justifyContent: "flex-start" }}>
        <Button variant="secondary" size="small" onClick={locate}>
          Where I am now
        </Button>
        {point ? (
          <Button variant="secondary" size="small" onClick={() => { setPoint(null); setLocating(null); }}>
            Clear place
          </Button>
        ) : null}
      </div>
      {locating ? <p className={ui.muted}>{locating}</p> : null}
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
          <label className={ui.checkbox}>
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
              <PhotoPicker organisationId={organisationId} farmId={farm.id} restricted files={detailPhotos} onChange={setDetailPhotos} label="Photo of the injury (restricted)" />
            </fieldset>
          ) : null}
          <fieldset style={{ border: 0, padding: 0, margin: "8px 0" }}>
            <legend className={ui.fieldLabel}>WorkSafe&apos;s questions</legend>
            <p className={ui.muted} style={{ margin: "0 0 6px", fontSize: "var(--text-sm)" }}>
              From WorkSafe&apos;s quick guide.{" "}
              <a href={WORKSAFE_NOTIFIABLE_GUIDE_URL} target="_blank" rel="noreferrer">
                Check WorkSafe&apos;s current guide
              </a>{" "}
              if you&apos;re not sure.
            </p>
            {NOTIFIABLE_QUESTIONS.map((question) => (
              <label key={question.key} className={ui.checkbox} style={{ alignItems: "flex-start", marginBottom: 6 }}>
                <input type="checkbox" checked={answers[question.key] === true} onChange={(event) => setAnswers({ ...answers, [question.key]: event.target.checked })} /> {question.text}
              </label>
            ))}
          </fieldset>
          {notifiable ? <NotifiablePrompt /> : null}
        </>
      ) : null}
      <fieldset style={{ border: 0, padding: 0, margin: "8px 0" }}>
        <legend className={ui.fieldLabel}>Who&apos;ll put it right (optional)</legend>
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
      </fieldset>
      <div className={ui.actions}>
        <Button type="submit" disabled={busy || !form.title.trim()}>
          {busy ? "Saving…" : "Save report"}
        </Button>
        <Button variant="secondary" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/** Reports saved on this phone and not yet recorded (decision 944). */
export function WaitingToSend({ organisationId, onSent }: { organisationId: string; onSent: () => void }) {
  const { user } = useWorkspace();
  useDraftVersion();
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const waiting = typeof window === "undefined" ? [] : drafts.list(user.id, organisationId);
  if (!waiting.length) return null;
  const sendAll = async () => {
    setBusy(true);
    let sent = 0;
    for (const draft of waiting) {
      const outcome = await sendDraft(drafts, draft, (path, body) => api(path, { method: "POST", body }));
      if (outcome.result === "sent") sent += 1;
    }
    draftsChanged();
    setBusy(false);
    setMessage(sent === waiting.length ? `All ${sent} sent and recorded.` : `${sent} of ${waiting.length} sent. The rest are still on this phone.`);
    if (sent) onSent();
  };
  return (
    <Card title={`Waiting to send (${waiting.length})`} description="Saved on this phone, not yet recorded in Tohyee. Nobody has been told about these yet.">
      {message ? <Notice tone="info">{message}</Notice> : null}
      <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
        {waiting.map((draft) => (
          <li key={draft.operationId} style={{ borderTop: "1px solid var(--border)", padding: "8px 0" }}>
            <strong>{draft.label}</strong> <span className={ui.muted}>· {draft.farmName} · saved {formatDateTime(draft.savedAt)}</span>{" "}
            {draft.status === "needs_attention" ? <Badge tone="red">Needs attention</Badge> : <Badge tone="amber">Saved on this phone</Badge>}
            {draft.problem ? <div style={{ color: "var(--danger, #c81e1e)" }}>{draft.problem}</div> : null}
            {draft.status === "needs_attention" ? (
              <div>
                <Button variant="secondary" size="small" onClick={() => { if (window.confirm("Discard this report from the phone? It was never recorded.")) { drafts.remove(draft.operationId); draftsChanged(); } }}>
                  Discard
                </Button>
              </div>
            ) : null}
          </li>
        ))}
      </ul>
      <div className={ui.actions}>
        <Button disabled={busy} onClick={() => void sendAll()}>
          {busy ? "Sending…" : "Send now"}
        </Button>
      </div>
    </Card>
  );
}

// Following reports through -------------------------------------------------------------------------------

export function ReportsCard({
  organisationId,
  data,
  paddockNames,
  showWithdrawn,
  onShowWithdrawn,
  onChanged,
}: {
  organisationId: string;
  data: ReportsData;
  paddockNames: ReadonlyMap<string, string>;
  showWithdrawn: boolean;
  onShowWithdrawn: (value: boolean) => void;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const { reports, access, people } = data;
  const openCount = reports.filter((report) => report.state === "open" || report.state === "actions").length;
  return (
    <>
      <Card title={`Reports (${openCount} open)`} description="Hazards spotted, near misses and incidents, newest first, with what's being done about them.">
        {!reports.length ? <Empty>Nothing reported on this farm yet.</Empty> : null}
        <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
          {reports.map((report) => (
            <li key={report.recordId} style={{ borderTop: "1px solid var(--border)", padding: "10px 0" }}>
              <button type="button" className={ui.linkButton} style={{ fontWeight: 600, textAlign: "left" }} aria-expanded={open === report.recordId} onClick={() => setOpen(open === report.recordId ? null : report.recordId)}>
                {report.data.title}
              </button>{" "}
              <Badge tone={report.data.type === "incident" ? "red" : report.data.type === "near_miss" ? "amber" : "neutral"}>{REPORT_TYPE_LABELS[report.data.type]}</Badge>{" "}
              <Badge tone={report.state === "closed" ? "green" : report.state === "withdrawn" ? "neutral" : "blue"}>{REPORT_STATE_LABELS[report.state]}</Badge>
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
      {access.isOwner ? <RestrictedAccessCard organisationId={organisationId} people={people} /> : null}
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
      {!report.actions.length ? <p className={ui.muted}>None yet.</p> : null}
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
  const [photos, setPhotos] = useState<SafetyFile[]>([]);
  const [operationId, setOperationId] = useState(newOperationId);
  const { busy, error, run } = useRun();
  const who = action.data.assignedToUserId ? (people.find((person) => person.userId === action.data.assignedToUserId)?.name ?? "a member") : action.data.assignedToName;
  const submit = () =>
    void run(
      () => api(`/api/farming/safety/actions/${action.recordId}`, { method: "POST", body: { organisationId, operationId, step, expectedVersion: action.version, note: step === "reopen" ? undefined : note, why: step === "reopen" ? note : undefined, files: step === "done" ? photos.map((file) => ({ id: file.id })) : undefined } }),
      () => {
        setStep(null);
        setNote("");
        setOperationId(newOperationId());
        onChanged();
      },
    );
  return (
    <li style={{ padding: "6px 0", borderTop: "1px dashed var(--border)" }}>
      <strong>{action.data.title}</strong> <Badge tone={state === "overdue" ? "red" : state === "verified" ? "green" : state === "done" ? "blue" : "neutral"}>{ACTION_STATE_LABELS[state]}</Badge>
      <div className={ui.muted} style={{ fontSize: "var(--text-sm)" }}>
        {who}
        {action.data.due ? ` · by ${formatDate(action.data.due)}` : ""}
        {action.data.done ? ` · done: ${action.data.done.note}` : ""}
        {action.data.verified ? ` · checked${action.data.verified.note ? `: ${action.data.verified.note}` : ""} by ${action.enteredByName || action.enteredByEmail}` : ""}
      </div>
      {error ? <Notice tone="error">{error}</Notice> : null}
      {(access.canRecord || mineToDo) && state !== "withdrawn" ? (
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
          <Button type="submit" disabled={busy || (step !== "verify" && !note.trim())}>
            Save
          </Button>
        </form>
      ) : null}
    </li>
  );
}

/** Owners choose who else sees incident and medical details (decision 936). */
function RestrictedAccessCard({ organisationId, people }: { organisationId: string; people: Person[] }) {
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
