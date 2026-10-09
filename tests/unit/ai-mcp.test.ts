import { describe, expect, it } from "vitest";
import { boundedJson, boundedLimit, firstRows, RequestLimiter } from "@/lib/ai/limits";
import { handleMcpMessage, type McpServer, negotiateProtocolVersion, protocolHeaderAccepted } from "@/lib/ai/mcp-protocol";
import { aiTokenDisplayPrefix, bearerAiToken, hashAiToken, looksLikeAiToken, newAiToken } from "@/lib/ai/token-format";
import { effectiveAccessLevel, isAiAccessLevel, levelAllows } from "@/lib/ai/access-levels";
import { AI_TOOL_PLAIN_WORDS } from "@/lib/ai/tool-names";
import { AI_TOOLS } from "@/lib/ai/catalogue";
import { financialYearEndLabel } from "@/lib/ai/tools";

describe("AI key format (decision 340)", () => {
  it("makes tohyee_ai_ keys with 32 random bytes, different each time", () => {
    const first = newAiToken();
    const second = newAiToken();
    expect(first).toMatch(/^tohyee_ai_[A-Za-z0-9_-]{43}$/);
    expect(first).not.toBe(second);
    expect(looksLikeAiToken(first)).toBe(true);
  });

  it("hashes with SHA-256 hex and shows 8 characters after the prefix", () => {
    expect(hashAiToken("x")).toMatch(/^[0-9a-f]{64}$/);
    expect(hashAiToken("x")).toBe("2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881");
    expect(aiTokenDisplayPrefix("tohyee_ai_abcdefghijklmnop")).toBe("abcdefgh");
  });

  it("reads only Bearer tohyee_ai_ keys from the Authorization header", () => {
    const token = newAiToken();
    expect(bearerAiToken(`Bearer ${token}`)).toBe(token);
    expect(bearerAiToken(`bearer   ${token} `)).toBe(token);
    expect(bearerAiToken(null)).toBeNull();
    expect(bearerAiToken(token)).toBeNull();
    expect(bearerAiToken(`Basic ${token}`)).toBeNull();
    expect(bearerAiToken("Bearer some-session-token-abcdefghijklmnopqrstuvwxyz0123456789")).toBeNull();
    expect(bearerAiToken("Bearer tohyee_ai_short")).toBeNull();
  });
});

describe("MCP limits (decision 343)", () => {
  it("allows the limit per key per minute, then refuses until the minute is up", () => {
    const limiter = new RequestLimiter(3, 60_000);
    expect([limiter.take("a", 0), limiter.take("a", 1), limiter.take("a", 2), limiter.take("a", 3)]).toEqual([true, true, true, false]);
    expect(limiter.take("b", 3)).toBe(true);
    expect(limiter.take("a", 60_000)).toBe(true);
  });

  it("bounds limits and rows", () => {
    expect(boundedLimit(undefined, 50, 200)).toBe(50);
    expect(boundedLimit(500, 50, 200)).toBe(200);
    expect(boundedLimit("20", 50, 200)).toBe(20);
    expect(boundedLimit(0, 50, 200)).toBe(50);
    expect(boundedLimit(2.5, 50, 200)).toBe(50);
    expect(firstRows([1, 2, 3], 2)).toEqual({ rows: [1, 2], truncated: true, total: 3 });
    expect(firstRows([1], 2)).toEqual({ rows: [1], truncated: false, total: 1 });
    expect(boundedJson({ a: "x".repeat(10) }, 100)).toBe('{"a":"xxxxxxxxxx"}');
    expect(boundedJson({ a: "x".repeat(200) }, 100)).toBeNull();
  });
});

describe("the AI page's list of what it can see", () => {
  it("names every tool, and only those", () => {
    expect(AI_TOOL_PLAIN_WORDS.map((tool) => tool.name).sort()).toEqual(AI_TOOLS.map((tool) => tool.name).sort());
  });
});

describe("financial year end label", () => {
  it("uses the month's last day", () => {
    expect(financialYearEndLabel(3)).toBe("31 March");
    expect(financialYearEndLabel(6)).toBe("30 June");
    expect(financialYearEndLabel(2)).toBe("28 February (29 in a leap year)");
  });
});

describe("MCP messages (decision 344)", () => {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const server: McpServer = {
    serverInfo: { name: "tohyee", version: "9.9.9" },
    instructions: "Read-only.",
    tools: [{ name: "list_accounts", title: "Accounts", description: "The chart of accounts.", inputSchema: { type: "object", properties: {} } }],
    async callTool(name, args) {
      calls.push({ name, args });
      return { content: [{ type: "text", text: "[]" }] };
    },
  };

  it("negotiates the protocol version", () => {
    expect(negotiateProtocolVersion("2025-06-18")).toBe("2025-06-18");
    expect(negotiateProtocolVersion("2025-03-26")).toBe("2025-03-26");
    expect(negotiateProtocolVersion("2099-01-01")).toBe("2025-06-18");
    expect(negotiateProtocolVersion(undefined)).toBe("2025-06-18");
    expect(protocolHeaderAccepted(null)).toBe(true);
    expect(protocolHeaderAccepted("2025-06-18")).toBe(true);
    expect(protocolHeaderAccepted("nope")).toBe(false);
  });

  it("answers initialize with tools only", async () => {
    expect(await handleMcpMessage({ jsonrpc: "2.0", id: "a", method: "initialize", params: { protocolVersion: "2024-11-05" } }, server)).toEqual({
      jsonrpc: "2.0",
      id: "a",
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "tohyee", version: "9.9.9" },
        instructions: "Read-only.",
      },
    });
  });

  it("lists tools as read-only and calls them with their arguments", async () => {
    const listed = (await handleMcpMessage({ jsonrpc: "2.0", id: 1, method: "tools/list" }, server)) as { result: { tools: Record<string, unknown>[] } };
    expect(listed.result.tools[0]).toMatchObject({ name: "list_accounts", annotations: { readOnlyHint: true, destructiveHint: false } });
    const called = await handleMcpMessage({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list_accounts", arguments: { includeArchived: true } } }, server);
    expect(called).toEqual({ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: "[]" }] } });
    expect(calls).toEqual([{ name: "list_accounts", args: { includeArchived: true } }]);
  });

  it("gives JSON-RPC errors for unknown methods, unknown tools and bad messages", async () => {
    expect(await handleMcpMessage({ jsonrpc: "2.0", id: 3, method: "sampling/createMessage" }, server)).toMatchObject({ id: 3, error: { code: -32601 } });
    expect(await handleMcpMessage({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "delete_everything" } }, server)).toMatchObject({
      id: 4,
      error: { code: -32602 },
    });
    expect(await handleMcpMessage({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "list_accounts", arguments: [] } }, server)).toMatchObject({
      error: { code: -32602 },
    });
    expect(await handleMcpMessage({ jsonrpc: "1.0", id: 6, method: "ping" }, server)).toMatchObject({ id: 6, error: { code: -32600 } });
    expect(await handleMcpMessage("ping", server)).toMatchObject({ id: null, error: { code: -32600 } });
  });

  it("doesn't answer notifications or the client's responses", async () => {
    expect(await handleMcpMessage({ jsonrpc: "2.0", method: "notifications/initialized" }, server)).toBeNull();
    expect(await handleMcpMessage({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 1 } }, server)).toBeNull();
    expect(await handleMcpMessage({ jsonrpc: "2.0", id: 9, result: {} }, server)).toBeNull();
  });

  it("explains a tool that exists but isn't offered, and marks writing tools", async () => {
    const limited: McpServer = {
      ...server,
      tools: [{ name: "create_contact", title: "Add", description: "Adds a contact.", inputSchema: { type: "object" }, readOnly: false }],
      unavailableTool: (name) => (name === "approve_invoice" ? "approve_invoice needs a key with \"Make and post\" access." : null),
    };
    expect(await handleMcpMessage({ jsonrpc: "2.0", id: 10, method: "tools/call", params: { name: "approve_invoice" } }, limited)).toMatchObject({
      error: { code: -32602, message: 'approve_invoice needs a key with "Make and post" access.' },
    });
    const listed = (await handleMcpMessage({ jsonrpc: "2.0", id: 11, method: "tools/list" }, limited)) as { result: { tools: { annotations: Record<string, unknown> }[] } };
    expect(listed.result.tools[0].annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
  });
});

describe("AI key access levels (decision 346)", () => {
  it("caps the key's level by the person's role", () => {
    expect(effectiveAccessLevel("post", "viewer")).toBe("read");
    expect(effectiveAccessLevel("draft", "viewer")).toBe("read");
    expect(effectiveAccessLevel("read", "owner")).toBe("read");
    expect(effectiveAccessLevel("draft", "bookkeeper")).toBe("draft");
    expect(effectiveAccessLevel("post", "bookkeeper")).toBe("post");
    expect(effectiveAccessLevel("post", "admin")).toBe("post");
    // Full access (decision 488): Owners only; anyone else's works as "post" or less.
    expect(effectiveAccessLevel("full", "owner")).toBe("full");
    expect(effectiveAccessLevel("full", "admin")).toBe("post");
    expect(effectiveAccessLevel("full", "bookkeeper")).toBe("post");
    expect(effectiveAccessLevel("full", "viewer")).toBe("read");
  });

  it("orders the levels", () => {
    expect(levelAllows("post", "draft")).toBe(true);
    expect(levelAllows("draft", "post")).toBe(false);
    expect(levelAllows("read", "draft")).toBe(false);
    expect(levelAllows("full", "post")).toBe(true);
    expect(levelAllows("post", "full")).toBe(false);
    expect(isAiAccessLevel("full")).toBe(true);
    expect(isAiAccessLevel("draft")).toBe(true);
    expect(isAiAccessLevel("delete")).toBe(false);
  });

  it("every tool has a level, and the page lists each with the same level", () => {
    for (const tool of AI_TOOLS) {
      expect(AI_TOOL_PLAIN_WORDS.find((entry) => entry.name === tool.name)?.level, tool.name).toBe(tool.level);
    }
  });
});
