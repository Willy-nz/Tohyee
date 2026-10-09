import { parseAccountCodeInput } from "@/lib/accounts/service";
import type { AccountClass, AccountType } from "@/lib/accounts/types";
import { writeAuditEvent } from "@/lib/audit";
import { billLineAccountProblem } from "@/lib/bills/accounts";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { assertSameRequest, requestHash } from "@/lib/idempotency";
import { ITEM_TYPES, type ItemType, UNIT_FACTOR_SCALE } from "@/lib/items/pricing";
import { cmp, dec, parseDecimalInput, toPlainString } from "@/lib/money/decimal";
import { type AvailableOn, isAvailableOn, onlyWords } from "@/lib/tax/available-on";
import { advancedFeaturesOn } from "@/lib/tracking/service";
import {
  asRecord,
  optionalBoolean,
  optionalId,
  optionalSource,
  optionalString,
  requireArray,
  requireId,
  requireIdempotencyKey,
  requireOneOf,
  requireString,
} from "@/lib/validation";

/**
 * Products and services (examples IT1-IT9), like Xero's items, with
 * NetSuite's extras while Advanced reporting is on: units of measure, prices
 * for price levels, supplier prices and kits. Items are archived, never
 * deleted. Picking an item on a line fills it in (`@/lib/items/lines`).
 */

export const ITEM_CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,49}$/;
/** Item prices allow up to 4 decimal places, like line unit prices. */
export const ITEM_PRICE_SCALE = 4;

export type ItemUnit = { id: string; name: string; factor: string; isActive: boolean };
export type ItemLevelPrice = { priceLevelId: string; priceLevelName: string; price: string };
export type ItemSupplier = {
  contactId: string;
  contactName: string;
  price: string | null;
  supplierItemCode: string | null;
  isPreferred: boolean;
};
export type KitComponent = { itemId: string; code: string; name: string; itemType: ItemType; baseUnit: string; quantity: string };

export type Item = {
  id: string;
  code: string;
  name: string;
  description: string | null;
  itemType: ItemType;
  /** What quantities are counted in, e.g. "each" or "kg". */
  baseUnit: string;
  /** Excluding GST, for the base unit. */
  salePrice: string | null;
  purchasePrice: string | null;
  incomeAccountCode: string | null;
  purchaseAccountCode: string | null;
  salesTaxCode: string | null;
  purchaseTaxCode: string | null;
  /** The unit sales and purchases start in; null is the base unit. */
  saleUnitId: string | null;
  purchaseUnitId: string | null;
  isActive: boolean;
  units: ItemUnit[];
  levelPrices: ItemLevelPrice[];
  suppliers: ItemSupplier[];
  components: KitComponent[];
};

export type ItemInput = {
  code?: unknown;
  name?: unknown;
  description?: unknown;
  itemType?: unknown;
  baseUnit?: unknown;
  salePrice?: unknown;
  purchasePrice?: unknown;
  incomeAccountCode?: unknown;
  purchaseAccountCode?: unknown;
  salesTaxCode?: unknown;
  purchaseTaxCode?: unknown;
  saleUnitId?: unknown;
  purchaseUnitId?: unknown;
  isActive?: unknown;
  levelPrices?: unknown;
  suppliers?: unknown;
  components?: unknown;
};

type ItemRow = {
  id: string;
  request_hash: string;
  code: string;
  name: string;
  description: string | null;
  item_type: ItemType;
  base_unit: string;
  sale_price: string | null;
  purchase_price: string | null;
  income_account_code: string | null;
  purchase_account_code: string | null;
  sales_tax_code: string | null;
  purchase_tax_code: string | null;
  sale_unit_id: string | null;
  purchase_unit_id: string | null;
  is_active: boolean;
};

const ITEM_SELECT = `
  select i.id, i.request_hash, i.code, i.name, i.description, i.item_type, i.base_unit,
         i.sale_price::text, i.purchase_price::text, ia.code as income_account_code, pa.code as purchase_account_code,
         st.code as sales_tax_code, pt.code as purchase_tax_code, i.sale_unit_id, i.purchase_unit_id, i.is_active
    from items i
    left join accounts ia on ia.id = i.income_account_id
    left join accounts pa on pa.id = i.purchase_account_id
    left join tax_codes st on st.id = i.sales_tax_code_id
    left join tax_codes pt on pt.id = i.purchase_tax_code_id`;

const plainOrNull = (value: string | null) => (value === null ? null : toPlainString(dec(value)));

async function loadItems(tx: OrgTx, where: string, values: unknown[]): Promise<Array<Item & { requestHash: string }>> {
  const rows = await tx.query<ItemRow>(`${ITEM_SELECT} ${where}`, values);
  if (rows.rows.length === 0) return [];
  const ids = rows.rows.map((row) => row.id);
  const units = await tx.query<{ id: string; item_id: string; name: string; factor: string; is_active: boolean }>(
    "select id, item_id, name, factor::text, is_active from item_units where item_id = any($1::bigint[]) order by item_units.factor, item_units.id",
    [ids],
  );
  const prices = await tx.query<{ item_id: string; price_level_id: string; name: string; price: string }>(
    `select p.item_id, p.price_level_id, l.name, p.price::text from item_level_prices p join price_levels l on l.id = p.price_level_id
      where p.item_id = any($1::bigint[]) order by lower(l.name)`,
    [ids],
  );
  const suppliers = await tx.query<{
    item_id: string;
    contact_id: string;
    name: string;
    price: string | null;
    supplier_item_code: string | null;
    is_preferred: boolean;
  }>(
    `select s.item_id, s.contact_id, c.name, s.price::text, s.supplier_item_code, s.is_preferred
       from item_suppliers s join contacts c on c.id = s.contact_id
      where s.item_id = any($1::bigint[]) order by s.is_preferred desc, lower(c.name)`,
    [ids],
  );
  const components = await tx.query<{ kit_item_id: string; id: string; code: string; name: string; item_type: ItemType; base_unit: string; quantity: string }>(
    `select k.kit_item_id, i.id, i.code, i.name, i.item_type, i.base_unit, k.quantity::text
       from kit_components k join items i on i.id = k.component_item_id
      where k.kit_item_id = any($1::bigint[]) order by lower(i.code)`,
    [ids],
  );
  return rows.rows.map((row) => ({
    id: row.id,
    requestHash: row.request_hash,
    code: row.code,
    name: row.name,
    description: row.description,
    itemType: row.item_type,
    baseUnit: row.base_unit,
    salePrice: plainOrNull(row.sale_price),
    purchasePrice: plainOrNull(row.purchase_price),
    incomeAccountCode: row.income_account_code,
    purchaseAccountCode: row.purchase_account_code,
    salesTaxCode: row.sales_tax_code,
    purchaseTaxCode: row.purchase_tax_code,
    saleUnitId: row.sale_unit_id,
    purchaseUnitId: row.purchase_unit_id,
    isActive: row.is_active,
    units: units.rows
      .filter((unit) => unit.item_id === row.id)
      .map((unit) => ({ id: unit.id, name: unit.name, factor: toPlainString(dec(unit.factor)), isActive: unit.is_active })),
    levelPrices: prices.rows
      .filter((price) => price.item_id === row.id)
      .map((price) => ({ priceLevelId: price.price_level_id, priceLevelName: price.name, price: toPlainString(dec(price.price)) })),
    suppliers: suppliers.rows
      .filter((supplier) => supplier.item_id === row.id)
      .map((supplier) => ({
        contactId: supplier.contact_id,
        contactName: supplier.name,
        price: plainOrNull(supplier.price),
        supplierItemCode: supplier.supplier_item_code,
        isPreferred: supplier.is_preferred,
      })),
    components: components.rows
      .filter((component) => component.kit_item_id === row.id)
      .map((component) => ({
        itemId: component.id,
        code: component.code,
        name: component.name,
        itemType: component.item_type,
        baseUnit: component.base_unit,
        quantity: toPlainString(dec(component.quantity)),
      })),
  }));
}

function publicItem(item: Item & { requestHash?: string }): Item {
  const rest: Item & { requestHash?: string } = { ...item };
  delete rest.requestHash;
  return rest;
}

export async function getItem(tx: OrgTx, itemIdInput: unknown): Promise<Item> {
  const id = requireId(itemIdInput, "itemId");
  const [item] = await loadItems(tx, "where i.id = $1", [id]);
  if (!item) throw new NotFoundError("Item not found.");
  return publicItem(item);
}

export type ItemList = { advancedFeatures: boolean; items: Item[] };

/** Every item (active only unless `includeArchived`), by code; `search` matches the code or name. */
export async function listItems(tx: OrgTx, filters: { includeArchived?: unknown; search?: unknown } = {}): Promise<ItemList> {
  const includeArchived = optionalBoolean(filters.includeArchived, "includeArchived") ?? false;
  const search = optionalString(filters.search, "search", { maxLength: 100 });
  const items = await loadItems(
    tx,
    `where ($1::boolean or i.is_active)
       and ($2::text is null or i.code ilike '%' || $2 || '%' or i.name ilike '%' || $2 || '%')
     order by lower(i.code)`,
    [includeArchived, search],
  );
  return { advancedFeatures: await advancedFeaturesOn(tx), items: items.map(publicItem) };
}

// ---------------------------------------------------------------------------
// Parsing

type ParsedItem = {
  code: string;
  name: string;
  description: string | null;
  itemType: ItemType;
  baseUnit: string;
  salePrice: string | null;
  purchasePrice: string | null;
  incomeAccountCode: string | null;
  purchaseAccountCode: string | null;
  salesTaxCode: string | null;
  purchaseTaxCode: string | null;
  saleUnitId: string | null;
  purchaseUnitId: string | null;
  isActive: boolean;
  /** Undefined: not sent (kept as they are). */
  levelPrices: Array<{ priceLevelId: string; price: string }> | undefined;
  suppliers: Array<{ contactId: string; price: string | null; supplierItemCode: string | null; isPreferred: boolean }> | undefined;
  components: Array<{ itemId: string; quantity: string }> | undefined;
};

function blank(input: unknown): boolean {
  return input === null || input === undefined || (typeof input === "string" && input.trim() === "");
}

function optionalPrice(input: unknown, field: string): string | null {
  return blank(input) ? null : parseDecimalInput(input, field, { maxScale: ITEM_PRICE_SCALE });
}

function optionalAccount(input: unknown, field: string): string | null {
  return blank(input) ? null : parseAccountCodeInput(input, field);
}

function optionalTaxCode(input: unknown, field: string): string | null {
  return optionalString(input, field, { maxLength: 20 })?.toUpperCase() ?? null;
}

function parseUnitName(input: unknown, field: string): string {
  const name = requireString(input, field, { maxLength: 30 }).replace(/\s+/g, " ");
  return name;
}

function parseLevelPrices(input: unknown): ParsedItem["levelPrices"] {
  if (input === undefined) return undefined;
  if (input === null) return [];
  const seen = new Set<string>();
  return requireArray(input, "levelPrices", 100).map((raw, index) => {
    const entry = asRecord(raw, `Price level ${index + 1}`);
    const priceLevelId = requireId(entry.priceLevelId, `Price level ${index + 1}`);
    if (seen.has(priceLevelId)) throw new ValidationError("Each price level can have only one price.");
    seen.add(priceLevelId);
    return { priceLevelId, price: parseDecimalInput(entry.price, `Price level ${index + 1} price`, { maxScale: ITEM_PRICE_SCALE }) };
  });
}

function parseSuppliers(input: unknown): ParsedItem["suppliers"] {
  if (input === undefined) return undefined;
  if (input === null) return [];
  const seen = new Set<string>();
  const suppliers = requireArray(input, "suppliers", 50).map((raw, index) => {
    const entry = asRecord(raw, `Supplier ${index + 1}`);
    const contactId = requireId(entry.contactId, `Supplier ${index + 1}`);
    if (seen.has(contactId)) throw new ValidationError("Each supplier can be listed only once.");
    seen.add(contactId);
    return {
      contactId,
      price: optionalPrice(entry.price, `Supplier ${index + 1} price`),
      supplierItemCode: optionalString(entry.supplierItemCode, `Supplier ${index + 1} item code`, { maxLength: 50 }),
      isPreferred: optionalBoolean(entry.isPreferred, "isPreferred") ?? false,
    };
  });
  if (suppliers.filter((supplier) => supplier.isPreferred).length > 1) {
    throw new ValidationError("Only one supplier can be preferred.");
  }
  return suppliers;
}

function parseComponents(input: unknown): ParsedItem["components"] {
  if (input === undefined) return undefined;
  if (input === null) return [];
  const seen = new Set<string>();
  return requireArray(input, "components", 50).map((raw, index) => {
    const entry = asRecord(raw, `Component ${index + 1}`);
    const itemId = requireId(entry.itemId, `Component ${index + 1}`);
    if (seen.has(itemId)) throw new ValidationError("Each item can be in a kit only once; change its quantity instead.");
    seen.add(itemId);
    return { itemId, quantity: parseDecimalInput(entry.quantity, `Component ${index + 1} quantity`, { maxScale: UNIT_FACTOR_SCALE }) };
  });
}

function parseItem(input: ItemInput, current: Item | null): ParsedItem {
  const pick = <T>(value: unknown, fallback: T, parse: (value: unknown) => T): T => (value === undefined ? fallback : parse(value));
  return {
    code: pick(input.code, current?.code ?? "", (value) =>
      requireString(value, "code", {
        maxLength: 50,
        pattern: ITEM_CODE_PATTERN,
        patternHint: "The code must be 1-50 letters, numbers, dots, dashes, slashes or underscores, starting with a letter or number.",
      }),
    ),
    name: pick(input.name, current?.name ?? "", (value) => requireString(value, "name", { maxLength: 150 })),
    description: pick(input.description, current?.description ?? null, (value) => optionalString(value, "description", { maxLength: 500 })),
    itemType: pick(input.itemType, current?.itemType ?? ("service" as ItemType), (value) => requireOneOf(value, "itemType", ITEM_TYPES)),
    baseUnit: pick(input.baseUnit, current?.baseUnit ?? "each", (value) => (blank(value) ? "each" : parseUnitName(value, "baseUnit"))),
    salePrice: pick(input.salePrice, current?.salePrice ?? null, (value) => optionalPrice(value, "salePrice")),
    purchasePrice: pick(input.purchasePrice, current?.purchasePrice ?? null, (value) => optionalPrice(value, "purchasePrice")),
    incomeAccountCode: pick(input.incomeAccountCode, current?.incomeAccountCode ?? null, (value) => optionalAccount(value, "incomeAccountCode")),
    purchaseAccountCode: pick(input.purchaseAccountCode, current?.purchaseAccountCode ?? null, (value) => optionalAccount(value, "purchaseAccountCode")),
    salesTaxCode: pick(input.salesTaxCode, current?.salesTaxCode ?? null, (value) => optionalTaxCode(value, "salesTaxCode")),
    purchaseTaxCode: pick(input.purchaseTaxCode, current?.purchaseTaxCode ?? null, (value) => optionalTaxCode(value, "purchaseTaxCode")),
    saleUnitId: pick(input.saleUnitId, current?.saleUnitId ?? null, (value) => optionalId(value, "saleUnitId")),
    purchaseUnitId: pick(input.purchaseUnitId, current?.purchaseUnitId ?? null, (value) => optionalId(value, "purchaseUnitId")),
    isActive: pick(input.isActive, current?.isActive ?? true, (value) => {
      if (typeof value !== "boolean") throw new ValidationError("isActive must be true or false.");
      return value;
    }),
    levelPrices: parseLevelPrices(input.levelPrices),
    suppliers: parseSuppliers(input.suppliers),
    components: parseComponents(input.components),
  };
}

// ---------------------------------------------------------------------------
// Checking against the organisation's data

type ResolvedRefs = {
  incomeAccountId: string | null;
  purchaseAccountId: string | null;
  salesTaxCodeId: string | null;
  purchaseTaxCodeId: string | null;
};

async function resolveAccount(
  tx: OrgTx,
  code: string | null,
  side: "income" | "purchase",
  keptId: string | null,
): Promise<string | null> {
  if (code === null) return null;
  const found = await tx.query<{
    id: string;
    code: string;
    name: string;
    account_class: AccountClass;
    account_type: AccountType;
    system_key: string | null;
    currency_code: string | null;
    is_active: boolean;
  }>("select id, code, name, account_class, account_type, system_key, currency_code, is_active from accounts where lower(code) = lower($1)", [code]);
  const account = found.rows[0];
  if (!account) throw new ValidationError(`There's no account with the code ${code}.`);
  if (!account.is_active && account.id !== keptId) throw new ValidationError(`Account ${account.code} (${account.name}) is archived.`);
  if (side === "income") {
    if (account.account_class !== "revenue") {
      throw new ValidationError(`The income account ${account.code} (${account.name}) must be a revenue account, like Sales.`);
    }
    if (account.currency_code !== null && account.currency_code !== tx.baseCurrency) {
      throw new ValidationError(`The income account ${account.code} is in ${account.currency_code}, but invoices are in the base currency.`);
    }
    return account.id;
  }
  const problem = billLineAccountProblem({
    accountClass: account.account_class,
    accountType: account.account_type,
    systemKey: account.system_key,
    currencyCode: account.currency_code === tx.baseCurrency ? null : account.currency_code,
  });
  if (problem) throw new ValidationError(`The purchase account ${account.code} (${account.name}) is ${problem}`);
  return account.id;
}

/** An item's sales tax code is available on sales, its purchase tax code on purchases (TAO7); the database checks it too. */
async function resolveTaxCode(tx: OrgTx, code: string | null, keptId: string | null, side: "sales" | "purchases"): Promise<string | null> {
  if (code === null) return null;
  const found = await tx.query<{ id: string; code: string; is_active: boolean; available_on: AvailableOn }>(
    "select id, code, is_active, available_on from tax_codes where code = $1",
    [code],
  );
  const taxCode = found.rows[0];
  if (!taxCode) throw new ValidationError(`There's no tax code ${code}.`);
  if (!taxCode.is_active && taxCode.id !== keptId) throw new ValidationError(`Tax code ${taxCode.code} is inactive.`);
  if (!isAvailableOn(taxCode.available_on, side)) {
    const word = side === "sales" ? "sales" : "purchase";
    throw new ValidationError(
      `Tax code ${taxCode.code} is available on ${onlyWords(taxCode.available_on)}, so it can't be an item's ${word} tax code. Choose a code available on ${side}.`,
    );
  }
  return taxCode.id;
}

async function currentRefs(tx: OrgTx, itemId: string | null): Promise<ResolvedRefs> {
  if (itemId === null) return { incomeAccountId: null, purchaseAccountId: null, salesTaxCodeId: null, purchaseTaxCodeId: null };
  const found = await tx.query<{
    income_account_id: string | null;
    purchase_account_id: string | null;
    sales_tax_code_id: string | null;
    purchase_tax_code_id: string | null;
  }>("select income_account_id, purchase_account_id, sales_tax_code_id, purchase_tax_code_id from items where id = $1", [itemId]);
  const row = found.rows[0];
  return {
    incomeAccountId: row.income_account_id,
    purchaseAccountId: row.purchase_account_id,
    salesTaxCodeId: row.sales_tax_code_id,
    purchaseTaxCodeId: row.purchase_tax_code_id,
  };
}

/**
 * Units, level prices, supplier prices and kits are NetSuite's extras: they
 * can only be given new values while Advanced reporting is on (IT8). What an
 * item already has is kept when it's turned off.
 */
function assertAdvancedExtras(parsed: ParsedItem, current: Item | null, advanced: boolean): void {
  if (advanced) return;
  const refuse = (what: string) => {
    throw new ValidationError(`Advanced reporting is off, so ${what} can't be set. Turn it on in Settings › Modules.`);
  };
  if (parsed.itemType === "kit" && current?.itemType !== "kit") refuse("an item can't be made a kit, and kits");
  const sameList = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  if (parsed.levelPrices !== undefined && parsed.levelPrices.length > 0 &&
      !sameList(parsed.levelPrices, (current?.levelPrices ?? []).map((p) => ({ priceLevelId: p.priceLevelId, price: p.price })))) {
    refuse("prices for price levels");
  }
  if (parsed.suppliers !== undefined && parsed.suppliers.length > 0 &&
      !sameList(parsed.suppliers, (current?.suppliers ?? []).map((s) => ({ contactId: s.contactId, price: s.price, supplierItemCode: s.supplierItemCode, isPreferred: s.isPreferred })))) {
    refuse("supplier prices");
  }
  if ((parsed.saleUnitId !== null && parsed.saleUnitId !== (current?.saleUnitId ?? null)) ||
      (parsed.purchaseUnitId !== null && parsed.purchaseUnitId !== (current?.purchaseUnitId ?? null))) {
    refuse("sale and purchase units");
  }
}

async function checkUnits(tx: OrgTx, itemId: string | null, parsed: ParsedItem, current: Item | null): Promise<void> {
  for (const [field, unitId] of [["sale unit", parsed.saleUnitId], ["purchase unit", parsed.purchaseUnitId]] as const) {
    if (unitId === null) continue;
    const found = await tx.query<{ item_id: string; name: string; is_active: boolean }>("select item_id, name, is_active from item_units where id = $1", [unitId]);
    const unit = found.rows[0];
    if (!unit || unit.item_id !== itemId) throw new ValidationError(`The ${field} must be one of this item's units.`);
    const kept = field === "sale unit" ? current?.saleUnitId : current?.purchaseUnitId;
    if (!unit.is_active && kept !== unitId) throw new ValidationError(`${unit.name} is archived.`);
  }
}

async function saveLists(tx: OrgTx, itemId: string, parsed: ParsedItem, current: Item | null): Promise<void> {
  if (parsed.levelPrices !== undefined) {
    for (const entry of parsed.levelPrices) {
      const level = await tx.query<{ name: string; is_active: boolean }>("select name, is_active from price_levels where id = $1", [entry.priceLevelId]);
      if (!level.rows[0]) throw new ValidationError(`There's no price level #${entry.priceLevelId}.`);
      const had = current?.levelPrices.some((p) => p.priceLevelId === entry.priceLevelId);
      if (!level.rows[0].is_active && !had) throw new ValidationError(`${level.rows[0].name} is archived.`);
    }
    await tx.query("delete from item_level_prices where item_id = $1", [itemId]);
    for (const entry of parsed.levelPrices) {
      await tx.query("insert into item_level_prices (item_id, price_level_id, price) values ($1, $2, $3::numeric)", [itemId, entry.priceLevelId, entry.price]);
    }
  }
  if (parsed.suppliers !== undefined) {
    for (const entry of parsed.suppliers) {
      const contact = await tx.query<{ name: string; is_supplier: boolean; is_archived: boolean }>(
        "select name, is_supplier, is_archived from contacts where id = $1",
        [entry.contactId],
      );
      const row = contact.rows[0];
      if (!row) throw new ValidationError(`There's no contact #${entry.contactId}.`);
      if (!row.is_supplier) throw new ValidationError(`${row.name} isn't a supplier.`);
      const had = current?.suppliers.some((s) => s.contactId === entry.contactId);
      if (row.is_archived && !had) throw new ValidationError(`${row.name} is archived.`);
    }
    await tx.query("delete from item_suppliers where item_id = $1", [itemId]);
    for (const entry of parsed.suppliers) {
      await tx.query(
        "insert into item_suppliers (item_id, contact_id, price, supplier_item_code, is_preferred) values ($1, $2, $3::numeric, $4, $5)",
        [itemId, entry.contactId, entry.price, entry.supplierItemCode, entry.isPreferred],
      );
    }
  }
  if (parsed.components !== undefined) {
    if (parsed.itemType !== "kit" && parsed.components.length > 0) {
      throw new ValidationError("Only a kit has components.");
    }
    for (const entry of parsed.components) {
      if (entry.itemId === itemId) throw new ValidationError("A kit can't contain itself.");
      const component = await tx.query<{ code: string; item_type: ItemType; is_active: boolean }>(
        "select code, item_type, is_active from items where id = $1",
        [entry.itemId],
      );
      const row = component.rows[0];
      if (!row) throw new ValidationError(`There's no item #${entry.itemId}.`);
      // Kits inside kits would need their parts costed recursively; not supported (IT7).
      if (row.item_type === "kit") throw new ValidationError(`${row.code} is a kit. Kits can't be inside other kits; add its parts instead.`);
      const had = current?.components.some((c) => c.itemId === entry.itemId);
      if (!row.is_active && !had) throw new ValidationError(`${row.code} is archived.`);
    }
    await tx.query("delete from kit_components where kit_item_id = $1", [itemId]);
    for (const entry of parsed.components) {
      await tx.query("insert into kit_components (kit_item_id, component_item_id, quantity) values ($1, $2, $3::numeric)", [itemId, entry.itemId, entry.quantity]);
    }
  }
  if (parsed.itemType === "kit") {
    const count = await tx.query<{ count: string }>("select count(*)::text as count from kit_components where kit_item_id = $1", [itemId]);
    if (count.rows[0].count === "0") throw new ValidationError("A kit needs at least one component.");
  }
}

function databaseRule(error: unknown): ValidationError | null {
  const e = error as { code?: string; message?: string };
  return e.code === "P0001" && e.message ? new ValidationError(`${e.message}.`) : null;
}

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string }).code === "23505";
}

function hashOf(parsed: ParsedItem): string {
  return requestHash("item", { ...parsed, code: parsed.code, incomeAccountCode: parsed.incomeAccountCode?.toLowerCase() ?? null, purchaseAccountCode: parsed.purchaseAccountCode?.toLowerCase() ?? null });
}

/** Adds an item (IT1). Bookkeepers and up. */
export async function createItem(
  tx: OrgTx,
  input: ItemInput & { source?: unknown; idempotencyKey: unknown },
): Promise<{ created: boolean; item: Item }> {
  const source = optionalSource(input.source);
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  const parsed = parseItem(input, null);
  const hash = hashOf(parsed);
  const existing = await tx.query<{ id: string; request_hash: string }>(
    "select id, request_hash from items where command_source = $1 and idempotency_key = $2",
    [source, idempotencyKey],
  );
  if (existing.rows[0]) {
    assertSameRequest(existing.rows[0].request_hash, hash, "item");
    return { created: false, item: await getItem(tx, existing.rows[0].id) };
  }
  if (parsed.saleUnitId !== null || parsed.purchaseUnitId !== null) {
    throw new ValidationError("Add the item first, then its units, then choose its sale and purchase units.");
  }
  assertAdvancedExtras(parsed, null, await advancedFeaturesOn(tx));
  if (parsed.itemType === "stock") {
    // Stock entered on the Stock screen before the item existed is kept under the code as it was typed.
    const earlier = await tx.query<{ item_code: string }>(
      "select item_code from inventory_movements where lower(item_code) = lower($1) and item_code <> $1 limit 1",
      [parsed.code],
    );
    if (earlier.rows[0]) {
      throw new ValidationError(`There's already stock recorded as ${earlier.rows[0].item_code}. Use that code exactly, so the item shares that stock.`);
    }
  }
  const refs: ResolvedRefs = {
    incomeAccountId: await resolveAccount(tx, parsed.incomeAccountCode, "income", null),
    purchaseAccountId: await resolveAccount(tx, parsed.purchaseAccountCode, "purchase", null),
    salesTaxCodeId: await resolveTaxCode(tx, parsed.salesTaxCode, null, "sales"),
    purchaseTaxCodeId: await resolveTaxCode(tx, parsed.purchaseTaxCode, null, "purchases"),
  };
  let itemId: string;
  try {
    const inserted = await tx.query<{ id: string }>(
      `insert into items (command_source, idempotency_key, request_hash, code, name, description, item_type, base_unit,
                          sale_price, purchase_price, income_account_id, purchase_account_id, sales_tax_code_id,
                          purchase_tax_code_id, is_active)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9::numeric, $10::numeric, $11, $12, $13, $14, $15) returning id`,
      [
        source,
        idempotencyKey,
        hash,
        parsed.code,
        parsed.name,
        parsed.description,
        parsed.itemType,
        parsed.baseUnit,
        parsed.salePrice,
        parsed.purchasePrice,
        refs.incomeAccountId,
        refs.purchaseAccountId,
        refs.salesTaxCodeId,
        refs.purchaseTaxCodeId,
        parsed.isActive,
      ],
    );
    itemId = inserted.rows[0].id;
    await saveLists(tx, itemId, parsed, null);
  } catch (error) {
    if (isUniqueViolation(error)) throw new ConflictError(`There's already an item with the code ${parsed.code} (codes ignore case).`);
    throw databaseRule(error) ?? error;
  }
  await writeAuditEvent(tx, {
    eventType: "item.created",
    entityType: "item",
    entityId: itemId,
    details: { code: parsed.code, name: parsed.name, itemType: parsed.itemType },
  });
  return { created: true, item: await getItem(tx, itemId) };
}

/**
 * Changes an item (IT1, IT8). Fields that aren't sent keep their values;
 * `levelPrices`, `suppliers` and `components` replace the whole list. A stock
 * item that has stock can't change type (checked once stock tracking arrives).
 */
export async function updateItem(tx: OrgTx, itemIdInput: unknown, input: ItemInput): Promise<Item> {
  const itemId = requireId(itemIdInput, "itemId");
  const locked = await tx.query("select id from items where id = $1 for update", [itemId]);
  if (locked.rowCount === 0) throw new NotFoundError("Item not found.");
  const current = await getItem(tx, itemId);
  const parsed = parseItem(input, current);
  assertAdvancedExtras(parsed, current, await advancedFeaturesOn(tx));
  await assertTypeChangeAllowed(tx, current, parsed.itemType, parsed.code);
  await checkUnits(tx, itemId, parsed, current);
  const kept = await currentRefs(tx, itemId);
  const refs: ResolvedRefs = {
    incomeAccountId: await resolveAccount(tx, parsed.incomeAccountCode, "income", kept.incomeAccountId),
    purchaseAccountId: await resolveAccount(tx, parsed.purchaseAccountCode, "purchase", kept.purchaseAccountId),
    salesTaxCodeId: await resolveTaxCode(tx, parsed.salesTaxCode, kept.salesTaxCodeId, "sales"),
    purchaseTaxCodeId: await resolveTaxCode(tx, parsed.purchaseTaxCode, kept.purchaseTaxCodeId, "purchases"),
  };
  try {
    await tx.query(
      `update items set code = $2, name = $3, description = $4, item_type = $5, base_unit = $6, sale_price = $7::numeric,
              purchase_price = $8::numeric, income_account_id = $9, purchase_account_id = $10, sales_tax_code_id = $11,
              purchase_tax_code_id = $12, sale_unit_id = $13, purchase_unit_id = $14, is_active = $15, updated_at = now()
        where id = $1`,
      [
        itemId,
        parsed.code,
        parsed.name,
        parsed.description,
        parsed.itemType,
        parsed.baseUnit,
        parsed.salePrice,
        parsed.purchasePrice,
        refs.incomeAccountId,
        refs.purchaseAccountId,
        refs.salesTaxCodeId,
        refs.purchaseTaxCodeId,
        parsed.saleUnitId,
        parsed.purchaseUnitId,
        parsed.isActive,
      ],
    );
    await saveLists(tx, itemId, parsed, current);
  } catch (error) {
    if (isUniqueViolation(error)) throw new ConflictError(`There's already an item with the code ${parsed.code} (codes ignore case).`);
    throw databaseRule(error) ?? error;
  }
  const after = await getItem(tx, itemId);
  const changed = (Object.keys(after) as Array<keyof Item>).filter((key) => JSON.stringify(after[key]) !== JSON.stringify(current[key]));
  if (changed.length > 0) {
    await writeAuditEvent(tx, { eventType: "item.updated", entityType: "item", entityId: itemId, details: { changed } });
  }
  return after;
}

/**
 * Changing an item's type after it's been used would change what its lines
 * meant, so it's refused once any document line uses it (IT1). Hook for
 * stock tracking to add its own rule.
 */
async function assertTypeChangeAllowed(tx: OrgTx, current: Item, nextType: ItemType, nextCode: string): Promise<void> {
  // Stock is kept by item code (ST1-ST3), so a stock item with stock movements keeps its code and type.
  if (current.itemType === "stock" && (nextType !== "stock" || nextCode !== current.code)) {
    const moved = await tx.query("select 1 from inventory_movements where item_code = $1 limit 1", [current.code]);
    if (moved.rowCount !== 0) {
      throw new ConflictError(`${current.code} has stock movements, so its code and type can't change. Archive it and add a new item.`);
    }
  }
  if (current.itemType === nextType) return;
  const used = await tx.query(
    `select 1 from sales_invoice_lines where item_id = $1
     union all select 1 from bill_lines where item_id = $1
     union all select 1 from sales_credit_note_lines where item_id = $1
     union all select 1 from supplier_credit_note_lines where item_id = $1
     limit 1`,
    [current.id],
  );
  if (used.rowCount !== 0) {
    throw new ConflictError(`${current.code} is already on invoices, bills or credit notes, so its type can't change. Archive it and add a new item.`);
  }
}

// ---------------------------------------------------------------------------
// Units of measure (IT5)

/** Adds a unit that's a fixed multiple of the item's base unit, e.g. "Box of 12" = 12. */
export async function addItemUnit(tx: OrgTx, itemIdInput: unknown, input: { name: unknown; factor: unknown }): Promise<Item> {
  const itemId = requireId(itemIdInput, "itemId");
  if (!(await advancedFeaturesOn(tx))) {
    throw new ValidationError("Advanced reporting is off, so units of measure can't be added. Turn it on in Settings › Modules.");
  }
  const item = await getItem(tx, itemId);
  const name = parseUnitName(input.name, "The unit's name");
  if (name.toLowerCase() === item.baseUnit.toLowerCase()) throw new ValidationError(`${name} is already the base unit.`);
  const factor = parseDecimalInput(input.factor, "How many base units it holds", { maxScale: UNIT_FACTOR_SCALE });
  if (cmp(dec(factor), dec("1")) === 0) throw new ValidationError(`A unit of 1 ${item.baseUnit} is the base unit itself.`);
  try {
    const inserted = await tx.query<{ id: string }>("insert into item_units (item_id, name, factor) values ($1, $2, $3::numeric) returning id", [itemId, name, factor]);
    await writeAuditEvent(tx, { eventType: "item.unit_added", entityType: "item", entityId: itemId, details: { unitId: inserted.rows[0].id, name, factor } });
  } catch (error) {
    if (isUniqueViolation(error)) throw new ConflictError(`${item.code} already has a unit called ${name}.`);
    throw error;
  }
  return getItem(tx, itemId);
}

/** Renames or archives a unit. Its size never changes: lines already saved keep their meaning. */
export async function updateItemUnit(tx: OrgTx, unitIdInput: unknown, input: { name?: unknown; factor?: unknown; isActive?: unknown }): Promise<Item> {
  const unitId = requireId(unitIdInput, "unitId");
  const found = await tx.query<{ item_id: string; name: string; factor: string; is_active: boolean }>(
    "select item_id, name, factor::text, is_active from item_units where id = $1 for update",
    [unitId],
  );
  const unit = found.rows[0];
  if (!unit) throw new NotFoundError("Unit not found.");
  if (input.factor !== undefined && cmp(dec(parseDecimalInput(input.factor, "factor", { maxScale: UNIT_FACTOR_SCALE })), dec(unit.factor)) !== 0) {
    throw new ValidationError("A unit's size can't change, because lines already use it. Archive it and add a new unit.");
  }
  const name = input.name === undefined ? unit.name : parseUnitName(input.name, "The unit's name");
  if (input.isActive !== undefined && typeof input.isActive !== "boolean") throw new ValidationError("isActive must be true or false.");
  const isActive = input.isActive === undefined ? unit.is_active : input.isActive;
  if (!isActive) {
    const using = await tx.query("select 1 from items where id = $1 and (sale_unit_id = $2 or purchase_unit_id = $2)", [unit.item_id, unitId]);
    if (using.rowCount !== 0) throw new ConflictError(`${unit.name} is the item's sale or purchase unit. Choose another first.`);
  }
  try {
    await tx.query("update item_units set name = $2, is_active = $3, updated_at = now() where id = $1", [unitId, name, isActive]);
  } catch (error) {
    if (isUniqueViolation(error)) throw new ConflictError(`This item already has a unit called ${name}.`);
    throw error;
  }
  await writeAuditEvent(tx, { eventType: "item.unit_updated", entityType: "item", entityId: unit.item_id, details: { unitId, name, isActive } });
  return getItem(tx, unit.item_id);
}
