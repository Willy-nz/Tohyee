import { writeAuditEvent } from "@/lib/audit";
import { type Role, roleAtLeast } from "@/lib/auth/roles";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ConflictError, NotFoundError } from "@/lib/errors";
import { formatMoney } from "@/lib/format";
import { currencyMinorUnits } from "@/lib/money/currency";
import { dec, toFixedString } from "@/lib/money/decimal";
import { nameOf } from "@/lib/people/names";
import { type DocumentFacts, getApprovalRule, loadDocumentFacts, matchingRule } from "@/lib/approvals/rules";
import {
  type ApprovalAction,
  type ApprovalDocumentType,
  approvalEmailPath,
  type ApprovalEmailState,
  type ApprovalRequest,
  type ApprovalRule,
  type ApprovalStatus,
  type ApprovalStepProgress,
  documentNoun,
} from "@/lib/approvals/types";
import { requireId } from "@/lib/validation";

/**
 * Approval requests (AW3-AW17): a document's trip through its rule's steps.
 * This module has what the document services need (the gates that stop a
 * document under a rule being approved or edited directly) and imports none
 * of them; approving, declining and withdrawing are in `service.ts`.
 *
 * A request follows its rule as it is now (AW6): a step is done when one of
 * its approvers has approved it ("any one") or when every approver has
 * ("all"). Nobody approves a document they submitted or made (question 4).
 */

export type Viewer = { userId: string | null; email: string; role: Role };

type RequestRow = {
  id: string;
  document_type: ApprovalDocumentType;
  document_id: string;
  rule_id: string;
  rule_name: string;
  status: ApprovalStatus;
  submitted_by_user_id: string | null;
  submitted_by_email: string;
  submitted_at: string;
  finished_by_email: string | null;
  finished_at: string | null;
  decline_reason: string | null;
  last_error: string | null;
  last_error_at: string | null;
};

const REQUEST_COLUMNS = `id::text, document_type, document_id::text, rule_id::text, rule_name, status, submitted_by_user_id::text,
  submitted_by_email, submitted_at, finished_by_email, finished_at, decline_reason, last_error, last_error_at`;

export async function lockRequest(tx: OrgTx, idInput: unknown): Promise<RequestRow> {
  const id = requireId(idInput, "requestId");
  const found = await tx.query<RequestRow>(`select ${REQUEST_COLUMNS} from approval_requests where id = $1 for update`, [id]);
  if (!found.rows[0]) throw new NotFoundError("Approval request not found.");
  return found.rows[0];
}

async function requestRow(tx: OrgTx, idInput: unknown): Promise<RequestRow> {
  const id = requireId(idInput, "requestId");
  const found = await tx.query<RequestRow>(`select ${REQUEST_COLUMNS} from approval_requests where id = $1`, [id]);
  if (!found.rows[0]) throw new NotFoundError("Approval request not found.");
  return found.rows[0];
}

/** The request waiting for a document, if any. */
export async function waitingRequestFor(tx: OrgTx, type: ApprovalDocumentType, documentId: string): Promise<RequestRow | null> {
  const found = await tx.query<RequestRow>(
    `select ${REQUEST_COLUMNS} from approval_requests where document_type = $1 and document_id = $2 and status = 'waiting'`,
    [type, documentId],
  );
  return found.rows[0] ?? null;
}

function capital(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// ---------------------------------------------------------------- progress

type Actions = ApprovalAction[];

async function loadActions(tx: OrgTx, requestId: string): Promise<Actions> {
  const found = await tx.query<{ id: string; step_number: number; action: "approved" | "declined"; email: string; reason: string | null; created_at: string; user_id: string | null }>(
    "select id::text, step_number, action, email, reason, created_at, user_id::text from approval_actions where request_id = $1 order by approval_actions.id",
    [requestId],
  );
  return found.rows.map((row) => ({ id: row.id, stepNumber: row.step_number, action: row.action, email: row.email, name: nameOf(tx.people, row.email), reason: row.reason, at: row.created_at }));
}

/** Whoever submitted or made the document: they can't approve any step of it (AW6). */
function excludedFrom(request: Pick<RequestRow, "submitted_by_user_id" | "submitted_by_email">, facts: Pick<DocumentFacts, "makerUserId" | "makerEmail">) {
  const ids = new Set([request.submitted_by_user_id, facts.makerUserId].filter((value): value is string => !!value));
  const emails = new Set([request.submitted_by_email, facts.makerEmail].filter((value): value is string => !!value).map((value) => value.toLowerCase()));
  return (person: { userId?: string | null; email: string }) => (person.userId ? ids.has(person.userId) : false) || emails.has(person.email.toLowerCase());
}

type Progress = { steps: ApprovalStepProgress[]; currentStep: number | null };

function stepProgress(
  tx: OrgTx,
  rule: ApprovalRule,
  actions: Actions,
  excluded: (person: { userId?: string | null; email: string }) => boolean,
  noun: string,
  submitter: string,
): Progress {
  let currentStep: number | null = null;
  const steps = rule.steps.map((step): ApprovalStepProgress => {
    const approvals = actions.filter((action) => action.stepNumber === step.stepNumber && action.action === "approved");
    const approvedAt = (email: string) => approvals.find((action) => action.email.toLowerCase() === email.toLowerCase())?.at ?? null;
    const approvers = step.approvers.map((approver) => ({ ...approver, name: nameOf(tx.people, approver.email), approvedAt: approvedAt(approver.email), excluded: excluded(approver) }));
    const done = step.mode === "any" ? approvals.length > 0 : approvers.every((approver) => approver.approvedAt !== null);
    let state: ApprovalStepProgress["state"] = "done";
    if (!done) {
      state = currentStep === null ? "current" : "later";
      if (currentStep === null) currentStep = step.stepNumber;
    }
    let blocked: string | null = null;
    if (!done) {
      const name = (email: string) => nameOf(tx.people, email);
      const stuck = approvers.filter((approver) => approver.excluded && approver.approvedAt === null);
      if (approvers.length === 1 && approvers[0].excluded) {
        blocked = `Only ${name(approvers[0].email)} can approve this step, and ${name(approvers[0].email)} ${approvers[0].email.toLowerCase() === submitter.toLowerCase() ? "submitted" : "made"} it.`;
      } else if (step.mode === "any" && approvers.every((approver) => approver.excluded)) {
        blocked = `None of this step's approvers can approve it: they submitted or made this ${noun}.`;
      } else if (step.mode === "all" && stuck.length > 0) {
        blocked = `${name(stuck[0].email)} must approve this step, and ${name(stuck[0].email)} ${stuck[0].email.toLowerCase() === submitter.toLowerCase() ? "submitted" : "made"} it.`;
      }
      if (blocked) blocked += " An admin can change the rule's approvers (Settings › Approval rules), and the request carries on with them.";
    }
    return { stepNumber: step.stepNumber, mode: step.mode, approvers, approvedBy: approvals.map((action) => ({ email: action.email, name: action.name, at: action.at })), state, blocked };
  });
  return { steps, currentStep };
}

/** Who can act on the current step now: its approvers who didn't submit or make the document and haven't approved it yet. */
function eligible(step: ApprovalStepProgress | undefined) {
  if (!step) return [];
  return step.approvers.filter((approver) => !approver.excluded && approver.approvedAt === null);
}

export type RequestState = {
  row: RequestRow;
  rule: ApprovalRule;
  facts: DocumentFacts;
  actions: Actions;
  progress: Progress;
};

export async function requestState(tx: OrgTx, row: RequestRow): Promise<RequestState> {
  const rule = await getApprovalRule(tx, row.rule_id);
  const facts = await loadDocumentFacts(tx, row.document_type, row.document_id);
  const actions = await loadActions(tx, row.id);
  const progress = stepProgress(tx, rule, actions, excludedFrom(row, facts), documentNoun(row.document_type), row.submitted_by_email);
  return { row, rule, facts, actions, progress };
}

/** Whether `viewer` can approve or decline the current step now. */
export function canActOn(state: RequestState, viewer: Viewer): boolean {
  if (state.row.status !== "waiting" || !roleAtLeast(viewer.role, "bookkeeper")) return false;
  const step = state.progress.steps.find((item) => item.stepNumber === state.progress.currentStep);
  if (!step) {
    // Every step is done but the document wasn't approved (the rule changed, AW6): an approver of the last step finishes it.
    const last = state.progress.steps[state.progress.steps.length - 1];
    return !!last && last.approvers.some((approver) => !approver.excluded && sameUser(approver, viewer));
  }
  return eligible(step).some((approver) => sameUser(approver, viewer));
}

function sameUser(approver: { userId: string; email: string }, viewer: Viewer): boolean {
  return viewer.userId ? approver.userId === viewer.userId : approver.email.toLowerCase() === viewer.email.toLowerCase();
}

function canWithdrawState(state: RequestState, viewer: Viewer): boolean {
  if (state.row.status !== "waiting") return false;
  const submitter = state.row.submitted_by_user_id ? state.row.submitted_by_user_id === viewer.userId : state.row.submitted_by_email.toLowerCase() === viewer.email.toLowerCase();
  if (state.row.document_type === "expense_claim") return submitter || (state.facts.makerUserId !== null && state.facts.makerUserId === viewer.userId);
  return submitter || roleAtLeast(viewer.role, "admin");
}

export async function toRequestView(tx: OrgTx, state: RequestState, viewer: Viewer): Promise<ApprovalRequest> {
  const { row, rule, facts, actions, progress } = state;
  const current = progress.steps.find((step) => step.stepNumber === progress.currentStep);
  let waitingFor: string | null = null;
  if (row.status === "waiting") {
    const people = eligible(current).map((approver) => nameOf(tx.people, approver.email));
    if (current?.blocked) waitingFor = current.blocked;
    else if (!current) waitingFor = "Every step is approved; the last step's approver approves it again to finish.";
    else waitingFor = `Waiting for ${people.join(current.mode === "any" ? " or " : " and ")}`;
  }
  const emails = await tx.query<{ step_number: number; to_email: string; status: ApprovalEmailState["status"]; last_error: string | null }>(
    "select step_number, to_email, status, last_error from approval_emails where request_id = $1 order by id",
    [row.id],
  );
  const scale = currencyMinorUnits(facts.currencyCode);
  return {
    id: row.id,
    documentType: row.document_type,
    documentId: row.document_id,
    documentLabel: facts.label,
    partyName: facts.partyName,
    documentNumber: facts.number,
    documentDate: facts.date || null,
    currencyCode: facts.currencyCode,
    total: toFixedString(dec(facts.total), scale),
    ruleId: rule.id,
    ruleName: row.rule_name,
    status: row.status,
    submittedByEmail: row.submitted_by_email,
    submittedAt: row.submitted_at,
    finishedByEmail: row.finished_by_email,
    finishedAt: row.finished_at,
    declineReason: row.decline_reason,
    lastError: row.last_error,
    lastErrorAt: row.last_error_at,
    currentStep: row.status === "waiting" ? progress.currentStep : null,
    stepCount: rule.steps.length,
    steps: progress.steps,
    actions,
    emails: emails.rows.map((email) => ({ stepNumber: email.step_number, toEmail: email.to_email, status: email.status, lastError: email.last_error })),
    waitingFor,
    canAct: canActOn(state, viewer),
    isFinalStep: row.status === "waiting" && (progress.currentStep === null || isLastToFinish(progress)),
    canWithdraw: canWithdrawState(state, viewer),
  };
}

/** Approving the current step now would finish every step. */
export function isLastToFinish(progress: Progress): boolean {
  const current = progress.steps.find((step) => step.stepNumber === progress.currentStep);
  if (!current) return true;
  const later = progress.steps.filter((step) => step.stepNumber > current.stepNumber && step.state !== "done");
  if (later.length > 0) return false;
  return current.mode === "any" || current.approvers.filter((approver) => approver.approvedAt === null).length <= 1;
}

export async function getApprovalRequest(tx: OrgTx, idInput: unknown, viewer: Viewer): Promise<ApprovalRequest> {
  return toRequestView(tx, await requestState(tx, await requestRow(tx, idInput)), viewer);
}

/**
 * The approvals page (AW3): requests waiting, with `mine` only those the
 * signed-in person can approve or decline now; `finished` the latest 50 that
 * have finished instead.
 */
export async function listApprovalRequests(
  tx: OrgTx,
  viewer: Viewer,
  filters: { mine?: unknown; finished?: unknown } = {},
): Promise<ApprovalRequest[]> {
  const finished = filters.finished === true || filters.finished === "true";
  const found = await tx.query<RequestRow>(
    finished
      ? `select ${REQUEST_COLUMNS} from approval_requests where status <> 'waiting' order by finished_at desc, id desc limit 50`
      : `select ${REQUEST_COLUMNS} from approval_requests where status = 'waiting' order by submitted_at, id`,
  );
  const views: ApprovalRequest[] = [];
  for (const row of found.rows) {
    const state = await requestState(tx, row).catch((error) => {
      // A document deleted after its request finished: nothing to show.
      if (error instanceof NotFoundError) return null;
      throw error;
    });
    if (!state) continue;
    const view = await toRequestView(tx, state, viewer);
    if ((filters.mine === true || filters.mine === "true") && !view.canAct) continue;
    views.push(view);
  }
  return views;
}

// ---------------------------------------------------------------- starting

/** Puts a document under its rule: a waiting request, step 1's approvers asked (AW3). */
export async function startApprovalRequest(
  tx: OrgTx,
  facts: DocumentFacts,
  rule: ApprovalRule,
  options: { origin: string | null },
): Promise<string> {
  const inserted = await tx
    .query<{ id: string }>(
      `insert into approval_requests (document_type, document_id, rule_id, rule_name, submitted_by_user_id, submitted_by_email)
       values ($1, $2, $3, $4, $5, $6) returning id::text`,
      [facts.type, facts.id, rule.id, rule.name, tx.actor.userId, tx.actor.email],
    )
    .catch((error) => {
      if ((error as { code?: string }).code === "23505") throw new ConflictError(`${capital(facts.label)} is already waiting for approval.`);
      throw error;
    });
  const requestId = inserted.rows[0].id;
  await writeAuditEvent(tx, {
    eventType: "approval.submitted",
    entityType: facts.type,
    entityId: facts.id,
    details: { requestId, ruleId: rule.id, ruleName: rule.name },
  });
  await queueStepEmails(tx, await requestState(tx, await requestRow(tx, requestId)), options.origin);
  return requestId;
}

/**
 * Emails the current step's approvers who haven't been asked yet (AW3,
 * AW12): the document, its total and a link to its approval page, which
 * needs signing in. Nothing is approved from an email. Sent by the email job.
 */
export async function queueStepEmails(tx: OrgTx, state: RequestState, origin: string | null): Promise<void> {
  const { row, rule, facts, progress } = state;
  const step = progress.steps.find((item) => item.stepNumber === progress.currentStep);
  if (!step || row.status !== "waiting") return;
  const scale = currencyMinorUnits(facts.currencyCode);
  const total = `${formatMoney(facts.total, scale)} ${facts.currencyCode}`;
  const noun = documentNoun(facts.type);
  const party = facts.type === "expense_claim" ? "Claimant" : "Supplier";
  const link = origin ? `${origin}${approvalEmailPath(tx.organisationId, row.id)}` : null;
  for (const approver of eligible(step)) {
    const subject = `Approval needed: ${facts.label} (${total})`.slice(0, 250);
    const body = [
      `Hi ${nameOf(tx.people, approver.email)},`,
      "",
      `${nameOf(tx.people, row.submitted_by_email)} submitted ${facts.label.charAt(0).toLowerCase()}${facts.label.slice(1)} for approval (rule: ${rule.name}, step ${step.stepNumber} of ${rule.steps.length}).`,
      "",
      `${party}: ${facts.partyName}`,
      ...(facts.number ? [`Number: ${facts.number}`] : []),
      `Total: ${total}`,
      "",
      link
        ? `Open it in Tohyee to approve or decline it (you'll need to sign in):\n${link}`
        : `Open Tohyee and go to Purchases › Approvals to approve or decline it.`,
      "",
      `Nothing is approved from this email: the ${noun} is approved in Tohyee, by you, after signing in.`,
    ].join("\n");
    await tx.query(
      `insert into approval_emails (request_id, step_number, to_user_id, to_email, subject, body)
       values ($1, $2, $3, $4, $5, $6) on conflict (request_id, step_number, to_user_id) do nothing`,
      [row.id, step.stepNumber, approver.userId, approver.email, subject, body.slice(0, 5000)],
    );
  }
}

// ---------------------------------------------------------------- gates

/**
 * Refuses approving a document directly when a rule matches it or it's
 * waiting for approval (AW3, AW15); `viaRequestId` is the approval workflow
 * approving it at its last step.
 */
export async function assertNoApprovalNeeded(tx: OrgTx, type: ApprovalDocumentType, documentId: string, viaRequestId?: string): Promise<void> {
  const waiting = await waitingRequestFor(tx, type, documentId);
  if (viaRequestId !== undefined) {
    if (!waiting || waiting.id !== viaRequestId) throw new ConflictError("That approval request isn't waiting for this document.");
    return;
  }
  const noun = documentNoun(type);
  if (waiting) {
    throw new ConflictError(`This ${noun} is waiting for approval (rule: ${waiting.rule_name}). Its approvers approve it on its approval page (Purchases › Approvals).`);
  }
  const rule = await matchingRule(tx, await loadDocumentFacts(tx, type, documentId));
  if (rule) {
    throw new ConflictError(
      type === "expense_claim"
        ? `This expense claim needs approval (rule: ${rule.name}). Its claimant submits it again to send it to the rule's approvers.`
        : `This ${noun} needs approval (rule: ${rule.name}). Submit it for approval.`,
    );
  }
}

/** Refuses editing or deleting a document while it's waiting for approval (AW3, question 5). */
export async function assertNotWaitingForApproval(tx: OrgTx, type: ApprovalDocumentType, documentId: string, action: "edited" | "deleted"): Promise<void> {
  const waiting = await waitingRequestFor(tx, type, documentId);
  if (waiting) {
    throw new ConflictError(`This ${documentNoun(type)} is waiting for approval (rule: ${waiting.rule_name}), so it can't be ${action}. Withdraw it from approval first.`);
  }
}

/** Why the connected AI can't approve a document: a person approves it (AW13, question 6); null when no rule applies. */
export async function approvalNeededForAi(tx: OrgTx, type: ApprovalDocumentType, documentId: string): Promise<string | null> {
  const waiting = await waitingRequestFor(tx, type, documentId);
  const ruleName = waiting?.rule_name ?? (await matchingRule(tx, await loadDocumentFacts(tx, type, documentId)))?.name ?? null;
  return ruleName ? `This ${documentNoun(type)} needs a person's approval (rule: ${ruleName}).` : null;
}

/** Finishes a request (approved, declined or withdrawn) and records it in the document's history. */
export async function finishRequest(
  tx: OrgTx,
  row: RequestRow,
  status: Exclude<ApprovalStatus, "waiting">,
  details: { reason?: string; stepNumber?: number | null } = {},
): Promise<void> {
  await tx.query(
    `update approval_requests set status = $2, finished_by_email = $3, finished_at = now(), decline_reason = $4, last_error = null, last_error_at = null
      where id = $1`,
    [row.id, status, tx.actor.email, status === "declined" ? details.reason : null],
  );
  await writeAuditEvent(tx, {
    eventType: `approval.${status}`,
    entityType: row.document_type,
    entityId: row.document_id,
    details: { requestId: row.id, ruleName: row.rule_name, ...(details.stepNumber ? { step: details.stepNumber } : {}), ...(details.reason ? { reason: details.reason } : {}) },
  });
}

/** The latest request for a document, waiting or not. */
export async function latestRequestFor(tx: OrgTx, type: ApprovalDocumentType, documentId: string): Promise<RequestRow | null> {
  const found = await tx.query<RequestRow>(
    `select ${REQUEST_COLUMNS} from approval_requests where document_type = $1 and document_id = $2 order by id desc limit 1`,
    [type, documentId],
  );
  return found.rows[0] ?? null;
}
