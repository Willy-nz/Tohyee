"use client";

import Link from "next/link";
import { type ReactNode, useState } from "react";
import { DateInput } from "@/components/date-input";
import { type MapOverlay, PaddockMap } from "@/components/farming";
import type { FarmContext } from "@/components/farm-workspace";
import { useApiData } from "@/components/hooks";
import { InfoTip } from "@/components/info-tip";
import { QueuedWork, submitThroughQueue, useOfflineQueue } from "@/components/offline-queue";
import { Badge, Button, Card, Empty, Field, Notice, ui } from "@/components/ui";
import { useWorkspace } from "@/components/workspace";
import { api, errorMessage } from "@/lib/client/api";
import { REPEAT_LABELS, REPEATS, type Repeat } from "@/lib/farming/calendar-shared";
import { addDays, shortDate } from "@/lib/farming/farm-words";
import type { Position } from "@/lib/farming/geometry";
import type { Farm, FarmingSettings, Paddock } from "@/lib/farming/paddocks";
import type { FarmTask, FarmTeamMember, TaskDueItem } from "@/lib/farming/tasks";
import { repeatText, TASK_STATE_LABELS, type TaskState } from "@/lib/farming/tasks-rules";
import { formatDate, formatDateTime, todayInBrowser } from "@/lib/format";
import { newOperationId } from "@/lib/offline/queue";
import styles from "./farm-workspace.module.css";

/*
 * Farm team tasks (decisions 1457-1461): Farm › More › Tasks to add and
 * change them, a card on Today with the farm's tasks due, the next 30
 * days on the farm calendar, and the assigned person's own reminders in
 * the Android app (with their safety actions). Ticking one off goes
 * through the device's queue, so it works with no signal.
 */

export const TASK_DONE_KIND = "farm.task.done";

/** Today's order: overdue, then due today, then this week; the person's own first within each. */
const RANK: Record<TaskState, number> = { overdue: 0, today: 1, soon: 2, later: 3, done: 4 };

const STATE_TONE: Record<TaskState, "red" | "amber" | "blue" | "neutral" | "green"> = { overdue: "red", today: "amber", soon: "blue", later: "neutral", done: "green" };

export function useFarmTasks(organisationId: string, farmId: string, view: "open" | "done" | "cancelled" = "open") {
  return useApiData<{ tasks: FarmTask[] }>(`/api/farming/farms/${farmId}/tasks`, { organisationId, ...(view === "open" ? {} : { view }) });
}

/** Open tasks with a place on the map, as amber "T" dots for the Map tab. */
export function taskOverlays(tasks: FarmTask[], onSelect?: (id: string) => void): MapOverlay[] {
  return tasks
    .filter((task) => task.point && task.next)
    .map((task) => ({
      id: `task-${task.id}`,
      label: `Task: ${task.title}, due ${task.next}${task.assignedToName ? `, for ${task.assignedToName}` : ""}`,
      tone: "warning" as const,
      marker: "dot" as const,
      short: "T",
      point: task.point,
      onSelect: onSelect ? () => onSelect(task.id) : undefined,
    }));
}

function dueText(task: FarmTask, today: string): string {
  if (!task.next) return "Done";
  if (task.next === today) return "Due today";
  return `${task.next < today ? "Was due" : "Due"} ${shortDate(task.next, today)}`;
}

/** Done, through the device's queue: kept on the phone with no signal and sent once. */
function DoneButton({ organisationId, farm, task, onDone }: { organisationId: string; farm: Farm; task: FarmTask; onDone: (message: string) => void }) {
  const { queue } = useOfflineQueue(organisationId);
  const [busy, setBusy] = useState(false);
  const today = todayInBrowser();
  if (!task.next) return null;
  return (
    <Button
      size="small"
      disabled={busy}
      aria-label={`Done: ${task.title}`}
      onClick={async () => {
        setBusy(true);
        try {
          const outcome = await submitThroughQueue(queue, { operationId: newOperationId(), kind: TASK_DONE_KIND, label: `Done: ${task.title} (${shortDate(task.next!, today)})`, farmId: farm.id, farmName: farm.name, meta: { taskId: task.id }, request: { method: "POST", path: `/api/farming/tasks/${task.id}/done`, body: { doneFor: task.next } } });
          onDone(outcome.state === "synced" ? `Done: ${task.title}.` : `Done: ${task.title}. Saved on this device; it goes when Tohyee can be reached.`);
        } catch (caught) {
          onDone(`Not saved: ${errorMessage(caught)}`);
        } finally {
          setBusy(false);
        }
      }}
    >
      Done
    </Button>
  );
}

function TaskLine({ organisationId, farm, task, canRecord, onChanged, onOpen, open, children }: { organisationId: string; farm: Farm; task: FarmTask; canRecord: boolean; onChanged: (message?: string) => void; onOpen?: () => void; open?: boolean; children?: ReactNode }) {
  const today = todayInBrowser();
  const { items } = useOfflineQueue(organisationId);
  const pending = items.some((item) => item.kind === TASK_DONE_KIND && item.status !== "synced" && item.meta.taskId === task.id);
  return (
    <li style={{ display: "grid", gap: 4, padding: "10px 0", borderBottom: "1px solid var(--border)" }}>
      <span style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ display: "grid", gap: 2 }}>
          {onOpen ? (
            <button type="button" className={ui.linkButton} style={{ textAlign: "left" }} aria-expanded={open} onClick={onOpen}>
              <strong>{task.title}</strong>
            </button>
          ) : (
            <strong>{task.title}</strong>
          )}
          <span className={ui.muted}>
            {[dueText(task, today), task.repeat ? REPEAT_LABELS[task.repeat] : null, task.assignedToName ? `for ${task.assignedToName}` : "anyone", task.paddockName ? `paddock ${task.paddockName}` : null, task.point ? "on the map" : null].filter(Boolean).join(" · ")}
          </span>
        </span>
        <span style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {task.needsReassigning ? <Badge tone="amber">Needs reassigning</Badge> : null}
          <Badge tone={STATE_TONE[task.state]}>{TASK_STATE_LABELS[task.state]}</Badge>
          {pending ? <Badge>Waiting to send</Badge> : canRecord ? <DoneButton organisationId={organisationId} farm={farm} task={task} onDone={(message) => onChanged(message)} /> : null}
        </span>
      </span>
      {children}
    </li>
  );
}

/** Today's card: the farm's tasks overdue, due today and in the next 7 days, the person's own first. */
export function FarmTasksToday({ organisationId, farm }: { organisationId: string; farm: Farm }) {
  const { user, can, current } = useWorkspace();
  const canRecord = current?.role === "farm_worker" || can("bookkeeper");
  const tasks = useFarmTasks(organisationId, farm.id);
  const [message, setMessage] = useState<string | null>(null);
  if (tasks.error) return <Notice tone="error">Couldn&apos;t load the farm&apos;s tasks: {tasks.error}</Notice>;
  if (!tasks.data) return null;
  const due = tasks.data.tasks.filter((task) => task.state === "overdue" || task.state === "today" || task.state === "soon").sort((a, b) => RANK[a.state] - RANK[b.state] || Number(b.assignedToUserId === user.id) - Number(a.assignedToUserId === user.id) || (a.next ?? "").localeCompare(b.next ?? ""));
  return (
    <Card title="Tasks" description={due.length ? undefined : "Farm team jobs, with who and when."}>
      {message ? <Notice tone={message.startsWith("Not saved") ? "error" : "success"}>{message}</Notice> : null}
      {due.length ? (
        <ul className={styles.links} aria-label="Tasks due">
          {due.slice(0, 8).map((task) => (
            <TaskLine
              key={task.id}
              organisationId={organisationId}
              farm={farm}
              task={task}
              canRecord={canRecord}
              onChanged={(text) => {
                setMessage(text ?? null);
                tasks.reload();
              }}
            />
          ))}
        </ul>
      ) : (
        <p>No tasks due this week.</p>
      )}
      {due.length > 8 ? <p className={ui.muted}>And {due.length - 8} more.</p> : null}
      <p>
        <Link href={`/operations/farming/tasks?farm=${farm.id}`}>All tasks</Link>
        {canRecord ? (
          <>
            {" "}
            · <Link href={`/operations/farming/tasks?farm=${farm.id}&new=1`}>Add a task</Link>
          </>
        ) : null}
      </p>
    </Card>
  );
}

/** Tasks on the farm calendar for the next 30 days (decision 1460), every farm the person can see. */
export function FarmTasksDue({ organisationId }: { organisationId: string }) {
  const from = todayInBrowser();
  const data = useApiData<{ items: TaskDueItem[] }>("/api/farming/tasks/due", { organisationId, from, to: addDays(from, 30) });
  if (data.error || !data.data || !data.data.items.length) return null;
  return (
    <Card title="Tasks due">
      <ul style={{ margin: 0, paddingLeft: 18 }}>
        {data.data.items.map((item) => (
          <li key={item.key}>
            <strong>{formatDate(item.date)}</strong> {item.overdue ? <Badge tone="red">Overdue</Badge> : null} {item.needsReassigning ? <Badge tone="amber">Needs reassigning</Badge> : null} {item.title}
            <span className={ui.muted}>
              {" "}
              · {item.farmName}
              {item.assignedToName ? ` · ${item.assignedToName}` : ""}
            </span>
          </li>
        ))}
      </ul>
      <p>
        <Link href="/operations/farming/tasks">Open Tasks</Link>
      </p>
    </Card>
  );
}

// The Tasks page ---------------------------------------------------------------------------------------

type Filter = "everyone" | "mine";

export function FarmTasks({ organisationId, farm, startNew = false }: FarmContext & { startNew?: boolean }) {
  const { user, can, current } = useWorkspace();
  const canRecord = current?.role === "farm_worker" || can("bookkeeper");
  const [view, setView] = useState<"open" | "done" | "cancelled">("open");
  const tasks = useFarmTasks(organisationId, farm.id, view);
  const [filter, setFilter] = useState<Filter>("everyone");
  const [adding, setAdding] = useState(startNew && canRecord);
  const [open, setOpen] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const shown = (tasks.data?.tasks ?? []).filter((task) => filter === "everyone" || task.assignedToUserId === user.id);
  const groups: Array<{ state: TaskState; tasks: FarmTask[] }> = (["overdue", "today", "soon", "later", "done"] as const).map((state) => ({ state, tasks: shown.filter((task) => task.state === state) })).filter((group) => group.tasks.length);
  const changed = (text?: string) => {
    setMessage(text ?? null);
    tasks.reload();
  };
  return (
    <div style={{ display: "grid", gap: 16 }}>
      {canRecord ? (
        adding ? (
          <TaskForm organisationId={organisationId} farm={farm} task={null} onClose={() => setAdding(false)} onSaved={() => changed("Task added.")} />
        ) : (
          <div className={styles.actions}>
            <Button onClick={() => setAdding(true)}>Add a task</Button>
          </div>
        )
      ) : null}
      <Card
        title={`Tasks on ${farm.name}`}
        description={
          <>
            Jobs for the farm team, with who and when.{" "}
            <InfoTip label="About tasks">
              A task is due on a day and can repeat. Marking it done keeps who did it and when; a repeating task then moves to its next day. The person it&apos;s for gets a reminder on the day in the Tohyee Android app, if they&apos;ve turned reminders on. Tasks show on Today and the farm calendar.
            </InfoTip>
          </>
        }
      >
        {message ? <Notice tone={message.startsWith("Not saved") ? "error" : "success"}>{message}</Notice> : null}
        <div className={styles.actions}>
          <div className={ui.tabs} role="group" aria-label="Which tasks">
            {(["open", "done", "cancelled"] as const).map((entry) => (
              <button key={entry} type="button" aria-pressed={view === entry} className={`${ui.tab} ${view === entry ? ui.tabActive : ""}`} onClick={() => setView(entry)}>
                {entry === "open" ? "To do" : entry === "done" ? "Done" : "Cancelled"}
              </button>
            ))}
          </div>
          <div className={ui.tabs} role="group" aria-label="Whose tasks">
            {(["everyone", "mine"] as const).map((entry) => (
              <button key={entry} type="button" aria-pressed={filter === entry} className={`${ui.tab} ${filter === entry ? ui.tabActive : ""}`} onClick={() => setFilter(entry)}>
                {entry === "everyone" ? "Everyone's" : "Mine"}
              </button>
            ))}
          </div>
        </div>
        {tasks.error ? <Notice tone="error">{tasks.error}</Notice> : null}
        {!tasks.data && !tasks.error ? <p className={ui.muted}>Loading…</p> : null}
        {tasks.data && !shown.length ? <Empty>{view === "open" ? "Nothing to do." : view === "done" ? "No finished one-off tasks." : "No cancelled tasks."}</Empty> : null}
        {groups.map((group) => (
          <section key={group.state} aria-label={TASK_STATE_LABELS[group.state]}>
            <h3 style={{ margin: "12px 0 0" }}>{TASK_STATE_LABELS[group.state]}</h3>
            <ul className={styles.links}>
              {group.tasks.map((task) => (
                <TaskLine key={task.id} organisationId={organisationId} farm={farm} task={task} canRecord={canRecord} onChanged={changed} open={open === task.id} onOpen={() => setOpen(open === task.id ? null : task.id)}>
                  {open === task.id ? <TaskDetail organisationId={organisationId} farm={farm} task={task} canRecord={canRecord} onChanged={changed} onClose={() => setOpen(null)} /> : null}
                </TaskLine>
              ))}
            </ul>
          </section>
        ))}
      </Card>
      <QueuedWork organisationId={organisationId} farmId={farm.id} kinds={[TASK_DONE_KIND]} title="Tasks ticked on this device" onSynced={tasks.reload} />
    </div>
  );
}

type History = { history: Array<{ id: string; doneFor: string; doneByEmail: string; doneByName?: string; doneAt: string; undoneByEmail: string | null; undoneByName?: string; undoneAt: string | null }> };

function TaskDetail({ organisationId, farm, task, canRecord, onChanged, onClose }: { organisationId: string; farm: Farm; task: FarmTask; canRecord: boolean; onChanged: (message?: string) => void; onClose: () => void }) {
  // Cancelling (and opening again) is for bookkeepers and up (decision 1457).
  const canCancel = useWorkspace().can("bookkeeper");
  const history = useApiData<History>(`/api/farming/tasks/${task.id}/done`, { organisationId, n: task.lastDone?.id ?? "" });
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const today = todayInBrowser();
  const act = async (work: () => Promise<unknown>, text: string) => {
    setBusy(true);
    setError(null);
    try {
      await work();
      onChanged(text);
      history.reload();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };
  if (editing) return <TaskForm organisationId={organisationId} farm={farm} task={task} onClose={() => setEditing(false)} onSaved={() => onChanged("Task saved.")} />;
  return (
    <div style={{ padding: "8px 0 16px", display: "grid", gap: 8 }}>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <dl className={styles.facts}>
        <dt>Due</dt>
        <dd>
          {task.next ? formatDate(task.next) : "Done"} ({repeatText(task.repeat)}
          {task.repeat ? `, from ${formatDate(task.dueOn)}` : ""})
        </dd>
        <dt>For</dt>
        <dd>
          {task.assignedToName ?? "Anyone on the farm team"}
          {task.needsReassigning ? <span className={ui.muted}> (can&apos;t sign in now: their access has ended or hasn&apos;t started. Change the task to give it to someone else.)</span> : null}
        </dd>
        {task.paddockName ? (
          <>
            <dt>Paddock</dt>
            <dd>{task.paddockName}</dd>
          </>
        ) : null}
        {task.note ? (
          <>
            <dt>Note</dt>
            <dd style={{ whiteSpace: "pre-wrap" }}>{task.note}</dd>
          </>
        ) : null}
        <dt>Added</dt>
        <dd>
          by {(task as FarmTask & { createdByName?: string }).createdByName ?? task.createdByEmail} {formatDateTime(task.createdAt)}
          {task.updatedAt ? `; changed by ${(task as FarmTask & { updatedByName?: string }).updatedByName ?? task.updatedByEmail} ${formatDateTime(task.updatedAt)}` : ""}
        </dd>
      </dl>
      <h4 style={{ margin: 0 }}>Done</h4>
      {history.data && !history.data.history.length ? <p className={ui.muted}>Not done yet.</p> : null}
      {history.data?.history.length ? (
        <ul style={{ margin: 0, paddingLeft: 18 }}>
          {history.data.history.map((entry) => (
            <li key={entry.id} style={entry.undoneAt ? { color: "var(--text-muted)" } : undefined}>
              For {shortDate(entry.doneFor, today)}: by {entry.doneByName ?? entry.doneByEmail}, {formatDateTime(entry.doneAt)}
              {entry.undoneAt ? ` (undone by ${entry.undoneByName ?? entry.undoneByEmail}, ${formatDateTime(entry.undoneAt)})` : ""}
            </li>
          ))}
        </ul>
      ) : null}
      {canRecord ? (
        <div className={styles.actions}>
          {task.status === "open" ? (
            <Button variant="secondary" onClick={() => setEditing(true)}>
              Change
            </Button>
          ) : null}
          {task.lastDone && task.status === "open" ? (
            <Button variant="secondary" disabled={busy} onClick={() => void act(() => api(`/api/farming/tasks/${task.id}/done`, { method: "DELETE", query: { organisationId, doneId: task.lastDone!.id } }), `Undone: ${task.title} is due ${shortDate(task.lastDone!.doneFor, today)} again.`)}>
              Undo done for {shortDate(task.lastDone.doneFor, today)}
            </Button>
          ) : null}
          {canCancel ? (
            <Button variant="secondary" disabled={busy} onClick={() => void act(() => api(`/api/farming/tasks/${task.id}`, { method: "PATCH", body: { organisationId, status: task.status === "open" ? "cancelled" : "open" } }), task.status === "open" ? "Task cancelled. It's kept under Cancelled." : "Task opened again.")}>
              {task.status === "open" ? "Cancel task" : "Open again"}
            </Button>
          ) : null}
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function TaskForm({ organisationId, farm, task, onClose, onSaved }: { organisationId: string; farm: Farm; task: FarmTask | null; onClose: () => void; onSaved: () => void }) {
  const today = todayInBrowser();
  const team = useApiData<{ people: FarmTeamMember[] }>(`/api/farming/farms/${farm.id}/team`, { organisationId });
  const paddocks = useApiData<{ paddocks: Paddock[] }>(`/api/farming/farms/${farm.id}/paddocks`, { organisationId });
  const imageryKey = useApiData<{ settings: FarmingSettings }>("/api/farming/settings", { organisationId }).data?.settings.imageryKey ?? null;
  const [form, setForm] = useState({ title: task?.title ?? "", assignedToUserId: task?.assignedToUserId ?? "", dueOn: task?.next ?? task?.dueOn ?? today, repeat: (task?.repeat ?? "") as Repeat | "", paddockId: task?.paddockId ?? "", note: task?.note ?? "" });
  const [point, setPoint] = useState<Position | null>(task?.point ?? null);
  const [placing, setPlacing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const active = (paddocks.data?.paddocks ?? []).filter((paddock) => paddock.status === "active");
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const body = { organisationId, title: form.title, assignedToUserId: form.assignedToUserId || null, dueOn: form.dueOn, repeat: form.repeat || null, paddockId: form.paddockId || null, note: form.note.trim() || null, point };
      if (task) await api(`/api/farming/tasks/${task.id}`, { method: "PATCH", body });
      else await api(`/api/farming/farms/${farm.id}/tasks`, { method: "POST", body });
      onSaved();
      onClose();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title={task ? `Change: ${task.title}` : "Add a task"}>
      <form
        style={{ display: "grid", gap: 12 }}
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        {error ? <Notice tone="error">{error}</Notice> : null}
        <Field label="What needs doing">
          <input value={form.title} maxLength={200} required onChange={(event) => setForm({ ...form, title: event.target.value })} placeholder="Check the trough in paddock 12" />
        </Field>
        <div className={ui.inlineForm}>
          <Field label="For">
            <select value={form.assignedToUserId} onChange={(event) => setForm({ ...form, assignedToUserId: event.target.value })}>
              <option value="">Anyone on the farm team</option>
              {/* Kept as it is until someone picks another person (decision 1513). */}
              {task?.assignedToUserId && team.data && !team.data.people.some((person) => person.userId === task.assignedToUserId) ? (
                <option value={task.assignedToUserId}>{task.assignedToName ?? "A former member"} (can&apos;t sign in now)</option>
              ) : null}
              {(team.data?.people ?? []).map((person) => (
                <option key={person.userId} value={person.userId}>
                  {person.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label={task?.repeat ? "Next due" : "Due"}>
            <DateInput value={form.dueOn} onChange={(event) => setForm({ ...form, dueOn: event.target.value })} required />
          </Field>
          <Field label="Repeat">
            <select value={form.repeat} onChange={(event) => setForm({ ...form, repeat: event.target.value as Repeat | "" })}>
              <option value="">Once</option>
              {REPEATS.map((repeat) => (
                <option key={repeat} value={repeat}>
                  {REPEAT_LABELS[repeat][0].toUpperCase() + REPEAT_LABELS[repeat].slice(1)}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Paddock (optional)">
            <select value={form.paddockId} onChange={(event) => setForm({ ...form, paddockId: event.target.value })}>
              <option value="">None</option>
              {active.map((paddock) => (
                <option key={paddock.id} value={paddock.id}>
                  {paddock.name}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <Field label="Note (optional)">
          <textarea value={form.note} maxLength={1000} rows={2} onChange={(event) => setForm({ ...form, note: event.target.value })} />
        </Field>
        <div className={styles.actions}>
          <Button variant="secondary" aria-expanded={placing} onClick={() => setPlacing(!placing)}>
            {placing ? "Done placing" : point ? "Move the map pin" : "Add a map pin"}
          </Button>
          {point ? (
            <Button variant="secondary" onClick={() => setPoint(null)}>
              Remove the pin
            </Button>
          ) : null}
        </div>
        {placing ? (
          paddocks.data ? (
            <>
              <p className={ui.muted}>Tap the map where the job is.</p>
              <PaddockMap paddocks={active} selected={form.paddockId || null} imageryKey={imageryKey} drawing={point ? [point] : []} onMapTap={(position) => setPoint([Math.round(position[0] * 1e6) / 1e6, Math.round(position[1] * 1e6) / 1e6])} label="Map of the paddocks: tap to pin the task" />
            </>
          ) : (
            <p className={ui.muted}>Loading the map…</p>
          )
        ) : null}
        {task?.repeat ? <p className={ui.muted}>Changing Next due moves this and later dates. Times it was done are kept.</p> : null}
        <div className={styles.actions}>
          <Button type="submit" disabled={busy || !form.title.trim() || !form.dueOn}>
            {task ? "Save" : "Add task"}
          </Button>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </form>
    </Card>
  );
}
