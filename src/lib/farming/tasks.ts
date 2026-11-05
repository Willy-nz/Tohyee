import { writeAuditEvent } from "@/lib/audit";
import { roleAtLeast } from "@/lib/auth/roles";
import { parseIsoDate, todayIsoDate } from "@/lib/dates";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { canSeeFarm, requireFarmAccess, visibleFarmIds } from "@/lib/farming/access";
import { REPEATS, type Repeat } from "@/lib/farming/calendar-shared";
import type { Position } from "@/lib/farming/geometry";
import { requireFarming } from "@/lib/farming/paddocks";
import { nextDue, taskDates, taskState, type TaskState } from "@/lib/farming/tasks-rules";
import { listMembers } from "@/lib/organisations/members";
import { optionalString, requireId, requireOneOf, requireString } from "@/lib/validation";

/*
 * Farm team tasks (decisions 1457-1461; examples FT1-FT8, not yet
 * reviewed): a job for someone on the farm team, with a due day, an
 * optional repeat, and optionally a paddock or a place on the map. Done
 * and undone keep who and when. Reminders are the Android app's (the
 * assigned person's own, like safety actions), and the tasks show on
 * Today and the farm calendar. Farm staff and up add, change and tick
 * tasks on their farms; viewers see them.
 */

export type FarmTeamMember = { userId: string; name: string; role: string };

export type TaskDone = { id: string; doneFor: string; doneByEmail: string; doneAt: string; doneByName?: string };

export type FarmTask = {
  id: string;
  farmId: string;
  farmName: string;
  title: string;
  note: string | null;
  assignedToUserId: string | null;
  assignedToName: string | null;
  dueOn: string;
  repeat: Repeat | null;
  paddockId: string | null;
  paddockName: string | null;
  point: Position | null;
  status: "open" | "cancelled";
  /** The day it's next due; null for a one-off that's done. */
  next: string | null;
  state: TaskState;
  /** The latest time it was done (for "Undo"). */
  lastDone: TaskDone | null;
  createdByEmail: string;
  createdAt: string;
  updatedByEmail: string | null;
  updatedAt: string | null;
};

/**
 * The people a task on this farm can be for: active members who can record
 * farm work (farm staff, bookkeepers and up) and can see the farm. Read
 * from the core database (names and roles) and the farm's access lists.
 */
export async function farmTeam(tx: OrgTx, farmId: string): Promise<FarmTeamMember[]> {
  const members = (await listMembers(tx.organisationId)).filter((member) => member.isActive && (member.role === "farm_worker" || roleAtLeast(member.role, "bookkeeper")));
  const farms = await tx.query<{ n: number }>("select count(*)::int as n from farms");
  const scoped = farms.rows[0].n >= 2;
  const all = new Set((await tx.query<{ user_id: string }>("select user_id::text from farm_member_scopes where all_farms")).rows.map((row) => row.user_id));
  const here = new Set((await tx.query<{ user_id: string }>("select user_id::text from farm_member_farms where farm_id = $1", [farmId])).rows.map((row) => row.user_id));
  return members
    .filter((member) => !scoped || member.role === "owner" || member.role === "admin" || all.has(member.userId) || here.has(member.userId))
    .map((member) => ({ userId: member.userId, name: member.displayName || member.email, role: member.role }));
}

type TaskRow = {
  id: string;
  farm_id: string;
  farm_name: string;
  title: string;
  note: string | null;
  assigned_to_user_id: string | null;
  due_on: string;
  repeat: Repeat | null;
  paddock_id: string | null;
  paddock_name: string | null;
  latitude: string | null;
  longitude: string | null;
  status: "open" | "cancelled";
  created_by_email: string;
  created_at: string;
  updated_by_email: string | null;
  updated_at: string | null;
  done_id: string | null;
  done_for: string | null;
  done_by_email: string | null;
  done_at: string | null;
};

async function loadTasks(tx: OrgTx, where: string, params: unknown[], today: string): Promise<FarmTask[]> {
  const rows = await tx.query<TaskRow>(
    `select t.id::text, t.farm_id::text, f.name as farm_name, t.title, t.note, t.assigned_to_user_id::text, t.due_on::text, t.repeat,
            t.paddock_id::text, p.name as paddock_name, t.latitude::text, t.longitude::text, t.status,
            t.created_by_email, to_char(t.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as created_at, t.updated_by_email, to_char(t.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as updated_at,
            d.id::text as done_id, d.done_for::text, d.done_by_email, to_char(d.done_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as done_at
       from farm_tasks t
       join farms f on f.id = t.farm_id
       left join paddocks p on p.id = t.paddock_id
       left join lateral (select x.id, x.done_for, x.done_by_email, x.done_at from farm_task_done x where x.task_id = t.id and x.undone_at is null order by x.done_for desc, x.id desc limit 1) d on true
      where ${where}
      order by t.due_on, t.id`,
    params,
  );
  const team = new Map<string, string>();
  for (const member of await listMembers(tx.organisationId)) team.set(member.userId, member.displayName || member.email);
  return rows.rows.map((row) => {
    const next = row.status === "cancelled" ? null : nextDue({ dueOn: row.due_on, repeat: row.repeat }, row.done_for);
    return {
      id: row.id,
      farmId: row.farm_id,
      farmName: row.farm_name,
      title: row.title,
      note: row.note,
      assignedToUserId: row.assigned_to_user_id,
      assignedToName: row.assigned_to_user_id ? (team.get(row.assigned_to_user_id) ?? "A former member") : null,
      dueOn: row.due_on,
      repeat: row.repeat,
      paddockId: row.paddock_id,
      paddockName: row.paddock_name,
      point: row.latitude === null || row.longitude === null ? null : [Number(row.longitude), Number(row.latitude)],
      status: row.status,
      next,
      state: taskState(next, today),
      lastDone: row.done_id && row.done_for && row.done_by_email && row.done_at ? { id: row.done_id, doneFor: row.done_for, doneByEmail: row.done_by_email, doneAt: row.done_at } : null,
      createdByEmail: row.created_by_email,
      createdAt: row.created_at,
      updatedByEmail: row.updated_by_email,
      updatedAt: row.updated_at,
    };
  });
}

async function requireFarm(tx: OrgTx, input: unknown): Promise<string> {
  await requireFarming(tx);
  const farmId = requireId(input, "farmId");
  const farm = await tx.query("select 1 from farms where id = $1", [farmId]);
  if (!farm.rowCount) throw new NotFoundError("Farm not found.");
  await requireFarmAccess(tx, farmId);
  return farmId;
}

async function requireTask(tx: OrgTx, input: unknown, today: string): Promise<FarmTask> {
  await requireFarming(tx);
  const task = (await loadTasks(tx, "t.id = $1", [requireId(input, "taskId")], today))[0];
  if (!task || !(await canSeeFarm(tx, task.farmId))) throw new NotFoundError("Task not found.");
  return task;
}

type TaskFields = { title: string; note: string | null; assignedTo: string | null; dueOn: string; repeat: Repeat | null; paddockId: string | null; point: { latitude: string; longitude: string } | null };

function parsePoint(input: unknown): { latitude: string; longitude: string } | null {
  if (input === null || input === undefined || input === "") return null;
  const [lon, lat] = Array.isArray(input) ? input : [];
  if (typeof lon !== "number" || typeof lat !== "number" || !Number.isFinite(lon) || !Number.isFinite(lat) || lon < -180 || lon > 180 || lat < -90 || lat > 90) throw new ValidationError("The place on the map must be a longitude and latitude.");
  return { longitude: lon.toFixed(6), latitude: lat.toFixed(6) };
}

async function parseFields(tx: OrgTx, farmId: string, input: Record<string, unknown>, current: FarmTask | null): Promise<TaskFields> {
  const has = (key: string) => input[key] !== undefined;
  const title = has("title") ? requireString(input.title, "What needs doing", { maxLength: 200 }).trim() : current!.title;
  const note = has("note") ? optionalString(input.note, "Note", { maxLength: 1000 }) : (current?.note ?? null);
  const dueOn = has("dueOn") ? parseIsoDate(input.dueOn, "Due") : current?.dueOn;
  if (!dueOn) throw new ValidationError("Due is required (YYYY-MM-DD).");
  const repeat = has("repeat") ? (input.repeat === null || input.repeat === "" || input.repeat === "none" ? null : requireOneOf(input.repeat, "Repeat", REPEATS)) : (current?.repeat ?? null);
  let assignedTo = current?.assignedToUserId ?? null;
  if (has("assignedToUserId")) {
    assignedTo = input.assignedToUserId === null || input.assignedToUserId === "" ? null : String(input.assignedToUserId);
    if (assignedTo && assignedTo !== current?.assignedToUserId) {
      const team = await farmTeam(tx, farmId);
      if (!team.some((member) => member.userId === assignedTo)) throw new ValidationError("That person isn't on this farm's team. Choose someone who works on the farm.");
    }
  }
  let paddockId = current?.paddockId ?? null;
  if (has("paddockId")) {
    paddockId = input.paddockId === null || input.paddockId === "" ? null : requireId(input.paddockId, "paddockId");
    if (paddockId) {
      const paddock = await tx.query<{ farm_id: string }>("select farm_id::text from paddocks where id = $1", [paddockId]);
      if (!paddock.rows[0] || paddock.rows[0].farm_id !== farmId) throw new ValidationError("That paddock isn't on this farm.");
    }
  }
  const point = has("point") ? parsePoint(input.point) : current?.point ? { longitude: current.point[0].toFixed(6), latitude: current.point[1].toFixed(6) } : null;
  return { title, note, assignedTo, dueOn, repeat, paddockId, point };
}

// Tasks (FT1-FT3) ---------------------------------------------------------------------------------------

/** Adds a task (`title`, `dueOn`, and optionally `assignedToUserId`, `repeat`, `paddockId`, `point`, `note`). */
export async function addTask(tx: OrgTx, input: Record<string, unknown> & { farmId: unknown }, options: { today?: string } = {}): Promise<FarmTask> {
  const farmId = await requireFarm(tx, input.farmId);
  const fields = await parseFields(tx, farmId, input, null);
  const row = await tx.query<{ id: string }>(
    `insert into farm_tasks (farm_id, title, note, assigned_to_user_id, due_on, repeat, paddock_id, latitude, longitude, created_by_email)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning id::text`,
    [farmId, fields.title, fields.note, fields.assignedTo, fields.dueOn, fields.repeat, fields.paddockId, fields.point?.latitude ?? null, fields.point?.longitude ?? null, tx.actor.email],
  );
  await writeAuditEvent(tx, { eventType: "farming.task_added", entityType: "farm_task", entityId: row.rows[0].id, details: { farmId, title: fields.title, dueOn: fields.dueOn, repeat: fields.repeat, assignedTo: fields.assignedTo } });
  return (await loadTasks(tx, "t.id = $1", [row.rows[0].id], options.today ?? todayIsoDate()))[0];
}

/** Changes a task, or cancels it (`status: "cancelled"`; it's kept, and can be opened again). */
export async function updateTask(tx: OrgTx, idInput: unknown, input: Record<string, unknown>, options: { today?: string } = {}): Promise<FarmTask> {
  const today = options.today ?? todayIsoDate();
  const task = await requireTask(tx, idInput, today);
  const status = input.status === undefined ? task.status : requireOneOf(input.status, "Status", ["open", "cancelled"] as const);
  const fields = await parseFields(tx, task.farmId, input, task);
  await tx.query(
    `update farm_tasks set title = $2, note = $3, assigned_to_user_id = $4, due_on = $5, repeat = $6, paddock_id = $7, latitude = $8, longitude = $9, status = $10, updated_by_email = $11, updated_at = now() where id = $1`,
    [task.id, fields.title, fields.note, fields.assignedTo, fields.dueOn, fields.repeat, fields.paddockId, fields.point?.latitude ?? null, fields.point?.longitude ?? null, status, tx.actor.email],
  );
  await writeAuditEvent(tx, {
    eventType: status !== task.status ? (status === "cancelled" ? "farming.task_cancelled" : "farming.task_reopened") : "farming.task_changed",
    entityType: "farm_task",
    entityId: task.id,
    details: { before: { title: task.title, dueOn: task.dueOn, repeat: task.repeat, assignedTo: task.assignedToUserId, status: task.status }, after: { title: fields.title, dueOn: fields.dueOn, repeat: fields.repeat, assignedTo: fields.assignedTo, status } },
  });
  return (await loadTasks(tx, "t.id = $1", [task.id], today))[0];
}

/**
 * Marks the task done for the day it's due now (FT4), with who and when.
 * `doneFor` is the date the person saw; if someone else already did it,
 * the task is answered as it is and nothing is added twice (a phone's
 * queue may send it again).
 */
export async function markTaskDone(tx: OrgTx, idInput: unknown, input: { doneFor?: unknown }, options: { today?: string } = {}): Promise<FarmTask> {
  const today = options.today ?? todayIsoDate();
  await tx.query("select 1 from farm_tasks where id = $1 for update", [requireId(idInput, "taskId")]);
  const task = await requireTask(tx, idInput, today);
  if (task.status === "cancelled") throw new ConflictError("This task was cancelled. Open it again to mark it done.");
  const doneFor = input.doneFor === undefined || input.doneFor === null || input.doneFor === "" ? task.next : parseIsoDate(input.doneFor, "Done for");
  if (doneFor === null) return task;
  const already = await tx.query("select 1 from farm_task_done where task_id = $1 and done_for = $2 and undone_at is null", [task.id, doneFor]);
  if (already.rowCount) return task;
  if (doneFor !== task.next) throw new ConflictError(task.next ? `This task is now due ${task.next}, not ${doneFor}. Check it and mark it done again.` : "This task is already done.");
  const row = await tx.query<{ id: string }>("insert into farm_task_done (task_id, done_for, done_by_email) values ($1, $2, $3) returning id::text", [task.id, doneFor, tx.actor.email]);
  await writeAuditEvent(tx, { eventType: "farming.task_done", entityType: "farm_task", entityId: task.id, details: { doneFor, doneId: row.rows[0].id } });
  return (await loadTasks(tx, "t.id = $1", [task.id], today))[0];
}

/** Undoes the latest "done" (FT5): kept, with who undid it and when; the task is due again for that day. */
export async function undoTaskDone(tx: OrgTx, idInput: unknown, input: { doneId: unknown }, options: { today?: string } = {}): Promise<FarmTask> {
  const today = options.today ?? todayIsoDate();
  const task = await requireTask(tx, idInput, today);
  const doneId = requireId(input.doneId, "doneId");
  if (!task.lastDone || task.lastDone.id !== doneId) throw new ConflictError("Only the latest time it was done can be undone. Nothing was changed.");
  await tx.query("update farm_task_done set undone_by_email = $2, undone_at = now() where id = $1 and undone_at is null", [doneId, tx.actor.email]);
  await writeAuditEvent(tx, { eventType: "farming.task_undone", entityType: "farm_task", entityId: task.id, details: { doneFor: task.lastDone.doneFor, doneId } });
  return (await loadTasks(tx, "t.id = $1", [task.id], today))[0];
}

/** A farm's tasks: open ones (not cancelled, not a done one-off) by when they're next due, or `view: "done"` / `"cancelled"`. */
export async function listTasks(tx: OrgTx, input: { farmId: unknown; view?: unknown; mine?: boolean }, options: { today?: string } = {}): Promise<FarmTask[]> {
  const farmId = await requireFarm(tx, input.farmId);
  const view = input.view === undefined || input.view === null || input.view === "" ? "open" : requireOneOf(input.view, "View", ["open", "done", "cancelled"] as const);
  const tasks = await loadTasks(tx, view === "cancelled" ? "t.farm_id = $1 and t.status = 'cancelled'" : "t.farm_id = $1 and t.status = 'open'", [farmId], options.today ?? todayIsoDate());
  const shown = tasks.filter((task) => (view === "done" ? task.next === null : view === "open" ? task.next !== null : true)).filter((task) => !input.mine || task.assignedToUserId === tx.actor.userId);
  return shown.sort((a, b) => (a.next ?? "9999").localeCompare(b.next ?? "9999") || Number(a.id) - Number(b.id));
}

/** Everything done for a task, newest first, undone ones included and marked (FT5). */
export async function taskHistory(tx: OrgTx, idInput: unknown): Promise<Array<TaskDone & { undoneByEmail: string | null; undoneAt: string | null }>> {
  const task = await requireTask(tx, idInput, todayIsoDate());
  const rows = await tx.query<{ id: string; done_for: string; done_by_email: string; done_at: string; undone_by_email: string | null; undone_at: string | null }>(
    `select id::text, done_for::text, done_by_email, to_char(done_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as done_at, undone_by_email, to_char(undone_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as undone_at from farm_task_done where task_id = $1 order by farm_task_done.done_at desc, farm_task_done.id desc limit 100`,
    [task.id],
  );
  return rows.rows.map((row) => ({ id: row.id, doneFor: row.done_for, doneByEmail: row.done_by_email, doneAt: row.done_at, undoneByEmail: row.undone_by_email, undoneAt: row.undone_at }));
}

export type TaskDueItem = { key: string; taskId: string; farmId: string; farmName: string; date: string; title: string; assignedToName: string | null; overdue: boolean };

/**
 * Tasks on the farm calendar (FT6): each open task's dates from `from` to
 * `to` (a repeat's dates from the one it's next due), on the farms the
 * person can see. An overdue task shows on today as well, so it isn't lost.
 */
export async function tasksDue(tx: OrgTx, input: { from: string; to: string; farmId?: string | null; today?: string }): Promise<TaskDueItem[]> {
  await requireFarming(tx);
  const today = input.today ?? todayIsoDate();
  const params: unknown[] = [];
  let where = "t.status = 'open'";
  if (input.farmId) {
    params.push(await requireFarm(tx, input.farmId));
    where += ` and t.farm_id = $${params.length}`;
  } else {
    const visible = await visibleFarmIds(tx);
    if (visible) {
      params.push(visible);
      where += ` and t.farm_id = any($${params.length}::bigint[])`;
    }
  }
  const items: TaskDueItem[] = [];
  for (const task of await loadTasks(tx, where, params, today)) {
    const base = { taskId: task.id, farmId: task.farmId, farmName: task.farmName, title: task.title, assignedToName: task.assignedToName };
    if (task.next && task.next < today && today >= input.from && today <= input.to) items.push({ ...base, key: `${task.id}-overdue`, date: today, overdue: true });
    for (const date of taskDates(task, task.next, input.from, input.to)) if (!(task.next && task.next < today && date === task.next)) items.push({ ...base, key: `${task.id}-${date}`, date, overdue: false });
  }
  return items.sort((a, b) => a.date.localeCompare(b.date) || a.title.localeCompare(b.title));
}

/** The person's own open tasks due by `until` (default 14 days ahead), on farms they work on: for Today and the Android app's reminders. */
export async function myTasks(tx: OrgTx, options: { today?: string } = {}): Promise<FarmTask[]> {
  await requireFarming(tx);
  if (!tx.actor.userId) return [];
  const today = options.today ?? todayIsoDate();
  const tasks = await loadTasks(tx, "t.status = 'open' and t.assigned_to_user_id = $1", [tx.actor.userId], today);
  const shown: FarmTask[] = [];
  for (const task of tasks) if (task.next && (await canSeeFarm(tx, task.farmId))) shown.push(task);
  return shown.sort((a, b) => a.next!.localeCompare(b.next!));
}
