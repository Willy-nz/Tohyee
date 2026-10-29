import { describe, expect, it } from "vitest";
import {
  ASSIGNED_NOT_TOLD,
  HASH_LIMITS,
  NOBODY_MESSAGED,
  phoneTimeOrNull,
  recordFields,
  REPORTED_ACCOUNT,
  reportStateText,
  SENT_MEANS,
  sentLaterText,
  WEEKLY_COPY_INCLUDES,
  WEEKLY_COPY_KEPT,
  WEEKLY_COPY_LEAVES_OUT,
} from "@/lib/safety/shared";

/*
 * Safety records say what's known and no more (#491, decisions 1105-1109):
 * saved on a phone isn't sent, sent isn't read, and a matching hash isn't
 * proof that a record is true.
 */

const NOW = Date.parse("2026-10-29T03:00:00Z");

describe("the phone's time for something sent later", () => {
  it("keeps a usable phone time and drops one that can't be right, without refusing the record", () => {
    expect(phoneTimeOrNull("2026-10-29T01:00:00Z", NOW)).toBe("2026-10-29T01:00:00.000Z");
    expect(phoneTimeOrNull("2026-10-30T01:00:00Z", NOW)).toBeNull();
    expect(phoneTimeOrNull("2026-01-01T01:00:00Z", NOW)).toBeNull();
    expect(phoneTimeOrNull("not a time", NOW)).toBeNull();
    expect(phoneTimeOrNull(undefined, NOW)).toBeNull();
  });

  it("shows both times only when it waited on the phone, and never says anyone was told", () => {
    expect(sentLaterText("2026-10-29T01:00:00Z", "2026-10-29T01:01:00Z", (iso) => iso)).toBeNull();
    const text = sentLaterText("2026-10-29T01:00:00Z", "2026-10-29T03:00:00Z", (iso) => iso)!;
    expect(text).toBe("Saved on a phone 2026-10-29T01:00:00Z (the phone's clock); reached Tohyee 2026-10-29T03:00:00Z. Until then only that phone had it.");
    expect(text).not.toMatch(/notified|told|seen|acknowledg/i);
  });

  it("is labelled as the phone's in a record's history", () => {
    expect(recordFields({ phoneTime: "2026-10-29T01:00:00.000Z" })).toEqual([["First saved on a phone (its clock)", "29 Oct 2026, 2:00:00 pm (New Zealand time)"]]);
  });
});

describe("a report's state", () => {
  const action = (verified: boolean, withdrawn = false) => ({ change: withdrawn ? ("withdrawn" as const) : ("updated" as const), data: { reportId: "r", hazardId: null, title: "Fix", assignedToUserId: null, assignedToName: "Sam", due: null, done: verified ? { note: "Done", files: [] } : null, verified: verified ? { note: null } : null } });

  it("says reported until something is done, and checked before it closes", () => {
    expect(reportStateText("open", [])).toBe("Reported, nothing done yet");
    expect(reportStateText("open", [action(false, true)])).toBe("Reported, nothing done yet");
    expect(reportStateText("actions", [action(false)])).toBe("Actions open");
    expect(reportStateText("open", [action(true)])).toBe("Actions checked, to close");
    expect(reportStateText("closed", [action(true)])).toBe("Closed");
  });
});

describe("what's said about telling people and about copies", () => {
  it("never claims a message, a reading, proof or privilege", () => {
    for (const text of [NOBODY_MESSAGED, ASSIGNED_NOT_TOLD, SENT_MEANS, REPORTED_ACCOUNT]) expect(text).not.toMatch(/\b(has been|was) (told|notified)\b/i);
    expect(ASSIGNED_NOT_TOLD).toMatch(/doesn't send a message/);
    expect(SENT_MEANS).toMatch(/can't tell whether anyone opened or read it/);
    expect(HASH_LIMITS).toMatch(/doesn't show that what a record says is true/);
    expect(HASH_LIMITS).toMatch(/doesn't make them legally privileged/);
  });

  it("the weekly copy says what's in it, what isn't, and that recipients keep copies", () => {
    expect(WEEKLY_COPY_INCLUDES.join(" ")).toMatch(/corrections included/);
    expect(WEEKLY_COPY_INCLUDES.join(" ")).toMatch(/phone numbers/);
    expect(WEEKLY_COPY_LEAVES_OUT.join(" ")).toMatch(/Injury and medical details/);
    expect(WEEKLY_COPY_KEPT).toMatch(/keeps its own copy, outside Tohyee/);
  });
});
