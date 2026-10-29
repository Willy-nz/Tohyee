/** Words for photo estimates (#503, decisions 1162-1165). Browser-safe. */

export const ESTIMATE_CONFIDENCES = ["low", "medium", "high"] as const;
export type EstimateConfidence = (typeof ESTIMATE_CONFIDENCES)[number];
export const ESTIMATE_CONFIDENCE_LABELS: Record<EstimateConfidence, string> = { low: "Not sure", medium: "Fairly sure", high: "Sure" };
export type EstimateStatus = "waiting" | "accepted" | "changed" | "compared" | "declined";
export const ESTIMATE_STATUS_LABELS: Record<EstimateStatus, string> = {
  waiting: "Waiting for a person",
  accepted: "Accepted as a reading",
  changed: "Changed, then saved as a reading",
  compared: "Kept for comparison",
  declined: "Declined",
};
/** Shown beside every estimate (decision 1162). */
export const ESTIMATE_LABEL = "AI estimate from a photo, not measured";

