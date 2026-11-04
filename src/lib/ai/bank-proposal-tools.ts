import { randomBytes } from "node:crypto";
import { BANK_ACCOUNT_CODE, BANK_ACCOUNT_ID, accountFromArgs, namesAccount } from "@/lib/ai/account-ref";
import { boundedLimit, CURSOR, limitInput, pageByOffset } from "@/lib/ai/limits";
import { GST_EVIDENCE_FIELD } from "@/lib/ai/gst-evidence";
import { type AiTool, type JsonSchema, schema } from "@/lib/ai/tools";
import { PROPOSAL_FILTERS } from "@/lib/bank/coding-proposal-words";
import { getProposal, listProposals, MAX_PROPOSAL_ROWS, type Proposal, proposeBankCoding } from "@/lib/bank/coding-proposals";
import { requireIdempotencyKey } from "@/lib/validation";

/**
 * Bank coding proposals for a connected AI (#544, decisions 1292-1299):
 * a "Make drafts" key (or higher) can propose coding for statement lines
 * for a person to review; nothing is posted or reconciled. Only a person
 * approves, edits or rejects, in Tohyee. The read tools are for any key.
 */

const ID = (what: string): JsonSchema => ({ type: "string", description: `The ${what}'s id.` });

/** What an AI sees of a proposal: never "approved" unless a person approved it. */
function proposalView(proposal: Proposal) {
  return {
    proposalId: proposal.id,
    accountId: proposal.accountId,
    account: `${proposal.accountCode} ${proposal.accountName}`,
    note: proposal.note,
    createdAt: proposal.createdAt,
    counts: proposal.counts,
    totals: proposal.totals,
    refused: proposal.refused,
    filter: proposal.filter,
    rows: proposal.rows.map((row) => ({
      rowId: row.id,
      lineId: row.lineId,
      line: row.line,
      contactId: row.contactId,
      contactName: row.contactName,
      accountCode: row.accountCode,
      taxCode: row.taxCode,
      description: row.description,
      amount: row.amount,
      confidence: row.confidence,
      gstEvidence: row.gstEvidence,
      state: row.state,
      reviewedByPerson: row.reviewed,
      problems: row.problems.map((problem) => problem.text),
      error: row.error,
    })),
    next: "A person reviews this in Tohyee (the bank account's Proposals tab) and approves, edits or rejects each row. Nothing is posted until they approve.",
  };
}

export const BANK_PROPOSAL_READ_TOOLS: readonly AiTool[] = [
  {
    name: "list_bank_coding_proposals",
    title: "Bank coding proposals",
    level: "read",
    description: "Bank coding proposals, newest first, optionally for one bank account (accountId or accountCode), with how many rows are proposed, approved (waiting to post), posted, failed and rejected.",
    inputSchema: schema({ accountId: BANK_ACCOUNT_ID, accountCode: BANK_ACCOUNT_CODE, limit: limitInput(20, 100), cursor: CURSOR }),
    async run(tx, args) {
      const accountId = namesAccount(args) ? (await accountFromArgs(tx, args, { bank: true })).id : undefined;
      const page = await pageByOffset(args.cursor, boundedLimit(args.limit, 20, 100), (offset, limit) => listProposals(tx, { accountId, limit, offset }));
      return { proposals: page.rows, more: page.more, nextCursor: page.nextCursor };
    },
  },
  {
    name: "get_bank_coding_proposal",
    title: "One bank coding proposal",
    level: "read",
    description:
      "A bank coding proposal's rows with each one's state (proposed, approved = waiting to post, posted, failed, rejected), whether a person has reviewed it, and why an open row can't be approved as it is (stale: the line changed since; a locked period; GST). Totals by account and by tax code. filter: a state, or attention for open rows with a problem.",
    inputSchema: schema({ proposalId: ID("proposal"), filter: { type: "string", enum: [...PROPOSAL_FILTERS] } }, ["proposalId"]),
    async run(tx, args) {
      return proposalView(await getProposal(tx, args.proposalId, { filter: args.filter }));
    },
  },
];

export const BANK_PROPOSAL_WRITE_TOOLS: readonly AiTool[] = [
  {
    name: "propose_bank_coding",
    title: "Propose bank coding",
    level: "draft",
    description: `Proposes coding for up to ${MAX_PROPOSAL_ROWS} unreconciled statement lines on one bank account, for a person to review. Nothing is posted or reconciled: a person approves, edits or rejects each row in Tohyee, and only then is spend or receive money posted (for the line's full amount, GST inclusive with a tax code) and the line reconciled. Each row: lineId, contactId, accountCode, taxCode (null for no GST), and optionally description, rationale (why), confidence (0 to 1), gstEvidence and evidence (what supports it, e.g. "Receipt in the bills inbox"). A row the person can't approve as it is (no GST evidence while registered) is still kept and shown as needing a look. Rows that can't be kept (line reconciled or already in an open proposal, unknown contact or account) are listed in refused. Send the same idempotencyKey to retry; you can't approve your own proposal.`,
    inputSchema: schema(
      {
        accountId: BANK_ACCOUNT_ID,
        accountCode: BANK_ACCOUNT_CODE,
        note: { type: "string", description: "A short note for the reviewer." },
        rows: {
          type: "array",
          minItems: 1,
          maxItems: MAX_PROPOSAL_ROWS,
          items: {
            type: "object",
            properties: {
              lineId: ID("statement line"),
              contactId: { type: "string", description: "From list_contacts." },
              accountCode: { type: "string", description: "From list_accounts." },
              taxCode: { type: ["string", "null"], description: "A GST code, e.g. GST, ZERO, EXEMPT, or null for none." },
              description: { type: "string" },
              amount: { type: "string", description: "Optional: the line's full amount without its sign. Splits aren't proposed." },
              rationale: { type: "string", description: "Why this coding, in a sentence." },
              confidence: { type: "string", description: "How sure, from 0 to 1, e.g. \"0.85\"." },
              gstEvidence: GST_EVIDENCE_FIELD,
              evidence: { type: "string", description: "What supports it, e.g. the receipt or what the person said." },
            },
            required: ["lineId", "contactId", "accountCode"],
          },
        },
        idempotencyKey: { type: "string", pattern: "^[A-Za-z0-9._:-]{8,120}$", description: "Send the same key if you retry the same call. Made up for you if left out." },
      },
      ["rows"],
    ),
    async run(tx, args, context) {
      const key = args.idempotencyKey === undefined || args.idempotencyKey === null || args.idempotencyKey === "" ? `ai-${randomBytes(12).toString("hex")}` : requireIdempotencyKey(args.idempotencyKey);
      const account = await accountFromArgs(tx, args, { bank: true });
      const { proposal, created } = await proposeBankCoding(tx, { accountId: account.id, rows: args.rows, note: args.note, idempotencyKey: key, source: context.source });
      return { created, ...proposalView(proposal) };
    },
  },
];
