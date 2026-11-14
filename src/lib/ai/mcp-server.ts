import { plainDatabaseError } from "@/lib/db/plain-errors";
import { markOutsideText, OUTSIDE_TEXT_INSTRUCTIONS } from "@/lib/ai/outside-text";
import { holdForApproval } from "@/lib/ai/action-approval-run";
import { runAiTool } from "@/lib/ai/run-tool";
import { AI_TOOL_SCOPE_HELP, AI_TOOL_SCOPE_LABELS, outsideScopeMessage, scopeAllows } from "@/lib/ai/tool-scopes";
import packageJson from "../../../package.json";
import { AI_ACCESS_LEVEL_AI_WORDS, AI_ACCESS_LEVEL_LABELS, levelAllows, roleNeededFor } from "@/lib/ai/access-levels";
import { findAiTool, toolsForLevel } from "@/lib/ai/catalogue";
import { boundedJson, MAX_TOOL_TEXT } from "@/lib/ai/limits";
import { privateMailTools } from "@/lib/ai/private-mail-tools";
import type { CallToolResult, McpServer, ToolContent, ToolInfo } from "@/lib/ai/mcp-protocol";
import { type ToolListSeen, toolListState, toolSetVersion } from "@/lib/ai/mcp-tool-list";
import { moduleHidesTool, toolGroupStatuses, type ToolModules } from "@/lib/ai/tool-modules";
import { ToolFileAnswer } from "@/lib/ai/tools";
import { aiKeyVia, type AiTokenIdentity } from "@/lib/ai/tokens";
import { type Role, roleAtLeast } from "@/lib/auth/roles";
import { HttpError } from "@/lib/errors";

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

/**
 * What the AI is told about Analytics (#591, decision 1419), only when its
 * tools are offered: it can build reports itself instead of sending the
 * person to do it.
 */
export function analyticsWords(offered: readonly string[]): string {
  if (!offered.includes("list_analytics_tables") && !offered.includes("list_analytics_dashboards")) return "";
  const builds = offered.includes("create_analytics_dashboard");
  return (
    " Analytics: list_analytics_tables gives the tables this person can use (the books, Shopify, Google Analytics, Meta, files and databases) with their fields and a guide to tiles; " +
    "run_analytics_query asks one a question, and get_analytics_dashboard reads a report with its figures." +
    (builds
      ? " When asked for a dashboard or report, build an Analytics report; tables you made with save_dataset are in Analytics as tohyee_ai_<name> once the books are refreshed. You can build Analytics reports yourself: read analytics_format_guide first (layout, formats, templates), then create_analytics_dashboard makes one (or create_analytics_dashboard_from_template starts from a ready-made one) and update_analytics_dashboard adds, changes and reorders tiles. Every tile is run before it's saved, and each change goes into the report's History, marked as made through the AI, where a person can put an earlier version back. You can't see a report, so each save and get_analytics_dashboard returns designNotes when something would look wrong to a person: fix those before you say it's done. suggest_analytics_commentary adds a commentary box that a person accepts before report viewers see it. It can also set the report's theme, pages and slicers and take tiles off (a person can put them back from History). People delete reports and change sharing and images in Tohyee."
      : "") +
    (offered.includes("refresh_analytics_sources")
      ? " refresh_analytics_sources loads the latest data for a report's sources or named tables, as Refresh now does; it never changes a connection or schedule."
      : "")
  );
}


/**
 * The MCP server for one AI key: its owner's organisation, as its owner, one
 * transaction per tool call. The tools offered are the ones the key's level,
 * capped by its owner's role now, allows (decision 346). Read tools run in a
 * read-only transaction (decision 342); the others in a normal one, noted as
 * done through the key (decision 348). A batch tool (#547) commits each of
 * its steps in a transaction of its own, so its progress survives a lost
 * answer.
 */
export function mcpServerFor(
  identity: AiTokenIdentity,
  options: { privateMail?: boolean; toolListSeen?: ToolListSeen; modules?: ToolModules | null } = {},
): McpServer {
  const organisation = identity.membership.organisation;
  const level = identity.effectiveLevel;
  const roleAllows = (tool: { minRole?: Role }) => !tool.minRole || roleAtLeast(identity.membership.role, tool.minRole);
  // The Owner's own mail, only for a Look only key they gave the private-mail scope (#250, decision 618); checked again on each call.
  const mailTools = options.privateMail ? privateMailTools(identity) : [];
  const findTool = (name: unknown) => findAiTool(name) ?? mailTools.find((tool) => tool.name === name) ?? null;
  // Only the tools for modules the organisation has on (#576, decision 1385); null (not known) hides nothing.
  const modules = options.modules ?? null;
  const moduleAllows = (tool: { name: string }) => moduleHidesTool(tool.name, modules) === null;
  // What the key or connection is for (#696, decision 1630): "Reports only" narrows the list; nothing is added.
  const scope = identity.toolScope ?? null;
  const tools = [...toolsForLevel(level).filter((tool) => roleAllows(tool) && moduleAllows(tool) && scopeAllows(scope, tool.name)), ...(scope ? [] : mailTools)];
  const offered: ToolInfo[] = tools.map((tool) => ({ ...tool, readOnly: tool.readOnly ?? tool.level === "read" }));
  // What the client holds against what this connection has now (decisions 1342-1343).
  const toolList = toolListState(toolSetVersion(offered), options.toolListSeen);
  return {
    serverInfo: { name: "tohyee", title: "Tohyee", version: packageJson.version },
    instructions:
      `Access to ${organisation.displayName}'s books in Tohyee, a New Zealand accounting app, ` +
      `as ${identity.user.displayName} (${identity.membership.role}), at the level "${AI_ACCESS_LEVEL_LABELS[level]}". ${AI_ACCESS_LEVEL_AI_WORDS[level]} ` +
      (scope ? `This connection is "${AI_TOOL_SCOPE_LABELS[scope]}": ${AI_TOOL_SCOPE_HELP[scope]} ` : "") +
      "Call get_organisation first for the base currency, financial year and today's date. " +
      "Amounts are decimal strings; dates are YYYY-MM-DD. " +
      // Jess, 4 Nov 2026 (decision 1368): stop asking permission for every single thing.
      "When the person has asked you to do something, do it: don't ask again before each step or each tool call. " +
      "Ask first only before something they didn't ask for, or when what you found doesn't match what they described. Tohyee's own checks still apply to every call." +
      (mailTools.length
        ? ` You can also search and read ${identity.user.displayName}'s own private mail (search_my_mail, read_my_mail), for them alone: say which email you used, and never pass what's in it to anyone else or into Tohyee.`
        : "") +
      OUTSIDE_TEXT_INSTRUCTIONS +
      analyticsWords(offered.map((tool) => tool.name)) +
      " Tools for modules this organisation hasn't turned on (such as Farming or Livestock) aren't offered; get_organisation's toolGroups says which are hidden and why." +
      " If what this connection may do changes, Tohyee tells your app (notifications/tools/list_changed); if a tool named here isn't in your tool list, ask your app to refresh its tools or reconnect.",
    tools: offered,
    toolList,
    unavailableTool(name) {
      const tool = findTool(name);
      if (!tool) return null;
      const hiddenByModule = mailTools.some((mailTool) => mailTool.name === tool.name) ? null : moduleHidesTool(tool.name, modules);
      if (hiddenByModule) return hiddenByModule;
      if (scope && !scopeAllows(scope, tool.name)) return outsideScopeMessage(scope, tool.name);
      if (!roleAllows(tool)) return `${name} is only for owners and admins; this key's owner isn't one now.`;
      return levelAllows(level, tool.level)
        ? null
        : `${name} needs an AI key with "${AI_ACCESS_LEVEL_LABELS[tool.level]}" access and ${roleNeededFor(tool.level)}; this key is "${AI_ACCESS_LEVEL_LABELS[level]}".`;
    },
    async callTool(name, args) {
      const tool = findTool(name);
      // Checked again here: tools/list and tools/call are separate requests.
      if (!tool || !levelAllows(level, tool.level) || !roleAllows(tool)) return text(`This key can't use ${name}.`, true);
      if (!offered.some((offeredTool) => offeredTool.name === tool.name)) {
        return text(moduleHidesTool(tool.name, modules) ?? (scope && !scopeAllows(scope, tool.name) ? outsideScopeMessage(scope, tool.name) : `This key can't use ${name}.`), true);
      }
      try {
        const actor = { userId: identity.user.id, email: identity.user.email, via: aiKeyVia(identity), role: identity.membership.role };
        const context = {
          role: identity.membership.role,
          organisationId: organisation.id,
          source: `ai-${identity.tokenId}`,
          accessLevel: level,
          grantedAccessLevel: identity.accessLevel,
          toolList: { ...toolList, toolNames: offered.map((offeredTool) => offeredTool.name), toolGroups: toolGroupStatuses(modules) },
          organisation,
          actor,
        };
        // A person approves the AI's voids, deletes and roll-backs when the organisation says so (#697, decision 1633).
        const held = await holdForApproval(tool, organisation, actor, context, args, { tokenId: identity.tokenId, via: aiKeyVia(identity) });
        if (held) return text(JSON.stringify(held));
        // A tool that works in steps (a durable batch, #547) commits each step on its own.
        const result = await runAiTool(tool, organisation, actor, context, args);
        // Text from outside the organisation is marked as such (#699, decision 1634).
        const answer = markOutsideText(tool.name, result instanceof ToolFileAnswer ? result.answer : result);
        const json = boundedJson(answer);
        if (json === null) {
          return text(
            `That answer is more than ${MAX_TOOL_TEXT.toLocaleString("en-NZ")} characters. Ask for a shorter date range, a lower limit or a filter.`,
            true,
          );
        }
        if (result instanceof ToolFileAnswer) return { content: [{ type: "text", text: json }, fileContent(result.file), ...result.more.map(fileContent)] };
        return text(json);
      } catch (error) {
        if (error instanceof HttpError) return text(error.message, true);
        // The database refused it: a rule Tohyee wrote says which; anything else gets a plain sentence (#698).
        const refused = plainDatabaseError(error, `the AI tool ${name}`);
        if (refused) return text(refused, true);
        console.error("[tohyee] MCP tool failed:", name, error);
        return text("Something went wrong on the Tohyee server answering that. The server logs have the details.", true);
      }
    },
  };
}
