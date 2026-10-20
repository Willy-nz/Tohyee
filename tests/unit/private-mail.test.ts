import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { copyKeys, emailTokens, newWrappedDataKey, open, openJson, queryTokens, seal, sealJson, searchWords, threadKey } from "@/lib/private-mail/crypto";
import { copyExclusions, copyProgress, formatBytes } from "@/lib/private-mail/types";

/** The private mail copy's encryption, search words and what My mail says (#250; PM3, PM4, PM9, decisions 612, 613). Made-up data. */
describe("private mail", () => {
  const previous = process.env.TOHYEE_SECRET_KEY;
  beforeAll(() => {
    process.env.TOHYEE_SECRET_KEY = "private-mail-unit-test-secret-key-0123456789";
  });
  afterAll(() => {
    if (previous === undefined) delete process.env.TOHYEE_SECRET_KEY;
    else process.env.TOHYEE_SECRET_KEY = previous;
  });

  it("encrypts each value for its copy, kind and email only", () => {
    const wrapped = newWrappedDataKey();
    expect(wrapped).toMatch(/^v2:/);
    const keys = copyKeys("7", wrapped);
    const sealed = sealJson(keys, "envelope", "m1", { subject: "Soil test results" });
    expect(sealed.toString("latin1")).not.toContain("Soil");
    expect(openJson(keys, "envelope", "m1", sealed)).toEqual({ subject: "Soil test results" });
    // Moved to another email, field or copy, it doesn't open.
    expect(() => open(keys, "envelope", "m2", sealed)).toThrow("can't be read");
    expect(() => open(keys, "body", "m1", sealed)).toThrow("can't be read");
    expect(() => open(copyKeys("8", wrapped), "envelope", "m1", sealed)).toThrow("can't be read");
    expect(() => open(copyKeys("7", newWrappedDataKey()), "envelope", "m1", sealed)).toThrow("can't be read");
    // Each sealing is different (a fresh nonce).
    expect(seal(keys, "body", "m1", Buffer.from("x")).equals(seal(keys, "body", "m1", Buffer.from("x")))).toBe(false);
    // Without the server's key, the copy's key can't be opened at all.
    process.env.TOHYEE_SECRET_KEY = "a-different-server-secret-key-0123456789abcd";
    expect(() => copyKeys("7", wrapped)).toThrow();
    process.env.TOHYEE_SECRET_KEY = "private-mail-unit-test-secret-key-0123456789";
  });

  it("searches whole words, without accents or case, as keyed tokens that differ per copy", () => {
    expect(searchWords("Kōwhai Dairies: Olsen-P 32, paddock 12. A")).toEqual(["kowhai", "dairies", "olsen", "32", "paddock", "12"]);
    const one = copyKeys("1", newWrappedDataKey());
    const two = copyKeys("2", newWrappedDataKey());
    const tokens = emailTokens(one, { text: "Olsen P for paddock twelve", from: ["Results@SoilLab.example"], to: ["jess@kowhai.example"] });
    expect(tokens.join(" ")).not.toMatch(/olsen|paddock|soillab|kowhai/i);
    for (const query of ["olsen", "OLSEN paddock", "from:results@soillab.example", "to:jess@kowhai.example"]) {
      expect(queryTokens(one, query).every((token) => tokens.includes(token))).toBe(true);
    }
    expect(queryTokens(one, "nitrogen").every((token) => tokens.includes(token))).toBe(false);
    expect(queryTokens(one, "olse").every((token) => tokens.includes(token))).toBe(false);
    // Another copy's key gives other tokens for the same words.
    expect(queryTokens(two, "olsen")).not.toEqual(queryTokens(one, "olsen"));
    expect(threadKey(one, "t1")).toBe(threadKey(one, "t1"));
    expect(threadKey(one, "t1")).not.toBe(threadKey(two, "t1"));
  });

  it("shows progress, what isn't copied and sizes plainly", () => {
    expect(copyProgress({ copied: 0, listed: 0, lastSuccessAt: null })).toEqual({ text: "Not copied yet", percent: null, done: false });
    expect(copyProgress({ copied: 1234, listed: 5000, lastSuccessAt: "2026-10-19T09:15:00Z" })).toEqual({ text: "1,234 of 5,000 emails copied (24%)", percent: 24, done: false });
    expect(copyProgress({ copied: 9, listed: 9, lastSuccessAt: "2026-10-19T09:15:00Z" })).toMatchObject({ text: "All 9 emails copied", done: true });
    expect(copyExclusions("google").join(" ")).toContain("Sent, Drafts, Spam and Trash, unless you tick them");
    expect(copyExclusions("microsoft").join(" ")).toContain("Drafts, Junk Email, Deleted Items and Sent Items, unless you tick them");
    expect([formatBytes(900), formatBytes(2048), formatBytes(25 * 1024 * 1024)]).toEqual(["900 bytes", "2 KB", "25.0 MB"]);
  });

  /**
   * PM7: the private tables are touched only by the private mail code (and
   * the farm calendar's folder removal and listing, which only delete or
   * check its own member's), never by analytics, search, exports,
   * notices, reports or the AI tools.
   */
  it("keeps the private tables out of every other part of Tohyee", () => {
    const root = path.resolve(__dirname, "../../src");
    const allowed = new Set([
      "lib/private-mail/store.ts",
      "lib/private-mail/sync.ts",
      "lib/farming/calendar.ts",
      "lib/db/migrations/tenant.ts",
    ]);
    const found: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/.test(name) && /private_mail_(copies|messages|attachments)/.test(readFileSync(full, "utf8"))) found.push(path.relative(root, full).split(path.sep).join("/"));
      }
    };
    walk(root);
    expect(found.filter((file) => !allowed.has(file))).toEqual([]);
  });
});
