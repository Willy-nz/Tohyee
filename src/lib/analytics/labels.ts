import type { Measure } from "@/lib/analytics/query";

/**
 * Plain names for Analytics' tables and columns. The tables Tohyee copies
 * from the books, the CRM and Farming (`tohyee_*`) have names and short
 * descriptions; anything else (a loaded file, a prepared table) gets its own
 * name tidied up. The real name stays what's saved and sent: these are only
 * what people read.
 *
 * Browser-safe.
 */

type TableText = { label: string; noun: string; description: string };

const TABLES: Record<string, TableText> = {
  tohyee_invoices: { label: "Invoices", noun: "invoices", description: "One row for each approved or voided sales invoice." },
  tohyee_invoice_lines: { label: "Invoice lines", noun: "invoice lines", description: "Each line of each approved or voided sales invoice." },
  tohyee_bills: { label: "Bills", noun: "bills", description: "One row for each approved or voided bill." },
  tohyee_bill_lines: { label: "Bill lines", noun: "bill lines", description: "Each line of each approved or voided bill." },
  tohyee_ledger_lines: { label: "Ledger", noun: "ledger lines", description: "Every line of every posted journal: the general ledger. Amount is debit less credit." },
  tohyee_contacts: { label: "Contacts", noun: "contacts", description: "Customers, suppliers and prospects." },
  tohyee_items: { label: "Items", noun: "items", description: "Products and services." },
  tohyee_crm_opportunities: { label: "CRM opportunities", noun: "opportunities", description: "Sales opportunities in the CRM." },
  tohyee_crm_activities: { label: "CRM activities", noun: "activities", description: "Calls, meetings, emails and notes in the CRM." },
  tohyee_crm_companies: { label: "CRM companies", noun: "companies", description: "Companies in the CRM." },
  tohyee_farm_paddocks: { label: "Paddocks", noun: "paddocks", description: "Each farm's paddocks and their areas." },
  tohyee_farm_fertiliser_products: { label: "Fertiliser products", noun: "fertiliser products", description: "Fertiliser products and their nutrients." },
  tohyee_farm_fertiliser_plan_lines: { label: "Fertiliser plan lines", noun: "fertiliser plan lines", description: "Each paddock and product in each fertiliser plan." },
  tohyee_farm_fertiliser_applications: { label: "Fertiliser applications", noun: "fertiliser applications", description: "Fertiliser spread on paddocks." },
  tohyee_farm_fertiliser_bill_links: { label: "Fertiliser bill links", noun: "fertiliser bill links", description: "Which bill lines paid for which fertiliser." },
  tohyee_farm_soil_results: { label: "Soil test results", noun: "soil test results", description: "Each measure from each soil test." },
  tohyee_farm_pasture_readings: { label: "Pasture readings", noun: "pasture readings", description: "Pasture cover readings by paddock." },
  tohyee_farm_grazings: { label: "Grazings", noun: "grazings", description: "Mobs in and out of paddocks." },
  tohyee_farm_supplements: { label: "Supplements fed", noun: "supplements fed", description: "Supplements fed out by paddock." },
};

/** Words written differently from lower case. */
const WORDS: Record<string, string> = { gst: "GST", id: "ID", ha: "ha", kg: "kg", dm: "DM", pct: "%", geojson: "GeoJSON", crm: "CRM", nz: "NZ", ird: "IRD" };

/** A column's name as words, e.g. "contact ID"; `capital` starts it with a capital letter. */
function fieldWords(name: string, capital: boolean): string {
  const words = name.split(/[_\s]+/).filter(Boolean).map((word) => WORDS[word.toLowerCase()] ?? word);
  if (words.length === 0) return name;
  const text = words.join(" ");
  return capital ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}

/** "tracking_department" -> "Tracking department", "gst" -> "GST", "contact_id" -> "Contact ID". */
export function fieldLabel(name: string): string {
  return fieldWords(name, true);
}

/** The table's plain name: "tohyee_ledger_lines" -> "Ledger", "sales_2025" -> "Sales 2025". */
export function tableLabel(name: string): string {
  return TABLES[name]?.label ?? fieldLabel(name);
}

/** A sentence about what's in a Tohyee table; empty for other tables. */
export function tableDescription(name: string): string {
  return TABLES[name]?.description ?? "";
}

/** What one row of the table is, for "Count of …": "invoices", "ledger lines", or "rows". */
export function tableNoun(name: string): string {
  return TABLES[name]?.noun ?? "rows";
}

/**
 * The label a value gets from its calculation and column, until someone types
 * their own (#329): "Amount", "Average net", "Count of invoices".
 */
export function measureLabel(measure: Pick<Measure, "aggregate" | "field" | "times">, table: string): string {
  const times = measure.times ? ` × ${fieldWords(measure.times, false)}` : "";
  const of = measure.field ? `${fieldLabel(measure.field)}${times}` : "";
  const lower = measure.field ? `${fieldWords(measure.field, false)}${times}` : "";
  switch (measure.aggregate) {
    case "sum":
      return of || "Total";
    case "avg":
      return of ? `Average ${lower}` : "Average";
    case "min":
      return of ? `Smallest ${lower}` : "Smallest";
    case "max":
      return of ? `Largest ${lower}` : "Largest";
    case "count":
      return `Count of ${tableNoun(table)}`;
    case "count_distinct":
      return of ? `Count of different ${lower}` : "Count of different values";
  }
}

/**
 * Whether a value's label is one Tohyee filled in rather than one typed by
 * hand: blank, what `measureLabel` gives, or what earlier versions filled in
 * (the column's name with spaces, or "Rows").
 */
export function isAutomaticLabel(label: string, measure: Pick<Measure, "aggregate" | "field" | "times">, table: string): boolean {
  const text = label.trim();
  if (!text) return true;
  if (text === measureLabel(measure, table)) return true;
  if (text === "Rows") return true;
  return Boolean(measure.field) && (text === measure.field || text === measure.field!.replaceAll("_", " "));
}

/**
 * A value after a change to how it's worked out (its calculation or columns):
 * an automatic label follows the change, a typed one stays.
 */
export function changeMeasure<M extends Pick<Measure, "label" | "aggregate" | "field" | "times">>(measure: M, patch: Partial<M>, table: string): M {
  const next = { ...measure, ...patch };
  if ("label" in patch || !isAutomaticLabel(measure.label, measure, table)) return next;
  return { ...next, label: measureLabel(next, table) };
}
