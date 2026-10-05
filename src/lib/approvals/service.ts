import { writeAuditEvent } from "@/lib/audit";
import { approveBill } from "@/lib/bills/service";
import { budgetTrackingFilter, getBudgetSummary } from "@/lib/budgets/service";
import { todayIsoDate } from "@/lib/dates";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ConflictError, ForbiddenError, HttpError, NotFoundError, ValidationError } from "@/lib/errors";
import { approveExpenseClaim, declineExpenseClaim, submitExpenseClaim } from "@/lib/expense-claims/service";
import { formatMoney } from "@/lib/format";
import { currencyMinorUnits } from "@/lib/money/currency";
import { add, cmp, dec, type Decimal, isNegative, neg, sub, toFixedString, ZERO_DECIMAL } from "@/lib/money/decimal";
import { nameOf } from "@/lib/people/names";
import { approvePurchaseOrder } from "@/lib/purchase-orders/service";
import { accountTotals, naturalAmount } from "@/lib/reports/financial";
import { loadDocumentFacts, matchingRule } from "@/lib/approvals/rules";
import {
  canActOn,
  finishRequest,
  getApprovalRequest,
  isLastToFinish,
  latestRequestFor,
  lockRequest,
  queueStepEmails,
  requestState,
  startApprovalRequest,
  toRequestView,
  type Viewer,
  waitingRequestFor,
} from "@/lib/approvals/requests";
import {
  APPROVAL_DOCUMENT_TYPES,
  type ApprovalBudgetLine,
  type ApprovalDocumentType,
  type ApprovalRequest,
  type DocumentApproval,
  documentNoun,
} from "@/lib/approvals/types";
import { requireId, requireOneOf, requireString } from "@/lib/validation";

/**
 * Approval workflows (AW1-AW17): submitting a document under a rule,
 * approving and declining its steps, and withdrawing it. When the last step
 * is approved the document is approved exactly as it is today (bills B1-B3,
 * purchase orders PO2, expense claims EC3), by the last approver; if that's
 * refused (a locked period, AW10), the request waits at its step and says
 * why. The connected AI can submit but never approve or decline a step
 * (question 6): the routes for steps are for people only.
 */

const SOURCE = "approval";

function capital(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

async function lockDocument(tx: OrgTx, type: ApprovalDocumentType, id: string): Promise<void> {
  const table = type === "bill" ? "bills" : type === "purchase_order" ? "purchase_orders" : "expense_claims";
  const locked = await tx.query(`select 1 from ${table} where id = $1 for update`, [id]);
  if (locked.rowCount === 0) throw new NotFoundError(`${capital(documentNoun(type))} not found.`);
}

/**
 * Submits a draft bill or purchase order for approval (AW3, AW11), or an
 * expense claim (as EC2, AW15). It stays a draft and posts nothing, but
 * can't be edited until it's withdrawn. Submitting again while it waits
 * returns the same request.
 */
export async function submitForApproval(
  tx: OrgTx,
  viewer: Viewer,
  typeInput: unknown,
  idInput: unknown,
  options: { origin: string | null },
): Promise<ApprovalRequest> {
  const type = requireOneOf(typeInput, "documentType", APPROVAL_DOCUMENT_TYPES);
  const id = requireId(idInput, "documentId");
  if (type === "expense_claim") {
    await submitExpenseClaim(tx, id, { origin: options.origin });
    const waiting = await waitingRequestFor(tx, type, id);
    if (!waiting) throw new ValidationError("No approval rule applies to this expense claim: it's submitted, and any bookkeeper can approve it (EC3).");
    return getApprovalRequest(tx, waiting.id, viewer);
  }
  await lockDocument(tx, type, id);
  const facts = await loadDocumentFacts(tx, type, id);
  const waiting = await waitingRequestFor(tx, type, id);
  if (waiting) return getApprovalRequest(tx, waiting.id, viewer);
  if (facts.status !== "draft") throw new ConflictError(`${capital(facts.label)} is ${facts.status}, so it can't be submitted for approval.`);
  if (type === "bill" && facts.number === null) {
    throw new ValidationError(
      `Add the supplier's invoice number before submitting: this draft bill from ${facts.partyName} doesn't have one yet. Type it from their invoice when it arrives.`,
    );
  }
  const rule = await matchingRule(tx, facts);
  if (!rule) throw new ValidationError(`No approval rule applies to this ${documentNoun(type)}, so it doesn't need submitting: approve it directly.`);
  const requestId = await startApprovalRequest(tx, facts, rule, options);
  return getApprovalRequest(tx, requestId, viewer);
}

function cannotAct(tx: OrgTx, state: Awaited<ReturnType<typeof requestState>>, viewer: Viewer): never {
  const noun = documentNoun(state.row.document_type);
  const mine =
    (viewer.userId !== null && (state.row.submitted_by_user_id === viewer.userId || state.facts.makerUserId === viewer.userId)) ||
    state.row.submitted_by_email.toLowerCase() === viewer.email.toLowerCase();
  if (mine) throw new ForbiddenError(`You can't approve or decline this ${noun}: nobody approves their own, and you submitted or made it.`);
  const step = state.progress.steps.find((item) => item.stepNumber === state.progress.currentStep);
  const waiting = step ? step.approvers.filter((approver) => !approver.excluded && approver.approvedAt === null).map((approver) => nameOf(tx.people, approver.email)) : [];
  throw new ForbiddenError(
    waiting.length > 0
      ? `Only this step's approvers can approve or decline it: it's waiting for ${waiting.join(step?.mode === "all" ? " and " : " or ")}.`
      : "You can't approve or decline this step.",
  );
}

/**
 * Approves the current step (AW5, AW9): when every step is done the
 * document is approved as today by this person. A claim's last approver
 * chooses its claim date (AW16); a bill's can approve a likely duplicate
 * anyway, as on the bill's page (DU2). If the document's approval is
 * refused, nothing is recorded and the request says why (AW10): `refused`.
 */
export async function approveApprovalStep(
  tx: OrgTx,
  viewer: Viewer,
  requestIdInput: unknown,
  command: { claimDate?: unknown; approveDespiteWarnings?: unknown; origin: string | null },
): Promise<{ request: ApprovalRequest; refused: string | null }> {
  const row = await lockRequest(tx, requestIdInput);
  if (row.status !== "waiting") throw new ConflictError(`This approval request is already ${row.status}.`);
  await lockDocument(tx, row.document_type, row.document_id);
  const state = await requestState(tx, row);
  if (!canActOn(state, viewer)) cannotAct(tx, state, viewer);
  const step = state.progress.currentStep;
  const final = step === null || isLastToFinish(state.progress);
  if (final && row.document_type === "expense_claim" && (command.claimDate == null || command.claimDate === "")) {
    throw new ValidationError("Choose the claim date: approving this step approves the claim, which posts on that date (EC3).");
  }

  await tx.query("savepoint approval_step");
  if (step !== null) {
    await tx.query(
      "insert into approval_actions (request_id, step_number, action, user_id, email) values ($1, $2, 'approved', $3, $4)",
      [row.id, step, viewer.userId, viewer.email],
    );
    await writeAuditEvent(tx, {
      eventType: "approval.step_approved",
      entityType: row.document_type,
      entityId: row.document_id,
      details: { requestId: row.id, ruleName: row.rule_name, step, steps: state.rule.steps.length },
    });
  }
  if (!final) {
    await tx.query("release savepoint approval_step");
    await queueStepEmails(tx, await requestState(tx, row), command.origin);
    return { request: await getApprovalRequest(tx, row.id, viewer), refused: null };
  }

  const key = `approval-${row.id}`;
  try {
    if (row.document_type === "bill") {
      await approveBill(tx, row.document_id, {
        source: SOURCE,
        idempotencyKey: key,
        approveDespiteWarnings: command.approveDespiteWarnings === true,
        viaApprovalRequestId: row.id,
      });
    } else if (row.document_type === "purchase_order") {
      await approvePurchaseOrder(tx, row.document_id, { source: SOURCE, idempotencyKey: key, viaApprovalRequestId: row.id });
    } else {
      await approveExpenseClaim(tx, viewer.role, row.document_id, { source: SOURCE, idempotencyKey: key, claimDate: command.claimDate, viaApprovalRequestId: row.id });
    }
  } catch (error) {
    if (!(error instanceof HttpError) || error.status >= 500) throw error;
    // Refused as any approval would be (AW10): nothing of this approval is kept, and the request says why.
    await tx.query("rollback to savepoint approval_step");
    await tx.query("update approval_requests set last_error = $2, last_error_at = now() where id = $1", [row.id, error.message.slice(0, 1000)]);
    await writeAuditEvent(tx, {
      eventType: "approval.final_refused",
      entityType: row.document_type,
      entityId: row.document_id,
      details: { requestId: row.id, ruleName: row.rule_name, step, error: error.message.slice(0, 500) },
    });
    return { request: await getApprovalRequest(tx, row.id, viewer), refused: error.message };
  }
  await tx.query("release savepoint approval_step");
  await finishRequest(tx, row, "approved", { stepNumber: step });
  return { request: await getApprovalRequest(tx, row.id, viewer), refused: null };
}

/**
 * Declines the current step with a reason (AW7, AW16): the request ends and
 * the document goes back to its submitter as a draft they can edit, showing
 * the reason; a claim exactly as EC6.
 */
export async function declineApprovalStep(tx: OrgTx, viewer: Viewer, requestIdInput: unknown, command: { reason: unknown }): Promise<ApprovalRequest> {
  const reason = requireString(command.reason, "The reason", { maxLength: 500 });
  const row = await lockRequest(tx, requestIdInput);
  if (row.status !== "waiting") throw new ConflictError(`This approval request is already ${row.status}.`);
  await lockDocument(tx, row.document_type, row.document_id);
  const state = await requestState(tx, row);
  if (!canActOn(state, viewer)) cannotAct(tx, state, viewer);
  const step = state.progress.currentStep ?? state.rule.steps.length;
  await tx.query(
    "insert into approval_actions (request_id, step_number, action, user_id, email, reason) values ($1, $2, 'declined', $3, $4, $5)",
    [row.id, step, viewer.userId, viewer.email, reason],
  );
  if (row.document_type === "expense_claim") {
    await declineExpenseClaim(tx, viewer.role, row.document_id, { reason }, { viaApprovalRequestId: row.id });
  }
  await finishRequest(tx, row, "declined", { reason, stepNumber: step });
  return getApprovalRequest(tx, row.id, viewer);
}

/**
 * Withdraws a waiting document from approval (AW8, AW17): it's an ordinary
 * draft again and approvals already given are dropped (they stay in the
 * history). Its submitter or an admin can; a claim only its claimant.
 */
export async function withdrawApprovalRequest(tx: OrgTx, viewer: Viewer, requestIdInput: unknown): Promise<ApprovalRequest> {
  const row = await lockRequest(tx, requestIdInput);
  if (row.status !== "waiting") throw new ConflictError(`This approval request is already ${row.status}.`);
  await lockDocument(tx, row.document_type, row.document_id);
  const state = await requestState(tx, row);
  const view = await toRequestView(tx, state, viewer);
  if (!view.canWithdraw) {
    throw new ForbiddenError(
      row.document_type === "expense_claim"
        ? `Only ${nameOf(tx.people, state.facts.makerEmail ?? row.submitted_by_email)}, whose claim it is, can withdraw it.`
        : `Only ${nameOf(tx.people, row.submitted_by_email)}, who submitted it, or an admin can withdraw it.`,
    );
  }
  if (row.document_type === "expense_claim") {
    await tx.query("update expense_claims set status = 'draft', submitted_at = null, updated_at = now() where id = $1 and status = 'submitted'", [row.document_id]);
  }
  await finishRequest(tx, row, "withdrawn");
  return getApprovalRequest(tx, row.id, viewer);
}

/** What a document's page shows about approval: the rule that applies, and the waiting or latest request. */
export async function documentApproval(tx: OrgTx, viewer: Viewer, typeInput: unknown, idInput: unknown): Promise<DocumentApproval> {
  const type = requireOneOf(typeInput, "documentType", APPROVAL_DOCUMENT_TYPES);
  const id = requireId(idInput, "documentId");
  const facts = await loadDocumentFacts(tx, type, id);
  const waiting = await waitingRequestFor(tx, type, id);
  const open = facts.status === "draft" || (type === "expense_claim" && facts.status === "submitted");
  const rule = open ? await matchingRule(tx, facts).catch((error) => (error instanceof ValidationError ? null : Promise.reject(error))) : null;
  const latest = waiting ?? (await latestRequestFor(tx, type, id));
  return {
    rule: rule ? { id: rule.id, name: rule.name } : null,
    request: latest ? await getApprovalRequest(tx, latest.id, viewer) : null,
    needsApproval: !!rule && !waiting,
  };
}

// ---------------------------------------------------------------- budget

/**
 * The budget at approval (AW4, question 3): for each profit and loss
 * account on the document, the month's budget (the budget for a line's
 * tracking value when there is one, else the overall budget), what's been
 * posted to it in the month, this document (excluding GST, in the base
 * currency) and what's left. Shown, never blocks.
 */
export async function approvalBudget(tx: OrgTx, requestIdInput: unknown): Promise<ApprovalBudgetLine[]> {
  const id = requireId(requestIdInput, "requestId");
  const found = await tx.query<{ document_type: ApprovalDocumentType; document_id: string }>(
    "select document_type, document_id::text from approval_requests where id = $1",
    [id],
  );
  if (!found.rows[0]) throw new NotFoundError("Approval request not found.");
  const facts = await loadDocumentFacts(tx, found.rows[0].document_type, found.rows[0].document_id);
  const month = `${(facts.date || todayIsoDate()).slice(0, 7)}-01`;
  const monthEnd = (await tx.query<{ end: string }>("select (date_trunc('month', $1::date) + interval '1 month - 1 day')::date::text as end", [month])).rows[0].end;
  const budgets = await tx.query<{ id: string; name: string; is_overall: boolean; tracking_value_id: string | null }>(
    "select id::text, name, is_overall, tracking_value_id::text from budgets where archived_at is null order by is_overall, id",
  );
  const overall = budgets.rows.find((budget) => budget.is_overall) ?? null;
  const byValue = new Map(budgets.rows.filter((budget) => budget.tracking_value_id).map((budget) => [budget.tracking_value_id!, budget]));

  type Group = { accountId: string; accountCode: string; accountName: string; budgetId: string; budgetName: string; amount: Decimal };
  const groups = new Map<string, Group>();
  for (const line of facts.lines) {
    if (line.accountClass !== "expense" && line.accountClass !== "revenue") continue;
    const budget = Object.values(line.tracking).map((value) => byValue.get(value)).find((item) => item !== undefined) ?? overall;
    if (!budget) continue;
    const key = `${line.accountId}|${budget.id}`;
    const group = groups.get(key) ?? { accountId: line.accountId, accountCode: line.accountCode, accountName: line.accountName, budgetId: budget.id, budgetName: budget.name, amount: ZERO_DECIMAL };
    group.amount = add(group.amount, line.accountClass === "revenue" ? neg(line.baseNet) : line.baseNet);
    groups.set(key, group);
  }
  const scale = currencyMinorUnits(tx.baseCurrency);
  const money = (value: Decimal) => toFixedString(value, scale);
  const spentCache = new Map<string, Map<string, Decimal>>();
  const lines: ApprovalBudgetLine[] = [];
  for (const group of [...groups.values()].sort((left, right) => left.accountCode.localeCompare(right.accountCode) || left.budgetName.localeCompare(right.budgetName))) {
    let spent = spentCache.get(group.budgetId);
    if (!spent) {
      const filter = await budgetTrackingFilter(tx, await getBudgetSummary(tx, group.budgetId));
      spent = new Map((await accountTotals(tx, month, monthEnd, filter)).map((row) => [String(row.id), naturalAmount(row)]));
      spentCache.set(group.budgetId, spent);
    }
    const amount = await tx.query<{ amount: string }>(
      "select amount::text from budget_amounts where budget_id = $1 and account_id = $2 and month = $3::date",
      [group.budgetId, group.accountId, month],
    );
    const budget = amount.rows[0] ? dec(amount.rows[0].amount) : null;
    const used = spent.get(group.accountId) ?? ZERO_DECIMAL;
    const left = budget === null ? null : sub(sub(budget, used), group.amount);
    lines.push({
      accountId: group.accountId,
      accountCode: group.accountCode,
      accountName: group.accountName,
      budgetId: group.budgetId,
      budgetName: group.budgetName,
      month,
      budget: budget === null ? null : money(budget),
      spent: money(used),
      thisDocument: money(group.amount),
      left: left === null ? null : money(left),
      overBy: left !== null && isNegative(left) && cmp(left, ZERO_DECIMAL) < 0 ? `Over budget by ${formatMoney(money(neg(left)), scale)}` : null,
    });
  }
  return lines;
}
