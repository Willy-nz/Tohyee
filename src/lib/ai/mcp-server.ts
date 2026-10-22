import packageJson from "../../../package.json";
import { AI_ACCESS_LEVEL_LABELS, levelAllows, roleNeededFor } from "@/lib/ai/access-levels";
import { findAiTool, toolsForLevel } from "@/lib/ai/catalogue";
import { boundedJson, MAX_TOOL_TEXT } from "@/lib/ai/limits";
import { privateMailTools } from "@/lib/ai/private-mail-tools";
import type { CallToolResult, McpServer, ToolContent } from "@/lib/ai/mcp-protocol";
import { ToolFileAnswer } from "@/lib/ai/tools";
import { aiKeyVia, type AiTokenIdentity } from "@/lib/ai/tokens";
import { type Role, roleAtLeast } from "@/lib/auth/roles";
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

export { aiKeyVia } from "@/lib/ai/tokens";

const LEVEL_WORDS = {
  read: "You can look things up but not change anything.",
  draft:
    "You can look things up, add and edit contacts, and make and edit draft invoices, bills and journals (drafts post nothing). You can't approve, post, delete, void or archive anything.",
  post:
    "You can look things up, add and edit contacts, make and edit drafts, approve invoices and bills, post draft journals and record payments. You can't delete, void, archive, roll back or refund anything.",
  full:
    "You can do everything at the \"Make and post\" level, and also reconcile bank statement lines, make and edit bank rules, make, edit and approve credit notes, quotes, sales and purchase orders and repeating invoices and bills, apply credit, record refunds, approve and pay expense claims, add and edit items, accounts, tracking, budgets and fixed assets, and run depreciation. You can't delete, void, archive, pause, roll back or dispose of anything, exclude lines or switch anything off, and anything an approval rule covers is for a person to approve. The only undo you have is unmatch_bank_line, for your own reconciliations in the last 24 hours. Work in small batches and check the results.",
} as const;

/**
 * The MCP server for one AI key: its owner's organisation, as its owner, one
 * transaction per tool call. The tools offered are the ones the key's level,
 * capped by its owner's role now, allows (decision 346). Read tools run in a
 * read-only transaction (decision 342); the others in a normal one, noted as
 * done through the key (decision 348).
 */
export function mcpServerFor(identity: AiTokenIdentity, options: { privateMail?: boolean } = {}): McpServer {
  const organisation = identity.membership.organisation;
  const level = identity.effectiveLevel;
  const roleAllows = (tool: { minRole?: Role }) => !tool.minRole || roleAtLeast(identity.membership.role, tool.minRole);
  // The Owner's own mail, only for a Look only key they gave the private-mail scope (#250, decision 618); checked again on each call.
  const mailTools = options.privateMail ? privateMailTools(identity) : [];
  const findTool = (name: unknown) => findAiTool(name) ?? mailTools.find((tool) => tool.name === name) ?? null;
  const tools = [...toolsForLevel(level).filter(roleAllows), ...mailTools];
  return {
    serverInfo: { name: "tohyee", title: "Tohyee", version: packageJson.version },
    instructions:
      `Access to ${organisation.displayName}'s books in Tohyee, a New Zealand accounting app, ` +
      `as ${identity.user.displayName} (${identity.membership.role}), at the level "${AI_ACCESS_LEVEL_LABELS[level]}". ${LEVEL_WORDS[level]} ` +
      "Call get_organisation first for the base currency, financial year and today's date. " +
      "Amounts are decimal strings; dates are YYYY-MM-DD. Before changing anything, say what you'll do and check with the person." +
      (mailTools.length
        ? ` You can also search and read ${identity.user.displayName}'s own private mail (search_my_mail, read_my_mail), for them alone: say which email you used, and never pass what's in it to anyone else or into Tohyee.`
        : ""),
    tools: tools.map((tool) => ({ ...tool, readOnly: tool.readOnly ?? tool.level === "read" })),
    unavailableTool(name) {
      const tool = findTool(name);
      if (!tool) return null;
      if (!roleAllows(tool)) return `${name} is only for owners and admins; this key's owner isn't one now.`;
      return levelAllows(level, tool.level)
        ? null
        : `${name} needs an AI key with "${AI_ACCESS_LEVEL_LABELS[tool.level]}" access and ${roleNeededFor(tool.level)}; this key is "${AI_ACCESS_LEVEL_LABELS[level]}".`;
    },
    async callTool(name, args) {
      const tool = findTool(name);
      // Checked again here: tools/list and tools/call are separate requests.
      if (!tool || !levelAllows(level, tool.level) || !roleAllows(tool)) return text(`This key can't use ${name}.`, true);
      try {
        const people = await loadMemberNames(organisation.id);
        const result = await withOrganisationTransaction(
          organisation,
          { userId: identity.user.id, email: identity.user.email, via: aiKeyVia(identity), role: identity.membership.role },
          (tx) => tool.run(tx, args, { role: identity.membership.role, organisationId: organisation.id, source: `ai-${identity.tokenId}` }),
          { people, readOnly: tool.readOnly ?? tool.level === "read" },
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
