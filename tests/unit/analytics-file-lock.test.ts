import { describe, expect, it } from "vitest";
import { analyticsLockedMessage, createWaitingForLock } from "@/lib/analytics/engine";

/** Jess's issue 3 (11 Nov 2026): another Tohyee process holding the analytics file. */
describe("a locked analytics file", () => {
  const windows = new Error(
    'IO Error: Cannot open file "C:\\ProgramData\\Tohyee\\analytics\\example.duckdb": The process cannot access the file because it is being used by another process. File is already open in C:\\Program Files\\Tohyee\\node\\node.exe (PID 12092).',
  );

  it("says so plainly, with the process number", () => {
    expect(analyticsLockedMessage(windows)).toBe(
      "Analytics is locked by another Tohyee process (process 12092), usually one left running after an update. Restart Tohyee (or the computer) and try again.",
    );
    expect(analyticsLockedMessage(new Error('IO Error: Could not set lock on file "/x.duckdb": Conflicting lock is held in /usr/bin/node (PID 5)'))).toContain("(process 5)");
    expect(analyticsLockedMessage(new Error("Catalog Error: no such table"))).toBeNull();
  });

  it("waits for the other process to let go, then gives up with that message", async () => {
    let tries = 0;
    expect(
      await createWaitingForLock(
        async () => {
          tries += 1;
          if (tries < 3) throw windows;
          return "open";
        },
        [1, 1, 1],
      ),
    ).toBe("open");
    expect(tries).toBe(3);
    await expect(createWaitingForLock(async () => Promise.reject(windows), [1])).rejects.toThrow("Analytics is locked by another Tohyee process");
    await expect(createWaitingForLock(async () => Promise.reject(new Error("other")), [1])).rejects.toThrow("other");
  });
});
