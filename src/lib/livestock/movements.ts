import { writeAuditEvent } from "@/lib/audit";
import { parseIsoDate, todayIsoDate } from "@/lib/dates";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { addDays, financialYearEnd, financialYearStart } from "@/lib/financial-year";
import { assertSameRequest, requestHash } from "@/lib/idempotency";
import { parseJournalBody, postJournalBody } from "@/lib/ledger/journals";
import { assertPostingDateAllowed } from "@/lib/ledger/period-controls";
import { dec, isZero, parseDecimalInput } from "@/lib/money/decimal";
import { getGstRegistration, type GstRegistration, isRegisteredOn } from "@/lib/tax/registration";
import { createAccount } from "@/lib/accounts/service";
import { getOrganisationSettings } from "@/lib/organisations/settings";
import { asRecord, optionalId, optionalSource, optionalString, requireArray, requireId, requireIdempotencyKey, requireOneOf, requireString } from "@/lib/validation";
import { classKey, className, findClass, KIND_NAMES, LIVESTOCK_CLASSES, LIVESTOCK_KINDS, type LivestockKind } from "./classes";
import { type AgeingStep, ageingSteps, type HerdMovement, lastDate, walkHerd } from "./herd";
import { assessRationsGst, currentPostingJournal, insertAssessment, parseAssessment, type RationsGst, rationsJournalLines, registeredOn, reverseRationsJournal } from "./rations-gst";
import { type RationsGstOutcome, rationsPosting } from "./rations-gst-rules";

/*
 * Livestock movements and head counts (#221 stage 2; examples LV1-LV3,
 * decision 503). Births, deaths and ageing change head counts only (LV8),
 * and the year-end valuation (stage 3) turns them into values. The one
 * posting here is the owner's rations (RAT1): income at market value,
 * Dr drawings, Cr rations income.
 */

export const MOVEMENT_TYPES = ["birth", "purchase", "sale", "death", "missing", "found", "reclass", "transfer", "arrival", "departure", "rations"] as const;
export type MovementType = (typeof MOVEMENT_TYPES)[number];

export const MOVEMENT_LABELS: Readonly<Record<MovementType, string>> = {
  birth: "Born",
  purchase: "Bought",
  sale: "Sold",
  death: "Died",
  missing: "Missing",
  found: "Found",
  reclass: "Class change",
  transfer: "Moved",
  arrival: "Arrived (held for others)",
  departure: "Left (held for others)",
  rations: "Killed for rations",
};

/** Whose rations (RAT1, RAT2): the owner's are income at market value; staff rations post nothing. */
export const RATIONS_FOR = ["owner", "staff"] as const;
export type RationsFor = (typeof RATIONS_FOR)[number];

export type LivestockAccount = { code: string; name: string } | null;

export const REPORTING_BASES = ["special_purpose", "general_purpose"] as const;
export type ReportingBasis = (typeof REPORTING_BASES)[number];

export type LivestockSettings = {
  enabled: boolean;
  firstYearStart: string | null;
  financialYearEndMonth: number;
  /** Where the herd scheme revaluation goes (LV12, decision 503): profit and loss, or an equity reserve (special purpose only, LV28). */
  revaluationTarget: "profit_and_loss" | "reserve";
  /**
   * The financial statements' basis (LV28, decision 567): special purpose (tax basis, the
   * farm's own stated policy) or general purpose (NZ IFRS or PBE Standards: changes in
   * value through profit or loss only).
   */
  reportingBasis: ReportingBasis;
  /** Classes held for sale in the normal operating cycle: current assets (LV27, decision 566), as "kind.class". */
  currentClasses: string[];
  accounts: {
    asset: LivestockAccount;
    /** Livestock on hand for the classes that are current (LV27). */
    currentAsset: LivestockAccount;
    valueChange: LivestockAccount;
    revaluation: LivestockAccount;
    reserve: LivestockAccount;
    /** The owner's rations (RAT1): Cr this income account, Dr the drawings account. */
    rationsIncome: LivestockAccount;
    drawings: LivestockAccount;
  };
};

/** The accounts LV4 and LV12 post to, made when livestock is first turned on unless the code is already used. */
const DEFAULT_ACCOUNTS = {
  asset: { column: "asset_account_id", code: "1500", name: "Livestock on hand", type: "non_current_asset", accountClass: "asset" },
  currentAsset: { column: "current_asset_account_id", code: "1490", name: "Livestock on hand (current)", type: "current_asset", accountClass: "asset" },
  valueChange: { column: "value_change_account_id", code: "5210", name: "Livestock: change in value", type: "direct_costs", accountClass: "expense" },
  revaluation: { column: "revaluation_account_id", code: "7060", name: "Herd scheme revaluation (non-taxable)", type: "other_income", accountClass: "revenue" },
  reserve: { column: "reserve_account_id", code: "3300", name: "Herd scheme revaluation reserve", type: "equity", accountClass: "equity" },
  rationsIncome: { column: "rations_income_account_id", code: "7070", name: "Livestock rations (private use)", type: "other_income", accountClass: "revenue" },
  drawings: { column: "drawings_account_id", code: "3100", name: "Owner drawings", type: "equity", accountClass: "equity" },
} as const;
type AccountRole = keyof typeof DEFAULT_ACCOUNTS;
const ROLE_NAMES: Record<AccountRole, string> = {
  asset: "livestock on hand",
  currentAsset: "livestock on hand (current)",
  valueChange: "change in value",
  revaluation: "herd scheme revaluation",
  reserve: "revaluation reserve",
  rationsIncome: "rations income",
  drawings: "drawings",
};

export type LivestockOpening = { kind: LivestockKind; classCode: string; className: string; head: number; value: string };

export type LivestockLocation = { id: string; name: string; archived: boolean };

export type Movement = {
  id: string;
  movementDate: string;
  movementType: MovementType;
  ownership: "owned" | "held_for_others";
  heldFor: string | null;
  kind: LivestockKind;
  classCode: string;
  className: string;
  toClassCode: string | null;
  head: number;
  amount: string | null;
  locationId: string | null;
  locationName: string | null;
  toLocationId: string | null;
  toLocationName: string | null;
  salesInvoiceLineId: string | null;
  invoiceNumber: string | null;
  billLineId: string | null;
  billReference: string | null;
  /** Rations only: whose. */
  rationsFor: RationsFor | null;
  /** The owner's rations journal as first posted (RAT1). */
  journalId: string | null;
  /** The owner's rations: who they went to, the legal entity they came from, and whether the value includes GST (RAT1). */
  rationsRecipient: string | null;
  rationsEntity: string | null;
  amountIncludesGst: boolean | null;
  /** The owner's rations: where the GST stands (RAT5-RAT10). Null for anything else. */
  gst: RationsGst | null;
  note: string | null;
  createdByEmail: string;
  createdAt: string;
  voided: boolean;
  voidReason: string | null;
};

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "23505";
}

// Settings ------------------------------------------------------------------

export async function getLivestockSettings(tx: OrgTx): Promise<LivestockSettings> {
  const row = (
    await tx.query<{
      enabled: boolean;
      first_year_start: string | null;
      revaluation_target: "profit_and_loss" | "reserve";
      reporting_basis: ReportingBasis;
      asset_code: string | null;
      current_code: string | null;
      current_name: string | null;
      asset_name: string | null;
      value_change_code: string | null;
      value_change_name: string | null;
      revaluation_code: string | null;
      revaluation_name: string | null;
      reserve_code: string | null;
      reserve_name: string | null;
      rations_code: string | null;
      rations_name: string | null;
      drawings_code: string | null;
      drawings_name: string | null;
    }>(
      `select s.enabled, s.first_year_start::text, s.revaluation_target, s.reporting_basis,
              a.code as asset_code, a.name as asset_name, c.code as current_code, c.name as current_name, v.code as value_change_code, v.name as value_change_name,
              r.code as revaluation_code, r.name as revaluation_name, e.code as reserve_code, e.name as reserve_name,
              ra.code as rations_code, ra.name as rations_name, d.code as drawings_code, d.name as drawings_name
         from livestock_settings s
         left join accounts a on a.id = s.asset_account_id
         left join accounts c on c.id = s.current_asset_account_id
         left join accounts v on v.id = s.value_change_account_id
         left join accounts r on r.id = s.revaluation_account_id
         left join accounts e on e.id = s.reserve_account_id
         left join accounts ra on ra.id = s.rations_income_account_id
         left join accounts d on d.id = s.drawings_account_id
        where s.id = true`,
    )
  ).rows[0];
  const organisation = await getOrganisationSettings(tx);
  const account = (code: string | null | undefined, name: string | null | undefined) => (code && name ? { code, name } : null);
  const current = await tx.query<{ kind: string; class_code: string }>("select kind, class_code from livestock_class_reporting where is_current order by kind, class_code");
  return {
    enabled: row?.enabled ?? false,
    firstYearStart: row?.first_year_start ?? null,
    financialYearEndMonth: organisation.financialYearEndMonth,
    revaluationTarget: row?.revaluation_target ?? "profit_and_loss",
    reportingBasis: row?.reporting_basis ?? "special_purpose",
    currentClasses: current.rows.map((entry) => classKey(entry.kind, entry.class_code)),
    accounts: {
      asset: account(row?.asset_code, row?.asset_name),
      currentAsset: account(row?.current_code, row?.current_name),
      valueChange: account(row?.value_change_code, row?.value_change_name),
      revaluation: account(row?.revaluation_code, row?.revaluation_name),
      reserve: account(row?.reserve_code, row?.reserve_name),
      rationsIncome: account(row?.rations_code, row?.rations_name),
      drawings: account(row?.drawings_code, row?.drawings_name),
    },
  };
}

/**
 * Makes the default livestock accounts that aren't set yet. A code that's
 * already used for a different kind of account is left for an admin to
 * choose instead.
 */
async function ensureAccounts(tx: OrgTx, roles: readonly AccountRole[] = ["asset", "valueChange", "revaluation", "reserve", "rationsIncome", "drawings"]): Promise<void> {
  for (const spec of roles.map((role) => DEFAULT_ACCOUNTS[role])) {
    const set = await tx.query<{ id: string | null }>(`select ${spec.column}::text as id from livestock_settings where id = true`);
    if (set.rows[0]?.id) continue;
    const existing = await tx.query<{ id: string; account_type: string }>("select id::text, account_type from accounts where lower(code) = lower($1)", [spec.code]);
    let id: string | null = null;
    if (existing.rows[0]) {
      if (existing.rows[0].account_type === spec.type) id = existing.rows[0].id;
    } else {
      id = (await createAccount(tx, { code: spec.code, name: spec.name, accountType: spec.type })).id;
    }
    if (id) await tx.query(`update livestock_settings set ${spec.column} = $1 where id = true`, [id]);
  }
}

async function chooseAccount(tx: OrgTx, role: AccountRole, input: unknown): Promise<void> {
  const spec = DEFAULT_ACCOUNTS[role];
  const code = requireString(input, `The ${ROLE_NAMES[role]} account`, { maxLength: 20 });
  const row = await tx.query<{ id: string; account_class: string; account_type: string; is_active: boolean; currency_code: string | null; system_key: string | null }>(
    "select id::text, account_class, account_type, is_active, currency_code, system_key from accounts where lower(code) = lower($1)",
    [code],
  );
  const account = row.rows[0];
  if (!account) throw new ValidationError(`There's no account ${code}.`);
  if (!account.is_active) throw new ValidationError(`Account ${code} is archived.`);
  if (account.currency_code) throw new ValidationError(`Account ${code} holds a foreign currency.`);
  if (account.system_key) throw new ValidationError(`Account ${code} is used by Tohyee for something else.`);
  if (account.account_class !== spec.accountClass) {
    throw new ValidationError(`Account ${code} has to be ${spec.accountClass === "expense" ? "an expense" : spec.accountClass === "asset" ? "an asset" : spec.accountClass === "revenue" ? "an income" : "an equity"} account.`);
  }
  if (role === "currentAsset" && account.account_type !== "current_asset") throw new ValidationError(`Account ${code} has to be a current asset account.`);
  if (role === "asset" && account.account_type === "current_asset") throw new ValidationError(`Account ${code} is a current asset account; livestock kept is non-current (LV27).`);
  await tx.query(`update livestock_settings set ${spec.column} = $1 where id = true`, [account.id]);
}

/** Livestock is part of Accounting (#221): it needs Accounting on and Livestock turned on. */
export async function requireLivestock(tx: OrgTx): Promise<LivestockSettings & { firstYearStart: string }> {
  const organisation = await getOrganisationSettings(tx);
  if (!organisation.accountingEnabled) throw new ValidationError("Livestock is part of Accounting. Turn Accounting on first.");
  const settings = await getLivestockSettings(tx);
  if (!settings.enabled || !settings.firstYearStart) {
    throw new ValidationError("Livestock isn't turned on for this organisation. An admin can turn it on in Livestock › Settings.");
  }
  return { ...settings, firstYearStart: settings.firstYearStart };
}

async function hasMovements(tx: OrgTx): Promise<boolean> {
  return (await tx.query("select 1 from livestock_movements limit 1")).rowCount !== 0;
}

/**
 * Turns livestock on or off and sets the first income year. The first year
 * can't change once movements are recorded (its opening is where every head
 * count starts).
 */
export async function updateLivestockSettings(
  tx: OrgTx,
  input: {
    enabled?: unknown;
    firstYearStart?: unknown;
    revaluationTarget?: unknown;
    reportingBasis?: unknown;
    assetAccount?: unknown;
    currentAssetAccount?: unknown;
    valueChangeAccount?: unknown;
    revaluationAccount?: unknown;
    reserveAccount?: unknown;
    rationsIncomeAccount?: unknown;
    drawingsAccount?: unknown;
  },
): Promise<LivestockSettings> {
  const current = await getLivestockSettings(tx);
  const organisation = await getOrganisationSettings(tx);
  if (input.enabled !== undefined && typeof input.enabled !== "boolean") throw new ValidationError("enabled must be true or false.");
  const enabled = input.enabled === undefined ? current.enabled : input.enabled;
  if (enabled && !organisation.accountingEnabled) throw new ValidationError("Livestock is part of Accounting. Turn Accounting on first.");
  let firstYearStart = current.firstYearStart;
  if (input.firstYearStart !== undefined) {
    const date = parseIsoDate(input.firstYearStart, "The first year's start");
    if (financialYearStart(date, organisation.financialYearEndMonth) !== date) {
      throw new ValidationError(`The first year has to start on the first day of a financial year (the year ends in month ${organisation.financialYearEndMonth}).`);
    }
    if (date !== current.firstYearStart && (await hasMovements(tx))) {
      throw new ConflictError("The first year can't change once movements are recorded.");
    }
    firstYearStart = date;
  }
  // Turned on from Modules without a first year: the current financial year, changeable in Livestock settings until movements are recorded.
  if (enabled && !firstYearStart) firstYearStart = financialYearStart(todayIsoDate(), organisation.financialYearEndMonth);
  const revaluationTarget =
    input.revaluationTarget === undefined ? current.revaluationTarget : requireOneOf(input.revaluationTarget, "revaluationTarget", ["profit_and_loss", "reserve"] as const);
  const reportingBasis = input.reportingBasis === undefined ? current.reportingBasis : requireOneOf(input.reportingBasis, "reportingBasis", REPORTING_BASES);
  // LV28: under general purpose reporting changes in value go through profit or loss (NZ IAS 41 para 26).
  if (reportingBasis === "general_purpose" && revaluationTarget === "reserve") {
    throw new ValidationError(
      "Under general purpose reporting (NZ IFRS or PBE Standards) changes in livestock values go through profit or loss (NZ IAS 41 para 26), so the herd scheme revaluation can't go to a reserve. Choose profit and loss.",
    );
  }
  // A new revaluation target or basis applies from the next valuation approved (LV12); approved years are never re-posted.
  await tx.query(
    "update livestock_settings set enabled = $1, first_year_start = $2, revaluation_target = $3, reporting_basis = $4, updated_by_email = $5, updated_at = now() where id = true",
    [enabled, firstYearStart, revaluationTarget, reportingBasis, tx.actor.email],
  );
  if (enabled) await ensureAccounts(tx);
  const choices: Array<[AccountRole, unknown]> = [
    ["asset", input.assetAccount],
    ["currentAsset", input.currentAssetAccount],
    ["valueChange", input.valueChangeAccount],
    ["revaluation", input.revaluationAccount],
    ["reserve", input.reserveAccount],
    ["rationsIncome", input.rationsIncomeAccount],
    ["drawings", input.drawingsAccount],
  ];
  for (const [role, value] of choices) if (value !== undefined) await chooseAccount(tx, role, value);
  const updated = await getLivestockSettings(tx);
  await writeAuditEvent(tx, {
    eventType: "livestock.settings_updated",
    entityType: "livestock_settings",
    entityId: "1",
    details: { enabled, firstYearStart, revaluationTarget, reportingBasis, accounts: updated.accounts },
  });
  return updated;
}

/**
 * Which classes are current assets (LV27, decision 566): held for sale in
 * the normal operating cycle (NZ IAS 1 para 66); the rest, such as a
 * breeding or milking herd kept, are non-current. Applies from the next
 * valuation approved, which moves the current classes' closing value to
 * the current account; approved years aren't re-posted. The current
 * account (1490) is made when a class is first made current. Admins.
 */
export async function setClassReporting(tx: OrgTx, input: { lines: unknown }): Promise<LivestockSettings> {
  await requireLivestock(tx);
  const lines = requireArray(input.lines, "lines", 200).map((raw) => {
    const line = asRecord(raw, "A class");
    const kind = requireString(line.kind, "kind", { maxLength: 40 });
    const classCode = requireString(line.classCode, "classCode", { maxLength: 60 });
    if (!findClass(kind, classCode)) throw new ValidationError(`There's no livestock class ${kind} ${classCode}.`);
    if (typeof line.current !== "boolean") throw new ValidationError("current must be true or false.");
    return { kind, classCode, current: line.current };
  });
  for (const line of lines) {
    await tx.query(
      `insert into livestock_class_reporting (kind, class_code, is_current, updated_by_email) values ($1, $2, $3, $4)
       on conflict (kind, class_code) do update set is_current = excluded.is_current, updated_by_email = excluded.updated_by_email, updated_at = now()`,
      [line.kind, line.classCode, line.current, tx.actor.email],
    );
  }
  if (lines.some((line) => line.current)) await ensureAccounts(tx, ["currentAsset"]);
  const updated = await getLivestockSettings(tx);
  await writeAuditEvent(tx, { eventType: "livestock.class_reporting_updated", entityType: "livestock_settings", entityId: "1", details: { currentClasses: updated.currentClasses } });
  return updated;
}

// Opening position ----------------------------------------------------------

export async function listOpenings(tx: OrgTx): Promise<LivestockOpening[]> {
  const rows = await tx.query<{ kind: LivestockKind; class_code: string; head: number; value: string }>(
    "select kind, class_code, head, value::text from livestock_openings",
  );
  const order = (kind: string, code: string) => LIVESTOCK_CLASSES.findIndex((entry) => entry.kind === kind && entry.code === code);
  return rows.rows
    .map((row) => ({ kind: row.kind, classCode: row.class_code, className: className(row.kind, row.class_code), head: row.head, value: row.value }))
    .sort((a, b) => order(a.kind, a.classCode) - order(b.kind, b.classCode));
}

/**
 * Sets the first year's opening by class: head and value from last year's
 * workpaper (decision 503), as at the end of the year before (so before
 * ageing). Replaces the whole opening; refused once a valuation is approved.
 */
export async function setOpenings(tx: OrgTx, input: { lines: unknown }): Promise<LivestockOpening[]> {
  const settings = await requireLivestock(tx);
  await assertYearOpen(tx, settings, settings.firstYearStart);
  const lines = requireArray(input.lines, "lines", 100);
  const seen = new Set<string>();
  const parsed = lines.map((raw, index) => {
    const line = (raw ?? {}) as Record<string, unknown>;
    const label = `Line ${index + 1}`;
    const kind = requireOneOf(line.kind, `${label} kind`, LIVESTOCK_KINDS);
    const classCode = requireString(line.classCode, `${label} class`, { maxLength: 50 });
    if (!findClass(kind, classCode)) throw new ValidationError(`${label}: ${KIND_NAMES[kind]} has no class "${classCode}".`);
    const key = classKey(kind, classCode);
    if (seen.has(key)) throw new ValidationError(`${label} repeats ${className(kind, classCode)}.`);
    seen.add(key);
    const head = parseHead(line.head, `${label} head`, true);
    const value = parseDecimalInput(line.value, `${label} value`, { maxScale: 2, allowZero: true });
    if (head === 0 && !isZero(dec(value))) throw new ValidationError(`${label}: no head, so the value must be 0.00.`);
    return { kind, classCode, head, value };
  });
  await tx.query("delete from livestock_openings");
  for (const line of parsed.filter((entry) => entry.head > 0)) {
    await tx.query("insert into livestock_openings (kind, class_code, head, value) values ($1, $2, $3, $4::numeric)", [
      line.kind,
      line.classCode,
      line.head,
      line.value,
    ]);
  }
  await writeAuditEvent(tx, {
    eventType: "livestock.opening_set",
    entityType: "livestock_settings",
    entityId: "1",
    details: { firstYearStart: settings.firstYearStart, lines: parsed.filter((entry) => entry.head > 0) },
  });
  await assertNoNegative(tx);
  return listOpenings(tx);
}

function parseHead(input: unknown, fieldName: string, allowZero = false): number {
  const text = parseDecimalInput(input, fieldName, { maxScale: 0, allowZero });
  const head = Number(text);
  if (!Number.isSafeInteger(head) || head > 10_000_000) throw new ValidationError(`${fieldName} is too large.`);
  return head;
}

// Locations -----------------------------------------------------------------

export async function listLocations(tx: OrgTx): Promise<LivestockLocation[]> {
  const rows = await tx.query<{ id: string; name: string; archived: boolean }>(
    "select id::text, name, archived_at is not null as archived from livestock_locations order by archived_at is not null, lower(name)",
  );
  return rows.rows;
}

export async function createLocation(tx: OrgTx, input: { name: unknown }): Promise<LivestockLocation> {
  await requireLivestock(tx);
  const name = requireString(input.name, "name", { maxLength: 100 });
  try {
    const row = await tx.query<{ id: string }>("insert into livestock_locations (name) values ($1) returning id::text", [name]);
    await writeAuditEvent(tx, { eventType: "livestock.location_created", entityType: "livestock_location", entityId: row.rows[0].id, details: { name } });
    return { id: row.rows[0].id, name, archived: false };
  } catch (error) {
    if (isUniqueViolation(error)) throw new ConflictError(`There's already a location called ${name}.`);
    throw error;
  }
}

export async function archiveLocation(tx: OrgTx, idInput: unknown, archived = true): Promise<LivestockLocation> {
  const id = requireId(idInput, "locationId");
  const row = await tx.query<{ id: string; name: string }>(
    `update livestock_locations set archived_at = case when $2 then coalesce(archived_at, now()) else null end where id = $1 returning id::text, name`,
    [id, archived],
  );
  if (!row.rows[0]) throw new NotFoundError("Location not found.");
  return { ...row.rows[0], archived };
}

// Movements -----------------------------------------------------------------

const MOVEMENT_COLUMNS = `m.id::text, m.movement_date::text, m.movement_type, m.ownership, m.held_for, m.kind, m.class_code, m.to_class_code, m.head,
  m.amount::text, m.location_id::text, l.name as location_name, m.to_location_id::text, tl.name as to_location_name,
  m.sales_invoice_line_id::text, i.invoice_number, m.bill_line_id::text, b.supplier_invoice_number as bill_reference, m.rations_for, m.journal_id::text, m.note,
  m.created_by_email, m.created_at::text, m.voided_at is not null as voided, m.void_reason,
  m.rations_recipient, m.rations_entity, m.amount_includes_gst, g.id::text as gst_id, g.outcome as gst_outcome, g.gst_amount::text as gst_amount,
  g.basis as gst_basis, g.assessed_by_email as gst_assessed_by_email, g.assessed_at::text as gst_assessed_at`;
const MOVEMENT_JOINS = `from livestock_movements m
  left join livestock_locations l on l.id = m.location_id
  left join livestock_locations tl on tl.id = m.to_location_id
  left join sales_invoice_lines il on il.id = m.sales_invoice_line_id
  left join sales_invoices i on i.id = il.invoice_id
  left join bill_lines bl on bl.id = m.bill_line_id
  left join bills b on b.id = bl.bill_id
  left join livestock_rations_gst g on g.movement_id = m.id and g.replaced_at is null`;

type MovementRow = {
  id: string;
  movement_date: string;
  movement_type: MovementType;
  ownership: "owned" | "held_for_others";
  held_for: string | null;
  kind: LivestockKind;
  class_code: string;
  to_class_code: string | null;
  head: number;
  amount: string | null;
  location_id: string | null;
  location_name: string | null;
  to_location_id: string | null;
  to_location_name: string | null;
  sales_invoice_line_id: string | null;
  invoice_number: string | null;
  bill_line_id: string | null;
  bill_reference: string | null;
  rations_for: RationsFor | null;
  journal_id: string | null;
  note: string | null;
  created_by_email: string;
  created_at: string;
  voided: boolean;
  void_reason: string | null;
  rations_recipient: string | null;
  rations_entity: string | null;
  amount_includes_gst: boolean | null;
  gst_id: string | null;
  gst_outcome: RationsGstOutcome | null;
  gst_amount: string | null;
  gst_basis: string | null;
  gst_assessed_by_email: string | null;
  gst_assessed_at: string | null;
};

function toMovement(row: MovementRow, registration: GstRegistration): Movement {
  const ownersRations = row.movement_type === "rations" && row.rations_for === "owner";
  return {
    id: row.id,
    movementDate: row.movement_date,
    movementType: row.movement_type,
    ownership: row.ownership,
    heldFor: row.held_for,
    kind: row.kind,
    classCode: row.class_code,
    className: className(row.kind, row.class_code),
    toClassCode: row.to_class_code,
    head: row.head,
    amount: row.amount,
    locationId: row.location_id,
    locationName: row.location_name,
    toLocationId: row.to_location_id,
    toLocationName: row.to_location_name,
    salesInvoiceLineId: row.sales_invoice_line_id,
    invoiceNumber: row.invoice_number,
    billLineId: row.bill_line_id,
    billReference: row.bill_reference,
    rationsFor: row.rations_for,
    journalId: row.journal_id,
    note: row.note,
    createdByEmail: row.created_by_email,
    createdAt: row.created_at,
    voided: row.voided,
    voidReason: row.void_reason,
    rationsRecipient: row.rations_recipient,
    rationsEntity: row.rations_entity,
    amountIncludesGst: row.amount_includes_gst,
    gst: ownersRations
      ? {
          status: row.gst_outcome ?? (isRegisteredOn(registration, row.movement_date) ? "unresolved" : "not_registered"),
          assessmentId: row.gst_id,
          gstAmount: row.gst_amount,
          basis: row.gst_basis,
          assessedByEmail: row.gst_assessed_by_email,
          assessedAt: row.gst_assessed_at,
        }
      : null,
  };
}

export async function getMovement(tx: OrgTx, idInput: unknown): Promise<Movement> {
  const id = requireId(idInput, "movementId");
  const row = await tx.query<MovementRow>(`select ${MOVEMENT_COLUMNS} ${MOVEMENT_JOINS} where m.id = $1`, [id]);
  if (!row.rows[0]) throw new NotFoundError("Livestock movement not found.");
  return toMovement(row.rows[0], await getGstRegistration(tx));
}

export async function listMovements(tx: OrgTx, input: { from?: unknown; to?: unknown; includeVoided?: unknown } = {}): Promise<Movement[]> {
  const from = input.from ? parseIsoDate(input.from, "from") : null;
  const to = input.to ? parseIsoDate(input.to, "to") : null;
  const rows = await tx.query<MovementRow>(
    `select ${MOVEMENT_COLUMNS} ${MOVEMENT_JOINS}
      where ($1::date is null or m.movement_date >= $1) and ($2::date is null or m.movement_date <= $2) and ($3 or m.voided_at is null)
      order by m.movement_date desc, m.id desc limit 5000`,
    [from, to, input.includeVoided === true || input.includeVoided === "true"],
  );
  const registration = await getGstRegistration(tx);
  return rows.rows.map((row) => toMovement(row, registration));
}

async function requireLocation(tx: OrgTx, input: unknown, fieldName: string): Promise<string | null> {
  const id = optionalId(input, fieldName);
  if (!id) return null;
  const row = await tx.query<{ archived: boolean }>("select archived_at is not null as archived from livestock_locations where id = $1", [id]);
  if (!row.rows[0]) throw new ValidationError("That location wasn't found.");
  if (row.rows[0].archived) throw new ValidationError("That location is archived.");
  return id;
}

/** A change on this date: after the first year's start, after the lock date, and in no year with an approved valuation (LV9). */
async function assertYearOpen(tx: OrgTx, settings: LivestockSettings & { firstYearStart: string }, date: string): Promise<void> {
  if (date < settings.firstYearStart) {
    throw new ValidationError(`Livestock starts on ${settings.firstYearStart}; that's before it. Put earlier stock in the opening position.`);
  }
  await assertPostingDateAllowed(tx, date);
  await assertNoApprovedValuation(tx, date);
}

/**
 * Records one movement (LV1, LV3). A sale or purchase can link an approved
 * invoice or bill line, once per class (LV7). Refused when it would take a
 * class below zero on any date.
 */
export async function recordMovement(tx: OrgTx, input: Record<string, unknown>): Promise<{ created: boolean; movement: Movement }> {
  const settings = await requireLivestock(tx);
  const source = optionalSource(input.source);
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  const movementType = requireOneOf(input.movementType, "movementType", MOVEMENT_TYPES);
  const movementDate = parseIsoDate(input.movementDate, "The date");
  const kind = requireOneOf(input.kind, "kind", LIVESTOCK_KINDS);
  const classCode = requireString(input.classCode, "class", { maxLength: 50 });
  const definition = findClass(kind, classCode);
  if (!definition) throw new ValidationError(`${KIND_NAMES[kind]} has no class "${classCode}".`);
  const head = parseHead(input.head, "Head");
  const heldForOthers = movementType === "arrival" || movementType === "departure";
  const heldFor = heldForOthers ? requireString(input.heldFor, "Whose stock it is", { maxLength: 200 }) : null;
  if (!heldForOthers && input.heldFor) throw new ValidationError("Only stock arriving or leaving for someone else is held for others.");
  if (movementType === "birth" && !definition.birth) {
    throw new ValidationError(`Births go into the youngest classes. ${definition.name} isn't one.`);
  }
  let toClassCode: string | null = null;
  if (movementType === "reclass") {
    toClassCode = requireString(input.toClassCode, "The new class", { maxLength: 50 });
    if (!findClass(kind, toClassCode)) throw new ValidationError(`${KIND_NAMES[kind]} has no class "${toClassCode}".`);
    if (toClassCode === classCode) throw new ValidationError("The new class is the same as the old one.");
  }
  const locationId = await requireLocation(tx, input.locationId, "locationId");
  let toLocationId: string | null = null;
  if (movementType === "transfer") {
    toLocationId = await requireLocation(tx, input.toLocationId, "toLocationId");
    if (!toLocationId) throw new ValidationError("Say where the stock moved to.");
    if (toLocationId === locationId) throw new ValidationError("The stock is moving to the same location.");
  }
  const rationsFor = movementType === "rations" ? requireOneOf(input.rationsFor, "Whose rations", RATIONS_FOR) : null;
  if (movementType !== "rations" && input.rationsFor) throw new ValidationError("Only rations are for the owner or staff.");
  const amountGiven = input.amount !== undefined && input.amount !== null && input.amount !== "";
  let amount: string | null = null;
  if (movementType === "purchase" || movementType === "sale") {
    amount = amountGiven ? parseDecimalInput(input.amount, "Amount", { maxScale: 2, allowZero: true }) : null;
  } else if (rationsFor === "owner") {
    // Income at market value (RAT1), so the value is needed.
    if (!amountGiven) throw new ValidationError("Enter the market value of the owner's rations, and say whether it includes GST. It's income at market value.");
    amount = parseDecimalInput(input.amount, "Market value", { maxScale: 2 });
  } else if (amountGiven) {
    throw new ValidationError(rationsFor === "staff" ? "Staff rations have no value to enter: nothing is posted, and the lower closing stock is the cost." : "Only purchases, sales and the owner's rations have an amount.");
  }
  const salesInvoiceLineId = optionalId(input.salesInvoiceLineId, "salesInvoiceLineId");
  const billLineId = optionalId(input.billLineId, "billLineId");
  if (salesInvoiceLineId && movementType !== "sale") throw new ValidationError("Only a sale can be linked to an invoice line.");
  if (billLineId && movementType !== "purchase") throw new ValidationError("Only a purchase can be linked to a bill line.");
  const note = optionalString(input.note, "note", { maxLength: 1000 });
  // The owner's rations record who they went to, the legal entity they came from, and whether the value includes GST (RAT1).
  let rationsRecipient: string | null = null;
  let rationsEntity: string | null = null;
  let amountIncludesGst: boolean | null = null;
  if (rationsFor === "owner") {
    rationsRecipient = requireString(input.rationsRecipient, "Who the rations went to", { maxLength: 200 });
    rationsEntity = requireString(input.rationsEntity, "The legal entity the rations came from", { maxLength: 200 });
    if (input.amountIncludesGst !== undefined && input.amountIncludesGst !== null && typeof input.amountIncludesGst !== "boolean") {
      throw new ValidationError("Say whether the value includes GST (true or false).");
    }
    amountIncludesGst = input.amountIncludesGst === true;
  } else if (input.rationsRecipient || input.rationsEntity || input.amountIncludesGst !== undefined) {
    throw new ValidationError("Only the owner's rations record a recipient, a legal entity and whether the value includes GST.");
  }
  const gstInput = input.gstAssessment && typeof input.gstAssessment === "object" ? (input.gstAssessment as Record<string, unknown>) : null;
  if (gstInput && rationsFor !== "owner") throw new ValidationError("Only the owner's rations are assessed for GST. Staff rations need their own analysis.");

  const hash = requestHash("livestock_movement", {
    movementType,
    movementDate,
    kind,
    classCode,
    toClassCode,
    head,
    heldFor,
    amount,
    locationId,
    toLocationId,
    salesInvoiceLineId,
    billLineId,
    rationsFor,
    note,
    ...(rationsFor === "owner" ? { rationsRecipient, rationsEntity, amountIncludesGst, gstAssessment: gstInput } : {}),
  });
  const earlier = await tx.query<{ id: string; request_hash: string }>(
    "select id::text, request_hash from livestock_movements where command_source = $1 and idempotency_key = $2",
    [source, idempotencyKey],
  );
  if (earlier.rows[0]) {
    assertSameRequest(earlier.rows[0].request_hash, hash, "livestock movement");
    return { created: false, movement: await getMovement(tx, earlier.rows[0].id) };
  }
  await assertYearOpen(tx, settings, movementDate);
  if (salesInvoiceLineId) await assertDocumentLine(tx, "invoice", salesInvoiceLineId);
  if (billLineId) await assertDocumentLine(tx, "bill", billLineId);
  const rationsAccounts = rationsFor === "owner" ? await requireRationsAccounts(tx) : null;
  // A GST-registered date: the event can be assessed as it's recorded; otherwise it waits, unresolved (RAT10).
  const registered = rationsFor === "owner" ? await registeredOn(tx, movementDate) : false;
  if (gstInput && !registered) throw new ValidationError(`This organisation wasn't GST-registered on ${movementDate}, so there's no GST to assess.`);
  const assessment = gstInput && amount ? await parseAssessment(tx, { outcome: gstInput.outcome, basis: gstInput.basis, gstAmount: gstInput.gstAmount }, amount, amountIncludesGst === true) : null;

  await lockLivestock(tx);
  let id: string;
  try {
    const row = await tx.query<{ id: string }>(
      `insert into livestock_movements (command_source, idempotency_key, request_hash, movement_date, movement_type, ownership, held_for, kind,
         class_code, to_class_code, head, amount, location_id, to_location_id, sales_invoice_line_id, bill_line_id, note,
         created_by_user_id, created_by_email, rations_for, rations_recipient, rations_entity, amount_includes_gst)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::numeric, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23) returning id::text`,
      [
        source,
        idempotencyKey,
        hash,
        movementDate,
        movementType,
        heldForOthers ? "held_for_others" : "owned",
        heldFor,
        kind,
        classCode,
        toClassCode,
        head,
        amount,
        locationId,
        toLocationId,
        salesInvoiceLineId,
        billLineId,
        note,
        tx.actor.userId,
        tx.actor.email,
        rationsFor,
        rationsRecipient,
        rationsEntity,
        amountIncludesGst,
      ],
    );
    id = row.rows[0].id;
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ConflictError(
        `That ${salesInvoiceLineId ? "invoice" : "bill"} line is already linked to a movement of ${definition.name.toLowerCase()}. A sale or purchase is only counted once.`,
      );
    }
    throw error;
  }
  await assertNoNegative(tx);
  if (rationsAccounts && amount) {
    const journal = await postJournalBody(
      tx,
      "livestock_rations",
      id,
      parseJournalBody(tx, {
        postingDate: movementDate,
        reference: `RATIONS-${id}`,
        description: `${head} ${definition.name.toLowerCase()} killed for the owner's rations, at market value${assessment ? ` (${assessment.outcome === "taxable_supply" ? "taxable supply" : assessment.outcome === "change_in_use" ? "change-in-use GST adjustment" : "no GST adjustment"})` : ""}`,
        // Unresolved, not registered or no adjustment: the value, with no GST. Assessed now: the GST as well (RAT5-RAT7).
        lines: await rationsJournalLines(tx, rationsAccounts, assessment ? assessment.posting : rationsPosting({ value: dec(amount), includesGst: amountIncludesGst === true, status: "unresolved" })),
      }),
      { origin: "livestock_rations" },
    );
    await tx.query("update livestock_movements set journal_id = $2 where id = $1", [id, journal.journal.id]);
    if (assessment) await insertAssessment(tx, id, assessment, null);
  }
  await writeAuditEvent(tx, {
    eventType: "livestock.movement_recorded",
    entityType: "livestock_movement",
    entityId: id,
    details: { movementType, movementDate, kind, classCode, toClassCode, head, heldFor, amount, rationsFor, ...(rationsFor === "owner" ? { rationsRecipient, rationsEntity, amountIncludesGst, gstOutcome: assessment?.outcome ?? null } : {}) },
  });
  return { created: true, movement: await getMovement(tx, id) };
}

/**
 * Assesses an owner's rations event for GST, or assesses it again with a
 * reason (RAT5-RAT9). When the amounts change, the rations journal is
 * reversed and posted again on the event's date.
 */
export async function assessMovementGst(tx: OrgTx, idInput: unknown, input: { outcome: unknown; basis: unknown; gstAmount?: unknown; reason?: unknown }): Promise<Movement> {
  await requireLivestock(tx);
  const id = requireId(idInput, "movementId");
  await lockLivestock(tx);
  const accounts = await requireRationsAccounts(tx);
  await assessRationsGst(tx, { movementId: id, ...input }, accounts);
  return getMovement(tx, id);
}

/** The owner's rations accounts, made if they aren't set yet (RAT1). */
async function requireRationsAccounts(tx: OrgTx): Promise<{ income: string; drawings: string }> {
  await ensureAccounts(tx);
  const { accounts } = await getLivestockSettings(tx);
  if (!accounts.rationsIncome || !accounts.drawings) {
    throw new ValidationError("Choose the rations income and drawings accounts in Livestock › Settings first.");
  }
  return { income: accounts.rationsIncome.code, drawings: accounts.drawings.code };
}

async function assertDocumentLine(tx: OrgTx, kind: "invoice" | "bill", lineId: string): Promise<void> {
  const row =
    kind === "invoice"
      ? await tx.query<{ status: string }>("select i.status from sales_invoice_lines l join sales_invoices i on i.id = l.invoice_id where l.id = $1", [lineId])
      : await tx.query<{ status: string }>("select b.status from bill_lines l join bills b on b.id = l.bill_id where l.id = $1", [lineId]);
  if (!row.rows[0]) throw new ValidationError(`That ${kind} line wasn't found.`);
  if (row.rows[0].status !== "approved") throw new ValidationError(`Only an approved ${kind}'s line can be linked.`);
}

/** Voids a movement (it stays, marked voided, with the reason). Ageing movements are undone with their run. */
export async function voidMovement(tx: OrgTx, idInput: unknown, input: { reason: unknown }): Promise<Movement> {
  const settings = await requireLivestock(tx);
  const movement = await getMovement(tx, idInput);
  const reason = requireString(input.reason, "A reason", { maxLength: 500 });
  if (movement.voided) return movement;
  await assertYearOpen(tx, settings, movement.movementDate);
  await lockLivestock(tx);
  let voidJournalId: string | null = null;
  // The owner's rations journal as it stands now (after any GST assessment) is reversed on the movement's date (RAT3, RAT8).
  const posted = movement.journalId ? await currentPostingJournal(tx, movement.id, movement.journalId) : null;
  if (posted) {
    voidJournalId = await reverseRationsJournal(tx, movement.id, posted, movement.movementDate, `Voided: ${reason}`, "livestock_rations:void", movement.id);
  }
  await tx.query("update livestock_movements set voided_at = now(), voided_by_email = $2, void_reason = $3, void_journal_id = $4 where id = $1", [
    movement.id,
    tx.actor.email,
    reason,
    voidJournalId,
  ]);
  await assertNoNegative(tx);
  await writeAuditEvent(tx, { eventType: "livestock.movement_voided", entityType: "livestock_movement", entityId: movement.id, details: { reason } });
  return getMovement(tx, movement.id);
}

async function lockLivestock(tx: OrgTx): Promise<void> {
  await tx.query("select 1 from livestock_settings where id = true for update");
}


// The herd, worked out ---------------------------------------------------------

type HerdState = {
  settings: LivestockSettings & { firstYearStart: string };
  openings: Map<string, number>;
  movements: HerdMovement[];
  splits: Map<string, Map<string, number>>;
};

async function loadHerd(tx: OrgTx, settings: LivestockSettings & { firstYearStart: string }): Promise<HerdState> {
  const openings = await tx.query<{ kind: string; class_code: string; head: number }>("select kind, class_code, head from livestock_openings");
  const movements = await tx.query<{ movement_date: string; movement_type: string; kind: string; class_code: string; to_class_code: string | null; head: number }>(
    `select movement_date::text, movement_type, kind, class_code, to_class_code, head
       from livestock_movements where voided_at is null and ownership = 'owned' order by movement_date, id`,
  );
  const splitRows = await tx.query<{ year_start: string; kind: string; class_code: string; head: number }>(
    "select year_start::text, kind, class_code, head from livestock_ageing_splits",
  );
  const splits = new Map<string, Map<string, number>>();
  for (const row of splitRows.rows) {
    const year = splits.get(row.year_start) ?? new Map<string, number>();
    year.set(classKey(row.kind, row.class_code), row.head);
    splits.set(row.year_start, year);
  }
  return {
    settings,
    openings: new Map(openings.rows.map((row) => [classKey(row.kind, row.class_code), row.head])),
    movements: movements.rows.map((row) => ({
      movementDate: row.movement_date,
      movementType: row.movement_type,
      kind: row.kind,
      classCode: row.class_code,
      toClassCode: row.to_class_code,
      head: row.head,
    })),
    splits,
  };
}

function walk(state: HerdState, until: string) {
  return walkHerd({
    firstYearStart: state.settings.firstYearStart,
    yearEndMonth: state.settings.financialYearEndMonth,
    openings: state.openings,
    movements: state.movements,
    splits: state.splits,
    until,
  });
}

/**
 * Refuses any change that takes a class (the farm's own, or stock held for
 * one person) below zero on some date, ageing included.
 */
async function assertNoNegative(tx: OrgTx): Promise<void> {
  const settings = await requireLivestock(tx);
  const state = await loadHerd(tx, settings);
  const latestSplit = [...state.splits.keys()].reduce((latest, year) => (year > latest ? year : latest), settings.firstYearStart);
  const until = financialYearEnd(lastDate(state.movements, latestSplit), settings.financialYearEndMonth);
  const { negative } = walk(state, until);
  if (negative) {
    const [kind, code] = negative.key.split(".");
    throw new ValidationError(
      `That would leave ${className(kind, code).toLowerCase()} below zero on ${negative.date}. Record the births, purchases or class changes first.`,
    );
  }
  const held = await tx.query<{ held_for: string; kind: string; class_code: string; movement_date: string }>(
    `with daily as (
       select held_for, kind, class_code, movement_date as d, sum(case movement_type when 'arrival' then head else -head end) as delta
         from livestock_movements where voided_at is null and ownership = 'held_for_others'
        group by held_for, kind, class_code, movement_date
     ), running as (
       select held_for, kind, class_code, d, sum(delta) over (partition by held_for, kind, class_code order by d) as balance from daily
     )
     select held_for, kind, class_code, d::text as movement_date from running where balance < 0 order by d limit 1`,
  );
  if (held.rows[0]) {
    const row = held.rows[0];
    throw new ValidationError(`More ${className(row.kind, row.class_code).toLowerCase()} would leave than arrived for ${row.held_for} (on ${row.movement_date}).`);
  }
}

/** Stage 3 adds approved valuations; a year with one (or a later one) can't change (LV9). */
async function assertNoApprovedValuation(tx: OrgTx, date: string): Promise<void> {
  const table = await tx.query("select 1 from pg_tables where tablename = 'livestock_valuations'");
  if (!table.rowCount) return;
  const approved = await tx.query<{ year_end: string }>(
    "select year_end::text from livestock_valuations where year_end >= $1 and status = 'approved' order by year_end limit 1",
    [date],
  );
  if (approved.rows[0]) {
    throw new ConflictError(`The livestock valuation for the year to ${approved.rows[0].year_end} is approved, so this can't change. Replace the valuation first.`);
  }
}

function requireYearEnd(settings: LivestockSettings & { firstYearStart: string }, input: unknown): string {
  const yearEnd = parseIsoDate(input, "The year end");
  if (financialYearEnd(yearEnd, settings.financialYearEndMonth) !== yearEnd) {
    throw new ValidationError(`${yearEnd} isn't a financial year end.`);
  }
  if (yearEnd < settings.firstYearStart) throw new ValidationError(`Livestock starts on ${settings.firstYearStart}.`);
  return yearEnd;
}

// Ageing -----------------------------------------------------------------------

export type AgeingPreview = { yearStart: string; steps: AgeingStep[]; needsSplit: AgeingStep[] };

/**
 * What ageing does at the start of the year ending `yearEnd` (LV1): every
 * class's head at the end of the year before moves to the next class. It's
 * worked out, not run, so it can't happen twice.
 */
export async function previewAgeing(tx: OrgTx, input: { yearEnd: unknown }): Promise<AgeingPreview> {
  const settings = await requireLivestock(tx);
  const yearEnd = requireYearEnd(settings, input.yearEnd);
  const yearStart = financialYearStart(yearEnd, settings.financialYearEndMonth);
  const state = await loadHerd(tx, settings);
  const before = walk(state, addDays(yearStart, -1)).balances;
  return { yearStart, ...ageingSteps(before, state.splits.get(yearStart) ?? new Map()) };
}

/** How many mixed-age ewes (rising three and four) turn rising five at the start of a year. */
export async function setAgeingSplit(tx: OrgTx, input: { yearEnd: unknown; kind: unknown; classCode: unknown; head: unknown }): Promise<AgeingPreview> {
  const settings = await requireLivestock(tx);
  const yearEnd = requireYearEnd(settings, input.yearEnd);
  const yearStart = financialYearStart(yearEnd, settings.financialYearEndMonth);
  const kind = requireOneOf(input.kind, "kind", LIVESTOCK_KINDS);
  const classCode = requireString(input.classCode, "class", { maxLength: 50 });
  const definition = findClass(kind, classCode);
  if (!definition?.agesInPart) throw new ValidationError(`${definition?.name ?? classCode} all turn older together; there's nothing to split.`);
  const head = parseHead(input.head, "Head", true);
  await assertYearOpen(tx, settings, yearStart);
  await lockLivestock(tx);
  await tx.query(
    `insert into livestock_ageing_splits (year_start, kind, class_code, head, updated_by_email) values ($1, $2, $3, $4, $5)
     on conflict (year_start, kind, class_code) do update set head = excluded.head, updated_by_email = excluded.updated_by_email, updated_at = now()`,
    [yearStart, kind, classCode, head, tx.actor.email],
  );
  const before = walk(await loadHerd(tx, settings), addDays(yearStart, -1)).balances.get(classKey(kind, classCode)) ?? 0;
  if (head > before) throw new ValidationError(`Only ${before} ${definition.name.toLowerCase()} were on hand at the start of the year.`);
  await assertNoNegative(tx);
  const preview = await previewAgeing(tx, { yearEnd });
  await writeAuditEvent(tx, { eventType: "livestock.ageing_split", entityType: "livestock_settings", entityId: "1", details: { yearStart, kind, classCode, head } });
  return preview;
}

// Head counts ------------------------------------------------------------------

export type HeadCountRow = {
  kind: LivestockKind;
  classCode: string;
  className: string;
  opening: number;
  births: number;
  bought: number;
  sold: number;
  died: number;
  /** Killed for the owner's or staff rations (RAT4): its own line, not a death. */
  rations: number;
  missing: number;
  found: number;
  reclassIn: number;
  reclassOut: number;
  ageingIn: number;
  ageingOut: number;
  closing: number;
  counted: number | null;
  /** Expected less counted; non-zero = "not explained" (LV2). */
  unexplained: number | null;
};

type Totals = Omit<HeadCountRow, "kind" | "classCode" | "className" | "counted" | "unexplained">;

export type HeldRow = { heldFor: string; kind: LivestockKind; classCode: string; className: string; opening: number; arrived: number; left: number; closing: number };

export type HeadCount = {
  yearStart: string;
  yearEnd: string;
  rows: HeadCountRow[];
  totals: Totals;
  /** Ageing nets to zero across the herd (LV1). */
  ageingBalances: boolean;
  /** Mixed-age ewes waiting for "how many turn rising five". */
  needsSplit: AgeingStep[];
  unexplained: Array<{ kind: LivestockKind; classCode: string; className: string; expected: number; counted: number; difference: number }>;
  held: HeldRow[];
  byLocation: Array<{ locationId: string | null; locationName: string; kind: LivestockKind; head: number }>;
};

/** The head count reconciliation for an income year (LV1-LV3). */
export async function headCount(tx: OrgTx, input: { yearEnd: unknown }): Promise<HeadCount> {
  const settings = await requireLivestock(tx);
  const yearEnd = requireYearEnd(settings, input.yearEnd);
  const yearStart = financialYearStart(yearEnd, settings.financialYearEndMonth);
  const state = await loadHerd(tx, settings);
  const opening = walk(state, addDays(yearStart, -1)).balances;
  const ageing = ageingSteps(opening, state.splits.get(yearStart) ?? new Map());

  const rows = new Map<string, HeadCountRow>();
  const rowFor = (kind: string, code: string) => {
    const key = classKey(kind, code);
    let row = rows.get(key);
    if (!row) {
      row = {
        kind: kind as LivestockKind,
        classCode: code,
        className: className(kind, code),
        opening: opening.get(key) ?? 0,
        births: 0,
        bought: 0,
        sold: 0,
        died: 0,
        rations: 0,
        missing: 0,
        found: 0,
        reclassIn: 0,
        reclassOut: 0,
        ageingIn: 0,
        ageingOut: 0,
        closing: 0,
        counted: null,
        unexplained: null,
      };
      rows.set(key, row);
    }
    return row;
  };
  for (const [key, head] of opening) {
    if (head === 0) continue;
    const [kind, code] = key.split(".");
    rowFor(kind, code);
  }
  for (const step of ageing.steps) {
    rowFor(step.kind, step.classCode).ageingOut += step.head;
    rowFor(step.kind, step.toClassCode).ageingIn += step.head;
  }
  for (const movement of state.movements) {
    if (movement.movementDate < yearStart || movement.movementDate > yearEnd) continue;
    const row = rowFor(movement.kind, movement.classCode);
    const head = movement.head;
    switch (movement.movementType) {
      case "birth":
        row.births += head;
        break;
      case "purchase":
        row.bought += head;
        break;
      case "sale":
        row.sold += head;
        break;
      case "death":
        row.died += head;
        break;
      case "rations":
        row.rations += head;
        break;
      case "missing":
        row.missing += head;
        break;
      case "found":
        row.found += head;
        break;
      case "reclass":
        row.reclassOut += head;
        rowFor(movement.kind, movement.toClassCode ?? "").reclassIn += head;
        break;
      default:
        break;
    }
  }
  const counts = await tx.query<{ kind: string; class_code: string; head: number }>(
    "select distinct on (kind, class_code) kind, class_code, head from livestock_counts where count_date = $1 order by kind, class_code, id desc",
    [yearEnd],
  );
  for (const count of counts.rows) rowFor(count.kind, count.class_code);
  const order = (row: HeadCountRow) => LIVESTOCK_CLASSES.findIndex((entry) => entry.kind === row.kind && entry.code === row.classCode);
  const list = [...rows.values()].sort((a, b) => order(a) - order(b));
  const unexplained: HeadCount["unexplained"] = [];
  for (const row of list) {
    row.closing =
      row.opening + row.births + row.bought - row.sold - row.died - row.rations - row.missing + row.found + row.reclassIn - row.reclassOut + row.ageingIn - row.ageingOut;
    const count = counts.rows.find((entry) => entry.kind === row.kind && entry.class_code === row.classCode);
    if (count) {
      row.counted = count.head;
      row.unexplained = row.closing - count.head;
      if (row.unexplained !== 0) {
        unexplained.push({ kind: row.kind, classCode: row.classCode, className: row.className, expected: row.closing, counted: count.head, difference: row.unexplained });
      }
    }
  }
  const total = (field: keyof Totals) => list.reduce((sum, row) => sum + row[field], 0);
  const totals: Totals = {
    opening: total("opening"),
    births: total("births"),
    bought: total("bought"),
    sold: total("sold"),
    died: total("died"),
    rations: total("rations"),
    missing: total("missing"),
    found: total("found"),
    reclassIn: total("reclassIn"),
    reclassOut: total("reclassOut"),
    ageingIn: total("ageingIn"),
    ageingOut: total("ageingOut"),
    closing: total("closing"),
  };

  const held = await tx.query<{ held_for: string; kind: string; class_code: string; opening: string; arrived: string; left_: string }>(
    `select held_for, kind, class_code,
            sum(case when movement_date < $1 then (case movement_type when 'arrival' then head else -head end) else 0 end)::text as opening,
            sum(case when movement_date >= $1 and movement_type = 'arrival' then head else 0 end)::text as arrived,
            sum(case when movement_date >= $1 and movement_type = 'departure' then head else 0 end)::text as left_
       from livestock_movements where voided_at is null and ownership = 'held_for_others' and movement_date <= $2
      group by held_for, kind, class_code order by lower(held_for), kind, class_code`,
    [yearStart, yearEnd],
  );
  const heldRows: HeldRow[] = held.rows
    .map((row) => {
      const opened = Number(row.opening);
      const arrived = Number(row.arrived);
      const left = Number(row.left_);
      return {
        heldFor: row.held_for,
        kind: row.kind as LivestockKind,
        classCode: row.class_code,
        className: className(row.kind, row.class_code),
        opening: opened,
        arrived,
        left,
        closing: opened + arrived - left,
      };
    })
    .filter((row) => row.opening !== 0 || row.arrived !== 0 || row.left !== 0);

  return {
    yearStart,
    yearEnd,
    rows: list,
    totals,
    ageingBalances: totals.ageingIn === totals.ageingOut,
    needsSplit: ageing.needsSplit,
    unexplained,
    held: heldRows,
    byLocation: await locationBalances(tx, yearEnd),
  };
}

/**
 * Where the farm's own stock is at a date, by kind (ageing and class changes
 * don't move stock). The opening, and movements without a location, are
 * "No location".
 */
async function locationBalances(tx: OrgTx, asAt: string): Promise<HeadCount["byLocation"]> {
  const rows = await tx.query<{ location_id: string | null; location_name: string | null; kind: string; head: string }>(
    `select d.location_id::text, l.name as location_name, d.kind, sum(d.delta)::text as head from (
       select null::bigint as location_id, kind, head as delta from livestock_openings
       union all
       select location_id, kind,
              case movement_type when 'birth' then head when 'purchase' then head when 'found' then head
                                 when 'sale' then -head when 'death' then -head when 'rations' then -head when 'missing' then -head
                                 when 'transfer' then -head else 0 end
         from livestock_movements where voided_at is null and ownership = 'owned' and movement_date <= $1
       union all
       select to_location_id, kind, head from livestock_movements
        where voided_at is null and ownership = 'owned' and movement_type = 'transfer' and movement_date <= $1
     ) d left join livestock_locations l on l.id = d.location_id
     group by d.location_id, l.name, d.kind having sum(d.delta) <> 0
     order by l.name nulls first, d.kind`,
    [asAt],
  );
  return rows.rows.map((row) => ({
    locationId: row.location_id,
    locationName: row.location_name ?? "No location",
    kind: row.kind as LivestockKind,
    head: Number(row.head),
  }));
}

/** Records what was counted at a year end, by class, after ageing (LV2). A new count for a class replaces the last. */
export async function recordCounts(tx: OrgTx, input: { countDate: unknown; lines: unknown }): Promise<HeadCount> {
  const settings = await requireLivestock(tx);
  const countDate = requireYearEnd(settings, input.countDate);
  const lines = requireArray(input.lines, "lines", 100);
  for (const [index, raw] of lines.entries()) {
    const line = (raw ?? {}) as Record<string, unknown>;
    const kind = requireOneOf(line.kind, `Line ${index + 1} kind`, LIVESTOCK_KINDS);
    const classCode = requireString(line.classCode, `Line ${index + 1} class`, { maxLength: 50 });
    if (!findClass(kind, classCode)) throw new ValidationError(`${KIND_NAMES[kind]} has no class "${classCode}".`);
    const head = parseHead(line.head, `Line ${index + 1} head`, true);
    await tx.query("insert into livestock_counts (count_date, kind, class_code, head, created_by_email) values ($1, $2, $3, $4, $5)", [
      countDate,
      kind,
      classCode,
      head,
      tx.actor.email,
    ]);
  }
  await writeAuditEvent(tx, { eventType: "livestock.counted", entityType: "livestock_settings", entityId: "1", details: { countDate, lines: lines.length } });
  return headCount(tx, { yearEnd: countDate });
}

// For the valuation -------------------------------------------------------------

export type YearMovement = HerdMovement & { id: string; amount: string | null; linkedNetAmount: string | null };

export type YearFacts = {
  yearStart: string;
  yearEnd: string;
  /** Head by class at the end of the year before (before ageing). */
  opening: Map<string, number>;
  ageing: { steps: AgeingStep[]; needsSplit: AgeingStep[] };
  /** The year's own movements of the farm's own stock. */
  movements: YearMovement[];
  closing: Map<string, number>;
  unexplained: HeadCount["unexplained"];
};

/** Everything the year-end valuation needs from the head count (LV4-LV11). */
export async function yearFacts(tx: OrgTx, yearEnd: string): Promise<YearFacts> {
  const settings = await requireLivestock(tx);
  const yearStart = financialYearStart(yearEnd, settings.financialYearEndMonth);
  const state = await loadHerd(tx, settings);
  const opening = walk(state, addDays(yearStart, -1)).balances;
  const closing = walk(state, yearEnd).balances;
  const rows = await tx.query<{
    id: string;
    movement_date: string;
    movement_type: string;
    kind: string;
    class_code: string;
    to_class_code: string | null;
    head: number;
    amount: string | null;
    linked: string | null;
  }>(
    `select m.id::text, m.movement_date::text, m.movement_type, m.kind, m.class_code, m.to_class_code, m.head, m.amount::text,
            coalesce(il.net_amount, bl.net_amount)::text as linked
       from livestock_movements m
       left join sales_invoice_lines il on il.id = m.sales_invoice_line_id
       left join bill_lines bl on bl.id = m.bill_line_id
      where m.voided_at is null and m.ownership = 'owned' and m.movement_date between $1 and $2
      order by m.movement_date, m.id`,
    [yearStart, yearEnd],
  );
  const counted = await headCount(tx, { yearEnd });
  return {
    yearStart,
    yearEnd,
    opening,
    ageing: ageingSteps(opening, state.splits.get(yearStart) ?? new Map()),
    movements: rows.rows.map((row) => ({
      id: row.id,
      movementDate: row.movement_date,
      movementType: row.movement_type,
      kind: row.kind,
      classCode: row.class_code,
      toClassCode: row.to_class_code,
      head: row.head,
      amount: row.amount,
      linkedNetAmount: row.linked,
    })),
    closing,
    unexplained: counted.unexplained,
  };
}

export { requireYearEnd };

/** The farm's own head by class at the end of each date (ageing included), for management valuations (LV18). */
export async function herdBalancesAt(tx: OrgTx, dates: readonly string[]): Promise<Map<string, Map<string, number>>> {
  const settings = await requireLivestock(tx);
  const state = await loadHerd(tx, settings);
  const result = new Map<string, Map<string, number>>();
  for (const date of dates) result.set(date, date < settings.firstYearStart ? new Map(state.openings) : walk(state, date).balances);
  return result;
}
