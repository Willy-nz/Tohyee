import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as farmLocationsRoute from "@/app/api/farming/farms/[farmId]/locations/route";
import * as myLocationRoute from "@/app/api/farming/locations/route";
import type { SessionUser } from "@/lib/auth/sessions";
import { startPgTool } from "@/lib/backups/pg-tools";
import { pgDumpArgs } from "@/lib/backups/service";
import { coreQuery } from "@/lib/db/transactions";
import type { OrgTx } from "@/lib/db/org-transaction";
import { setMemberFarmAccess } from "@/lib/farming/access";
import { deleteExpiredShares } from "@/lib/farming/locations";
import { positionState, type SharingPerson } from "@/lib/farming/locations-shared";
import { saveFarm, setFarmingEnabled } from "@/lib/farming/paddocks";
import { getOrganisation } from "@/lib/organisations/registry";
import { apiRequest, createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, params, sessionCookieFor, startTestServer, type TestServer } from "../helpers/test-server";

const ORG = "farm-locations";
const OTHER = "farm-locations-other";

type Handler = (request: Request, context: never) => Promise<Response>;

/**
 * Farm members on the map (#498 item 7, decisions 1125-1134): opt-in
 * sharing, only the latest position, seen only by members who work on that
 * farm, stopped or expired positions deleted, and starting and stopping
 * audited (positions never). Made-up people and places.
 */
describeWithDatabase("farm members on the map", () => {
  let server: TestServer;
  let owner: SessionUser;
  let staff: SessionUser;
  let runoffStaff: SessionUser;
  let salesRep: SessionUser;
  let outsider: SessionUser;
  const w = {} as Record<string, string>;
  const as = (user: SessionUser) => <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(ORG, { userId: user.id, email: user.email }, work);

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("loc-owner@example.com", { serverAdmin: true, displayName: "Jess Kelly" });
    staff = await createTestUser("loc-staff@example.com", { displayName: "Mere Tane" });
    runoffStaff = await createTestUser("loc-runoff@example.com", { displayName: "Tama Rua" });
    salesRep = await createTestUser("loc-sales@example.com", { displayName: "Aroha" });
    outsider = await createTestUser("loc-outsider@example.com", { displayName: "Rangi" });
    await createTestOrganisation(owner, ORG);
    await createTestOrganisation(outsider, OTHER);
    for (const [user, role] of [[staff, "farm_worker"], [runoffStaff, "farm_worker"], [salesRep, "sales_rep"]] as const) {
      await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, $3)", [ORG, user.id, role]);
    }
    const run = as(owner);
    await run((tx) => setFarmingEnabled(tx, { enabled: true }));
    w.home = (await run((tx) => saveFarm(tx, { name: "Home farm" })))[0].id;
    w.runoff = (await run((tx) => saveFarm(tx, { name: "Runoff" }))).find((farm) => farm.name === "Runoff")!.id;
    await run((tx) => setMemberFarmAccess(tx, { userId: staff.id, role: "farm_worker", access: "farms", farmIds: [w.home] }));
    await run((tx) => setMemberFarmAccess(tx, { userId: runoffStaff.id, role: "farm_worker", access: "farms", farmIds: [w.runoff] }));
    const other = (fn: (tx: OrgTx) => Promise<unknown>) => inOrganisation(OTHER, { userId: outsider.id, email: outsider.email }, fn);
    await other((tx) => setFarmingEnabled(tx, { enabled: true }));
    w.otherFarm = ((await other((tx) => saveFarm(tx, { name: "Other farm" }))) as Array<{ id: string }>)[0].id;
  });

  afterAll(async () => {
    await server?.teardown();
  });

  const call = async (user: SessionUser, handler: Handler, path: string, context: Record<string, string> = {}, method = "GET", body?: Record<string, unknown>, organisationId = ORG) =>
    handler(
      apiRequest(method === "GET" || method === "DELETE" ? `${path}?organisationId=${organisationId}` : path, {
        method,
        cookie: await sessionCookieFor(user),
        body: body ? { organisationId, ...body } : undefined,
      }),
      params(context) as never,
    );
  const start = (user: SessionUser, farmId: string, hours?: number) => call(user, farmLocationsRoute.POST as Handler, `/api/farming/farms/${farmId}/locations`, { farmId }, "POST", hours === undefined ? {} : { hours });
  const list = (user: SessionUser, farmId: string, organisationId = ORG) => call(user, farmLocationsRoute.GET as Handler, `/api/farming/farms/${farmId}/locations`, { farmId }, "GET", undefined, organisationId);
  const send = (user: SessionUser, body: Record<string, unknown>) => call(user, myLocationRoute.PUT as Handler, "/api/farming/locations", {}, "PUT", body);
  const stop = (user: SessionUser) => call(user, myLocationRoute.DELETE as Handler, "/api/farming/locations", {}, "DELETE");
  const mine = (user: SessionUser) => call(user, myLocationRoute.GET as Handler, "/api/farming/locations");
  const rows = () => as(owner)((tx) => tx.query<{ user_email: string; farm_id: string; latitude: number | null }>("select user_email, farm_id::text, latitude from farm_location_shares order by user_email"));
  // The rate limit counts from when Tohyee last got a position: moved back, as if 10 seconds had passed.
  const waitOut = (user: SessionUser) => as(owner)((tx) => tx.query("update farm_location_shares set received_at = received_at - interval '11 seconds' where user_id = $1", [user.id]));
  const at = (lat: number, lon: number, accuracy = 8) => ({ latitude: lat, longitude: lon, accuracyMetres: accuracy, takenAt: new Date().toISOString() });

  it("is off until someone starts it, and no one sees anything before then", async () => {
    expect((await (await mine(staff)).json()).sharing).toBeNull();
    const response = await list(owner, w.home);
    expect(response.status).toBe(200);
    expect((await response.json()).people).toEqual([]);
    // A position with no sharing is refused, not stored.
    expect((await send(staff, at(-45.91, 170.48))).status).toBe(404);
    expect((await rows()).rows).toHaveLength(0);
  });

  it("two members share with the farm and each sees the other, with only the latest position", async () => {
    const started = await start(staff, w.home);
    expect(started.status).toBe(201);
    const sharing = (await started.json()).sharing;
    expect(sharing).toMatchObject({ farmId: w.home, farmName: "Home farm", hasPosition: false });
    // Four hours unless chosen.
    expect(new Date(sharing.endsAt).getTime() - new Date(sharing.startedAt).getTime()).toBe(4 * 3_600_000);
    expect((await start(owner, w.home, 2)).status).toBe(201);

    expect((await send(staff, { shareId: sharing.shareId, ...at(-45.91, 170.48) })).status).toBe(200);
    expect((await send(owner, at(-45.912, 170.481, 12))).status).toBe(200);
    await waitOut(staff);
    expect((await send(staff, at(-45.92, 170.49))).status).toBe(200);

    const seenByOwner = (await (await list(owner, w.home)).json()).people as SharingPerson[];
    expect(seenByOwner.map((person) => [person.name, person.isMe])).toEqual([
      ["Mere Tane", false],
      ["Jess Kelly", true],
    ]);
    // Only where Mere is now: the first position is gone, not kept as a trail.
    expect(seenByOwner[0].position).toMatchObject({ latitude: -45.92, longitude: 170.49, accuracyMetres: 8 });
    expect(positionState(seenByOwner[0].position, new Date())).toBe("recent");
    const seenByStaff = (await (await list(staff, w.home)).json()).people as SharingPerson[];
    expect(seenByStaff.map((person) => [person.name, person.isMe])).toEqual([
      ["Mere Tane", true],
      ["Jess Kelly", false],
    ]);
    // No emails in what the map gets.
    expect(JSON.stringify(seenByStaff)).not.toContain("@example.com");
    expect((await rows()).rows).toHaveLength(2);
  });

  it("refuses positions too often, too rough or too old, and other people's sessions", async () => {
    expect((await send(staff, at(-45.93, 170.5))).status).toBe(429);
    await waitOut(staff);
    expect((await send(staff, at(-45.93, 170.5, 2500))).status).toBe(400);
    expect((await send(staff, { ...at(-45.93, 170.5), takenAt: new Date(Date.now() - 5 * 60_000).toISOString() })).status).toBe(400);
    expect((await send(staff, { ...at(-45.93, 170.5), latitude: 123 })).status).toBe(400);
    // A session id that isn't yours now isn't carried on.
    const ownerShare = (await (await mine(owner)).json()).sharing.shareId;
    expect((await send(staff, { shareId: ownerShare, ...at(-45.93, 170.5) })).status).toBe(404);
    // A rough fix (but under 2 km) is kept, with its accuracy, so the map draws an area.
    expect((await send(staff, at(-45.93, 170.5, 450))).status).toBe(200);
    const mere = ((await (await list(owner, w.home)).json()).people as SharingPerson[]).find((person) => person.name === "Mere Tane")!;
    expect(mere.position?.accuracyMetres).toBe(450);
  });

  it("labels an old position last known, not live", async () => {
    await as(owner)((tx) => tx.query("update farm_location_shares set position_at = now() - interval '12 minutes' where user_id = $1", [staff.id]));
    const mere = ((await (await list(owner, w.home)).json()).people as SharingPerson[]).find((person) => person.name === "Mere Tane")!;
    expect(positionState(mere.position, new Date())).toBe("stale");
  });

  it("is seen only by members who work on that farm; another farm or organisation is not found", async () => {
    // Tama works on Runoff only.
    expect((await list(runoffStaff, w.home)).status).toBe(404);
    expect((await (await list(runoffStaff, w.runoff)).json()).people).toEqual([]);
    // Mere can't share with, or look at, a farm she doesn't work on.
    expect((await start(staff, w.runoff)).status).toBe(404);
    expect((await list(staff, w.runoff)).status).toBe(404);
    // A farm that isn't there, and a farm id from another organisation, are not found too.
    expect((await list(owner, "999999")).status).toBe(404);
    expect((await list(outsider, w.home)).status).toBe(404);
    expect((await list(owner, w.otherFarm, OTHER)).status).toBe(404);
    // Roles without farm records (the CRM's sales rep) are refused.
    expect((await list(salesRep, w.home)).status).toBe(403);
  });

  it("records starting and stopping in the audit trail, never a position", async () => {
    const audit = await as(owner)((tx) => tx.query<{ event_type: string; actor_email: string; details: Record<string, unknown> }>("select event_type, actor_email, details from audit_events where event_type like 'farming.location_sharing%' order by id"));
    expect(audit.rows.map((row) => [row.event_type, row.actor_email])).toEqual([
      ["farming.location_sharing_started", staff.email],
      ["farming.location_sharing_started", owner.email],
    ]);
    expect(JSON.stringify(audit.rows)).not.toMatch(/latitude|longitude|-45\.9/);
  });

  it("leaves positions out of backups", async () => {
    const organisation = (await getOrganisation(ORG))!;
    const dump = startPgTool("pg_dump", pgDumpArgs("plain"), organisation.databaseName);
    dump.child.stdin?.end();
    let text = "";
    dump.child.stdout!.setEncoding("utf8");
    dump.child.stdout!.on("data", (chunk: string) => {
      text += chunk;
    });
    await dump.done;
    // The table is there (so a restore works), but none of its rows.
    expect(text).toContain("CREATE TABLE public.farm_location_shares");
    expect(text).not.toMatch(/COPY public\.farm_location_shares/);
    // Nor any of the positions sent above.
    expect(text).not.toMatch(/-45\.9[123]/);
  });

  it("Stop sharing deletes the position at once", async () => {
    const response = await stop(staff);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ stopped: true });
    expect((await rows()).rows.map((row) => row.user_email)).toEqual([owner.email]);
    expect(((await (await list(owner, w.home)).json()).people as SharingPerson[]).map((person) => person.name)).toEqual(["Jess Kelly"]);
    // Stopping twice is fine; a phone still sending is refused.
    expect(await (await stop(staff)).json()).toEqual({ stopped: false });
    await waitOut(staff);
    expect((await send(staff, at(-45.9, 170.5))).status).toBe(404);
    const audit = await as(owner)((tx) => tx.query<{ details: { reason: string } }>("select details from audit_events where event_type = 'farming.location_sharing_stopped' and actor_email = $1", [staff.email]));
    expect(audit.rows.map((row) => row.details.reason)).toEqual(["stopped"]);
  });

  it("an expired session is deleted and shown to no one", async () => {
    await as(owner)((tx) => tx.query("update farm_location_shares set started_at = now() - interval '3 hours', ends_at = now() - interval '1 minute' where user_id = $1", [owner.id]));
    expect((await (await list(staff, w.home)).json()).people).toEqual([]);
    expect((await rows()).rows).toHaveLength(0);
    expect((await (await mine(owner)).json()).sharing).toBeNull();
  });

  it("the clean-up deletes expired sessions without anyone opening the map, and keeps current ones", async () => {
    expect((await start(staff, w.home, 12)).status).toBe(201);
    expect((await start(runoffStaff, w.runoff, 1)).status).toBe(201);
    await as(owner)((tx) => tx.query("update farm_location_shares set started_at = now() - interval '2 hours', ends_at = now() - interval '1 hour' where user_id = $1", [runoffStaff.id]));
    expect(await as(owner)((tx) => deleteExpiredShares(tx))).toBe(1);
    expect((await rows()).rows.map((row) => row.user_email)).toEqual([staff.email]);
    // The database itself refuses more than 12 hours.
    await expect(as(owner)((tx) => tx.query("update farm_location_shares set ends_at = started_at + interval '13 hours' where user_id = $1", [staff.id]))).rejects.toThrow();
    expect((await start(staff, w.home, 13)).status).toBe(400);
  });

  it("ends when the member stops working on that farm", async () => {
    await as(owner)((tx) => setMemberFarmAccess(tx, { userId: staff.id, role: "farm_worker", access: "farms", farmIds: [w.runoff] }));
    expect((await rows()).rows).toHaveLength(0);
    expect((await (await mine(staff)).json()).sharing).toBeNull();
  });
});
