/**
 * Account plans and renewals (decisions 653-654): the parts of them that
 * need no database, so the pages can use them too. See `account-plans.ts`.
 */

export const BUYING_ROLES = ["decision_maker", "budget_holder", "champion", "influencer", "user", "blocker", "other"] as const;
export type BuyingRole = (typeof BUYING_ROLES)[number];
export const GOAL_STATUSES = ["open", "achieved", "dropped"] as const;
export type GoalStatus = (typeof GOAL_STATUSES)[number];

/** HubSpot's buying roles, in plain words. */
export const BUYING_ROLE_LABELS: Record<BuyingRole, string> = {
  decision_maker: "Decision maker",
  budget_holder: "Budget holder",
  champion: "Champion",
  influencer: "Influencer",
  user: "User",
  blocker: "Blocker",
  other: "Other",
};

export const GOAL_STATUS_LABELS: Record<GoalStatus, string> = { open: "Open", achieved: "Achieved", dropped: "Dropped" };

/** How a renewal date reads against today: "in 12 days", "today", "3 days ago". */
export function renewalWhen(renewalDate: string, today: string): string {
  const days = Math.round((Date.parse(`${renewalDate}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days === -1) return "yesterday";
  return days > 0 ? `in ${days} days` : `${-days} days ago`;
}

/** "2 of 5 goals achieved" (dropped ones aren't counted). */
export function goalProgress(goals: ReadonlyArray<{ status: GoalStatus }>): string {
  const counted = goals.filter((goal) => goal.status !== "dropped");
  if (counted.length === 0) return "No goals yet";
  return `${counted.filter((goal) => goal.status === "achieved").length} of ${counted.length} goals achieved`;
}
