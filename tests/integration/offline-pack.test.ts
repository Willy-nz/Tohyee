import { afterAll, beforeAll, expect, it } from "vitest";
import * as fileRoute from "@/app/api/farming/offline-pack/file/route";
import * as packRoute from "@/app/api/farming/offline-pack/route";
import type { SessionUser } from "@/lib/auth/sessions";
import type { OrgTx } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import { setMemberFarmAccess } from "@/lib/farming/access";
import { addPaddock, saveFarm, setFarmingEnabled } from "@/lib/farming/paddocks";
import { answerFromEntries } from "@/lib/offline/pack-inventory";
import { uploadSafetyFile } from "@/lib/safety/files";
import { addHazard, saveEmergency } from "@/lib/safety/hazards";
import { addReport } from "@/lib/safety/reports";
import { apiRequest, createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, params, sessionCookieFor, startTestServer, type TestServer } from "../helpers/test-server";

const ORG = "offline-pack";
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 2, 0xff, 0xd9]).toString("base64");

type Handler = (request: Request, context: never) => Promise<Response>;

/**
 * Offline farm packs on the server (#472 stage 3, decisions 999-1007):
 * built from the screens' own reads as the person asking, so farm access
 * and roles apply exactly; never injury or medical details or restricted
 * photos, even for an owner. Made-up data only.
 */
describeWithDatabase("offline farm packs", () => {
  let server: TestServer;
  let owner: SessionUser;
  let worker: SessionUser;
  const as = (user: SessionUser) => <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(ORG, { userId: user.id, email: user.email }, work);
  const w = {} as Record<string, string>;

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("pack-owner@example.com", { serverAdmin: true, displayName: "Jess" });
    worker = await createTestUser("pack-worker@example.com", { displayName: "Hemi" });
    await createTestOrganisation(owner, ORG);
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'farm_worker')", [ORG, worker.id]);
    await as(owner)((tx) => setFarmingEnabled(tx, { enabled: true }));
    w.home = (await as(owner)((tx) => saveFarm(tx, { name: "Home farm" })))[0].id;
    w.runoff = (await as(owner)((tx) => saveFarm(tx, { name: "Runoff" }))).find((farm) => farm.name === "Runoff")!.id;
    w.paddock = (await as(owner)((tx) => addPaddock(tx, { farmId: w.home, name: "1", effectiveHa: "5" }))).id;
    await as(owner)((tx) => setMemberFarmAccess(tx, { userId: worker.id, role: "farm_worker", access: "farms", farmIds: [w.home] }));
    await as(owner)((tx) => addHazard(tx, { farmId: w.home, title: "Effluent pond", level: "high", noGo: true, paddockIds: [w.paddock] }));
    await as(owner)((tx) => addHazard(tx, { farmId: w.runoff, title: "Runoff quarry", level: "high" }));
    await as(owner)((tx) => saveEmergency(tx, { farmId: w.home, address: "1 Example Road" }));
    const photo = await as(owner)((tx) => uploadSafetyFile(tx, { farmId: w.home, fileName: "race.jpg", contentType: "image/jpeg", contentBase64: JPEG }));
    const injury = await as(owner)((tx) => uploadSafetyFile(tx, { farmId: w.home, fileName: "cut.jpg", contentType: "image/jpeg", contentBase64: JPEG, restricted: true }));
    w.photo = photo.id;
    w.injury = injury.id;
    await as(owner)((tx) => addReport(tx, { farmId: w.home, type: "incident", title: "Cut hand on the gate", injured: true, files: [{ id: photo.id }], details: { injuredPerson: "Hemi", injury: "Deep cut to the left hand", files: [{ id: injury.id }] } }));
  });

  afterAll(async () => {
    await server?.teardown();
  });

  const get = async (user: SessionUser | null, handler: Handler, path: string) =>
    handler(apiRequest(`${path}${path.includes("?") ? "&" : "?"}organisationId=${ORG}`, { cookie: user ? await sessionCookieFor(user) : undefined }), params({}) as never);

  const section = async (user: SessionUser, name: string, farmId?: string) => {
    const response = await get(user, packRoute.GET as Handler, `/api/farming/offline-pack?section=${name}${farmId ? `&farmId=${farmId}` : ""}`);
    return { status: response.status, body: (await response.json()) as { entries: Array<{ path: string; query: Record<string, string>; body: unknown }>; skipped: Array<{ path: string; reason: string }>; files: Array<{ id: string }> } };
  };

  it("lists only the farms the person can see", async () => {
    const forWorker = (await (await get(worker, packRoute.GET as Handler, "/api/farming/offline-pack")).json()) as { farms: Array<{ name: string }>; months: number; neverIncluded: string[] };
    expect(forWorker.farms.map((farm) => farm.name)).toEqual(["Home farm"]);
    expect(forWorker.months).toBe(12);
    const forOwner = (await (await get(owner, packRoute.GET as Handler, "/api/farming/offline-pack")).json()) as { farms: Array<{ name: string }> };
    expect(forOwner.farms.map((farm) => farm.name).sort()).toEqual(["Home farm", "Runoff"]);
  });

  it("refuses a farm the person can't see, and anyone not signed in", async () => {
    expect((await section(worker, "safety", w.runoff)).status).toBe(404);
    expect((await section(worker, "map", w.runoff)).status).toBe(404);
    expect((await get(null, packRoute.GET as Handler, "/api/farming/offline-pack")).status).toBe(401);
    expect((await section(worker, "nonsense", w.home)).status).toBe(400);
  });

  it("builds a farm's safety from the same reads as the screen, for that farm only", async () => {
    const { status, body } = await section(worker, "safety", w.home);
    expect(status).toBe(200);
    expect(body.entries.map((entry) => [entry.path, entry.query])).toEqual([
      ["/api/farming/safety", { farmId: w.home }],
      ["/api/farming/safety/today", { farmId: w.home }],
      ["/api/farming/safety/reports", { farmId: w.home }],
    ]);
    const overview = body.entries[0].body as { hazards: Array<{ data: { title: string } }>; emergency: { data: { address: string } } };
    expect(overview.hazards.map((hazard) => hazard.data.title)).toEqual(["Effluent pond"]);
    expect(overview.emergency.data.address).toBe("1 Example Road");
    expect(JSON.stringify(body)).not.toContain("Runoff quarry");
  });

  it("never includes injury or medical details or restricted photos, even for the owner who may see them online", async () => {
    const { body } = await section(owner, "safety", w.home);
    const reports = body.entries.find((entry) => entry.path === "/api/farming/safety/reports")!.body as { reports: Array<{ details: unknown; detailsHidden: boolean; files: Array<{ id: string }> }>; access: { canSeeRestricted: boolean } };
    expect(reports.reports[0]).toMatchObject({ details: null, detailsHidden: true });
    expect(reports.reports[0].files.map((file) => file.id)).toEqual([w.photo]);
    expect(reports.access.canSeeRestricted).toBe(false);
    expect(JSON.stringify(body)).not.toContain("Deep cut");
    expect(JSON.stringify(body)).not.toContain(w.injury);
    // The photos section names the ordinary photo only.
    expect((await section(owner, "photos", w.home)).body.files.map((file) => file.id)).toEqual([w.photo]);
    // And the file address refuses the restricted one, even for the owner.
    expect((await get(owner, fileRoute.GET as Handler, `/api/farming/offline-pack/file?fileId=${w.injury}`)).status).toBe(404);
    const ordinary = await get(worker, fileRoute.GET as Handler, `/api/farming/offline-pack/file?fileId=${w.photo}`);
    expect(ordinary.status).toBe(200);
    expect(ordinary.headers.get("cache-control")).toBe("private, no-store");
  });

  it("leaves out what the person's role can't read, and says so", async () => {
    const notebook = await section(worker, "notebook");
    expect(notebook.status).toBe(200);
    expect(notebook.body.entries).toEqual([]);
    expect(notebook.body.skipped.map((entry) => entry.path)).toEqual(["/api/farm-notebook"]);
    const plans = await section(worker, "plans", w.home);
    expect(plans.body.skipped.map((entry) => entry.path)).toContain(`/api/farming/farms/${w.home}/plans`);
    // The owner gets them.
    expect((await section(owner, "notebook")).body.skipped).toEqual([]);
  });

  it("keeps the map, pasture and calendar for the farm, with a year of history", async () => {
    const map = await section(worker, "map", w.home);
    expect(map.body.entries.map((entry) => entry.path)).toEqual([`/api/farming/farms/${w.home}/paddocks`, `/api/farming/farms/${w.home}/paddock-status`, `/api/farming/paddocks/${w.paddock}`]);
    const pasture = await section(worker, "pasture", w.home);
    expect(pasture.body.entries.map((entry) => entry.path)).toEqual([
      `/api/farming/farms/${w.home}/pasture`,
      `/api/farming/farms/${w.home}/grazings`,
      `/api/farming/farms/${w.home}/grazings`,
      `/api/farming/farms/${w.home}/supplements`,
      `/api/farming/farms/${w.home}/pasture/readings`,
      `/api/farming/paddocks/${w.paddock}/pasture`,
    ]);
    const calendar = await section(worker, "calendar", w.home);
    expect(calendar.status).toBe(200);
    expect(calendar.body.entries.map((entry) => `${entry.path} ${entry.query.view ?? "range"}`)).toEqual(["/api/farming/calendar range", "/api/farming/calendar check", "/api/farming/safety/due range"]);
  });

  it("keeps what the farm sections' screens read: soil histories, tractor machines and jobs (#477)", async () => {
    const soil = await section(owner, "soil", w.home);
    expect(soil.body.entries.map((entry) => entry.path)).toContain(`/api/farming/paddocks/${w.paddock}/history`);
    const equipment = await section(owner, "equipment", w.home);
    expect(equipment.body.entries.map((entry) => entry.path)).toEqual(expect.arrayContaining(["/api/farming/tractor/equipment", "/api/farming/tractor/jobs"]));
  });

  it("keeps every grazing of the year, past the server's 1,000 a read, and pages them on the device without repeats (#479)", async () => {
    const paddock = (await as(owner)((tx) => addPaddock(tx, { farmId: w.home, name: "History", effectiveHa: "3" }))).id;
    const today = new Date().toISOString().slice(0, 10);
    await as(owner)((tx) =>
      tx.query(
        "insert into grazings (farm_id, paddock_id, mob, head, in_on, out_on, created_by_email) select $1, $2, 'Heifers', 40, ($3::date - (n / 4)), ($3::date - (n / 4)), 'pack-owner@example.com' from generate_series(1, 1200) as n",
        [w.home, paddock, today],
      ),
    );
    const pasture = await section(owner, "pasture", w.home);
    const history = pasture.body.entries.find((entry) => entry.path === `/api/farming/farms/${w.home}/grazings` && !entry.query.open)!;
    const body = history.body as { grazings: Array<{ id: string }>; next: string | null; offline: { complete: boolean; count: number } };
    expect(body.grazings).toHaveLength(1200);
    expect(body.next).toBeNull();
    expect(body.offline).toMatchObject({ complete: true, count: 1200 });

    // Paged on the device as the screen asks: 25 at a time, each row once, ending.
    const seen = new Set<string>();
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page = answerFromEntries(pasture.body.entries, history.path, { organisationId: ORG, paddockId: paddock, cursor }) as { grazings: Array<{ id: string }>; next: string | null };
      for (const row of page.grazings) {
        expect(seen.has(row.id)).toBe(false);
        seen.add(row.id);
      }
      cursor = page.next;
      pages += 1;
    } while (cursor && pages < 100);
    expect(seen.size).toBe(1200);
    expect(pages).toBe(48);
  });
});
