import { afterAll, beforeAll, expect, it } from "vitest";
import * as packRoute from "@/app/api/farming/effluent/pack/route";
import type { SessionUser } from "@/lib/auth/sessions";
import type { OrgTx } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import { addIncident, reportFault } from "@/lib/effluent/care";
import { addApplication, addPondReading } from "@/lib/effluent/log";
import { loadCouncilPack, renderCouncilPack } from "@/lib/effluent/pack";
import { addSetup, addSystem, changeSetup } from "@/lib/effluent/setup";
import type { OutgoingMessage } from "@/lib/email/smtp";
import { setMemberFarmAccess } from "@/lib/farming/access";
import { addPaddock, saveFarm, setBoundary, setFarmingEnabled } from "@/lib/farming/paddocks";
import { getOrganisation } from "@/lib/organisations/registry";
import { verifyChain } from "@/lib/safety/chain";
import { uploadSafetyFile } from "@/lib/safety/files";
import { addHazard } from "@/lib/safety/hazards";
import { copySettings, saveCopySettings, sendSafetyCopy } from "@/lib/safety/weekly-copy";
import { apiRequest, createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, sessionCookieFor, startTestServer, type TestServer } from "../helpers/test-server";

const ORG = "farm-effluent-pack";
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 2, 0xff, 0xd9]).toString("base64");
const ago = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();
const square = { type: "Polygon", coordinates: [[[170.5, -45.9], [170.502, -45.9], [170.502, -45.902], [170.5, -45.902], [170.5, -45.9]]] };

/**
 * The council pack, the weekly copy option and tanker runs from tractor
 * mode (#487, EF24-EF29 in docs/FARM-EFFLUENT.md, decision 1099).
 */
describeWithDatabase("farm effluent council pack", () => {
  let server: TestServer;
  let owner: SessionUser;
  let worker: SessionUser;
  const as = (user: SessionUser) => <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(ORG, { userId: user.id, email: user.email }, work);
  const w = {} as Record<string, string>;
  let members: Map<string, string>;

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("efp-owner@example.com", { serverAdmin: true, displayName: "Jess" });
    worker = await createTestUser("efp-worker@example.com", { displayName: "Hemi" });
    await createTestOrganisation(owner, ORG);
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'farm_worker')", [ORG, worker.id]);
    members = new Map([[owner.id, "Jess"], [worker.id, "Hemi"]]);
    await as(owner)((tx) => setFarmingEnabled(tx, { enabled: true }));
    w.home = (await as(owner)((tx) => saveFarm(tx, { name: "Home farm" })))[0].id;
    w.p1 = (await as(owner)((tx) => addPaddock(tx, { farmId: w.home, name: "1", effectiveHa: "4" }))).id;
    await as(owner)((tx) => setBoundary(tx, w.p1, { geometry: square, source: "drawn" }));
    await as(owner)((tx) => setMemberFarmAccess(tx, { userId: worker.id, role: "farm_worker", access: "farms", farmIds: [w.home] }));
    const consent = await as(owner)((tx) => addSetup(tx, "consents", { farmId: w.home, council: "orc", template: "orc", consentNumber: "RM-TEST (made up)" }));
    await as(owner)((tx) => changeSetup(tx, "consents", consent.recordId, { expectedVersion: 1, maxDepthMm: "25", returnPeriodDays: 14 }));
    w.pond = (await as(owner)((tx) => addSetup(tx, "ponds", { farmId: w.home, name: "Pond", capacityM3: "1000", fullAtMm: "2000", highAtMm: "1800" }))).recordId;
    await as(owner)((tx) => addSetup(tx, "zones", { farmId: w.home, name: "Creek", feature: "waterway", zone: square }));
    const irrigator = await as(owner)((tx) => addSystem(tx, { farmId: w.home, name: "Irrigator", type: "travelling_irrigator", settings: { flowM3PerHour: "18", wettedWidthM: "30", speedMPerHour: "40" } }, members));
    w.irrigator = irrigator.recordId;
    w.tanker = (await as(owner)((tx) => addSystem(tx, { farmId: w.home, name: "Tanker", type: "slurry_tanker", settings: { tankM3: "10" } }, members))).recordId;
    const photo = await as(worker)((tx) => uploadSafetyFile(tx, { farmId: w.home, fileName: "pond.jpg", contentType: "image/jpeg", contentBase64: JPEG, phoneFileTime: ago(5), place: { latitude: -45.9, longitude: 170.5, accuracyM: 5, at: ago(5) } }));
    await as(worker)((tx) => addPondReading(tx, { farmId: w.home, pondId: w.pond, levelMm: "1850", files: [{ id: photo.id }] }));
    await as(worker)((tx) => addApplication(tx, { farmId: w.home, systemId: w.irrigator, paddockIds: [w.p1], startedAt: ago(30), stoppedAt: ago(27), depthEnteredMm: "30", ponding: { result: "none" }, positions: [{ paddockId: w.p1, point: [170.501, -45.901], movedAt: ago(30) }] }));
    await as(worker)((tx) => reportFault(tx, { farmId: w.home, systemId: w.irrigator, what: "Hose split" }, members));
    await as(worker)((tx) => addIncident(tx, { farmId: w.home, type: "spill", title: "Sump overflow", actions: [{ title: "Fix the float", assignedToUserId: worker.id }] }, members));
    // A safety record that must stay out of the council pack.
    await as(owner)((tx) => addHazard(tx, { farmId: w.home, title: "Bull in paddock 9", level: "high" }));
  });

  afterAll(async () => {
    await server?.teardown();
  });

  it("EF24 the pack holds the effluent records, the systems' checks and incident actions, and not other safety records", async () => {
    const pack = await as(owner)((tx) => loadCouncilPack(tx, { farmId: w.home, from: "2020-01-01", to: "2099-12-31" }));
    const kinds = new Set(pack.data.entries.map((entry) => entry.kind));
    for (const kind of ["effluent_consent", "effluent_pond", "effluent_system", "effluent_zone", "effluent_application", "effluent_pond_reading", "effluent_incident", "equipment", "checklist", "check", "action"]) expect(kinds.has(kind), kind).toBe(true);
    expect(kinds.has("hazard")).toBe(false);
    // The chain is the whole history, and each entry in the pack checks out against it.
    expect(verifyChain(pack.data.chain.map((link) => ({ ...link, kind: "", recordId: "", version: 1, change: "", farmId: null, restricted: false, happenedOn: null, enteredAt: "", enteredByUserId: null, enteredByEmail: "", via: null, operationId: null, body: null }))).problems).toEqual([]);
    expect(pack.data.chainOk).toBe(true);
    // The photo keeps its phone time and place.
    expect(pack.data.files.map((file) => [file.name, file.place?.accuracyM, Boolean(file.phoneFileTime)])).toEqual([["pond.jpg", 5, true]]);
  });

  it("EF25 the summary counts against the entered limits in neutral words, and the map draws the applied paddock", async () => {
    const pack = await as(owner)((tx) => loadCouncilPack(tx, { farmId: w.home, from: "2020-01-01", to: "2099-12-31" }));
    expect(pack.summary).toContain("Applications over the most depth entered (25 mm): 1");
    expect(pack.summary).toContain("Most rate: not entered for the consent, so not compared");
    expect(pack.summary.some((line) => line.startsWith("Pond readings: 1, from 1850 to 1850 mm"))).toBe(true);
    expect(pack.summary.join("\n")).toMatch(/Tohyee doesn't send this pack/);
    expect(pack.summary.join("\n")).not.toMatch(/\bcomplies with\b|\bcompliant\b|\bin breach\b/i);
    // Scope and corrections are said; positions and areas are estimates, never a finding (#491).
    expect(pack.summary[0]).toMatch(/^Scope: Home farm, effluent records entered or dated 2020-01-01 to 2099-12-31.*Corrections: \d+ corrected versions/);
    expect(pack.summary.join("\n")).toMatch(/recorded position \(phone GPS, an estimate\)/);
    expect(pack.summary.join("\n")).toMatch(/Sump overflow|Spill or overflow, reported, not yet checked/);
    expect(pack.svg).toContain("1 (1)");
    expect(pack.svg).toContain("Creek");
    const rendered = await renderCouncilPack(pack);
    expect(rendered.fileName).toMatch(/^effluent-records-home-farm-2020-01-01-to-2099-12-31\.zip$/);
    const zip = rendered.bytes.toString("latin1");
    for (const name of ["pack.pdf", "applied-areas.svg", "summary.txt", "entries.json", "chain.json", "files.json", "verify.mjs", "README.txt"]) expect(zip).toContain(name);
  });

  it("EF26 farm staff can't download the pack; the route serves it to an owner as a zip", async () => {
    await expect(as(worker)((tx) => loadCouncilPack(tx, { farmId: w.home, from: "2020-01-01", to: "2099-12-31" }))).rejects.toThrow(/council pack is for the people/);
    const handler = packRoute.GET as (request: Request, context: never) => Promise<Response>;
    const staff = await handler(apiRequest(`/api/farming/effluent/pack?organisationId=${ORG}&farmId=${w.home}&from=2020-01-01&to=2099-12-31`, { cookie: await sessionCookieFor(worker) }), {} as never);
    expect(staff.status).toBe(403);
    const response = await handler(apiRequest(`/api/farming/effluent/pack?organisationId=${ORG}&farmId=${w.home}&from=2020-01-01&to=2099-12-31`, { cookie: await sessionCookieFor(owner) }), {} as never);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/zip");
  });

  it("EF27 the weekly copy leaves effluent out unless the farm chooses it", async () => {
    const sent: Array<Omit<OutgoingMessage, "messageId">> = [];
    const accept = async (_organisation: unknown, message: Omit<OutgoingMessage, "messageId">) => {
      sent.push(message);
      return { messageId: `<copy-${sent.length}@example.com>`, response: "250 OK", rejected: [] };
    };
    await as(owner)((tx) => saveCopySettings(tx, { on: true, toAddresses: "accountant@example.com" }));
    expect((await as(owner)((tx) => copySettings(tx))).settings.includeEffluent).toBe(false);
    const organisation = (await getOrganisation(ORG))!;
    const first = await sendSafetyCopy(organisation, { force: true, send: accept });
    expect(sent[0].subject).toMatch(/^Farm safety records/);
    const safetyOnly = first.sent!.entries;
    await as(owner)((tx) => saveCopySettings(tx, { on: true, toAddresses: "accountant@example.com", includeEffluent: true }));
    // Saving again without saying keeps the choice.
    await as(owner)((tx) => saveCopySettings(tx, { on: true, toAddresses: "accountant@example.com" }));
    expect((await as(owner)((tx) => copySettings(tx))).settings.includeEffluent).toBe(true);
    await as(worker)((tx) => addPondReading(tx, { farmId: w.home, pondId: w.pond, levelMm: "1500" }));
    const second = await sendSafetyCopy(organisation, { force: true, send: accept });
    expect(sent[1].subject).toMatch(/^Farm safety and effluent records/);
    expect(sent[1].text).toMatch(/Farm safety and effluent records/);
    expect(second.sent!.entries).toBeGreaterThan(0);
    expect(safetyOnly).toBeGreaterThan(0);
  });

  it("EF28 a tanker run from a tractor mode job takes its paddocks, times and worked area", async () => {
    const jobId = "5f2c1a3e-8b7d-4e6f-9a1b-2c3d4e5f6a7b";
    await as(owner)((tx) =>
      tx.query(
        `insert into tractor_jobs (id, farm_id, paddock_ids, operation, operator_user_id, operator_email, started_at, finished_at, point_count, track, track_sha256, summary, coverage, worked_ha)
         values ($1, $2, $3, 'effluent', $4, $5, $6, $7, 0, '{}', $8, '{}', '{}', 2.35)`,
        [jobId, w.home, [w.p1], worker.id, worker.email, ago(6), ago(4), "0".repeat(64)],
      ),
    );
    const run = await as(worker)((tx) => addApplication(tx, { farmId: w.home, systemId: w.tanker, tractorJobId: jobId, loads: 4, ponding: { result: "none" } }));
    expect(run.data).toMatchObject({ tractorJobId: jobId, paddockIds: [w.p1], areaHa: "2.35", depthWorkedOut: { mm: "1.7" } });
    await expect(as(worker)((tx) => addApplication(tx, { farmId: w.home, systemId: w.irrigator, tractorJobId: jobId, ponding: { result: "none" } }))).rejects.toThrow(/Only a tanker or spreader/);
    await expect(as(worker)((tx) => addApplication(tx, { farmId: w.home, systemId: w.tanker, tractorJobId: "not-a-job", ponding: { result: "none" } }))).rejects.toThrow(/isn't on this farm/);
  });
});
