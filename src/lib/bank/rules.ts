import { writeAuditEvent } from "@/lib/audit";
import type { StatementLine } from "@/lib/bank/accounts";
import type { OrgTx } from "@/lib/db/org-transaction";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { add, cmp, dec, isNegative, isPositive, isZero, parseDecimalInput, sub, toFixedString } from "@/lib/money/decimal";
import { splitByPercentages } from "@/lib/payroll/allocation-split";
import { type AvailableOn, isAvailableOn, onlyWords, ruleSides } from "@/lib/tax/available-on";
import { assertRequiredTags, checkNewTags, loadTrackingContext, parseTrackingInput, sortedTags, type TrackingTags } from "@/lib/tracking/service";
import type { AccountClass } from "@/lib/accounts/types";
import { asRecord, optionalBoolean, optionalId, optionalString, requireArray, requireId, requireOneOf, requireString } from "@/lib/validation";

/**
 * Bank rules (BK10, BR1-BR10): when a statement line meets a rule's
 * conditions, suggest a bank transaction (contact, then lines with account,
 * GST code and tracking: fixed amounts first, the rest split by
 * percentages). A suggestion posts nothing until it's confirmed on the
 * reconcile screen (Jess, 5 Oct 2026: rules never post by themselves). Rules
 * are settings, so they can be edited and deleted; changes are audited.
 */
export const RULE_DIRECTIONS = ["any", "in", "out"] as const;
export const RULE_TEXT_FIELDS = ["any", "description", "payee", "particulars", "code", "reference"] as const;
export const RULE_TEXT_OPERATORS = ["contains", "equals", "starts_with"] as const;
export const RULE_AMOUNT_OPERATORS = ["equals", "at_least", "at_most", "between"] as const;
export const RULE_MATCH_MODES = ["all", "any"] as const;
export const RULE_CONTACT_MODES = ["chosen", "payee"] as const;
export const MAX_RULE_CONDITIONS = 10;
export const MAX_RULE_LINES = 20;

export type RuleTextField = (typeof RULE_TEXT_FIELDS)[number];

export type RuleCondition =
  | { field: RuleTextField; operator: (typeof RULE_TEXT_OPERATORS)[number]; text: string }
  | { field: "amount"; operator: (typeof RULE_AMOUNT_OPERATORS)[number]; amount: string; amountTo: string | null };

export type RuleLine = {
  accountId: string;
  accountCode: string;
  accountName: string;
  taxCode: string | null;
  description: string | null;
  tracking: TrackingTags;
  /** Exactly one of these is set: a fixed amount (taken first), or a share of what's left. */
  fixedAmount: string | null;
  percentage: string | null;
};

export type BankRule = {
  id: string;
  name: string;
  isActive: boolean;
  priority: number;
  accountId: string | null;
  accountCode: string | null;
  direction: (typeof RULE_DIRECTIONS)[number];
  matchMode: (typeof RULE_MATCH_MODES)[number];
  conditions: RuleCondition[];
  contactMode: (typeof RULE_CONTACT_MODES)[number];
  contactId: string | null;
  contactName: string | null;
  lines: RuleLine[];
};

type RuleRow = {
  id: string;
  name: string;
  is_active: boolean;
  priority: number;
  account_id: string | null;
  account_code: string | null;
  direction: BankRule["direction"];
  match_mode: BankRule["matchMode"];
  contact_mode: BankRule["contactMode"];
  contact_id: string | null;
  contact_name: string | null;
  conditions: Array<{ field: string; operator: string; text_value: string | null; amount_from: string | null; amount_to: string | null }>;
  lines: Array<{
    account_id: string;
    account_code: string;
    account_name: string;
    tax_code: string | null;
    description: string | null;
    tracking: TrackingTags;
    fixed_amount: string | null;
    percentage: string | null;
  }>;
};

const SELECT = `
  select r.id, r.name, r.is_active, r.priority, r.account_id, a.code as account_code, r.direction, r.match_mode,
         r.contact_mode, r.contact_id, c.name as contact_name,
         coalesce((select jsonb_agg(jsonb_build_object('field', k.field, 'operator', k.operator, 'text_value', k.text_value,
                                                      'amount_from', k.amount_from::text, 'amount_to', k.amount_to::text) order by k.position)
                     from bank_rule_conditions k where k.rule_id = r.id), '[]'::jsonb) as conditions,
         coalesce((select jsonb_agg(jsonb_build_object('account_id', l.account_id::text, 'account_code', t.code, 'account_name', t.name,
                                                      'tax_code', tc.code, 'description', l.description, 'tracking', l.tracking,
                                                      'fixed_amount', l.fixed_amount::text, 'percentage', l.percentage::text) order by l.position)
                     from bank_rule_lines l join accounts t on t.id = l.account_id left join tax_codes tc on tc.id = l.tax_code_id
                    where l.rule_id = r.id), '[]'::jsonb) as lines
    from bank_rules r
    left join accounts a on a.id = r.account_id
    left join contacts c on c.id = r.contact_id`;

function toRule(row: RuleRow): BankRule {
  return {
    id: row.id,
    name: row.name,
    isActive: row.is_active,
    priority: row.priority,
    accountId: row.account_id,
    accountCode: row.account_code,
    direction: row.direction,
    matchMode: row.match_mode,
    conditions: row.conditions.map((condition): RuleCondition =>
      condition.field === "amount"
        ? {
            field: "amount",
            operator: condition.operator as (typeof RULE_AMOUNT_OPERATORS)[number],
            amount: toFixedString(dec(condition.amount_from!), 2),
            amountTo: condition.amount_to === null ? null : toFixedString(dec(condition.amount_to), 2),
          }
        : {
            field: condition.field as RuleTextField,
            operator: condition.operator as (typeof RULE_TEXT_OPERATORS)[number],
            text: condition.text_value!,
          },
    ),
    contactMode: row.contact_mode,
    contactId: row.contact_id,
    contactName: row.contact_name,
    lines: row.lines.map((line) => ({
      accountId: line.account_id,
      accountCode: line.account_code,
      accountName: line.account_name,
      taxCode: line.tax_code,
      description: line.description,
      tracking: sortedTags(line.tracking),
      fixedAmount: line.fixed_amount === null ? null : toFixedString(dec(line.fixed_amount), 2),
      percentage: line.percentage === null ? null : toFixedString(dec(line.percentage), 2),
    })),
  };
}

export async function listBankRules(tx: OrgTx, options: { activeOnly?: boolean } = {}): Promise<BankRule[]> {
  const result = await tx.query<RuleRow>(
    `${SELECT} where ($1::boolean is not true or r.is_active) order by r.priority, r.id`,
    [options.activeOnly ?? false],
  );
  return result.rows.map(toRule);
}

export async function getBankRule(tx: OrgTx, idInput: unknown): Promise<BankRule> {
  const id = requireId(idInput, "ruleId");
  const result = await tx.query<RuleRow>(`${SELECT} where r.id = $1`, [id]);
  if (!result.rows[0]) throw new NotFoundError("Bank rule not found.");
  return toRule(result.rows[0]);
}

type RuleInput = {
  name?: unknown;
  isActive?: unknown;
  priority?: unknown;
  accountId?: unknown;
  direction?: unknown;
  matchMode?: unknown;
  conditions?: unknown;
  contactMode?: unknown;
  contactId?: unknown;
  lines?: unknown;
  // The single-condition, single-line shape rules had before BR1 (BK10);
  // still accepted, e.g. "Make a rule" from the reconcile screen.
  matchField?: unknown;
  matchText?: unknown;
  targetAccountCode?: unknown;
  taxCode?: unknown;
  amountsMode?: unknown;
  lineDescription?: unknown;
};

const money = (value: unknown, label: string) => toFixedString(dec(parseDecimalInput(value, label, { maxScale: 2 })), 2);

function parseCondition(raw: unknown, index: number): RuleCondition {
  const label = `Condition ${index + 1}`;
  const entry = asRecord(raw, label);
  const field = requireOneOf(entry.field, `${label} field`, [...RULE_TEXT_FIELDS, "amount"] as const);
  if (field === "amount") {
    const operator = requireOneOf(entry.operator, `${label} operator`, RULE_AMOUNT_OPERATORS);
    const amount = money(entry.amount, `${label} amount`);
    if (isNegative(dec(amount))) throw new ValidationError(`${label}: amounts are without their sign (money in or out is chosen separately).`);
    let amountTo: string | null = null;
    if (operator === "between") {
      amountTo = money(entry.amountTo, `${label} second amount`);
      if (cmp(dec(amount), dec(amountTo)) > 0) throw new ValidationError(`${label}: the first amount can't be more than the second.`);
    }
    return { field, operator, amount, amountTo };
  }
  const operator = requireOneOf(entry.operator ?? "contains", `${label} operator`, RULE_TEXT_OPERATORS);
  const text = requireString(entry.text, `${label} text`, { maxLength: 200 });
  return { field, operator, text };
}

type ParsedLine = { accountCode: string; taxCode: string | null; description: string | null; tracking: TrackingTags; fixedAmount: string | null; percentage: string | null };

function parseLine(raw: unknown, index: number): ParsedLine {
  const label = `Line ${index + 1}`;
  const entry = asRecord(raw, label);
  const fixedRaw = entry.fixedAmount ?? null;
  const percentageRaw = entry.percentage ?? null;
  const hasFixed = fixedRaw !== null && fixedRaw !== "";
  const hasPercentage = percentageRaw !== null && percentageRaw !== "";
  if (hasFixed === hasPercentage) throw new ValidationError(`${label}: give either a fixed amount or a percentage.`);
  let fixedAmount: string | null = null;
  let percentage: string | null = null;
  if (hasFixed) {
    fixedAmount = money(fixedRaw, `${label} fixed amount`);
    if (!isPositive(dec(fixedAmount))) throw new ValidationError(`${label}: a fixed amount must be more than 0.`);
  } else {
    percentage = toFixedString(dec(parseDecimalInput(percentageRaw, `${label} percentage`, { maxScale: 2 })), 2);
    if (!isPositive(dec(percentage)) || cmp(dec(percentage), dec("100")) > 0) {
      throw new ValidationError(`${label}: a percentage must be more than 0 and at most 100.`);
    }
  }
  return {
    accountCode: requireString(entry.accountCode, `${label} account`, { maxLength: 20 }),
    taxCode: optionalString(entry.taxCode, `${label} tax code`, { maxLength: 20 }) || null,
    description: optionalString(entry.description, `${label} description`, { maxLength: 500 }) || null,
    tracking: sortedTags(parseTrackingInput(entry.tracking, label)),
    fixedAmount,
    percentage,
  };
}

/** The rule as the request gives it: the full shape, or the older single-condition one. */
function parseShape(input: RuleInput): { conditions: RuleCondition[]; lines: ParsedLine[] } {
  if (input.conditions === undefined && input.lines === undefined) {
    const text = requireString(input.matchText, "matchText", { maxLength: 200 });
    const field = input.matchField == null ? "any" : requireOneOf(input.matchField, "matchField", RULE_TEXT_FIELDS);
    const noTax = input.amountsMode === "no_tax";
    return {
      conditions: [{ field, operator: "contains", text }],
      lines: [
        parseLine(
          {
            accountCode: input.targetAccountCode,
            taxCode: noTax ? null : input.taxCode,
            description: input.lineDescription,
            percentage: "100",
          },
          0,
        ),
      ],
    };
  }
  const conditions = requireArray(input.conditions, "conditions", MAX_RULE_CONDITIONS).map(parseCondition);
  if (conditions.length === 0) throw new ValidationError("Add at least one condition.");
  const lines = requireArray(input.lines, "lines", MAX_RULE_LINES).map(parseLine);
  const shares = lines.filter((line) => line.percentage !== null);
  if (shares.length === 0) throw new ValidationError("Add at least one percentage line for what's left after any fixed amounts.");
  const total = shares.reduce((sum, line) => add(sum, dec(line.percentage!)), dec("0"));
  if (cmp(total, dec("100")) !== 0) {
    throw new ValidationError(`The percentage lines add up to ${toFixedString(total, 2)}%; they must add up to exactly 100%.`);
  }
  return { conditions, lines };
}

async function resolveRule(tx: OrgTx, input: RuleInput) {
  const name = requireString(input.name, "name", { maxLength: 100 });
  const priorityRaw = input.priority == null || input.priority === "" ? 100 : Number(input.priority);
  if (!Number.isInteger(priorityRaw) || priorityRaw < 0 || priorityRaw > 10_000) {
    throw new ValidationError("priority must be a whole number from 0 to 10000 (lower runs first).");
  }
  const accountId = optionalId(input.accountId, "accountId");
  if (accountId) {
    const account = await tx.query("select 1 from accounts where id = $1 and account_type in ('bank', 'credit_card')", [accountId]);
    if (account.rowCount === 0) throw new ValidationError("The rule's account must be a bank or credit card account.");
  }
  const direction = input.direction == null ? "any" : requireOneOf(input.direction, "direction", RULE_DIRECTIONS);
  const matchMode = input.matchMode == null ? "all" : requireOneOf(input.matchMode, "matchMode", RULE_MATCH_MODES);
  const contactMode = input.contactMode == null ? "chosen" : requireOneOf(input.contactMode, "contactMode", RULE_CONTACT_MODES);
  let contactId: string | null = null;
  if (contactMode === "chosen") {
    contactId = requireId(input.contactId, "contactId");
    const contact = await tx.query("select 1 from contacts where id = $1", [contactId]);
    if (contact.rowCount === 0) throw new ValidationError(`There's no contact #${contactId}.`);
  }
  const shape = parseShape(input);

  const tracking = await loadTrackingContext(tx);
  const lines: Array<ParsedLine & { accountId: string; taxCodeId: string | null; accountClass: AccountClass }> = [];
  for (const [index, line] of shape.lines.entries()) {
    const label = `Line ${index + 1}`;
    const target = await tx.query<{ id: string; is_active: boolean; account_class: AccountClass }>(
      "select id, is_active, account_class from accounts where lower(code) = lower($1)",
      [line.accountCode],
    );
    if (!target.rows[0]) throw new ValidationError(`${label}: there's no account with the code ${line.accountCode}.`);
    if (!target.rows[0].is_active) throw new ValidationError(`${label}: account ${line.accountCode} is archived.`);
    let taxCodeId: string | null = null;
    if (line.taxCode) {
      const taxCode = await tx.query<{ id: string; code: string; available_on: AvailableOn; is_active: boolean }>(
        "select id, code, available_on, is_active from tax_codes where code = $1",
        [line.taxCode],
      );
      const found = taxCode.rows[0];
      if (!found) throw new ValidationError(`${label}: there's no tax code ${line.taxCode}.`);
      if (!found.is_active) throw new ValidationError(`${label}: tax code ${found.code} is inactive.`);
      // Money in becomes receive money (sales), out spend money (purchases); a rule for either needs a code for both (TAO8).
      const missing = ruleSides(direction).find((side) => !isAvailableOn(found.available_on, side));
      if (missing) {
        // One line reads as it always did (TAO8); with several, say which.
        throw new ValidationError(
          `${shape.lines.length === 1 ? "Tax" : `${label}: tax`} code ${found.code} is available on ${onlyWords(found.available_on)}, so it can't be used on a rule for ${
            direction === "any" ? "money in or out (that needs a code available on both)" : direction === "in" ? "money in (receive money is sales)" : "money out (spend money is purchases)"
          }.`,
        );
      }
      taxCodeId = found.id;
    }
    checkNewTags(tracking, line.tracking, label);
    lines.push({ ...line, accountId: target.rows[0].id, taxCodeId, accountClass: target.rows[0].account_class });
  }
  assertRequiredTags(tracking, lines.map((line) => ({ tags: line.tracking, accountClass: line.accountClass })));

  return {
    name,
    isActive: optionalBoolean(input.isActive, "isActive") ?? true,
    priority: priorityRaw,
    accountId,
    direction,
    matchMode,
    contactMode,
    contactId,
    conditions: shape.conditions,
    lines,
  };
}

type ResolvedRule = Awaited<ReturnType<typeof resolveRule>>;

async function clearParts(tx: OrgTx, id: string) {
  await tx.query("delete from bank_rule_conditions where rule_id = $1", [id]);
  await tx.query("delete from bank_rule_lines where rule_id = $1", [id]);
}

async function writeParts(tx: OrgTx, id: string, rule: ResolvedRule) {
  for (const [index, condition] of rule.conditions.entries()) {
    await tx.query(
      `insert into bank_rule_conditions (rule_id, position, field, operator, text_value, amount_from, amount_to)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      condition.field === "amount"
        ? [id, index + 1, "amount", condition.operator, null, condition.amount, condition.amountTo]
        : [id, index + 1, condition.field, condition.operator, condition.text, null, null],
    );
  }
  for (const [index, line] of rule.lines.entries()) {
    await tx.query(
      `insert into bank_rule_lines (rule_id, position, account_id, tax_code_id, description, tracking, fixed_amount, percentage)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [id, index + 1, line.accountId, line.taxCodeId, line.description, JSON.stringify(line.tracking), line.fixedAmount, line.percentage],
    );
  }
}

function auditDetails(rule: ResolvedRule) {
  return {
    name: rule.name,
    isActive: rule.isActive,
    priority: rule.priority,
    accountId: rule.accountId,
    direction: rule.direction,
    matchMode: rule.matchMode,
    contactMode: rule.contactMode,
    contactId: rule.contactId,
    conditions: rule.conditions,
    lines: rule.lines.map(({ accountCode, taxCode, description, tracking, fixedAmount, percentage }) => ({
      accountCode,
      taxCode,
      description,
      tracking,
      fixedAmount,
      percentage,
    })),
  };
}

export async function createBankRule(tx: OrgTx, input: RuleInput): Promise<BankRule> {
  const rule = await resolveRule(tx, input);
  const inserted = await tx.query<{ id: string }>(
    `insert into bank_rules (name, is_active, priority, account_id, direction, match_mode, contact_mode, contact_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
    [rule.name, rule.isActive, rule.priority, rule.accountId, rule.direction, rule.matchMode, rule.contactMode, rule.contactId],
  );
  const id = inserted.rows[0].id;
  await writeParts(tx, id, rule);
  await writeAuditEvent(tx, { eventType: "bank_rule.created", entityType: "bank_rule", entityId: id, details: auditDetails(rule) });
  return getBankRule(tx, id);
}

export async function updateBankRule(tx: OrgTx, idInput: unknown, input: RuleInput): Promise<BankRule> {
  const id = requireId(idInput, "ruleId");
  await getBankRule(tx, id);
  const rule = await resolveRule(tx, input);
  // Old lines out, then the new direction, then the new lines, so the database
  // checks each new line's tax code against the new direction (TAO8).
  await clearParts(tx, id);
  await tx.query(
    `update bank_rules set name = $2, is_active = $3, priority = $4, account_id = $5, direction = $6, match_mode = $7,
            contact_mode = $8, contact_id = $9, updated_at = now()
      where id = $1`,
    [id, rule.name, rule.isActive, rule.priority, rule.accountId, rule.direction, rule.matchMode, rule.contactMode, rule.contactId],
  );
  await writeParts(tx, id, rule);
  await writeAuditEvent(tx, { eventType: "bank_rule.updated", entityType: "bank_rule", entityId: id, details: auditDetails(rule) });
  return getBankRule(tx, id);
}

export async function deleteBankRule(tx: OrgTx, idInput: unknown): Promise<void> {
  const id = requireId(idInput, "ruleId");
  const rule = await getBankRule(tx, id);
  await tx.query("delete from bank_rules where id = $1", [id]);
  await writeAuditEvent(tx, { eventType: "bank_rule.deleted", entityType: "bank_rule", entityId: id, details: { name: rule.name } });
}

type RuleLineInput = Pick<StatementLine, "accountId" | "amount" | "description" | "payee" | "particulars" | "code" | "reference">;

/** Case and runs of spaces don't matter, nor spaces at either end ("CALTEX " is "caltex"). */
export function normaliseRuleText(text: string | null | undefined): string {
  return (text ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

function conditionHolds(condition: RuleCondition, line: RuleLineInput): boolean {
  if (condition.field === "amount") {
    const amount = dec(line.amount.replace(/^-/, ""));
    const low = dec(condition.amount);
    switch (condition.operator) {
      case "equals":
        return cmp(amount, low) === 0;
      case "at_least":
        return cmp(amount, low) >= 0;
      case "at_most":
        return cmp(amount, low) <= 0;
      case "between":
        return cmp(amount, low) >= 0 && cmp(amount, dec(condition.amountTo!)) <= 0;
    }
  }
  const needle = normaliseRuleText(condition.text);
  const fields =
    condition.field === "any"
      ? [line.description, line.payee, line.particulars, line.code, line.reference]
      : [line[condition.field]];
  return fields.some((field) => {
    const value = normaliseRuleText(field);
    if (condition.operator === "equals") return value === needle;
    if (condition.operator === "starts_with") return value.startsWith(needle);
    return value.includes(needle);
  });
}

/** Whether a rule applies to a statement line: same account (if set), direction, and its conditions (all or any). */
export function ruleMatches(rule: BankRule, line: RuleLineInput): boolean {
  if (!rule.isActive) return false;
  if (rule.accountId && rule.accountId !== line.accountId) return false;
  const moneyIn = !line.amount.startsWith("-");
  if (rule.direction === "in" && !moneyIn) return false;
  if (rule.direction === "out" && moneyIn) return false;
  if (rule.conditions.length === 0) return false;
  return rule.matchMode === "any"
    ? rule.conditions.some((condition) => conditionHolds(condition, line))
    : rule.conditions.every((condition) => conditionHolds(condition, line));
}

export type SuggestedRuleLine = {
  description: string;
  accountCode: string;
  accountName: string;
  taxCode: string | null;
  tracking: TrackingTags;
  /** GST inclusive when the line has a GST code: it's a share of the statement line. */
  amount: string;
};

/**
 * The lines a rule gives for a statement line's amount (BR4-BR6): fixed
 * amounts first, then the rest split by percentages in cents the way payroll
 * allocations are (round down, leftover cents to the shares that lost most).
 * Null when the fixed amounts are more than the line: the rule doesn't fit.
 * A percentage line that comes to 0.00 is left out.
 */
export function ruleLinesFor(rule: BankRule, line: Pick<StatementLine, "amount" | "description">): SuggestedRuleLine[] | null {
  const whole = dec(line.amount.replace(/^-/, ""));
  const fixed = rule.lines.filter((entry) => entry.fixedAmount !== null);
  const shares = rule.lines.filter((entry) => entry.percentage !== null);
  const fixedTotal = fixed.reduce((sum, entry) => add(sum, dec(entry.fixedAmount!)), dec("0"));
  if (cmp(fixedTotal, whole) > 0 || shares.length === 0) return null;
  const rest = toFixedString(sub(whole, fixedTotal), 2);
  const split = splitOrZero(rest, shares.map((entry) => entry.percentage!));
  const amountFor = new Map<RuleLine, string>();
  fixed.forEach((entry) => amountFor.set(entry, toFixedString(dec(entry.fixedAmount!), 2)));
  shares.forEach((entry, index) => amountFor.set(entry, split[index]));
  return rule.lines
    .filter((entry) => !isZero(dec(amountFor.get(entry)!)))
    .map((entry) => ({
      description: entry.description ?? line.description,
      accountCode: entry.accountCode,
      accountName: entry.accountName,
      taxCode: entry.taxCode,
      tracking: entry.tracking,
      amount: amountFor.get(entry)!,
    }));
}

function splitOrZero(amount: string, percentages: string[]): string[] {
  return isZero(dec(amount)) ? percentages.map(() => "0.00") : splitByPercentages(amount, percentages);
}

/** The first active rule (lowest priority number, then oldest) that matches the line and fits its amount (BR4, BR6, BR7). */
export function firstFittingRule(rules: readonly BankRule[], line: RuleLineInput): { rule: BankRule; lines: SuggestedRuleLine[] } | null {
  for (const rule of rules) {
    if (!ruleMatches(rule, line)) continue;
    const lines = ruleLinesFor(rule, line);
    if (lines) return { rule, lines };
  }
  return null;
}

/**
 * The contact a rule gives for a line: its chosen contact, or the active
 * contact whose name is the line's payee (or, with no payee, its
 * description), as bulk coding finds one (BR2). Null when there's none.
 */
export async function ruleContact(
  tx: OrgTx,
  rule: BankRule,
  line: Pick<StatementLine, "payee" | "description">,
): Promise<{ id: string; name: string } | null> {
  if (rule.contactMode === "chosen") return rule.contactId ? { id: rule.contactId, name: rule.contactName ?? "" } : null;
  return contactNamedLike(tx, line.payee ?? line.description);
}

export async function contactNamedLike(tx: OrgTx, name: string): Promise<{ id: string; name: string } | null> {
  const found = await tx.query<{ id: string; name: string }>(
    `select id, name from contacts
      where not is_archived and lower(regexp_replace(btrim(name), '\\s+', ' ', 'g')) = lower(regexp_replace(btrim($1), '\\s+', ' ', 'g'))
      order by id limit 1`,
    [name],
  );
  return found.rows[0] ?? null;
}

/** The amounts mode a rule's suggestion uses: the line's amount includes GST, so any GST code means tax inclusive. */
export function ruleAmountsMode(lines: readonly SuggestedRuleLine[]): "inclusive" | "no_tax" {
  return lines.some((line) => line.taxCode !== null) ? "inclusive" : "no_tax";
}
