import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { todayIsoDate } from "@/lib/dates";
import { getRateSourceSettings, RATE_SOURCES, type RateSource, rateSourceWarning, setRateSource } from "@/lib/fx/sources";

/**
 * GET: where exchange rates come from (#183, FX2) and the history of
 * changes; with `to`, the warning a change to that source would show (FX7).
 * Viewers and above.
 */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const to = params.get("to");
  const result = await withOrganisation(request, params.get("organisationId"), "viewer", async (tx) => ({
    settings: await getRateSourceSettings(tx),
    warning: to && (RATE_SOURCES as readonly string[]).includes(to) ? await rateSourceWarning(tx, to as RateSource, todayIsoDate()) : null,
  }));
  return json(result);
});

/** PUT `{ source, reason }`: changes the source (FX7: a reason when it would mix sources in a year). Admins. */
export const PUT = route(async (request) => {
  const body = await readJson(request);
  const settings = await withOrganisation(request, body.organisationId, "admin", (tx) => setRateSource(tx, { source: body.source, reason: body.reason }, todayIsoDate()));
  return json({ settings });
});
