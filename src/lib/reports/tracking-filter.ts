import type { OrgTx } from "@/lib/db/org-transaction";
import { ValidationError } from "@/lib/errors";
import { valueWithDescendants } from "@/lib/tracking/service";
import { optionalId } from "@/lib/validation";

/**
 * A report's tracking filter (TC8, decision 1355): a category and one of its
 * values (the value and everything under it), or "unassigned" for lines
 * with no value in the category. Null when neither is given.
 */
export type ParsedTrackingFilter = { categoryId: string; valueId: string; valueIds: string[]; label: string };

/** A tracking filter from a category and value (the value and everything under it), or null. */
export async function parseTrackingFilter(
  tx: OrgTx,
  categoryInput: unknown,
  valueInput: unknown,
): Promise<{ categoryId: string; valueId: string; valueIds: string[]; label: string } | null> {
  const categoryId = optionalId(categoryInput, "trackingCategoryId");
  if (valueInput === "unassigned") {
    if (!categoryId) throw new ValidationError("Choose a tracking category to filter untagged lines.");
    const found = await tx.query<{ name: string }>("select name from tracking_categories where id = $1", [categoryId]);
    if (!found.rows[0]) throw new ValidationError("That tracking category doesn't exist.");
    return { categoryId, valueId: "unassigned", valueIds: [], label: `${found.rows[0].name}: Not set` };
  }
  const valueId = optionalId(valueInput, "trackingValueId");
  if (!categoryId && !valueId) return null;
  if (!categoryId || !valueId) throw new ValidationError("Choose both a tracking category and a value to filter by.");
  const found = await tx.query<{ category: string; value: string }>(
    "select c.name as category, v.name as value from tracking_values v join tracking_categories c on c.id = v.category_id where v.id = $1 and c.id = $2",
    [valueId, categoryId],
  );
  if (!found.rows[0]) throw new ValidationError("That tracking value isn't in that category.");
  return { categoryId, valueId, valueIds: await valueWithDescendants(tx, valueId), label: `${found.rows[0].category}: ${found.rows[0].value}` };
}

