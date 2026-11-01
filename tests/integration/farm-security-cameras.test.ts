import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { Client } from "basic-ftp";
import { afterAll, beforeAll, expect, it } from "vitest";
import * as accessRoute from "@/app/api/farming/security/access/route";
import * as camerasRoute from "@/app/api/farming/security/cameras/route";
import * as cameraRoute from "@/app/api/farming/security/cameras/[cameraId]/route";
import * as uploadLoginRoute from "@/app/api/farming/security/cameras/[cameraId]/upload-login/route";
import * as eventsRoute from "@/app/api/farming/security/events/route";
import * as eventRoute from "@/app/api/farming/security/events/[eventId]/route";
import * as keepRoute from "@/app/api/farming/security/events/[eventId]/keep/route";
import * as mediaRoute from "@/app/api/farming/security/events/[eventId]/media/route";
import * as settingsRoute from "@/app/api/farming/security/settings/route";
import type { SessionUser } from "@/lib/auth/sessions";
import { coreQuery } from "@/lib/db/transactions";
import type { OrgTx } from "@/lib/db/org-transaction";
import { setMemberFarmAccess } from "@/lib/farming/access";
import { saveFarm, setFarmingEnabled } from "@/lib/farming/paddocks";
import { expireEvents } from "@/lib/security-cameras/events";
import { type CameraReceiver, startCameraReceiver } from "@/lib/security-cameras/ftp-receiver";
import { authenticateCamera, ingestUpload, type Uploader } from "@/lib/security-cameras/ingest";
import type { SecurityEvent } from "@/lib/security-cameras/shared";
import { incomingFolder, removeStored, resolveStored } from "@/lib/security-cameras/storage";
import { apiRequest, createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, params, sessionCookieFor, startTestServer, type TestServer } from "../helpers/test-server";

const ORG = "farm-security";
const OTHER = "farm-security-other";

type Handler = (request: Request, context: never) => Promise<Response>;

/*
 * Farm security cameras (#508, decisions 1216-1225): upload logins, the
 * FTP(S) receiver taking files from a stand-in camera (basic-ftp, not a
 * Reolink camera: none was available), type checks, duplicates, permissions
 * on every route and media URL, keeping, deleting and the retention
 * clean-up. Made-up people, farms and pictures.
 */
describeWithDatabase("farm security cameras", () => {
  let server: TestServer;
  let owner: SessionUser;
  let staff: SessionUser;
  let viewer: SessionUser;
  let bookkeeper: SessionUser;
  let salesRep: SessionUser;
  let outsider: SessionUser;
  let receiver: CameraReceiver;
  let plainReceiver: CameraReceiver;
  let mediaDir: string;
  let certDir: string;
  const w = {} as Record<string, string>;
  const login = {} as Record<string, { username: string; password: string }>;
  const as = (user: SessionUser) => <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(ORG, { userId: user.id, email: user.email }, work);
  let jpeg: Buffer;
  let jpeg2: Buffer;
  // An MP4's opening box ("ftyp", brand isom) and some made-up bytes: enough for the type check, not a playable clip.
  const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypisom"), Buffer.from([0, 0, 2, 0]), Buffer.from("isomiso2"), Buffer.alloc(4000, 7)]);

  beforeAll(async () => {
    mediaDir = mkdtempSync(path.join(tmpdir(), "tohyee-camera-media-"));
    process.env.TOHYEE_CAMERA_MEDIA_DIR = mediaDir;
    const sharp = (await import("sharp")).default;
    jpeg = await sharp({ create: { width: 64, height: 48, channels: 3, background: "#4a7" } }).jpeg().toBuffer();
    jpeg2 = await sharp({ create: { width: 64, height: 48, channels: 3, background: "#a47" } }).jpeg().toBuffer();
    certDir = mkdtempSync(path.join(tmpdir(), "tohyee-camera-cert-"));
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost", "-keyout", path.join(certDir, "key.pem"), "-out", path.join(certDir, "cert.pem")], { stdio: "ignore" });

    server = await startTestServer();
    owner = await createTestUser("sec-owner@example.com", { serverAdmin: true, displayName: "Jess Kelly" });
    staff = await createTestUser("sec-staff@example.com", { displayName: "Mere Tane" });
    viewer = await createTestUser("sec-viewer@example.com", { displayName: "Tama Rua" });
    bookkeeper = await createTestUser("sec-books@example.com", { displayName: "Aroha" });
    salesRep = await createTestUser("sec-sales@example.com", { displayName: "Hemi" });
    outsider = await createTestUser("sec-outsider@example.com", { displayName: "Rangi" });
    await createTestOrganisation(owner, ORG);
    await createTestOrganisation(outsider, OTHER);
    for (const [user, role] of [[staff, "farm_worker"], [viewer, "viewer"], [bookkeeper, "bookkeeper"], [salesRep, "sales_rep"]] as const) {
      await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, $3)", [ORG, user.id, role]);
    }
    const run = as(owner);
    await run((tx) => setFarmingEnabled(tx, { enabled: true }));
    w.home = (await run((tx) => saveFarm(tx, { name: "Home farm" })))[0].id;
    w.runoff = (await run((tx) => saveFarm(tx, { name: "Runoff" }))).find((farm) => farm.name === "Runoff")!.id;
    for (const user of [staff, viewer, bookkeeper]) await run((tx) => setMemberFarmAccess(tx, { userId: user.id, role: user === staff ? "farm_worker" : user === viewer ? "viewer" : "bookkeeper", access: "farms", farmIds: [w.home] }));
    await inOrganisation(OTHER, { userId: outsider.id, email: outsider.email }, (tx) => setFarmingEnabled(tx, { enabled: true }));

    const common = {
      host: "127.0.0.1",
      port: 0,
      publicAddress: null,
      maxFileBytes: 200 * 1024,
      incomingFolder: incomingFolder(),
      authenticate: (username: string, password: string) => authenticateCamera(username, password),
      receive: async (uploader: Uploader, file: Parameters<typeof ingestUpload>[1]) => (await ingestUpload(uploader, file)).status,
      failedLoginDelayMs: 10,
      log: (message: string) => console.log(message),
    };
    receiver = await startCameraReceiver({ ...common, tls: { key: execFileSync("cat", [path.join(certDir, "key.pem")]), cert: execFileSync("cat", [path.join(certDir, "cert.pem")]) }, allowPlain: false, passivePorts: [46310, 46329] });
    plainReceiver = await startCameraReceiver({ ...common, tls: null, allowPlain: true, passivePorts: [46330, 46349] });
  });

  afterAll(async () => {
    await receiver?.close();
    await plainReceiver?.close();
    await server?.teardown();
    rmSync(mediaDir, { recursive: true, force: true });
    rmSync(certDir, { recursive: true, force: true });
    delete process.env.TOHYEE_CAMERA_MEDIA_DIR;
  });

  const call = async (user: SessionUser, handler: Handler, pathName: string, context: Record<string, string> = {}, method = "GET", body?: Record<string, unknown>, query = "", organisationId = ORG) =>
    handler(
      apiRequest(method === "GET" || method === "DELETE" ? `${pathName}?organisationId=${organisationId}${query}` : pathName, {
        method,
        cookie: await sessionCookieFor(user),
        body: body ? { organisationId, ...body } : undefined,
      }),
      params(context) as never,
    );
  const events = async (user: SessionUser, query = "") => call(user, eventsRoute.GET as Handler, "/api/farming/security/events", {}, "GET", undefined, query);
  const media = (user: SessionUser, eventId: string, query = "", organisationId = ORG) => call(user, mediaRoute.GET as Handler, `/api/farming/security/events/${eventId}/media`, { eventId }, "GET", undefined, query, organisationId);
  const grant = (userId: string, level: string) => call(owner, accessRoute.PUT as Handler, "/api/farming/security/access", {}, "PUT", { userId, level });

  async function upload(target: CameraReceiver, credentials: { username: string; password: string }, files: Array<{ name: string; bytes: Buffer }>, secure = true): Promise<string[]> {
    const client = new Client(5000);
    const results: string[] = [];
    try {
      await client.access({ host: "127.0.0.1", port: target.port, user: credentials.username, password: credentials.password, secure, secureOptions: { rejectUnauthorized: false } });
      await client.ensureDir("farm/gate");
      for (const file of files) {
        try {
          results.push(String((await client.uploadFrom(Readable.from(file.bytes), file.name)).code));
        } catch (error) {
          results.push(String((error as { code?: number }).code ?? (error as Error).message));
        }
      }
    } finally {
      client.close();
    }
    return results;
  }

  it("cameras are set up by owners and admins only, with a login made by Tohyee and shown once", async () => {
    const added = await call(owner, camerasRoute.POST as Handler, "/api/farming/security/cameras", {}, "POST", { farmId: w.home, name: "Gate", model: "Reolink Go PT Plus", point: [170.5, -45.9], timeZone: "Pacific/Auckland" });
    expect(added.status).toBe(201);
    w.gate = (await added.json()).camera.id;
    w.shed = (await (await call(owner, camerasRoute.POST as Handler, "/api/farming/security/cameras", {}, "POST", { farmId: w.runoff, name: "Shed" })).json()).camera.id;
    expect((await call(owner, camerasRoute.POST as Handler, "/api/farming/security/cameras", {}, "POST", { farmId: w.home, name: "gate" })).status).toBe(409);
    expect((await call(bookkeeper, camerasRoute.POST as Handler, "/api/farming/security/cameras", {}, "POST", { farmId: w.home, name: "Nope" })).status).toBe(403);
    expect((await call(owner, camerasRoute.POST as Handler, "/api/farming/security/cameras", {}, "POST", { farmId: w.home, name: "Bad", timeZone: "Mars/Olympus" })).status).toBe(400);

    for (const [key, id] of [["gate", w.gate], ["shed", w.shed]] as const) {
      const made = await call(owner, uploadLoginRoute.POST as Handler, `/api/farming/security/cameras/${id}/upload-login`, { cameraId: id }, "POST", {});
      expect(made.status).toBe(201);
      login[key] = await made.json();
    }
    expect(login.gate.username).toMatch(/^farm-security\.[a-z0-9]{10}$/);
    expect(login.gate.password).toHaveLength(20);
    // Kept only as a hash; never in a listing.
    const stored = await as(owner)((tx) => tx.query<{ upload_password_hash: string }>("select upload_password_hash from security_cameras where id = $1", [w.gate]));
    expect(stored.rows[0].upload_password_hash).toMatch(/^scrypt\$/);
    expect(stored.rows[0].upload_password_hash).not.toContain(login.gate.password);
    const listed = JSON.stringify(await (await call(owner, camerasRoute.GET as Handler, "/api/farming/security/cameras")).json());
    expect(listed).not.toContain(login.gate.password);
    expect((await call(viewer, uploadLoginRoute.POST as Handler, `/api/farming/security/cameras/${w.gate}/upload-login`, { cameraId: w.gate }, "POST", {})).status).toBe(403);
    const audit = await as(owner)((tx) => tx.query<{ details: Record<string, unknown> }>("select details from audit_events where event_type = 'security.upload_login_made'"));
    expect(audit.rows).toHaveLength(2);
    expect(JSON.stringify(audit.rows)).not.toContain(login.gate.password);
  });

  it("a camera uploads snapshots and clips over FTPS; each file becomes one event with the camera's time", async () => {
    const results = await upload(receiver, login.gate, [
      { name: "Gate_00_20261101063015.jpg", bytes: jpeg },
      { name: "Gate_00_20261101063001.mp4", bytes: mp4 },
      // The same photo again (a resend): one event.
      { name: "Gate_00_20261101063015.jpg", bytes: jpeg },
    ]);
    expect(results).toEqual(["226", "226", "226"]);
    const listed = (await (await events(owner)).json()).events as SecurityEvent[];
    expect(listed.map((event) => [event.kind, event.cameraLocalTime, event.detection])).toEqual([
      ["snapshot", "2026-11-01T06:30:15", "unknown"],
      ["clip", "2026-11-01T06:30:01", "unknown"],
    ]);
    const snapshot = listed[0];
    // 06:30:15 NZDT is 17:30:15 UTC the day before; arriving now, long after, it's marked late but keeps the camera's time.
    expect(snapshot.cameraAt).toBe("2026-10-31T17:30:15.000Z");
    expect(snapshot.occurredAt).toBe(snapshot.cameraAt);
    expect(snapshot.hasThumbnail).toBe(true);
    expect(new Date(snapshot.receivedAt).getTime()).toBeGreaterThan(Date.now() - 60_000);
    w.snapshot = snapshot.id;
    w.clip = listed[1].id;
    // On disk, not in the database; nothing left half-arrived.
    const row = await as(owner)((tx) => tx.query<{ storage_path: string }>("select storage_path from security_events where id = $1", [w.snapshot]));
    expect(existsSync(resolveStored(ORG, row.rows[0].storage_path))).toBe(true);
    expect(readdirSync(incomingFolder())).toEqual([]);
  });

  it("refuses files that aren't JPEG or MP4, files over the limit, wrong passwords and plain FTP", async () => {
    const results = await upload(receiver, login.gate, [
      { name: "Gate_00_20261101070000.jpg", bytes: Buffer.from("<html><script>alert(1)</script></html>") },
      { name: "Gate_00_20261101070001.mp4", bytes: Buffer.concat([mp4, Buffer.alloc(300 * 1024)]) },
    ]);
    expect(results[0]).toBe("553");
    expect(results[1]).toBe("552");
    expect((await (await events(owner)).json()).events).toHaveLength(2);
    expect(readdirSync(incomingFolder())).toEqual([]);
    await expect(upload(receiver, { username: login.gate.username, password: "wrong-password-12345" }, [])).rejects.toMatchObject({ code: 530 });
    // FTPS is required on this receiver.
    await expect(upload(receiver, login.gate, [], false)).rejects.toMatchObject({ code: 530 });
    // A receiver that allows plain FTP (for a camera on the same network) takes it.
    expect(await upload(plainReceiver, login.shed, [{ name: "Shed_00_20261101080000.jpg", bytes: jpeg2 }], false)).toEqual(["226"]);
  });

  it("uploads go only to the camera whose login it is, and stop when the login goes", async () => {
    const shedEvents = (await (await events(owner, `&cameraId=${w.shed}`)).json()).events as SecurityEvent[];
    expect(shedEvents.map((event) => [event.cameraName, event.farmName])).toEqual([["Shed", "Runoff"]]);
    w.shedEvent = shedEvents[0].id;
    expect((await call(owner, uploadLoginRoute.DELETE as Handler, `/api/farming/security/cameras/${w.shed}/upload-login`, { cameraId: w.shed }, "DELETE")).status).toBe(200);
    expect(await authenticateCamera(login.shed.username, login.shed.password)).toBeNull();
    // Archiving removes the login too.
    expect((await call(owner, cameraRoute.PATCH as Handler, `/api/farming/security/cameras/${w.gate}`, { cameraId: w.gate }, "PATCH", { active: false })).status).toBe(200);
    expect(await authenticateCamera(login.gate.username, login.gate.password)).toBeNull();
    await call(owner, cameraRoute.PATCH as Handler, `/api/farming/security/cameras/${w.gate}`, { cameraId: w.gate }, "PATCH", { active: true });
    login.gate = await (await call(owner, uploadLoginRoute.POST as Handler, `/api/farming/security/cameras/${w.gate}/upload-login`, { cameraId: w.gate }, "POST", {})).json();
    expect(await authenticateCamera(login.gate.username, login.gate.password)).toMatchObject({ cameraId: w.gate });
  });

  it("only people given camera access see events, only on their farms, and only at their level", async () => {
    // Members with no camera access, and sales roles, see nothing.
    expect((await events(staff)).status).toBe(403);
    expect((await events(viewer)).status).toBe(403);
    expect((await events(salesRep)).status).toBe(403);
    expect((await media(viewer, w.snapshot, "&variant=thumbnail")).status).toBe(403);
    expect((await grant(salesRep.id, "view")).status).toBe(400);
    expect((await call(viewer, accessRoute.PUT as Handler, "/api/farming/security/access", {}, "PUT", { userId: viewer.id, level: "delete" })).status).toBe(403);

    expect((await grant(staff.id, "view")).status).toBe(200);
    expect((await grant(viewer.id, "download")).status).toBe(200);
    expect((await grant(bookkeeper.id, "delete")).status).toBe(200);

    // Staff see the home farm's events, not the runoff's.
    const seen = (await (await events(staff)).json()).events as SecurityEvent[];
    expect(seen.map((event) => event.cameraName)).toEqual(["Gate", "Gate"]);
    expect((await call(staff, eventRoute.GET as Handler, `/api/farming/security/events/${w.shedEvent}`, { eventId: w.shedEvent })).status).toBe(404);
    expect((await media(staff, w.shedEvent, "&variant=full")).status).toBe(404);
    // Seeing isn't downloading.
    const thumb = await media(staff, w.snapshot, "&variant=thumbnail");
    expect(thumb.status).toBe(200);
    expect(thumb.headers.get("content-type")).toBe("image/jpeg");
    expect((await media(staff, w.snapshot, "&download=1")).status).toBe(403);
    // A clip plays in ranges.
    const part = await call(staff, mediaRoute.GET as Handler, `/api/farming/security/events/${w.clip}/media`, { eventId: w.clip }, "GET", undefined, "&variant=full");
    expect(part.status).toBe(200);
    expect(Buffer.from(await part.arrayBuffer()).equals(mp4)).toBe(true);
    const ranged = await mediaRoute.GET(apiRequest(`/api/farming/security/events/${w.clip}/media?organisationId=${ORG}&variant=full`, { cookie: await sessionCookieFor(staff), headers: { range: "bytes=4-11" } }), params({ eventId: w.clip }));
    expect(ranged.status).toBe(206);
    expect(Buffer.from(await ranged.arrayBuffer()).toString()).toBe("ftypisom");

    const download = await media(viewer, w.snapshot, "&download=1");
    expect(download.status).toBe(200);
    expect(download.headers.get("content-disposition")).toMatch(/^attachment; filename="Gate-\d{8}-\d{6}\.jpg"$/);
    expect(Buffer.from(await download.arrayBuffer()).equals(jpeg)).toBe(true);

    // Another organisation's owner gets nothing, even with the id: it's looked for in their own organisation only.
    expect((await media(outsider, w.snapshot, "&variant=full", OTHER)).status).toBe(404);
    expect((await media(outsider, w.snapshot, "&variant=full")).status).toBe(404);

    const audit = await as(owner)((tx) => tx.query<{ event_type: string; actor_email: string }>("select event_type, actor_email from audit_events where event_type in ('security.media_downloaded', 'security.clip_viewed', 'security.access_set') order by id"));
    expect(audit.rows.map((row) => [row.event_type, row.actor_email])).toEqual([
      ["security.access_set", "sec-owner@example.com"],
      ["security.access_set", "sec-owner@example.com"],
      ["security.access_set", "sec-owner@example.com"],
      // The first request for the clip, not every range after it.
      ["security.clip_viewed", "sec-staff@example.com"],
      ["security.media_downloaded", "sec-viewer@example.com"],
    ]);
  });

  it("filters by camera, kind and date", async () => {
    expect(((await (await events(owner, "&kind=clip")).json()).events as SecurityEvent[]).map((event) => event.id)).toEqual([w.clip]);
    expect((await (await events(owner, `&farmId=${w.home}&from=2026-11-01&to=2026-11-01`)).json()).events).toHaveLength(2);
    expect((await (await events(owner, "&from=2026-11-02")).json()).events.filter((event: SecurityEvent) => event.farmId === w.home)).toHaveLength(0);
    expect((await events(owner, "&kind=movie")).status).toBe(400);
  });

  it("kept events stay; deleting needs delete access, can't be undone and is audited", async () => {
    // Anyone who can see it may keep it, with a note.
    const kept = await call(staff, keepRoute.PUT as Handler, `/api/farming/security/events/${w.snapshot}/keep`, { eventId: w.snapshot }, "PUT", { note: "Ute at the gate at 6:30, not ours" });
    expect(kept.status).toBe(200);
    expect((await kept.json()).event).toMatchObject({ kept: true, keptNote: "Ute at the gate at 6:30, not ours", keptByEmail: "sec-staff@example.com" });
    // Un-keeping and deleting need delete access.
    expect((await call(viewer, keepRoute.DELETE as Handler, `/api/farming/security/events/${w.snapshot}/keep`, { eventId: w.snapshot }, "DELETE")).status).toBe(403);
    expect((await call(viewer, eventRoute.DELETE as Handler, `/api/farming/security/events/${w.clip}`, { eventId: w.clip }, "DELETE")).status).toBe(403);
    // A kept event must be un-kept first.
    expect((await call(bookkeeper, eventRoute.DELETE as Handler, `/api/farming/security/events/${w.snapshot}`, { eventId: w.snapshot }, "DELETE")).status).toBe(409);

    const row = await as(owner)((tx) => tx.query<{ storage_path: string }>("select storage_path from security_events where id = $1", [w.clip]));
    const file = resolveStored(ORG, row.rows[0].storage_path);
    expect(existsSync(file)).toBe(true);
    expect((await call(bookkeeper, eventRoute.DELETE as Handler, `/api/farming/security/events/${w.clip}`, { eventId: w.clip }, "DELETE")).status).toBe(200);
    expect(existsSync(file)).toBe(false);
    expect((await media(owner, w.clip, "&variant=full")).status).toBe(404);
    const audit = await as(owner)((tx) => tx.query<{ actor_email: string; details: Record<string, unknown> }>("select actor_email, details from audit_events where event_type = 'security.event_deleted'"));
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({ actor_email: "sec-books@example.com", details: { kind: "clip", cameraName: "Gate" } });
  });

  it("the clean-up removes media past the farm's retention, never kept events", async () => {
    expect((await call(viewer, settingsRoute.PUT as Handler, "/api/farming/security/settings", {}, "PUT", { farmId: w.home, retentionDays: 7 })).status).toBe(403);
    expect((await call(owner, settingsRoute.PUT as Handler, "/api/farming/security/settings", {}, "PUT", { farmId: w.home, retentionDays: 7 })).status).toBe(200);
    expect((await (await call(staff, settingsRoute.GET as Handler, "/api/farming/security/settings", {}, "GET", undefined, `&farmId=${w.home}`)).json()).settings).toMatchObject({ retentionDays: 7, isDefault: false });
    // A second snapshot from the gate, then everything made to look 8 days old.
    expect(await upload(receiver, login.gate, [{ name: "Gate_00_20261101090000.jpg", bytes: jpeg2 }])).toEqual(["226"]);
    await as(owner)((tx) => tx.query("update security_events set received_at = received_at - interval '8 days'"));
    const gone = await as(owner)((tx) => expireEvents(tx, new Date()));
    // The runoff keeps the 30-day default, the kept snapshot stays: only the new one goes.
    expect(gone).toHaveLength(1);
    for (const media of gone) await removeStored(ORG, media.storagePath);
    expect(existsSync(resolveStored(ORG, gone[0].storagePath))).toBe(false);
    const left = await as(owner)((tx) => tx.query<{ id: string }>("select id::text from security_events order by id"));
    expect(left.rows.map((entry) => entry.id).sort()).toEqual([w.snapshot, w.shedEvent].sort());
    const audit = await as(owner)((tx) => tx.query<{ details: Record<string, unknown> }>("select details from audit_events where event_type = 'security.media_expired'"));
    expect(audit.rows).toEqual([{ details: { count: 1, retentionDays: 7 } }]);
  });
});
