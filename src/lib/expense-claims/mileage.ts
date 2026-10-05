import type { OrgTx } from "@/lib/db/org-transaction";
import { ValidationError } from "@/lib/errors";
import {
  incomeYearDates,
  incomeYearEnding,
  incomeYearLabel,
  MAX_LINE_KM,
  TIER1_KM,
  VEHICLE_TYPE_LABELS,
  VEHICLE_TYPES,
  type VehicleType,
} from "@/lib/expense-claims/mileage-types";
import { add, cmp, dec, type Decimal, mul, parseDecimalInput, sub, toFixedString, toPlainString, ZERO_DECIMAL } from "@/lib/money/decimal";
import { optionalString, requireString } from "@/lib/validation";

/**
 * Mileage lines on expense claims (MI1-MI7, decisions 407-410): kilometres
 * times IRD's kilometre rate for the vehicle type, tier 1 for the first
 * 14,000 km of the claimant's mileage lines per vehicle type in an income
 * year and tier 2 after that. The rates are the line's income year's when an
 * admin has entered them, otherwise the latest entered (and the line says
 * so). No GST.
 */

export type MileageInput = {
  fromPlace: string;
  toPlace: string;
  /** One decimal place, as typed. */
  km: string;
  vehicleType: VehicleType;
  /** An admin's choice of tier for the whole line (question 3), or null to work it out. */
  tierOverride: "tier1" | "tier2" | null;
  /** How an approved or submitted line was worked out, kept as it is (MI6); null to work it out now. */
  fixed: MileageWorking | null;
};

export type MileageWorking = {
  rateYearEnding: number;
  tier1Km: string;
  tier1Rate: string;
  tier2Km: string;
  tier2Rate: string;
  rateNote: string | null;
  /** tier 1 km x tier 1 rate + tier 2 km x tier 2 rate, to the cent. */
  amount: string;
};

export type MileageRateRow = {
  yearEnding: number;
  yearLabel: string;
  vehicleType: VehicleType;
  tier1Rate: string;
  tier2Rate: string;
  updatedByEmail: string | null;
  updatedAt: string;
  /** An approved claim used this year's rates, so they can't change (MI1). */
  used: boolean;
};

export function parseVehicleType(input: unknown, label: string): VehicleType {
  if (typeof input === "string" && (VEHICLE_TYPES as readonly string[]).includes(input)) return input as VehicleType;
  throw new ValidationError(`${label} vehicle type must be petrol, diesel, petrol hybrid or electric.`);
}

/** Kilometres on one line (MI7): more than 0, at most 2,000, one decimal place. */
export function parseKm(input: unknown, label: string): string {
  if (typeof input === "string" || typeof input === "number") {
    const text = String(input).trim();
    if (/^-/.test(text) || /^0*(\.0*)?$/.test(text)) {
      throw new ValidationError(`${label} kilometres must be more than 0.`);
    }
  }
  const km = parseDecimalInput(input, `${label} kilometres`, { maxScale: 1 });
  if (cmp(dec(km), dec(MAX_LINE_KM)) > 0) {
    throw new ValidationError(`${label} is more than ${MAX_LINE_KM} km. Split long trips into days.`);
  }
  return toPlainString(dec(km));
}

/** A mileage line's places, kilometres and vehicle type as typed. */
export function parseMileage(line: Record<string, unknown>, label: string): Omit<MileageInput, "tierOverride" | "fixed"> {
  return {
    fromPlace: requireString(line.fromPlace, `${label} from`, { maxLength: 200 }),
    toPlace: requireString(line.toPlace, `${label} to`, { maxLength: 200 }),
    km: parseKm(line.km, label),
    vehicleType: parseVehicleType(line.vehicleType, label),
  };
}

export function parseTierOverride(input: unknown): "tier1" | "tier2" | null {
  const value = optionalString(input, "tier", { maxLength: 10 });
  if (value === null) return null;
  if (value !== "tier1" && value !== "tier2") throw new ValidationError("The tier must be tier1, tier2 or empty (worked out).");
  return value;
}

type RateRow = { year_ending: number; vehicle_type: VehicleType; tier1_rate: string; tier2_rate: string };

/** Every year's rates, newest first, with whether an approved claim used them. */
export async function listMileageRates(tx: OrgTx): Promise<MileageRateRow[]> {
  const found = await tx.query<RateRow & { updated_by_email: string | null; updated_at: string; used: boolean }>(
    `select m.year_ending, m.vehicle_type, m.tier1_rate::text, m.tier2_rate::text, m.updated_by_email, m.updated_at,
            exists (select 1 from expense_claim_receipts r join expense_claims c on c.id = r.claim_id
                     where r.kind = 'mileage' and r.rate_year_ending = m.year_ending and c.status in ('approved', 'voided')) as used
       from mileage_rates m
      order by m.year_ending desc, array_position(array['petrol', 'diesel', 'petrol_hybrid', 'electric'], m.vehicle_type)`,
  );
  return found.rows.map((row) => ({
    yearEnding: row.year_ending,
    yearLabel: incomeYearLabel(row.year_ending),
    vehicleType: row.vehicle_type,
    tier1Rate: toPlainString(dec(row.tier1_rate)),
    tier2Rate: toPlainString(dec(row.tier2_rate)),
    updatedByEmail: row.updated_by_email,
    updatedAt: new Date(row.updated_at).toISOString(),
    used: row.used,
  }));
}

async function loadRates(tx: OrgTx): Promise<Map<VehicleType, RateRow[]>> {
  const found = await tx.query<RateRow>(
    "select year_ending, vehicle_type, tier1_rate::text, tier2_rate::text from mileage_rates order by year_ending desc",
  );
  const byType = new Map<VehicleType, RateRow[]>();
  for (const row of found.rows) byType.set(row.vehicle_type, [...(byType.get(row.vehicle_type) ?? []), row]);
  return byType;
}

export type Claimant = { claimId: string | null; userId: string | null; email: string };

/**
 * Kilometres already claimed per vehicle type and income year by the
 * claimant on their other submitted and approved claims (question 3). Drafts
 * and voided claims don't count.
 */
async function earlierKm(tx: OrgTx, claimant: Claimant, vehicleType: VehicleType, yearEnding: number): Promise<Decimal> {
  const { from, to } = incomeYearDates(yearEnding);
  const found = await tx.query<{ km: string }>(
    `select coalesce(sum(r.km), 0)::text as km
       from expense_claim_receipts r join expense_claims c on c.id = r.claim_id
      where r.kind = 'mileage' and r.vehicle_type = $1 and r.receipt_date between $2 and $3
        and c.status in ('submitted', 'approved')
        and ($4::bigint is null or c.id <> $4::bigint)
        and (($5::uuid is not null and c.claimant_user_id = $5::uuid)
             or (c.claimant_user_id is null and lower(c.claimant_email) = lower($6)))`,
    [vehicleType, from, to, claimant.claimId, claimant.userId, claimant.email],
  );
  return dec(found.rows[0].km);
}

const min = (left: Decimal, right: Decimal) => (cmp(left, right) <= 0 ? left : right);
const maxZero = (value: Decimal) => (cmp(value, ZERO_DECIMAL) < 0 ? ZERO_DECIMAL : value);

/**
 * Works out each mileage line (MI2-MI4): the rates, the split between the
 * tiers and the amount. `lines` are the claim's mileage lines with their
 * dates; lines with `fixed` keep it. Tier 1 kilometres left are counted from
 * the claimant's other claims and then this claim's earlier lines (by date,
 * then line order).
 */
export async function workOutMileage(
  tx: OrgTx,
  claimant: Claimant,
  lines: readonly { index: number; receiptDate: string; mileage: MileageInput; label: string }[],
  scale: number,
): Promise<Map<number, MileageWorking>> {
  const result = new Map<number, MileageWorking>();
  const toWork = lines.filter((line) => {
    if (line.mileage.fixed) result.set(line.index, line.mileage.fixed);
    return !line.mileage.fixed;
  });
  if (toWork.length === 0) return result;
  const rates = await loadRates(tx);
  const used = new Map<string, Decimal>();
  const ordered = [...lines].sort((left, right) => left.receiptDate.localeCompare(right.receiptDate) || left.index - right.index);
  for (const line of ordered) {
    const { vehicleType, km } = line.mileage;
    const lineYear = incomeYearEnding(line.receiptDate);
    const key = `${vehicleType}|${lineYear}`;
    if (!used.has(key)) used.set(key, await earlierKm(tx, claimant, vehicleType, lineYear));
    const before = used.get(key)!;
    used.set(key, add(before, dec(km)));
    if (line.mileage.fixed) continue;
    const available = rates.get(vehicleType) ?? [];
    const exact = available.find((row) => row.year_ending === lineYear);
    // Not published yet (or not entered): the latest rates entered, said on the line (question 2).
    const chosen = exact ?? available[0];
    if (!chosen) {
      throw new ValidationError(
        `${line.label}: no kilometre rates have been entered for ${VEHICLE_TYPE_LABELS[vehicleType].toLowerCase()} vehicles. An admin enters them under Settings, Kilometre rates.`,
      );
    }
    const override = line.mileage.tierOverride;
    const tier1Left = maxZero(sub(dec(TIER1_KM), before));
    const tier1Km = override === "tier1" ? dec(km) : override === "tier2" ? ZERO_DECIMAL : min(dec(km), tier1Left);
    const tier2Km = sub(dec(km), tier1Km);
    const amount = add(mul(tier1Km, dec(chosen.tier1_rate)), mul(tier2Km, dec(chosen.tier2_rate)));
    result.set(line.index, {
      rateYearEnding: chosen.year_ending,
      tier1Km: toPlainString(tier1Km),
      tier1Rate: toPlainString(dec(chosen.tier1_rate)),
      tier2Km: toPlainString(tier2Km),
      tier2Rate: toPlainString(dec(chosen.tier2_rate)),
      rateNote: exact ? null : `${incomeYearLabel(chosen.year_ending)} rates (${incomeYearLabel(lineYear)} not entered)`,
      amount: toFixedString(amount, scale),
    });
  }
  return result;
}
