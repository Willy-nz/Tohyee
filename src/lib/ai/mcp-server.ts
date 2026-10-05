import packageJson from "../../../package.json";
import { AI_ACCESS_LEVEL_LABELS, levelAllows } from "@/lib/ai/access-levels";
import { findAiTool, toolsForLevel } from "@/lib/ai/catalogue";
import { boundedJson, MAX_TOOL_TEXT } from "@/lib/ai/limits";
import type { CallToolResult, McpServer, ToolContent } from "@/lib/ai/mcp-protocol";
import { ToolFileAnswer } from "@/lib/ai/tools";
import type { AiTokenIdentity } from "@/lib/ai/tokens";
import { withOrganisationTransaction } from "@/lib/db/org-transaction";
import { HttpError } from "@/lib/errors";
import { loadMemberNames } from "@/lib/people/names";

function text(value: string, isError = false): CallToolResult {
  return isError ? { content: [{ type: "text", text: value }], isError: true } : { content: [{ type: "text", text: value }] };
}

/** A file as MCP content: pictures the AI can see as images, PDFs and HEIC as an embedded resource. */
function fileContent(file: ToolFileAnswer["file"]): ToolContent {
  const data = file.content.toString("base64");
  return file.contentType === "image/jpeg" || file.contentType === "image/png"
    ? { type: "image", data, mimeType: file.contentType }
    : { type: "resource", resource: { uri: file.uri, mimeType: file.contentType, blob: data } };
}

/** How an AI key shows in the history and on drafts: AI key "Claude on my laptop". */
export function aiKeyVia(identity: Pick<AiTokenIdentity, "tokenName">): string {
  return `AI key "${identity.tokenName}"`;
}

const LEVEL_WORDS = {
  read: "You can look things up but not change anything.",
  draft:
    "You can look things up, add and edit contacts, and make and edit draft invoices, bills and journals (drafts post nothing). You can't approve, post, delete, void or archive anything.",
  post:
    "You can look things up, add and edit contacts, make and edit drafts, approve invoices and bills, post draft journals and record payments. You can't delete, void, archive, roll back or refund anything.",
} as const;

/**
 * The MCP server for one AI key: its owner's organisation, as its owner, one
 * transaction per tool call. The tools offered are the ones the key's level,
 * capped by its owner's role now, allows (decision 346). Read tools run in a
 * read-only transaction (decision 342); the others in a normal one, noted as
 * done through the key (decision 348).
 */
export function mcpServerFor(identity: AiTokenIdentity): McpServer {
  const organisation = identity.membership.organisation;
  const level = identity.effectiveLevel;
  const tools = toolsForLevel(level);
  return {
    serverInfo: { name: "tohyee", title: "Tohyee", version: packageJson.version },
    instructions:
      `Access to ${organisation.displayName}'s books in Tohyee, a New Zealand accounting app, ` +
      `as ${identity.user.displayName} (${identity.membership.role}), at the level "${AI_ACCESS_LEVEL_LABELS[level]}". ${LEVEL_WORDS[level]} ` +
      "Call get_organisation first for the base currency, financial year and today's date. " +
      "Amounts are decimal strings; dates are YYYY-MM-DD. Before changing anything, say what you'll do and check with the person.",
    tools: tools.map((tool) => ({ ...tool, readOnly: tool.level === "read" })),
    unavailableTool(name) {
      const tool = findAiTool(name);
      if (!tool) return null;
      return levelAllows(level, tool.level)
        ? null
        : `${name} needs an AI key with "${AI_ACCESS_LEVEL_LABELS[tool.level]}" access and the bookkeeper role or higher; this key is "${AI_ACCESS_LEVEL_LABELS[level]}".`;
    },
    async callTool(name, args) {
      const tool = findAiTool(name);
      // Checked again here: tools/list and tools/call are separate requests.
      if (!tool || !levelAllows(level, tool.level)) return text(`This key can't use ${name}.`, true);
      try {
        const people = await loadMemberNames(organisation.id);
        const result = await withOrganisationTransaction(
          organisation,
          { userId: identity.user.id, email: identity.user.email, via: aiKeyVia(identity) },
          (tx) => tool.run(tx, args, { role: identity.membership.role, organisationId: organisation.id, source: `ai-${identity.tokenId}` }),
          { people, readOnly: tool.level === "read" },
        );
        const answer = result instanceof ToolFileAnswer ? result.answer : result;
        const json = boundedJson(answer);
        if (json === null) {
          return text(
            `That answer is more than ${MAX_TOOL_TEXT.toLocaleString("en-NZ")} characters. Ask for a shorter date range, a lower limit or a filter.`,
            true,
          );
        }
        if (result instanceof ToolFileAnswer) return { content: [{ type: "text", text: json }, fileContent(result.file)] };
        return text(json);
      } catch (error) {
        if (error instanceof HttpError) return text(error.message, true);
        const pgCode = (error as { code?: unknown })?.code;
        if (typeof pgCode === "string" && /^(23|22|P0)/.test(pgCode) && error instanceof Error) {
          // The database refused it (a rule it enforces); the message says which.
          return text(error.message, true);
        }
        console.error("[tohyee] MCP tool failed:", name, error);
        return text("Something went wrong on the Tohyee server answering that. The server logs have the details.", true);
      }
    },
  };
}
