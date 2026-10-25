import { randomBytes } from "node:crypto";
import { createWriteStream, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { backupKeys, materialFromText, readBackupHeader, readDecrypted, writeEncrypted } from "@/lib/backups/format";
import {
  describeRecoveryFile,
  formatRecoveryCode,
  makeRecoveryFile,
  openRecoveryFile,
  parseRecoveryCode,
  randomRecoveryFileName,
  suggestPassphrase,
} from "@/lib/backups/recovery-code";
import { liveKeyId, recoveryKeyId } from "@/lib/backups/recovery-key";

const LIVE = "unit-test-live-key-0123456789abcdefghijklmnop";
const KEY = Buffer.from("00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff", "hex");

describe("the recovery code (decision 735)", () => {
  it("round-trips, grouped in fours, with a check at the end", () => {
    const code = formatRecoveryCode(3, KEY);
    expect(code).toMatch(/^RK3-([0-9A-HJKMNP-TV-Z]{4}-){13}[0-9A-HJKMNP-TV-Z]{4}$/);
    expect(parseRecoveryCode(code)).toEqual({ version: 3, key: KEY });
  });

  it("forgives case, spaces and the letters people mix up", () => {
    const code = formatRecoveryCode(1, KEY);
    const body = code.slice(4).toLowerCase().replace(/-/g, " ").replace(/0/g, "o").replace(/1/g, "l");
    const sloppy = ` rk1 ${body} `;
    expect(parseRecoveryCode(sloppy).key.equals(KEY)).toBe(true);
  });

  it("catches a mistyped or missing character, and things that aren't codes", () => {
    const code = formatRecoveryCode(1, KEY);
    const at = 10;
    const swapped = code.slice(0, at) + (code[at] === "A" ? "B" : "A") + code.slice(at + 1);
    expect(() => parseRecoveryCode(swapped)).toThrow(/has a mistake in it/);
    expect(() => parseRecoveryCode(code.slice(0, -1))).toThrow(/56 characters after RK1; that one has 55/);
    expect(() => parseRecoveryCode("hello")).toThrow(/isn't a recovery code/);
    expect(() => parseRecoveryCode("")).toThrow(/Paste or type/);
    expect(() => parseRecoveryCode(code.replace("RK1", "RK2"))).toThrow(/mistake/); // the version is part of the check
  });

  it("typed text is read as a recovery code, and nothing else is accepted (decision 867)", () => {
    expect(materialFromText(formatRecoveryCode(1, KEY))?.recoveryKey?.key.equals(KEY)).toBe(true);
    expect(() => materialFromText("  some-older-secret-key-0123456789abcdef  ")).toThrow(/isn't a recovery code/);
    expect(materialFromText("")).toBeUndefined();
  });
});

describe("the recovery file (decision 735)", () => {
  const passphrase = "correct horse battery staple";

  it("opens only with its passphrase, and holds the code encrypted", async () => {
    const text = await makeRecoveryFile({ version: 2, id: recoveryKeyId(KEY), key: KEY, madeAt: "2026-10-21T00:00:00.000Z" }, passphrase);
    const json = JSON.parse(text) as Record<string, unknown>;
    expect(json).toMatchObject({ tohyee: "recovery-kit", format: 1, keyVersion: 2, keyId: recoveryKeyId(KEY), cipher: "aes-256-gcm", kdf: { name: "scrypt", N: 131072, r: 8, p: 1 } });
    expect(text).not.toContain(formatRecoveryCode(2, KEY).slice(4, 20));
    expect(text).not.toContain(KEY.toString("base64"));
    expect(describeRecoveryFile(text)).toEqual({ keyVersion: 2, keyId: recoveryKeyId(KEY), madeAt: "2026-10-21T00:00:00.000Z" });

    const opened = await openRecoveryFile(text, passphrase);
    expect(opened.version).toBe(2);
    expect(opened.key.equals(KEY)).toBe(true);
    await expect(openRecoveryFile(text, "correct horse battery stable")).rejects.toThrow(/doesn't open this recovery file/);
  }, 30_000);

  it("refuses a file whose clear parts were changed, a weak passphrase and settings Tohyee doesn't make", async () => {
    const text = await makeRecoveryFile({ version: 2, id: recoveryKeyId(KEY), key: KEY }, passphrase);
    const changed = JSON.stringify({ ...JSON.parse(text), madeAt: "2020-01-01T00:00:00.000Z" });
    await expect(openRecoveryFile(changed, passphrase)).rejects.toThrow(/doesn't open this recovery file \(or the file was changed\)/);
    const slow = JSON.stringify({ ...JSON.parse(text), kdf: { ...JSON.parse(text).kdf, N: 2 ** 24 } });
    await expect(openRecoveryFile(slow, passphrase)).rejects.toThrow(/settings aren't ones Tohyee makes/);
    await expect(openRecoveryFile("{}", passphrase)).rejects.toThrow(/isn't a Tohyee recovery file/);
    await expect(makeRecoveryFile({ version: 1, id: "x", key: KEY }, "short")).rejects.toThrow(/at least 14 characters/);
    await expect(makeRecoveryFile({ version: 1, id: "x", key: KEY }, "aaaaaaaaaaaaaaaaaa")).rejects.toThrow(/too easy to guess/);
  }, 30_000);

  it("suggests strong passphrases and honest random names", () => {
    const one = suggestPassphrase();
    expect(one).toMatch(/^([0-9a-hjkmnp-tv-z]{5}-){4}[0-9a-hjkmnp-tv-z]{5}$/);
    expect(suggestPassphrase()).not.toBe(one);
    expect(randomRecoveryFileName()).toMatch(/^[0-9a-hjkmnp-tv-z]{16}\.tohyee-recovery$/);
  });
});

describe("backup file format 2 (decision 734)", () => {
  let folder: string;
  const original = process.env.TOHYEE_SECRET_KEY;
  const recovery = { version: 1, id: recoveryKeyId(KEY), key: KEY };
  const fields = {
    kind: "organisation" as const,
    organisationId: "unit-co",
    displayName: "Unit Co",
    databaseName: "tohyee_org_unit_co",
    schemaVersion: "0180",
    createdAt: "2026-10-21T00:00:00.000Z",
    tohyeeVersion: "0.0.0-test",
  };
  const payload = randomBytes(200_000);

  async function write(file: string) {
    await writeEncrypted(Readable.from([payload]), createWriteStream(file), fields, recovery);
  }

  async function read(file: string, material?: Parameters<typeof readDecrypted>[2]) {
    const chunks: Buffer[] = [];
    const sink = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(chunk as Buffer);
        callback();
      },
    });
    await readDecrypted(file, sink, material);
    return Buffer.concat(chunks);
  }

  beforeAll(async () => {
    process.env.TOHYEE_SECRET_KEY = LIVE;
    folder = await fs.mkdtemp(path.join(os.tmpdir(), "tohyee-format2-"));
  });
  afterAll(async () => {
    process.env.TOHYEE_SECRET_KEY = original;
    await fs.rm(folder, { recursive: true, force: true });
  });

  it("opens with the right kit, carries the live key encrypted, and has no secret in the clear", async () => {
    const file = path.join(folder, "a.tohyee-backup");
    await write(file);
    const bytes = await fs.readFile(file);
    expect(bytes.subarray(0, 16).toString()).toBe("TOHYEE-BACKUP 2\n");
    expect(bytes.includes(Buffer.from(LIVE))).toBe(false);
    expect(bytes.includes(KEY)).toBe(false);
    expect(bytes.includes(payload.subarray(0, 64))).toBe(false);

    const { header } = await readBackupHeader(file);
    expect(header).toMatchObject({ format: 2, recoveryKey: { version: 1, id: recovery.id }, kdf: "hkdf-sha256", organisationId: "unit-co" });
    expect(header.liveKey.id).toBe(liveKeyId(LIVE));

    expect((await read(file, { recoveryKey: { version: 1, key: KEY } })).equals(payload)).toBe(true);
    const keys = await backupKeys(await readBackupHeader(file), { recoveryKey: { version: 1, key: KEY } });
    expect(keys.sourceLiveKey).toBe(LIVE);
  });

  it("refuses the wrong kit, a changed header and a damaged or cut-short file", async () => {
    const file = path.join(folder, "b.tohyee-backup");
    await write(file);
    await expect(read(file, { recoveryKey: { version: 1, key: randomBytes(32) } })).rejects.toThrow(/isn't the one this backup was made with/);
    await expect(read(file, { recoveryKey: { version: 2, key: KEY } })).rejects.toThrow(/it needs version 1/);

    const bytes = await fs.readFile(file);
    const flipped = Buffer.from(bytes);
    flipped[flipped.length - 500] ^= 0x01;
    await fs.writeFile(path.join(folder, "flipped.tohyee-backup"), flipped);
    await expect(read(path.join(folder, "flipped.tohyee-backup"), { recoveryKey: { version: 1, key: KEY } })).rejects.toThrow(/damaged or was changed/);

    await fs.writeFile(path.join(folder, "short.tohyee-backup"), bytes.subarray(0, bytes.length - 4096));
    await expect(read(path.join(folder, "short.tohyee-backup"), { recoveryKey: { version: 1, key: KEY } })).rejects.toThrow(/damaged or was changed/);

    const text = bytes.toString("latin1");
    const renamed = Buffer.from(text.replace('"displayName":"Unit Co"', '"displayName":"Unit Cx"'), "latin1");
    await fs.writeFile(path.join(folder, "renamed.tohyee-backup"), renamed);
    await expect(read(path.join(folder, "renamed.tohyee-backup"), { recoveryKey: { version: 1, key: KEY } })).rejects.toThrow(/damaged or was changed/);

    await fs.writeFile(path.join(folder, "future.tohyee-backup"), Buffer.concat([Buffer.from("TOHYEE-BACKUP 9\n{}\n"), randomBytes(64)]));
    await expect(readBackupHeader(path.join(folder, "future.tohyee-backup"))).rejects.toThrow(/made by a newer version of Tohyee/);
  });

  it("a file in the first format (before recovery kits) isn't opened (decision 867)", async () => {
    const file = path.join(folder, "first-format.tohyee-backup");
    const header = { format: 1, ...fields, cipher: "aes-256-gcm", keyId: "0123456789abcdef" };
    await fs.writeFile(file, Buffer.concat([Buffer.from(`TOHYEE-BACKUP 1\n${JSON.stringify(header)}\n`), randomBytes(64)]));
    await expect(readBackupHeader(file)).rejects.toThrow(/in a format this version of Tohyee can't open/);
    await expect(read(file)).rejects.toThrow(/in a format this version of Tohyee can't open/);
    // A format 2 header claiming another format is damaged, not opened.
    const good = path.join(folder, "c.tohyee-backup");
    await write(good);
    const relabelled = Buffer.from((await fs.readFile(good)).toString("latin1").replace('"format":2', '"format":1'), "latin1");
    await fs.writeFile(path.join(folder, "relabelled.tohyee-backup"), relabelled);
    await expect(readBackupHeader(path.join(folder, "relabelled.tohyee-backup"))).rejects.toThrow(/damaged or was made by a newer version/);
  });
});
