import packageJson from "../../../package.json";
import { boundedJson, MAX_TOOL_TEXT } from "@/lib/ai/limits";
import type { CallToolResult, McpServer } from "@/lib/ai/mcp-protocol";
import type { AiTokenIdentity } from "@/lib/ai/tokens";
import { AI_TOOLS, findAiTool } from "@/lib/ai/tools";
import { withOrganisationTransaction } from "@/lib/db/org-transaction";
import { HttpError } from "@/lib/errors";
import { loadMemberNames } from "@/lib/people/names";

function text(value: string, isError = false): CallToolResult {
  return isError ? { content: [{ type: "text", text: value }], isError: true } : { content: [{ type: "text", text: value }] };
}

/**
 * The MCP server for one AI key: its owner's organisation, as its owner, in
 * a read-only transaction per tool call (decision 342).
 */
export function mcpServerFor(identity: AiTokenIdentity): McpServer {
  const organisation = identity.membership.organisation;
  return {
    serverInfo: { name: "tohyee", title: "Tohyee", version: packageJson.version },
    instructions:
      `Read-only access to ${organisation.displayName}'s books in Tohyee, a New Zealand accounting app, ` +
      `as ${identity.user.displayName} (${identity.membership.role}). You can look things up but not change anything. ` +
      "Call get_organisation first for the base currency, financial year and today's date. " +
      "Amounts are decimal strings; dates are YYYY-MM-DD.",
    tools: AI_TOOLS,
    async callTool(name, args) {
      const tool = findAiTool(name);
      if (!tool) return text(`Unknown tool: ${name}.`, true);
      try {
        const people = await loadMemberNames(organisation.id);
        const result = await withOrganisationTransaction(
          organisation,
          { userId: identity.user.id, email: identity.user.email },
          (tx) => tool.run(tx, args, { role: identity.membership.role, organisationId: organisation.id }),
          { people, readOnly: true },
        );
        const json = boundedJson(result);
        if (json === null) {
          return text(
            `That answer is more than ${MAX_TOOL_TEXT.toLocaleString("en-NZ")} characters. Ask for a shorter date range, a lower limit or a filter.`,
            true,
          );
        }
        return text(json);
      } catch (error) {
        if (error instanceof HttpError) return text(error.message, true);
        console.error("[tohyee] MCP tool failed:", name, error);
        return text("Something went wrong on the Tohyee server answering that. The server logs have the details.", true);
      }
    },
  };
}
