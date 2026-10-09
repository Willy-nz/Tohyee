import { type Role, roleAtLeast } from "@/lib/auth/roles";

/**
 * What an AI key may do (decision 346), chosen when the key is made:
 *  read   look only
 *  draft  also make and edit drafts (invoices, bills, journals) and contacts; nothing posts
 *  post   also approve and post them, and record payments
 *  full   also reconcile bank statement lines and make and edit bank rules
 *         (decision 488, #205); only Owners make one, and it works as
 *         "post" when its owner is no longer an Owner
 * Never delete (decision 347): no level deletes, voids, archives, rolls back,
 * refunds or removes anything. The one exception is a Full access key undoing
 * its own reconciliation within 24 hours (example AIB7). Browser-safe.
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
    "It can also reconcile bank statement lines (match them, code them as spend or receive money, record transfers, apply bank rules, up to 100 lines at a time) and make and edit bank rules. It can undo only its own reconciliations, within 24 hours. Only Owners can make one.",
};

/** Shown before a Full access key is made; the person must tick it (decision 488). */
export const FULL_ACCESS_WARNING =
  "A Full access key can post spend money, receive money, payments and transfers into your books without anyone checking each one first. Anyone who gets the key can do the same, as you. Make one only for an AI you trust, keep the key secret, and revoke it when you stop using it.";

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
