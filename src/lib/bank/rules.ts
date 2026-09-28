import { writeAuditEvent } from "@/lib/audit";
import type { StatementLine } from "@/lib/bank/accounts";
import type { OrgTx } from "@/lib/db/org-transaction";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { AMOUNTS_MODES, type AmountsMode } from "@/lib/invoices/amounts";
import { optionalBoolean, optionalId, optionalString, requireId, requireOneOf, requireString } from "@/lib/validation";

/**
 * Bank rules (example BK10): when a statement line's text contains some words,
 * suggest a bank transaction (contact, account, tax code). A suggestion posts
 * nothing until it's confirmed on the reconcile screen. Rules are settings,
 * so they can be edited and deleted; changes are audited.
 */
export const RULE_DIRECTIONS = ["any", "in", "out"] as const;
export const RULE_FIELDS = ["any", "description", "payee", "particulars", "code", "reference"] as const;

export type BankRule = {
  id: string;
  name: string;
  isActive: boolean;
  priority: number;
  accountId: string | null;
  accountCode: string | null;
  direction: (typeof RULE_DIRECTIONS)[number];
  matchField: (typeof RULE_FIELDS)[number];
  matchText: string;
  contactId: string;
  contactName: string;
  targetAccountCode: string;
  targetAccountName: string;
  taxCode: string | null;
  amountsMode: AmountsMode;
  lineDescription: string | null;
};

type RuleRow = {
  id: string;
  name: string;
  is_active: boolean;
  priority: number;
  account_id: string | null;
  account_code: string | null;
  direction: BankRule["direction"];
  match_field: BankRule["matchField"];
  match_text: string;
  contact_id: string;
  contact_name: string;
  target_account_code: string;
  target_account_name: string;
  tax_code: string | null;
  amounts_mode: AmountsMode;
  line_description: string | null;
};

const SELECT = `
  select r.id, r.name, r.is_active, r.priority, r.account_id, a.code as account_code, r.direction, r.match_field,
         r.match_text, r.contact_id, c.name as contact_name, t.code as target_account_code, t.name as target_account_name,
         tc.code as tax_code, r.amounts_mode, r.line_description
    from bank_rules r
    left join accounts a on a.id = r.account_id
    join contacts c on c.id = r.contact_id
    join accounts t on t.id = r.target_account_id
    left join tax_codes tc on tc.id = r.tax_code_id`;

function toRule(row: RuleRow): BankRule {
  return {
    id: row.id,
    name: row.name,
    isActive: row.is_active,
    priority: row.priority,
    accountId: row.account_id,
    accountCode: row.account_code,
    direction: row.direction,
    matchField: row.match_field,
    matchText: row.match_text,
    contactId: row.contact_id,
    contactName: row.contact_name,
    targetAccountCode: row.target_account_code,
    targetAccountName: row.target_account_name,
    taxCode: row.tax_code,
    amountsMode: row.amounts_mode,
    lineDescription: row.line_description,
  };
}

export async function listBankRules(tx: OrgTx, options: { activeOnly?: boolean } = {}): Promise<BankRule[]> {
  const result = await tx.query<RuleRow>(
    `${SELECT} where ($1::boolean is not true or r.is_active) order by r.priority, r.id`,
    [options.activeOnly ?? false],
  );
  return result.rows.map(toRule);
}

async function getRule(tx: OrgTx, id: string): Promise<BankRule> {
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
  matchField?: unknown;
  matchText?: unknown;
  contactId?: unknown;
  targetAccountCode?: unknown;
  taxCode?: unknown;
  amountsMode?: unknown;
  lineDescription?: unknown;
};

async function resolveRule(tx: OrgTx, input: RuleInput) {
  const name = requireString(input.name, "name", { maxLength: 100 });
  const matchText = requireString(input.matchText, "matchText", { maxLength: 200 });
  const priorityRaw = input.priority == null || input.priority === "" ? 100 : Number(input.priority);
  if (!Number.isInteger(priorityRaw) || priorityRaw < 0 || priorityRaw > 10_000) {
    throw new ValidationError("priority must be a whole number from 0 to 10000 (lower runs first).");
  }
  const accountId = optionalId(input.accountId, "accountId");
  if (accountId) {
    const account = await tx.query("select 1 from accounts where id = $1 and account_type in ('bank', 'credit_card')", [accountId]);
    if (account.rowCount === 0) throw new ValidationError("The rule's account must be a bank or credit card account.");
  }
  const contactId = requireId(input.contactId, "contactId");
  const contact = await tx.query("select 1 from contacts where id = $1", [contactId]);
  if (contact.rowCount === 0) throw new ValidationError(`There's no contact #${contactId}.`);
  const targetCode = requireString(input.targetAccountCode, "targetAccountCode", { maxLength: 20 });
  const target = await tx.query<{ id: string }>("select id from accounts where lower(code) = lower($1)", [targetCode]);
  if (!target.rows[0]) throw new ValidationError(`There's no account with the code ${targetCode}.`);
  const taxCodeText = optionalString(input.taxCode, "taxCode", { maxLength: 20 });
  let taxCodeId: string | null = null;
  if (taxCodeText) {
    const taxCode = await tx.query<{ id: string }>("select id from tax_codes where code = $1", [taxCodeText]);
    if (!taxCode.rows[0]) throw new ValidationError(`There's no tax code ${taxCodeText}.`);
    taxCodeId = taxCode.rows[0].id;
  }
  return {
    name,
    isActive: optionalBoolean(input.isActive, "isActive") ?? true,
    priority: priorityRaw,
    accountId,
    direction: input.direction == null ? "any" : requireOneOf(input.direction, "direction", RULE_DIRECTIONS),
    matchField: input.matchField == null ? "any" : requireOneOf(input.matchField, "matchField", RULE_FIELDS),
    matchText,
    contactId,
    targetAccountId: target.rows[0].id,
    taxCodeId,
    amountsMode: input.amountsMode == null ? "inclusive" : requireOneOf(input.amountsMode, "amountsMode", AMOUNTS_MODES),
    lineDescription: optionalString(input.lineDescription, "lineDescription", { maxLength: 500 }),
  };
}

export async function createBankRule(tx: OrgTx, input: RuleInput): Promise<BankRule> {
  const rule = await resolveRule(tx, input);
  const inserted = await tx.query<{ id: string }>(
    `insert into bank_rules (name, is_active, priority, account_id, direction, match_field, match_text, contact_id,
                             target_account_id, tax_code_id, amounts_mode, line_description)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) returning id`,
    [
      rule.name, rule.isActive, rule.priority, rule.accountId, rule.direction, rule.matchField, rule.matchText,
      rule.contactId, rule.targetAccountId, rule.taxCodeId, rule.amountsMode, rule.lineDescription,
    ],
  );
  const id = inserted.rows[0].id;
  await writeAuditEvent(tx, { eventType: "bank_rule.created", entityType: "bank_rule", entityId: id, details: { ...rule } });
  return getRule(tx, id);
}

export async function updateBankRule(tx: OrgTx, idInput: unknown, input: RuleInput): Promise<BankRule> {
  const id = requireId(idInput, "ruleId");
  await getRule(tx, id);
  const rule = await resolveRule(tx, input);
  await tx.query(
    `update bank_rules set name = $2, is_active = $3, priority = $4, account_id = $5, direction = $6, match_field = $7,
            match_text = $8, contact_id = $9, target_account_id = $10, tax_code_id = $11, amounts_mode = $12,
            line_description = $13, updated_at = now()
      where id = $1`,
    [
      id, rule.name, rule.isActive, rule.priority, rule.accountId, rule.direction, rule.matchField, rule.matchText,
      rule.contactId, rule.targetAccountId, rule.taxCodeId, rule.amountsMode, rule.lineDescription,
    ],
  );
  await writeAuditEvent(tx, { eventType: "bank_rule.updated", entityType: "bank_rule", entityId: id, details: { ...rule } });
  return getRule(tx, id);
}

export async function deleteBankRule(tx: OrgTx, idInput: unknown): Promise<void> {
  const id = requireId(idInput, "ruleId");
  const rule = await getRule(tx, id);
  await tx.query("delete from bank_rules where id = $1", [id]);
  await writeAuditEvent(tx, { eventType: "bank_rule.deleted", entityType: "bank_rule", entityId: id, details: { name: rule.name } });
}

/** Whether a rule applies to a statement line: same account (if set), direction and text (ignoring case). */
export function ruleMatches(rule: BankRule, line: Pick<StatementLine, "accountId" | "amount" | "description" | "payee" | "particulars" | "code" | "reference">): boolean {
  if (!rule.isActive) return false;
  if (rule.accountId && rule.accountId !== line.accountId) return false;
  const moneyIn = !line.amount.startsWith("-");
  if (rule.direction === "in" && !moneyIn) return false;
  if (rule.direction === "out" && moneyIn) return false;
  const needle = rule.matchText.toLowerCase();
  const fields =
    rule.matchField === "any"
      ? [line.description, line.payee, line.particulars, line.code, line.reference]
      : [line[rule.matchField]];
  return fields.some((field) => (field ?? "").toLowerCase().includes(needle));
}
