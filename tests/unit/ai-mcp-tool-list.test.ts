import { describe, expect, it } from "vitest";
import { handleMcpMessage, type McpServer, type ToolInfo } from "@/lib/ai/mcp-protocol";
import {
  acceptsEventStream,
  eventStreamBody,
  newSessionId,
  STALE_TOOL_LIST_NOTE,
  toolListState,
  ToolListSessions,
  toolSetVersion,
  TOOLS_LIST_CHANGED,
  versionInSessionId,
} from "@/lib/ai/mcp-tool-list";
import { toolListStatus } from "@/lib/ai/tools";
import { toolsForLevel } from "@/lib/ai/catalogue";

const tool = (name: string, description = `About ${name}.`): ToolInfo => ({ name, title: name, description, inputSchema: { type: "object", properties: {} } });
const asInfo = (level: Parameters<typeof toolsForLevel>[0]) => toolsForLevel(level).map((t) => ({ ...t, readOnly: t.readOnly ?? t.level === "read" }));

describe("tool-set version (decision 1342)", () => {
  it("is the same for the same tools in any order, and changes with any change a client keeps", () => {
    const base = toolSetVersion([tool("a"), tool("b")]);
    expect(base).toMatch(/^[0-9a-f]{16}$/);
    expect(toolSetVersion([tool("b"), tool("a")])).toBe(base);
    expect(toolSetVersion([tool("a"), tool("b"), tool("c")])).not.toBe(base);
    expect(toolSetVersion([tool("a"), tool("b", "Changed in a new release.")])).not.toBe(base);
    expect(toolSetVersion([tool("a"), { ...tool("b"), inputSchema: { type: "object", properties: { x: { type: "string" } } } }])).not.toBe(base);
  });

  it("differs for every access level, so a level change is noticed", () => {
    const versions = (["read", "draft", "post", "full"] as const).map((level) => toolSetVersion(asInfo(level)));
    expect(new Set(versions).size).toBe(4);
  });
});

describe("session ids", () => {
  it("carry the version at initialize and 128 random bits, in visible ASCII", () => {
    const id = newSessionId("0123456789abcdef");
    expect(id).toMatch(/^[\x21-\x7e]+$/);
    expect(versionInSessionId(id)).toBe("0123456789abcdef");
    expect(newSessionId("0123456789abcdef")).not.toBe(id);
    expect(versionInSessionId("someone-elses-session")).toBeNull();
    expect(versionInSessionId(null)).toBeNull();
  });
});

describe("which tool list a session's client holds", () => {
  const read = toolSetVersion(asInfo("read"));
  const full = toolSetVersion(asInfo("full"));

  it("level raised: a client that listed at Look only is out of date once the connection is Full access", () => {
    const sessions = new ToolListSessions();
    const id = sessions.start("u1:org", read);
    expect(sessions.seen("u1:org", id)).toBeNull(); // not listed yet in this session
    sessions.listed("u1:org", id, read);
    expect(toolListState(read, sessions.seen("u1:org", id))).toEqual({ version: read, stale: false });
    expect(toolListState(full, sessions.seen("u1:org", id))).toEqual({ version: full, stale: true });
    sessions.listed("u1:org", id, full);
    expect(toolListState(full, sessions.seen("u1:org", id)).stale).toBe(false);
  });

  it("a session that never fetched the list may hold an old one, so it's told to refresh", () => {
    const sessions = new ToolListSessions();
    const id = sessions.start("u1:org", full);
    expect(toolListState(full, sessions.seen("u1:org", id)).stale).toBe(true);
  });

  it("deploy: after a restart a session id still says what it was offered, so a changed tool set is noticed", () => {
    const before = new ToolListSessions();
    const id = before.start("u1:org", read);
    const afterRestart = new ToolListSessions();
    expect(afterRestart.seen("u1:org", id)).toBe(read);
    expect(toolListState(read, afterRestart.seen("u1:org", id)).stale).toBe(false);
    const newRelease = toolSetVersion([...asInfo("read"), tool("get_sales_platform_status_v2")]);
    expect(toolListState(newRelease, afterRestart.seen("u1:org", id)).stale).toBe(true);
  });

  it("knows nothing without a session id of its own, and doesn't trust another person's session", () => {
    const sessions = new ToolListSessions();
    expect(sessions.seen("u1:org", null)).toBeUndefined();
    expect(sessions.seen("u1:org", "not-ours")).toBeUndefined();
    expect(toolListState(full, undefined).stale).toBe(false);
    const id = sessions.start("u1:org", read);
    sessions.listed("u1:org", id, read);
    sessions.listed("u2:org", id, full); // someone else's key sending this id changes nothing
    expect(sessions.seen("u1:org", id)).toBe(read);
    expect(sessions.seen("u2:org", id)).toBe(read); // only the id's own version
    expect(sessions.seen("u1:org", id)).toBe(read);
  });

  it("forgets the oldest sessions past its size, and unused ones after a day", () => {
    let now = 0;
    const sessions = new ToolListSessions(2, 1000, () => now);
    const a = sessions.start("u", read);
    const b = sessions.start("u", read);
    sessions.listed("u", a, full);
    sessions.listed("u", b, full);
    const c = sessions.start("u", read);
    expect(sessions.seen("u", a)).toBe(read); // forgotten: falls back to the id's own version
    expect(sessions.seen("u", b)).toBe(full);
    expect(sessions.seen("u", c)).toBeNull();
    now = 5000;
    expect(sessions.seen("u", b)).toBe(read);
  });
});

describe("telling the client", () => {
  it("sends list_changed before the answer as server-sent events", () => {
    const body = eventStreamBody([TOOLS_LIST_CHANGED, { jsonrpc: "2.0", id: 7, result: {} }]);
    expect(body).toBe(
      'event: message\ndata: {"jsonrpc":"2.0","method":"notifications/tools/list_changed"}\n\n' + 'event: message\ndata: {"jsonrpc":"2.0","id":7,"result":{}}\n\n',
    );
    expect(acceptsEventStream("application/json, text/event-stream")).toBe(true);
    expect(acceptsEventStream("application/json")).toBe(false);
    expect(acceptsEventStream(null)).toBe(false);
  });

  it("get_organisation says the list is out of date and names only the tools this connection has", () => {
    expect(toolListStatus({})).toEqual({});
    expect(toolListStatus({ toolList: { version: "v", stale: false, toolNames: ["a"] } })).toEqual({ toolListVersion: "v" });
    expect(toolListStatus({ toolList: { version: "v", stale: true, toolNames: ["get_organisation"] } })).toEqual({
      toolListVersion: "v",
      toolListUpToDate: false,
      toolListNote: STALE_TOOL_LIST_NOTE,
      toolsNow: ["get_organisation"],
    });
  });

  it("advertises listChanged, and adds the refresh note to an unknown-tool error when the list is stale", async () => {
    const server = (stale: boolean): McpServer => ({
      serverInfo: { name: "tohyee", version: "1" },
      instructions: "",
      tools: [tool("get_organisation")],
      toolList: { version: "v", stale },
      unavailableTool: (name) => (name === "unmatch_bank_lines" ? 'unmatch_bank_lines needs "Full access".' : null),
      callTool: async () => ({ content: [] }),
    });
    const init = (await handleMcpMessage({ jsonrpc: "2.0", id: 1, method: "initialize" }, server(false))) as { result: { capabilities: unknown } };
    expect(init.result.capabilities).toEqual({ tools: { listChanged: true } });
    const call = { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "unmatch_bank_lines" } };
    expect(await handleMcpMessage(call, server(false))).toMatchObject({ error: { message: 'unmatch_bank_lines needs "Full access".' } });
    expect(await handleMcpMessage(call, server(true))).toMatchObject({ error: { message: `unmatch_bank_lines needs "Full access". ${STALE_TOOL_LIST_NOTE}` } });
  });
});
