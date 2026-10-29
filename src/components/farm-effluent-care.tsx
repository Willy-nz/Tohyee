"use client";

import Link from "next/link";
import { useState } from "react";
import { DateInput } from "@/components/date-input";
import { SafetyHistory } from "@/components/farm-safety";
import { PhotoPicker, Thumbnails } from "@/components/farm-safety-reports";
import { useApiData } from "@/components/hooks";
import { type PickedFile, QueuedWork, submitThroughQueue, useOfflineQueue, waitForFiles } from "@/components/offline-queue";
import { Badge, Button, Card, Empty, Field, Notice, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { api, errorMessage } from "@/lib/client/api";
import type { EffluentCare, IncidentView, SystemCare } from "@/lib/effluent/care";
import { type Reminder, SERVICE_KIND_LABELS, SERVICE_KINDS, type ServiceKind } from "@/lib/effluent/reminders";
import { effluentHref } from "@/lib/effluent/screens";
import { COUNCIL_TOLD_HOW, type CouncilTold, INCIDENT_TYPE_LABELS, INCIDENT_TYPES, type IncidentType, NEVER_SENDS, SYSTEM_TYPE_LABELS } from "@/lib/effluent/shared";
import type { Farm } from "@/lib/farming/paddocks";
import { formatDate, formatDateTime, todayInBrowser } from "@/lib/format";
import { newOperationId } from "@/lib/offline/queue";
import { ACTION_STATE_LABELS, type ActionState } from "@/lib/safety/shared";
import { safetyHref } from "@/lib/safety/screens";
import styles from "./farm-safety.module.css";

/*
 * Effluent's checks, faults, servicing, incidents and reminders (#487,
 * decisions 1090-1097). Checks open Safety's pre-start check for the
 * system's machine; faults and incidents are saved on the device first and
 * sent through the queue; actions are Safety's, so they're marked done and
 * checked where every other action is.
 */

type Ctx = { organisationId: string; farm: Farm };

export function useEffluentCare(organisationId: string, farmId: string) {
  return useApiData<EffluentCare>("/api/farming/effluent/care", { organisationId, farmId });
}

const REMINDER_HREF: Record<Reminder["kind"], "log" | "ponds" | "checks" | "setup"> = { shift: "log", pond: "ponds", check: "checks", service: "checks", wof: "checks", consent: "setup" };

function outcomeText(state: string) {
  return state === "synced" ? "Saved." : state === "waiting" ? "Saved on this device, waiting to send. Nobody has been told yet." : "This device's storage wouldn't keep it. Keep Tohyee open until it shows Synced.";
}

/** The reminders as a list, each opening its screen (decision 1095). */
export function ReminderList({ farm, reminders }: { farm: Farm; reminders: Reminder[] }) {
  if (!reminders.length) return <p>Nothing due for effluent.</p>;
  return (
    <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
      {reminders.map((reminder) => (
        <li key={reminder.key} style={{ borderTop: "1px solid var(--border)", padding: "8px 0", display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
          <Badge tone={reminder.when === "due" ? "amber" : "neutral"}>{reminder.when === "due" ? "Due" : `By ${formatDate(reminder.date)}`}</Badge>
          <Link href={effluentHref({ farmId: farm.id, screen: REMINDER_HREF[reminder.kind] })}>{reminder.text}</Link>
        </li>
      ))}
    </ul>
  );
}

// Checks, faults and servicing -------------------------------------------------------------------------

export function ChecksScreen({ organisationId, farm }: Ctx) {
  const care = useEffluentCare(organisationId, farm.id);
  const [done, setDone] = useState<string | null>(null);
  if (care.error) return <Notice tone="error">{care.error}</Notice>;
  if (!care.data) return <p className={ui.muted}>Loading…</p>;
  const systems = care.data.systems.filter((system) => system.change !== "withdrawn" && !system.data.retired);
  const due = care.data.reminders.filter((reminder) => reminder.kind === "check" || reminder.kind === "service" || reminder.kind === "wof");
  return (
    <div className={styles.overview}>
      <div className={styles.column}>
        {done ? <Notice tone="success">{done}</Notice> : null}
        <QueuedWork organisationId={organisationId} farmId={farm.id} kinds={["effluent.fault", "effluent.service"]} title="Faults and servicing on this device" onSynced={care.reload} />
        <Card title="Due">
          <ReminderList farm={farm} reminders={due} />
        </Card>
        {!systems.length ? <Empty>No effluent systems yet.</Empty> : null}
        {systems.map((system) => (
          <SystemCard key={system.recordId} organisationId={organisationId} farm={farm} system={system} onSaved={(text) => { setDone(text); care.reload(); }} />
        ))}
      </div>
      <div className={styles.column}>
        <Card title="How checks work" description="The checks are Safety's pre-start checks on each system's machine.">
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            <li>A failed critical item, or a fault reported here as &quot;don&apos;t use it&quot;, puts the system out of use. Only an owner, an admin or someone named on the machine releases it, in Safety, saying what was done.</li>
            <li>Tohyee&apos;s &quot;out of use&quot; is a record, not a lock: tag it out on the machine too.</li>
            <li>Change a system&apos;s checklist in Safety › Equipment.</li>
          </ul>
        </Card>
      </div>
    </div>
  );
}

function SystemCard({ organisationId, farm, system, onSaved }: Ctx & { system: SystemCare; onSaved: (text: string) => void }) {
  const [open, setOpen] = useState<"fault" | "service" | null>(null);
  return (
    <Card
      title={system.data.name}
      description={SYSTEM_TYPE_LABELS[system.data.type]}
      actions={system.available ? <Badge tone="green">In use</Badge> : <Badge tone="red">Out of use</Badge>}
    >
      {!system.available ? (
        <Notice tone="error">
          Don&apos;t use it: {system.outOfUseBecause}. {system.canRelease ? "You can release it in Safety once it's fixed." : "Someone allowed releases it in Safety once it's fixed."}
        </Notice>
      ) : null}
      <dl style={{ display: "grid", gridTemplateColumns: "minmax(0, 9em) minmax(0, 1fr)", gap: "4px 12px", margin: "0 0 8px" }}>
        <dt className={ui.muted}>Last check</dt>
        <dd style={{ margin: 0 }}>{system.lastCheckedAt ? formatDateTime(system.lastCheckedAt) : "None yet"} ({system.data.checkEvery === "week" ? "each week" : "each day it's used"})</dd>
        <dt className={ui.muted}>Last service</dt>
        <dd style={{ margin: 0 }}>{system.lastService ? formatDate(system.lastService) : "None recorded"}{system.nextService ? `; next by ${formatDate(system.nextService)}` : ""}</dd>
        <dt className={ui.muted}>Effluent WoF</dt>
        <dd style={{ margin: 0 }}>{system.lastWof ? `Last ${formatDate(system.lastWof)}` : "None recorded"}{system.nextWof ? `; next ${formatDate(system.nextWof)}` : ""}</dd>
      </dl>
      <div className={ui.actions} style={{ justifyContent: "flex-start", flexWrap: "wrap" }}>
        <Link className={ui.linkButton} href={safetyHref({ farmId: farm.id, screen: "equipment", equipment: system.data.equipmentId })}>
          {system.available ? "Do the check" : "Open in Safety"}
        </Link>
        <Button variant="secondary" aria-expanded={open === "fault"} onClick={() => setOpen(open === "fault" ? null : "fault")}>
          Report a fault
        </Button>
        <Button variant="secondary" aria-expanded={open === "service"} onClick={() => setOpen(open === "service" ? null : "service")}>
          Service, WoF or repair done
        </Button>
      </div>
      {open === "fault" ? <FaultForm organisationId={organisationId} farm={farm} system={system} onDone={(text) => { setOpen(null); onSaved(text); }} onCancel={() => setOpen(null)} /> : null}
      {open === "service" ? <ServiceForm organisationId={organisationId} farm={farm} system={system} onDone={(text) => { setOpen(null); onSaved(text); }} onCancel={() => setOpen(null)} /> : null}
      {system.faults.length ? (
        <details>
          <summary>Faults and failed checks ({system.faults.length})</summary>
          <ul style={{ paddingLeft: 18 }}>
            {system.faults.map((check) => (
              <li key={check.recordId}>
                {formatDateTime(check.enteredAt)}: {check.data.answers.filter((answer) => answer.result === "fault").map((answer) => answer.note ?? answer.text).join("; ")}
                {check.data.criticalFault ? " (out of use)" : ""}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {system.services.length ? (
        <details>
          <summary>Servicing ({system.services.length})</summary>
          <ul style={{ paddingLeft: 18 }}>
            {system.services.map((service) => (
              <li key={service.recordId}>
                <strong>{SERVICE_KIND_LABELS[service.data.kind]}</strong> {formatDate(service.data.doneOn)}
                {service.data.by ? ` by ${service.data.by}` : ""}
                {service.data.notes ? `: ${service.data.notes}` : ""}
                {service.data.nextDue ? ` (next ${formatDate(service.data.nextDue)})` : ""}
                <Thumbnails organisationId={organisationId} files={service.data.files as PickedFile[]} />
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </Card>
  );
}

function FaultForm({ organisationId, farm, system, onDone, onCancel }: Ctx & { system: SystemCare; onDone: (text: string) => void; onCancel: () => void }) {
  const { queue } = useOfflineQueue(organisationId);
  const [operationId] = useState(newOperationId);
  const [what, setWhat] = useState("");
  const [outOfUse, setOutOfUse] = useState(true);
  const [photos, setPhotos] = useState<PickedFile[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      style={{ margin: "8px 0", padding: 10, border: "1px solid var(--border)", borderRadius: 8 }}
      aria-label={`Report a fault on ${system.data.name}`}
      onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true);
        setError(null);
        try {
          const outcome = await submitThroughQueue(queue, { operationId, kind: "effluent.fault", label: `Fault: ${system.data.name}`, farmId: farm.id, farmName: farm.name, request: { method: "POST", path: "/api/farming/effluent/faults", body: { farmId: farm.id, systemId: system.recordId, what, outOfUse, files: photos.map((photo) => ({ id: photo.id })) }, refs: waitForFiles(photos, ["files"]) } });
          onDone(`${outcomeText(outcome.state)}${outOfUse ? ` ${system.data.name} is out of use until it's released in Safety.` : ""} Tohyee doesn't message anyone: the action shows in Tohyee for whoever looks after it.`);
        } catch (caught) {
          setError(`Not saved: ${errorMessage(caught)}`);
        } finally {
          setBusy(false);
        }
      }}
    >
      {error ? <Notice tone="error">{error}</Notice> : null}
      <Field label="What's wrong">
        <textarea rows={2} value={what} required maxLength={1000} onChange={(event) => setWhat(event.target.value)} placeholder="e.g. Coupling split at hydrant 3, leaking" />
      </Field>
      <label className={ui.checkbox} style={{ minHeight: 44 }}>
        <input type="checkbox" checked={outOfUse} onChange={(event) => setOutOfUse(event.target.checked)} /> Don&apos;t use it until it&apos;s fixed (out of use)
      </label>
      <PhotoPicker organisationId={organisationId} farmId={farm.id} farmName={farm.name} files={photos} onChange={setPhotos} label="Photo of the fault" />
      <div className={ui.actions}>
        <Button type="submit" disabled={busy || !what.trim()}>
          Report it
        </Button>
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function ServiceForm({ organisationId, farm, system, onDone, onCancel }: Ctx & { system: SystemCare; onDone: (text: string) => void; onCancel: () => void }) {
  const { queue } = useOfflineQueue(organisationId);
  const [operationId] = useState(newOperationId);
  const [form, setForm] = useState({ kind: "service" as ServiceKind, doneOn: todayInBrowser(), by: "", notes: "", nextDue: "" });
  const [files, setFiles] = useState<PickedFile[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      style={{ margin: "8px 0", padding: 10, border: "1px solid var(--border)", borderRadius: 8 }}
      aria-label={`Servicing done on ${system.data.name}`}
      onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true);
        setError(null);
        try {
          const outcome = await submitThroughQueue(queue, { operationId, kind: "effluent.service", label: `${SERVICE_KIND_LABELS[form.kind]}: ${system.data.name}`, farmId: farm.id, farmName: farm.name, request: { method: "POST", path: "/api/farming/effluent/services", body: { farmId: farm.id, systemId: system.recordId, ...form, nextDue: form.nextDue || null, files: files.map((file) => ({ id: file.id })) }, refs: waitForFiles(files, ["files"]) } });
          onDone(outcomeText(outcome.state));
        } catch (caught) {
          setError(`Not saved: ${errorMessage(caught)}`);
        } finally {
          setBusy(false);
        }
      }}
    >
      {error ? <Notice tone="error">{error}</Notice> : null}
      <div className={ui.inlineForm}>
        <Field label="What">
          <select value={form.kind} onChange={(event) => setForm({ ...form, kind: event.target.value as ServiceKind })}>
            {SERVICE_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {SERVICE_KIND_LABELS[kind]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Done on">
          <DateInput value={form.doneOn} max={todayInBrowser()} onChange={(event) => setForm({ ...form, doneOn: event.target.value })} />
        </Field>
        <Field label="Who did it">
          <input value={form.by} maxLength={150} onChange={(event) => setForm({ ...form, by: event.target.value })} placeholder="e.g. the pump company, the WoF assessor" />
        </Field>
        <Field label="Next one due" hint={form.kind === "wof" ? "As the assessor said." : system.data.serviceEveryMonths ? `Empty: ${system.data.serviceEveryMonths} months on.` : undefined}>
          <DateInput value={form.nextDue} onChange={(event) => setForm({ ...form, nextDue: event.target.value })} />
        </Field>
      </div>
      <Field label="What was done">
        <textarea rows={2} value={form.notes} maxLength={4000} onChange={(event) => setForm({ ...form, notes: event.target.value })} />
      </Field>
      <PhotoPicker organisationId={organisationId} farmId={farm.id} farmName={farm.name} files={files} onChange={setFiles} label="Photo of the report or invoice" />
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

// Incidents --------------------------------------------------------------------------------------------

type People = { people: Array<{ userId: string; name: string }> };

export function IncidentsScreen({ organisationId, farm }: Ctx) {
  const care = useEffluentCare(organisationId, farm.id);
  const setup = useApiData<{ systems: Array<{ recordId: string; change: string; data: { name: string; retired: boolean } }>; consents: Array<{ change: string; data: { replaced: boolean; notifyCouncil: { who: string; phone: string | null; when: string } | null } }> }>("/api/farming/effluent", { organisationId, farmId: farm.id });
  const people = useApiData<People>("/api/farming/safety/reports", { organisationId, farmId: farm.id });
  const [reporting, setReporting] = useState(false);
  const [done, setDone] = useState<{ text: string; tell: boolean } | null>(null);
  if (care.error) return <Notice tone="error">{care.error}</Notice>;
  if (!care.data || !setup.data) return <p className={ui.muted}>Loading…</p>;
  const consent = [...setup.data.consents].reverse().find((each) => each.change !== "withdrawn" && !each.data.replaced) ?? null;
  const notice = consent?.data.notifyCouncil ?? null;
  const open = care.data.incidents.filter((incident) => incident.state === "open" || incident.state === "actions");
  const other = care.data.incidents.filter((incident) => incident.state === "closed" || incident.state === "withdrawn");
  return (
    <div className={styles.overview}>
      <div className={styles.column}>
        {done ? (
          <Notice tone="success">
            {done.text}
            {done.tell && notice ? (
              <>
                {" "}
                <strong>Your consent says:</strong> tell {notice.who}
                {notice.phone ? (
                  <>
                    {" "}
                    on <a href={`tel:${notice.phone.replace(/\s+/g, "")}`}>{notice.phone}</a>
                  </>
                ) : null}
                , {notice.when} {NEVER_SENDS}
              </>
            ) : null}
          </Notice>
        ) : null}
        <QueuedWork organisationId={organisationId} farmId={farm.id} kinds={["effluent.incident"]} title="Incidents on this device" onSynced={care.reload} />
        {!reporting && care.data && setup.data ? (
          <div className={styles.bigActions}>
            <button type="button" className={styles.bigAction} onClick={() => setReporting(true)}>
              <span className={styles.icon} aria-hidden="true">!</span>
              <span>
                Report an incident
                <small>Spill, ponding, runoff, a buffer, a failure</small>
              </span>
            </button>
          </div>
        ) : null}
        {reporting ? (
          <IncidentForm
            organisationId={organisationId}
            farm={farm}
            systems={setup.data.systems.filter((system) => system.change !== "withdrawn" && !system.data.retired)}
            people={people.data?.people ?? []}
            onDone={(text) => {
              setReporting(false);
              setDone({ text, tell: true });
              care.reload();
            }}
            onCancel={() => setReporting(false)}
          />
        ) : null}
        <Card title={`Open (${open.length})`}>
          {!open.length ? <p className={ui.muted}>No open incidents.</p> : null}
          <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {open.map((incident) => (
              <IncidentRow key={incident.recordId} organisationId={organisationId} farm={farm} incident={incident} canClose={care.data!.canClose} people={people.data?.people ?? []} onSaved={(text) => { setDone({ text, tell: false }); care.reload(); }} />
            ))}
          </ul>
        </Card>
      </div>
      <div className={styles.column}>
        <Card title="Telling the council" description={NEVER_SENDS}>
          {notice ? (
            <p>
              Your consent conditions say: tell <strong>{notice.who}</strong>
              {notice.phone ? (
                <>
                  {" "}
                  on <a href={`tel:${notice.phone.replace(/\s+/g, "")}`}>{notice.phone}</a>
                </>
              ) : null}
              . {notice.when}
            </p>
          ) : (
            <p>No council contact entered in the consent conditions. An owner or admin adds it under Systems, map and consent.</p>
          )}
        </Card>
        <Card title={`Closed and withdrawn (${other.length})`}>
          {!other.length ? <p className={ui.muted}>None yet.</p> : null}
          <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {other.map((incident) => (
              <IncidentRow key={incident.recordId} organisationId={organisationId} farm={farm} incident={incident} canClose={care.data!.canClose} people={people.data?.people ?? []} onSaved={(text) => { setDone({ text, tell: false }); care.reload(); }} />
            ))}
          </ul>
        </Card>
      </div>
    </div>
  );
}

function nowLocal(): string {
  const now = new Date();
  now.setSeconds(0, 0);
  return new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

type ActionDraft = { title: string; who: string; name: string; due: string };

function ActionFields({ actions, onChange, people, meId }: { actions: ActionDraft[]; onChange: (actions: ActionDraft[]) => void; people: Array<{ userId: string; name: string }>; meId: string }) {
  return (
    <fieldset style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 10, margin: "8px 0" }}>
      <legend className={ui.fieldLabel}>What needs doing, and who</legend>
      {actions.map((action, index) => (
        <div key={index} className={ui.inlineForm}>
          <Field label={`Action ${index + 1}`}>
            <input value={action.title} maxLength={200} onChange={(event) => onChange(actions.map((each, at) => (at === index ? { ...each, title: event.target.value } : each)))} placeholder="e.g. Replace the float switch" />
          </Field>
          <Field label="Who">
            <select value={action.who} onChange={(event) => onChange(actions.map((each, at) => (at === index ? { ...each, who: event.target.value } : each)))}>
              <option value={meId}>Me</option>
              {people.filter((person) => person.userId !== meId).map((person) => (
                <option key={person.userId} value={person.userId}>
                  {person.name}
                </option>
              ))}
              <option value="">Someone else (type their name)</option>
            </select>
          </Field>
          {action.who === "" ? (
            <Field label="Their name">
              <input value={action.name} maxLength={150} onChange={(event) => onChange(actions.map((each, at) => (at === index ? { ...each, name: event.target.value } : each)))} />
            </Field>
          ) : null}
          <Field label="By">
            <DateInput value={action.due} onChange={(event) => onChange(actions.map((each, at) => (at === index ? { ...each, due: event.target.value } : each)))} />
          </Field>
        </div>
      ))}
      <Button variant="secondary" size="small" onClick={() => onChange([...actions, { title: "", who: meId, name: "", due: "" }])}>
        Add an action
      </Button>
    </fieldset>
  );
}

function IncidentForm({ organisationId, farm, systems, people, onDone, onCancel }: Ctx & { systems: Array<{ recordId: string; data: { name: string } }>; people: Array<{ userId: string; name: string }>; onDone: (text: string) => void; onCancel: () => void }) {
  const { user } = useWorkspace();
  const { queue } = useOfflineQueue(organisationId);
  const [operationId] = useState(newOperationId);
  const [form, setForm] = useState({ type: "spill" as IncidentType, title: "", whatHappened: "", systemId: "", occurredAt: nowLocal(), immediateAction: "", reachedWater: false });
  const [actions, setActions] = useState<ActionDraft[]>([{ title: "", who: user.id, name: "", due: "" }]);
  const [photos, setPhotos] = useState<PickedFile[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<typeof form>) => setForm({ ...form, ...patch });
  return (
    <Card title="Report an incident">
      <form
        aria-label="Report an effluent incident"
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          setError(null);
          try {
            const body = {
              farmId: farm.id,
              ...form,
              systemId: form.systemId || null,
              occurredAt: new Date(form.occurredAt).toISOString(),
              files: photos.map((photo) => ({ id: photo.id })),
              actions: actions.filter((action) => action.title.trim()).map((action) => ({ title: action.title, assignedToUserId: action.who || null, assignedToName: action.who ? null : action.name || null, due: action.due || null })),
            };
            const outcome = await submitThroughQueue(queue, { operationId, kind: "effluent.incident", label: `${INCIDENT_TYPE_LABELS[form.type]}: ${form.title}`, farmId: farm.id, farmName: farm.name, request: { method: "POST", path: "/api/farming/effluent/incidents", body, refs: waitForFiles(photos, ["files"]) } });
            onDone(outcomeText(outcome.state));
          } catch (caught) {
            setError(`Not saved: ${errorMessage(caught)}`);
          } finally {
            setBusy(false);
          }
        }}
      >
        {error ? <Notice tone="error">{error}</Notice> : null}
        <PhotoPicker organisationId={organisationId} farmId={farm.id} farmName={farm.name} files={photos} onChange={setPhotos} label="Photos (take them now if you can)" />
        <div className={ui.inlineForm}>
          <Field label="What happened">
            <select value={form.type} onChange={(event) => set({ type: event.target.value as IncidentType })}>
              {INCIDENT_TYPES.map((type) => (
                <option key={type} value={type}>
                  {INCIDENT_TYPE_LABELS[type]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="When">
            <input type="datetime-local" value={form.occurredAt} max={nowLocal()} required onChange={(event) => set({ occurredAt: event.target.value })} />
          </Field>
          {systems.length ? (
            <Field label="System">
              <select value={form.systemId} onChange={(event) => set({ systemId: event.target.value })}>
                <option value="">Not a system</option>
                {systems.map((system) => (
                  <option key={system.recordId} value={system.recordId}>
                    {system.data.name}
                  </option>
                ))}
              </select>
            </Field>
          ) : null}
        </div>
        <Field label="In a few words">
          <input value={form.title} required maxLength={150} onChange={(event) => set({ title: event.target.value })} placeholder="e.g. Sump overflowed into the drain" />
        </Field>
        <Field label="What happened">
          <textarea rows={3} value={form.whatHappened} maxLength={4000} onChange={(event) => set({ whatHappened: event.target.value })} />
        </Field>
        <Field label="What was done straight away" hint="ORC's guide sheet: turn off the pump, block the drain, call a suction tanker.">
          <textarea rows={2} value={form.immediateAction} maxLength={2000} onChange={(event) => set({ immediateAction: event.target.value })} />
        </Field>
        <label className={ui.checkbox} style={{ minHeight: 44 }}>
          <input type="checkbox" checked={form.reachedWater} onChange={(event) => set({ reachedWater: event.target.checked })} /> It reached water, a drain or a neighbour&apos;s place
        </label>
        <ActionFields actions={actions} onChange={setActions} people={people} meId={user.id} />
        <p className={ui.muted}>{NEVER_SENDS}</p>
        <div className={ui.actions}>
          <Button type="submit" disabled={busy || !form.title.trim()}>
            Save the incident
          </Button>
          <Button variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </form>
    </Card>
  );
}

const STATE_TONE: Record<IncidentView["state"], "neutral" | "amber" | "green"> = { open: "amber", actions: "amber", closed: "green", withdrawn: "neutral" };
const STATE_LABEL: Record<IncidentView["state"], string> = { open: "Open", actions: "Actions open", closed: "Closed", withdrawn: "Withdrawn" };

function IncidentRow({ organisationId, farm, incident, canClose, people, onSaved }: Ctx & { incident: IncidentView; canClose: boolean; people: Array<{ userId: string; name: string }>; onSaved: (text: string) => void }) {
  const [open, setOpen] = useState<"more" | "told" | "close" | "action" | "check" | null>(null);
  const data = incident.data;
  return (
    <li style={{ borderTop: "1px solid var(--border)", padding: "10px 0" }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
        <strong style={{ overflowWrap: "anywhere" }}>{data.title}</strong>
        <span className={ui.muted}>{INCIDENT_TYPE_LABELS[data.type]}</span>
        <Badge tone={STATE_TONE[incident.state]}>{STATE_LABEL[incident.state]}</Badge>
        {data.reachedWater ? <Badge tone="red">Reached water or a drain</Badge> : null}
        {/* The consent's condition as information only: the farm decides (Jess, 29 October 2026). */}
        {incident.state !== "withdrawn" ? incident.checkedOnSite ? <Badge tone="blue">Checked</Badge> : <Badge>Reported, not yet checked</Badge> : null}
      </div>
      <div className={ui.muted} style={{ fontSize: "var(--text-sm)" }}>
        Happened {formatDateTime(data.occurredAt)} · reported {formatDateTime(incident.firstEnteredAt)} by {incident.firstEnteredByName || incident.firstEnteredByEmail}
      </div>
      {data.checked ? <div>Checked: {data.checked.note}</div> : null}
      {incident.tellCouncil && !data.councilTold ? (
        <div className={ui.muted}>
          For information, your consent conditions say: {incident.tellCouncil.who}
          {incident.tellCouncil.phone ? `, ${incident.tellCouncil.phone}` : ""}: {incident.tellCouncil.when} The farm decides; Tohyee doesn&apos;t contact the council.
        </div>
      ) : null}
      {data.councilTold ? (
        <div>
          Council told {formatDate(data.councilTold.on)} {COUNCIL_TOLD_HOW[data.councilTold.how]}
          {data.councilTold.who ? `, ${data.councilTold.who}` : ""}
          {data.councilTold.reference ? `, reference ${data.councilTold.reference}` : ""}
        </div>
      ) : null}
      {incident.actions.length ? (
        <ul style={{ margin: "4px 0", paddingLeft: 18 }}>
          {incident.actions.map((action) => (
            <li key={action.recordId}>
              <Link href={safetyHref({ farmId: farm.id, screen: "reports", action: action.recordId })}>{action.data.title}</Link> <span className={ui.muted}>({ACTION_STATE_LABELS[action.state as ActionState] ?? action.state}{action.data.assignedToName ? `, ${action.data.assignedToName}` : ""}{action.data.due ? `, by ${formatDate(action.data.due)}` : ""})</span>
            </li>
          ))}
        </ul>
      ) : null}
      <div className={ui.actions} style={{ justifyContent: "flex-start", flexWrap: "wrap" }}>
        <Button variant="secondary" size="small" aria-expanded={open === "more"} onClick={() => setOpen(open === "more" ? null : "more")}>
          More
        </Button>
        {incident.state === "open" || incident.state === "actions" ? (
          <>
            <Button variant="secondary" size="small" onClick={() => setOpen(open === "action" ? null : "action")}>
              Add an action
            </Button>
            {!data.councilTold ? (
              <Button variant="secondary" size="small" onClick={() => setOpen(open === "told" ? null : "told")}>
                We told the council
              </Button>
            ) : null}
            {canClose && !data.checked ? (
              <Button variant="secondary" size="small" onClick={() => setOpen(open === "check" ? null : "check")}>
                Checked it
              </Button>
            ) : null}
            {canClose ? (
              <Button variant="secondary" size="small" onClick={() => setOpen(open === "close" ? null : "close")}>
                Close
              </Button>
            ) : null}
          </>
        ) : null}
      </div>
      {open === "more" ? (
        <div>
          {data.whatHappened ? <p style={{ whiteSpace: "pre-wrap" }}>{data.whatHappened}</p> : null}
          {data.immediateAction ? <p>Done straight away: {data.immediateAction}</p> : null}
          {data.closed ? <p>Closed: {data.closed.why}</p> : null}
          <Thumbnails organisationId={organisationId} files={data.files as PickedFile[]} />
          <SafetyHistory organisationId={organisationId} recordId={incident.recordId} />
        </div>
      ) : null}
      {open === "told" ? <CouncilToldForm organisationId={organisationId} incident={incident} onDone={() => { setOpen(null); onSaved("Recorded that the council was told."); }} /> : null}
      {open === "check" ? <CheckedForm organisationId={organisationId} incident={incident} onDone={() => { setOpen(null); onSaved("Recorded what was found."); }} /> : null}
      {open === "close" ? <CloseForm organisationId={organisationId} incident={incident} onDone={() => { setOpen(null); onSaved("Closed."); }} /> : null}
      {open === "action" ? <AddActionForm organisationId={organisationId} incident={incident} people={people} onDone={() => { setOpen(null); onSaved("Action added."); }} /> : null}
    </li>
  );
}

function useRun() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (action: () => Promise<unknown>, done: () => void) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      done();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run };
}

const FORM = { margin: "8px 0", padding: 10, border: "1px solid var(--border)", borderRadius: 8 } as const;

function CouncilToldForm({ organisationId, incident, onDone }: { organisationId: string; incident: IncidentView; onDone: () => void }) {
  const [told, setTold] = useState<CouncilTold>({ on: todayInBrowser(), how: "phone", who: "", reference: "" });
  const { busy, error, run } = useRun();
  return (
    <form style={FORM} onSubmit={(event) => { event.preventDefault(); void run(() => api(`/api/farming/effluent/incidents/${incident.recordId}`, { method: "PATCH", body: { organisationId, step: "council_told", expectedVersion: incident.version, councilTold: told } }), onDone); }}>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <p style={{ marginTop: 0 }}>Record this after you&apos;ve told them yourself. Tohyee doesn&apos;t contact the council.</p>
      <div className={ui.inlineForm}>
        <Field label="On">
          <DateInput value={told.on} max={todayInBrowser()} onChange={(event) => setTold({ ...told, on: event.target.value })} />
        </Field>
        <Field label="How">
          <select value={told.how} onChange={(event) => setTold({ ...told, how: event.target.value as CouncilTold["how"] })}>
            {Object.entries(COUNCIL_TOLD_HOW).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Who you spoke to">
          <input value={told.who ?? ""} maxLength={150} onChange={(event) => setTold({ ...told, who: event.target.value })} />
        </Field>
        <Field label="Their reference">
          <input value={told.reference ?? ""} maxLength={100} onChange={(event) => setTold({ ...told, reference: event.target.value })} />
        </Field>
      </div>
      <Button type="submit" disabled={busy}>
        Save
      </Button>
    </form>
  );
}

/** What was found when someone looked (#491): kept beside the reporter's account, not instead of it. */
function CheckedForm({ organisationId, incident, onDone }: { organisationId: string; incident: IncidentView; onDone: () => void }) {
  const [note, setNote] = useState("");
  const { busy, error, run } = useRun();
  return (
    <form style={FORM} onSubmit={(event) => { event.preventDefault(); void run(() => api(`/api/farming/effluent/incidents/${incident.recordId}`, { method: "PATCH", body: { organisationId, step: "check", expectedVersion: incident.version, note } }), onDone); }}>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <Field label="What you found when you checked" hint="The report stays as the reporter wrote it; this is kept beside it.">
        <textarea rows={2} value={note} required maxLength={2000} onChange={(event) => setNote(event.target.value)} />
      </Field>
      <Button type="submit" disabled={busy || !note.trim()}>
        Save
      </Button>
    </form>
  );
}

function CloseForm({ organisationId, incident, onDone }: { organisationId: string; incident: IncidentView; onDone: () => void }) {
  const [why, setWhy] = useState("");
  const { busy, error, run } = useRun();
  return (
    <form style={FORM} onSubmit={(event) => { event.preventDefault(); void run(() => api(`/api/farming/effluent/incidents/${incident.recordId}`, { method: "PATCH", body: { organisationId, step: "close", expectedVersion: incident.version, why } }), onDone); }}>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <Field label="Why it's closed" hint="Its actions must be checked and closed first.">
        <input value={why} required maxLength={1000} onChange={(event) => setWhy(event.target.value)} />
      </Field>
      <Button type="submit" disabled={busy || !why.trim()}>
        Close it
      </Button>
    </form>
  );
}

function AddActionForm({ organisationId, incident, people, onDone }: { organisationId: string; incident: IncidentView; people: Array<{ userId: string; name: string }>; onDone: () => void }) {
  const { user } = useWorkspace();
  const [actions, setActions] = useState<ActionDraft[]>([{ title: "", who: user.id, name: "", due: "" }]);
  const { busy, error, run } = useRun();
  return (
    <form
      style={FORM}
      onSubmit={(event) => {
        event.preventDefault();
        void run(async () => {
          for (const action of actions.filter((each) => each.title.trim())) {
            await api(`/api/farming/effluent/incidents/${incident.recordId}/actions`, { method: "POST", body: { organisationId, title: action.title, assignedToUserId: action.who || null, assignedToName: action.who ? null : action.name || null, due: action.due || null } });
          }
        }, onDone);
      }}
    >
      {error ? <Notice tone="error">{error}</Notice> : null}
      <ActionFields actions={actions} onChange={setActions} people={people} meId={user.id} />
      <Button type="submit" disabled={busy}>
        Save
      </Button>
    </form>
  );
}

// Today and the calendar ------------------------------------------------------------------------------

type TodayData = { hasEffluent: boolean; reminders: Reminder[]; outOfUse: Array<{ id: string; name: string; because: string | null }>; openIncidents: Array<{ id: string; title: string; tellCouncil: boolean }> };

/** What Today shows from Effluent (decision 1095): nothing on a farm without it. */
export function FarmEffluentToday({ organisationId, farm }: Ctx) {
  const data = useApiData<TodayData>("/api/farming/effluent/today", { organisationId, farmId: farm.id });
  if (!data.data?.hasEffluent) return null;
  const today = data.data;
  return (
    <Card title="Effluent">
      {today.outOfUse.map((system) => (
        <Notice key={system.id} tone="error">
          {system.name}: out of use{system.because ? ` (${system.because})` : ""}. Don&apos;t use it.
        </Notice>
      ))}
      <ReminderList farm={farm} reminders={today.reminders.slice(0, 8)} />
      {today.openIncidents.length ? (
        <p>
          <Link href={effluentHref({ farmId: farm.id, screen: "incidents" })}>
            {today.openIncidents.length} open incident{today.openIncidents.length === 1 ? "" : "s"}

          </Link>
        </p>
      ) : null}
      <p>
        <Link href={effluentHref({ farmId: farm.id })}>Open Effluent</Link> · <Link href={effluentHref({ farmId: farm.id, screen: "log" })}>Irrigation</Link>
      </p>
    </Card>
  );
}

/** Effluent's dates on the farm calendar for the next 90 days (decision 1097). */
export function FarmEffluentDue({ organisationId }: { organisationId: string }) {
  const [from] = useState(todayInBrowser);
  const to = new Date(Date.parse(`${from}T00:00:00Z`) + 90 * 86_400_000).toISOString().slice(0, 10);
  const data = useApiData<{ items: Array<{ date: string; title: string; kind: string; farmId: string }> }>("/api/farming/effluent/due", { organisationId, from, to });
  if (data.error || !data.data || !data.data.items.length) return null;
  return (
    <Card title="Effluent due" description="From Effluent: servicing, Effluent WoF and the consent's expiry, the next 90 days. Incident actions are under Safety due.">
      <ul style={{ margin: 0, paddingLeft: 18 }}>
        {data.data.items.map((item, index) => (
          <li key={`${item.date}-${index}`}>
            <strong>{formatDate(item.date)}</strong> <Link href={effluentHref({ farmId: item.farmId, screen: item.kind === "consent" ? "setup" : "checks" })}>{item.title}</Link>
          </li>
        ))}
      </ul>
    </Card>
  );
}

// The council pack -------------------------------------------------------------------------------------

/** The council pack (decision 1099a): a date range to download. Tohyee never sends it. */
export function PackScreen({ organisationId, farm }: Ctx) {
  const { current } = useWorkspace();
  const today = todayInBrowser();
  const [range, setRange] = useState({ from: `${Number(today.slice(0, 4)) - 1}${today.slice(4)}`, to: today });
  if (current?.role !== "owner" && current?.role !== "admin") return <Notice tone="info">Only an owner or an admin can make the council pack.</Notice>;
  const href = `/api/farming/effluent/pack?${new URLSearchParams({ organisationId, farmId: farm.id, from: range.from, to: range.to }).toString()}`;
  return (
    <div className={styles.overview}>
      <div className={styles.column}>
        <Card title="Download the council pack" description={`${farm.name}'s effluent records for the dates you choose, if the council asks for them.`}>
          <div className={ui.inlineForm}>
            <Field label="From">
              <DateInput value={range.from} max={range.to} onChange={(event) => setRange({ ...range, from: event.target.value })} />
            </Field>
            <Field label="To">
              <DateInput value={range.to} max={today} onChange={(event) => setRange({ ...range, to: event.target.value })} />
            </Field>
          </div>
          <p>
            <a className={ui.linkButton} href={href} download>
              Download (zip)
            </a>
          </p>
          <p className={ui.muted}>Tohyee doesn&apos;t send this to anyone. You download it and give it to the council yourself.</p>
        </Card>
      </div>
      <div className={styles.column}>
        <Card title="What's in it">
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            <li>A summary: the runs compared with the consent conditions as entered, in counts (it never says the farm complies), pond levels, days not applied, incidents.</li>
            <li>A map of the paddocks shaded by applications (applied-areas.svg).</li>
            <li>Every run, pond reading, day not applied, check, fault, release, service, incident and action, each with its full history: who entered it and when (set by Tohyee), corrections with the earlier versions and why, withdrawn records marked.</li>
            <li>Depth as entered (measured or declared) beside the estimate from the settings; positions and tractor areas are phone GPS estimates.</li>
            <li>Photos with the camera&apos;s time, the phone&apos;s time and where the phone said it was.</li>
            <li>The history&apos;s numbers and hashes, and a small program (verify.mjs) that checks the records weren&apos;t changed after they were saved. It can&apos;t show that what was entered is true.</li>
          </ul>
          <p>
            The weekly copy off the farm can include the effluent records too: <Link href={safetyHref({ farmId: farm.id, screen: "records" })}>Safety › Records and settings</Link>.
          </p>
        </Card>
      </div>
    </div>
  );
}
