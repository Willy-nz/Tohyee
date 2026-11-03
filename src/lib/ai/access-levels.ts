import { type Role, roleAtLeast } from "@/lib/auth/roles";

/**
 * What an AI key may do (decision 346), chosen when the key is made:
 *  read   look only
 *  draft  also make and edit drafts (invoices, bills, journals) and contacts; nothing posts
 *  post   also approve and post them, and record payments
 *  full   also reconcile bank statement lines and make and edit bank rules
 *         (decision 488), and do day-to-day accounting outside banking
 *         (decision 489, #205); only Owners make one, and it works as
 *         "post" when its owner is no longer an Owner
 * Never delete (decision 347): no level deletes, voids, archives, rolls back,
 * refunds or removes anything. The exceptions are a Full access key undoing
 * its own reconciliation within 24 hours (example AIB7) and unreconciling
 * lines after a preview, posting and voiding nothing (decision 1277, Jess).
 * Browser-safe.
 */
export const AI_ACCESS_LEVELS = ["read", "draft", "post", "full"] as const;
export type AiAccessLevel = (typeof AI_ACCESS_LEVELS)[number];

export const AI_ACCESS_LEVEL_LABELS: Record<AiAccessLevel, string> = {
  read: "Look only",
  draft: "Make drafts",
  post: "Make and post",
  full: "Full access",
};

export const AI_ACCESS_LEVEL_HELP: Record<AiAccessLevel, string> = {
  read: "It can look things up and answer questions. It can't change anything.",
  draft:
    "It can also add and edit contacts, and make and edit draft invoices, bills and journals for you to check. Drafts post nothing.",
  post:
    "It can also approve invoices and bills, post draft journals and record payments, so what it does goes into the books.",
  full:
    "It can also reconcile bank statement lines (up to 100 at a time) and make and edit bank rules; make, edit and approve credit notes, quotes, sales and purchase orders and repeating invoices and bills; apply credit and record refunds; approve and pay expense claims; add and edit items, accounts, tracking, budgets and fixed assets, and run depreciation. Anything an approval rule covers still waits for a person. It can unreconcile bank lines after showing what it will do (nothing is posted or voided), and undo only its own reconciliations, within 24 hours. Only Owners can make one.",
};

/**
 * What each level means, said to the AI: in the MCP server's instructions
 * and in get_organisation's answer, so the two always agree (#531).
 */
export const AI_ACCESS_LEVEL_AI_WORDS: Record<AiAccessLevel, string> = {
  read: "You can look things up but not change anything.",
  draft:
    "You can look things up, add and edit contacts, and make and edit draft invoices, bills and journals (drafts post nothing). You can't approve, post, delete, void or archive anything.",
  post:
    "You can look things up, add and edit contacts, make and edit drafts, approve invoices and bills, post draft journals and record payments. You can't delete, void, archive, roll back or refund anything.",
  full:
    "You can do everything at the \"Make and post\" level, and also reconcile bank statement lines, make and edit bank rules, make, edit and approve credit notes, quotes, sales and purchase orders and repeating invoices and bills, apply credit, record refunds, approve and pay expense claims, add and edit items, accounts, tracking, budgets and fixed assets, and run depreciation. You can't delete, void, archive, pause, roll back or dispose of anything, exclude lines or switch anything off, and anything an approval rule covers is for a person to approve. Your undos are unmatch_bank_line, for your own reconciliations in the last 24 hours, and unmatch_bank_lines, which unreconciles any lines (nothing posted or voided) after you've shown the person its preview. bulk_reconcile works as a batch: if an answer is lost, read it with get_bank_batch and carry on with resume_bank_batch instead of sending the actions again. Work in small batches and check the results.",
};

/** Shown before a Full access key is made; the person must tick it (decision 488). */
export const FULL_ACCESS_WARNING =
  "A Full access key can post spend money, receive money, payments, transfers, credit notes, refunds and depreciation into your books without anyone checking each one first. Anyone who gets the key can do the same, as you. Make one only for an AI you trust, keep the key secret, and revoke it when you stop using it.";

/** The same warning on the consent screen, for an AI app that signs in (#427, decision 819). */
export const FULL_ACCESS_CONNECTION_WARNING =
  "With Full access, the app can post spend money, receive money, payments, transfers, credit notes, refunds and depreciation into your books without anyone checking each one first, as you. Give it only to an AI you trust, and disconnect it when you stop using it.";

const RANK: Record<AiAccessLevel, number> = { read: 0, draft: 1, post: 2, full: 3 };

/**
 * The most a role allows: viewers look only; making drafts and contacts, and
 * approving, posting and recording payments, all need the bookkeeper role,
 * the same as the screens (the routes use "bookkeeper" for each). Full access
 * is for Owners only (decision 488).
 */
export function roleCeiling(role: Role): AiAccessLevel {
  if (roleAtLeast(role, "owner")) return "full";
  return roleAtLeast(role, "bookkeeper") ? "post" : "read";
}

/** The role a level needs, in words, for messages. */
export function roleNeededFor(level: AiAccessLevel): string {
  if (level === "full") return "the Owner role";
  return level === "read" ? "any role" : "the bookkeeper role or higher";
}

/** The key's level capped by the person's role now. */
export function effectiveAccessLevel(level: AiAccessLevel, role: Role): AiAccessLevel {
  const ceiling = roleCeiling(role);
  return RANK[level] <= RANK[ceiling] ? level : ceiling;
}

export function levelAllows(effective: AiAccessLevel, needed: AiAccessLevel): boolean {
  return RANK[effective] >= RANK[needed];
}

export function isAiAccessLevel(value: unknown): value is AiAccessLevel {
  return typeof value === "string" && (AI_ACCESS_LEVELS as readonly string[]).includes(value);
}
