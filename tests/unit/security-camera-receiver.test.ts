import { describe, expect, it } from "vitest";
import { newUploadPassword, newUploadUsername, organisationOfUsername } from "@/lib/security-cameras/cameras";
import { changeFolder } from "@/lib/security-cameras/ftp-receiver";
import { receiverSettings } from "@/lib/security-cameras/receiver";
import { resolveStored, storagePathFor, thumbnailPathFor } from "@/lib/security-cameras/storage";

/* The camera upload receiver's settings, folders, logins and storage paths (#508, decisions 1216 and 1219). */

describe("receiver settings", () => {
  it("is off unless a port is set, and won't take plain FTP by accident", () => {
    expect(receiverSettings({})).toEqual({ off: "TOHYEE_CAMERA_FTP_PORT isn't set" });
    expect(receiverSettings({ TOHYEE_CAMERA_FTP_PORT: "off" })).toHaveProperty("off");
    expect(receiverSettings({ TOHYEE_CAMERA_FTP_PORT: "2121" })).toEqual({ off: "there's no FTPS certificate (TOHYEE_CAMERA_FTP_TLS_CERT and _KEY), and plain FTP isn't allowed" });
    expect(receiverSettings({ TOHYEE_CAMERA_FTP_PORT: "2121", TOHYEE_CAMERA_FTP_TLS_CERT: "/c.pem" })).toHaveProperty("off");
    expect(receiverSettings({ TOHYEE_CAMERA_FTP_PORT: "99999", TOHYEE_CAMERA_FTP_ALLOW_PLAIN: "on" })).toHaveProperty("off");
    expect(receiverSettings({ TOHYEE_CAMERA_FTP_PORT: "2121", TOHYEE_CAMERA_FTP_ALLOW_PLAIN: "on", TOHYEE_CAMERA_FTP_PASSIVE_PORTS: "50010-50000" })).toHaveProperty("off");
  });

  it("reads FTPS settings with sensible defaults", () => {
    expect(receiverSettings({ TOHYEE_CAMERA_FTP_PORT: "2121", TOHYEE_CAMERA_FTP_TLS_CERT: "/c.pem", TOHYEE_CAMERA_FTP_TLS_KEY: "/k.pem", TOHYEE_CAMERA_FTP_PUBLIC_ADDRESS: "203.0.113.7" })).toEqual({
      port: 2121,
      host: "0.0.0.0",
      passivePorts: [50000, 50019],
      publicAddress: "203.0.113.7",
      certPath: "/c.pem",
      keyPath: "/k.pem",
      allowPlain: false,
      maxFileBytes: 200 * 1024 * 1024,
    });
  });
});

describe("folders and file paths", () => {
  it("pretends to change folder without ever leaving the top", () => {
    expect(changeFolder("/", "farm/gate")).toBe("/farm/gate");
    expect(changeFolder("/farm/gate", "../../../../etc")).toBe("/etc");
    expect(changeFolder("/farm", "/")).toBe("/");
    expect(changeFolder("/a", "..\\..\\b")).toBe("/b");
  });

  it("keeps files in the organisation's own folder, named by hash", () => {
    const hash = "a".repeat(64);
    const stored = storagePathFor("kowhai-dairies", "12", new Date("2026-11-01T00:00:00Z"), hash, "jpg");
    expect(stored).toBe(`kowhai-dairies/camera-12/2026-11/${hash}.jpg`);
    expect(thumbnailPathFor(stored)).toBe(`kowhai-dairies/camera-12/2026-11/${hash}.thumb.jpg`);
    expect(() => storagePathFor("../x", "12", new Date(), hash, "jpg")).toThrow();
    expect(() => storagePathFor("kowhai-dairies", "12", new Date(), "../../x", "jpg")).toThrow();
    expect(() => resolveStored("kowhai-dairies", "../other-org/camera-1/x.jpg")).toThrow();
    expect(() => resolveStored("kowhai-dairies", "kowhai-dairies/../../etc/passwd")).toThrow();
    expect(resolveStored("kowhai-dairies", stored)).toMatch(/kowhai-dairies[\\/]camera-12[\\/]2026-11[\\/]a+\.jpg$/);
  });
});

describe("upload logins", () => {
  it("say which organisation they're for, with a long random password", () => {
    const username = newUploadUsername("kowhai-dairies");
    expect(username).toMatch(/^kowhai-dairies\.[a-z0-9]{10}$/);
    expect(organisationOfUsername(username)).toBe("kowhai-dairies");
    expect(organisationOfUsername("admin")).toBeNull();
    expect(organisationOfUsername("../x.abcdefghij")).toBeNull();
    const password = newUploadPassword();
    expect(password).toMatch(/^[a-km-zA-HJ-NP-Z2-9]{20}$/);
    expect(new Set(Array.from({ length: 50 }, () => newUploadPassword())).size).toBe(50);
  });
});
