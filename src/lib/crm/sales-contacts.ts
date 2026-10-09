import { ForbiddenError } from "@/lib/errors";

/** The contact fields a sales rep or manager may set: who the company is and how to reach it (decision 491). */
const SALES_FIELDS = ["name", "email", "phone", "postalAddress", "billingCountry", "customFields", "recordTypeId", "ownerUserId"] as const;
const COMMAND_FIELDS = ["source", "idempotencyKey", "organisationId"] as const;

/**
 * A contact create or update from a sales role: only the fields above. A new
 * one is a prospect; marking a company as a customer or supplier, and its
 * currency, tax, payment terms and accounts, are for bookkeepers. Anything
 * else sent is refused rather than quietly dropped.
 */
export function salesContactInput(body: Record<string, unknown>, mode: "create"): Record<string, unknown> & { idempotencyKey: unknown; name: unknown };
export function salesContactInput(body: Record<string, unknown>, mode: "update"): Record<string, unknown>;
export function salesContactInput(body: Record<string, unknown>, mode: "create" | "update"): Record<string, unknown> {
  const allowed = new Set<string>([...SALES_FIELDS, ...COMMAND_FIELDS]);
  const extra = Object.keys(body).filter((key) => body[key] !== undefined && !allowed.has(key) && !(mode === "create" && key === "isProspect"));
  if (extra.length > 0) {
    throw new ForbiddenError(
      `A sales role can set a company's name, email, phone, address, owner and CRM fields only, not ${extra.join(", ")}. A bookkeeper can change the rest.`,
    );
  }
  const input: Record<string, unknown> = {};
  for (const key of SALES_FIELDS) if (body[key] !== undefined) input[key] = body[key];
  if (mode === "create") return { ...input, source: body.source, idempotencyKey: body.idempotencyKey, isProspect: true, isCustomer: false, isSupplier: false };
  return input;
}
