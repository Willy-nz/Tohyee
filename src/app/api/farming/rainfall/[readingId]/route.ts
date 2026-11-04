import { json, readJson, route, searchParams, withFarmWork, withOrganisation } from "@/lib/api/http";
import { removeRainReading, updateRainReading } from "@/lib/farming/rainfall";

type Context = { params: Promise<{ readingId: string }> };

/** Changes a reading's date (`readOn`), `mm` or `note`; who and when is kept. Farm staff and up (RF3). */
export const PATCH = route<Context>(async (request, context) => {
  const { readingId } = await context.params;
  const body = await readJson(request);
  const reading = await withFarmWork(request, body.organisationId, "record", (tx) => updateRainReading(tx, readingId, { readOn: body.readOn, mm: body.mm, note: body.note }));
  return json({ reading });
});

/** Removes a reading entered by mistake; it's kept for the history. Bookkeepers and up (RF3). */
export const DELETE = route<Context>(async (request, context) => {
  const { readingId } = await context.params;
  await withOrganisation(request, searchParams(request).get("organisationId"), "bookkeeper", (tx) => removeRainReading(tx, readingId));
  return json({ ok: true });
});
