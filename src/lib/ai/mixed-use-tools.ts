import { randomBytes } from "node:crypto";
import { batchAnswer, savepointRunner } from "@/lib/ai/bank-tools";
import { GST_EVIDENCE_FIELD } from "@/lib/ai/gst-evidence";
import { type AiTool, type JsonSchema, schema } from "@/lib/ai/tools";
import { listAccountUsage, listReviewLines, MAX_REVIEW_ACTIONS, REVIEW_STATES, reviewLine, startReviewBatch, undoReview } from "@/lib/bank/mixed-use";
import { REVIEW_DECISIONS } from "@/lib/bank/mixed-use-rules";
import { ValidationError } from "@/lib/errors";
import { requireIdempotencyKey } from "@/lib/validation";

/**
 * Personal and mixed-use accounts for a connected AI (#545, MU14). Any key
 * can look; only a Full access key reviews lines, the same review a person
 * makes (so it posts what the screen would), with the GST evidence rules of
 * GSR10. It undoes only its own reviews within 24 hours (as AIB8). No key
 * changes how an account is used: that's an admin's setting.
 */

const IDEMPOTENCY: JsonSchema = {
  type: "string",
  pattern: "^[A-Za-z0-9._:-]{8,80}$",
  description: "8-80 letters, numbers, dots, colons, dashes or underscores. The same key on a retry, so nothing is posted twice. Made up for you if left out.",
};

function key(input: unknown): string {
  if (input === undefined || input === null || input === "") return `ai-${randomBytes(12).toString("hex")}`;
  const value = requireIdempotencyKey(input);
  if (value.length > 80) throw new ValidationError("idempotencyKey must be at most 80 characters.");
  return value;
}

const REVIEW_FIELDS: Record<string, JsonSchema> = {
  lineId: { type: "string", description: "The statement line's id, from list_mixed_use_lines." },
  decision: {
    type: "string",
    enum: [...REVIEW_DECISIONS],
    description:
      "Money out: business (all of it), split (businessAmount is business, the rest private) or private. Money in: refund (of a purchase reviewed as business or split, refundOfLineId) or private (a card repayment or household money). Only say business with evidence it's the business's: a merchant's name isn't enough.",
  },
  businessAmount: { type: "string", description: "For split: the business part, without a sign." },
  contactId: { type: "string", description: "Who it was from (list_contacts). For a refund, left out: the original's." },
  lines: {
    type: "array",
    minItems: 1,
    maxItems: 20,
    description: "The business part, GST inclusive, adding up to it. A refund uses the original's accounts and tax codes.",
    items: {
      type: "object",
      properties: {
        accountCode: { type: "string" },
        taxCode: { type: ["string", "null"] },
        amount: { type: "string" },
        description: { type: "string" },
      },
      required: ["accountCode", "amount"],
    },
  },
  refundOfLineId: { type: "string", description: "For refund: the purchase line it refunds." },
  notDuplicate: { type: "boolean", description: "True only when the person said a line flagged as a possible duplicate is a separate purchase." },
  gstEvidence: GST_EVIDENCE_FIELD,
};

export const MIXED_USE_READ_TOOLS: readonly AiTool[] = [
  {
    name: "list_mixed_use_lines",
    title: "Lines on personal and mixed-use accounts",
    level: "read",
    description:
      "How each bank and card account is used (business only, mixed use or personal), and, with accountId, a mixed-use or personal account's lines with their reviews. Those lines are reviewed (business, private, split or refund), never reconciled. A business part is spend money plus an owner journal, so the account's balance in the books stays 0.00. state: to_review (default), reviewed, excluded or all.",
    inputSchema: schema({
      accountId: { type: "string" },
      state: { type: "string", enum: [...REVIEW_STATES] },
      search: { type: "string" },
      limit: { type: "integer", minimum: 1, maximum: 200 },
    }),
    async run(tx, args) {
      if (args.accountId == null || args.accountId === "") {
        return { accounts: (await listAccountUsage(tx)).filter((account) => account.usage !== "business"), note: "Accounts not listed are business only: reconcile them with the bank tools." };
      }
      return listReviewLines(tx, args.accountId, { state: args.state, search: args.search, limit: args.limit ?? 50 });
    },
  },
];

export const MIXED_USE_WRITE_TOOLS: readonly AiTool[] = [
  {
    name: "review_mixed_use_line",
    title: "Review a line on a mixed-use account",
    level: "full",
    description:
      "Reviews one line on a mixed-use or personal account, as a person does in Tohyee: business or split posts spend money and an owner journal on the line's date; refund posts receive money the other way; private posts nothing. GST needs gstEvidence while registered (unconfirmed registration: only no_gst_supply). Refused in a locked period.",
    inputSchema: schema({ ...REVIEW_FIELDS, idempotencyKey: IDEMPOTENCY }, ["lineId", "decision"]),
    async run(tx, args, context) {
      const { lineId, ...rest } = args;
      return reviewLine(tx, lineId, { ...rest, source: context.source, idempotencyKey: key(args.idempotencyKey) }, { ai: true });
    },
  },
  {
    name: "review_mixed_use_lines",
    title: "Review many lines on mixed-use accounts",
    level: "full",
    description: `Up to ${MAX_REVIEW_ACTIONS} reviews in one call, each with review_mixed_use_line's fields. Each is done or refused on its own. It's a batch: after a lost answer, read it with get_bank_batch and carry on with resume_bank_batch rather than sending it again.`,
    inputSchema: schema(
      {
        actions: { type: "array", minItems: 1, maxItems: MAX_REVIEW_ACTIONS, items: { type: "object", properties: REVIEW_FIELDS, required: ["lineId", "decision"] } },
        idempotencyKey: IDEMPOTENCY,
      },
      ["actions"],
    ),
    async runSteps(run, args, context) {
      return batchAnswer(await startReviewBatch(run, { actions: args.actions, idempotencyKey: key(args.idempotencyKey), source: context.source, byAi: true }));
    },
    async run(tx, args, context) {
      return batchAnswer(await startReviewBatch(savepointRunner(tx), { actions: args.actions, idempotencyKey: key(args.idempotencyKey), source: context.source, byAi: true }));
    },
  },
  {
    name: "unreview_mixed_use_line",
    title: "Undo your own review",
    level: "full",
    description:
      "Undoes a review this same connection made in the last 24 hours, in an unlocked period: what it posted is voided on the line's date and the line goes back to review. A person's review, another connection's, or an older one is for a person to undo in Tohyee.",
    inputSchema: schema({ lineId: { type: "string" }, idempotencyKey: IDEMPOTENCY }, ["lineId"]),
    async run(tx, args, context) {
      return undoReview(tx, args.lineId, { source: context.source, idempotencyKey: key(args.idempotencyKey) }, { onlySource: context.source, withinHours: 24 });
    },
  },
];
