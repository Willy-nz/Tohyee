import type { OrgTx } from "@/lib/db/org-transaction";
import { ValidationError } from "@/lib/errors";
import { listFarms, listPaddocks } from "@/lib/farming/paddocks";
import { addReading, listReadings, pastureSummary } from "@/lib/farming/pasture";
import { addSoilSample, listSoilSamples } from "@/lib/farming/soil-samples";
import { listSoilTests, soilSummary } from "@/lib/farming/soil";
import { todayIsoDate } from "@/lib/dates";
import type { HistoryInput } from "@/lib/farming/history";

/*
 * What the Farming API v1 does (#249 stage 5; FA1-FA8, decision 561), on top
 * of the same services the screens use. The routes under
 * src/app/api/farm-apps/v1 wire these to scopes.
 */

export const API_VERSION = "1.0.0";

/** The farm asked for, or the only active one (as for the AI, AIW10). */
export async function farmFor(tx: OrgTx, farmId: string | null): Promise<string> {
  if (farmId) return farmId;
  const farms = (await listFarms(tx)).filter((farm) => farm.isActive);
  if (farms.length === 1) return farms[0].id;
  if (farms.length === 0) throw new ValidationError("There are no farms yet.");
  throw new ValidationError(`There are ${farms.length} farms: give farmId (GET /farms lists them).`);
}

export async function farmsWithPaddocks(tx: OrgTx) {
  const farms = (await listFarms(tx)).filter((farm) => farm.isActive);
  const result = [];
  for (const farm of farms) {
    const paddocks = await listPaddocks(tx, { farmId: farm.id });
    result.push({
      id: farm.id,
      name: farm.name,
      effectiveHa: farm.effectiveHa,
      paddocks: paddocks.map((paddock) => ({ id: paddock.id, name: paddock.name, effectiveHa: paddock.effectiveHa, mappedHa: paddock.mappedHa, geometry: paddock.geometry })),
    });
  }
  return { farms: result };
}

/** Each current paddock's latest soil test date (none when never tested), oldest first: the app decides what's due (FA5). */
export async function soilByPaddock(tx: OrgTx, farmId: string) {
  const summary = await soilSummary(tx, { farmId });
  const paddocks = [...summary.paddocks].sort((a, b) => (a.lastSampledOn ?? "").localeCompare(b.lastSampledOn ?? "") || a.paddockName.localeCompare(b.paddockName));
  return { farmId, measures: summary.measures, paddocks };
}

export const api = {
  farmsWithPaddocks,
  soilByPaddock,
  soilTests: (tx: OrgTx, farmId: string, paddockId: string | null) => listSoilTests(tx, { farmId, paddockId }),
  soilSamples: (tx: OrgTx, farmId: string, paddockId: string | null) => listSoilSamples(tx, { farmId, paddockId }),
  addSoilSample,
  pastureCover: (tx: OrgTx, farmId: string, onDate: string | null) => pastureSummary(tx, { farmId, onDate: onDate ?? todayIsoDate() }),
  /** Up to 1,000 a page by default (decision 901). */
  pastureReadings: (tx: OrgTx, farmId: string, paddockId: string | null, page: HistoryInput = {}) => listReadings(tx, { farmId, paddockId, ...page }, { defaultLimit: 1000, max: 1000 }),
  addReading,
};
