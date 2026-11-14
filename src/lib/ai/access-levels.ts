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
    "It can also add and edit contacts, make and edit draft invoices, bills and journals, propose bank coding, and make and change Analytics reports, for you to check. Drafts and proposals post nothing.",
  post:
    "It can also approve invoices and bills, post draft journals and record payments, so what it does goes into the books.",
  full:
    "It can also reconcile bank statement lines (up to 100 at a time), review lines on personal and mixed-use accounts and make and edit bank rules; make, edit and approve credit notes, quotes, sales and purchase orders and repeating invoices and bills; apply credit and record refunds; approve and pay expense claims; add and edit items, accounts, tracking, budgets, fixed assets and their types (with an asset's tax details and Investment Boost), and run depreciation. Anything an approval rule covers still waits for a person. It can unreconcile bank lines after showing what it will do (nothing is posted or voided), and undo only its own reconciliations, within 24 hours. Only Owners can make one.",
};

/**
 * What each level means, said to the AI: in the MCP server's instructions
 * and in get_organisation's answer, so the two always agree (#531).
 */
export const AI_ACCESS_LEVEL_AI_WORDS: Record<AiAccessLevel, string> = {
  read: "You can look things up but not change anything.",
  draft:
    "You can look things up, add and edit contacts, make and edit draft invoices, bills and journals, propose bank coding for a person to approve (drafts and proposals post nothing), and make and change Analytics reports. You can't approve, post, delete, void or archive anything.",
  post:
    "You can look things up, add and edit contacts, make and edit drafts, approve invoices and bills, post draft journals and record payments. You can't delete, void (except with remove_and_redo_bank_lines), archive, roll back or refund anything.",
  full:
    "You can do everything at the \"Make and post\" level, and also reconcile bank statement lines, review lines on personal and mixed-use accounts (review_mixed_use_line; you undo only your own reviews within 24 hours), make and edit bank rules, make, edit and approve credit notes, quotes, sales and purchase orders and repeating invoices and bills, apply credit, record refunds, approve and pay expense claims, add and edit items, accounts, tracking, budgets, fixed assets and their types (with an asset's tax details and Investment Boost), and run depreciation. You can also do what the screens' Void, Delete (drafts), Remove, Archive, Dispose, Undo, Roll back, Exclude and OK, Lock date and switching settings off do (decisions 1609-1612): each of those tools first shows what it acts on and a confirmHash and changes nothing, and does it only when called again with the hash. Use them only when the person asked for that. Anything an approval rule covers is for a person to approve. Your undos are unmatch_bank_line, for your own reconciliations in the last 24 hours, and unmatch_bank_lines, which unreconciles any lines (nothing posted or voided) after you've checked its preview. remove_and_redo_bank_lines also voids what each line created (and, if asked, the payments it recorded), after its preview. correct_journal corrects a manual journal or a correction's replacement, whoever posted it, as Edit this journal does (a reversal and the new version), after its preview. void_own_journal voids a manual journal an AI connection posted from a draft, after its preview, and discard_own_draft_journal discards a draft journal an AI made that no person has edited. recode_bank_transactions voids spend and receive money and posts it again with the new coding on the same date, after its preview. bulk_reconcile works as a batch: if an answer is lost, read it with get_bank_batch and carry on with resume_bank_batch instead of sending the actions again. Work in small batches and check the results.",
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

/** The end dates offered when a key is made (#695, decision 1629), in days; null is no end date. */
export const AI_KEY_END_CHOICES = [30, 90, 365, null] as const;
export type AiKeyEndDays = (typeof AI_KEY_END_CHOICES)[number];
export const AI_KEY_END_LABELS: Record<string, string> = { "30": "In 30 days", "90": "In 90 days", "365": "In a year", none: "No end date" };

/** The end date a key gets when none is chosen: 90 days for one that can post, none for one that only reads or drafts. */
export function defaultKeyEndDays(level: AiAccessLevel): AiKeyEndDays {
  return level === "post" || level === "full" ? 90 : null;
}
