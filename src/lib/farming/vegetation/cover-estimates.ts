/**
 * The farm's modelled-cover line in use, and an estimate from it (#612 phase
 * 3, MCV6, decision 1596). Kept apart from cover-model.ts so the map's
 * vegetation reads can use it.
 */
import type { OrgTx } from "@/lib/db/org-transaction";
import { type Line, type ModelledCover, modelledCover } from "@/lib/farming/vegetation/cover-fit";

export type CoverModel = {
  id: string;
  line: Line;
  ndviMin: string;
  ndviMax: string;
  likelyWithin: number;
  meanError: number;
  acceptableError: number;
  pairs: number;
  dates: number;
  turnedOnBy: string;
  turnedOnAt: string;
};

export type ModelRow = {
  id: string;
  intercept: string;
  slope: string;
  ndvi_min: string;
  ndvi_max: string;
  likely_within: number;
  mean_error: number;
  acceptable_error: number;
  pairs: number;
  dates: number;
  turned_on_by_email: string;
  turned_on_at: string;
};

export const toModel = (row: ModelRow): CoverModel => ({
  id: row.id,
  line: { intercept: row.intercept, slope: row.slope },
  ndviMin: row.ndvi_min,
  ndviMax: row.ndvi_max,
  likelyWithin: row.likely_within,
  meanError: row.mean_error,
  acceptableError: row.acceptable_error,
  pairs: row.pairs,
  dates: row.dates,
  turnedOnBy: row.turned_on_by_email,
  turnedOnAt: row.turned_on_at,
});

/** The farm's line in use, or null when estimates are off. */
export async function activeCoverModel(tx: OrgTx, farmId: string): Promise<CoverModel | null> {
  const row = await tx.query<ModelRow>(
    `select id::text, intercept::text, slope::text, ndvi_min::text, ndvi_max::text, likely_within, mean_error, acceptable_error, pairs, dates,
            turned_on_by_email, to_char(turned_on_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as turned_on_at
       from vegetation_cover_models where farm_id = $1 and turned_off_at is null`,
    [farmId],
  );
  return row.rows[0] ? toModel(row.rows[0]) : null;
}

/** MCV6: the estimate for a clear view's greenness with the farm's line, or null (estimates off, or no clear view). */
export function estimateFor(model: CoverModel | null, observation: { quality: string; meanNdvi: string | null }): ModelledCover | null {
  if (!model || observation.quality !== "good" || observation.meanNdvi === null) return null;
  return modelledCover({ line: model.line, likelyWithin: model.likelyWithin, ndviMin: model.ndviMin, ndviMax: model.ndviMax }, observation.meanNdvi);
}

