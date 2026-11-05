import { afterAll, beforeAll, expect, it } from "vitest";
import * as remindersRoute from "@/app/api/app/reminders/route";
import * as tasksRoute from "@/app/api/farming/farms/[farmId]/tasks/route";
import * as teamRoute from "@/app/api/farming/farms/[farmId]/team/route";
import * as doneRoute from "@/app/api/farming/tasks/[taskId]/done/route";
import * as dueRoute from "@/app/api/farming/tasks/due/route";
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

  it("FT2 cancelling keeps a task, out of the to-do list", async () => {
    const run = as(owner);
    const spare = await run((tx) => addTask(tx, { farmId: w.home, title: "Spray thistles", dueOn: "2026-11-20" }));
    await run((tx) => updateTask(tx, spare.id, { status: "cancelled" }));
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
});
