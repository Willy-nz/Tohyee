import { createHash } from "node:crypto";
import { createAccount } from "@/lib/accounts/service";
import { writeAuditEvent } from "@/lib/audit";
import { parseDelimited } from "@/lib/bank/formats/table";
import { parseIsoDate } from "@/lib/dates";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { add, cmp, dec, type Decimal, divide, mul, parseDecimalInput, sub, sum, toFixedString, ZERO_DECIMAL } from "@/lib/money/decimal";
import { optionalString, requireArray, requireId, requireString } from "@/lib/validation";

/*
 * Fertiliser plans, purchases and applications (examples FB1-FB8, approved
 * by Jess 13 Oct 2026; decision 514). Fertiliser is expensed when bought, so
 * a purchase is a link to an approved bill line (6310), and applying it is a
 * record on the paddock that posts nothing. Applications take their cost for
 * reports from the plan's linked purchases at their average price; anything
 * applied beyond what was bought uses the plan's quoted price, marked
 * "quoted" (FB8). The spreading contractor's bill (6320) posts once and is
 * shared across the applications it covered by hectares (FB5). No rates are
 * recommended and nothing about nutrient loss is worked out.
 */

const FERTILISER_ACCOUNTS = [
  { column: "fertiliser_account_id", code: "6310", name: "Fertiliser and lime" },
  { column: "spreading_account_id", code: "6320", name: "Fertiliser spreading" },
] as const;

/** Adds 6310 Fertiliser and lime and 6320 Fertiliser spreading when Farming is turned on, unless those codes are taken. */
export async function ensureFertiliserAccounts(tx: OrgTx): Promise<void> {
  for (const spec of FERTILISER_ACCOUNTS) {
    const set = await tx.query<{ id: string | null }>(`select ${spec.column}::text as id from farming_settings where id = true`);
    if (set.rows[0]?.id) continue;
    const existing = await tx.query<{ id: string; account_class: string }>("select id::text, account_class from accounts where lower(code) = lower($1)", [spec.code]);
    let id: string | null = null;
    if (existing.rows[0]) {
      if (existing.rows[0].account_class === "expense") id = existing.rows[0].id;
    } else {
      id = (await createAccount(tx, { code: spec.code, name: spec.name, accountType: "expense" })).id;
    }
    if (id) await tx.query(`update farming_settings set ${spec.column} = $1 where id = true`, [id]);
  }
}

// Products ----------------------------------------------------------------------------------

export type FertiliserProduct = { id: string; name: string; nPct: string; pPct: string; kPct: string; sPct: string; isActive: boolean };

async function requireFarming(tx: OrgTx): Promise<void> {
  const row = await tx.query<{ enabled: boolean }>("select enabled from farming_settings where id = true");
  if (row.rows[0]?.enabled !== true) throw new ValidationError("Farming is off. An admin can turn it on under Settings, Modules.");
}

const pct = (value: string) => toFixedString(dec(value), 2);

export async function listProducts(tx: OrgTx): Promise<FertiliserProduct[]> {
  await requireFarming(tx);
  const rows = await tx.query<{ id: string; name: string; n_pct: string; p_pct: string; k_pct: string; s_pct: string; is_active: boolean }>(
    "select id::text, name, n_pct::text, p_pct::text, k_pct::text, s_pct::text, is_active from fertiliser_products order by not is_active, lower(name), fertiliser_products.id",
  );
  return rows.rows.map((row) => ({ id: row.id, name: row.name, nPct: pct(row.n_pct), pPct: pct(row.p_pct), kPct: pct(row.k_pct), sPct: pct(row.s_pct), isActive: row.is_active }));
}

function parsePct(input: unknown, label: string): string {
  if (input === undefined || input === null || input === "") return "0";
  const value = parseDecimalInput(input, label, { maxScale: 2, allowZero: true });
  if (cmp(dec(value), dec("100")) > 0) throw new ValidationError(`${label} can be at most 100%.`);
  return value;
}

/** Adds a product with its nutrient content (% by weight), or changes one (`id`). */
export async function saveProduct(tx: OrgTx, input: { id?: unknown; name: unknown; nPct?: unknown; pPct?: unknown; kPct?: unknown; sPct?: unknown; isActive?: unknown }): Promise<FertiliserProduct[]> {
  await requireFarming(tx);
  const name = requireString(input.name, "Product name", { maxLength: 100 });
  const values = [parsePct(input.nPct, "N"), parsePct(input.pPct, "P"), parsePct(input.kPct, "K"), parsePct(input.sPct, "S")];
  if (cmp(sum(values.map(dec)), dec("100")) > 0) throw new ValidationError("N, P, K and S add up to more than 100%.");
  const id = input.id ? requireId(input.id, "productId") : null;
  const clash = await tx.query("select 1 from fertiliser_products where lower(name) = lower($1) and ($2::bigint is null or id <> $2)", [name, id]);
  if (clash.rowCount) throw new ValidationError(`There's already a product called ${name}.`);
  if (id) {
    const updated = await tx.query("update fertiliser_products set name = $2, n_pct = $3, p_pct = $4, k_pct = $5, s_pct = $6, is_active = $7 where id = $1", [
      id,
      name,
      ...values,
      input.isActive === undefined ? true : input.isActive === true,
    ]);
    if (!updated.rowCount) throw new NotFoundError("Product not found.");
  } else {
    await tx.query("insert into fertiliser_products (name, n_pct, p_pct, k_pct, s_pct, created_by_email) values ($1, $2, $3, $4, $5, $6)", [name, ...values, tx.actor.email]);
  }
  await writeAuditEvent(tx, { eventType: "farming.fertiliser_product_saved", entityType: "fertiliser_product", entityId: id ?? name, details: { name } });
  return listProducts(tx);
}

// Plans ----------------------------------------------------------------------------------------

export type PlanSummary = { id: string; farmId: string; name: string; latestVersion: number | null; createdAt: string };

export async function listPlans(tx: OrgTx, input: { farmId: unknown }): Promise<PlanSummary[]> {
  await requireFarming(tx);
  const farmId = requireId(input.farmId, "farmId");
  const rows = await tx.query<{ id: string; farm_id: string; name: string; latest: number | null; created_at: string }>(
    `select p.id::text, p.farm_id::text, p.name, (select max(v.version) from fertiliser_plan_versions v where v.plan_id = p.id) as latest, p.created_at::text
       from fertiliser_plans p where p.farm_id = $1 order by p.created_at desc, p.id desc`,
    [farmId],
  );
  return rows.rows.map((row) => ({ id: row.id, farmId: row.farm_id, name: row.name, latestVersion: row.latest, createdAt: row.created_at }));
}

export async function createPlan(tx: OrgTx, input: { farmId: unknown; name: unknown }): Promise<PlanSummary> {
  await requireFarming(tx);
  const farmId = requireId(input.farmId, "farmId");
  const name = requireString(input.name, "Plan name", { maxLength: 100 });
  const farm = await tx.query("select 1 from farms where id = $1", [farmId]);
  if (!farm.rowCount) throw new NotFoundError("Farm not found.");
  const clash = await tx.query("select 1 from fertiliser_plans where farm_id = $1 and lower(name) = lower($2)", [farmId, name]);
  if (clash.rowCount) throw new ValidationError(`The farm already has a plan called ${name}.`);
  const row = await tx.query<{ id: string }>("insert into fertiliser_plans (farm_id, name, created_by_email) values ($1, $2, $3) returning id::text", [farmId, name, tx.actor.email]);
  await writeAuditEvent(tx, { eventType: "farming.fertiliser_plan_added", entityType: "fertiliser_plan", entityId: row.rows[0].id, details: { name } });
  return (await listPlans(tx, { farmId })).find((plan) => plan.id === row.rows[0].id)!;
}

async function requirePlan(tx: OrgTx, idInput: unknown): Promise<{ id: string; farm_id: string; name: string }> {
  await requireFarming(tx);
  const id = requireId(idInput, "planId");
  const row = await tx.query<{ id: string; farm_id: string; name: string }>("select id::text, farm_id::text, name from fertiliser_plans where id = $1", [id]);
  if (!row.rows[0]) throw new NotFoundError("Plan not found.");
  return row.rows[0];
}

/**
 * Saves a new version of a plan (FB2): its lines (paddock, product, kg/ha,
 * treated ha defaulting to the paddock's effective area, quoted price a
 * tonne) and the spreading quote a hectare. Earlier versions are kept.
 */
export async function savePlanVersion(
  tx: OrgTx,
  planIdInput: unknown,
  input: { spreadingPerHa?: unknown; note?: unknown; lines: unknown },
): Promise<PlanReport> {
  const plan = await requirePlan(tx, planIdInput);
  await tx.query("select 1 from fertiliser_plans where id = $1 for update", [plan.id]);
  const spreading = input.spreadingPerHa === undefined || input.spreadingPerHa === null || input.spreadingPerHa === "" ? null : parseDecimalInput(input.spreadingPerHa, "Spreading a hectare", { maxScale: 2, allowZero: true });
  const note = optionalString(input.note, "Note", { maxLength: 500 });
  const raw = requireArray(input.lines, "lines", 500);
  if (raw.length === 0) throw new ValidationError("A plan needs at least one paddock.");
  const lines = [];
  const seen = new Set<string>();
  for (const [index, entry] of raw.entries()) {
    const line = (entry ?? {}) as Record<string, unknown>;
    const label = `Line ${index + 1}`;
    const paddockId = requireId(line.paddockId, `${label} paddock`);
    const productId = requireId(line.productId, `${label} product`);
    const key = `${paddockId}|${productId}`;
    if (seen.has(key)) throw new ValidationError(`${label} repeats a paddock and product already in the plan.`);
    seen.add(key);
    const paddock = (await tx.query<{ farm_id: string; name: string; status: string; effective_ha: string | null }>("select farm_id::text, name, status, effective_ha::text from paddocks where id = $1", [paddockId])).rows[0];
    if (!paddock || paddock.farm_id !== plan.farm_id) throw new ValidationError(`${label}: that paddock isn't on this plan's farm.`);
    if (paddock.status !== "active") throw new ValidationError(`${label}: ${paddock.name} is retired.`);
    const product = (await tx.query<{ is_active: boolean; name: string }>("select is_active, name from fertiliser_products where id = $1", [productId])).rows[0];
    if (!product) throw new ValidationError(`${label}: that product wasn't found.`);
    const rate = parseDecimalInput(line.rateKgHa, `${label} kg/ha`, { maxScale: 2 });
    const treated =
      line.treatedHa === undefined || line.treatedHa === null || line.treatedHa === "" ? paddock.effective_ha : parseDecimalInput(line.treatedHa, `${label} treated ha`, { maxScale: 2 });
    if (!treated) throw new ValidationError(`${label}: ${paddock.name} has no effective area. Enter its treated hectares.`);
    const price = line.pricePerTonne === undefined || line.pricePerTonne === null || line.pricePerTonne === "" ? null : parseDecimalInput(line.pricePerTonne, `${label} price a tonne`, { maxScale: 2, allowZero: true });
    lines.push({ paddockId, productId, rate, treated, price });
  }
  const next = (await tx.query<{ next: number }>("select coalesce(max(version), 0) + 1 as next from fertiliser_plan_versions where plan_id = $1", [plan.id])).rows[0].next;
  const version = await tx.query<{ id: string }>(
    "insert into fertiliser_plan_versions (plan_id, version, spreading_per_ha, note, created_by_email) values ($1, $2, $3, $4, $5) returning id::text",
    [plan.id, next, spreading, note, tx.actor.email],
  );
  for (const line of lines) {
    await tx.query("insert into fertiliser_plan_lines (version_id, paddock_id, product_id, rate_kg_ha, treated_ha, price_per_tonne) values ($1, $2, $3, $4, $5, $6)", [
      version.rows[0].id,
      line.paddockId,
      line.productId,
      line.rate,
      toFixedString(dec(line.treated), 2),
      line.price,
    ]);
  }
  await writeAuditEvent(tx, { eventType: "farming.fertiliser_plan_version", entityType: "fertiliser_plan", entityId: plan.id, details: { version: next } });
  return getPlanReport(tx, plan.id);
}

// Purchases, applications and spreading -------------------------------------------------------

type BillLine = { id: string; bill_status: string; quantity: string; net: string; account_code: string; description: string; bill_date: string; supplier: string };

async function findBillLine(tx: OrgTx, idInput: unknown): Promise<BillLine> {
  const id = requireId(idInput, "billLineId");
  const row = await tx.query<BillLine>(
    `select l.id::text, b.status as bill_status, l.quantity::text, coalesce(l.base_net_amount, l.net_amount)::text as net, a.code as account_code, l.description,
            b.bill_date::text, c.name as supplier
       from bill_lines l join bills b on b.id = l.bill_id join accounts a on a.id = l.account_id join contacts c on c.id = b.contact_id
      where l.id = $1`,
    [id],
  );
  if (!row.rows[0]) throw new NotFoundError("That bill line wasn't found.");
  if (row.rows[0].bill_status !== "approved") throw new ConflictError("Only lines of approved bills can be linked.");
  return row.rows[0];
}

export type LinkableBillLine = { id: string; billDate: string; supplier: string; description: string; quantity: string; net: string; accountCode: string; linked: boolean };

/** Approved bill lines on the fertiliser or spreading account, newest first, for linking (FB3, FB5). */
export async function linkableBillLines(tx: OrgTx): Promise<LinkableBillLine[]> {
  await requireFarming(tx);
  const rows = await tx.query<BillLine & { linked: boolean }>(
    `select l.id::text, b.status as bill_status, l.quantity::text, coalesce(l.base_net_amount, l.net_amount)::text as net, a.code as account_code, l.description,
            b.bill_date::text, c.name as supplier,
            exists (select 1 from fertiliser_purchases p where p.bill_line_id = l.id) or exists (select 1 from fertiliser_spreading s where s.bill_line_id = l.id) as linked
       from bill_lines l join bills b on b.id = l.bill_id join accounts a on a.id = l.account_id join contacts c on c.id = b.contact_id
      where b.status = 'approved' and l.account_id in (select fertiliser_account_id from farming_settings union select spreading_account_id from farming_settings)
      order by b.bill_date desc, l.id desc limit 200`,
  );
  return rows.rows.map((row) => ({
    id: row.id,
    billDate: row.bill_date,
    supplier: row.supplier,
    description: row.description,
    quantity: toFixedString(dec(row.quantity), 3),
    net: toFixedString(dec(row.net), 2),
    accountCode: row.account_code,
    linked: row.linked,
  }));
}

/** Links a bill line to a plan as product bought (FB3). Tonnes default to the line's quantity. Posts nothing. */
export async function linkPurchase(tx: OrgTx, planIdInput: unknown, input: { billLineId: unknown; productId: unknown; tonnes?: unknown }): Promise<PlanReport> {
  const plan = await requirePlan(tx, planIdInput);
  const line = await findBillLine(tx, input.billLineId);
  const productId = requireId(input.productId, "productId");
  const product = await tx.query("select 1 from fertiliser_products where id = $1", [productId]);
  if (!product.rowCount) throw new ValidationError("That product wasn't found.");
  const tonnes = input.tonnes === undefined || input.tonnes === null || input.tonnes === "" ? toFixedString(dec(line.quantity), 3) : parseDecimalInput(input.tonnes, "Tonnes", { maxScale: 3 });
  const taken = await tx.query("select 1 from fertiliser_purchases where bill_line_id = $1 union all select 1 from fertiliser_spreading where bill_line_id = $1", [line.id]);
  if (taken.rowCount) throw new ConflictError("That bill line is already linked.");
  await tx.query("insert into fertiliser_purchases (plan_id, product_id, bill_line_id, tonnes, created_by_email) values ($1, $2, $3, $4, $5)", [plan.id, productId, line.id, tonnes, tx.actor.email]);
  await writeAuditEvent(tx, { eventType: "farming.fertiliser_purchase_linked", entityType: "fertiliser_plan", entityId: plan.id, details: { billLineId: line.id } });
  return getPlanReport(tx, plan.id);
}

export async function unlinkPurchase(tx: OrgTx, planIdInput: unknown, input: { billLineId: unknown }): Promise<PlanReport> {
  const plan = await requirePlan(tx, planIdInput);
  const billLineId = requireId(input.billLineId, "billLineId");
  await tx.query("delete from fertiliser_purchases where plan_id = $1 and bill_line_id = $2", [plan.id, billLineId]);
  return getPlanReport(tx, plan.id);
}

async function insertApplication(
  tx: OrgTx,
  plan: { id: string; farm_id: string },
  input: { paddockId: string; productId: string; appliedOn: string; tonnes: string; treatedHa: string | null; source: string },
  label = "",
): Promise<void> {
  const paddock = (await tx.query<{ farm_id: string; name: string; effective_ha: string | null }>("select farm_id::text, name, effective_ha::text from paddocks where id = $1", [input.paddockId])).rows[0];
  if (!paddock || paddock.farm_id !== plan.farm_id) throw new ValidationError(`${label}That paddock isn't on this plan's farm.`);
  const product = await tx.query("select 1 from fertiliser_products where id = $1", [input.productId]);
  if (!product.rowCount) throw new ValidationError(`${label}That product wasn't found.`);
  const treated = input.treatedHa ?? paddock.effective_ha;
  if (!treated) throw new ValidationError(`${label}${paddock.name} has no effective area. Enter the treated hectares.`);
  await tx.query(
    "insert into fertiliser_applications (plan_id, paddock_id, product_id, applied_on, tonnes, treated_ha, source, created_by_email) values ($1, $2, $3, $4, $5, $6, $7, $8)",
    [plan.id, input.paddockId, input.productId, input.appliedOn, input.tonnes, toFixedString(dec(treated), 2), input.source, tx.actor.email],
  );
}

/** Records fertiliser applied to a paddock (FB4). Treated ha default to its effective area. Posts nothing. */
export async function recordApplication(
  tx: OrgTx,
  planIdInput: unknown,
  input: { paddockId: unknown; productId: unknown; appliedOn: unknown; tonnes: unknown; treatedHa?: unknown },
): Promise<PlanReport> {
  const plan = await requirePlan(tx, planIdInput);
  await insertApplication(tx, plan, {
    paddockId: requireId(input.paddockId, "paddockId"),
    productId: requireId(input.productId, "productId"),
    appliedOn: parseIsoDate(input.appliedOn, "Applied on"),
    tonnes: parseDecimalInput(input.tonnes, "Tonnes", { maxScale: 3 }),
    treatedHa: input.treatedHa === undefined || input.treatedHa === null || input.treatedHa === "" ? null : parseDecimalInput(input.treatedHa, "Treated ha", { maxScale: 2 }),
    source: "Entered in Tohyee",
  });
  await writeAuditEvent(tx, { eventType: "farming.fertiliser_applied", entityType: "fertiliser_plan", entityId: plan.id, details: {} });
  return getPlanReport(tx, plan.id);
}

export async function removeApplication(tx: OrgTx, idInput: unknown): Promise<PlanReport> {
  await requireFarming(tx);
  const id = requireId(idInput, "applicationId");
  // Removing it would move its share of a spreading bill onto the other paddocks without anyone choosing that.
  const spread = await tx.query("select 1 from fertiliser_spreading where application_id = $1", [id]);
  if (spread.rowCount) throw new ConflictError("A spreading bill is linked to this application. Unlink the spreading first.");
  const row = await tx.query<{ plan_id: string }>("update fertiliser_applications set status = 'removed' where id = $1 and status = 'active' returning plan_id::text", [id]);
  if (!row.rows[0]) throw new NotFoundError("That application wasn't found.");
  await writeAuditEvent(tx, { eventType: "farming.fertiliser_application_removed", entityType: "fertiliser_plan", entityId: row.rows[0].plan_id, details: { applicationId: id } });
  return getPlanReport(tx, row.rows[0].plan_id);
}

/** Unlinks a spreading bill line from all the applications it covered. */
export async function unlinkSpreading(tx: OrgTx, planIdInput: unknown, input: { billLineId: unknown }): Promise<PlanReport> {
  const plan = await requirePlan(tx, planIdInput);
  const billLineId = requireId(input.billLineId, "billLineId");
  await tx.query("delete from fertiliser_spreading s using fertiliser_applications a where s.application_id = a.id and a.plan_id = $1 and s.bill_line_id = $2", [plan.id, billLineId]);
  await writeAuditEvent(tx, { eventType: "farming.spreading_unlinked", entityType: "fertiliser_plan", entityId: plan.id, details: { billLineId } });
  return getPlanReport(tx, plan.id);
}

/** Links a spreading bill line to the applications it covered (FB5); it's shared by their hectares for reports. */
export async function linkSpreading(tx: OrgTx, planIdInput: unknown, input: { billLineId: unknown; applicationIds: unknown }): Promise<PlanReport> {
  const plan = await requirePlan(tx, planIdInput);
  const line = await findBillLine(tx, input.billLineId);
  const ids = [...new Set(requireArray(input.applicationIds, "applicationIds", 500).map((id) => requireId(id, "applicationId")))];
  if (ids.length === 0) throw new ValidationError("Choose the applications the spreading covered.");
  const taken = await tx.query("select 1 from fertiliser_purchases where bill_line_id = $1 union all select 1 from fertiliser_spreading where bill_line_id = $1", [line.id]);
  if (taken.rowCount) throw new ConflictError("That bill line is already linked.");
  const found = await tx.query<{ id: string }>("select id::text from fertiliser_applications where id = any($1::bigint[]) and plan_id = $2 and status = 'active'", [ids, plan.id]);
  if (found.rows.length !== ids.length) throw new ValidationError("Each application must be on this plan.");
  for (const id of ids) await tx.query("insert into fertiliser_spreading (bill_line_id, application_id) values ($1, $2)", [line.id, id]);
  await writeAuditEvent(tx, { eventType: "farming.spreading_linked", entityType: "fertiliser_plan", entityId: plan.id, details: { billLineId: line.id, applications: ids.length } });
  return getPlanReport(tx, plan.id);
}

// Importing applications ----------------------------------------------------------------------------

export type ApplicationImportRow = { line: number; paddock: string; product: string; appliedOn: string | null; tonnes: string | null; treatedHa: string | null; error: string | null };
export type ApplicationImportPreview = { fileName: string; sha256: string; alreadyImportedOn: string | null; rows: ApplicationImportRow[]; valid: number; errors: number };

const COLUMNS = { paddock: ["paddock", "paddock name"], product: ["product", "fertiliser"], date: ["date", "applied on", "applied"], tonnes: ["tonnes", "t", "quantity (t)"], treated: ["treated ha", "ha", "hectares", "area"] };

async function readApplications(tx: OrgTx, plan: { id: string; farm_id: string }, input: { fileName: unknown; content: unknown }) {
  const fileName = requireString(input.fileName, "File name", { maxLength: 200 });
  if (typeof input.content !== "string" || !input.content.trim()) throw new ValidationError("Choose a CSV file.");
  const table = parseDelimited(input.content);
  if (table.length < 2) throw new ValidationError("The file needs a heading row and at least one application.");
  const headings = table[0].map((cell) => cell.trim().toLowerCase());
  const column = (names: string[]) => headings.findIndex((heading) => names.includes(heading));
  const at = { paddock: column(COLUMNS.paddock), product: column(COLUMNS.product), date: column(COLUMNS.date), tonnes: column(COLUMNS.tonnes), treated: column(COLUMNS.treated) };
  const missing = (["paddock", "product", "date", "tonnes"] as const).filter((key) => at[key] < 0);
  if (missing.length) throw new ValidationError(`The file needs columns for ${missing.join(", ")} (headings like Paddock, Product, Date, Tonnes and optionally Treated ha).`);
  const paddocks = await tx.query<{ id: string; name: string }>("select id::text, name from paddocks where farm_id = $1 and status = 'active'", [plan.farm_id]);
  const products = await tx.query<{ id: string; name: string }>("select id::text, name from fertiliser_products");
  const sha256 = createHash("sha256").update(input.content).digest("hex");
  const earlier = await tx.query<{ created_at: string }>("select created_at::text from farm_imports where farm_id = $1 and kind = 'fertiliser_applications' and sha256 = $2", [plan.farm_id, sha256]);
  const rows: Array<ApplicationImportRow & { paddockId: string | null; productId: string | null }> = table.slice(1).filter((cells) => cells.some((cell) => cell.trim())).map((cells, index) => {
    const cell = (i: number) => (i >= 0 ? (cells[i] ?? "").trim() : "");
    const paddockName = cell(at.paddock);
    const productName = cell(at.product);
    const paddock = paddocks.rows.find((row) => row.name.toLowerCase() === paddockName.toLowerCase());
    const product = products.rows.find((row) => row.name.toLowerCase() === productName.toLowerCase());
    let error: string | null = null;
    let appliedOn: string | null = null;
    let tonnes: string | null = null;
    let treatedHa: string | null = null;
    try {
      appliedOn = parseIsoDate(cell(at.date), "Date");
      tonnes = parseDecimalInput(cell(at.tonnes), "Tonnes", { maxScale: 3 });
      treatedHa = cell(at.treated) ? parseDecimalInput(cell(at.treated), "Treated ha", { maxScale: 2 }) : null;
    } catch (caught) {
      error = caught instanceof Error ? caught.message : "That row can't be read.";
    }
    if (!error && !paddock) error = `There's no current paddock ${paddockName || "(blank)"} on this farm.`;
    if (!error && !product) error = `There's no product ${productName || "(blank)"}.`;
    return { line: index + 2, paddock: paddockName, product: productName, appliedOn, tonnes, treatedHa, error, paddockId: paddock?.id ?? null, productId: product?.id ?? null };
  });
  return { fileName, sha256, alreadyImportedOn: earlier.rows[0]?.created_at ?? null, rows };
}

/** What importing a CSV of applications would do, before anything is saved (FB8). */
export async function previewApplicationImport(tx: OrgTx, planIdInput: unknown, input: { fileName: unknown; content: unknown }): Promise<ApplicationImportPreview> {
  const plan = await requirePlan(tx, planIdInput);
  const read = await readApplications(tx, plan, input);
  const rows: ApplicationImportRow[] = read.rows.map((row) => ({
    line: row.line,
    paddock: row.paddock,
    product: row.product,
    appliedOn: row.appliedOn,
    tonnes: row.tonnes,
    treatedHa: row.treatedHa,
    error: row.error,
  }));
  return { fileName: read.fileName, sha256: read.sha256, alreadyImportedOn: read.alreadyImportedOn, rows, valid: rows.filter((row) => !row.error).length, errors: rows.filter((row) => row.error).length };
}

/** Imports the rows without errors. The same file twice adds nothing (FB8). */
export async function importApplications(tx: OrgTx, planIdInput: unknown, input: { fileName: unknown; content: unknown }): Promise<PlanReport> {
  const plan = await requirePlan(tx, planIdInput);
  await tx.query("select 1 from fertiliser_plans where id = $1 for update", [plan.id]);
  const read = await readApplications(tx, plan, input);
  if (read.alreadyImportedOn) throw new ConflictError(`This file was already imported on ${read.alreadyImportedOn.slice(0, 10)}.`);
  const good = read.rows.filter((row) => !row.error);
  if (good.length === 0) throw new ValidationError("There are no rows without errors to import.");
  for (const row of good) {
    await insertApplication(tx, plan, { paddockId: row.paddockId!, productId: row.productId!, appliedOn: row.appliedOn!, tonnes: row.tonnes!, treatedHa: row.treatedHa, source: `Imported from ${read.fileName}` }, `Line ${row.line}: `);
  }
  await tx.query("insert into farm_imports (farm_id, kind, file_name, sha256, summary, created_by_email) values ($1, 'fertiliser_applications', $2, $3, $4::jsonb, $5)", [
    plan.farm_id,
    read.fileName,
    read.sha256,
    JSON.stringify({ imported: good.length, skipped: read.rows.length - good.length }),
    tx.actor.email,
  ]);
  await writeAuditEvent(tx, { eventType: "farming.fertiliser_applications_imported", entityType: "fertiliser_plan", entityId: plan.id, details: { fileName: read.fileName, imported: good.length } });
  return getPlanReport(tx, plan.id);
}

// The plan and its actuals (FB2-FB6) ------------------------------------------------------------

export type PlanLine = {
  paddockId: string;
  paddockName: string;
  productId: string;
  productName: string;
  rateKgHa: string;
  treatedHa: string;
  tonnes: string;
  nKgHa: string;
  nKg: string;
  pricePerTonne: string | null;
  productCost: string | null;
  spreadingCost: string | null;
};

export type PlanVersion = {
  version: number;
  note: string | null;
  spreadingPerHa: string | null;
  createdAt: string;
  createdByEmail: string;
  lines: PlanLine[];
  totals: { tonnes: string; nKg: string; productCost: string; spreadingCost: string; total: string };
};

export type ApplicationRow = {
  id: string;
  paddockId: string;
  paddockName: string;
  productId: string;
  productName: string;
  appliedOn: string;
  tonnes: string;
  treatedHa: string;
  kgHa: string;
  nKgHa: string;
  productCost: string | null;
  /** Costed at the plan's quoted price, not a linked bill (FB4, FB8). */
  quoted: boolean;
  spreadingCost: string;
  source: string;
};

export type ProductActual = {
  productId: string;
  productName: string;
  plannedTonnes: string;
  boughtTonnes: string;
  appliedTonnes: string;
  plannedCost: string;
  /** What the linked bills expensed. */
  expensed: string;
  appliedCost: string;
  /** Bought but not yet applied, at the bills' average price. */
  notYetApplied: string;
  notYetAppliedTonnes: string;
};

export type PaddockActual = {
  paddockId: string;
  paddockName: string;
  plannedNKgHa: string | null;
  actualNKgHa: string;
  plannedCost: string | null;
  actualCost: string;
  actualPerHa: string;
};

export type PlanReport = {
  plan: { id: string; farmId: string; name: string };
  versions: PlanVersion[];
  purchases: Array<{ billLineId: string; productName: string; tonnes: string; net: string; billDate: string; supplier: string; voided: boolean }>;
  spreading: Array<{ billLineId: string; net: string; billDate: string; supplier: string; applications: number; voided: boolean }>;
  applications: ApplicationRow[];
  products: ProductActual[];
  paddocks: PaddockActual[];
  spreadingTotals: { planned: string; actual: string };
  warnings: string[];
};

const m2 = (value: Decimal) => toFixedString(value, 2);
const t3 = (value: Decimal) => toFixedString(value, 3);
const one = (value: Decimal) => toFixedString(value, 1);
const THOUSAND = dec("1000");
const HUNDRED = dec("100");

/** Shares `total` by `weights`, rounded to cents, with any rounding cent going to the largest share. */
function shareByWeight(total: Decimal, weights: Decimal[]): Decimal[] {
  const whole = sum(weights);
  if (cmp(whole, ZERO_DECIMAL) === 0) return weights.map(() => ZERO_DECIMAL);
  const shares = weights.map((weight) => divide(mul(total, weight), whole, 2));
  const left = sub(total, sum(shares));
  if (cmp(left, ZERO_DECIMAL) !== 0) {
    let largest = 0;
    weights.forEach((weight, index) => {
      if (cmp(weight, weights[largest]) > 0) largest = index;
    });
    shares[largest] = add(shares[largest], left);
  }
  return shares;
}

export async function getPlanReport(tx: OrgTx, planIdInput: unknown): Promise<PlanReport> {
  const plan = await requirePlan(tx, planIdInput);
  const products = new Map((await tx.query<{ id: string; name: string; n_pct: string }>("select id::text, name, n_pct::text from fertiliser_products")).rows.map((row) => [row.id, row]));
  const paddockNames = new Map(
    (await tx.query<{ id: string; name: string }>("select id::text, name from paddocks where farm_id = $1", [plan.farm_id])).rows.map((row) => [row.id, row.name]),
  );

  const versionRows = await tx.query<{ id: string; version: number; note: string | null; spreading_per_ha: string | null; created_at: string; created_by_email: string }>(
    "select id::text, version, note, spreading_per_ha::text, created_at::text, created_by_email from fertiliser_plan_versions where plan_id = $1 order by version desc",
    [plan.id],
  );
  const versions: PlanVersion[] = [];
  for (const version of versionRows.rows) {
    const lineRows = await tx.query<{ paddock_id: string; product_id: string; rate_kg_ha: string; treated_ha: string; price_per_tonne: string | null }>(
      "select paddock_id::text, product_id::text, rate_kg_ha::text, treated_ha::text, price_per_tonne::text from fertiliser_plan_lines where version_id = $1 order by fertiliser_plan_lines.id",
      [version.id],
    );
    const lines: PlanLine[] = lineRows.rows.map((row) => {
      const product = products.get(row.product_id)!;
      const tonnes = divide(mul(dec(row.treated_ha), dec(row.rate_kg_ha)), THOUSAND, 3);
      const nKgHa = divide(mul(dec(row.rate_kg_ha), dec(product.n_pct)), HUNDRED, 1);
      const nKg = divide(mul(mul(dec(row.treated_ha), dec(row.rate_kg_ha)), dec(product.n_pct)), HUNDRED, 1);
      const productCost = row.price_per_tonne === null ? null : divide(mul(tonnes, dec(row.price_per_tonne)), dec("1"), 2);
      const spreadingCost = version.spreading_per_ha === null ? null : divide(mul(dec(row.treated_ha), dec(version.spreading_per_ha)), dec("1"), 2);
      return {
        paddockId: row.paddock_id,
        paddockName: paddockNames.get(row.paddock_id) ?? "",
        productId: row.product_id,
        productName: product.name,
        rateKgHa: m2(dec(row.rate_kg_ha)),
        treatedHa: m2(dec(row.treated_ha)),
        tonnes: t3(tonnes),
        nKgHa: one(nKgHa),
        nKg: one(nKg),
        pricePerTonne: row.price_per_tonne === null ? null : m2(dec(row.price_per_tonne)),
        productCost: productCost === null ? null : m2(productCost),
        spreadingCost: spreadingCost === null ? null : m2(spreadingCost),
      };
    });
    // Spreading is quoted on the hectares spread: each paddock once, however many products go on it.
    const spreadHa = sum([...new Map(lines.map((line) => [line.paddockId, dec(line.treatedHa)])).values()]);
    const spreadingCost = version.spreading_per_ha === null ? ZERO_DECIMAL : divide(mul(spreadHa, dec(version.spreading_per_ha)), dec("1"), 2);
    const productCost = sum(lines.map((line) => dec(line.productCost ?? "0")));
    versions.push({
      version: version.version,
      note: version.note,
      spreadingPerHa: version.spreading_per_ha === null ? null : m2(dec(version.spreading_per_ha)),
      createdAt: version.created_at,
      createdByEmail: version.created_by_email,
      lines,
      totals: {
        tonnes: t3(sum(lines.map((line) => dec(line.tonnes)))),
        nKg: one(sum(lines.map((line) => dec(line.nKg)))),
        productCost: m2(productCost),
        spreadingCost: m2(spreadingCost),
        total: m2(add(productCost, spreadingCost)),
      },
    });
  }
  const latest = versions[0] ?? null;

  const purchaseRows = await tx.query<{ bill_line_id: string; product_id: string; tonnes: string; net: string; bill_date: string; supplier: string; voided: boolean }>(
    `select p.bill_line_id::text, p.product_id::text, p.tonnes::text, coalesce(l.base_net_amount, l.net_amount)::text as net, b.bill_date::text, c.name as supplier, b.status = 'voided' as voided
       from fertiliser_purchases p join bill_lines l on l.id = p.bill_line_id join bills b on b.id = l.bill_id join contacts c on c.id = b.contact_id
      where p.plan_id = $1 order by b.bill_date, p.id`,
    [plan.id],
  );
  const appRows = await tx.query<{ id: string; paddock_id: string; product_id: string; applied_on: string; tonnes: string; treated_ha: string; source: string }>(
    "select id::text, paddock_id::text, product_id::text, applied_on::text, tonnes::text, treated_ha::text, source from fertiliser_applications where plan_id = $1 and status = 'active' order by applied_on, fertiliser_applications.id",
    [plan.id],
  );
  const spreadRows = await tx.query<{ bill_line_id: string; application_id: string; net: string; bill_date: string; supplier: string; voided: boolean }>(
    `select s.bill_line_id::text, s.application_id::text, coalesce(l.base_net_amount, l.net_amount)::text as net, b.bill_date::text, c.name as supplier, b.status = 'voided' as voided
       from fertiliser_spreading s join bill_lines l on l.id = s.bill_line_id join bills b on b.id = l.bill_id join contacts c on c.id = b.contact_id
       join fertiliser_applications a on a.id = s.application_id and a.plan_id = $1 and a.status = 'active'
      order by s.bill_line_id, s.application_id`,
    [plan.id],
  );

  const warnings: string[] = [];
  const livePurchases = purchaseRows.rows.filter((row) => !row.voided);
  // Product cost for each application: the linked bills' average price, in date order; beyond what was bought, the quoted price (FB8).
  const applicationCost = new Map<string, { cost: Decimal | null; quoted: boolean }>();
  const productIds = [...new Set([...appRows.rows.map((row) => row.product_id), ...livePurchases.map((row) => row.product_id), ...(latest?.lines.map((line) => line.productId) ?? [])])];
  const productActuals: ProductActual[] = [];
  for (const productId of productIds) {
    const bought = livePurchases.filter((row) => row.product_id === productId);
    const boughtTonnes = sum(bought.map((row) => dec(row.tonnes)));
    const expensed = sum(bought.map((row) => dec(row.net)));
    const average = cmp(boughtTonnes, ZERO_DECIMAL) > 0 ? divide(expensed, boughtTonnes, 6) : null;
    let remaining = boughtTonnes;
    let appliedTonnes = ZERO_DECIMAL;
    let appliedCost = ZERO_DECIMAL;
    for (const app of appRows.rows.filter((row) => row.product_id === productId)) {
      const tonnes = dec(app.tonnes);
      appliedTonnes = add(appliedTonnes, tonnes);
      const fromBills = cmp(remaining, tonnes) >= 0 ? tonnes : remaining;
      const extra = sub(tonnes, fromBills);
      remaining = sub(remaining, fromBills);
      const quotedPrice = latest?.lines.find((line) => line.productId === productId && line.paddockId === app.paddock_id)?.pricePerTonne ?? latest?.lines.find((line) => line.productId === productId)?.pricePerTonne ?? null;
      let cost: Decimal | null = average ? divide(mul(fromBills, average), dec("1"), 2) : ZERO_DECIMAL;
      const quoted = cmp(extra, ZERO_DECIMAL) > 0;
      if (quoted) {
        if (quotedPrice === null) cost = null;
        else cost = add(cost ?? ZERO_DECIMAL, divide(mul(extra, dec(quotedPrice)), dec("1"), 2));
      }
      if (cost) appliedCost = add(appliedCost, cost);
      applicationCost.set(app.id, { cost, quoted });
    }
    const name = products.get(productId)?.name ?? "";
    if (cmp(appliedTonnes, boughtTonnes) > 0 && bought.length > 0) {
      warnings.push(`${t3(sub(appliedTonnes, boughtTonnes))} t more ${name} was applied than the linked bills bought. It may have come from earlier purchases; it's costed at the quoted price.`);
    }
    const notYetTonnes = cmp(boughtTonnes, appliedTonnes) > 0 ? sub(boughtTonnes, appliedTonnes) : ZERO_DECIMAL;
    const plannedLines = latest?.lines.filter((line) => line.productId === productId) ?? [];
    productActuals.push({
      productId,
      productName: name,
      plannedTonnes: t3(sum(plannedLines.map((line) => dec(line.tonnes)))),
      boughtTonnes: t3(boughtTonnes),
      appliedTonnes: t3(appliedTonnes),
      plannedCost: m2(sum(plannedLines.map((line) => dec(line.productCost ?? "0")))),
      expensed: m2(expensed),
      appliedCost: m2(appliedCost),
      notYetApplied: average ? m2(divide(mul(notYetTonnes, average), dec("1"), 2)) : "0.00",
      notYetAppliedTonnes: t3(notYetTonnes),
    });
  }
  if (purchaseRows.rows.some((row) => row.voided)) warnings.push("A linked bill has been voided, so it's left out.");

  // Spreading shared by hectares across the applications each bill line covered (FB5).
  const spreadingShare = new Map<string, Decimal>();
  const spreadingByLine = new Map<string, typeof spreadRows.rows>();
  for (const row of spreadRows.rows.filter((entry) => !entry.voided)) spreadingByLine.set(row.bill_line_id, [...(spreadingByLine.get(row.bill_line_id) ?? []), row]);
  for (const rows of spreadingByLine.values()) {
    const apps = rows.map((row) => appRows.rows.find((app) => app.id === row.application_id)!);
    const shares = shareByWeight(dec(rows[0].net), apps.map((app) => dec(app.treated_ha)));
    apps.forEach((app, index) => spreadingShare.set(app.id, add(spreadingShare.get(app.id) ?? ZERO_DECIMAL, shares[index])));
  }

  const applications: ApplicationRow[] = appRows.rows.map((row) => {
    const product = products.get(row.product_id)!;
    const kgHa = divide(mul(dec(row.tonnes), THOUSAND), dec(row.treated_ha), 1);
    const nKgHa = divide(mul(mul(dec(row.tonnes), THOUSAND), dec(product.n_pct)), mul(dec(row.treated_ha), HUNDRED), 1);
    const cost = applicationCost.get(row.id);
    return {
      id: row.id,
      paddockId: row.paddock_id,
      paddockName: paddockNames.get(row.paddock_id) ?? "",
      productId: row.product_id,
      productName: product.name,
      appliedOn: row.applied_on,
      tonnes: t3(dec(row.tonnes)),
      treatedHa: m2(dec(row.treated_ha)),
      kgHa: one(kgHa),
      nKgHa: one(nKgHa),
      productCost: cost?.cost ? m2(cost.cost) : null,
      quoted: cost?.quoted ?? false,
      spreadingCost: m2(spreadingShare.get(row.id) ?? ZERO_DECIMAL),
      source: row.source,
    };
  });

  // Paddocks: planned against actual (FB6).
  const paddockIds = [...new Set([...(latest?.lines.map((line) => line.paddockId) ?? []), ...applications.map((app) => app.paddockId)])];
  const paddocks: PaddockActual[] = paddockIds.map((paddockId) => {
    const planned = latest?.lines.filter((line) => line.paddockId === paddockId) ?? [];
    const applied = applications.filter((app) => app.paddockId === paddockId);
    const plannedHa = planned[0] ? dec(planned[0].treatedHa) : null;
    const area = plannedHa ?? (applied.length ? applied.map((app) => dec(app.treatedHa)).reduce((a, b) => (cmp(a, b) >= 0 ? a : b)) : null);
    const actualCost = sum(applied.map((app) => add(dec(app.productCost ?? "0"), dec(app.spreadingCost))));
    const actualN = sum(applied.map((app) => mul(mul(dec(app.tonnes), THOUSAND), dec(products.get(app.productId)!.n_pct))));
    const plannedCost = planned.length && planned.every((line) => line.productCost !== null) ? sum(planned.map((line) => add(dec(line.productCost!), ZERO_DECIMAL))) : null;
    const plannedSpreading = planned.length && latest?.spreadingPerHa ? divide(mul(plannedHa!, dec(latest.spreadingPerHa)), dec("1"), 2) : ZERO_DECIMAL;
    return {
      paddockId,
      paddockName: paddockNames.get(paddockId) ?? "",
      plannedNKgHa: planned.length ? one(sum(planned.map((line) => dec(line.nKgHa)))) : null,
      actualNKgHa: area ? one(divide(actualN, mul(area, HUNDRED), 1)) : "0.0",
      plannedCost: plannedCost === null ? null : m2(add(plannedCost, plannedSpreading)),
      actualCost: m2(actualCost),
      actualPerHa: area ? m2(divide(actualCost, area, 2)) : "0.00",
    };
  });
  paddocks.sort((a, b) => a.paddockName.localeCompare(b.paddockName, "en-NZ", { numeric: true }));

  const spreadingLines = [...new Map(spreadRows.rows.map((row) => [row.bill_line_id, row])).values()];
  return {
    plan: { id: plan.id, farmId: plan.farm_id, name: plan.name },
    versions,
    purchases: purchaseRows.rows.map((row) => ({
      billLineId: row.bill_line_id,
      productName: products.get(row.product_id)?.name ?? "",
      tonnes: t3(dec(row.tonnes)),
      net: m2(dec(row.net)),
      billDate: row.bill_date,
      supplier: row.supplier,
      voided: row.voided,
    })),
    spreading: spreadingLines.map((row) => ({
      billLineId: row.bill_line_id,
      net: m2(dec(row.net)),
      billDate: row.bill_date,
      supplier: row.supplier,
      applications: spreadRows.rows.filter((entry) => entry.bill_line_id === row.bill_line_id).length,
      voided: row.voided,
    })),
    applications,
    products: productActuals,
    paddocks,
    spreadingTotals: { planned: latest?.totals.spreadingCost ?? "0.00", actual: m2(sum(spreadingLines.filter((row) => !row.voided).map((row) => dec(row.net)))) },
    warnings,
  };
}
