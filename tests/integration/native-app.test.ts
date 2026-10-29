import { afterAll, beforeAll, expect, it } from "vitest";
import packageJson from "../../package.json";
import * as identifyRoute from "@/app/api/app/identify/route";
import * as remindersRoute from "@/app/api/app/reminders/route";
import type { SessionUser } from "@/lib/auth/sessions";
import type { OrgTx } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import { todayIsoDate } from "@/lib/dates";
import { addApplication } from "@/lib/effluent/log";
import { addSetup, addSystem } from "@/lib/effluent/setup";
import { setMemberFarmAccess } from "@/lib/farming/access";
import { addPaddock, saveFarm, setFarmingEnabled, setImageryKey } from "@/lib/farming/paddocks";
import { readIdentity } from "@/lib/native/server-address";
import type { DeviceRemindersResponse } from "@/lib/native/reminders-shared";
import { addAction } from "@/lib/safety/reports";
import { apiRequest, createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, sessionCookieFor, startTestServer, type TestServer } from "../helpers/test-server";

const ORG = "native-app";
const ago = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();
const inDays = (days: number) => new Date(Date.parse(`${todayIsoDate()}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

/*
 * The Android app's server side (#502, decisions 1141 and 1146-1148):
 * /api/app/identify answers "this is Tohyee" to anyone (the version only on
 * the server's own network), and /api/app/reminders gives the signed-in
 * person their own reminders, only from farms they work on. Made-up data.
 */
describeWithDatabase("Android app: identify and reminders", () => {
  let server: TestServer;
  let owner: SessionUser;
  let worker: SessionUser;
  const as = (user: SessionUser) => <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(ORG, { userId: user.id, email: user.email }, work);
  const w = {} as Record<string, string>;
  let members: Map<string, string>;

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("app-owner@example.com", { serverAdmin: true, displayName: "Jess" });
    worker = await createTestUser("app-worker@example.com", { displayName: "Hemi" });
    await createTestOrganisation(owner, ORG);
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'farm_worker')", [ORG, worker.id]);
    members = new Map([
      [owner.id, "Jess"],
      [worker.id, "Hemi"],
    ]);
    await as(owner)((tx) => setFarmingEnabled(tx, { enabled: true }));
    w.home = (await as(owner)((tx) => saveFarm(tx, { name: "Home farm" })))[0].id;
    w.runoff = (await as(owner)((tx) => saveFarm(tx, { name: "Runoff" }))).find((farm) => farm.name === "Runoff")!.id;
    w.p1 = (await as(owner)((tx) => addPaddock(tx, { farmId: w.home, name: "1", effectiveHa: "4" }))).id;
    await as(owner)((tx) => setMemberFarmAccess(tx, { userId: worker.id, role: "farm_worker", access: "farms", farmIds: [w.home] }));
    w.pond = (await as(owner)((tx) => addSetup(tx, "ponds", { farmId: w.home, name: "Dairy pond", capacityM3: "1000" }))).recordId;
    w.irrigator = (await as(owner)((tx) => addSystem(tx, { farmId: w.home, name: "Irrigator", type: "travelling_irrigator", shiftEveryHours: "2" }, members))).recordId;
    w.pods = (await as(owner)((tx) => addSystem(tx, { farmId: w.home, name: "Pods", type: "pods", checkEvery: "week" }, members))).recordId;
    // On the runoff, which the worker doesn't work on.
    w.runoffPond = (await as(owner)((tx) => addSetup(tx, "ponds", { farmId: w.runoff, name: "Runoff pond", capacityM3: "200" }))).recordId;
    await as(worker)((tx) => addApplication(tx, { farmId: w.home, systemId: w.irrigator, startedAt: ago(1), positions: [{ paddockId: w.p1, movedAt: ago(1) }] }));
    await as(owner)((tx) => addAction(tx, { farmId: w.home, title: "Fix the race gate (made up)", assignedToUserId: worker.id, due: inDays(3) }, members));
    await as(owner)((tx) => addAction(tx, { farmId: w.home, title: "Owner's own job (made up)", assignedToUserId: owner.id, due: inDays(5) }, members));
    await as(owner)((tx) => setImageryKey(tx, { imageryKey: "made-up-linz-key-0001" }));
  });

  afterAll(async () => {
    await server?.teardown();
  });

  it("identify: says it's Tohyee, with the version only on the server's own network", async () => {
    const local = await identifyRoute.GET(new Request("http://127.0.0.1:3000/api/app/identify"));
    expect(local.status).toBe(200);
    expect(local.headers.get("access-control-allow-origin")).toBe("*");
    const body = await local.json();
    expect(body).toEqual({ app: "tohyee", api: 1, name: "Tohyee", version: packageJson.version });
    expect(readIdentity(200, body)).toEqual({ ok: true, identity: { app: "tohyee", api: 1, name: "Tohyee", version: packageJson.version } });

    const remote = await identifyRoute.GET(new Request("https://books.example.nz/api/app/identify", { headers: { host: "books.example.nz", "cf-ray": "abc-AKL" } }));
    expect(await remote.json()).toEqual({ app: "tohyee", api: 1, name: "Tohyee", version: null });

    const preflight = await identifyRoute.OPTIONS();
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-methods")).toContain("GET");
  });

  it("reminders need a signed-in member", async () => {
    const response = await remindersRoute.GET(apiRequest(`/api/app/reminders?organisationId=${ORG}`), undefined as never);
    expect(response.status).toBe(401);
  });

  it("a farm worker gets the shift, the pond, the weekly check and their own action, only on their farm", async () => {
    const response = await remindersRoute.GET(apiRequest(`/api/app/reminders?organisationId=${ORG}`, { cookie: await sessionCookieFor(worker) }), undefined as never);
    expect(response.status).toBe(200);
    const body = (await response.json()) as DeviceRemindersResponse;
    const kinds = body.reminders.map((reminder) => reminder.kind).sort();
    expect(kinds).toEqual(["action", "check", "pond", "shift"]);
    const shift = body.reminders.find((reminder) => reminder.kind === "shift")!;
    expect(shift.title).toBe("Shift Irrigator");
    // Due two hours after it was last moved.
    expect(Math.abs(Date.parse(shift.at!) - (Date.now() + 3_600_000))).toBeLessThan(60_000);
    expect(shift.path).toBe(`/operations/farm/effluent?farm=${w.home}`);
    const pond = body.reminders.find((reminder) => reminder.kind === "pond")!;
    expect(pond).toMatchObject({ title: "Read Dairy pond", date: todayIsoDate(), daily: true, organisationId: ORG });
    expect(body.reminders.find((reminder) => reminder.kind === "check")).toMatchObject({ title: "Weekly check: Pods", date: todayIsoDate() });
    expect(body.reminders.find((reminder) => reminder.kind === "action")).toMatchObject({ title: "Safety action due: Fix the race gate (made up)", date: inDays(3) });
    // Not the runoff's pond, not the owner's action, not the LINZ key (admins renew it).
    expect(JSON.stringify(body)).not.toContain("Runoff pond");
    expect(JSON.stringify(body)).not.toContain("Owner's own job");
  });

  it("an admin gets every farm, their own actions and the LINZ key's two dates", async () => {
    const response = await remindersRoute.GET(apiRequest(`/api/app/reminders?organisationId=${ORG}`, { cookie: await sessionCookieFor(owner) }), undefined as never);
    const body = (await response.json()) as DeviceRemindersResponse;
    expect(body.reminders.filter((reminder) => reminder.kind === "pond").map((reminder) => reminder.title).sort()).toEqual(["Read Dairy pond", "Read Runoff pond"]);
    expect(body.reminders.filter((reminder) => reminder.kind === "action").map((reminder) => reminder.title)).toEqual(["Safety action due: Owner's own job (made up)"]);
    const linz = body.reminders.filter((reminder) => reminder.kind === "linz_key");
    expect(linz.map((reminder) => reminder.date)).toEqual([inDays(80), inDays(90)]);
    expect(linz.every((reminder) => reminder.path === "/operations/farming")).toBe(true);
  });

  it("an organisation with Farming off has none", async () => {
    await as(owner)((tx) => setFarmingEnabled(tx, { enabled: false }));
    try {
      const response = await remindersRoute.GET(apiRequest(`/api/app/reminders?organisationId=${ORG}`, { cookie: await sessionCookieFor(owner) }), undefined as never);
      expect(((await response.json()) as DeviceRemindersResponse).reminders).toEqual([]);
    } finally {
      await as(owner)((tx) => setFarmingEnabled(tx, { enabled: true }));
    }
  });
});
