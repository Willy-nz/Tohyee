import { writeAuditEvent } from "@/lib/audit";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { advancedFeaturesOn } from "@/lib/tracking/service";
import { optionalId, requireId } from "@/lib/validation";

/**
 * Salespeople (examples SR1-SR8), like NetSuite's sales reps: a customer's
 * default and one on each sales invoice and sales credit note. They never
 * change an amount, an account or a GST box.
 */
export type Salesperson = { id: string; name: string; email: string | null; isActive: boolean };

export type SalespeopleSetup = { advancedFeatures: boolean; salespeople: Salesperson[] };

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function listSalespeople(tx: OrgTx): Promise<SalespeopleSetup> {
  const rows = await tx.query<{ id: string; name: string; email: string | null; is_active: boolean }>(
    "select id, name, email, is_active from salespeople order by lower(name), id",
  );
  return {
    advancedFeatures: await advancedFeaturesOn(tx),
    salespeople: rows.rows.map((row) => ({ id: row.id, name: row.name, email: row.email, isActive: row.is_active })),
  };
}

function parseName(input: unknown): string {
  if (typeof input !== "string" || !input.trim()) throw new ValidationError("The name is required.");
  const name = input.trim().replace(/\s+/g, " ");
  if (name.length > 100) throw new ValidationError("The name can be at most 100 characters.");
  return name;
}

function parseEmail(input: unknown): string | null {
  if (input == null || (typeof input === "string" && !input.trim())) return null;
  if (typeof input !== "string" || input.trim().length > 254 || !EMAIL.test(input.trim())) {
    throw new ValidationError("Enter a valid email address, like aroha@example.co.nz.");
  }
  return input.trim();
}

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string }).code === "23505";
}

async function requireAdvanced(tx: OrgTx): Promise<void> {
  if (!(await advancedFeaturesOn(tx))) throw new ConflictError("Advanced reporting is off. Turn it on in Settings › Modules first.");
}

/** Adds a salesperson (SR1). */
export async function createSalesperson(tx: OrgTx, input: { name: unknown; email?: unknown }): Promise<SalespeopleSetup> {
  await requireAdvanced(tx);
  const name = parseName(input.name);
  const email = parseEmail(input.email);
  try {
    const inserted = await tx.query<{ id: string }>("insert into salespeople (name, email) values ($1, $2) returning id", [name, email]);
    await writeAuditEvent(tx, { eventType: "salesperson.created", entityType: "salesperson", entityId: inserted.rows[0].id, details: { name, email } });
  } catch (error) {
    if (isUniqueViolation(error)) throw new ConflictError(`There's already a salesperson called ${name}.`);
    throw error;
  }
  return listSalespeople(tx);
}

/** Renames a salesperson, changes their email, or archives or restores them (SR6). */
export async function updateSalesperson(
  tx: OrgTx,
  idInput: unknown,
  input: { name?: unknown; email?: unknown; isActive?: unknown },
): Promise<SalespeopleSetup> {
  await requireAdvanced(tx);
  const id = requireId(idInput, "salespersonId");
  const found = await tx.query<{ name: string; email: string | null; is_active: boolean }>(
    "select name, email, is_active from salespeople where id = $1 for update",
    [id],
  );
  const current = found.rows[0];
  if (!current) throw new NotFoundError("Salesperson not found.");
  const name = input.name === undefined ? current.name : parseName(input.name);
  const email = input.email === undefined ? current.email : parseEmail(input.email);
  if (input.isActive !== undefined && typeof input.isActive !== "boolean") throw new ValidationError("isActive must be true or false.");
  const isActive = input.isActive === undefined ? current.is_active : input.isActive;
  try {
    await tx.query("update salespeople set name = $2, email = $3, is_active = $4, updated_at = now() where id = $1", [id, name, email, isActive]);
  } catch (error) {
    if (isUniqueViolation(error)) throw new ConflictError(`There's already a salesperson called ${name}.`);
    throw error;
  }
  await writeAuditEvent(tx, { eventType: "salesperson.updated", entityType: "salesperson", entityId: id, details: { name, email, isActive } });
  return listSalespeople(tx);
}

/**
 * A salesperson id as sent: undefined when it wasn't sent, null for "none".
 */
export function parseSalespersonInput(input: unknown): string | null | undefined {
  if (input === undefined) return undefined;
  if (input === null || input === "") return null;
  return requireId(input, "salespersonId");
}

/**
 * The salesperson for a document (SR1, SR6, SR7): the one sent, or when none
 * was sent the customer's default (if it's active and advanced features are
 * on). A new one must be active and advanced features on; `kept` is the one
 * the draft already had, which can stay.
 */
export async function resolveSalesperson(
  tx: OrgTx,
  sent: string | null | undefined,
  options: { contactId: string; kept: string | null },
): Promise<{ id: string | null; name: string | null }> {
  const advanced = await advancedFeaturesOn(tx);
  let id = sent;
  if (id === undefined) {
    if (!advanced) return { id: null, name: null };
    const contact = await tx.query<{ id: string | null; is_active: boolean | null }>(
      `select s.id, s.is_active from contacts c left join salespeople s on s.id = c.default_salesperson_id where c.id = $1`,
      [options.contactId],
    );
    const row = contact.rows[0];
    id = row?.id && row.is_active ? row.id : null;
  }
  if (id === null) return { id: null, name: null };
  const found = await tx.query<{ name: string; is_active: boolean }>("select name, is_active from salespeople where id = $1", [id]);
  const salesperson = found.rows[0];
  if (!salesperson) throw new ValidationError(`There's no salesperson #${id}.`);
  if (id !== options.kept) {
    if (!advanced) throw new ValidationError("Advanced reporting is off, so a salesperson can't be chosen.");
    if (!salesperson.is_active) throw new ValidationError(`${salesperson.name} is archived.`);
  }
  return { id, name: salesperson.name };
}

/** A customer's default salesperson as sent (undefined: not sent). Must exist; a new one must be active. */
export async function resolveDefaultSalesperson(tx: OrgTx, sent: unknown, kept: string | null): Promise<string | null | undefined> {
  const id = sent === undefined ? undefined : optionalId(sent === "" ? null : sent, "defaultSalespersonId");
  if (id === undefined || id === null || id === kept) return id;
  const found = await tx.query<{ name: string; is_active: boolean }>("select name, is_active from salespeople where id = $1", [id]);
  const salesperson = found.rows[0];
  if (!salesperson) throw new ValidationError(`There's no salesperson #${id}.`);
  if (!(await advancedFeaturesOn(tx))) throw new ValidationError("Advanced reporting is off, so a salesperson can't be chosen.");
  if (!salesperson.is_active) throw new ValidationError(`${salesperson.name} is archived.`);
  return id;
}
