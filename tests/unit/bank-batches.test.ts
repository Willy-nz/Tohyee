import { describe, expect, it } from "vitest";
import { RequestLimiter } from "@/lib/ai/limits";
import { reconcileBatchActions } from "@/lib/bank/batches";
import { canResume, countsText, planButtonText, toggleAll, toggleSelection } from "@/lib/bank/batch-words";
import { batchState, countActions, retryAfterFor } from "@/lib/batches/service";
import { ConflictError, TooManyRequestsError } from "@/lib/errors";

describe("bank batches (#547)", () => {
  it("counts actions by what callers see, and works out the batch's state", () => {
    const counts = countActions(["committed", "committed", "failed", "pending", "unknown", "in_progress"]);
    expect(counts).toEqual({ total: 6, committed: 2, failed: 1, pending: 1, inProgress: 1, unknown: 1 });
    expect(batchState(counts, true, 30)).toBe("working");
    expect(batchState(counts, false, 0)).toBe("waiting");
    expect(batchState(counts, false, 12)).toBe("rate_limited");
    expect(batchState(countActions(["committed", "committed"]), false, 0)).toBe("done");
    expect(batchState(countActions(["committed", "failed"]), false, 0)).toBe("finished_with_failures");
  });

  it("only rate limits and lock or serialisation clashes mean wait; refusals don't", () => {
    expect(retryAfterFor(new TooManyRequestsError("Slow down", 12.2))).toBe(13);
    expect(retryAfterFor(new TooManyRequestsError("Slow down"))).toBe(60);
    expect(retryAfterFor(Object.assign(new Error("deadlock"), { code: "40P01" }))).toBe(5);
    expect(retryAfterFor(Object.assign(new Error("serialisation"), { code: "40001" }))).toBe(5);
    expect(retryAfterFor(new ConflictError("This line is reconciled."))).toBeNull();
    expect(retryAfterFor(Object.assign(new Error("check"), { code: "23514" }))).toBeNull();
  });

  it("the MCP limiter says how long until its window starts again", () => {
    const limiter = new RequestLimiter(2, 60_000);
    expect(limiter.take("k", 1_000)).toBe(true);
    expect(limiter.take("k", 2_000)).toBe(true);
    expect(limiter.take("k", 3_000)).toBe(false);
    expect(limiter.retryAfterSeconds("k", 3_000)).toBe(58);
    expect(limiter.retryAfterSeconds("k", 60_900)).toBe(1);
    expect(limiter.retryAfterSeconds("unknown")).toBe(1);
  });

  it("bulk_reconcile's actions keep their own keys; malformed ones and repeated lines are refused on their own", () => {
    const actions = reconcileBatchActions(
      [
        { action: "match", lineId: "12", journalLineIds: ["3"] },
        { action: "nonsense", lineId: "13" },
        { action: "match", lineId: "12" },
        "not an object",
        { action: "apply_bank_rule", lineId: "14" },
      ],
      "batch-key-1",
    );
    expect(actions.map((action) => [action.action, action.targetId, action.idempotencyKey, Boolean(action.refused)])).toEqual([
      ["match", "12", "batch-key-1:12", false],
      ["nonsense", "13", "batch-key-1:#1", true],
      ["match", "12", "batch-key-1:#2", true],
      ["unknown", null, "batch-key-1:#3", true],
      ["apply_bank_rule", "14", "batch-key-1:14", false],
    ]);
    expect(actions[2].refused).toMatch(/already in this call/);
  });

  it("words and selection for the screens", () => {
    expect(countsText({ total: 5, committed: 3, failed: 1, pending: 0, inProgress: 0, unknown: 1 })).toBe("3 done, 1 refused, 1 outcome unknown");
    expect(canResume({ total: 2, committed: 1, failed: 0, pending: 1, inProgress: 0, unknown: 0 }, "waiting")).toBe(true);
    expect(canResume({ total: 2, committed: 1, failed: 1, pending: 0, inProgress: 0, unknown: 0 }, "finished_with_failures")).toBe(false);
    expect(canResume({ total: 2, committed: 1, failed: 0, pending: 1, inProgress: 0, unknown: 0 }, "working")).toBe(false);
    expect(planButtonText("unreconcile", { lines: 1, voids: 0 })).toBe("Unreconcile 1 line");
    expect(planButtonText("undo", { lines: 3, voids: 2 })).toBe("Unreconcile 3 lines and void 2");
    const one = toggleSelection(new Set(), "1");
    expect([...one]).toEqual(["1"]);
    expect([...toggleSelection(one, "1")]).toEqual([]);
    expect([...toggleAll(one, ["1", "2"])].sort()).toEqual(["1", "2"]);
    expect([...toggleAll(new Set(["1", "2", "9"]), ["1", "2"])]).toEqual(["9"]);
  });
});
