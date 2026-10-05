/**
 * Approval workflows (AW1-AW17): what the screens and the server share.
 * Browser-safe.
 */

export const APPROVAL_DOCUMENT_TYPES = ["bill", "purchase_order", "expense_claim"] as const;
export type ApprovalDocumentType = (typeof APPROVAL_DOCUMENT_TYPES)[number];

export const APPROVAL_DOCUMENT_LABELS: Record<ApprovalDocumentType, { one: string; many: string }> = {
  bill: { one: "bill", many: "Bills" },
  purchase_order: { one: "purchase order", many: "Purchase orders" },
  expense_claim: { one: "expense claim", many: "Expense claims" },
};

export const APPROVAL_MODES = ["any", "all"] as const;
export type ApprovalMode = (typeof APPROVAL_MODES)[number];

/** At most this many steps in a rule, and approvers in a step. */
export const MAX_APPROVAL_STEPS = 10;
export const MAX_STEP_APPROVERS = 20;

export type ApprovalPerson = { userId: string; email: string };

export type ApprovalRuleStep = { stepNumber: number; mode: ApprovalMode; approvers: ApprovalPerson[] };

export type ApprovalRule = {
  id: string;
  documentType: ApprovalDocumentType;
  name: string;
  position: number;
  /** In the base currency (question 7); null for any total. */
  minTotal: string | null;
  contactId: string | null;
  contactName: string | null;
  claimantUserId: string | null;
  claimantEmail: string | null;
  accountId: string | null;
  accountCode: string | null;
  accountName: string | null;
  trackingValueId: string | null;
  trackingValueName: string | null;
  trackingCategoryName: string | null;
  steps: ApprovalRuleStep[];
  version: number;
  archivedAt: string | null;
  archivedByEmail: string | null;
  createdByEmail: string | null;
  updatedByEmail: string | null;
  updatedAt: string;
};

export const APPROVAL_STATUSES = ["waiting", "approved", "declined", "withdrawn"] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

export type ApprovalStepApprover = ApprovalPerson & {
  name: string;
  /** When they approved this step, if they have. */
  approvedAt: string | null;
  /** They submitted or made the document, so they can't approve it (AW6). */
  excluded: boolean;
};

export type ApprovalStepProgress = {
  stepNumber: number;
  mode: ApprovalMode;
  approvers: ApprovalStepApprover[];
  /** Everyone who approved this step (an approver since removed from the rule included). */
  approvedBy: { email: string; name: string; at: string }[];
  state: "done" | "current" | "later";
  /** Why nobody can finish this step (AW6), or null. */
  blocked: string | null;
};

export type ApprovalAction = {
  id: string;
  stepNumber: number;
  action: "approved" | "declined";
  email: string;
  name: string;
  reason: string | null;
  at: string;
};

export type ApprovalEmailState = {
  stepNumber: number;
  toEmail: string;
  status: "queued" | "sending" | "sent" | "failed";
  lastError: string | null;
};

export type ApprovalRequest = {
  id: string;
  documentType: ApprovalDocumentType;
  documentId: string;
  /** "Bill K-300 from Kauri Supplies". */
  documentLabel: string;
  /** The supplier, or the claimant for an expense claim. */
  partyName: string;
  documentNumber: string | null;
  documentDate: string | null;
  currencyCode: string;
  total: string;
  ruleId: string;
  ruleName: string;
  status: ApprovalStatus;
  submittedByEmail: string;
  submittedAt: string;
  finishedByEmail: string | null;
  finishedAt: string | null;
  declineReason: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  /** The step waiting, or null when none is (finished, or every step done). */
  currentStep: number | null;
  stepCount: number;
  steps: ApprovalStepProgress[];
  actions: ApprovalAction[];
  emails: ApprovalEmailState[];
  /** "Waiting for Tama or Ana" (AW12), or null when it isn't waiting. */
  waitingFor: string | null;
  /** The signed-in person can approve or decline now. */
  canAct: boolean;
  /** Approving now finishes it: the document is approved. */
  isFinalStep: boolean;
  /** The signed-in person can withdraw it. */
  canWithdraw: boolean;
};

export type ApprovalBudgetLine = {
  accountId: string;
  accountCode: string;
  accountName: string;
  /** The budget used: the tracking value's, or the overall budget. */
  budgetId: string;
  budgetName: string;
  /** The first of the month the document is in. */
  month: string;
  /** The month's budget, or null when the budget has no amount for the account. */
  budget: string | null;
  /** Posted to the account in the month so far (filtered to the budget's tracking value). */
  spent: string;
  /** This document's amount on the account, excluding GST, in the base currency. */
  thisDocument: string;
  /** Budget less spent less this document; null with no budget amount. */
  left: string | null;
  /** "Over budget by 900.00", or null. */
  overBy: string | null;
};

/** What a document's page shows about approval. */
export type DocumentApproval = {
  /** The first rule that matches the document now, if any. */
  rule: { id: string; name: string } | null;
  /** The waiting request, or the latest finished one. */
  request: ApprovalRequest | null;
  /** A rule matches and nothing is waiting: approving directly is refused, submitting is offered. */
  needsApproval: boolean;
};

export function documentNoun(type: ApprovalDocumentType): string {
  return APPROVAL_DOCUMENT_LABELS[type].one;
}

/** The approval page for a request. */
export function approvalHref(requestId: string): string {
  return `/operations/purchases/approvals/${requestId}`;
}

/** The link in an approver's email: signing in first, then the request in its organisation (AW12). */
export function approvalEmailPath(organisationId: string, requestId: string): string {
  return `/login?next=${encodeURIComponent(`/operations/purchases/approvals/${requestId}/in/${organisationId}`)}`;
}
