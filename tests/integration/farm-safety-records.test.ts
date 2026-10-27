import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import yauzl from "yauzl";
import { afterAll, beforeAll, expect, it } from "vitest";
import * as checkRoute from "@/app/api/farming/safety/check/route";
import * as hazardRoute from "@/app/api/farming/safety/hazards/[recordId]/route";
import * as hazardsRoute from "@/app/api/farming/safety/hazards/route";
import * as packRoute from "@/app/api/farming/safety/pack/route";
import * as overviewRoute from "@/app/api/farming/safety/route";
import type { SessionUser } from "@/lib/auth/sessions";
import type { OrgTx } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import { setMemberFarmAccess } from "@/lib/farming/access";
import { addPaddock, saveFarm, setFarmingEnabled } from "@/lib/farming/paddocks";
import { canonicalText, verifyChain } from "@/lib/safety/chain";
import { addHazard, changeHazard, getEmergency, listHazards, saveEmergency } from "@/lib/safety/hazards";
import { appendEntry, checkSafetyHistory, currentRecords, ENTRY_COLUMNS, type EntryRow, recordHistory, setRestrictedMember, toChainEntry } from "@/lib/safety/records";
import { apiRequest, createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, params, sessionCookieFor, startTestServer, type TestServer } from "../helpers/test-server";

const ORG = "farm-safety";

type Handler = (request: Request, context: never) => Promise<Response>;

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

function runVerify(files: Map<string, Buffer>): { ok: boolean; output: string } {
  const folder = mkdtempSync(join(tmpdir(), "safety-pack-"));
  try {
    for (const [name, data] of files) {
      mkdirSync(dirname(join(folder, name)), { recursive: true });
      writeFileSync(join(folder, name), data);
    }
    try {
      return { ok: true, output: execFileSync(process.execPath, [join(folder, "verify.mjs")], { encoding: "utf8" }) };
    } catch (error) {
      return { ok: false, output: String((error as { stdout?: string }).stdout ?? error) };
    }
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

/**
 * Farm safety records that stand up (#446; examples FS1-FS12 in
 * docs/FARM-SAFETY.md, decisions 930-941): dated by the database, versions
 * kept, nothing deleted, a hash chain that shows changes made straight in
 * the database, farm and restricted access, and the WorkSafe pack.
 */
describeWithDatabase("farm safety records", () => {
  let server: TestServer;
  let owner: SessionUser;
  let staff: SessionUser;
  let viewer: SessionUser;
  let lead: SessionUser;
  const as = (user: SessionUser) => <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(ORG, { userId: user.id, email: user.email }, work);
  const w = {} as Record<string, string>;

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("safety-owner@example.com", { serverAdmin: true, displayName: "Jess" });
    staff = await createTestUser("safety-staff@example.com", { displayName: "Mere" });
    viewer = await createTestUser("safety-viewer@example.com", { displayName: "Tama" });
    lead = await createTestUser("safety-lead@example.com", { displayName: "Aroha" });
    await createTestOrganisation(owner, ORG);
    for (const [user, role] of [[staff, "bookkeeper"], [viewer, "viewer"], [lead, "bookkeeper"]] as const) {
      await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, $3)", [ORG, user.id, role]);
    }
    const run = as(owner);
    await run((tx) => setFarmingEnabled(tx, { enabled: true }));
    w.home = (await run((tx) => saveFarm(tx, { name: "Home farm" })))[0].id;
    w.runoff = (await run((tx) => saveFarm(tx, { name: "Runoff" }))).find((farm) => farm.name === "Runoff")!.id;
    w.paddock = (await run((tx) => addPaddock(tx, { farmId: w.home, name: "Creek", effectiveHa: "8" }))).id;
    w.runoffPaddock = (await run((tx) => addPaddock(tx, { farmId: w.runoff, name: "Top", effectiveHa: "20" }))).id;
    await run((tx) => setMemberFarmAccess(tx, { userId: staff.id, role: "bookkeeper", access: "farms", farmIds: [w.home] }));
    await run((tx) => setMemberFarmAccess(tx, { userId: viewer.id, role: "viewer", access: "all" }));
    await run((tx) => setMemberFarmAccess(tx, { userId: lead.id, role: "bookkeeper", access: "all" }));
  });

  afterAll(async () => {
    await server?.teardown();
  });

  const call = async (user: SessionUser, handler: Handler, path: string, context: Record<string, string> = {}, method = "GET", body?: Record<string, unknown>) =>
    handler(
      apiRequest(method === "GET" ? `${path}${path.includes("?") ? "&" : "?"}organisationId=${ORG}` : path, { method, cookie: await sessionCookieFor(user), body: body ? { organisationId: ORG, ...body } : undefined }),
      params(context) as never,
    );

  it("FS1 the database dates every entry, whatever is sent, and a late entry keeps both dates", async () => {
    const hazard = await as(staff)((tx) => addHazard(tx, { farmId: w.home, title: "Steep creek bank", level: "high", noGo: true, paddockIds: [w.paddock], point: [175.1, -37.8], identifiedOn: "2026-09-01", reviewDue: "2026-12-01" }));
    w.hazard = hazard.recordId;
    expect(hazard.version).toBe(1);
    expect(hazard.happenedOn).toBe("2026-09-01");
    expect(hazard.enteredByEmail).toBe("safety-staff@example.com");
    const now = await as(owner)((tx) => tx.query<{ now: string }>("select now() as now"));
    expect(Math.abs(new Date(hazard.enteredAt).getTime() - new Date(now.rows[0].now).getTime())).toBeLessThan(60_000);
    // Sending an entry date straight to the database is ignored: the trigger sets it.
    const forced = await as(owner)(async (tx) => {
      const row = await tx.query<EntryRow>(
        `with added as (insert into safety_entries (seq, kind, record_id, version, change, farm_id, entered_at, entered_by_email, body, previous_hash, hash)
           values (99, 'hazard', gen_random_uuid(), 1, 'created', $1, '2020-01-01', 'x@example.com', '{"title":"Old"}', $2, $2) returning *)
         select ${ENTRY_COLUMNS} from added e`,
        [w.home, "f".repeat(64)],
      );
      return row.rows[0];
    });
    expect(forced.entered_at.startsWith("2020")).toBe(false);
    expect(forced.seq).not.toBe("99");
    expect(forced.previous_hash).not.toBe("f".repeat(64));
    w.forced = forced.record_id;
  });

  it("FS2 a change is a new version; the first stays as it was", async () => {
    const changed = await as(staff)((tx) => changeHazard(tx, w.hazard, { change: "updated", expectedVersion: 1, controls: "Fenced off; walk the top track" }));
    expect(changed.version).toBe(2);
    expect(changed.data.controls).toBe("Fenced off; walk the top track");
    expect(changed.data.title).toBe("Steep creek bank");
    const history = await as(owner)((tx) => recordHistory(tx, w.hazard));
    expect(history.map((version) => [version.version, version.change, version.data.controls ?? null])).toEqual([
      [1, "created", null],
      [2, "updated", "Fenced off; walk the top track"],
    ]);
  });

  it("FS3 nothing can be changed, deleted or truncated in the database", async () => {
    for (const sql of ["update safety_entries set body = '{}' where record_id = $1", "delete from safety_entries where record_id = $1"]) {
      await expect(as(owner)((tx) => tx.query(sql, [w.hazard]))).rejects.toThrow(/append-only/);
    }
    await expect(as(owner)((tx) => tx.query("truncate safety_entries"))).rejects.toThrow(/append-only/);
    await expect(as(owner)((tx) => tx.query("truncate safety_files"))).rejects.toThrow(/append-only/);
  });

  it("FS4 a correction or withdrawal says why; a withdrawn record can't change again", async () => {
    await expect(as(staff)((tx) => changeHazard(tx, w.hazard, { change: "corrected", expectedVersion: 2, level: "medium" }))).rejects.toThrow(/what was wrong/);
    const corrected = await as(staff)((tx) => changeHazard(tx, w.hazard, { change: "corrected", expectedVersion: 2, level: "medium", why: "Typed high by mistake" }));
    expect(corrected).toMatchObject({ version: 3, change: "corrected", data: { level: "medium", why: "Typed high by mistake" } });
    const wrong = await as(staff)((tx) => addHazard(tx, { farmId: w.home, title: "Wrong farm entry" }));
    await expect(as(staff)((tx) => changeHazard(tx, wrong.recordId, { change: "withdrawn", expectedVersion: 1 }))).rejects.toThrow(/why/);
    await as(staff)((tx) => changeHazard(tx, wrong.recordId, { change: "withdrawn", expectedVersion: 1, why: "Meant for the runoff" }));
    await expect(as(staff)((tx) => changeHazard(tx, wrong.recordId, { change: "updated", expectedVersion: 2, title: "Again" }))).rejects.toThrow(/withdrawn/);
    const shown = await as(staff)((tx) => listHazards(tx, w.home));
    expect(shown.map((hazard) => hazard.data.title)).not.toContain("Wrong farm entry");
    const all = await as(staff)((tx) => listHazards(tx, w.home, { includeWithdrawn: true }));
    expect(all.find((hazard) => hazard.recordId === wrong.recordId)?.change).toBe("withdrawn");
  });

  it("FS5 a change from an old version is refused, so nobody's change is lost", async () => {
    await expect(as(owner)((tx) => changeHazard(tx, w.hazard, { change: "updated", expectedVersion: 2, title: "Creek bank" }))).rejects.toThrow(/changed this record \(version 3\)/);
  });

  it("FS6 the same save sent twice (a phone retrying) is kept once", async () => {
    const send = () => as(staff)((tx) => addHazard(tx, { farmId: w.home, title: "Loose gate", operationId: "phone-op-000001" }));
    const first = await send();
    const second = await send();
    expect(second.seq).toBe(first.seq);
    await expect(as(staff)((tx) => addHazard(tx, { farmId: w.home, title: "Different", operationId: "phone-op-000001" }))).rejects.toThrow(/already sent with different details/);
  });

  it("FS9 a member sees and records only on their farms", async () => {
    await as(owner)((tx) => addHazard(tx, { farmId: w.runoff, title: "Old quarry", paddockIds: [w.runoffPaddock] }));
    await expect(as(staff)((tx) => listHazards(tx, w.runoff))).rejects.toThrow(/Farm not found/);
    await expect(as(staff)((tx) => addHazard(tx, { farmId: w.runoff, title: "Not mine" }))).rejects.toThrow(/Farm not found/);
    const runoffHazard = (await as(owner)((tx) => listHazards(tx, w.runoff)))[0];
    await expect(as(staff)((tx) => recordHistory(tx, runoffHazard.recordId))).rejects.toThrow(/wasn't found/);
    await expect(as(staff)((tx) => changeHazard(tx, runoffHazard.recordId, { change: "updated", expectedVersion: 1, title: "x" }))).rejects.toThrow(/wasn't found/);
    // A paddock on another farm can't be named.
    await expect(as(owner)((tx) => addHazard(tx, { farmId: w.home, title: "x", paddockIds: [w.runoffPaddock] }))).rejects.toThrow(/isn't on this farm/);
    const response = await call(staff, overviewRoute.GET as Handler, `/api/farming/safety?farmId=${w.runoff}`);
    expect(response.status).toBe(404);
  });

  it("an archived farm takes no new safety records", async () => {
    const archived = (await as(owner)((tx) => saveFarm(tx, { name: "Old block" }))).find((farm) => farm.name === "Old block")!.id;
    await as(owner)((tx) => saveFarm(tx, { id: archived, name: "Old block", isActive: false }));
    await expect(as(owner)((tx) => addHazard(tx, { farmId: archived, title: "Old dip" }))).rejects.toThrow(/archived/);
  });

  it("FS12 viewers read safety but don't record it", async () => {
    const read = await call(viewer, overviewRoute.GET as Handler, `/api/farming/safety?farmId=${w.home}`);
    expect(read.status).toBe(200);
    expect(((await read.json()) as { access: { canRecord: boolean } }).access.canRecord).toBe(false);
    const add = await call(viewer, hazardsRoute.POST as Handler, "/api/farming/safety/hazards", {}, "POST", { farmId: w.home, title: "x" });
    expect(add.status).toBe(403);
    const change = await call(viewer, hazardRoute.POST as Handler, `/api/farming/safety/hazards/${w.hazard}`, { recordId: w.hazard }, "POST", { change: "updated", expectedVersion: 3, title: "x" });
    expect(change.status).toBe(403);
  });

  it("FS10 restricted details: owners, members an owner names, and whoever entered them", async () => {
    const details = await as(staff)((tx) => appendEntry(tx, { kind: "report_details", change: "created", farmId: w.home, data: { injury: "Cut hand", treatment: "Stitches at the medical centre" } }));
    await expect(as(lead)((tx) => currentRecords(tx, "report_details", { farmId: w.home }))).resolves.toEqual([]);
    await expect(as(lead)((tx) => recordHistory(tx, details.recordId))).rejects.toThrow(/wasn't found/);
    expect((await as(staff)((tx) => currentRecords(tx, "report_details", { farmId: w.home }))).length).toBe(1);
    expect((await as(owner)((tx) => currentRecords(tx, "report_details", { farmId: w.home }))).length).toBe(1);
    await expect(as(lead)((tx) => setRestrictedMember(tx, { userId: lead.id, allowed: true }))).rejects.toThrow(/Only an owner/);
    await as(owner)((tx) => setRestrictedMember(tx, { userId: lead.id, allowed: true }));
    expect((await as(lead)((tx) => currentRecords(tx, "report_details", { farmId: w.home }))).length).toBe(1);
    await as(owner)((tx) => setRestrictedMember(tx, { userId: lead.id, allowed: false }));
    await expect(as(lead)((tx) => currentRecords(tx, "report_details", { farmId: w.home }))).resolves.toEqual([]);
    w.details = details.recordId;
  });

  it("emergency details: one record per farm, saved as versions", async () => {
    expect(await as(staff)((tx) => getEmergency(tx, w.home))).toBeNull();
    const first = await as(staff)((tx) => saveEmergency(tx, { farmId: w.home, address: "12 Example Road", assemblyPoint: "Cowshed yard", contacts: [{ name: "Jess", role: "Owner", phone: "021 000 0000" }], firstAiders: ["Mere"], equipment: [{ what: "First aid kit", where: "Dairy office" }] }));
    await expect(as(staff)((tx) => saveEmergency(tx, { farmId: w.home, address: "12 Example Road", expectedVersion: 0 }))).rejects.toThrow(/changed this record/);
    const second = await as(staff)((tx) => saveEmergency(tx, { farmId: w.home, address: "12 Example Road", assemblyPoint: "Tanker stand", expectedVersion: first.version }));
    expect(second.recordId).toBe(first.recordId);
    expect((await as(staff)((tx) => getEmergency(tx, w.home)))?.data.assemblyPoint).toBe("Tanker stand");
    await expect(as(staff)((tx) => saveEmergency(tx, { farmId: w.home, contacts: [{ name: "X", phone: "call me" }] }))).rejects.toThrow(/phone/);
  });

  it("FS7 a change made straight in the database, past its rules, shows when the history is checked", async () => {
    const clean = await as(viewer)((tx) => checkSafetyHistory(tx));
    expect(clean.problems).toEqual([]);
    expect(clean.checked).toBe(clean.total);
    // The database's hash and Tohyee's own working-out agree, entry by entry.
    const rows = await as(owner)((tx) => tx.query<EntryRow>(`select ${ENTRY_COLUMNS} from safety_entries e order by e.seq`));
    expect(verifyChain(rows.rows.map((row) => toChainEntry(row))).problems).toEqual([]);
    expect(canonicalText(toChainEntry(rows.rows[0]) as never).split("\n")[0]).toBe("tohyee-safety-entry-v1");

    // Someone with full database access turns the rules off and edits a hazard.
    const target = rows.rows.find((row) => row.record_id === w.hazard && row.version === 1)!;
    await as(owner)(async (tx) => {
      await tx.query("alter table safety_entries disable trigger user");
      await tx.query("update safety_entries set body = replace(body, 'Steep creek bank', 'Creek bank') where seq = $1", [target.seq]);
      await tx.query("alter table safety_entries enable trigger user");
    });
    const tampered = await as(viewer)((tx) => checkSafetyHistory(tx));
    expect(tampered.problemsAt).toEqual([{ seq: target.seq, kind: "hazard", problem: "hash" }]);
    const response = await call(viewer, checkRoute.GET as Handler, "/api/farming/safety/check");
    expect(((await response.json()) as { report: { problems: unknown[] } }).report.problems.length).toBe(1);
  });

  it("FS7 an entry removed straight from the database shows as missing", async () => {
    const rows = await as(owner)((tx) => tx.query<{ seq: string }>("select seq::text from safety_entries order by safety_entries.seq"));
    const middle = rows.rows[3].seq;
    await as(owner)(async (tx) => {
      await tx.query("alter table safety_entries disable trigger user");
      await tx.query("delete from safety_entries where seq = $1", [middle]);
      await tx.query("alter table safety_entries enable trigger user");
    });
    const report = await as(viewer)((tx) => checkSafetyHistory(tx));
    const next = String(Number(middle) + 1);
    expect(report.problemsAt).toEqual(expect.arrayContaining([{ seq: next, kind: expect.any(String), problem: "missing" }, { seq: next, kind: expect.any(String), problem: "link" }]));
  });

  it("FS8 a copy kept off the farm shows whether an earlier entry was rewritten", async () => {
    const report = await as(viewer)((tx) => checkSafetyHistory(tx, { seq: "1", hash: "a".repeat(64) }));
    expect(report.copy).toBe("different");
    const head = report.head!;
    expect((await as(viewer)((tx) => checkSafetyHistory(tx, head))).copy).toBe("found");
    expect((await as(viewer)((tx) => checkSafetyHistory(tx, { seq: "9999", hash: head.hash }))).copy).toBe("missing");
    await expect(as(viewer)((tx) => checkSafetyHistory(tx, { seq: "x", hash: "y" }))).rejects.toThrow(/entry number/);
  });
});

/** The WorkSafe pack on a clean history (FS11): in its own organisation, so FS7's tampering isn't in it. */
describeWithDatabase("farm safety WorkSafe pack", () => {
  let server: TestServer;
  let owner: SessionUser;
  let staff: SessionUser;
  const PACK_ORG = "farm-safety-pack";
  const as = (user: SessionUser) => <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(PACK_ORG, { userId: user.id, email: user.email }, work);
  const w = {} as Record<string, string>;

  beforeAll(async () => {
    server = await startTestServer();
    owner = await createTestUser("pack-owner@example.com", { serverAdmin: true, displayName: "Jess" });
    staff = await createTestUser("pack-staff@example.com", { displayName: "Mere" });
    await createTestOrganisation(owner, PACK_ORG);
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'bookkeeper')", [PACK_ORG, staff.id]);
    await as(owner)((tx) => setFarmingEnabled(tx, { enabled: true }));
    w.home = (await as(owner)((tx) => saveFarm(tx, { name: "Home farm" })))[0].id;
    const hazard = await as(owner)((tx) => addHazard(tx, { farmId: w.home, title: "Effluent pond", level: "high", noGo: true }));
    await as(owner)((tx) => changeHazard(tx, hazard.recordId, { change: "updated", expectedVersion: 1, controls: "Fenced, sign on gate" }));
    await as(owner)((tx) => appendEntry(tx, { kind: "report_details", change: "created", farmId: w.home, data: { injury: "Sprained ankle" } }));
  });

  afterAll(async () => {
    await server?.teardown();
  });

  const download = async (user: SessionUser) => {
    const today = new Date().toISOString().slice(0, 10);
    const response = await packRoute.GET(apiRequest(`/api/farming/safety/pack?organisationId=${PACK_ORG}&farmId=${w.home}&from=2026-01-01&to=${today > "2026-12-31" ? today : "2026-12-31"}`, { cookie: await sessionCookieFor(user) }), params({}) as never);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/zip");
    return unzip(Buffer.from(await response.arrayBuffer()));
  };

  it("FS11 has every version, the whole chain and a checker that passes", async () => {
    const files = await download(owner);
    expect([...files.keys()].sort()).toEqual(["README.txt", "chain.json", "entries.json", "files.json", "pack.pdf", "verify.mjs"]);
    const entries = JSON.parse(files.get("entries.json")!.toString()) as Array<{ version: number; body: string | null }>;
    expect(entries.length).toBe(3);
    expect(entries.every((entry) => entry.body !== null)).toBe(true);
    expect(files.get("pack.pdf")!.subarray(0, 5).toString()).toBe("%PDF-");
    const result = runVerify(files);
    expect(result.output).toContain("Everything in this pack checks out.");
    expect(result.ok).toBe(true);
  });

  it("FS11 the checker finds an edited pack", async () => {
    const files = await download(owner);
    files.set("entries.json", Buffer.from(files.get("entries.json")!.toString().replace("Effluent pond", "Pond")));
    const result = runVerify(files);
    expect(result.ok).toBe(false);
    expect(result.output).toContain("don't match its hash");
  });

  it("FS11 restricted details are withheld from someone who can't see them, and the rest still checks", async () => {
    const files = await download(staff);
    const entries = JSON.parse(files.get("entries.json")!.toString()) as Array<{ kind: string; body: string | null }>;
    expect(entries.find((entry) => entry.kind === "report_details")?.body).toBeNull();
    expect(files.get("README.txt")!.toString()).toContain("withheld");
    const result = runVerify(files);
    expect(result.ok).toBe(true);
    expect(result.output).toContain("1 restricted, withheld");
  });
});
