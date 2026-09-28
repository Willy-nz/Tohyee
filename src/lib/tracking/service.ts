import type { AccountClass } from "@/lib/accounts/types";
import { writeAuditEvent } from "@/lib/audit";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { optionalId, requireId } from "@/lib/validation";

/**
 * Tracking categories (examples TC1-TC10): Department, Class and Location,
 * each a tree of values, turned on by the organisation's "Advanced (ERP)
 * features" setting. Lines carry tags as a map of category id -> value id.
 */
export type TrackingTags = Record<string, string>;

export type TrackingCategoryKind = "department" | "class" | "location" | "custom";

export type TrackingValue = {
  id: string;
  categoryId: string;
  parentId: string | null;
  name: string;
  /** Names from the top, e.g. "Otago › Dunedin". */
  path: string;
  depth: number;
  isActive: boolean;
};

export type TrackingCategory = {
  id: string;
  kind: TrackingCategoryKind;
  name: string;
  isRequired: boolean;
  /** Only custom segments can be archived: hidden from new lines, kept on old ones (CS2). */
  isActive: boolean;
  sortOrder: number;
  /** In tree order: each value followed by its children. */
  values: TrackingValue[];
};

export type TrackingSetup = { advancedFeatures: boolean; categories: TrackingCategory[] };

export async function advancedFeaturesOn(tx: OrgTx): Promise<boolean> {
  const result = await tx.query<{ advanced_features: boolean }>("select advanced_features from organisation_settings where id = true");
  return result.rows[0]?.advanced_features === true;
}

export async function getTrackingSetup(tx: OrgTx): Promise<TrackingSetup> {
  const categories = await tx.query<{
    id: string;
    kind: TrackingCategoryKind;
    name: string;
    is_required: boolean;
    is_active: boolean;
    sort_order: number;
  }>("select id, kind, name, is_required, is_active, sort_order from tracking_categories order by sort_order, id");
  const values = await tx.query<{ id: string; category_id: string; parent_id: string | null; name: string; is_active: boolean }>(
    "select id, category_id, parent_id, name, is_active from tracking_values order by lower(name), id",
  );
  const children = new Map<string, typeof values.rows>();
  for (const row of values.rows) {
    const key = `${row.category_id}:${row.parent_id ?? ""}`;
    children.set(key, [...(children.get(key) ?? []), row]);
  }
  const tree = (categoryId: string, parentId: string | null, prefix: string, depth: number): TrackingValue[] =>
    (children.get(`${categoryId}:${parentId ?? ""}`) ?? []).flatMap((row) => {
      const path = prefix ? `${prefix} › ${row.name}` : row.name;
      return [
        { id: row.id, categoryId, parentId: row.parent_id, name: row.name, path, depth, isActive: row.is_active },
        ...tree(categoryId, row.id, path, depth + 1),
      ];
    });
  return {
    advancedFeatures: await advancedFeaturesOn(tx),
    categories: categories.rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      name: row.name,
      isRequired: row.is_required,
      isActive: row.is_active,
      sortOrder: row.sort_order,
      values: tree(row.id, null, "", 0),
    })),
  };
}

async function requireAdvanced(tx: OrgTx): Promise<void> {
  if (!(await advancedFeaturesOn(tx))) {
    throw new ConflictError("Advanced features are off. Turn them on in Settings first.");
  }
}

function parseName(input: unknown, what: string, max: number): string {
  if (typeof input !== "string" || !input.trim()) throw new ValidationError(`${what} is required.`);
  const value = input.trim().replace(/\s+/g, " ");
  if (value.length > max) throw new ValidationError(`${what} can be at most ${max} characters.`);
  return value;
}

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string }).code === "23505";
}

function databaseRule(error: unknown): string | null {
  const e = error as { code?: string; message?: string };
  return e.code === "P0001" ? (e.message ?? null) : null;
}

async function findValue(tx: OrgTx, id: string) {
  const found = await tx.query<{ id: string; category_id: string; parent_id: string | null; name: string; is_active: boolean }>(
    "select id, category_id, parent_id, name, is_active from tracking_values where id = $1",
    [id],
  );
  if (!found.rows[0]) throw new NotFoundError("Tracking value not found.");
  return found.rows[0];
}

/** Adds a value, at the top of its category or under another value (TC2). */
export async function createTrackingValue(
  tx: OrgTx,
  input: { categoryId: unknown; name: unknown; parentId?: unknown },
): Promise<TrackingSetup> {
  await requireAdvanced(tx);
  const categoryId = requireId(input.categoryId, "categoryId");
  const name = parseName(input.name, "The name", 100);
  const parentId = optionalId(input.parentId, "parentId");
  const category = await tx.query<{ id: string; name: string }>("select id, name from tracking_categories where id = $1", [categoryId]);
  if (!category.rows[0]) throw new NotFoundError("Tracking category not found.");
  if (parentId) {
    const parent = await findValue(tx, parentId);
    if (parent.category_id !== categoryId) throw new ValidationError("A value's parent must be in the same category.");
  }
  try {
    const inserted = await tx.query<{ id: string }>(
      "insert into tracking_values (category_id, parent_id, name) values ($1, $2, $3) returning id",
      [categoryId, parentId, name],
    );
    await writeAuditEvent(tx, {
      eventType: "tracking.value_created",
      entityType: "tracking_value",
      entityId: inserted.rows[0].id,
      details: { category: category.rows[0].name, name, parentId },
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw new ConflictError(`There's already a value called ${name} there.`);
    const rule = databaseRule(error);
    if (rule) throw new ValidationError(rule);
    throw error;
  }
  return getTrackingSetup(tx);
}

/** Renames a value, moves it under another value (or to the top), or archives or restores it (TC2). */
export async function updateTrackingValue(
  tx: OrgTx,
  idInput: unknown,
  input: { name?: unknown; parentId?: unknown; isActive?: unknown },
): Promise<TrackingSetup> {
  await requireAdvanced(tx);
  const id = requireId(idInput, "valueId");
  const current = await findValue(tx, id);
  const name = input.name === undefined ? current.name : parseName(input.name, "The name", 100);
  const parentId = input.parentId === undefined ? current.parent_id : optionalId(input.parentId, "parentId");
  if (input.isActive !== undefined && typeof input.isActive !== "boolean") throw new ValidationError("isActive must be true or false.");
  const isActive = input.isActive === undefined ? current.is_active : input.isActive;
  if (parentId === id) throw new ValidationError(`${current.name} can't be under itself.`);
  try {
    await tx.query("update tracking_values set name = $2, parent_id = $3, is_active = $4, updated_at = now() where id = $1", [
      id,
      name,
      parentId,
      isActive,
    ]);
  } catch (error) {
    if (isUniqueViolation(error)) throw new ConflictError(`There's already a value called ${name} there.`);
    const rule = databaseRule(error);
    if (rule) throw new ValidationError(rule);
    throw error;
  }
  await writeAuditEvent(tx, {
    eventType: "tracking.value_updated",
    entityType: "tracking_value",
    entityId: id,
    details: { name, parentId, isActive },
  });
  return getTrackingSetup(tx);
}

/** The most custom segments an organisation can have (CS3). */
export const MAX_CUSTOM_SEGMENTS = 20;

/** Adds a custom segment: a tracking category of the organisation's own (CS1). */
export async function createTrackingCategory(tx: OrgTx, input: { name: unknown; isRequired?: unknown }): Promise<TrackingSetup> {
  await requireAdvanced(tx);
  const name = parseName(input.name, "The name", 60);
  if (input.isRequired !== undefined && typeof input.isRequired !== "boolean") throw new ValidationError("isRequired must be true or false.");
  // One at a time, so two admins can't both add the 20th.
  await tx.query("lock table tracking_categories in share row exclusive mode");
  const count = await tx.query<{ count: string }>("select count(*)::text as count from tracking_categories where kind = 'custom'");
  if (Number(count.rows[0].count) >= MAX_CUSTOM_SEGMENTS) {
    throw new ConflictError(`An organisation can have at most ${MAX_CUSTOM_SEGMENTS} segments of its own.`);
  }
  try {
    const inserted = await tx.query<{ id: string }>(
      `insert into tracking_categories (kind, name, is_required, sort_order)
       values ('custom', $1, $2, (select coalesce(max(sort_order), 0) + 1 from tracking_categories)) returning id`,
      [name, input.isRequired === true],
    );
    await writeAuditEvent(tx, {
      eventType: "tracking.category_created",
      entityType: "tracking_category",
      entityId: inserted.rows[0].id,
      details: { name, isRequired: input.isRequired === true },
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw new ConflictError(`There's already a category called ${name}.`);
    throw error;
  }
  return getTrackingSetup(tx);
}

/** Renames a category, makes it required (TC6), or archives or restores a custom segment (CS2). */
export async function updateTrackingCategory(
  tx: OrgTx,
  idInput: unknown,
  input: { name?: unknown; isRequired?: unknown; isActive?: unknown },
): Promise<TrackingSetup> {
  await requireAdvanced(tx);
  const id = requireId(idInput, "categoryId");
  const found = await tx.query<{ name: string; kind: TrackingCategoryKind; is_required: boolean; is_active: boolean }>(
    "select name, kind, is_required, is_active from tracking_categories where id = $1",
    [id],
  );
  const current = found.rows[0];
  if (!current) throw new NotFoundError("Tracking category not found.");
  const name = input.name === undefined ? current.name : parseName(input.name, "The name", 60);
  if (input.isRequired !== undefined && typeof input.isRequired !== "boolean") throw new ValidationError("isRequired must be true or false.");
  if (input.isActive !== undefined && typeof input.isActive !== "boolean") throw new ValidationError("isActive must be true or false.");
  const isRequired = input.isRequired === undefined ? current.is_required : input.isRequired;
  const isActive = input.isActive === undefined ? current.is_active : input.isActive;
  if (!isActive && current.kind !== "custom") throw new ValidationError("Department, Class and Location can't be archived.");
  try {
    await tx.query("update tracking_categories set name = $2, is_required = $3, is_active = $4, updated_at = now() where id = $1", [
      id,
      name,
      isRequired,
      isActive,
    ]);
  } catch (error) {
    if (isUniqueViolation(error)) throw new ConflictError(`There's already a category called ${name}.`);
    throw error;
  }
  await writeAuditEvent(tx, {
    eventType: "tracking.category_updated",
    entityType: "tracking_category",
    entityId: id,
    details: { name, isRequired, isActive },
  });
  return getTrackingSetup(tx);
}

/** A line's tags as sent: an object of category id -> value id. Blank values are left out. */
export function parseTrackingInput(input: unknown, label: string): TrackingTags {
  if (input == null) return {};
  if (typeof input !== "object" || Array.isArray(input)) throw new ValidationError(`${label} tracking must be an object of category -> value.`);
  const tags: TrackingTags = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (value == null || value === "") continue;
    const categoryId = requireId(key, `${label} tracking category`);
    tags[categoryId] = requireId(value, `${label} tracking value`);
  }
  return tags;
}

/** The same tags always give the same key, so equal lines can be posted together. */
export function trackingKey(tags: TrackingTags | undefined): string {
  if (!tags) return "";
  return Object.keys(tags)
    .sort((a, b) => Number(a) - Number(b))
    .map((key) => `${key}=${tags[key]}`)
    .join(",");
}

export function sortedTags(tags: TrackingTags | undefined): TrackingTags {
  const out: TrackingTags = {};
  if (!tags) return out;
  for (const key of Object.keys(tags).sort((a, b) => Number(a) - Number(b))) out[key] = tags[key];
  return out;
}

export type TrackingContext = {
  advancedFeatures: boolean;
  categories: Map<string, { id: string; name: string; isRequired: boolean; isActive: boolean }>;
  values: Map<string, { id: string; categoryId: string; name: string; path: string; isActive: boolean }>;
};

export async function loadTrackingContext(tx: OrgTx): Promise<TrackingContext> {
  const setup = await getTrackingSetup(tx);
  const categories = new Map(setup.categories.map((c) => [c.id, { id: c.id, name: c.name, isRequired: c.isRequired, isActive: c.isActive }]));
  const values = new Map(
    setup.categories.flatMap((c) => c.values.map((v) => [v.id, { id: v.id, categoryId: c.id, name: v.name, path: v.path, isActive: v.isActive }] as const)),
  );
  return { advancedFeatures: setup.advancedFeatures, categories, values };
}

/**
 * Checks tags a user is putting on a line (TC1, TC2, TC5): advanced features
 * must be on, each value must belong to its category, and a new line can't
 * use an archived value. `kept` holds values the document already had (an
 * edited or approved draft keeps an archived value it had before).
 */
export function checkNewTags(ctx: TrackingContext, tags: TrackingTags, label: string, kept: ReadonlySet<string> = new Set()): void {
  const keys = Object.keys(tags);
  if (keys.length === 0) return;
  // With the switch off, a document can keep the tags it already had (TC1), but gets no new ones.
  if (!ctx.advancedFeatures && keys.some((key) => !kept.has(tags[key]))) {
    throw new ValidationError(`${label}: advanced features are off, so lines can't have tracking categories.`);
  }
  for (const categoryId of keys) {
    const category = ctx.categories.get(categoryId);
    if (!category) throw new ValidationError(`${label}: there's no tracking category ${categoryId}.`);
    const value = ctx.values.get(tags[categoryId]);
    if (!value || value.categoryId !== categoryId) throw new ValidationError(`${label}: that isn't a ${category.name} value.`);
    if (!category.isActive && !kept.has(value.id)) throw new ValidationError(`${label}: ${category.name} is archived.`);
    if (!value.isActive && !kept.has(value.id)) throw new ValidationError(`${label}: ${value.path} is archived.`);
  }
}

/** A required category missing from a line on an income or expense account (TC6), or null. */
export function missingRequired(ctx: TrackingContext, tags: TrackingTags, accountClass: AccountClass): string | null {
  if (!ctx.advancedFeatures) return null;
  if (accountClass !== "revenue" && accountClass !== "expense") return null;
  for (const category of ctx.categories.values()) {
    if (category.isRequired && category.isActive && !tags[category.id]) return category.name;
  }
  return null;
}

/** Throws "Line 2 needs a Department" for the first line missing a required category (TC6). */
export function assertRequiredTags(
  ctx: TrackingContext,
  lines: Array<{ tags: TrackingTags; accountClass: AccountClass }>,
): void {
  lines.forEach((line, index) => {
    const missing = missingRequired(ctx, line.tags, line.accountClass);
    if (missing) throw new ValidationError(`Line ${index + 1} needs a ${missing}.`);
  });
}

/** A value and every value under it, for filters (TC8). */
export async function valueWithDescendants(tx: OrgTx, valueId: string): Promise<string[]> {
  const result = await tx.query<{ id: string }>(
    `with recursive tree as (
       select id from tracking_values where id = $1
       union all
       select v.id from tracking_values v join tree t on v.parent_id = t.id
     ) select id::text from tree`,
    [valueId],
  );
  return result.rows.map((row) => row.id);
}

/** Every value a document's lines already use, so an archived one can stay. */
export function keptValues(lines: ReadonlyArray<{ tracking: TrackingTags }>): Set<string> {
  return new Set(lines.flatMap((line) => Object.values(line.tracking ?? {})));
}

/**
 * Drops empty tags and custom field values that weren't sent from a hashed
 * line, so hashes from before tracking and custom fields don't change.
 */
export function hashableLine<T extends { tracking: TrackingTags; customFields?: unknown }>(line: T): Partial<T> {
  const out: Partial<T> = { ...line };
  if (Object.keys(line.tracking).length === 0) delete out.tracking;
  if (line.customFields === undefined) delete out.customFields;
  return out;
}
