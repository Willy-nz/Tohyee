import { describe, expect, it } from "vitest";
import { AI_TOOL_PLAIN_WORDS } from "@/lib/ai/tool-names";
import { AI_TOOL_SCOPES, isAiToolScope, outsideScopeMessage, scopeAllows, toolsInScope } from "@/lib/ai/tool-scopes";

const catalogue = new Set(AI_TOOL_PLAIN_WORDS.map((tool) => tool.name));

describe("what an AI key or connection is for (#696)", () => {
  it("names only tools that exist, and stays small", () => {
    for (const scope of AI_TOOL_SCOPES) {
      const tools = toolsInScope(scope);
      expect(tools.filter((tool) => !catalogue.has(tool)), scope).toEqual([]);
      expect(new Set(tools).size).toBe(tools.length);
      expect(tools.length).toBeLessThan(30);
    }
  });

  it("no scope allows everything; Reports only allows reports and Analytics, not banking or documents", () => {
    expect(scopeAllows(null, "list_bank_lines")).toBe(true);
    expect(scopeAllows(undefined, "void_invoice")).toBe(true);
    expect(scopeAllows("reports", "profit_and_loss")).toBe(true);
    expect(scopeAllows("reports", "create_analytics_dashboard")).toBe(true);
    expect(scopeAllows("reports", "list_bank_lines")).toBe(false);
    expect(scopeAllows("reports", "create_draft_invoice")).toBe(false);
    expect(scopeAllows("reports", "void_invoice")).toBe(false);
    expect(isAiToolScope("reports")).toBe(true);
    expect(isAiToolScope("all")).toBe(false);
    expect(outsideScopeMessage("reports", "list_bank_lines")).toContain('list_bank_lines is outside what this connection is for: it was set up as "Reports only"');
  });
});
