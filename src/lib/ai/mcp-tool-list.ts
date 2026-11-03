import { createHash, randomBytes } from "node:crypto";
import type { JsonRpcResponse, ToolInfo } from "@/lib/ai/mcp-protocol";

/**
 * Keeping an AI client's tool list current (decisions 1342-1344).
 *
 * Tohyee's MCP endpoint is stateless HTTP POST with no GET event stream, so
 * it can't push a message to a client that isn't asking for something. What
 * it can do, under the 2025-03-26 to 2025-11-25 Streamable HTTP rules, is:
 *
 *  - give the client a session id (`Mcp-Session-Id`) at `initialize`, which
 *    the client must send back on every later request;
 *  - remember, for that session, which tool set the client last fetched with
 *    `tools/list` (the "tool-set version", a hash of every tool's name,
 *    title, description and schema);
 *  - when the tools this connection may use now differ from that version (its
 *    level or the person's role changed, the private-mail scope changed, or a
 *    new release changed the tools), answer the client's next request as an
 *    event stream that carries `notifications/tools/list_changed` before the
 *    answer, so the client fetches the list again.
 *
 * The memory is in this process only. After a restart (a deploy) a session id
 * still says which version the client saw at `initialize`, so a release that
 * changes the tools is still noticed. Nothing here decides what a client may
 * do: every tools/call is checked against the connection's level and role
 * now (decision 346), whatever list the client holds.
 */

/** The notification the MCP spec defines for a changed tool list. */
export const TOOLS_LIST_CHANGED = { jsonrpc: "2.0", method: "notifications/tools/list_changed" } as const;

/** Version of the session id format, so a future change can tell old ids apart. */
const SESSION_PREFIX = "tsv1";
const SESSION_PATTERN = /^tsv1\.([0-9a-f]{16})\.[A-Za-z0-9_-]{22}$/;

/** A short hash of everything a client keeps from tools/list. Same tools, same version, in any order. */
export function toolSetVersion(tools: readonly ToolInfo[]): string {
  const canonical = [...tools]
    .map((tool) => [tool.name, tool.title, tool.description, tool.readOnly !== false, tool.inputSchema] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex").slice(0, 16);
}

/** A new session id: the tool-set version at initialize, then 128 random bits. Visible ASCII only. */
export function newSessionId(version: string): string {
  return `${SESSION_PREFIX}.${version}.${randomBytes(16).toString("base64url")}`;
}

/** The version a session id was made with, or null for an id Tohyee didn't make. */
export function versionInSessionId(sessionId: string | null): string | null {
  const match = sessionId ? SESSION_PATTERN.exec(sessionId.trim()) : null;
  return match ? match[1] : null;
}

/**
 * What Tohyee knows about the tool list a client holds:
 *  undefined  nothing (no session id, or one Tohyee didn't make)
 *  null       this session hasn't fetched the list: it may be using one from earlier
 *  string     the version it fetched last
 */
export type ToolListSeen = string | null | undefined;

export type ToolListState = {
  /** The tool-set version this connection has now. */
  version: string;
  /** True when the client's list is known to differ from `version` (or wasn't fetched this session). */
  stale: boolean;
};

export function toolListState(version: string, seen: ToolListSeen): ToolListState {
  return { version, stale: seen !== undefined && seen !== version };
}

/** Said to the AI (get_organisation, refused calls) when its tool list is out of date. */
export const STALE_TOOL_LIST_NOTE =
  "Your tool list is out of date: what this connection may do, or Tohyee's tools, changed since your app last fetched it. Ask your app to refresh its tools (fetch tools/list again), or disconnect and reconnect Tohyee. Tohyee still checks every call against what this connection may do now.";

type SessionEntry = { owner: string; listed: string | null; touched: number };

/**
 * Which tool-set version each session last fetched, in memory. Bounded: the
 * oldest sessions go first, and a session unused for a day is forgotten.
 * Entries are tied to the person and organisation that made them, so a
 * session id sent with someone else's key is treated as unknown.
 */
export class ToolListSessions {
  private readonly entries = new Map<string, SessionEntry>();

  constructor(
    private readonly maxSessions = 5000,
    private readonly ttlMs = 24 * 60 * 60 * 1000,
    private readonly now: () => number = Date.now,
  ) {}

  /** A new session at initialize: the client hasn't fetched the list yet. */
  start(owner: string, version: string): string {
    const id = newSessionId(version);
    this.put(id, { owner, listed: null, touched: this.now() });
    return id;
  }

  /** The client fetched tools/list in this session and got `version`. */
  listed(owner: string, sessionId: string | null, version: string): void {
    if (!sessionId || versionInSessionId(sessionId) === null) return;
    const existing = this.entries.get(sessionId);
    if (existing && existing.owner !== owner) return; // someone else's session: leave it alone
    this.put(sessionId, { owner, listed: version, touched: this.now() });
  }

  /** What this session's client holds, as far as Tohyee knows. */
  seen(owner: string, sessionId: string | null): ToolListSeen {
    const fromId = versionInSessionId(sessionId);
    if (!sessionId || fromId === null) return undefined;
    const entry = this.entries.get(sessionId);
    if (entry && entry.owner === owner && this.now() - entry.touched <= this.ttlMs) {
      entry.touched = this.now();
      return entry.listed;
    }
    // Not remembered (a restart, another process, or long unused): the best
    // guess is what it was offered at initialize.
    return fromId;
  }

  private put(id: string, entry: SessionEntry): void {
    this.entries.delete(id);
    this.entries.set(id, entry);
    const cutoff = this.now() - this.ttlMs;
    for (const [key, value] of this.entries) {
      if (this.entries.size <= this.maxSessions && value.touched >= cutoff) break;
      this.entries.delete(key);
    }
  }
}

/** True when the client said it can read an event stream (Streamable HTTP clients must). */
export function acceptsEventStream(accept: string | null): boolean {
  return (accept ?? "").toLowerCase().includes("text/event-stream");
}

/** Server-sent events: each JSON-RPC message as one `message` event. */
export function eventStreamBody(messages: readonly (JsonRpcResponse | typeof TOOLS_LIST_CHANGED)[]): string {
  return messages.map((message) => `event: message\ndata: ${JSON.stringify(message)}\n\n`).join("");
}
