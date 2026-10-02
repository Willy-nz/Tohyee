import { type Role, roleAtLeast } from "@/lib/auth/roles";

/**
 * What an AI key may do (decision 346), chosen when the key is made:
 *  read   look only
 *  draft  also make and edit drafts (invoices, bills, journals) and contacts; nothing posts
 *  post   also approve and post them, and record payments
 * Never delete (decision 347): no level deletes, voids, archives, rolls back,
 * refunds or removes anything. Browser-safe.
 */
export const AI_ACCESS_LEVELS = ["read", "draft", "post"] as const;
export type AiAccessLevel = (typeof AI_ACCESS_LEVELS)[number];

export const AI_ACCESS_LEVEL_LABELS: Record<AiAccessLevel, string> = {
  read: "Look only",
  draft: "Make drafts",
  post: "Make and post",
};

export const AI_ACCESS_LEVEL_HELP: Record<AiAccessLevel, string> = {
  read: "It can look things up and answer questions. It can't change anything.",
  draft:
    "It can also add and edit contacts, and make and edit draft invoices, bills and journals for you to check. Drafts post nothing.",
  post:
    "It can also approve invoices and bills, post draft journals and record payments, so what it does goes into the books.",
};

const RANK: Record<AiAccessLevel, number> = { read: 0, draft: 1, post: 2 };

/**
 * The most a role allows: viewers look only; making drafts and contacts, and
 * approving, posting and recording payments, all need the bookkeeper role,
 * the same as the screens (the routes use "bookkeeper" for each).
 */
export function roleCeiling(role: Role): AiAccessLevel {
  return roleAtLeast(role, "bookkeeper") ? "post" : "read";
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
