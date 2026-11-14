import { answerFor, answerToSameRequest, claimAiAction, doingHash, finishAiAction, getAiApprovalSettings, heldForApproval, previewArguments, requestAiAction, type AiActionRequest } from "@/lib/ai/action-approvals";
import { findAiTool } from "@/lib/ai/catalogue";
import { runAiTool } from "@/lib/ai/run-tool";
import { type AiTool, ToolFileAnswer, type ToolContext } from "@/lib/ai/tools";
import type { Role } from "@/lib/auth/roles";
import { type Actor, withOrganisationTransaction } from "@/lib/db/org-transaction";
import { plainDatabaseError } from "@/lib/db/plain-errors";
import { ConflictError, HttpError } from "@/lib/errors";
import type { OrganisationRecord } from "@/lib/organisations/registry";

/*
 * The two moments of an AI action a person approves (#697, decision 1633):
 * the AI's second call is held and a request left, and a person's approval
 * runs the tool.
 */

const plain = (result: unknown) => (result instanceof ToolFileAnswer ? result.answer : result);

/**
 * For the MCP server, before a tool runs: null when the call goes ahead as
 * usual, or what to answer the AI when it's left for a person. The preview
 * is worked out again here, read-only, so the person sees what the AI saw
 * and a hash that no longer matches is refused the way the tool itself would.
 */
export async function holdForApproval(
  tool: AiTool,
  organisation: OrganisationRecord,
  actor: Actor,
  context: ToolContext,
  args: Record<string, unknown>,
  key: { tokenId: string; via: string },
): Promise<Record<string, unknown> | null> {
  if (!heldForApproval(tool.name, args)) return null;
  const before = await withOrganisationTransaction(
    organisation,
    actor,
    async (tx) => ((await getAiApprovalSettings(tx)).required ? { answer: await answerToSameRequest(tx, { toolName: tool.name, tokenId: key.tokenId, args }) } : null),
    { readOnly: true },
  );
  if (!before) return null;
  if (before.answer) return before.answer;
  const sent = doingHash(args)!;
  const preview = plain(await runAiTool(tool, organisation, actor, context, previewArguments(args), { readOnly: true })) as Record<string, unknown> | null;
  const now = preview && typeof preview === "object" ? preview[sent.field] : undefined;
  // A preview that carries its hash is checked now; the tool checks again itself when a person approves.
  if (typeof now === "string" && now !== sent.value) {
    throw new ConflictError(`It has changed since the first call, or the arguments differ. Call ${tool.name} again without ${sent.field}.`);
  }
  // What the person is shown: the tool's own preview, without the hash and the "call it again" line meant for the AI.
  const shown = Object.fromEntries(Object.entries(preview ?? {}).filter(([name]) => !["confirmHash", "previewHash", "next", "preview"].includes(name)));
  return withOrganisationTransaction(organisation, actor, (tx) => requestAiAction(tx, { toolName: tool.name, title: tool.title, args, preview: shown, tokenId: key.tokenId, source: context.source, via: key.via }));
}

/**
 * A person approves: the tool runs with the arguments the AI sent, as the
 * approver (their role decides, as on the screen), noted as asked for
 * through the AI key. If things have changed since the AI asked, the tool's
 * own check refuses it and the request is marked failed; nothing is changed.
 */
export async function approveAiAction(organisation: OrganisationRecord, approver: Actor & { role: Role }, idInput: unknown): Promise<AiActionRequest & { answer: Record<string, unknown> }> {
  const claimed = await withOrganisationTransaction(organisation, approver, (tx) => claimAiAction(tx, idInput, approver.role));
  const tool = findAiTool(claimed.toolName);
  let result: { ok: true; outcome: unknown } | { ok: false; error: string };
  if (!tool) {
    result = { ok: false, error: `${claimed.toolName} is no longer a tool.` };
  } else {
    const actor: Actor = { ...approver, via: `${claimed.via}, approved in Tohyee` };
    const context: ToolContext = { role: approver.role, organisationId: organisation.id, source: claimed.source, accessLevel: "full", grantedAccessLevel: "full", organisation, actor };
    try {
      result = { ok: true, outcome: plain(await runAiTool(tool, organisation, actor, context, claimed.args)) };
    } catch (error) {
      const refused = error instanceof HttpError ? error.message : plainDatabaseError(error, `approving ${claimed.toolName}`);
      if (refused) {
        result = { ok: false, error: refused };
      } else {
        console.error("[tohyee] approving an AI action failed:", claimed.toolName, error);
        result = { ok: false, error: "Something went wrong on the Tohyee server. The server logs have the details." };
      }
    }
  }
  const finished = await withOrganisationTransaction(organisation, approver, (tx) => finishAiAction(tx, claimed.id, result));
  return { ...finished, answer: answerFor({ id: finished.id, status: finished.status, title: finished.title, decided_by_email: finished.decidedByEmail, outcome: result.ok ? result.outcome : null, error: finished.error }) };
}
