import { describe, expect, it } from "vitest";
import { canonicalJson, type ChainEntry, entryHash, findInChain, GENESIS_HASH, verifyChain } from "@/lib/safety/chain";
import { enteredLate, hazardState, notifiableKeepText, notifiableKeepUntil, recordFields, reviewOverdue, SIGNED_HOW_LABELS, SITE_EXCEPTIONS, sdsState, sitePrivacyNotice } from "@/lib/safety/shared";
import { copyDue } from "@/lib/safety/weekly-copy";

/** The safety history's hash chain, worked out without a database (#446, FS7, FS8). */
function chainOf(bodies: string[]): ChainEntry[] {
  const entries: ChainEntry[] = [];
  let previous = GENESIS_HASH;
  bodies.forEach((body, index) => {
    const entry: ChainEntry = {
      seq: String(index + 1),
      kind: "hazard",
      recordId: "00000000-0000-4000-8000-00000000000" + index,
      version: 1,
      change: "created",
      farmId: "1",
      restricted: false,
      happenedOn: null,
      enteredAt: `2026-10-27T01:00:0${index}.000000Z`,
      enteredByUserId: null,
      enteredByEmail: "jess@example.com",
      via: null,
      operationId: null,
      body,
      previousHash: previous,
      hash: "",
    };
    entry.hash = entryHash(entry as ChainEntry & { body: string });
    previous = entry.hash;
    entries.push(entry);
  });
  return entries;
}

describe("safety hash chain", () => {
  it("checks a whole chain", () => {
    const chain = chainOf(['{"title":"A"}', '{"title":"B"}', '{"title":"C"}']);
    expect(verifyChain(chain)).toMatchObject({ checked: 3, withheld: 0, problems: [], head: { seq: "3", hash: chain[2].hash } });
  });

  it("finds changed details, a removed entry and a reordered chain", () => {
    const chain = chainOf(['{"title":"A"}', '{"title":"B"}', '{"title":"C"}']);
    expect(verifyChain([chain[0], { ...chain[1], body: '{"title":"b"}' }, chain[2]]).problems).toEqual([{ seq: "2", problem: "hash" }]);
    expect(verifyChain([chain[0], chain[2]]).problems).toEqual([
      { seq: "3", problem: "missing" },
      { seq: "3", problem: "link" },
    ]);
    expect(verifyChain([chain[1], chain[0]]).problems.map((problem) => problem.problem)).toContain("out_of_order");
  });

  it("checks only the place of a withheld entry, and can start part-way", () => {
    const chain = chainOf(['{"a":1}', '{"b":2}', '{"c":3}']);
    expect(verifyChain([chain[0], { ...chain[1], body: null }, chain[2]])).toMatchObject({ checked: 2, withheld: 1, problems: [] });
    expect(verifyChain([chain[2]], { seq: "2", hash: chain[1].hash }).problems).toEqual([]);
  });

  it("finds a rewrite by comparing with a copy kept off the farm (FS8)", () => {
    const chain = chainOf(['{"title":"A"}', '{"title":"B"}']);
    const rewritten = chainOf(['{"title":"A"}', '{"title":"B (rewritten)"}']);
    // The rewritten chain checks out by itself...
    expect(verifyChain(rewritten).problems).toEqual([]);
    // ...but not against the number and hash emailed off the farm earlier.
    expect(findInChain(rewritten, { seq: "2", hash: chain[1].hash })).toBe("different");
    expect(findInChain(chain, { seq: "2", hash: chain[1].hash.toUpperCase() })).toBe("found");
    expect(findInChain(chain, { seq: "3", hash: chain[1].hash })).toBe("missing");
  });

  it("writes the same details as the same text", () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: null }, e: undefined })).toBe('{"a":{"c":null,"d":[2,{"y":2,"z":1}]},"b":1}');
  });
});

describe("safety record helpers", () => {
  it("shows both dates when entered after the day it happened (FS1)", () => {
    expect(enteredLate("2026-10-20", "2026-10-27T01:00:00Z")).toBe(true);
    // 11pm on the 20th in New Zealand is still the 20th.
    expect(enteredLate("2026-10-20", "2026-10-20T10:00:00Z")).toBe(false);
    expect(enteredLate(null, "2026-10-27T01:00:00Z")).toBe(false);
  });

  it("works out a hazard's state and whether its review is overdue", () => {
    expect(hazardState({ change: "withdrawn", data: { removed: false } as never })).toBe("withdrawn");
    expect(hazardState({ change: "updated", data: { removed: true } as never })).toBe("removed");
    expect(hazardState({ change: "created", data: { removed: false } as never })).toBe("active");
    expect(reviewOverdue({ reviewDue: "2026-10-01", removed: false }, "2026-10-27")).toBe(true);
    expect(reviewOverdue({ reviewDue: "2026-10-01", removed: true }, "2026-10-27")).toBe(false);
    expect(reviewOverdue({ reviewDue: null, removed: false }, "2026-10-27")).toBe(false);
  });

  it("labels a record's fields for the pack", () => {
    expect(recordFields({ title: "Creek", level: "high", noGo: true, removed: false, paddockIds: ["4"], point: [175.1, -37.8], zone: { type: "Polygon" } }, new Map([["4", "Creek paddock"]]))).toEqual([
      ["What", "Creek"],
      ["How serious", "High"],
      ["No-go zone", "Yes"],
      ["Paddocks", "Creek paddock"],
      ["Place on the map", "-37.800000, 175.100000 (latitude, longitude)"],
      ["Zone on the map", "Drawn on the map"],
    ]);
  });
});

describe("the answers to #446's safety questions (FS45-FS48)", () => {
  it("FS45 shows five years from when WorkSafe was told as the keeping period", () => {
    expect(notifiableKeepUntil("2026-10-20")).toBe("2031-10-20");
    expect(notifiableKeepUntil("2028-02-29")).toBe("2033-03-01");
    expect(notifiableKeepText({ on: "2026-10-20", how: "phone", reference: "WS-123" })).toBe(
      "Keep this record until at least 2031-10-20: five years from when WorkSafe was told (Health and Safety at Work Act 2015, s 57).",
    );
    expect(notifiableKeepText(null)).toContain("at least five years from when WorkSafe is told");
    expect(SITE_EXCEPTIONS).toHaveLength(5);
    expect(SITE_EXCEPTIONS.join("; ")).toMatch(/remove someone who has died/);
  });

  it("FS46 labels a gate-link sign-off self-declared, no login, in the pack too", () => {
    expect(SIGNED_HOW_LABELS.link).toMatch(/^self-declared, no login/);
    expect(recordFields({ signedHow: "link" })).toEqual([["Signed", SIGNED_HOW_LABELS.link]]);
  });

  it("FS47 the gate page's privacy notice names the organisation and covers each point", () => {
    const notice = sitePrivacyNotice({ name: "Kōwhai Farms Ltd", postalAddress: "12 Test Road\nRD 1\nMadeuptown" });
    expect(notice.map((part) => part.label)).toEqual(["What's collected", "Why", "Who sees it", "If you'd rather not", "Seeing and correcting it", "How long it's kept", "Contact"]);
    expect(notice[0].text).toMatch(/^Kōwhai Farms Ltd collects your name, company, phone/);
    expect(notice.at(-1)!.text).toBe("Kōwhai Farms Ltd, 12 Test Road, RD 1, Madeuptown.");
    expect(sitePrivacyNotice({ name: "Kōwhai Farms Ltd", postalAddress: null }).at(-1)!.text).toBe("Kōwhai Farms Ltd: use the farm's contacts on this page.");
  });

  it("FS48 a safety data sheet: needed when missing, a prompt (not out of date) when over five years old", () => {
    const sheet = { id: "1", sha256: "x" } as never;
    expect(sdsState({ sds: null, sdsDate: "2024-01-01" }, "2026-10-28")).toBe("missing");
    expect(sdsState({ sds: sheet, sdsDate: "2024-01-01" }, "2026-10-28")).toBe("ok");
    expect(sdsState({ sds: sheet, sdsDate: "2021-10-28" }, "2026-10-28")).toBe("ok");
    expect(sdsState({ sds: sheet, sdsDate: "2021-10-27" }, "2026-10-28")).toBe("check");
    expect(sdsState({ sds: sheet, sdsDate: null }, "2026-10-28")).toBe("check");
  });
});

describe("the weekly copy's timing (FS38)", () => {
  it("is due after 6am once a week has passed, or when none has been sent", () => {
    const now = new Date("2026-10-27T20:00:00Z");
    expect(copyDue(now, null, 7)).toBe(true);
    expect(copyDue(now, null, 5)).toBe(false);
    expect(copyDue(now, "2026-10-21T20:00:00Z", 7)).toBe(false);
    expect(copyDue(now, "2026-10-20T20:10:00Z", 7)).toBe(true);
  });
});
