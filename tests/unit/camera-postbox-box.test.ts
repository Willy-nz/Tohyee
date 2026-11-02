import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import https from "node:https";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { Client } from "basic-ftp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashPassword } from "@/lib/auth/password";
import { postboxConfig, type PostboxConfig } from "@/lib/camera-postbox/box/config";
import { type Postbox, startPostbox } from "@/lib/camera-postbox/box/server";
import { newPairingCode } from "@/lib/camera-postbox/box/state";
import { BoxError, type BoxTarget, callBox, CertificateChangedError, downloadFromBox } from "@/lib/camera-postbox/client";
import { decodePairingCode, hashToken, newKeyPair, openSealedFile, type QueuedFile, randomToken } from "@/lib/camera-postbox/protocol";

/*
 * The camera post box program on its own (decisions 1226-1233), run in
 * this process on made-up ports, with a stand-in camera (basic-ftp) and
 * Tohyee's own HTTPS client. No real server, camera or credentials.
 */

const API_PORT = 46451;
const FTP_PORT = 46450;
const PASSIVE: [number, number] = [46460, 46469];

describe("the camera post box", () => {
  let dataDir: string;
  let config: PostboxConfig;
  let box: Postbox;
  let target: BoxTarget;
  const keys = newKeyPair();
  const token = randomToken();
  const camera = { username: "farm-one.abcdefghij", password: "Pw3rdCameraLoginAbcd" };
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("made-up photo bytes ".repeat(400))]);

  beforeAll(async () => {
    dataDir = mkdtempSync(path.join(tmpdir(), "tohyee-postbox-box-"));
    config = { ...postboxConfig({ POSTBOX_PUBLIC_ADDRESS: "127.0.0.1", POSTBOX_DATA_DIR: dataDir, POSTBOX_HOST: "127.0.0.1", POSTBOX_FTP_PORT: String(FTP_PORT), POSTBOX_API_PORT: String(API_PORT), POSTBOX_PASSIVE_PORTS: PASSIVE.join("-"), POSTBOX_MIN_FREE_MB: "0" }), maxFileBytes: 100 * 1024 };
    box = await startPostbox(config, { log: () => undefined, failedLoginDelayMs: 5, requestsPerMinute: 200 });
  });

  afterAll(async () => {
    await box?.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

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

  it("answers health to anyone, and nothing else without pairing", async () => {
    const code = decodePairingCode(await newPairingCode(config))!;
    target = { address: "127.0.0.1", port: API_PORT, tlsMode: "pinned", fingerprint: code.fingerprint, token: null };
    expect(await callBox(target, { method: "GET", path: "/v1/health", auth: false })).toMatchObject({ ok: true, paired: false });
    await expect(callBox({ ...target, token }, { method: "GET", path: "/v1/files" })).rejects.toMatchObject({ status: 401 });
  });

  it("pairs once with the current pairing code; Tohyee's token is kept only as a hash", async () => {
    const code = decodePairingCode(await newPairingCode(config))!;
    const pair = (secret: string) => callBox(target, { method: "POST", path: "/v1/pair", auth: false, body: { secret, tokenHash: hashToken(token), publicKey: keys.publicKey } });
    await expect(pair("x".repeat(43))).rejects.toMatchObject({ status: 401 });
    const answer = await pair(code.secret);
    expect(answer).toMatchObject({ paired: true, ftp: { address: "127.0.0.1", port: FTP_PORT, passivePorts: PASSIVE } });
    // One-time: the same code doesn't work again.
    await expect(pair(code.secret)).rejects.toMatchObject({ status: 401 });
    const state = readFileSync(path.join(dataDir, "state.json"), "utf8");
    expect(state).toContain(hashToken(token));
    expect(state).not.toContain(token);
    target = { ...target, token };
    expect(await callBox(target, { method: "GET", path: "/v1/status" })).toMatchObject({ logins: { count: 0 }, queue: { files: 0 } });
  });

  it("refuses a server whose certificate isn't the pinned one, before sending anything", async () => {
    const before = box.counters.requests;
    const error = await callBox({ ...target, fingerprint: "0".repeat(64) }, { method: "GET", path: "/v1/status" }).catch((caught) => caught);
    expect(error).toBeInstanceOf(CertificateChangedError);
    expect((error as CertificateChangedError).seen).toBe(target.fingerprint);
    expect(box.counters.requests).toBe(before);
  });

  it("takes camera uploads only for logins Tohyee pushed, and only photos and clips", async () => {
    expect(await upload(camera, "Gate_00_20261101063015.jpg", jpeg)).toBe("530");
    const logins = [{ username: camera.username, hash: await hashPassword(camera.password), cameraId: "12" }];
    await expect(callBox(target, { method: "PUT", path: "/v1/logins", body: { logins: [{ ...logins[0], hash: camera.password }] } })).rejects.toMatchObject({ status: 400 });
    expect(await callBox(target, { method: "PUT", path: "/v1/logins", body: { logins } })).toMatchObject({ logins: { count: 1 } });

    expect(await upload(camera, "Gate_00_20261101063015.jpg", jpeg)).toBe("226");
    expect(await upload(camera, "again.jpg", jpeg)).toBe("226"); // a resend: one file
    expect(await upload(camera, "page.jpg", Buffer.from("<html>not a photo</html>"))).toBe("553");
    expect(await upload(camera, "big.jpg", Buffer.concat([jpeg, Buffer.alloc(200 * 1024)]))).toBe("552");
    expect(await upload({ ...camera, password: "wrong-password-12345" }, "x.jpg", jpeg)).toBe("530");
    expect(box.counters).toMatchObject({ uploads: 1, duplicates: 1 });
    // Nothing readable on the post box's disk.
    const queueFiles = readdirSync(path.join(dataDir, "queue"));
    expect(queueFiles.filter((name) => name.endsWith(".sealed"))).toHaveLength(1);
    for (const name of queueFiles) expect(readFileSync(path.join(dataDir, "queue", name)).includes(Buffer.from("made-up photo bytes"))).toBe(false);
    expect(readdirSync(path.join(dataDir, "incoming"))).toHaveLength(0);
  });

  it("lists, sends and deletes a file only when Tohyee confirms it with the right SHA-256", async () => {
    const { files } = await callBox<{ files: QueuedFile[] }>(target, { method: "GET", path: "/v1/files" });
    expect(files).toHaveLength(1);
    const file = files[0];
    expect(file).toMatchObject({ username: camera.username, cameraId: "12", fileName: "Gate_00_20261101063015.jpg", sizeBytes: jpeg.length });
    const sealed = path.join(dataDir, "downloaded.sealed");
    await downloadFromBox(target, file.id, file.storedBytes, sealed);
    await openSealedFile(sealed, path.join(dataDir, "downloaded.jpg"), keys);
    expect(readFileSync(path.join(dataDir, "downloaded.jpg")).equals(jpeg)).toBe(true);
    // Downloading again is fine: nothing goes until it's confirmed.
    await downloadFromBox(target, file.id, file.storedBytes, path.join(dataDir, "again.sealed"));
    await expect(callBox(target, { method: "POST", path: `/v1/files/${file.id}/received`, body: { sha256: "0".repeat(64) } })).rejects.toMatchObject({ status: 409 });
    expect((await callBox<{ files: QueuedFile[] }>(target, { method: "GET", path: "/v1/files" })).files).toHaveLength(1);
    expect(await callBox(target, { method: "POST", path: `/v1/files/${file.id}/received`, body: { sha256: file.sha256 } })).toEqual({ deleted: true });
    await expect(callBox(target, { method: "POST", path: `/v1/files/${file.id}/received`, body: { sha256: file.sha256 } })).rejects.toMatchObject({ status: 404 });
    expect((await callBox<{ files: QueuedFile[] }>(target, { method: "GET", path: "/v1/files" })).files).toHaveLength(0);
    await expect(downloadFromBox(target, file.id, file.storedBytes, path.join(dataDir, "gone.sealed"))).rejects.toMatchObject({ status: 404 });
  });

  it("refuses big bodies, and locks out an address after ten wrong tokens", async () => {
    // Tohyee won't send one, and the post box won't read one.
    await expect(callBox(target, { method: "PUT", path: "/v1/logins", body: { logins: [], padding: "x".repeat(1024 * 1024) } })).rejects.toBeInstanceOf(BoxError);
    const status = await new Promise<number>((resolve, reject) => {
      const request = https.request({ host: "127.0.0.1", port: API_PORT, method: "PUT", path: "/v1/logins", rejectUnauthorized: false, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "content-length": String(2 * 1024 * 1024) } }, (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      });
      request.on("error", reject);
      request.end();
    });
    expect(status).toBe(413);
    const wrong = { ...target, token: randomToken() };
    // Three wrong tries came earlier (a wrong pairing secret, a used one, a token before pairing): ten in all locks it.
    for (let attempt = 0; attempt < 7; attempt += 1) await expect(callBox(wrong, { method: "GET", path: "/v1/status" })).rejects.toMatchObject({ status: 401 });
    // Now even the right token waits.
    await expect(callBox(target, { method: "GET", path: "/v1/status" })).rejects.toMatchObject({ status: 429 });
  });

  it("rate limits each address", async () => {
    await box.close();
    box = await startPostbox(config, { log: () => undefined, failedLoginDelayMs: 5, requestsPerMinute: 5 });
    for (let attempt = 0; attempt < 5; attempt += 1) await callBox(target, { method: "GET", path: "/v1/health", auth: false });
    await expect(callBox(target, { method: "GET", path: "/v1/health", auth: false })).rejects.toMatchObject({ status: 429 });
  });
});
