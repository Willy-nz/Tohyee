import { api, farmFor } from "@/lib/farm-apps/api";
import { farmAppEndpoint, preflight } from "@/lib/farm-apps/http";

/** GET `?farmId=&paddockId=&from=&to=&limit=&cursor=`: cover readings, newest first, up to 1,000 a page; `next` is the next page's cursor (decision 901). Scope read_pasture. */
export const GET = farmAppEndpoint("read_pasture", async (tx, { url }) => {
  const query = url.searchParams;
  const page = await api.pastureReadings(tx, await farmFor(tx, query.get("farmId")), query.get("paddockId"), { from: query.get("from"), to: query.get("to"), limit: query.get("limit"), cursor: query.get("cursor") });
  return { readings: page.rows, next: page.next };
});

/** POST `{ paddockId, measuredOn, cover, method, note? }`: records a cover reading (PF1). Scope record_pasture (FA6). */
export const POST = farmAppEndpoint(
  "record_pasture",
  async (tx, { body }) => ({ reading: await api.addReading(tx, { paddockId: body.paddockId, measuredOn: body.measuredOn, cover: body.cover, method: body.method, note: body.note }) }),
  { writes: true, status: 201 },
);
export const OPTIONS = preflight;
