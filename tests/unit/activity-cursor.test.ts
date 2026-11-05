import { describe, expect, it } from "vitest";
import { compareActivity, decodeActivityCursor, encodeActivityCursor } from "@/lib/organisations/activity";

/** "What they did" cursors (#609; decision 1510). */
describe("activity cursor", () => {
  const at = "2026-10-01T09:30:00.123456Z";

  it("round-trips time to the microsecond, stream and id", () => {
    const cursor = { at, stream: "server" as const, id: "9007199254740993" };
    expect(decodeActivityCursor(encodeActivityCursor(cursor))).toEqual(cursor);
  });

  it("refuses anything else, including a plain date", () => {
    for (const bad of ["2026-10-01T09:30:00.000Z", "", "!!", encodeActivityCursor({ at: "2026-10-01T09:30:00Z", stream: "books", id: "1" }), Buffer.from(`${at}|mail|1`).toString("base64url"), Buffer.from(`${at}|books|0`).toString("base64url"), Buffer.from(`${at}|books|1|2`).toString("base64url")]) {
      expect(decodeActivityCursor(bad)).toBeNull();
    }
  });

  it("orders newest first, then books before server, then the higher id first", () => {
    const list = [
      { at, stream: "server" as const, id: "5" },
      { at, stream: "books" as const, id: "9" },
      { at: "2026-10-01T09:30:00.123457Z", stream: "server" as const, id: "1" },
      { at, stream: "books" as const, id: "10" },
    ].sort(compareActivity);
    expect(list.map((entry) => `${entry.stream}-${entry.id}`)).toEqual(["server-1", "books-10", "books-9", "server-5"]);
  });
});
