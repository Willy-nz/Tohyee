import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AI_TOOLS } from "@/lib/ai/catalogue";
import { SCREEN_COVERAGE } from "@/lib/ai/screen-coverage";
import { AI_TOOL_PLAIN_WORDS, isDestructiveTool } from "@/lib/ai/tool-names";

/** Every screen action has an AI tool, or is listed with why not yet (decision 1609). */
function writeRoutes(dir: string, prefix = "/api"): string[] {
  const found: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) found.push(...writeRoutes(full, `${prefix}/${name}`));
    else if (name === "route.ts") {
      for (const match of readFileSync(full, "utf8").matchAll(/export const (POST|PUT|PATCH|DELETE)\b/g)) found.push(`${match[1]} ${prefix}`);
    }
  }
  return found;
}

describe("AI tools for every screen action", () => {
  const routes = writeRoutes(path.join(process.cwd(), "src/app/api"));

  it("lists every screen action, and nothing that's gone", () => {
    const listed = new Set(Object.keys(SCREEN_COVERAGE));
    expect(routes.filter((route) => !listed.has(route)), "new screen actions: add them to src/lib/ai/screen-coverage.ts").toEqual([]);
    const present = new Set(routes);
    expect([...listed].filter((route) => !present.has(route)), "gone: take them out of screen-coverage.ts").toEqual([]);
  });

  it("names only tools that exist", () => {
    const names = new Set(AI_TOOLS.map((tool) => tool.name));
    const missing = Object.entries(SCREEN_COVERAGE).flatMap(([route, entry]) => ("tool" in entry && !names.has(entry.tool) ? [`${route}: ${entry.tool}`] : []));
    expect(missing).toEqual([]);
  });
});

describe("destructive tools (decisions 1609-1612)", () => {
  it("tells AI apps which tools void, delete or undo, and they're all Full access", () => {
    const destructive = AI_TOOL_PLAIN_WORDS.filter((tool) => isDestructiveTool(tool.name));
    expect(destructive.map((tool) => tool.name)).toEqual(expect.arrayContaining(["void_invoice", "delete_draft_bill", "archive_budget", "dispose_fixed_asset", "set_lock_date", "remove_and_redo_bank_lines"]));
    expect(destructive.filter((tool) => tool.level !== "full").map((tool) => tool.name)).toEqual([]);
    // Every tool named for voiding or deleting is marked.
    expect(AI_TOOL_PLAIN_WORDS.filter((tool) => /void|delete|archive/.test(tool.name) && !isDestructiveTool(tool.name)).map((tool) => tool.name)).toEqual([]);
    expect(isDestructiveTool("list_invoices")).toBe(false);
    expect(isDestructiveTool("create_draft_invoice")).toBe(false);
  });
});
