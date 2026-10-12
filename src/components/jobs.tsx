"use client";

import Link from "next/link";
import { useState } from "react";
import { Money } from "@/components/books";
import { useConfirm } from "@/components/confirm-dialog";
import { useApiData } from "@/components/hooks";
import { RecordExtrasPanel } from "@/components/records/record-extras";
import { Badge, Button, Card, Empty, Field, Notice, ui, WarningNote } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { api, errorMessage, newIdempotencyKey } from "@/lib/client/api";
import { formatDate, personName, todayInBrowser } from "@/lib/format";
import type { Item } from "@/lib/items/service";
import { formatMinutes } from "@/lib/projects/amounts";
import type { JobDetails, JobSummary, Material, ServiceReminder, Visit, VisitStatus } from "@/lib/projects/jobs";
import type { Project, StaffRate } from "@/lib/projects/service";

/**
 * Jobs and visits inside Projects (examples JV1-JV9): a job is a project with
 * a site; its visits are on a calendar; Start and Finish fill in hours the
 * staff member confirms into project time; materials go on the project
 * invoice, where their stock goes out.
 */

const VISIT_STATUS: Record<VisitStatus, { label: string; tone: "blue" | "amber" | "green" | "neutral" }> = {
  scheduled: { label: "Booked", tone: "blue" },
  started: { label: "On site", tone: "amber" },
  finished: { label: "Finished", tone: "green" },
  cancelled: { label: "Cancelled", tone: "neutral" },
};

/** Two visits for one person overlap (JV2): allowed, but shown on its own line so it wraps on a phone. */
function ClashNote({ text }: { text: string }) {
  return (
    <div>
      <WarningNote text={text} />
    </div>
  );
}

function VisitBadge({ status }: { status: VisitStatus }) {
  return <Badge tone={VISIT_STATUS[status].tone}>{VISIT_STATUS[status].label}</Badge>;
}

function useRun() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run<T>(action: () => Promise<T>, done?: (result: T) => void) {
    setBusy(true);
    setError(null);
    try {
      const result = await action();
      done?.(result);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, run, setError };
}

const TIME_ZONE = "Pacific/Auckland";
const DETAILS = { display: "grid", gridTemplateColumns: "max-content minmax(0, 1fr)", gap: "4px 16px", margin: "0 0 12px", overflowWrap: "anywhere" } as const;
const LIST = { listStyle: "none", padding: 0, margin: 0, display: "grid", gap: "8px" } as const;

function timeOf(value: string): string {
  return new Date(value).toLocaleTimeString("en-NZ", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: TIME_ZONE });
}

function dayOf(value: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(value));
}

function addDays(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number);
  const next = new Date(Date.UTC(year, month - 1, day + days));
  return next.toISOString().slice(0, 10);
}

/** Monday of the week a date is in. */
function weekStart(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return addDays(date, -((weekday + 6) % 7));
}

function weekdayName(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString("en-NZ", { weekday: "long", day: "numeric", month: "short", timeZone: "UTC" });
}

/** A browser datetime-local value (the device's own time, NZ) as an instant. */
function instant(local: string): string {
  return new Date(local).toISOString();
}

function useStaff(organisationId: string) {
  return useApiData<{ rates: StaffRate[] }>("/api/project-staff-rates", { organisationId });
}

function staffLabel(member: StaffRate): string {
  return member.displayName || member.email;
}

// ---------------------------------------------------------------------------
// Jobs list and service reminders (JV1, JV8)

export function JobsList({ organisationId }: { organisationId: string }) {
  const list = useApiData<{ jobs: JobSummary[]; reminders: ServiceReminder[] }>("/api/jobs", { organisationId });
  const open = list.data?.jobs.filter((job) => job.status === "in_progress") ?? [];
  const closed = list.data?.jobs.filter((job) => job.status !== "in_progress") ?? [];
  return (
    <>
      {list.data && list.data.reminders.length > 0 ? (
        <Card title="Services due" description="A job's service interval after its last finished visit, until another visit is booked. Shown here only; no text or email goes to the customer.">
          <ul style={LIST}>
            {list.data.reminders.map((reminder) => (
              <li key={reminder.projectId}>
                <strong>{reminder.message}</strong> · due {formatDate(reminder.dueOn)} (last visit {formatDate(reminder.lastVisit)}){" "}
                <Link href={`/operations/projects/${reminder.projectId}#visits`}>Book a visit</Link>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
      <Card
        title="Jobs"
        description="Projects with a site. Make a project a job on its page (Job details), then book visits."
        actions={
          <div className={ui.actions}>
            <Link className={`${ui.button} ${ui.secondary}`} href="/operations/jobs/calendar">
              Calendar
            </Link>
            <Link className={`${ui.button} ${ui.secondary}`} href="/operations/jobs/my-visits">
              My visits
            </Link>
          </div>
        }
      >
        {list.error ? <Notice tone="error">{list.error}</Notice> : null}
        {!list.data && !list.error ? <p className={ui.muted}>Loading…</p> : null}
        {list.data && list.data.jobs.length === 0 ? <Empty>No jobs yet. Open a project and tick &ldquo;This is a job&rdquo;.</Empty> : null}
        {open.length + closed.length > 0 ? (
          <div className={ui.tableWrap}>
            <table className={`${ui.table} ${ui.stackOnPhone}`}>
              <thead>
                <tr>
                  <th>Job</th>
                  <th>Customer</th>
                  <th>Site</th>
                  <th>Next visit</th>
                  <th>Last visit</th>
                </tr>
              </thead>
              <tbody>
                {[...open, ...closed].map((job) => (
                  <tr key={job.projectId}>
                    <td data-label="Job">
                      <Link href={`/operations/projects/${job.projectId}`}>{job.name}</Link> {job.status !== "in_progress" ? <Badge tone="neutral">Closed</Badge> : null}
                    </td>
                    <td data-label="Customer">{job.contactName}</td>
                    <td data-label="Site">{job.siteAddress}</td>
                    <td data-label="Next visit">{job.nextVisit ? `${formatDate(dayOf(job.nextVisit))} ${timeOf(job.nextVisit)}` : ""}</td>
                    <td data-label="Last visit">{job.lastVisit ? formatDate(dayOf(job.lastVisit)) : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </Card>
    </>
  );
}

// ---------------------------------------------------------------------------
// Booking a visit (JV2)

function ScheduleVisitForm({
  organisationId,
  projectId,
  tasks,
  onBooked,
}: {
  organisationId: string;
  projectId: string;
  tasks: Array<{ id: string; name: string }>;
  onBooked: (visit: Visit) => void;
}) {
  const staff = useStaff(organisationId);
  const { user } = useWorkspace();
  const tomorrow = addDays(todayInBrowser(), 1);
  const [userId, setUserId] = useState(user.id);
  const [taskId, setTaskId] = useState(tasks[0]?.id ?? "");
  const [startsAt, setStartsAt] = useState(`${tomorrow}T09:00`);
  const [endsAt, setEndsAt] = useState(`${tomorrow}T11:00`);
  const [notes, setNotes] = useState("");
  const [key, setKey] = useState(() => newIdempotencyKey("visit"));
  const { busy, error, run } = useRun();
  if (tasks.length === 0) return <p className={ui.muted}>Add a task (such as Labour) before booking visits: a visit&apos;s hours go onto a task.</p>;
  const submit = () =>
    void run(
      () =>
        api<{ visit: Visit }>("/api/jobs/visits", {
          method: "POST",
          body: { organisationId, source: "ui", idempotencyKey: key, projectId, taskId, userId, startsAt: instant(startsAt), endsAt: instant(endsAt), notes: notes || null },
        }),
      (result) => {
        setKey(newIdempotencyKey("visit"));
        setNotes("");
        onBooked(result.visit);
      },
    );
  return (
    <>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <div className={ui.inlineForm}>
        <Field label="Who">
          <select value={userId} onChange={(event) => setUserId(event.target.value)}>
            {(staff.data?.rates ?? []).map((member) => (
              <option key={member.userId} value={member.userId}>
                {staffLabel(member)}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Task">
          <select value={taskId} onChange={(event) => setTaskId(event.target.value)}>
            {tasks.map((task) => (
              <option key={task.id} value={task.id}>
                {task.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Starts">
          <input type="datetime-local" value={startsAt} onChange={(event) => setStartsAt(event.target.value)} />
        </Field>
        <Field label="Ends">
          <input type="datetime-local" value={endsAt} onChange={(event) => setEndsAt(event.target.value)} />
        </Field>
        <Field label="Notes">
          <input value={notes} maxLength={1000} onChange={(event) => setNotes(event.target.value)} />
        </Field>
        <Button onClick={submit} disabled={busy || !startsAt || !endsAt}>
          {busy ? "Booking…" : "Book visit"}
        </Button>
      </div>
    </>
  );
}

function VisitRows({ visits, showJob }: { visits: Visit[]; showJob?: boolean }) {
  return (
    <div className={ui.tableWrap}>
      <table className={`${ui.table} ${ui.stackOnPhone}`}>
        <thead>
          <tr>
            <th>When</th>
            {showJob ? <th>Job</th> : null}
            <th>Who</th>
            <th>Status</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {visits.map((visit) => (
            <tr key={visit.id}>
              <td data-label="When">
                {formatDate(dayOf(visit.startsAt))} {timeOf(visit.startsAt)}-{timeOf(visit.endsAt)}
                {visit.clash ? <ClashNote text={visit.clash} /> : null}
              </td>
              {showJob ? (
                <td data-label="Job">
                  {visit.contactName}: {visit.projectName}
                  {visit.siteAddress ? <div className={ui.muted}>{visit.siteAddress}</div> : null}
                </td>
              ) : null}
              <td data-label="Who">{personName(visit, "user")}</td>
              <td data-label="Status">
                <VisitBadge status={visit.status} />
              </td>
              <td>
                <Link href={`/operations/jobs/visits/${visit.id}`}>Open</Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// On a project's page: job details, its visits and materials

export function JobSection({
  organisationId,
  project,
  materials,
  onMaterialsChanged,
}: {
  organisationId: string;
  project: Project;
  materials: Material[];
  onMaterialsChanged: () => void;
}) {
  const { can } = useWorkspace();
  const loaded = useApiData<{ job: JobDetails }>(`/api/projects/${project.id}/job`, { organisationId });
  const [job, setJob] = useState<JobDetails | null>(null);
  const [editing, setEditing] = useState(false);
  const current = job ?? loaded.data?.job ?? null;
  if (loaded.error) return <Notice tone="error">{loaded.error}</Notice>;
  if (!current) return null;
  const open = project.status === "in_progress" && can("bookkeeper");
  if (!current.isJob && !editing) {
    return open ? (
      <Card title="Job" description="Make this project a job to book visits at a site, with a checklist, materials and service reminders.">
        <Button variant="secondary" onClick={() => setEditing(true)}>
          Make this a job
        </Button>
      </Card>
    ) : null;
  }
  return (
    <>
      <Card title="Job details" actions={open && !editing ? <Button variant="secondary" onClick={() => setEditing(true)}>Edit</Button> : null}>
        {editing ? (
          <JobEditor
            organisationId={organisationId}
            job={current}
            onSaved={(saved) => {
              setJob(saved);
              setEditing(false);
            }}
            onCancel={() => setEditing(false)}
          />
        ) : (
          <dl style={DETAILS}>
            <dt>Site</dt>
            <dd>{current.siteAddress}</dd>
            <dt>Contact on site</dt>
            <dd>{current.siteContact ?? "—"}</dd>
            <dt>Service</dt>
            <dd>{current.serviceIntervalMonths ? `Every ${current.serviceIntervalMonths} months from the last visit` : "No service reminder"}</dd>
            <dt>Checklist</dt>
            <dd>{current.checklistItems.length > 0 ? current.checklistItems.join(", ") : "None"}</dd>
          </dl>
        )}
      </Card>
      {current.isJob ? (
        <>
          <JobVisits organisationId={organisationId} project={project} />
          <MaterialsCard organisationId={organisationId} projectId={project.id} open={open} materials={materials} onChanged={onMaterialsChanged} />
        </>
      ) : null}
    </>
  );
}

function JobEditor({ organisationId, job, onSaved, onCancel }: { organisationId: string; job: JobDetails; onSaved: (job: JobDetails) => void; onCancel: () => void }) {
  const [isJob, setIsJob] = useState(true);
  const [siteAddress, setSiteAddress] = useState(job.siteAddress ?? "");
  const [siteContact, setSiteContact] = useState(job.siteContact ?? "");
  const [interval, setInterval] = useState(job.serviceIntervalMonths ? String(job.serviceIntervalMonths) : "");
  const [checklist, setChecklist] = useState(job.checklistItems.join("\n"));
  const { busy, error, run } = useRun();
  const save = () =>
    void run(
      () =>
        api<{ job: JobDetails }>(`/api/projects/${job.projectId}/job`, {
          method: "PUT",
          body: {
            organisationId,
            isJob,
            siteAddress: siteAddress.trim() || null,
            siteContact: siteContact.trim() || null,
            serviceIntervalMonths: interval.trim() || null,
            checklistItems: checklist
              .split("\n")
              .map((line) => line.trim())
              .filter(Boolean),
          },
        }),
      (result) => onSaved(result.job),
    );
  return (
    <>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <div className={ui.grid2}>
        <label className={ui.checkbox}>
          <input type="checkbox" checked={isJob} onChange={(event) => setIsJob(event.target.checked)} /> This is a job
        </label>
        <Field label="Site address">
          <input value={siteAddress} maxLength={500} onChange={(event) => setSiteAddress(event.target.value)} />
        </Field>
        <Field label="Contact on site" hint="Who to ask for, and their number.">
          <input value={siteContact} maxLength={200} onChange={(event) => setSiteContact(event.target.value)} />
        </Field>
        <Field label="Service every (months)" hint="Blank: no service reminder. 12 is an annual service.">
          <input inputMode="numeric" value={interval} onChange={(event) => setInterval(event.target.value)} />
        </Field>
        <Field label="Checklist" hint="One item per line. Each visit ticks them off.">
          <textarea rows={4} value={checklist} onChange={(event) => setChecklist(event.target.value)} />
        </Field>
        <div className={ui.actions}>
          <Button onClick={save} disabled={busy}>
            {busy ? "Saving…" : "Save"}
          </Button>
          <Button variant="secondary" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
        </div>
      </div>
    </>
  );
}

function JobVisits({ organisationId, project }: { organisationId: string; project: Project }) {
  const { can } = useWorkspace();
  const visits = useApiData<{ visits: Visit[] }>("/api/jobs/visits", { organisationId, projectId: project.id, from: "2000-01-01", to: "2100-12-31" });
  const tasks = project.tasks.filter((task) => task.status === "active" && task.chargeType !== "fixed");
  return (
    <Card title="Visits" description="Booked visits show on the jobs calendar. Overlapping visits for one person are allowed and flagged.">
      <span id="visits" />
      {visits.error ? <Notice tone="error">{visits.error}</Notice> : null}
      {visits.data && visits.data.visits.length === 0 ? <Empty>No visits yet.</Empty> : null}
      {visits.data && visits.data.visits.length > 0 ? <VisitRows visits={visits.data.visits} /> : null}
      {project.status === "in_progress" && can("bookkeeper") ? (
        <ScheduleVisitForm organisationId={organisationId} projectId={project.id} tasks={tasks} onBooked={() => visits.reload()} />
      ) : null}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Materials (JV4)

function MaterialsCard({
  organisationId,
  projectId,
  open,
  materials,
  visitId,
  onChanged,
}: {
  organisationId: string;
  projectId: string;
  open: boolean;
  materials: Material[];
  visitId?: string;
  onChanged: () => void;
}) {
  const confirm = useConfirm();
  const items = useApiData<{ items: Item[] }>(open ? "/api/items" : null, { organisationId });
  const [itemId, setItemId] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [unitPrice, setUnitPrice] = useState("");
  const { busy, error, run } = useRun();
  const sellable = (items.data?.items ?? []).filter((item) => item.itemType !== "service");
  const shown = materials.filter((material) => material.status === "active" && (!visitId || material.visitId === visitId));
  const add = () =>
    void run(
      () => api(`/api/projects/${projectId}/materials`, { method: "POST", body: { organisationId, itemId, quantity, unitPrice: unitPrice || null, visitId: visitId ?? null } }),
      () => {
        setQuantity("1");
        setUnitPrice("");
        onChanged();
      },
    );
  const remove = async (material: Material) => {
    if (!(await confirm(`Take ${material.quantity} x ${material.itemName} off the job?`))) return;
    void run(() => api(`/api/projects/${projectId}/materials/${material.id}`, { method: "DELETE", body: { organisationId } }), onChanged);
  };
  return (
    <Card title="Materials" description="Used on the job and charged on the project invoice. Stock goes out when that invoice is approved, not before.">
      {error ? <Notice tone="error">{error}</Notice> : null}
      {shown.length === 0 ? <Empty>No materials yet.</Empty> : null}
      {shown.length > 0 ? (
        <div className={ui.tableWrap}>
          <table className={`${ui.table} ${ui.stackOnPhone}`}>
            <thead>
              <tr>
                <th>Item</th>
                <th className={ui.num}>Quantity</th>
                <th className={ui.num}>Price</th>
                <th className={ui.num}>Amount</th>
                <th>Invoice</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {shown.map((material) => (
                <tr key={material.id}>
                  <td data-label="Item">
                    {material.itemCode} · {material.itemName}
                  </td>
                  <td data-label="Quantity" className={ui.num}>
                    {material.quantity}
                  </td>
                  <td data-label="Price" className={ui.num}>
                    <Money value={material.unitPrice} />
                  </td>
                  <td data-label="Amount" className={ui.num}>
                    <Money value={material.amount} />
                  </td>
                  <td data-label="Invoice">{material.invoiceNumber ?? <span className={ui.muted}>Not invoiced</span>}</td>
                  <td>
                    {open && !material.invoiceNumber ? (
                      <Button size="small" variant="secondary" onClick={() => void remove(material)} disabled={busy}>
                        Remove
                      </Button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {open ? (
        <div className={ui.inlineForm}>
          <Field label="Item">
            <select value={itemId} onChange={(event) => setItemId(event.target.value)}>
              <option value="">Choose…</option>
              {sellable.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.code} · {item.name}
                  {item.salePrice ? ` (${item.salePrice})` : ""}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Quantity">
            <input inputMode="decimal" value={quantity} onChange={(event) => setQuantity(event.target.value)} />
          </Field>
          <Field label="Unit price" hint="Blank: the item's sale price.">
            <input inputMode="decimal" value={unitPrice} onChange={(event) => setUnitPrice(event.target.value)} />
          </Field>
          <Button onClick={add} disabled={busy || !itemId || !quantity}>
            Add
          </Button>
        </div>
      ) : null}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Calendar (JV2, JV9)

export function JobCalendar({ organisationId }: { organisationId: string }) {
  const staff = useStaff(organisationId);
  const [from, setFrom] = useState(() => weekStart(todayInBrowser()));
  const [userId, setUserId] = useState("");
  const to = addDays(from, 6);
  const visits = useApiData<{ visits: Visit[] }>("/api/jobs/visits", { organisationId, from, to, userId: userId || null });
  const days = Array.from({ length: 7 }, (_, index) => addDays(from, index));
  const shown = (visits.data?.visits ?? []).filter((visit) => visit.status !== "cancelled");
  const icsQuery = new URLSearchParams({ organisationId, from, to: addDays(from, 90), format: "ics", ...(userId ? { userId } : {}) });
  return (
    <Card
      title={`Week of ${formatDate(from)}`}
      description="Visits by day. Book visits from a job's page."
      actions={
        <div className={ui.actions}>
          <Button variant="secondary" onClick={() => setFrom(addDays(from, -7))}>
            Previous week
          </Button>
          <Button variant="secondary" onClick={() => setFrom(weekStart(todayInBrowser()))}>
            This week
          </Button>
          <Button variant="secondary" onClick={() => setFrom(addDays(from, 7))}>
            Next week
          </Button>
        </div>
      }
    >
      <div className={ui.inlineForm}>
        <Field label="Staff member">
          <select value={userId} onChange={(event) => setUserId(event.target.value)}>
            <option value="">Everyone</option>
            {(staff.data?.rates ?? []).map((member) => (
              <option key={member.userId} value={member.userId}>
                {staffLabel(member)}
              </option>
            ))}
          </select>
        </Field>
        <a className={`${ui.button} ${ui.secondary}`} href={`/api/jobs/visits?${icsQuery.toString()}`}>
          Download calendar file
        </a>
      </div>
      <p className={ui.muted}>
        The calendar file has the next 90 days&apos; visits, to add to Google or Microsoft calendar. It&apos;s one way: moving an event there doesn&apos;t move the visit.
      </p>
      {visits.error ? <Notice tone="error">{visits.error}</Notice> : null}
      {!visits.data && !visits.error ? <p className={ui.muted}>Loading…</p> : null}
      {visits.data
        ? days.map((day) => {
            const onDay = shown.filter((visit) => dayOf(visit.startsAt) === day);
            return (
              <section key={day}>
                <h3>{weekdayName(day)}</h3>
                {onDay.length === 0 ? <p className={ui.muted}>No visits.</p> : <VisitRows visits={onDay} showJob />}
              </section>
            );
          })
        : null}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// My visits (JV3)

export function MyVisits({ organisationId }: { organisationId: string }) {
  const today = todayInBrowser();
  const visits = useApiData<{ visits: Visit[] }>("/api/jobs/visits", { organisationId, from: addDays(today, -7), to: addDays(today, 14), mine: "1" });
  const all = (visits.data?.visits ?? []).filter((visit) => visit.status !== "cancelled");
  const waiting = all.filter((visit) => visit.status === "finished" && !visit.timeEntryId);
  const todays = all.filter((visit) => dayOf(visit.startsAt) === today && !waiting.includes(visit));
  const later = all.filter((visit) => dayOf(visit.startsAt) > today && visit.status === "scheduled");
  return (
    <>
      {visits.error ? <Notice tone="error">{visits.error}</Notice> : null}
      {waiting.length > 0 ? (
        <Card title="Hours to confirm" description="Finished visits whose hours aren't in project time yet.">
          <VisitRows visits={waiting} showJob />
        </Card>
      ) : null}
      <Card title="Today">{visits.data ? todays.length === 0 ? <Empty>No visits today.</Empty> : <VisitRows visits={todays} showJob /> : <p className={ui.muted}>Loading…</p>}</Card>
      <Card title="Coming up">{visits.data ? later.length === 0 ? <Empty>Nothing booked in the next two weeks.</Empty> : <VisitRows visits={later} showJob /> : null}</Card>
    </>
  );
}

// ---------------------------------------------------------------------------
// A visit (JV3, JV5, JV6)

export function VisitView({ organisationId, visitId }: { organisationId: string; visitId: string }) {
  const { can, user } = useWorkspace();
  const confirm = useConfirm();
  const loaded = useApiData<{ visit: Visit }>(`/api/jobs/visits/${encodeURIComponent(visitId)}`, { organisationId });
  const [updated, setUpdated] = useState<Visit | null>(null);
  const visit = updated ?? loaded.data?.visit ?? null;
  const materials = useApiData<{ materials: Material[] }>(visit ? `/api/projects/${visit.projectId}/materials` : null, { organisationId });
  const [minutes, setMinutes] = useState("");
  const [signedBy, setSignedBy] = useState("");
  const [moving, setMoving] = useState(false);
  const [key, setKey] = useState(() => newIdempotencyKey("visit-hours"));
  const { busy, error, run, setError } = useRun();
  if (loaded.error) return <Notice tone="error">{loaded.error}</Notice>;
  if (!visit) return <p className={ui.muted}>Loading…</p>;
  const mine = visit.userId === user.id || can("admin");
  const act = (body: Record<string, unknown>) =>
    void run(() => api<{ visit: Visit }>(`/api/jobs/visits/${visit.id}`, { method: "POST", body: { organisationId, ...body } }), (result) => setUpdated(result.visit));
  const finish = async () => {
    setError(null);
    const open = visit.checks.filter((check) => !check.tickedAt).map((check) => check.item);
    if (open.length > 0 && !(await confirm(`Not ticked yet: ${open.join(", ")}. Finish anyway?`))) return;
    act({ action: "finish", finishAnyway: open.length > 0 });
  };
  const cancel = async () => {
    if (!(await confirm("Cancel this visit?"))) return;
    void run(() => api<{ visit: Visit }>(`/api/jobs/visits/${visit.id}`, { method: "PATCH", body: { organisationId, cancel: true } }), (result) => setUpdated(result.visit));
  };
  return (
    <>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <Card title={`${visit.contactName}: ${visit.projectName}`}>
        <dl style={DETAILS}>
          <dt>Status</dt>
          <dd>
            <VisitBadge status={visit.status} />
          </dd>
          <dt>When</dt>
          <dd>
            {formatDate(dayOf(visit.startsAt))} {timeOf(visit.startsAt)}-{timeOf(visit.endsAt)}
            {visit.clash ? <ClashNote text={visit.clash} /> : null}
          </dd>
          <dt>Site</dt>
          <dd>
            {visit.siteAddress ? (
              <a href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(visit.siteAddress)}`} target="_blank" rel="noreferrer">
                {visit.siteAddress}
              </a>
            ) : (
              "—"
            )}
          </dd>
          <dt>Who</dt>
          <dd>{personName(visit, "user")}</dd>
          <dt>Task</dt>
          <dd>{visit.taskName}</dd>
          {visit.notes ? (
            <>
              <dt>Notes</dt>
              <dd>{visit.notes}</dd>
            </>
          ) : null}
          {visit.startedAt ? (
            <>
              <dt>Started</dt>
              <dd>{timeOf(visit.startedAt)}</dd>
            </>
          ) : null}
          {visit.finishedAt ? (
            <>
              <dt>Finished</dt>
              <dd>
                {timeOf(visit.finishedAt)} ({formatMinutes(visit.workedMinutes ?? 0)})
                {visit.finishedWithOpenChecks ? " · finished with unticked checklist items" : ""}
              </dd>
            </>
          ) : null}
        </dl>
        {mine ? (
          <div className={ui.actions}>
            {visit.status === "scheduled" ? (
              <>
                <Button onClick={() => act({ action: "start" })} disabled={busy}>
                  Start
                </Button>
                {can("bookkeeper") ? (
                  <>
                    <Button variant="secondary" onClick={() => setMoving(!moving)} disabled={busy}>
                      Move
                    </Button>
                    <Button variant="danger" onClick={() => void cancel()} disabled={busy}>
                      Cancel visit
                    </Button>
                  </>
                ) : null}
              </>
            ) : null}
            {visit.status === "started" ? (
              <Button onClick={() => void finish()} disabled={busy}>
                Finish
              </Button>
            ) : null}
          </div>
        ) : (
          <p className={ui.muted}>Only {personName(visit, "user")} or an admin can start and finish this visit.</p>
        )}
        {moving && visit.status === "scheduled" ? <MoveVisit organisationId={organisationId} visit={visit} onMoved={(next) => (setUpdated(next), setMoving(false))} /> : null}
      </Card>

      {visit.status === "finished" ? (
        <Card title="Hours" description="Start to Finish fills in the hours. They count as project time once confirmed.">
          {visit.timeEntryId ? (
            <p>
              Confirmed into project time. <Link href={`/operations/projects/${visit.projectId}`}>Open the job</Link>
            </p>
          ) : mine ? (
            <div className={ui.inlineForm}>
              <Field label="Minutes" hint={`Start to Finish: ${formatMinutes(visit.workedMinutes ?? 0)}.`}>
                <input inputMode="numeric" placeholder={String(visit.workedMinutes ?? "")} value={minutes} onChange={(event) => setMinutes(event.target.value)} />
              </Field>
              <Button
                onClick={() => {
                  act({ action: "confirm", idempotencyKey: key, minutes: minutes || null, source: "ui" });
                  setKey(newIdempotencyKey("visit-hours"));
                }}
                disabled={busy}
              >
                Confirm hours
              </Button>
            </div>
          ) : (
            <p className={ui.muted}>Waiting for {personName(visit, "user")} to confirm.</p>
          )}
        </Card>
      ) : null}

      {visit.checks.length > 0 ? (
        <Card title="Checklist">
          <ul style={LIST}>
            {visit.checks.map((check) => (
              <li key={check.item}>
                <label className={ui.checkbox}>
                  <input
                    type="checkbox"
                    checked={!!check.tickedAt}
                    disabled={busy || !mine || visit.status === "cancelled"}
                    onChange={(event) => act({ action: "check", item: check.item, ticked: event.target.checked })}
                  />{" "}
                  {check.item}
                </label>
                {check.tickedAt ? (
                  <span className={ui.muted}>
                    {" "}
                    · {check.tickedByEmail}, {formatDate(dayOf(check.tickedAt))} {timeOf(check.tickedAt)}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <Card title="Sign-off" description="The person on site signs on screen; attach the signature image under Files below.">
        {visit.signedBy ? (
          <p>
            Signed by <strong>{visit.signedBy}</strong> on {formatDate(dayOf(visit.signedAt!))} at {timeOf(visit.signedAt!)}.
          </p>
        ) : null}
        {mine && visit.status !== "cancelled" ? (
          <div className={ui.inlineForm}>
            <Field label="Signed by">
              <input value={signedBy} maxLength={200} onChange={(event) => setSignedBy(event.target.value)} />
            </Field>
            <Button variant="secondary" onClick={() => act({ action: "sign", signedBy })} disabled={busy || !signedBy.trim()}>
              Record signature
            </Button>
          </div>
        ) : null}
      </Card>

      {materials.data ? (
        <MaterialsCard
          organisationId={organisationId}
          projectId={visit.projectId}
          open={can("bookkeeper") && visit.status !== "cancelled"}
          materials={materials.data.materials}
          visitId={visit.id}
          onChanged={() => materials.reload()}
        />
      ) : null}

      <RecordExtrasPanel organisationId={organisationId} recordType="project_visit" recordId={visit.id} title="Photos, files and notes" />
      <p>
        <Link href="/operations/jobs/my-visits">My visits</Link> · <Link href={`/operations/projects/${visit.projectId}`}>The job</Link>
      </p>
    </>
  );
}

function MoveVisit({ organisationId, visit, onMoved }: { organisationId: string; visit: Visit; onMoved: (visit: Visit) => void }) {
  const staff = useStaff(organisationId);
  const local = (value: string) => `${dayOf(value)}T${timeOf(value)}`;
  const [startsAt, setStartsAt] = useState(local(visit.startsAt));
  const [endsAt, setEndsAt] = useState(local(visit.endsAt));
  const [userId, setUserId] = useState(visit.userId);
  const { busy, error, run } = useRun();
  return (
    <>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <div className={ui.inlineForm}>
        <Field label="Who">
          <select value={userId} onChange={(event) => setUserId(event.target.value)}>
            {(staff.data?.rates ?? []).map((member) => (
              <option key={member.userId} value={member.userId}>
                {staffLabel(member)}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Starts">
          <input type="datetime-local" value={startsAt} onChange={(event) => setStartsAt(event.target.value)} />
        </Field>
        <Field label="Ends">
          <input type="datetime-local" value={endsAt} onChange={(event) => setEndsAt(event.target.value)} />
        </Field>
        <Button
          onClick={() =>
            void run(
              () => api<{ visit: Visit }>(`/api/jobs/visits/${visit.id}`, { method: "PATCH", body: { organisationId, startsAt: instant(startsAt), endsAt: instant(endsAt), userId } }),
              (result) => onMoved(result.visit),
            )
          }
          disabled={busy}
        >
          Save
        </Button>
      </div>
    </>
  );
}
