/**
 * The Model Context Protocol (MCP) as Tohyee speaks it (decision 344):
 * JSON-RPC 2.0 messages over HTTP POST, in the "Streamable HTTP" transport's
 * simplest stateless form. Each POST gets one application/json answer; there
 * are no sessions and no server-sent event streams. Only tools are offered.
 *
 * Pure: no database. `/api/mcp` authenticates and supplies the tools.
 */

/**
 * Protocol versions Tohyee answers to. A client asking for one of these gets
 * it back; anything else gets FALLBACK_PROTOCOL_VERSION, the one this was
 * written against, and the client decides whether to carry on.
 */
export const SUPPORTED_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"] as const;
export const FALLBACK_PROTOCOL_VERSION = "2025-06-18";

export const JSON_RPC = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  /** Not standard JSON-RPC: used in the body of a 401. */
  UNAUTHORIZED: -32001,
} as const;

export type JsonRpcId = string | number | null;

export type JsonRpcResponse =
  | { jsonrpc: "2.0"; id: JsonRpcId; result: unknown }
  | { jsonrpc: "2.0"; id: JsonRpcId; error: { code: number; message: string; data?: unknown } };

export type ToolInfo = {
  name: string;
  /** False for a tool that changes the books. */
  readOnly?: boolean;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

/**
 * A tool's answer: text, and for a tool that hands over a file (BI4, the
 * bills inbox) the file itself, as an image (JPG, PNG) or an embedded
 * resource with its bytes (PDF, HEIC), both base64.
 */
export type ToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: "resource"; resource: { uri: string; mimeType: string; blob: string } };

export type CallToolResult = {
  content: ToolContent[];
  isError?: boolean;
};

export type McpServer = {
  serverInfo: { name: string; title?: string; version: string };
  instructions: string;
  tools: readonly ToolInfo[];
  /** Why a tool that exists isn't offered to this caller, or null. */
  unavailableTool?(name: string): string | null;
  callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult>;
};

export function negotiateProtocolVersion(requested: unknown): string {
  return typeof requested === "string" && (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested)
    ? requested
    : FALLBACK_PROTOCOL_VERSION;
}

/** The MCP-Protocol-Version header on later requests: missing is fine, unknown isn't. */
export function protocolHeaderAccepted(header: string | null): boolean {
  return header === null || header.trim() === "" || (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(header.trim());
}

export function rpcError(id: JsonRpcId, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function rpcResult(id: JsonRpcId, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function isId(value: unknown): value is string | number {
  return typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}

/**
 * Answers one JSON-RPC message. Returns null for notifications and for
 * responses the client sends back (nothing to answer: the HTTP reply is 202).
 */
export async function handleMcpMessage(message: unknown, server: McpServer): Promise<JsonRpcResponse | null> {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return rpcError(null, JSON_RPC.INVALID_REQUEST, "Each message must be a JSON-RPC 2.0 object.");
  }
  const record = message as Record<string, unknown>;
  const hasId = "id" in record && isId(record.id);
  const id: JsonRpcId = hasId ? (record.id as string | number) : null;
  if (record.jsonrpc !== "2.0") {
    return rpcError(id, JSON_RPC.INVALID_REQUEST, 'jsonrpc must be "2.0".');
  }
  if (typeof record.method !== "string") {
    // A response or error from the client (we never ask it anything), or junk.
    return "result" in record || "error" in record ? null : rpcError(id, JSON_RPC.INVALID_REQUEST, "method is required.");
  }
  if (!hasId) {
    // A notification (e.g. notifications/initialized, notifications/cancelled): nothing to answer.
    return null;
  }
  const params = record.params && typeof record.params === "object" && !Array.isArray(record.params) ? (record.params as Record<string, unknown>) : {};

  switch (record.method) {
    case "initialize":
      return rpcResult(id, {
        protocolVersion: negotiateProtocolVersion(params.protocolVersion),
        capabilities: { tools: { listChanged: false } },
        serverInfo: server.serverInfo,
        instructions: server.instructions,
      });
    case "ping":
      return rpcResult(id, {});
    case "tools/list":
      return rpcResult(id, {
        tools: server.tools.map((tool) => ({
          name: tool.name,
          title: tool.title,
          description: tool.description,
          inputSchema: tool.inputSchema,
          annotations: {
            title: tool.title,
            readOnlyHint: tool.readOnly !== false,
            // No tool deletes, voids or archives anything (decision 347).
            destructiveHint: false,
            idempotentHint: tool.readOnly !== false,
            openWorldHint: false,
          },
        })),
      });
    case "tools/call": {
      const name = params.name;
      if (typeof name !== "string" || !server.tools.some((tool) => tool.name === name)) {
        const reason = typeof name === "string" ? server.unavailableTool?.(name) : null;
        return rpcError(id, JSON_RPC.INVALID_PARAMS, reason ?? `Unknown tool: ${typeof name === "string" ? name : "(none)"}.`);
      }
      const args = params.arguments ?? {};
      if (!args || typeof args !== "object" || Array.isArray(args)) {
        return rpcError(id, JSON_RPC.INVALID_PARAMS, "arguments must be an object.");
      }
      return rpcResult(id, await server.callTool(name, args as Record<string, unknown>));
    }
    case "resources/list":
      return rpcResult(id, { resources: [] });
    case "prompts/list":
      return rpcResult(id, { prompts: [] });
    default:
      return rpcError(id, JSON_RPC.METHOD_NOT_FOUND, `Tohyee doesn't support ${record.method}.`);
  }
}
