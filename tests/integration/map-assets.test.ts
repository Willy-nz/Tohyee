import { afterAll, beforeAll, expect, it } from "vitest";
import * as assetsRoute from "@/app/api/farming/farms/[farmId]/map-assets/route";
import * as assetRoute from "@/app/api/farming/map-assets/[assetId]/route";
import type { SessionUser } from "@/lib/auth/sessions";
import { coreQuery } from "@/lib/db/transactions";
import type { OrgTx } from "@/lib/db/org-transaction";
import { setMemberFarmAccess } from "@/lib/farming/access";
import { addMapAsset, listMapAssets, removeMapAsset, updateMapAsset } from "@/lib/farming/map-assets";
import { saveFarm, setFarmingEnabled } from "@/lib/farming/paddocks";
import { apiRequest, createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, params, sessionCookieFor, startTestServer, type TestServer } from "../helpers/test-server";

type Handler = (request: Request, context: never) => Promise<Response>;
const ORG = "map-assets-co";

/** Farm map assets (MA1-MA3; decisions 1462-1465, not yet reviewed). Made-up farms and people. */
describeWithDatabase("farm map assets", () => {
  let server: TestServer;
  let owner: SessionUser;
  let worker: SessionUser;
  let viewer: SessionUser;
  const w = {} as Record<string, string>;
  const as = (user: SessionUser) => <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(ORG, { userId: user.id, email: user.email }, work);

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("assets-owner@example.com", { serverAdmin: true, displayName: "Aroha" });
    worker = await createTestUser("assets-staff@example.com", { displayName: "Tama" });
    viewer = await createTestUser("assets-viewer@example.com", { displayName: "Rangi" });
    await createTestOrganisation(owner, ORG);
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'farm_worker'), ($1, $3, 'viewer')", [ORG, worker.id, viewer.id]);
    const run = as(owner);
    await run((tx) => setFarmingEnabled(tx, { enabled: true }));
    w.home = (await run((tx) => saveFarm(tx, { name: "Home farm" })))[0].id;
    w.runoff = (await run((tx) => saveFarm(tx, { name: "Runoff" }))).find((farm) => farm.name === "Runoff")!.id;
    await run((tx) => setMemberFarmAccess(tx, { userId: worker.id, role: "farm_worker", access: "farms", farmIds: [w.home] }));
    await run((tx) => setMemberFarmAccess(tx, { userId: viewer.id, role: "viewer", access: "farms", farmIds: [w.home] }));
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

  it("MA1 points: troughs, gates and the like, with a name and note", async () => {
    const added = await call(worker, assetsRoute.POST as Handler, `/api/farming/farms/${w.home}/map-assets`, { farmId: w.home }, "POST", { kind: "trough", name: "Trough in 12", note: "Ballcock sticks", point: [169.8045125, -46.1805267] });
    expect(added.status).toBe(201);
    expect(added.body.asset).toMatchObject({ kind: "trough", name: "Trough in 12", note: "Ballcock sticks", point: [169.804513, -46.180527], line: null, lengthMetres: null, createdByEmail: "assets-staff@example.com" });
    w.trough = (added.body.asset as { id: string }).id;
    const run = as(owner);
    await expect(run((tx) => addMapAsset(tx, { farmId: w.home, kind: "trough", name: "No place" }))).rejects.toThrow("Tap the map where it is");
    await expect(run((tx) => addMapAsset(tx, { farmId: w.home, kind: "windmill", name: "x", point: [169.8, -46.18] }))).rejects.toThrow("Kind must be one of");
    await expect(run((tx) => addMapAsset(tx, { farmId: w.home, kind: "gate", name: "x", point: [200, -46.18] }))).rejects.toThrow("longitude and latitude");
    // Viewers see assets but can't add them; staff can't reach another farm's.
    expect((await call(viewer, assetsRoute.POST as Handler, `/api/farming/farms/${w.home}/map-assets`, { farmId: w.home }, "POST", { kind: "gate", name: "x", point: [169.8, -46.18] })).status).toBe(403);
    expect((await call(viewer, assetsRoute.GET as Handler, `/api/farming/farms/${w.home}/map-assets`, { farmId: w.home })).status).toBe(200);
    expect((await call(worker, assetsRoute.GET as Handler, `/api/farming/farms/${w.runoff}/map-assets`, { farmId: w.runoff })).status).toBe(404);
  });

  it("MA2 lines: fences and pipes, at least two points, with their length", async () => {
    const run = as(owner);
    const fence = await run((tx) => addMapAsset(tx, { farmId: w.home, kind: "fence", name: "Boundary fence", line: [[169.8, -46.18], [169.8, -46.18], [169.801, -46.18], [169.801, -46.181]] }));
    // The repeated point is dropped; 77 m east then 111 m south.
    expect(fence.line).toEqual([[169.8, -46.18], [169.801, -46.18], [169.801, -46.181]]);
    expect(fence.lengthMetres).toBe(188);
    await expect(run((tx) => addMapAsset(tx, { farmId: w.home, kind: "pipe", name: "x", line: [[169.8, -46.18]] }))).rejects.toThrow("at least two points");
    await expect(run((tx) => addMapAsset(tx, { farmId: w.home, kind: "pipe", name: "x", line: [[169.8, -46.18], [169.8, -46.18]] }))).rejects.toThrow("two different points");
    await expect(run((tx) => updateMapAsset(tx, fence.id, { kind: "gate" }))).rejects.toThrow("A line can't become a point");
    w.fence = fence.id;
  });

  it("MA3 changed and removed with who and when; removed ones are kept", async () => {
    const changed = await call(worker, assetRoute.PATCH as Handler, `/api/farming/map-assets/${w.trough}`, { assetId: w.trough }, "PATCH", { name: "Trough, paddock 12", point: [169.805, -46.181] });
    expect(changed.status).toBe(200);
    expect(changed.body.asset).toMatchObject({ name: "Trough, paddock 12", point: [169.805, -46.181], note: "Ballcock sticks", updatedByEmail: "assets-staff@example.com" });
    expect((await call(worker, assetRoute.DELETE as Handler, `/api/farming/map-assets/${w.fence}`, { assetId: w.fence }, "DELETE")).status).toBe(200);
    const run = as(owner);
    expect((await run((tx) => listMapAssets(tx, w.home))).map((asset) => asset.name)).toEqual(["Trough, paddock 12"]);
    const kept = await run((tx) => tx.query<{ status: string; removed_by_email: string }>("select status, removed_by_email from farm_map_assets where id = $1", [w.fence]));
    expect(kept.rows[0]).toEqual({ status: "removed", removed_by_email: "assets-staff@example.com" });
    await expect(run((tx) => removeMapAsset(tx, w.fence))).rejects.toThrow("not found, or removed");
  });
});
