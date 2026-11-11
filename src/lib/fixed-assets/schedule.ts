import type { DepreciationMethod } from "@/lib/fixed-assets/depreciation";
import type { FixedAssetRegister } from "@/lib/fixed-assets/register";
import { add, dec, type Decimal, sub, toFixedString, ZERO_DECIMAL } from "@/lib/money/decimal";

/**
 * The year's depreciation schedule for the annual financial statements
 * (FS12, decision 1576), worked out from the fixed asset register as at the
 * year end: for each asset, its cost, book value at the start of the year,
 * additions, disposals, the year's depreciation and its book value at the
 * end. Opening + additions - disposals - depreciation = closing. It stores
 * and posts nothing.
 */

export type ScheduleAmounts = {
  cost: string;
  opening: string;
  additions: string;
  disposals: string;
  depreciation: string;
  closing: string;
};

export type ScheduleAsset = ScheduleAmounts & {
  id: string;
  assetNumber: string;
  name: string;
  /** "DV 20%", "SL 10%" or "None". */
  rate: string;
  /** The disposal date, for an asset disposed of in the year. */
  disposedOn: string | null;
};

export type ScheduleGroup = { typeName: string; assets: ScheduleAsset[]; totals: ScheduleAmounts };

export type DepreciationSchedule = { yearStart: string; yearEnd: string; groups: ScheduleGroup[]; totals: ScheduleAmounts };

type Sums = Record<keyof ScheduleAmounts, Decimal>;
const KEYS: Array<keyof ScheduleAmounts> = ["cost", "opening", "additions", "disposals", "depreciation", "closing"];
const zero = (): Sums => ({ cost: ZERO_DECIMAL, opening: ZERO_DECIMAL, additions: ZERO_DECIMAL, disposals: ZERO_DECIMAL, depreciation: ZERO_DECIMAL, closing: ZERO_DECIMAL });

export function rateText(method: DepreciationMethod, rate: string | null): string {
  if (method === "none" || rate === null) return "None";
  return `${method.toUpperCase()} ${rate}%`;
}

/** The schedule from a register as at `register.asOf`; null when there's nothing in it for the year. */
export function depreciationSchedule(register: FixedAssetRegister, scale = 2): DepreciationSchedule | null {
  const fixed = (value: Decimal) => toFixedString(value, scale);
  const yearStart = register.financialYearStart;
  const groups = new Map<string, { typeName: string; assets: ScheduleAsset[]; totals: Sums }>();
  const grand = zero();
  const push = (typeName: string, asset: Omit<ScheduleAsset, keyof ScheduleAmounts>, amounts: Sums) => {
    const group = groups.get(typeName) ?? { typeName, assets: [], totals: zero() };
    groups.set(typeName, group);
    const shown = Object.fromEntries(KEYS.map((key) => [key, fixed(amounts[key])])) as ScheduleAmounts;
    group.assets.push({ ...asset, ...shown });
    for (const key of KEYS) {
      group.totals[key] = add(group.totals[key], amounts[key]);
      grand[key] = add(grand[key], amounts[key]);
    }
  };

  for (const group of register.groups) {
    for (const asset of group.assets) {
      const cost = dec(asset.cost);
      const depreciation = dec(asset.depreciationThisYear);
      const closing = dec(asset.bookValue);
      const bought = asset.purchaseDate >= yearStart;
      push(
        group.typeName,
        { id: asset.id, assetNumber: asset.assetNumber, name: asset.name, rate: rateText(asset.method, asset.rate), disposedOn: null },
        {
          cost,
          opening: bought ? ZERO_DECIMAL : add(closing, depreciation),
          additions: bought ? cost : ZERO_DECIMAL,
          disposals: ZERO_DECIMAL,
          depreciation,
          closing,
        },
      );
    }
  }
  for (const disposal of register.disposals) {
    const cost = dec(disposal.cost);
    const depreciation = dec(disposal.depreciationThisYear);
    const atDisposal = sub(cost, dec(disposal.accumulatedDepreciation));
    const bought = disposal.purchaseDate >= yearStart;
    push(
      disposal.typeName,
      { id: disposal.id, assetNumber: disposal.assetNumber, name: disposal.name, rate: "", disposedOn: disposal.disposalDate },
      {
        cost,
        opening: bought ? ZERO_DECIMAL : add(atDisposal, depreciation),
        additions: bought ? cost : ZERO_DECIMAL,
        disposals: atDisposal,
        depreciation,
        closing: ZERO_DECIMAL,
      },
    );
  }
  if (groups.size === 0) return null;
  const done = (sums: Sums) => Object.fromEntries(KEYS.map((key) => [key, fixed(sums[key])])) as ScheduleAmounts;
  return {
    yearStart,
    yearEnd: register.asOf,
    groups: [...groups.values()].map((group) => ({ typeName: group.typeName, assets: group.assets, totals: done(group.totals) })),
    totals: done(grand),
  };
}
