import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { postboxConfig } from "@/lib/camera-postbox/box/config";
import {
  decodePairingCode,
  displayFingerprint,
  encodePairingCode,
  hashToken,
  isPublicKey,
  loginsVersion,
  newKeyPair,
  normaliseFingerprint,
  openSealedFile,
  parseLogins,
  sealFile,
  SEALED_OVERHEAD,
} from "@/lib/camera-postbox/protocol";
import { installCommand, statusFrom } from "@/lib/camera-postbox/service";

/* The camera post box's shared rules (decisions 1226-1233). Made-up addresses, keys and files. */

const folder = mkdtempSync(path.join(tmpdir(), "tohyee-postbox-unit-"));
afterAll(() => rmSync(folder, { recursive: true, force: true }));

const FP = "a".repeat(64);
const SECRET = "s".repeat(43);

describe("pairing codes", () => {
  it("round-trip, and ignore spaces and line breaks from copying", () => {
    const code = encodePairingCode({ address: "203.0.113.10", port: 8443, fingerprint: FP, secret: SECRET, name: null });
    expect(code.startsWith("TPB1-")).toBe(true);
    const spaced = `${code.slice(0, 20)}\n  ${code.slice(20)} `;
    expect(decodePairingCode(spaced)).toEqual({ address: "203.0.113.10", port: 8443, fingerprint: FP, secret: SECRET, name: null });
    const named = encodePairingCode({ address: "203.0.113.10", port: 443, fingerprint: FP, secret: SECRET, name: "cameras.example.nz" });
    expect(decodePairingCode(named)?.name).toBe("cameras.example.nz");
  });

  it("refuses anything that isn't one", () => {
    const body = (value: object) => `TPB1-${Buffer.from(JSON.stringify(value)).toString("base64url")}`;
    expect(decodePairingCode("hello")).toBeNull();
    expect(decodePairingCode("TPB1-!!!")).toBeNull();
    expect(decodePairingCode(body({ a: "203.0.113.10", p: 8443, f: "zz", s: SECRET }))).toBeNull();
    expect(decodePairingCode(body({ a: "203.0.113.999", p: 8443, f: FP, s: SECRET }))).toBeNull();
    expect(decodePairingCode(body({ a: "203.0.113.10", p: 70000, f: FP, s: SECRET }))).toBeNull();
    expect(decodePairingCode(body({ a: "203.0.113.10", p: 8443, f: FP, s: "short" }))).toBeNull();
    expect(decodePairingCode(body({ a: "x/../y", p: 8443, f: FP, s: SECRET }))).toBeNull();
    expect(decodePairingCode(body({ a: "203.0.113.10", p: 8443, f: FP, s: SECRET, n: "203.0.113.10" }))).toBeNull();
  });

  it("fingerprints are compared as lowercase hex and shown with colons", () => {
    expect(normaliseFingerprint("AB:CD:EF")).toBe("abcdef");
    expect(normaliseFingerprint(Buffer.from("x"))).toHaveLength(64);
    expect(displayFingerprint("abcdef")).toBe("AB:CD:EF");
    expect(hashToken("token")).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("camera logins", () => {
  const login = { username: "farm.abcdefghij", hash: "scrypt$32768$8$1$c2FsdA==$aGFzaA==", cameraId: "7" };

  it("are checked, and their version doesn't depend on order", () => {
    const other = { ...login, username: "farm.klmnopqrst", cameraId: "8" };
    expect(parseLogins([login, other])).toHaveLength(2);
    expect(loginsVersion([login, other])).toBe(loginsVersion([other, login]));
    expect(loginsVersion([login])).not.toBe(loginsVersion([login, other]));
    expect(loginsVersion([login])).not.toBe(loginsVersion([{ ...login, hash: "scrypt$32768$8$1$c2FsdA==$b3RoZXI=" }]));
  });

  it("refuse passwords, strange user names, duplicates and too many", () => {
    expect(() => parseLogins([{ ...login, hash: "plain-password" }])).toThrow(/scrypt/);
    expect(() => parseLogins([{ ...login, username: "../etc" }])).toThrow(/user name/);
    expect(() => parseLogins([login, login])).toThrow(/twice/);
    expect(() => parseLogins([{ ...login, cameraId: "x" }])).toThrow(/camera/);
    expect(() => parseLogins("nope")).toThrow();
    expect(() => parseLogins(Array.from({ length: 501 }, (_, index) => ({ ...login, username: `farm.${String(index).padStart(10, "a")}` })))).toThrow(/at most/);
  });
});

describe("sealing files to Tohyee's key", () => {
  it("only the matching private key opens a sealed file, and the post box's copy isn't readable", async () => {
    const keys = newKeyPair();
    expect(isPublicKey(keys.publicKey)).toBe(true);
    expect(isPublicKey("nope")).toBe(false);
    const original = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("made-up photo ".repeat(5000))]);
    writeFileSync(path.join(folder, "photo.jpg"), original);
    await sealFile(path.join(folder, "photo.jpg"), path.join(folder, "photo.sealed"), keys.publicKey);
    const sealed = readFileSync(path.join(folder, "photo.sealed"));
    expect(sealed.length).toBe(original.length + SEALED_OVERHEAD);
    expect(sealed.includes(Buffer.from("made-up photo"))).toBe(false);

    await openSealedFile(path.join(folder, "photo.sealed"), path.join(folder, "photo.opened"), keys);
    expect(readFileSync(path.join(folder, "photo.opened")).equals(original)).toBe(true);

    const other = newKeyPair();
    await expect(openSealedFile(path.join(folder, "photo.sealed"), path.join(folder, "photo.wrong"), other)).rejects.toThrow();

    const tampered = Buffer.from(sealed);
    tampered[100] ^= 1;
    writeFileSync(path.join(folder, "tampered.sealed"), tampered);
    await expect(openSealedFile(path.join(folder, "tampered.sealed"), path.join(folder, "tampered.opened"), keys)).rejects.toThrow();

    writeFileSync(path.join(folder, "short.sealed"), Buffer.from("TPB1"));
    await expect(openSealedFile(path.join(folder, "short.sealed"), path.join(folder, "short.opened"), keys)).rejects.toThrow(/too short/);
  });
});

describe("the post box's settings", () => {
  it("needs a public address, and has sensible defaults", () => {
    expect(() => postboxConfig({})).toThrow(/POSTBOX_PUBLIC_ADDRESS/);
    const config = postboxConfig({ POSTBOX_PUBLIC_ADDRESS: "203.0.113.10", POSTBOX_FTP_PUBLIC_PORT: "21" });
    expect(config).toMatchObject({ ftpPort: 2121, ftpPublicPort: 21, apiPort: 8443, apiPublicPort: 8443, passivePorts: [50000, 50019], maxFileBytes: 200 * 1024 * 1024, maxAgeDays: 30, publicName: null });
  });

  it("refuses half a certificate, a name without one, and bad ranges", () => {
    expect(() => postboxConfig({ POSTBOX_PUBLIC_ADDRESS: "203.0.113.10", POSTBOX_TLS_CERT: "/x.pem" })).toThrow(/both/);
    expect(() => postboxConfig({ POSTBOX_PUBLIC_ADDRESS: "203.0.113.10", POSTBOX_PUBLIC_NAME: "cameras.example.nz" })).toThrow(/certificate/);
    expect(() => postboxConfig({ POSTBOX_PUBLIC_ADDRESS: "203.0.113.10", POSTBOX_PASSIVE_PORTS: "9-1" })).toThrow(/range/);
    expect(() => postboxConfig({ POSTBOX_PUBLIC_ADDRESS: "203.0.113.10", POSTBOX_FTP_PORT: "99999" })).toThrow(/port/);
  });
});

describe("what Tohyee shows", () => {
  const base = {
    public_key: "k", private_key_ciphertext: "v2:x", address: "203.0.113.10", https_port: 8443, tls_mode: "pinned" as const, fingerprint: "ab".repeat(32), token_ciphertext: "v2:y",
    paired_at: new Date("2026-11-02T00:00:00Z"), paired_by_email: "owner@example.com", ftp_address: "203.0.113.10", ftp_port: 21, passive_ports: "50000-50019", box_version: "0.1.0",
    last_contact_at: new Date("2026-11-02T10:00:00Z"), last_collected_at: null, collected_total: "3", files_waiting: 2, bytes_waiting: "2048", disk_free_bytes: "100", disk_total_bytes: "200",
    low_disk: false, logins_version: "v", logins_pushed_at: null, last_error: null, last_error_kind: null, last_error_at: null,
  };

  it("connected means heard from in the last five minutes with nothing stopping it", () => {
    const now = new Date("2026-11-02T10:03:00Z");
    expect(statusFrom(base, "v", now)).toMatchObject({ paired: true, connected: true, loginsInSync: true, filesWaiting: 2, bytesWaiting: 2048, collectedTotal: 3, fingerprint: expect.stringMatching(/^AB:AB:/) });
    expect(statusFrom(base, "other", now).loginsInSync).toBe(false);
    expect(statusFrom(base, "v", new Date("2026-11-02T10:06:00Z")).connected).toBe(false);
    const changed = { ...base, last_error: "changed", last_error_kind: "certificate_changed" as const, last_error_at: now };
    expect(statusFrom(changed, "v", now)).toMatchObject({ connected: false, error: { kind: "certificate_changed" } });
    const oneFile = { ...base, last_error: "one file", last_error_kind: "file_failed" as const, last_error_at: now };
    expect(statusFrom(oneFile, "v", now).connected).toBe(true);
    expect(statusFrom(null, "v", now)).toMatchObject({ paired: false, connected: false, address: null });
  });

  it("the install command is for this Tohyee's own release", () => {
    expect(installCommand("1.2.3")).toBe("curl -fsSL https://raw.githubusercontent.com/Willy-nz/Tohyee/v1.2.3/postbox/install.sh | sudo bash -s -- --version 1.2.3");
  });
});
