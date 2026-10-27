import { afterAll, beforeAll, expect, it } from "vitest";
import * as launcherRoute from "@/app/api/farming/launchers/[launcherId]/route";
import * as launchersRoute from "@/app/api/farming/launchers/route";
import * as statusRoute from "@/app/api/farming/farms/[farmId]/paddock-status/route";
import type { SessionUser } from "@/lib/auth/sessions";
import { coreQuery } from "@/lib/db/transactions";
import type { OrgTx } from "@/lib/db/org-transaction";
import { setMemberFarmAccess } from "@/lib/farming/access";
import { paddockStatuses } from "@/lib/farming/paddock-status";
import { addPaddock, saveFarm, setFarmingEnabled } from "@/lib/farming/paddocks";
import { addGrazing, addReading, removeReading } from "@/lib/farming/pasture";
import { apiRequest, createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, params, sessionCookieFor, startTestServer, type TestServer } from "../helpers/test-server";

const ORG = "farm-workspace";
type Handler = (request: Request, context: never) => Promise<Response>;

/** The map's facts and the app tiles (#447, decisions 907 and 908; William's check on custom-app launchers). */
describeWithDatabase("the farmer's workspace", () => {
  let server: TestServer;
  let owner: SessionUser;
  let staff: SessionUser;
  let bookkeeper: SessionUser;
  const as = (user: SessionUser) => <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(ORG, { userId: user.id, email: user.email }, work);
  const w = {} as Record<string, string>;

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("workspace-owner@example.com", { serverAdmin: true, displayName: "Jess" });
    staff = await createTestUser("workspace-staff@example.com", { displayName: "Hemi" });
    bookkeeper = await createTestUser("workspace-books@example.com", { displayName: "Aroha" });
    await createTestOrganisation(owner, ORG);
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'farm_worker'), ($1, $3, 'bookkeeper')", [ORG, staff.id, bookkeeper.id]);
    const run = as(owner);
    await run((tx) => setFarmingEnabled(tx, { enabled: true }));
    w.home = (await run((tx) => saveFarm(tx, { name: "Home farm" })))[0].id;
    w.runoff = (await run((tx) => saveFarm(tx, { name: "Runoff" }))).find((farm) => farm.name === "Runoff")!.id;
    for (const name of ["1", "2", "3"]) w[`p${name}`] = (await run((tx) => addPaddock(tx, { farmId: w.home, name, effectiveHa: "10" }))).id;
    // Paddock 1: read twice, grazed and out on 10 October. Paddock 2: Milkers in since 25 October. Paddock 3: nothing.
    await run((tx) => addReading(tx, { paddockId: w.p1, measuredOn: "2026-10-01", cover: 2900, method: "plate_meter" }));
    await run((tx) => addReading(tx, { paddockId: w.p1, measuredOn: "2026-10-20", cover: 2300, method: "plate_meter" }));
    const late = await run((tx) => addReading(tx, { paddockId: w.p1, measuredOn: "2026-10-26", cover: 9999, method: "visual" }));
    await run((tx) => removeReading(tx, late.id));
    await run((tx) => addGrazing(tx, { paddockId: w.p1, mob: "Milkers", head: 300, inOn: "2026-10-09", outOn: "2026-10-10" }));
    await run((tx) => addGrazing(tx, { paddockId: w.p2, mob: "Milkers", head: 300, inOn: "2026-10-25" }));
    await run((tx) => setMemberFarmAccess(tx, { userId: staff.id, role: "farm_worker", access: "farms", farmIds: [w.home] }));
  });

  afterAll(async () => {
    await server?.teardown();
  });

  const call = async (user: SessionUser, handler: Handler, path: string, context: Record<string, string> = {}, method = "GET", body?: Record<string, unknown>) => {
    const response = await handler(
      apiRequest(method === "GET" || method === "DELETE" ? `${path}${path.includes("?") ? "&" : "?"}organisationId=${ORG}` : path, { method, cookie: await sessionCookieFor(user), body: body ? { organisationId: ORG, ...body } : undefined }),
      params(context) as never,
    );
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };

  it("gives each paddock's cover, mob and last day grazed on a date, for the map and paddock card", async () => {
    const statuses = await as(owner)((tx) => paddockStatuses(tx, { farmId: w.home, onDate: "2026-10-27" }));
    expect(statuses.map((status) => [status.name, status.cover?.cover ?? null, status.cover?.measuredOn ?? null, status.inNow?.mob ?? null, status.lastGrazedOn])).toEqual([
      ["1", 2300, "2026-10-20", null, "2026-10-10"],
      ["2", null, null, "Milkers", null],
      ["3", null, null, null, null],
    ]);
    // On an earlier date, it's as things were then.
    const before = await as(owner)((tx) => paddockStatuses(tx, { farmId: w.home, onDate: "2026-10-09" }));
    expect(before.map((status) => [status.name, status.cover?.cover ?? null, status.inNow?.mob ?? null, status.lastGrazedOn])).toEqual([
      ["1", 2900, "Milkers", null],
      ["2", null, null, null],
      ["3", null, null, null],
    ]);
    // Farm staff see their farm's, and another farm is not found.
    expect((await call(staff, statusRoute.GET as Handler, `/api/farming/farms/${w.home}/paddock-status?onDate=2026-10-27`, { farmId: w.home })).status).toBe(200);
    expect((await call(staff, statusRoute.GET as Handler, `/api/farming/farms/${w.runoff}/paddock-status`, { farmId: w.runoff })).status).toBe(404);
  });

  it("app tiles launch apps without giving away any key", async () => {
    const added = await call(owner, launchersRoute.POST as Handler, "/api/farming/launchers", {}, "POST", { name: "Plate meter", url: "https://plate.example.nz/walk", description: "Farm walks" });
    expect(added.status).toBe(201);
    await call(owner, launchersRoute.POST as Handler, "/api/farming/launchers", {}, "POST", { name: "Runoff water", url: "https://water.example.nz", farmId: w.runoff });
    // A key in the address is refused: everyone on the farm sees a tile.
    expect((await call(owner, launchersRoute.POST as Handler, "/api/farming/launchers", {}, "POST", { name: "Leaky", url: "https://x.example.nz/?k=tohyee_app_abcdef" })).status).toBe(400);
    // Farm staff see the tiles for their farms: a name and address, nothing else.
    const seen = await call(staff, launchersRoute.GET as Handler, "/api/farming/launchers");
    expect(seen.status).toBe(200);
    const tiles = seen.body.launchers as Array<Record<string, unknown>>;
    expect(tiles.map((tile) => tile.name)).toEqual(["Plate meter"]);
    expect(Object.keys(tiles[0]).sort()).toEqual(["createdByEmail", "createdByName", "description", "farmId", "id", "name", "url"]);
    expect(JSON.stringify(seen.body)).not.toMatch(/tohyee_app_|token|secret|scope/i);
    // Only admins add or remove tiles.
    expect((await call(staff, launchersRoute.POST as Handler, "/api/farming/launchers", {}, "POST", { name: "Mine", url: "https://mine.example.nz" })).status).toBe(403);
    expect((await call(bookkeeper, launchersRoute.POST as Handler, "/api/farming/launchers", {}, "POST", { name: "Mine", url: "https://mine.example.nz" })).status).toBe(403);
    const id = (tiles[0] as { id: string }).id;
    expect((await call(staff, launcherRoute.DELETE as Handler, `/api/farming/launchers/${id}`, { launcherId: id }, "DELETE")).status).toBe(403);
    const removed = await call(owner, launcherRoute.DELETE as Handler, `/api/farming/launchers/${id}`, { launcherId: id }, "DELETE");
    expect((removed.body.launchers as Array<{ name: string }>).map((tile) => tile.name)).toEqual(["Runoff water"]);
  });
});
