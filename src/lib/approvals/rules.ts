import { writeAuditEvent } from "@/lib/audit";
import { type Role, roleAtLeast, ROLE_LABELS } from "@/lib/auth/roles";
import type { OrgTx } from "@/lib/db/org-transaction";
import { coreQuery } from "@/lib/db/transactions";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { exchangeRateFor } from "@/lib/fx/documents";
import { currencyMinorUnits } from "@/lib/money/currency";
import { cmp, dec, type Decimal, divide, mul, parseDecimalInput, toFixedString } from "@/lib/money/decimal";
import { nameOf } from "@/lib/people/names";
import { valueWithDescendants } from "@/lib/tracking/service";
import {
  APPROVAL_DOCUMENT_TYPES,
  APPROVAL_MODES,
  type ApprovalDocumentType,
  type ApprovalMode,
  type ApprovalRule,
  type ApprovalRuleStep,
  documentNoun,
  MAX_APPROVAL_STEPS,
  MAX_STEP_APPROVERS,
} from "@/lib/approvals/types";
import { asRecord, optionalBoolean, optionalId, requireArray, requireOneOf, requireString } from "@/lib/validation";

/**
 * Approval rules (AW1, AW11): per document type, conditions that must all
 * hold (a total at least an amount in the base currency, the supplier or
 * claimant, an account on any line, a tracking value on any line) and steps
 * in order, each naming approvers (bookkeepers or above) and whether any one
 * or all of them approve. Rules are tried in their order; the first that
 * matches a document is used. Admins change rules; everyone can see them.
 * Rules are archived, never deleted.
 */

// ---------------------------------------------------------------- members

export type OrganisationMember = { userId: string; email: string; displayName: string; role: Role };

/** The organisation's members with their roles, from the core database. */
export async function organisationMembers(organisationId: string): Promise<OrganisationMember[]> {
  const result = await coreQuery<{ user_id: string; email: string; display_name: string; role: Role }>(
    `select m.user_id::text, u.email, u.display_name, m.role
       from organisation_members m join users u on u.id = m.user_id
      where m.organisation_id = $1 and u.is_active`,
    [organisationId],
  );
  return result.rows.map((row) => ({ userId: row.user_id, email: row.email, displayName: row.display_name, role: row.role }));
}

// ---------------------------------------------------------------- reading

type RuleRow = {
  id: string;
  document_type: ApprovalDocumentType;
  name: string;
  position: number;
  min_total: string | null;
  contact_id: string | null;
  contact_name: string | null;
  claimant_user_id: string | null;
  claimant_email: string | null;
  account_id: string | null;
  account_code: string | null;
  account_name: string | null;
  tracking_value_id: string | null;
  tracking_value_name: string | null;
  tracking_category_name: string | null;
  version: number;
  archived_at: string | null;
  archived_by_email: string | null;
  created_by_email: string | null;
  updated_by_email: string | null;
  updated_at: string;
};

const RULE_COLUMNS = `r.id::text, r.document_type, r.name, r.position, r.min_total::text, r.contact_id::text, c.name as contact_name,
  r.claimant_user_id::text, r.claimant_email, r.account_id::text, a.code as account_code, a.name as account_name,
  r.tracking_value_id::text, v.name as tracking_value_name, tc.name as tracking_category_name, r.version, r.archived_at,
  r.archived_by_email, r.created_by_email, r.updated_by_email, r.updated_at`;
const RULE_FROM = `approval_rules r
  left join contacts c on c.id = r.contact_id
  left join accounts a on a.id = r.account_id
  left join tracking_values v on v.id = r.tracking_value_id
  left join tracking_categories tc on tc.id = v.category_id`;

async function loadSteps(tx: OrgTx, ruleIds: string[]): Promise<Map<string, ApprovalRuleStep[]>> {
  const result = await tx.query<{ rule_id: string; step_number: number; mode: ApprovalMode; user_id: string | null; email: string | null }>(
    `select s.rule_id::text, s.step_number, s.mode, p.user_id::text, p.email
       from approval_rule_steps s left join approval_step_approvers p on p.step_id = s.id
      where s.rule_id = any($1::bigint[])
      order by s.rule_id, s.step_number, lower(p.email)`,
    [ruleIds],
  );
  const steps = new Map<string, ApprovalRuleStep[]>();
  for (const row of result.rows) {
    const list = steps.get(row.rule_id) ?? [];
    let step = list.find((item) => item.stepNumber === row.step_number);
    if (!step) {
      step = { stepNumber: row.step_number, mode: row.mode, approvers: [] };
      list.push(step);
    }
    if (row.user_id && row.email) step.approvers.push({ userId: row.user_id, email: row.email });
    steps.set(row.rule_id, list);
  }
  return steps;
}

function toRule(row: RuleRow, steps: ApprovalRuleStep[]): ApprovalRule {
  return {
    id: row.id,
    documentType: row.document_type,
    name: row.name,
    position: row.position,
    minTotal: row.min_total,
    contactId: row.contact_id,
    contactName: row.contact_name,
    claimantUserId: row.claimant_user_id,
    claimantEmail: row.claimant_email,
    accountId: row.account_id,
    accountCode: row.account_code,
    accountName: row.account_name,
    trackingValueId: row.tracking_value_id,
    trackingValueName: row.tracking_value_name,
    trackingCategoryName: row.tracking_category_name,
    steps,
    version: row.version,
    archivedAt: row.archived_at,
    archivedByEmail: row.archived_by_email,
    createdByEmail: row.created_by_email,
    updatedByEmail: row.updated_by_email,
    updatedAt: row.updated_at,
  };
}

async function rulesWhere(tx: OrgTx, where: string, params: unknown[]): Promise<ApprovalRule[]> {
  const result = await tx.query<RuleRow>(`select ${RULE_COLUMNS} from ${RULE_FROM} where ${where} order by r.document_type, r.position, r.id`, params);
  const steps = await loadSteps(tx, result.rows.map((row) => row.id));
  const scale = currencyMinorUnits(tx.baseCurrency);
  return result.rows.map((row) => toRule({ ...row, min_total: row.min_total === null ? null : toFixedString(dec(row.min_total), scale) }, steps.get(row.id) ?? []));
}

/** Every rule, active ones in order, then archived ones (`archived` true). */
export async function listApprovalRules(tx: OrgTx, filters: { documentType?: unknown; archived?: unknown } = {}): Promise<ApprovalRule[]> {
  const type = filters.documentType == null || filters.documentType === "" ? null : requireOneOf(filters.documentType, "documentType", APPROVAL_DOCUMENT_TYPES);
  const archived = optionalBoolean(filters.archived === "true" ? true : filters.archived === "false" ? false : filters.archived, "archived") ?? false;
  return rulesWhere(tx, `($1::text is null or r.document_type = $1) and (r.archived_at is not null) = $2`, [type, archived]);
}

export async function getApprovalRule(tx: OrgTx, idInput: unknown): Promise<ApprovalRule> {
  const id = optionalId(idInput, "ruleId");
  const [rule] = id ? await rulesWhere(tx, "r.id = $1", [id]) : [];
  if (!rule) throw new NotFoundError("Approval rule not found.");
  return rule;
}

// ---------------------------------------------------------------- changing

function assertAdmin(role: Role): void {
  if (!roleAtLeast(role, "admin")) throw new ForbiddenError("Only admins can change approval rules.");
}

type ParsedRule = {
  documentType: ApprovalDocumentType;
  name: string;
  minTotal: string | null;
  contactId: string | null;
  claimant: { userId: string; email: string } | null;
  accountId: string | null;
  trackingValueId: string | null;
  steps: ApprovalRuleStep[];
};

async function parseRule(tx: OrgTx, input: Record<string, unknown>, documentType: ApprovalDocumentType): Promise<{ rule: ParsedRule; warnings: string[] }> {
  const name = requireString(input.name, "The rule's name", { maxLength: 100 });
  const scale = currencyMinorUnits(tx.baseCurrency);
  const minTotal =
    input.minTotal == null || input.minTotal === ""
      ? null
      : parseDecimalInput(input.minTotal, "The minimum total", { maxScale: scale, allowZero: true });
  const contactId = documentType === "expense_claim" ? null : optionalId(input.contactId, "contactId");
  if (documentType === "expense_claim" && input.contactId) throw new ValidationError("An expense claim rule names a claimant, not a supplier.");
  if (documentType !== "expense_claim" && input.claimantUserId) throw new ValidationError("Only an expense claim rule names a claimant.");
  if (contactId) {
    const found = await tx.query("select 1 from contacts where id = $1", [contactId]);
    if (found.rowCount === 0) throw new ValidationError("That supplier wasn't found.");
  }
  const accountId = optionalId(input.accountId, "accountId");
  if (accountId) {
    const found = await tx.query("select 1 from accounts where id = $1", [accountId]);
    if (found.rowCount === 0) throw new ValidationError("That account wasn't found.");
  }
  const trackingValueId = optionalId(input.trackingValueId, "trackingValueId");
  if (trackingValueId) {
    const found = await tx.query("select 1 from tracking_values where id = $1", [trackingValueId]);
    if (found.rowCount === 0) throw new ValidationError("That tracking value wasn't found.");
  }

  const members = await organisationMembers(tx.organisationId);
  const memberById = new Map(members.map((member) => [member.userId, member]));
  let claimant: ParsedRule["claimant"] = null;
  if (documentType === "expense_claim" && input.claimantUserId != null && input.claimantUserId !== "") {
    const member = memberById.get(String(input.claimantUserId));
    if (!member) throw new ValidationError("The claimant must be a member of this organisation.");
    claimant = { userId: member.userId, email: member.email };
  }

  const stepsInput = requireArray(input.steps, "steps", MAX_APPROVAL_STEPS);
  if (stepsInput.length === 0) throw new ValidationError("Add at least one approval step.");
  const warnings: string[] = [];
  const steps = stepsInput.map((raw, index): ApprovalRuleStep => {
    const stepNumber = index + 1;
    const step = asRecord(raw, `Step ${stepNumber}`);
    const mode = requireOneOf(step.mode ?? "any", `Step ${stepNumber}'s mode`, APPROVAL_MODES);
    const ids = requireArray(step.approverUserIds, `Step ${stepNumber}'s approvers`, MAX_STEP_APPROVERS).map(String);
    if (ids.length === 0) throw new ValidationError(`Step ${stepNumber} has no approvers. Choose who approves it.`);
    if (new Set(ids).size !== ids.length) throw new ValidationError(`Step ${stepNumber} names someone twice.`);
    const approvers = ids.map((userId) => {
      const member = memberById.get(userId);
      if (!member) throw new ValidationError(`Step ${stepNumber}: an approver isn't a member of this organisation.`);
      if (!roleAtLeast(member.role, "bookkeeper")) {
        throw new ValidationError(
          `Step ${stepNumber}: ${member.displayName} is a ${ROLE_LABELS[member.role].toLowerCase()}. Approvers must be bookkeepers, admins or owners.`,
        );
      }
      return { userId: member.userId, email: member.email };
    });
    // A step only its submitter could approve can never be done (AW6).
    if (approvers.length === 1) {
      const who = memberById.get(approvers[0].userId)!.displayName;
      warnings.push(
        `Step ${stepNumber} has one approver, ${who}. Nobody approves their own ${documentNoun(documentType)}, so one that ${who} submits or makes waits at this step until the rule's approvers are changed.`,
      );
    } else if (mode === "all") {
      warnings.push(
        `Step ${stepNumber} needs all of its approvers, so ${documentType === "expense_claim" ? "an" : "a"} ${documentNoun(documentType)} one of them submits or makes waits at this step until the rule's approvers are changed.`,
      );
    }
    return { stepNumber, mode, approvers };
  });
  return { rule: { documentType, name, minTotal, contactId, claimant, accountId, trackingValueId, steps }, warnings };
}

async function saveSteps(tx: OrgTx, ruleId: string, steps: ApprovalRuleStep[]): Promise<void> {
  await tx.query("delete from approval_rule_steps where rule_id = $1", [ruleId]);
  for (const step of steps) {
    const inserted = await tx.query<{ id: string }>(
      "insert into approval_rule_steps (rule_id, step_number, mode) values ($1, $2, $3) returning id::text",
      [ruleId, step.stepNumber, step.mode],
    );
    for (const approver of step.approvers) {
      await tx.query("insert into approval_step_approvers (step_id, user_id, email) values ($1, $2, $3)", [inserted.rows[0].id, approver.userId, approver.email]);
    }
  }
}

function stepsForAudit(steps: ApprovalRuleStep[]) {
  return steps.map((step) => ({ step: step.stepNumber, mode: step.mode, approvers: step.approvers.map((approver) => approver.email) }));
}

function nameTaken(error: unknown, name: string): never {
  if ((error as { code?: string }).code === "23505") throw new ConflictError(`There's already an approval rule called "${name}" for these documents.`);
  throw error;
}

/** Adds a rule at the end of its document type's list (AW1). Returns warnings about steps that can get stuck (AW6). */
export async function createApprovalRule(tx: OrgTx, role: Role, input: Record<string, unknown>): Promise<{ rule: ApprovalRule; warnings: string[] }> {
  assertAdmin(role);
  const documentType = requireOneOf(input.documentType, "documentType", APPROVAL_DOCUMENT_TYPES);
  const { rule, warnings } = await parseRule(tx, input, documentType);
  const position = await tx.query<{ next: number }>(
    "select coalesce(max(position), 0) + 1 as next from approval_rules where document_type = $1",
    [documentType],
  );
  const inserted = await tx
    .query<{ id: string }>(
      `insert into approval_rules (document_type, name, position, min_total, contact_id, claimant_user_id, claimant_email, account_id,
                                   tracking_value_id, created_by_email, updated_by_email)
       values ($1, $2, $3, $4::numeric, $5, $6, $7, $8, $9, $10, $10) returning id::text`,
      [documentType, rule.name, position.rows[0].next, rule.minTotal, rule.contactId, rule.claimant?.userId ?? null, rule.claimant?.email ?? null, rule.accountId, rule.trackingValueId, tx.actor.email],
    )
    .catch((error) => nameTaken(error, rule.name));
  const id = inserted.rows[0].id;
  await saveSteps(tx, id, rule.steps);
  await writeAuditEvent(tx, {
    eventType: "approval_rule.created",
    entityType: "approval_rule",
    entityId: id,
    details: { documentType, name: rule.name, minTotal: rule.minTotal, contactId: rule.contactId, claimantEmail: rule.claimant?.email ?? null, accountId: rule.accountId, trackingValueId: rule.trackingValueId, steps: stepsForAudit(rule.steps) },
  });
  return { rule: await getApprovalRule(tx, id), warnings };
}

/**
 * Changes a rule's name, conditions and steps (its document type stays).
 * A document waiting for approval follows the rule as it is now (AW6).
 * `version` must be the one read, so two admins don't overwrite each other.
 */
export async function updateApprovalRule(tx: OrgTx, role: Role, idInput: unknown, input: Record<string, unknown>): Promise<{ rule: ApprovalRule; warnings: string[] }> {
  assertAdmin(role);
  const current = await getApprovalRule(tx, idInput);
  if (current.archivedAt) throw new ConflictError(`The rule "${current.name}" is archived. Restore it before changing it.`);
  if (Number(input.version) !== current.version) throw new ConflictError("Someone else changed this rule since you opened it. Reload it and try again.");
  const { rule, warnings } = await parseRule(tx, input, current.documentType);
  await tx
    .query(
      `update approval_rules set name = $2, min_total = $3::numeric, contact_id = $4, claimant_user_id = $5, claimant_email = $6, account_id = $7,
              tracking_value_id = $8, version = version + 1, updated_by_email = $9, updated_at = now()
        where id = $1`,
      [current.id, rule.name, rule.minTotal, rule.contactId, rule.claimant?.userId ?? null, rule.claimant?.email ?? null, rule.accountId, rule.trackingValueId, tx.actor.email],
    )
    .catch((error) => nameTaken(error, rule.name));
  await saveSteps(tx, current.id, rule.steps);
  await writeAuditEvent(tx, {
    eventType: "approval_rule.updated",
    entityType: "approval_rule",
    entityId: current.id,
    details: {
      name: rule.name,
      minTotal: rule.minTotal,
      contactId: rule.contactId,
      claimantEmail: rule.claimant?.email ?? null,
      accountId: rule.accountId,
      trackingValueId: rule.trackingValueId,
      steps: stepsForAudit(rule.steps),
      before: { name: current.name, minTotal: current.minTotal, steps: stepsForAudit(current.steps) },
    },
  });
  return { rule: await getApprovalRule(tx, current.id), warnings };
}

/** Archives a rule (new documents no longer match it; one already waiting carries on) or restores it at the end of the list. */
export async function setApprovalRuleArchived(tx: OrgTx, role: Role, idInput: unknown, archived: boolean): Promise<ApprovalRule> {
  assertAdmin(role);
  const current = await getApprovalRule(tx, idInput);
  if ((current.archivedAt !== null) === archived) return current;
  if (archived) {
    await tx.query("update approval_rules set archived_at = now(), archived_by_email = $2, version = version + 1, updated_at = now() where id = $1", [current.id, tx.actor.email]);
  } else {
    await tx
      .query(
        `update approval_rules set archived_at = null, archived_by_email = null, version = version + 1, updated_at = now(),
                position = (select coalesce(max(position), 0) + 1 from approval_rules where document_type = $2 and archived_at is null)
          where id = $1`,
        [current.id, current.documentType],
      )
      .catch((error) => nameTaken(error, current.name));
  }
  await writeAuditEvent(tx, { eventType: archived ? "approval_rule.archived" : "approval_rule.unarchived", entityType: "approval_rule", entityId: current.id, details: { name: current.name } });
  return getApprovalRule(tx, current.id);
}

/** Moves a rule up or down its document type's list: rules are tried in order (AW11). */
export async function moveApprovalRule(tx: OrgTx, role: Role, idInput: unknown, directionInput: unknown): Promise<ApprovalRule[]> {
  assertAdmin(role);
  const direction = requireOneOf(directionInput, "direction", ["up", "down"] as const);
  const current = await getApprovalRule(tx, idInput);
  if (current.archivedAt) throw new ConflictError("An archived rule has no place in the order.");
  await tx.query("select id from approval_rules where document_type = $1 for update", [current.documentType]);
  const ordered = (await listApprovalRules(tx, { documentType: current.documentType })).map((rule) => rule.id);
  const index = ordered.indexOf(current.id);
  const swap = direction === "up" ? index - 1 : index + 1;
  if (swap >= 0 && swap < ordered.length) {
    [ordered[index], ordered[swap]] = [ordered[swap], ordered[index]];
    for (const [position, id] of ordered.entries()) {
      await tx.query("update approval_rules set position = $2 where id = $1", [id, position + 1]);
    }
    await writeAuditEvent(tx, { eventType: "approval_rule.moved", entityType: "approval_rule", entityId: current.id, details: { name: current.name, position: swap + 1 } });
  }
  return listApprovalRules(tx, { documentType: current.documentType });
}

// ---------------------------------------------------------------- documents

export type DocumentLine = {
  accountId: string;
  accountCode: string;
  accountName: string;
  accountClass: string;
  /** Excluding GST, in the base currency. */
  baseNet: Decimal;
  tracking: Record<string, string>;
};

/** What a rule looks at in a document, and what the approval pages show. */
export type DocumentFacts = {
  type: ApprovalDocumentType;
  id: string;
  status: string;
  label: string;
  partyName: string;
  number: string | null;
  date: string;
  currencyCode: string;
  total: string;
  contactId: string | null;
  claimantUserId: string | null;
  /** Who made it (bills and purchase orders) or whose claim it is: they never approve it (AW6, question 4). */
  makerUserId: string | null;
  makerEmail: string | null;
  lines: DocumentLine[];
  /** The total in the base currency (question 7); worked out when a rule needs it. */
  baseTotal(): Promise<Decimal>;
};

type LineRow = { account_id: string; code: string; name: string; account_class: string; net: string; tracking: Record<string, string> };

export async function loadDocumentFacts(tx: OrgTx, type: ApprovalDocumentType, idInput: unknown): Promise<DocumentFacts> {
  const id = optionalId(idInput, "documentId");
  if (!id) throw new ValidationError("documentId must be a positive whole number.");
  const scale = currencyMinorUnits(tx.baseCurrency);
  if (type === "bill") {
    const found = await tx.query<{
      status: string; contact_id: string; contact_name: string; number: string | null; bill_date: string; currency_code: string;
      total: string; base_total: string | null; created_by_user_id: string | null; created_by_email: string | null;
    }>(
      `select b.status, b.contact_id::text, c.name as contact_name, b.supplier_invoice_number as number, b.bill_date::text, b.currency_code,
              b.total::text, b.base_total::text, b.created_by_user_id::text, b.created_by_email
         from bills b join contacts c on c.id = b.contact_id where b.id = $1`,
      [id],
    );
    const row = found.rows[0];
    if (!row) throw new NotFoundError("Bill not found.");
    const lines = await tx.query<LineRow>(
      `select l.account_id::text, a.code, a.name, a.account_class, coalesce(l.base_net_amount, l.net_amount)::text as net, l.tracking
         from bill_lines l join accounts a on a.id = l.account_id where l.bill_id = $1 order by l.line_order`,
      [id],
    );
    return {
      type, id, status: row.status,
      label: row.number ? `Bill ${row.number} from ${row.contact_name}` : `The draft bill from ${row.contact_name}`,
      partyName: row.contact_name, number: row.number, date: row.bill_date, currencyCode: row.currency_code, total: row.total,
      contactId: row.contact_id, claimantUserId: null, makerUserId: row.created_by_user_id, makerEmail: row.created_by_email,
      lines: lines.rows.map(toLine),
      baseTotal: async () => dec(row.base_total ?? row.total),
    };
  }
  if (type === "purchase_order") {
    const found = await tx.query<{
      status: string; contact_id: string; contact_name: string; number: string | null; order_date: string; currency_code: string;
      total: string; created_by_user_id: string | null; created_by_email: string | null;
    }>(
      `select p.status, p.contact_id::text, c.name as contact_name, p.po_number as number, p.order_date::text, p.currency_code,
              p.total::text, p.created_by_user_id::text, p.created_by_email
         from purchase_orders p join contacts c on c.id = p.contact_id where p.id = $1`,
      [id],
    );
    const row = found.rows[0];
    if (!row) throw new NotFoundError("Purchase order not found.");
    // A purchase order in another currency has no rate of its own (MC28): the exchange rates list's for its date.
    let rate: string | null | undefined;
    const rateFor = async (): Promise<string | null> => {
      if (rate !== undefined) return rate;
      try {
        rate = await exchangeRateFor(tx, { currencyCode: row.currency_code, date: row.order_date, typed: undefined, what: "purchase order" });
      } catch {
        throw new ValidationError(
          `There's no ${row.currency_code} exchange rate on or before ${row.order_date} to compare this purchase order's total with the approval rules (in ${tx.baseCurrency}). Add one in Accounting › Exchange rates.`,
        );
      }
      return rate;
    };
    const lines = await tx.query<LineRow>(
      `select l.account_id::text, a.code, a.name, a.account_class, l.net_amount::text as net, l.tracking
         from purchase_order_lines l join accounts a on a.id = l.account_id where l.purchase_order_id = $1 order by l.line_order`,
      [id],
    );
    const foreign = row.currency_code !== tx.baseCurrency;
    const toBase = async (amount: string) => {
      const used = foreign ? await rateFor() : null;
      return used ? dec(toFixedString(divide(mul(dec(amount), dec(used)), dec("1"), scale), scale)) : dec(amount);
    };
    const baseLines: DocumentLine[] = [];
    for (const line of lines.rows) {
      baseLines.push({ ...toLine(line), baseNet: foreign ? await toBase(line.net).catch(() => dec(line.net)) : dec(line.net) });
    }
    return {
      type, id, status: row.status,
      label: row.number ? `Purchase order ${row.number} to ${row.contact_name}` : `The draft purchase order to ${row.contact_name}`,
      partyName: row.contact_name, number: row.number, date: row.order_date, currencyCode: row.currency_code, total: row.total,
      contactId: row.contact_id, claimantUserId: null, makerUserId: row.created_by_user_id, makerEmail: row.created_by_email,
      lines: baseLines,
      baseTotal: () => toBase(row.total),
    };
  }
  const found = await tx.query<{ status: string; claimant_user_id: string | null; claimant_email: string; currency_code: string; total: string; latest: string | null }>(
    `select e.status, e.claimant_user_id::text, e.claimant_email, e.currency_code, e.total::text,
            (select max(r.receipt_date)::text from expense_claim_receipts r where r.claim_id = e.id) as latest
       from expense_claims e where e.id = $1`,
    [id],
  );
  const row = found.rows[0];
  if (!row) throw new NotFoundError("Expense claim not found.");
  const lines = await tx.query<LineRow>(
    `select r.account_id::text, a.code, a.name, a.account_class, r.net_amount::text as net, r.tracking
       from expense_claim_receipts r join accounts a on a.id = r.account_id where r.claim_id = $1 order by r.line_order`,
    [id],
  );
  const who = nameOf(tx.people, row.claimant_email);
  return {
    type, id, status: row.status,
    label: `Expense claim CLAIM-${id} from ${who}`,
    partyName: who, number: `CLAIM-${id}`, date: row.latest ?? "", currencyCode: row.currency_code, total: row.total,
    contactId: null, claimantUserId: row.claimant_user_id, makerUserId: row.claimant_user_id, makerEmail: row.claimant_email,
    lines: lines.rows.map(toLine),
    baseTotal: async () => dec(row.total),
  };
}

function toLine(row: LineRow): DocumentLine {
  return { accountId: row.account_id, accountCode: row.code, accountName: row.name, accountClass: row.account_class, baseNet: dec(row.net), tracking: row.tracking ?? {} };
}

/** The first active rule, in order, whose conditions all hold for the document (AW2, AW3, AW11); null if none. */
export async function matchingRule(tx: OrgTx, facts: DocumentFacts): Promise<ApprovalRule | null> {
  const rules = await listApprovalRules(tx, { documentType: facts.type });
  const tagged = new Set(facts.lines.flatMap((line) => Object.values(line.tracking)));
  for (const rule of rules) {
    if (rule.contactId && rule.contactId !== facts.contactId) continue;
    if (rule.claimantUserId && rule.claimantUserId !== facts.claimantUserId) continue;
    if (rule.accountId && !facts.lines.some((line) => line.accountId === rule.accountId)) continue;
    // A tracking value matches lines tagged with it or a value under it, as reports filter (TC8).
    if (rule.trackingValueId && !(await valueWithDescendants(tx, rule.trackingValueId)).some((value) => tagged.has(value))) continue;
    if (rule.minTotal !== null && cmp(await facts.baseTotal(), dec(rule.minTotal)) < 0) continue;
    return rule;
  }
  return null;
}
