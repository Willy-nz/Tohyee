import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { Client } from "basic-ftp";
import { afterAll, beforeAll, expect, it } from "vitest";
import * as camerasRoute from "@/app/api/farming/security/cameras/route";
import * as uploadLoginRoute from "@/app/api/farming/security/cameras/[cameraId]/upload-login/route";
import * as cameraRoute from "@/app/api/farming/security/cameras/[cameraId]/route";
import * as checkRoute from "@/app/api/farming/security/postbox/check/route";
import * as postboxRoute from "@/app/api/farming/security/postbox/route";
import type { SessionUser } from "@/lib/auth/sessions";
import { postboxConfig, type PostboxConfig } from "@/lib/camera-postbox/box/config";
import { type Postbox, startPostbox } from "@/lib/camera-postbox/box/server";
import { newPairingCode } from "@/lib/camera-postbox/box/state";
import { callBox } from "@/lib/camera-postbox/client";
import { collectFromPostboxById } from "@/lib/camera-postbox/collector";
import { decodePairingCode, encodePairingCode, type QueuedFile } from "@/lib/camera-postbox/protocol";
import { postboxConnection, type PostboxStatus } from "@/lib/camera-postbox/service";
import type { OrgTx } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import { setMemberFarmAccess } from "@/lib/farming/access";
import { saveFarm, setFarmingEnabled } from "@/lib/farming/paddocks";
import { apiRequest, createTestOrganisation, createTestUser, describeWithDatabase, inOrganisation, params, sessionCookieFor, startTestServer, type TestServer } from "../helpers/test-server";

const ORG = "camera-postbox";
const API_PORT = 46481;
const FTP_PORT = 46480;
const PASSIVE = "46490-46499";

type Handler = (request: Request, context: never) => Promise<Response>;

/*
 * The camera post box with Tohyee (decisions 1226-1233): the post box
 * program runs in this process on made-up local ports, a stand-in camera
 * (basic-ftp, not a Reolink) uploads to it, and Tohyee pairs, pushes
 * logins and collects through its own routes and job. Made-up people,
 * farms, photos and secrets.
 */
describeWithDatabase("camera post box", () => {
  let server: TestServer;
  let owner: SessionUser;
  let staff: SessionUser;
  let mediaDir: string;
  let dataDir: string;
  let config: PostboxConfig;
  let box: Postbox;
  let farmId: string;
  let cameraId: string;
  let login: { username: string; password: string };
  let jpeg: Buffer;
  let jpeg2: Buffer;
  const as = (user: SessionUser) => <T>(work: (tx: OrgTx) => Promise<T>) => inOrganisation(ORG, { userId: user.id, email: user.email }, work);

  beforeAll(async () => {
    process.env.TOHYEE_SECRET_KEY = "postbox-integration-test-secret-key-32-characters";
    mediaDir = mkdtempSync(path.join(tmpdir(), "tohyee-postbox-media-"));
    dataDir = mkdtempSync(path.join(tmpdir(), "tohyee-postbox-data-"));
    process.env.TOHYEE_CAMERA_MEDIA_DIR = mediaDir;
    const sharp = (await import("sharp")).default;
    jpeg = await sharp({ create: { width: 64, height: 48, channels: 3, background: "#4a7" } }).jpeg().toBuffer();
    jpeg2 = await sharp({ create: { width: 64, height: 48, channels: 3, background: "#a47" } }).jpeg().toBuffer();
    config = postboxConfig({ POSTBOX_PUBLIC_ADDRESS: "127.0.0.1", POSTBOX_DATA_DIR: dataDir, POSTBOX_HOST: "127.0.0.1", POSTBOX_FTP_PORT: String(FTP_PORT), POSTBOX_API_PORT: String(API_PORT), POSTBOX_PASSIVE_PORTS: PASSIVE, POSTBOX_MIN_FREE_MB: "0" });
    box = await startPostbox(config, { log: () => undefined, failedLoginDelayMs: 5 });

    server = await startTestServer();
    owner = await createTestUser("postbox-owner@example.com", { serverAdmin: true, displayName: "Jess Kelly" });
    staff = await createTestUser("postbox-staff@example.com", { displayName: "Mere Tane" });
    await createTestOrganisation(owner, ORG);
    await coreQuery("insert into organisation_members (organisation_id, user_id, role) values ($1, $2, 'farm_worker')", [ORG, staff.id]);
    await as(owner)((tx) => setFarmingEnabled(tx, { enabled: true }));
    farmId = (await as(owner)((tx) => saveFarm(tx, { name: "Home farm" })))[0].id;
    await as(owner)((tx) => setMemberFarmAccess(tx, { userId: staff.id, role: "farm_worker", access: "farms", farmIds: [farmId] }));
  });

  afterAll(async () => {
    await box?.close();
    await server?.teardown();
    rmSync(mediaDir, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.TOHYEE_CAMERA_MEDIA_DIR;
  });

  const call = async (user: SessionUser, handler: Handler, pathName: string, method = "GET", body?: Record<string, unknown>, context: Record<string, string> = {}) =>
    handler(
      apiRequest(method === "GET" || method === "DELETE" ? `${pathName}?organisationId=${ORG}` : pathName, { method, cookie: await sessionCookieFor(user), body: body ? { organisationId: ORG, ...body } : undefined }),
      params(context) as never,
    );
  const status = async () => (await (await call(owner, postboxRoute.GET as Handler, "/api/farming/security/postbox")).json()).status as PostboxStatus;
  const eventCount = async () => Number((await as(owner)((tx) => tx.query<{ count: string }>("select count(*) from security_events"))).rows[0].count);
  const target = async () => (await as(owner)((tx) => postboxConnection(tx)))!.target;
  const waiting = async () => (await callBox<{ files: QueuedFile[] }>(await target(), { method: "GET", path: "/v1/files" })).files;

  async function upload(credentials: { username: string; password: string }, name: string, bytes: Buffer): Promise<string> {
    const client = new Client(5000);
    try {
      await client.access({ host: "127.0.0.1", port: FTP_PORT, user: credentials.username, password: credentials.password, secure: true, secureOptions: { rejectUnauthorized: false } });
      return String((await client.uploadFrom(Readable.from(bytes), name)).code);
    } catch (error) {
      return String((error as { code?: number }).code ?? (error as Error).message);
    } finally {
      client.close();
    }
  }

  it("only owners and admins see or set up the post box", async () => {
    const added = await call(owner, camerasRoute.POST as Handler, "/api/farming/security/cameras", "POST", { farmId, name: "Gate" });
    cameraId = (await added.json()).camera.id;
    login = await (await call(owner, uploadLoginRoute.POST as Handler, `/api/farming/security/cameras/${cameraId}/upload-login`, "POST", {}, { cameraId })).json();

    expect((await call(staff, postboxRoute.GET as Handler, "/api/farming/security/postbox")).status).toBe(403);
    const code = await newPairingCode(config);
    expect((await call(staff, postboxRoute.POST as Handler, "/api/farming/security/postbox", "POST", { code })).status).toBe(403);
    expect((await call(staff, checkRoute.POST as Handler, "/api/farming/security/postbox/check", "POST", {})).status).toBe(403);
    expect((await call(staff, postboxRoute.DELETE as Handler, "/api/farming/security/postbox", "DELETE")).status).toBe(403);
    const shown = await status();
    expect(shown).toMatchObject({ paired: false, connected: false });
    expect(shown.installCommand).toMatch(/^curl -fsSL https:\/\/raw\.githubusercontent\.com\/Willy-nz\/Tohyee\/v[\d.]+\/postbox\/install\.sh \| sudo bash -s -- --version [\d.]+$/);
  });

  it("refuses a code that isn't one, and a post box whose certificate doesn't match the code, sending it nothing", async () => {
    expect((await call(owner, postboxRoute.POST as Handler, "/api/farming/security/postbox", "POST", { code: "hello" })).status).toBe(400);
    const real = decodePairingCode(await newPairingCode(config))!;
    const before = box.counters.requests;
    const forged = await call(owner, postboxRoute.POST as Handler, "/api/farming/security/postbox", "POST", { code: encodePairingCode({ ...real, fingerprint: "0".repeat(64) }) });
    expect(forged.status).toBe(409);
    expect((await forged.json()).error).toMatch(/certificate doesn't match/);
    expect(box.counters.requests).toBe(before);
    expect((await status()).paired).toBe(false);
  });

  it("pairs: the token and key are kept encrypted, it's audited, and the camera logins are pushed", async () => {
    const code = await newPairingCode(config);
    const paired = await call(owner, postboxRoute.POST as Handler, "/api/farming/security/postbox", "POST", { code });
    expect(paired.status).toBe(201);
    const shown = (await paired.json()).status as PostboxStatus;
    expect(shown).toMatchObject({ paired: true, connected: true, address: "127.0.0.1", tlsMode: "pinned", ftp: { address: "127.0.0.1", port: FTP_PORT }, loginsInSync: true, filesWaiting: 0 });
    const row = await as(owner)((tx) => tx.query<{ token_ciphertext: string; private_key_ciphertext: string }>("select token_ciphertext, private_key_ciphertext from security_postbox"));
    expect(row.rows[0].token_ciphertext).toMatch(/^v2:/);
    expect(row.rows[0].private_key_ciphertext).toMatch(/^v2:/);
    const audit = await as(owner)((tx) => tx.query<{ actor_email: string; details: Record<string, unknown> }>("select actor_email, details from audit_events where event_type = 'security.postbox_paired'"));
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].actor_email).toBe(owner.email);
    expect(JSON.stringify(audit.rows)).not.toContain((await target()).token!);
    const boxStatus = await callBox<{ logins: { count: number } }>(await target(), { method: "GET", path: "/v1/status" });
    expect(boxStatus.logins.count).toBe(1);
    // The same code can't pair twice.
    expect((await call(owner, postboxRoute.POST as Handler, "/api/farming/security/postbox", "POST", { code })).status).toBe(503);
    // The Cameras screen now gives the post box's address.
    const cameras = await (await call(owner, camerasRoute.GET as Handler, "/api/farming/security/cameras")).json();
    expect(cameras.uploads).toMatchObject({ on: true, via: "postbox", publicAddress: "127.0.0.1", port: FTP_PORT });
  });

  it("collects: a camera's upload becomes one event, and only then is it deleted from the post box", async () => {
    expect(await upload(login, "Gate_00_20261101063015.jpg", jpeg)).toBe("226");
    expect(await waiting()).toHaveLength(1);
    let seenBeforeConfirm = 0;
    const result = await collectFromPostboxById(ORG, {
      beforeConfirm: async () => {
        seenBeforeConfirm = (await waiting()).length;
      },
    });
    expect(result).toMatchObject({ collected: 1, duplicates: 0, failed: 0, waiting: 0, error: null });
    expect(seenBeforeConfirm).toBe(1);
    expect(await waiting()).toHaveLength(0);
    const events = await as(owner)((tx) => tx.query<{ camera_id: string; file_name: string; camera_local_time: string; size_bytes: string }>("select camera_id::text, file_name, camera_local_time, size_bytes from security_events"));
    expect(events.rows).toEqual([{ camera_id: cameraId, file_name: "Gate_00_20261101063015.jpg", camera_local_time: "2026-11-01T06:30:15", size_bytes: String(jpeg.length) }]);
    expect((await status())).toMatchObject({ collectedTotal: 1, filesWaiting: 0 });
  });

  it("if Tohyee stops between saving and confirming, nothing is lost and nothing is doubled", async () => {
    expect(await upload(login, "Gate_00_20261101070000.jpg", jpeg2)).toBe("226");
    const before = await eventCount();
    const stopped = await collectFromPostboxById(ORG, {
      beforeConfirm: () => {
        throw new Error("Tohyee stopped here");
      },
    });
    expect(stopped).toMatchObject({ collected: 0, failed: 1 });
    expect(await eventCount()).toBe(before + 1);
    expect(await waiting()).toHaveLength(1);
    const again = await collectFromPostboxById(ORG);
    expect(again).toMatchObject({ duplicates: 1, collected: 0, failed: 0, waiting: 0 });
    expect(await eventCount()).toBe(before + 1);
    expect(await waiting()).toHaveLength(0);
  });

  it("a new or removed camera login reaches the post box on the next collection", async () => {
    const other = await call(owner, camerasRoute.POST as Handler, "/api/farming/security/cameras", "POST", { farmId, name: "Shed" });
    const shedId = (await other.json()).camera.id;
    const shedLogin = await (await call(owner, uploadLoginRoute.POST as Handler, `/api/farming/security/cameras/${shedId}/upload-login`, "POST", {}, { cameraId: shedId })).json();
    expect(await upload(shedLogin, "Shed_00_20261101080000.jpg", jpeg)).toBe("530");
    expect((await status()).loginsInSync).toBe(false);
    const checked = await call(owner, checkRoute.POST as Handler, "/api/farming/security/postbox/check", "POST", {});
    expect(checked.status).toBe(200);
    expect(((await checked.json()).status as PostboxStatus).loginsInSync).toBe(true);
    expect(await upload(shedLogin, "Shed_00_20261101080000.jpg", jpeg)).toBe("226");
    // Archiving the camera removes its login: the post box stops taking its uploads.
    await call(owner, cameraRoute.PATCH as Handler, `/api/farming/security/cameras/${shedId}`, "PATCH", { active: false }, { cameraId: shedId });
    const result = await collectFromPostboxById(ORG);
    // Its file uploaded before archiving isn't kept, as a direct upload wouldn't be.
    expect(result).toMatchObject({ discarded: 1, collected: 0 });
    expect(await upload(shedLogin, "Shed_00_20261101090000.jpg", jpeg2)).toBe("530");
  });

  it("stops loudly if the post box's certificate changes, and sends it nothing", async () => {
    await box.close();
    rmSync(path.join(dataDir, "tls"), { recursive: true, force: true });
    box = await startPostbox(config, { log: () => undefined, failedLoginDelayMs: 5 });
    const checked = await call(owner, checkRoute.POST as Handler, "/api/farming/security/postbox/check", "POST", {});
    const shown = (await checked.json()).status as PostboxStatus;
    expect(shown.connected).toBe(false);
    expect(shown.error).toMatchObject({ kind: "certificate_changed" });
    expect(shown.error!.text).toMatch(/different security certificate/);
    expect(box.counters.requests).toBe(0);
  });

  it("pairing again keeps Tohyee's key, so files already waiting still open; unpairing is audited", async () => {
    const keyBefore = (await as(owner)((tx) => tx.query<{ public_key: string }>("select public_key from security_postbox"))).rows[0].public_key;
    expect((await call(owner, postboxRoute.POST as Handler, "/api/farming/security/postbox", "POST", { code: await newPairingCode(config) })).status).toBe(201);
    expect((await as(owner)((tx) => tx.query<{ public_key: string }>("select public_key from security_postbox"))).rows[0].public_key).toBe(keyBefore);
    expect((await status()).error).toBeNull();

    const removed = await call(owner, postboxRoute.DELETE as Handler, "/api/farming/security/postbox", "DELETE");
    expect(removed.status).toBe(200);
    expect(await removed.json()).toMatchObject({ status: { paired: false }, toldPostbox: true });
    expect(await callBox({ address: "127.0.0.1", port: API_PORT, tlsMode: "pinned", fingerprint: null, token: null }, { method: "GET", path: "/v1/health", auth: false }).catch((error) => error.constructor.name)).toBe("CertificateChangedError");
    expect(await upload(login, "Gate_00_20261101100000.jpg", jpeg)).toBe("530");
    const audit = await as(owner)((tx) => tx.query<{ event_type: string }>("select event_type from audit_events where event_type like 'security.postbox_%' order by id"));
    expect(audit.rows.map((row) => row.event_type)).toEqual(["security.postbox_paired", "security.postbox_paired", "security.postbox_unpaired"]);
    expect(await collectFromPostboxById(ORG)).toBeNull();
  });
});
