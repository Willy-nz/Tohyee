import { getStatementLine } from "@/lib/bank/accounts";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ValidationError } from "@/lib/errors";
import type { TaxCategory } from "@/lib/tax/categories";
import { type GstStatus, getGstRegistration, gstStatusOn } from "@/lib/tax/registration";

/**
 * What supports the GST treatment an AI gives a bank line (#546, GSR10):
 * - `tax_document`: a tax invoice or receipt the AI has read (in Tohyee or given by the person);
 * - `person_said`: the person told it;
 * - `contact_usual`: the contact's usual tax code in Tohyee;
 * - `no_gst_supply`: there's no GST to work out (bank fees, interest, wages, drawings, loans,
 *   tax payments, transfers); every line then has no tax code or an out-of-scope one.
 * A merchant's name alone isn't evidence: then the line is left for a person to review.
 */
export const GST_EVIDENCE = ["tax_document", "person_said", "contact_usual", "no_gst_supply"] as const;
export type GstEvidence = (typeof GST_EVIDENCE)[number];

export const GST_EVIDENCE_FIELD = {
  type: "string",
  enum: [...GST_EVIDENCE],
  description:
    "Required when the organisation is registered for GST on the line's date (get_organisation's gstRegistration): what supports the GST treatment. tax_document: a tax invoice or receipt you read; person_said: the person told you; contact_usual: the contact's usual tax code; no_gst_supply: nothing with GST (bank fees, interest, wages, drawings, loans, tax, transfers), so no GST codes. A merchant's name alone isn't evidence: leave the line unreconciled for the person to review.",
} as const;

/**
 * Why an AI may not code a bank line this way, or null (GSR10). `categories`
 * is each line's tax code category (null: no tax code). The server's own
 * checks (NR2 for not registered) still apply after this.
 */
export function aiGstRefusal(status: GstStatus, evidence: unknown, categories: ReadonlyArray<TaxCategory | null>, organisationName: string): string | null {
  const withGst = categories.some((category) => category !== null && category !== "out_of_scope");
  if (evidence !== undefined && evidence !== null && !GST_EVIDENCE.includes(evidence as GstEvidence)) {
    return `gstEvidence must be one of ${GST_EVIDENCE.join(", ")}.`;
  }
  if (status === "not_registered") return null;
  if (status === "unconfirmed") {
    if (evidence === "no_gst_supply" && !withGst) return null;
    return `${organisationName}'s GST registration hasn't been confirmed, so GST can't be chosen for this line. Leave it for the person to review, and ask them to confirm GST registration in Settings.`;
  }
  if (evidence === undefined || evidence === null) {
    return "Say what supports this line's GST treatment (gstEvidence). If there's no tax invoice, receipt, usual code or word from the person, leave the line unreconciled for the person to review rather than guessing from the merchant's name.";
  }
  if (evidence === "no_gst_supply" && withGst) return "gstEvidence no_gst_supply means no GST: use no tax code (or an out-of-scope one) on every line.";
  return null;
}

/** Checks an AI's create_and_match before it posts (GSR10). */
export async function assertAiGstTreatment(tx: OrgTx, args: Record<string, unknown>): Promise<void> {
  const line = await getStatementLine(tx, args.lineId);
  const registration = await getGstRegistration(tx);
  const lines = Array.isArray(args.lines) ? args.lines : [];
  const codes = lines.map((entry) => (entry && typeof entry === "object" && typeof (entry as Record<string, unknown>).taxCode === "string" ? String((entry as Record<string, unknown>).taxCode) : null));
  const known = codes.filter((code): code is string => code !== null);
  const found = known.length
    ? await tx.query<{ code: string; category: TaxCategory }>("select code, category from tax_codes where code = any($1::text[])", [known])
    : { rows: [] as Array<{ code: string; category: TaxCategory }> };
  const byCode = new Map(found.rows.map((row) => [row.code, row.category]));
  // An unknown code is refused by the posting itself; count it as having GST here so it isn't waved through.
  const categories = codes.map((code) => (code === null ? null : (byCode.get(code) ?? "standard")));
  const refusal = aiGstRefusal(gstStatusOn(registration, line.date), args.gstEvidence, categories, registration.organisationName);
  if (refusal) throw new ValidationError(refusal);
}
