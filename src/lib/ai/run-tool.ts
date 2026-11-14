import type { AiTool, ToolContext } from "@/lib/ai/tools";
import { type Actor, withOrganisationTransaction } from "@/lib/db/org-transaction";
import type { OrganisationRecord } from "@/lib/organisations/registry";
import { loadMemberNames } from "@/lib/people/names";

/**
 * Runs one AI tool the way the MCP server does: in a transaction of the
 * organisation's as the actor (read-only for a read tool), or step by step
 * for a tool that commits as it goes (#547). `readOnly` forces a read-only
 * transaction, for showing a preview without any chance of a change.
 */
export async function runAiTool(
  tool: AiTool,
  organisation: OrganisationRecord,
  actor: Actor,
  context: ToolContext,
  args: Record<string, unknown>,
  options: { readOnly?: boolean } = {},
): Promise<unknown> {
  const people = await loadMemberNames(organisation.id);
  const readOnly = options.readOnly ?? tool.readOnly ?? tool.level === "read";
  return tool.runSteps
    ? tool.runSteps((work) => withOrganisationTransaction(organisation, actor, work, { people, readOnly }), args, context)
    : withOrganisationTransaction(organisation, actor, (tx) => tool.run(tx, args, context), { people, readOnly });
}
