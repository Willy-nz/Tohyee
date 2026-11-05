import { json, route, searchParams, withFarmWork } from "@/lib/api/http";
import { rainfallSummary } from "@/lib/farming/rainfall";

type Context = { params: Promise<{ gaugeId: string }> };

/** GET: a gauge's rainfall to `onDate` (default today): this month, this season and the last 12 months, by month and by season, each with the same time last year (RF5-RF6). */
export const GET = route<Context>(async (request, context) => {
  const { gaugeId } = await context.params;
  const params = searchParams(request);
  const summary = await withFarmWork(request, params.get("organisationId"), "read", (tx) => rainfallSummary(tx, { gaugeId, onDate: params.get("onDate") }));
  return json({ summary });
});
