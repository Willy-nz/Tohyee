import { afterAll, beforeAll, expect, it } from "vitest";
import * as remindersRoute from "@/app/api/app/reminders/route";
import * as accessRoute from "@/app/api/organisations/[organisationId]/members/[userId]/access/route";
import * as tasksRoute from "@/app/api/farming/farms/[farmId]/tasks/route";
import * as teamRoute from "@/app/api/farming/farms/[farmId]/team/route";
import * as doneRoute from "@/app/api/farming/tasks/[taskId]/done/route";
import * as dueRoute from "@/app/api/farming/tasks/due/route";
import * as taskRoute from "@/app/api/farming/tasks/[taskId]/route";
import type { SessionUser } from "@/lib/auth/sessions";
import { coreQuery } from "@/lib/db/transactions";
import type { OrgTx } from "@/lib/db/org-transaction";
import { setMemberFarmAccess } from "@/lib/farming/access";
import { addPaddock, saveFarm, setFarmingEnabled } from "@/lib/farming/paddocks";
import { addTask, listTasks, markTaskDone, tasksDue, undoTaskDone, updateTask } from "@/lib/farming/tasks";
import { apiRequest, createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, params, sessionCookieFor, startTestServer, type TestServer } from "../helpers/test-server";

type Handler = (request: Request, context: never) => Promise<Response>;
const ORG = "farm-tasks-co";

/** Farm team tasks (FT1-FT8; decisions 1457-1461, not yet reviewed). Made-up farms and people. */
describeWithDatabase("farm team tasks", () => {
  let server: TestServer;
  let owner: SessionUser;
  let worker: SessionUser;
  let other: SessionUser;
  let viewer: SessionUser;
  const w = {} as Record<string, string>;
  const as = (user: SessionUser) => <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(ORG, { userId: user.id, email: user.email, role: user === owner ? "owner" : user === viewer ? "viewer" : "farm_worker" }, work);

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("tasks-owner@example.com", { serverAdmin: true, displayName: "Aroha" });
    worker = await createTestUser("tasks-staff@example.com", { displayName: "Tama" });
    other = await createTestUser("tasks-runoff@example.com", { displayName: "Mere" });
    viewer = await createTestUser("tasks-viewer@example.com", { displayName: "Rangi" });
    await createTestOrganisation(owner, ORG);
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'farm_worker'), ($1, $3, 'farm_worker'), ($1, $4, 'viewer')", [ORG, worker.id, other.id, viewer.id]);
    const run = as(owner);
    await run((tx) => setFarmingEnabled(tx, { enabled: true }));
    w.home = (await run((tx) => saveFarm(tx, { name: "Home farm" })))[0].id;
    w.runoff = (await run((tx) => saveFarm(tx, { name: "Runoff" }))).find((farm) => farm.name === "Runoff")!.id;
    w.paddock = (await run((tx) => addPaddock(tx, { farmId: w.home, name: "12", effectiveHa: "4" }))).id;
    w.runoffPaddock = (await run((tx) => addPaddock(tx, { farmId: w.runoff, name: "R1", effectiveHa: "9" }))).id;
    await run((tx) => setMemberFarmAccess(tx, { userId: worker.id, role: "farm_worker", access: "farms", farmIds: [w.home] }));
    await run((tx) => setMemberFarmAccess(tx, { userId: other.id, role: "farm_worker", access: "farms", farmIds: [w.runoff] }));
  });

  afterAll(async () => {
    await server?.teardown();
  });

  const call = async (user: SessionUser, handler: Handler, url: string, context: Record<string, string>, method = "GET", body?: Record<string, unknown>) => {
    const response = await handler(
      apiRequest(method === "GET" || method === "DELETE" ? `${url}${url.includes("?") ? "&" : "?"}organisationId=${ORG}` : url, { method, cookie: await sessionCookieFor(user), body: body ? { organisationId: ORG, ...body } : undefined }),
      params(context) as never,
    );
    const text = await response.text();
    return { status: response.status, body: (text ? JSON.parse(text) : {}) as Record<string, unknown> };
  };

  it("FT1 a task is for someone on the farm's team, with a due day, repeat, paddock or pin", async () => {
    const team = await call(owner, teamRoute.GET as Handler, `/api/farming/farms/${w.home}/team`, { farmId: w.home });
    // Owners and the farm's staff; not the runoff's staff, and not viewers (they can't tick tasks off).
    expect((team.body.people as Array<{ name: string }>).map((person) => person.name).sort()).toEqual(["Aroha", "Tama"]);
    const run = as(owner);
    await expect(run((tx) => addTask(tx, { farmId: w.home, title: "Fix the gate", dueOn: "2026-11-06", assignedToUserId: other.id }))).rejects.toThrow("isn't on this farm's team");
    await expect(run((tx) => addTask(tx, { farmId: w.home, title: "Fix the gate", dueOn: "2026-11-06", paddockId: w.runoffPaddock }))).rejects.toThrow("isn't on this farm");
    await expect(run((tx) => addTask(tx, { farmId: w.home, title: "Fix the gate", dueOn: "2026-11-06", repeat: "daily" }))).rejects.toThrow("Repeat must be one of");
    const added = await call(worker, tasksRoute.POST as Handler, `/api/farming/farms/${w.home}/tasks`, { farmId: w.home }, "POST", { title: "Check the trough", dueOn: "2026-11-02", repeat: "weekly", assignedToUserId: worker.id, paddockId: w.paddock, point: [170.51, -45.86] });
    expect(added.status).toBe(201);
    expect(added.body.task).toMatchObject({ title: "Check the trough", assignedToName: "Tama", repeat: "weekly", paddockName: "12", point: [170.51, -45.86], next: "2026-11-02", createdByEmail: "tasks-staff@example.com" });
    w.trough = (added.body.task as { id: string }).id;
    w.gate = (await run((tx) => addTask(tx, { farmId: w.home, title: "Fix the gate", dueOn: "2026-11-06" }, { today: "2026-11-05" }))).id;
    // A viewer sees tasks but can't add them.
    expect((await call(viewer, tasksRoute.POST as Handler, `/api/farming/farms/${w.home}/tasks`, { farmId: w.home }, "POST", { title: "x", dueOn: "2026-11-06" })).status).toBe(403);
    // Runoff staff can't see Home farm's tasks.
    expect((await call(other, tasksRoute.GET as Handler, `/api/farming/farms/${w.home}/tasks`, { farmId: w.home })).status).toBe(404);
  });

  it("FT4-FT5 done keeps who and when, moves a repeat on, is kept once if sent again, and can be undone", async () => {
    const run = as(worker);
    const today = { today: "2026-11-05" };
    const before = (await run((tx) => listTasks(tx, { farmId: w.home }, today))).map((task) => [task.title, task.next, task.state]);
    expect(before).toEqual([
      ["Check the trough", "2026-11-02", "overdue"],
      ["Fix the gate", "2026-11-06", "soon"],
    ]);
    const done = await run((tx) => markTaskDone(tx, w.trough, { doneFor: "2026-11-02" }, today));
    expect([done.next, done.state, done.lastDone?.doneFor, done.lastDone?.doneByEmail]).toEqual(["2026-11-09", "soon", "2026-11-02", "tasks-staff@example.com"]);
    // The phone's queue sends it again: nothing more is kept.
    const again = await call(worker, doneRoute.POST as Handler, `/api/farming/tasks/${w.trough}/done`, { taskId: w.trough }, "POST", { doneFor: "2026-11-02" });
    expect(again.status).toBe(200);
    expect((again.body.task as { next: string }).next).toBe("2026-11-09");
    const history = await call(worker, doneRoute.GET as Handler, `/api/farming/tasks/${w.trough}/done`, { taskId: w.trough });
    expect((history.body.history as unknown[]).length).toBe(1);
    // A stale date (someone else already moved it on) is refused.
    await expect(run((tx) => markTaskDone(tx, w.trough, { doneFor: "2026-11-16" }, today))).rejects.toThrow("now due 2026-11-09");
    const undone = await run((tx) => undoTaskDone(tx, w.trough, { doneId: done.lastDone!.id }, today));
    expect([undone.next, undone.lastDone]).toEqual(["2026-11-02", null]);
    const kept = await run((tx) => tx.query<{ undone_by_email: string }>("select undone_by_email from farm_task_done where task_id = $1", [w.trough]));
    expect(kept.rows).toEqual([{ undone_by_email: "tasks-staff@example.com" }]);
    // A one-off is done once and leaves the to-do list.
    await run((tx) => markTaskDone(tx, w.gate, {}, today));
    expect((await run((tx) => listTasks(tx, { farmId: w.home, view: "done" }, today))).map((task) => task.title)).toEqual(["Fix the gate"]);
    await run((tx) => markTaskDone(tx, w.trough, {}, today));
  });

  it("FT2 only bookkeepers and up cancel; cancelling keeps a task, out of the to-do list", async () => {
    const run = as(owner);
    // Farm staff can't cancel a task, even one they added (Jess, 5 Nov 2026), but can still change it.
    const theirs = await call(worker, tasksRoute.POST as Handler, `/api/farming/farms/${w.home}/tasks`, { farmId: w.home }, "POST", { title: "Spray thistles", dueOn: "2026-11-20" });
    const spare = theirs.body.task as { id: string };
    const refused = await call(worker, taskRoute.PATCH as Handler, `/api/farming/tasks/${spare.id}`, { taskId: spare.id }, "PATCH", { status: "cancelled" });
    expect([refused.status, refused.body.error]).toEqual([403, "Cancelling a task needs the bookkeeper role or higher. Mark it done, or ask a bookkeeper or the owner."]);
    expect((await call(worker, taskRoute.PATCH as Handler, `/api/farming/tasks/${spare.id}`, { taskId: spare.id }, "PATCH", { note: "Ragwort too" })).status).toBe(200);
    await run((tx) => updateTask(tx, spare.id, { status: "cancelled" }));
    await expect(as(worker)((tx) => updateTask(tx, spare.id, { status: "open" }))).rejects.toThrow("Opening a cancelled task again needs the bookkeeper role");
    expect((await run((tx) => listTasks(tx, { farmId: w.home }))).map((task) => task.title)).not.toContain("Spray thistles");
    expect((await run((tx) => listTasks(tx, { farmId: w.home, view: "cancelled" }))).map((task) => task.title)).toEqual(["Spray thistles"]);
    await expect(run((tx) => markTaskDone(tx, spare.id, {}))).rejects.toThrow("cancelled");
  });

  it("FT6 the calendar has each date, overdue ones on today too, on farms the person can see", async () => {
    const run = as(owner);
    const overdue = await run((tx) => addTask(tx, { farmId: w.runoff, title: "Move the bull", dueOn: "2026-11-01", assignedToUserId: other.id }));
    const items = await run((tx) => tasksDue(tx, { from: "2026-11-05", to: "2026-11-30", today: "2026-11-05" }));
    expect(items.map((item) => [item.date, item.title, item.overdue])).toEqual([
      ["2026-11-05", "Move the bull", true],
      ["2026-11-09", "Check the trough", false],
      ["2026-11-16", "Check the trough", false],
      ["2026-11-23", "Check the trough", false],
      ["2026-11-30", "Check the trough", false],
    ]);
    // Home farm's staff see only Home farm's.
    const theirs = await call(worker, dueRoute.GET as Handler, "/api/farming/tasks/due?from=2026-11-05&to=2026-11-30", {});
    expect((theirs.body.items as Array<{ title: string }>).every((item) => item.title === "Check the trough")).toBe(true);
    w.bull = overdue.id;
  });

  it("FT7 the assigned person's own tasks are reminders in the Android app, like safety actions", async () => {
    const mine = await call(other, remindersRoute.GET as Handler, "/api/app/reminders", {});
    expect(mine.status).toBe(200);
    const reminders = (mine.body.reminders as Array<{ kind: string; key: string; title: string; date: string; path: string }>).filter((reminder) => reminder.kind === "task");
    expect(reminders).toHaveLength(1);
    expect(reminders[0]).toMatchObject({ key: `task-${w.bull}`, title: "Task: Move the bull", path: `/operations/farming/tasks?farm=${w.runoff}` });
    // Overdue: told about today.
    expect(reminders[0].date >= "2026-11-05").toBe(true);
    const workers = await call(worker, remindersRoute.GET as Handler, "/api/app/reminders", {});
    expect((workers.body.reminders as Array<{ kind: string; title: string }>).filter((reminder) => reminder.kind === "task").map((reminder) => reminder.title)).toEqual(["Task: Check the trough"]);
  });
  it("#609 only people whose access is current can be given a task; open tasks for others are flagged, not changed", async () => {
    const run = as(owner);
    const temp = await createTestUser("tasks-temp@example.com", { displayName: "Hemi" });
    const starter = await createTestUser("tasks-starter@example.com", { displayName: "Ana" });
    const inHours = (hours: number) => new Date(Date.now() + hours * 3_600_000).toISOString();
    const setWindow = (userId: string, starts: string | null, ends: string | null) => coreQuery("update organisation_members set access_starts_at = $3, access_ends_at = $4 where organisation_id = $1 and user_id = $2", [ORG, userId, starts, ends]);
    await coreQuery("insert into organisation_members (organisation_id, user_id, role, access_ends_at) values ($1, $2, 'farm_worker', $4), ($1, $3, 'farm_worker', null)", [ORG, temp.id, starter.id, inHours(48)]);
    await run((tx) => setMemberFarmAccess(tx, { userId: temp.id, role: "farm_worker", access: "farms", farmIds: [w.home] }));
    await run((tx) => setMemberFarmAccess(tx, { userId: starter.id, role: "farm_worker", access: "farms", farmIds: [w.home] }));
    await setWindow(starter.id, inHours(24), null);
    const team = async () => ((await call(owner, teamRoute.GET as Handler, `/api/farming/farms/${w.home}/team`, { farmId: w.home })).body.people as Array<{ name: string }>).map((person) => person.name).sort();
    const add = (assignedToUserId: string, title: string) => call(owner, tasksRoute.POST as Handler, `/api/farming/farms/${w.home}/tasks`, { farmId: w.home }, "POST", { title, dueOn: "2026-11-20", assignedToUserId });

    // Current, with an end date: on the team, and can be given a task.
    expect(await team()).toEqual(["Aroha", "Hemi", "Tama"]);
    const calves = await add(temp.id, "Feed the calves");
    expect(calves.status).toBe(201);
    const calvesId = (calves.body.task as { id: string }).id;
    expect((calves.body.task as { needsReassigning: boolean }).needsReassigning).toBe(false);
    const fence = (await add(temp.id, "Check the boundary fence")).body.task as { id: string };
    await run((tx) => markTaskDone(tx, fence.id, {}));

    // Expired (login still on): off the team, refused through the API with why.
    await setWindow(temp.id, null, inHours(-1));
    expect(await team()).toEqual(["Aroha", "Tama"]);
    const ended = await add(temp.id, "Shift the break fence");
    expect([ended.status, ended.body.error]).toEqual([400, "Hemi's access to this organisation has ended, so they can't be given a task. Choose someone else, or extend their access in People and roles first."]);
    const moved = await call(owner, taskRoute.PATCH as Handler, `/api/farming/tasks/${w.trough}`, { taskId: w.trough }, "PATCH", { assignedToUserId: temp.id });
    expect(moved.status).toBe(400);
    expect((await run((tx) => listTasks(tx, { farmId: w.home }))).find((task) => task.id === w.trough)?.assignedToUserId).toBe(worker.id);

    // Not started yet: refused too (tasks aren't given ahead of someone's start).
    const early = await add(starter.id, "Shift the break fence");
    expect(early.status).toBe(400);
    expect(early.body.error).toMatch(/^Ana's access starts on \d{1,2} [A-Z][a-z]{2} \d{4}(, \d{1,2}:\d{2}(am|pm))?\. A task can only be for someone who can sign in now/);

    // The open task stays Hemi's and is flagged on Tasks, Today and the calendar; a done one isn't.
    const open = (await call(worker, tasksRoute.GET as Handler, `/api/farming/farms/${w.home}/tasks`, { farmId: w.home })).body.tasks as Array<{ id: string; assignedToName: string; needsReassigning: boolean }>;
    expect(open.find((task) => task.id === calvesId)).toMatchObject({ assignedToName: "Hemi", needsReassigning: true });
    expect(open.filter((task) => task.needsReassigning).map((task) => task.id)).toEqual([calvesId]);
    const done = (await run((tx) => listTasks(tx, { farmId: w.home, view: "done" }))).find((task) => task.id === fence.id);
    expect([done?.assignedToUserId, done?.needsReassigning]).toEqual([temp.id, false]);
    const due = await run((tx) => tasksDue(tx, { from: "2026-11-20", to: "2026-11-20", farmId: w.home }));
    expect(due.find((item) => item.taskId === calvesId)?.needsReassigning).toBe(true);
    // Changing something else keeps who it's for; nothing is deleted.
    const noted = await call(owner, taskRoute.PATCH as Handler, `/api/farming/tasks/${calvesId}`, { taskId: calvesId }, "PATCH", { note: "Two pens" });
    expect([noted.status, (noted.body.task as { assignedToUserId: string }).assignedToUserId]).toEqual([200, temp.id]);

    // Extended: back on the team, and the flag goes.
    const extended = await accessRoute.POST(apiRequest(`/api/organisations/${ORG}/members/${temp.id}/access`, { method: "POST", cookie: await sessionCookieFor(owner), body: { action: "extend_week" } }), params({ organisationId: ORG, userId: temp.id }));
    expect(extended.status).toBe(200);
    expect(await team()).toEqual(["Aroha", "Hemi", "Tama"]);
    expect((await run((tx) => listTasks(tx, { farmId: w.home }))).find((task) => task.id === calvesId)?.needsReassigning).toBe(false);

    // Ended again, then given to someone current: the flag goes, and the history keeps who it was for.
    await setWindow(temp.id, null, inHours(-1));
    const reassigned = await call(owner, taskRoute.PATCH as Handler, `/api/farming/tasks/${calvesId}`, { taskId: calvesId }, "PATCH", { assignedToUserId: worker.id });
    expect([reassigned.status, (reassigned.body.task as { needsReassigning: boolean }).needsReassigning]).toEqual([200, false]);
    const audit = await run((tx) => tx.query<{ details: { before: { assignedTo: string }; after: { assignedTo: string } } }>("select details from audit_events where entity_type = 'farm_task' and entity_id = $1 and event_type = 'farming.task_changed' order by audit_events.id desc limit 1", [calvesId]));
    expect([audit.rows[0].details.before.assignedTo, audit.rows[0].details.after.assignedTo]).toEqual([temp.id, worker.id]);

    // Started: Ana can be given one.
    await setWindow(starter.id, inHours(-1), null);
    expect((await add(starter.id, "Shift the break fence")).status).toBe(201);
  });
});
