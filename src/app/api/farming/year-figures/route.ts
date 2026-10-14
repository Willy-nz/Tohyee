import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { getYearFigures, setYearFigures } from "@/lib/farming/benchmarks";

/** A financial year's physical figures (FK2): effective hectares, peak cows, stock units, milk solids. */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const figures = await withOrganisation(request, params.get("organisationId"), "viewer", (tx) => getYearFigures(tx, params.get("yearEnd")));
  return json({ figures });
});

/** Saves a year's physical figures; an empty value clears it. Bookkeepers. */
export const PUT = route(async (request) => {
  const body = await readJson(request);
  const figures = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) =>
    setYearFigures(tx, { yearEnd: body.yearEnd, effectiveHa: body.effectiveHa, peakCows: body.peakCows, stockUnits: body.stockUnits, milkSolidsKg: body.milkSolidsKg }),
  );
  return json({ figures });
});
