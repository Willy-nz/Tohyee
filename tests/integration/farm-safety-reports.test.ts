import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import yauzl from "yauzl";
import { afterAll, beforeAll, expect, it } from "vitest";
import * as fileRoute from "@/app/api/farming/safety/files/[fileId]/route";
import * as reportsRoute from "@/app/api/farming/safety/reports/route";
import type { SessionUser } from "@/lib/auth/sessions";
import type { OrgTx } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import { setMemberFarmAccess } from "@/lib/farming/access";
import { addPaddock, saveFarm, setFarmingEnabled } from "@/lib/farming/paddocks";
import { readSafetyFile, uploadSafetyFile } from "@/lib/safety/files";
import { loadPackData, renderPack } from "@/lib/safety/pack";
import { addAction, addReport, changeAction, changeReport, listReports, openActions, saveReportDetails } from "@/lib/safety/reports";
import { checkSafetyHistory } from "@/lib/safety/records";
import { apiRequest, createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, params, sessionCookieFor, startTestServer, type TestServer } from "../helpers/test-server";

const ORG = "farm-safety-reports";

/** A tiny JPEG with the camera's date in it (EXIF DateTimeOriginal 2026:10:27 07:45:00). */
function photo(): Buffer {
  const date = "2026:10:27 07:45:00";
  const tiff = [0x49, 0x49, 42, 0, 8, 0, 0, 0, 1, 0, 0x69, 0x87, 4, 0, 1, 0, 0, 0, 26, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0x03, 0x90, 2, 0, 20, 0, 0, 0, 44, 0, 0, 0, 0, 0, 0, 0, ...[...date].map((c) => c.charCodeAt(0)), 0];
  const app1 = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff];
  return Buffer.from([0xff, 0xd8, 0xff, 0xe1, (app1.length + 2) >> 8, (app1.length + 2) & 0xff, ...app1, 0xff, 0xd9]);
}

async function unzip(bytes: Buffer): Promise<Map<string, Buffer>> {
  const zip = await new Promise<yauzl.ZipFile>((resolve, reject) => yauzl.fromBuffer(bytes, { lazyEntries: true }, (error, file) => (error ? reject(error) : resolve(file!))));
  const files = new Map<string, Buffer>();
  await new Promise<void>((resolve, reject) => {
    zip.on("entry", (entry: yauzl.Entry) => {
      zip.openReadStream(entry, (error, stream) => {
        if (error) return reject(error);
        const parts: Buffer[] = [];
        stream!.on("data", (part: Buffer) => parts.push(part));
        stream!.on("end", () => {
          files.set(entry.fileName, Buffer.concat(parts));
          zip.readEntry();
        });
      });
    });
    zip.on("end", resolve);
    zip.on("error", reject);
    zip.readEntry();
  });
  return files;
}

/**
 * Hazards spotted, near misses and incidents (#446; FS13-FS20 in
 * docs/FARM-SAFETY.md, decisions 942-947): restricted details kept apart,
 * WorkSafe's questions prompting (never notifying), photos with their own
 * dates and hashes, and corrective actions through to a checked close.
 */
describeWithDatabase("farm safety reports and actions", () => {
  let server: TestServer;
  let owner: SessionUser;
  let staff: SessionUser;
  let lead: SessionUser;
  const as = (user: SessionUser, via?: string) => <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(ORG, { userId: user.id, email: user.email, via }, work);
  const w = {} as Record<string, string>;
  let members: Map<string, string>;

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("reports-owner@example.com", { serverAdmin: true, displayName: "Jess" });
    staff = await createTestUser("reports-staff@example.com", { displayName: "Mere" });
    lead = await createTestUser("reports-lead@example.com", { displayName: "Aroha" });
    await createTestOrganisation(owner, ORG);
    for (const user of [staff, lead]) await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'bookkeeper')", [ORG, user.id]);
    members = new Map([[owner.id, "Jess"], [staff.id, "Mere"], [lead.id, "Aroha"]]);
    await as(owner)((tx) => setFarmingEnabled(tx, { enabled: true }));
    w.home = (await as(owner)((tx) => saveFarm(tx, { name: "Home farm" })))[0].id;
    w.runoff = (await as(owner)((tx) => saveFarm(tx, { name: "Runoff" }))).find((farm) => farm.name === "Runoff")!.id;
    w.paddock = (await as(owner)((tx) => addPaddock(tx, { farmId: w.home, name: "Shed", effectiveHa: "2" }))).id;
    await as(owner)((tx) => setMemberFarmAccess(tx, { userId: staff.id, role: "bookkeeper", access: "farms", farmIds: [w.home] }));
    await as(owner)((tx) => setMemberFarmAccess(tx, { userId: lead.id, role: "bookkeeper", access: "all" }));
  });

  afterAll(async () => {
    await server?.teardown();
  });

  it("FS15 a photo keeps the camera's date and its hash; a file that isn't what it says is refused", async () => {
    const file = await as(staff)((tx) => uploadSafetyFile(tx, { farmId: w.home, fileName: "gate.jpg", contentType: "image/jpeg", contentBase64: photo().toString("base64"), phoneFileTime: "2026-10-27T07:45:30+13:00" }));
    expect(file.photoTaken).toBe("2026-10-27 07:45:00");
    expect(file.phoneFileTime).toBe("2026-10-26T18:45:30.000Z");
    expect(file.sha256).toMatch(/^[0-9a-f]{64}$/);
    const read = await as(lead)((tx) => readSafetyFile(tx, file.id));
    expect(read.content.equals(photo())).toBe(true);
    await expect(as(staff)((tx) => uploadSafetyFile(tx, { farmId: w.home, fileName: "x.jpg", contentType: "image/jpeg", contentBase64: Buffer.from("<script>").toString("base64") }))).rejects.toThrow(/isn't the kind/);
    await expect(as(staff)((tx) => uploadSafetyFile(tx, { farmId: w.home, fileName: "x.svg", contentType: "image/svg+xml", contentBase64: "PHN2Zz4=" }))).rejects.toThrow(/JPEG, PNG or WebP/);
    await expect(as(staff)((tx) => uploadSafetyFile(tx, { farmId: w.runoff, fileName: "x.jpg", contentType: "image/jpeg", contentBase64: photo().toString("base64") }))).rejects.toThrow(/Farm not found/);
    w.photo = file.id;
  });

  it("FS13 an incident's injury details are kept apart and restricted", async () => {
    const injuryPhoto = await as(staff)((tx) => uploadSafetyFile(tx, { farmId: w.home, fileName: "hand.jpg", contentType: "image/jpeg", contentBase64: photo().toString("base64"), restricted: true }));
    const result = await as(staff)((tx) =>
      addReport(tx, {
        farmId: w.home,
        type: "incident",
        title: "Hand caught in the gate latch",
        whatHappened: "Closing the yard gate, the latch swung back.",
        paddockIds: [w.paddock],
        time: "07:40",
        immediateAction: "First aid; gate tied open",
        severity: "moderate",
        injured: true,
        notifiable: { hospital: false, seriousInjury: false },
        files: [{ id: w.photo }],
        details: { injuredPerson: "Mere", injury: "Cut to the left hand", treatment: "Stitches at the medical centre", files: [{ id: injuryPhoto.id }] },
        operationId: "phone-report-0001",
      }),
    );
    w.report = result.report.recordId;
    expect(result.mayBeNotifiable).toBe(false);
    expect(result.details?.data).toMatchObject({ reportId: w.report, injury: "Cut to the left hand" });
    expect(result.report.data.files).toEqual([{ id: w.photo, name: "gate.jpg", sha256: expect.stringMatching(/^[0-9a-f]{64}$/) }]);
    // The farm team (Aroha) sees the report, not the details or the restricted photo.
    const [seen] = await as(lead)((tx) => listReports(tx, w.home));
    expect(seen).toMatchObject({ recordId: w.report, details: null, detailsHidden: true });
    expect(seen.files.map((file) => file.id)).toEqual([w.photo]);
    await expect(as(lead)((tx) => readSafetyFile(tx, injuryPhoto.id))).rejects.toThrow(/wasn't found/);
    // Mere (who entered them) and the owner do.
    expect((await as(staff)((tx) => listReports(tx, w.home)))[0].details?.data.treatment).toBe("Stitches at the medical centre");
    expect((await as(owner)((tx) => listReports(tx, w.home)))[0].files.length).toBe(2);
    // A restricted photo can't go on the open report, nor an open one in the details.
    await expect(as(staff)((tx) => addReport(tx, { farmId: w.home, type: "near_miss", title: "x", files: [{ id: injuryPhoto.id }] }))).rejects.toThrow(/restricted/);
    // Aroha can't add details to it either (she can't see them).
    await expect(as(lead)((tx) => saveReportDetails(tx, w.report, { injury: "x" }))).rejects.toThrow(/wasn't found/);
  });

  it("FS17 a report sent twice from a phone is kept once, with one set of details", async () => {
    const again = await as(staff)((tx) =>
      addReport(tx, {
        farmId: w.home,
        type: "incident",
        title: "Hand caught in the gate latch",
        whatHappened: "Closing the yard gate, the latch swung back.",
        paddockIds: [w.paddock],
        time: "07:40",
        immediateAction: "First aid; gate tied open",
        severity: "moderate",
        injured: true,
        notifiable: { hospital: false, seriousInjury: false },
        files: [{ id: w.photo }],
        details: { injuredPerson: "Mere", injury: "Cut to the left hand" },
        operationId: "phone-report-0001",
      }),
    );
    expect(again.report.recordId).toBe(w.report);
    const count = await as(owner)((tx) => tx.query("select 1 from safety_entries where kind = 'report_details'"));
    expect(count.rowCount).toBe(1);
  });

  it("FS14 WorkSafe's questions prompt; a person records telling WorkSafe", async () => {
    const result = await as(staff)((tx) => addReport(tx, { farmId: w.home, type: "near_miss", title: "Tractor rolled on the race", severity: "serious", notifiable: { dangerousIncident: true }, happenedOn: "2026-10-20" }));
    expect(result.mayBeNotifiable).toBe(true);
    expect(result.report.happenedOn).toBe("2026-10-20");
    w.nearMiss = result.report.recordId;
    await expect(as(staff)((tx) => changeReport(tx, w.nearMiss, { step: "worksafe", expectedVersion: 1, on: "2026-10-20" }))).rejects.toThrow(/phone or online/);
    await expect(as(staff)((tx) => changeReport(tx, w.nearMiss, { step: "worksafe", expectedVersion: 1, on: "2099-01-01", how: "phone" }))).rejects.toThrow(/after today/);
    const told = await as(staff)((tx) => changeReport(tx, w.nearMiss, { step: "worksafe", expectedVersion: 1, on: "2026-10-20", how: "phone", reference: "WS-123" }));
    expect(told.data.workSafeNotified).toEqual({ on: "2026-10-20", how: "phone", reference: "WS-123" });
    await expect(as(staff)((tx) => addReport(tx, { farmId: w.home, type: "incident", title: "Tomorrow", happenedOn: "2099-01-01" }))).rejects.toThrow(/after today/);
  });

  it("FS16 actions go through done and checked before a report closes; an AI or app can't close them", async () => {
    await expect(as(staff)((tx) => addAction(tx, { reportId: w.report, title: "Fit a latch guard" }, members))).rejects.toThrow(/who's responsible/);
    await expect(as(staff)((tx) => addAction(tx, { reportId: w.report, title: "x", assignedToUserId: "00000000-0000-4000-8000-000000000000" }, members))).rejects.toThrow(/isn't a member/);
    const action = await as(staff)((tx) => addAction(tx, { reportId: w.report, title: "Fit a latch guard", assignedToUserId: staff.id, due: "2026-10-01" }, members));
    expect((await as(staff)((tx) => openActions(tx, { mine: true }))).map((each) => [each.recordId, each.state])).toEqual([[action.recordId, "overdue"]]);
    expect(await as(lead)((tx) => openActions(tx, { mine: true }))).toEqual([]);
    await expect(as(staff)((tx) => changeReport(tx, w.report, { step: "close", expectedVersion: 1, why: "Done" }))).rejects.toThrow(/still to be checked/);
    await expect(as(staff)((tx) => changeAction(tx, action.recordId, { step: "verify", expectedVersion: 1 }, members))).rejects.toThrow(/Mark it done/);
    await expect(as(staff, 'AI key "Phone"')((tx) => changeAction(tx, action.recordId, { step: "done", expectedVersion: 1, note: "Fitted" }, members))).rejects.toThrow(/not an AI or app/);
    const done = await as(staff)((tx) => changeAction(tx, action.recordId, { step: "done", expectedVersion: 1, note: "Guard fitted", files: [{ id: w.photo }] }, members));
    expect((await as(staff)((tx) => openActions(tx, { mine: true })))[0].state).toBe("done");
    await expect(as(lead, "farm app")((tx) => changeAction(tx, action.recordId, { step: "verify", expectedVersion: done.version }, members))).rejects.toThrow(/not an AI or app/);
    const checked = await as(lead)((tx) => changeAction(tx, action.recordId, { step: "verify", expectedVersion: done.version, note: "Looked at it: works" }, members));
    expect(checked.data.verified).toEqual({ note: "Looked at it: works" });
    await expect(as(lead)((tx) => changeAction(tx, action.recordId, { step: "update", expectedVersion: checked.version, title: "x" }, members))).rejects.toThrow(/Reopen it/);
    expect(await as(staff)((tx) => openActions(tx, { mine: true }))).toEqual([]);
    await expect(as(staff, "farm app")((tx) => changeReport(tx, w.report, { step: "close", expectedVersion: 1, why: "Guard on" }))).rejects.toThrow(/not an AI or app/);
    await expect(as(staff)((tx) => changeReport(tx, w.report, { step: "close", expectedVersion: 1 }))).rejects.toThrow(/why it's closed/);
    const closed = await as(staff)((tx) => changeReport(tx, w.report, { step: "close", expectedVersion: 1, why: "Guard fitted and checked" }));
    expect(closed.data.closed).toEqual({ why: "Guard fitted and checked" });
    const [view] = (await as(owner)((tx) => listReports(tx, w.home))).filter((report) => report.recordId === w.report);
    expect(view.state).toBe("closed");
    await expect(as(staff)((tx) => addAction(tx, { reportId: w.report, title: "More", assignedToName: "Contractor" }, members))).rejects.toThrow(/closed or withdrawn/);
  });

  it("FS18 another farm's reports aren't found", async () => {
    const runoff = await as(owner)((tx) => addReport(tx, { farmId: w.runoff, type: "hazard", title: "Washout on the track" }));
    await expect(as(staff)((tx) => listReports(tx, w.runoff))).rejects.toThrow(/Farm not found/);
    await expect(as(staff)((tx) => changeReport(tx, runoff.report.recordId, { step: "update", expectedVersion: 1, title: "x" }))).rejects.toThrow(/wasn't found/);
    await expect(as(staff)((tx) => addAction(tx, { reportId: runoff.report.recordId, title: "x", assignedToName: "x" }, members))).rejects.toThrow(/wasn't found/);
    const response = await reportsRoute.GET(apiRequest(`/api/farming/safety/reports?organisationId=${ORG}&farmId=${w.runoff}`, { cookie: await sessionCookieFor(staff) }), params({}) as never);
    expect(response.status).toBe(404);
    const file = await fileRoute.GET(apiRequest(`/api/farming/safety/files/${w.photo}?organisationId=${ORG}`, { cookie: await sessionCookieFor(lead) }), params({ fileId: w.photo }) as never);
    expect(file.status).toBe(200);
    expect(file.headers.get("content-type")).toBe("image/jpeg");
    expect(file.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("FS20 the pack carries the photos and checks them; restricted ones only for those allowed", async () => {
    const packFor = async (user: SessionUser) => unzip((await renderPack(await as(user)((tx) => loadPackData(tx, { farmId: w.home, from: "2026-01-01", to: "2099-12-31" })))).bytes);
    const verify = (files: Map<string, Buffer>) => {
      const folder = mkdtempSync(join(tmpdir(), "safety-pack-"));
      try {
        for (const [name, data] of files) {
          mkdirSync(dirname(join(folder, name)), { recursive: true });
          writeFileSync(join(folder, name), data);
        }
        return execFileSync(process.execPath, [join(folder, "verify.mjs")], { encoding: "utf8" });
      } finally {
        rmSync(folder, { recursive: true, force: true });
      }
    };
    const ownerPack = await packFor(owner);
    expect([...ownerPack.keys()].filter((name) => name.startsWith("files/")).length).toBe(2);
    expect(verify(ownerPack)).toContain("Files checked: 2");
    const leadPack = await packFor(lead);
    expect([...leadPack.keys()].filter((name) => name.startsWith("files/")).length).toBe(1);
    expect(verify(leadPack)).toContain("Everything in this pack checks out.");
    expect((await as(owner)((tx) => checkSafetyHistory(tx))).problems).toEqual([]);
  });
});
