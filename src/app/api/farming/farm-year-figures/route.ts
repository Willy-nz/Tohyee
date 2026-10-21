import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { listFarmYearFigures, setFarmYearFigures } from "@/lib/farming/farm-reporting";

/** GET: each farm's own figures for a financial year (FR4). */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const figures = await withOrganisation(request, params.get("organisationId"), "viewer", (tx) => listFarmYearFigures(tx, params.get("yearEnd")));
  return json({ figures });
});

/** PUT: saves one farm's figures for a year; all blank removes them. Bookkeepers. */
export const PUT = route(async (request) => {
  const body = await readJson(request);
  const figures = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) =>
    setFarmYearFigures(tx, { farmId: body.farmId, yearEnd: body.yearEnd, effectiveHa: body.effectiveHa, peakCows: body.peakCows, stockUnits: body.stockUnits, milkSolidsKg: body.milkSolidsKg }),
  );
  return json({ figures });
});
