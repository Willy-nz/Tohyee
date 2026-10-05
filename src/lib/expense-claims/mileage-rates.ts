import { writeAuditEvent } from "@/lib/audit";
import { type Role, roleAtLeast } from "@/lib/auth/roles";
import type { OrgTx } from "@/lib/db/org-transaction";
import { ConflictError, ForbiddenError, ValidationError } from "@/lib/errors";
import { listMileageRates, type MileageRateRow } from "@/lib/expense-claims/mileage";
import { incomeYearLabel, VEHICLE_TYPE_LABELS, VEHICLE_TYPES } from "@/lib/expense-claims/mileage-types";
import { recalculateDraftMileage } from "@/lib/expense-claims/service";
import { cmp, dec, parseDecimalInput, toPlainString } from "@/lib/money/decimal";
import { asRecord } from "@/lib/validation";

/**
 * Entering a year's kilometre rates (MI1): admins, all four vehicle types at
 * once, for an income year named by the year it ends. A year an approved
 * claim used can't change. Draft claims' mileage is worked out again (MI6).
 */
export async function saveMileageRates(
  tx: OrgTx,
  role: Role,
  input: { yearEnding?: unknown; rates?: unknown },
): Promise<{ rates: MileageRateRow[]; draftsRecalculated: number }> {
  if (!roleAtLeast(role, "admin")) throw new ForbiddenError("Only admins can enter kilometre rates.");
  const yearEnding = Number(input.yearEnding);
  if (!Number.isInteger(yearEnding) || yearEnding < 2000 || yearEnding > 2200) {
    throw new ValidationError("Choose the income year (named by the year it ends, e.g. 2027 for 2026-27).");
  }
  const label = incomeYearLabel(yearEnding);
  const rates = asRecord(input.rates ?? {}, "rates");
  const parsed = VEHICLE_TYPES.map((vehicleType) => {
    const entry = asRecord(rates[vehicleType] ?? {}, VEHICLE_TYPE_LABELS[vehicleType]);
    const name = `${VEHICLE_TYPE_LABELS[vehicleType]} ${label}`;
    const tier1 = parseDecimalInput(entry.tier1Rate, `${name} tier 1 rate`, { maxScale: 4 });
    const tier2 = parseDecimalInput(entry.tier2Rate, `${name} tier 2 rate`, { maxScale: 4 });
    for (const [rate, tier] of [[tier1, "tier 1"], [tier2, "tier 2"]] as const) {
      if (cmp(dec(rate), dec("100")) >= 0) throw new ValidationError(`${name} ${tier} rate must be less than 100 a km.`);
    }
    return { vehicleType, tier1: toPlainString(dec(tier1)), tier2: toPlainString(dec(tier2)) };
  });
  await tx.query("select pg_advisory_xact_lock(hashtext('mileage_rates'))");
  const existing = (await listMileageRates(tx)).filter((row) => row.yearEnding === yearEnding);
  const unchanged =
    existing.length === parsed.length &&
    parsed.every((entry) => existing.some((row) => row.vehicleType === entry.vehicleType && row.tier1Rate === entry.tier1 && row.tier2Rate === entry.tier2));
  if (unchanged) return { rates: await listMileageRates(tx), draftsRecalculated: 0 };
  if (existing.some((row) => row.used)) {
    throw new ConflictError(`The ${label} rates were used by an approved expense claim, so they can't change. Approved claims keep the rate they were approved at.`);
  }
  for (const entry of parsed) {
    await tx.query(
      `insert into mileage_rates (year_ending, vehicle_type, tier1_rate, tier2_rate, updated_by_email)
       values ($1, $2, $3::numeric, $4::numeric, $5)
       on conflict (year_ending, vehicle_type) do update
         set tier1_rate = excluded.tier1_rate, tier2_rate = excluded.tier2_rate, updated_by_email = excluded.updated_by_email, updated_at = now()`,
      [yearEnding, entry.vehicleType, entry.tier1, entry.tier2, tx.actor.email],
    );
  }
  await writeAuditEvent(tx, {
    eventType: "mileage_rates.saved",
    entityType: "mileage_rates",
    entityId: String(yearEnding),
    details: { year: label, rates: Object.fromEntries(parsed.map((entry) => [entry.vehicleType, { tier1: entry.tier1, tier2: entry.tier2 }])) },
  });
  const draftsRecalculated = await recalculateDraftMileage(tx);
  return { rates: await listMileageRates(tx), draftsRecalculated };
}
