import { describe, expect, it } from "vitest";
import { AI_TOOLS } from "@/lib/ai/catalogue";
import { toolSetVersion } from "@/lib/ai/mcp-tool-list";
import {
  ALWAYS_OFFERED,
  FARMING_TOOLS,
  LIVESTOCK_TOOLS,
  moduleHidesTool,
  toolGroupOf,
  toolGroupStatuses,
  toolModulesFrom,
  type ToolModules,
  TRACKING_TOOLS,
} from "@/lib/ai/tool-modules";

/** #576 (decisions 1385-1387): the AI's tools follow the organisation's modules, as the menus do. */
const modules = (overrides: Partial<ToolModules> = {}): ToolModules => ({
  accounting: true,
  farming: false,
  livestock: false,
  reporting: false,
  notForProfit: false,
  ...overrides,
});

const offered = (on: ToolModules) =>
  AI_TOOLS.filter((tool) => moduleHidesTool(tool.name, on) === null).map((tool) => ({ ...tool, readOnly: tool.readOnly ?? tool.level === "read" }));

describe("tool groups by module (#576)", () => {
  it("names only tools that exist, each in one group", () => {
    const names = new Set(AI_TOOLS.map((tool) => tool.name));
    const grouped = [...ALWAYS_OFFERED, ...FARMING_TOOLS, ...LIVESTOCK_TOOLS, ...TRACKING_TOOLS];
    for (const name of grouped) expect(names.has(name), name).toBe(true);
    expect(new Set(grouped).size).toBe(grouped.length);
  });

  it("an organisation without farming sees no farm tools; the rest of the books stay", () => {
    const names = offered(modules()).map((tool) => tool.name);
    for (const name of [...FARMING_TOOLS, ...LIVESTOCK_TOOLS, ...TRACKING_TOOLS]) expect(names, name).not.toContain(name);
    expect(names).toEqual(expect.arrayContaining(["get_organisation", "list_invoices", "gst_return", "list_bank_lines", "list_staff", "list_ai_uploads"]));
    expect(moduleHidesTool("pasture_cover", modules())).toBe(
      "pasture_cover isn't offered: Farming is turned off for this organisation (Settings › Modules).",
    );
  });

  it("each module brings its own tools, and turning one on changes the tool-set version", () => {
    const base = toolSetVersion(offered(modules()));
    const farming = offered(modules({ farming: true })).map((tool) => tool.name);
    expect(farming).toEqual(expect.arrayContaining([...FARMING_TOOLS]));
    expect(farming).not.toContain("livestock_overview");
    expect(offered(modules({ livestock: true })).map((tool) => tool.name)).toEqual(expect.arrayContaining([...LIVESTOCK_TOOLS]));
    expect(offered(modules({ reporting: true })).map((tool) => tool.name)).toEqual(expect.arrayContaining([...TRACKING_TOOLS]));
    expect(toolSetVersion(offered(modules({ farming: true })))).not.toBe(base);
    expect(toolSetVersion(offered(modules({ livestock: true })))).not.toBe(base);
    // Not-for-profit alone adds no tools (fund tracking needs Advanced reporting too, as the tracking service does).
    expect(toolSetVersion(offered(modules({ notForProfit: true })))).toBe(base);
    // Turned back off: the same version as before.
    expect(toolSetVersion(offered(modules({ farming: false })))).toBe(base);
  });

  it("with Accounting off only get_organisation and the AI's own workspace are offered", () => {
    const off = modules({ accounting: false, farming: true, livestock: true, reporting: true });
    expect(offered(off).map((tool) => tool.name).sort()).toEqual([...ALWAYS_OFFERED].sort());
    expect(moduleHidesTool("list_invoices", off)).toContain("Accounting is turned off");
    expect(moduleHidesTool("farm_notebook", off)).toContain("Accounting is turned off");
  });

  it("modules not known (null) hide nothing, and tools outside the catalogue count as Accounting", () => {
    expect(moduleHidesTool("farm_notebook", null)).toBeNull();
    expect(toolGroupOf("get_organisation")).toBeNull();
    expect(toolGroupOf("list_invoices")?.key).toBe("accounting");
  });

  it("get_organisation's toolGroups say which are hidden and why", () => {
    expect(toolGroupStatuses(modules({ livestock: true }))).toEqual([
      expect.objectContaining({ group: "accounting", offered: true }),
      expect.objectContaining({ group: "farming", offered: false, hiddenBecause: "Farming is turned off for this organisation (Settings › Modules)." }),
      expect.objectContaining({ group: "livestock", offered: true }),
      expect.objectContaining({ group: "tracking", offered: false, hiddenBecause: expect.stringContaining("Advanced reporting") }),
    ]);
    expect(toolGroupStatuses(null).every((group) => group.offered)).toBe(true);
  });

  it("reads the switches as the menus do: Farming and Livestock need Accounting", () => {
    const row = { accounting_enabled: false, farming_enabled: true, livestock_enabled: true, advanced_features: false, not_for_profit_enabled: false };
    expect(toolModulesFrom(row)).toEqual({ accounting: false, farming: false, livestock: false, reporting: false, notForProfit: false });
    expect(toolModulesFrom({ ...row, accounting_enabled: true })).toMatchObject({ accounting: true, farming: true, livestock: true });
  });
});
