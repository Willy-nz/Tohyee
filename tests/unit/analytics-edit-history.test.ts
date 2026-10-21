import { describe, expect, it } from "vitest";
import {
  copyName,
  hasUnsavedChanges,
  MAX_UNDO,
  recordChange,
  redo,
  redoLabel,
  replaceSaved,
  startHistory,
  undo,
  undoLabel,
} from "@/lib/analytics/edit-history";

type Report = { name: string; description: string | null; settings: unknown; tiles: Array<{ id: string; width: string; format?: unknown }> };

const report: Report = {
  name: "Sales",
  description: null,
  settings: { from: "2026-04-01", to: null, slicers: [] },
  tiles: [
    { id: "a", width: "half" },
    { id: "b", width: "half" },
  ],
};

describe("report Undo and Redo (decision 691)", () => {
  it("undoes removing a tile, then redoes it, naming the step", () => {
    const removed = { ...report, tiles: report.tiles.slice(1) };
    let history = recordChange(startHistory(report), removed, "remove Sales by month");
    expect(undoLabel(history)).toBe("remove Sales by month");
    history = undo(history);
    expect(history.present).toBe(report);
    expect(redoLabel(history)).toBe("remove Sales by month");
    expect(undoLabel(history)).toBeNull();
    history = redo(history);
    expect(history.present).toBe(removed);
  });

  it("undoes layout and bulk formatting one step at a time", () => {
    const moved = { ...report, tiles: [report.tiles[1], report.tiles[0]] };
    const wide = { ...moved, tiles: moved.tiles.map((tile) => ({ ...tile, width: "full" })) };
    const painted = { ...wide, tiles: wide.tiles.map((tile) => ({ ...tile, format: { legend: { show: false } } })) };
    let history = startHistory(report);
    history = recordChange(history, moved, "move Costs");
    history = recordChange(history, wide, "change Costs");
    history = recordChange(history, painted, "paste the format on Costs");
    history = undo(history);
    expect(history.present).toBe(wide);
    history = undo(history);
    expect(history.present).toBe(moved);
    history = undo(history);
    expect(history.present).toBe(report);
    expect(undo(history)).toBe(history);
  });

  it("makes a run of typing one step, and a new change clears Redo", () => {
    let history = startHistory(report);
    history = recordChange(history, { ...report, name: "S" }, "rename the report", "name");
    history = recordChange(history, { ...report, name: "Sa" }, "rename the report", "name");
    history = recordChange(history, { ...report, name: "Sal" }, "rename the report", "name");
    expect(history.past).toHaveLength(1);
    history = undo(history);
    expect(history.present.name).toBe("Sales");
    history = recordChange(history, { ...report, description: "x" }, "change the description", "description");
    expect(redoLabel(history)).toBeNull();
  });

  it("keeps up to the last 50 steps", () => {
    let history = startHistory(report);
    for (let index = 0; index < MAX_UNDO + 10; index += 1) history = recordChange(history, { ...report, name: `Sales ${index}` }, `step ${index}`);
    expect(history.past).toHaveLength(MAX_UNDO);
    expect(history.past[0].label).toBe("step 10");
  });

  it("takes the server's tidied copy after a save, unless more changes were made while it was saving", () => {
    const sent = { ...report, name: "Sales " };
    const saved = { ...report, name: "Sales" };
    const history = recordChange(startHistory(report), sent, "rename the report");
    expect(replaceSaved(history, sent, saved).present).toBe(saved);
    const later = recordChange(history, { ...sent, description: "More" }, "change the description");
    expect(replaceSaved(later, sent, saved)).toBe(later);
  });
});

describe("unsaved changes (decision 690)", () => {
  it("compares the definition, not who saved it or the key order", () => {
    const same = {
      ...report,
      settings: { slicers: [], to: null, from: "2026-04-01" },
      version: 7,
      updatedAt: "2026-10-21T00:00:00.000Z",
    };
    expect(hasUnsavedChanges(report, same)).toBe(false);
    expect(hasUnsavedChanges(report, { ...report, description: "" })).toBe(false);
    expect(hasUnsavedChanges(report, { ...report, tiles: report.tiles.slice(1) })).toBe(true);
    expect(hasUnsavedChanges(report, { ...report, tiles: [{ ...report.tiles[0], width: "full" }, report.tiles[1]] })).toBe(true);
  });

  it("names a copy within 100 characters", () => {
    expect(copyName("Sales")).toBe("Sales (copy)");
    expect(copyName("x".repeat(100))).toHaveLength(100);
  });
});
