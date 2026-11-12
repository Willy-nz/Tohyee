import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AI_TOOLS } from "@/lib/ai/catalogue";
import { SCREEN_COVERAGE } from "@/lib/ai/screen-coverage";

/** Every screen action has an AI tool, or is listed with why not yet (decision 1600). */
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
