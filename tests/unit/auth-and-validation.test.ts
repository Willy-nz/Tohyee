import { describe, expect, it } from "vitest";
import { hashPassword, validateNewPassword, verifyPassword } from "@/lib/auth/password";
import { roleAtLeast } from "@/lib/auth/roles";
import { parseIsoDate } from "@/lib/dates";
import { requestHash } from "@/lib/idempotency";
import { parseOrganisationId } from "@/lib/organisations/registry";

describe("passwords", () => {
  it("hashes with scrypt and verifies", async () => {
    const hash = await hashPassword("a long enough password");
    expect(hash.startsWith("scrypt$")).toBe(true);
    expect(await verifyPassword("a long enough password", hash)).toBe(true);
    expect(await verifyPassword("a long enough passworD", hash)).toBe(false);
    expect(await verifyPassword("anything", "not-a-hash")).toBe(false);
  });

  it("uses a new salt each time", async () => {
    expect(await hashPassword("same password here")).not.toBe(await hashPassword("same password here"));
  });

  it("enforces a minimum length", () => {
    expect(() => validateNewPassword("short")).toThrow(/at least 10/);
    expect(validateNewPassword("0123456789")).toBe("0123456789");
  });
});

describe("roles", () => {
  it("ranks viewer < bookkeeper < admin < owner", () => {
    expect(roleAtLeast("owner", "admin")).toBe(true);
    expect(roleAtLeast("bookkeeper", "bookkeeper")).toBe(true);
    expect(roleAtLeast("viewer", "bookkeeper")).toBe(false);
    expect(roleAtLeast("admin", "owner")).toBe(false);
  });
});

describe("validation", () => {
  it("accepts real dates only", () => {
    expect(parseIsoDate("2026-02-28", "date")).toBe("2026-02-28");
    expect(() => parseIsoDate("2026-02-30", "date")).toThrow(/not a real date/);
    expect(() => parseIsoDate("28/02/2026", "date")).toThrow(/YYYY-MM-DD/);
  });

  it("validates organisation ids", () => {
    expect(parseOrganisationId("glimmers-by-jess")).toBe("glimmers-by-jess");
    expect(() => parseOrganisationId("Glimmers")).toThrow();
    expect(() => parseOrganisationId("-bad")).toThrow();
    expect(() => parseOrganisationId("x".repeat(33))).toThrow();
  });

  it("request hashes ignore key order", () => {
    expect(requestHash("j", { a: 1, b: [1, { c: 2, d: 3 }] })).toBe(
      requestHash("j", { b: [1, { d: 3, c: 2 }], a: 1 }),
    );
    expect(requestHash("j", { a: 1 })).not.toBe(requestHash("j", { a: 2 }));
  });
});
