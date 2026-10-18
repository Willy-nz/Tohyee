import { api, farmFor } from "@/lib/farm-apps/api";
import { farmAppEndpoint, preflight } from "@/lib/farm-apps/http";

/** GET `?farmId=&paddockId=`: cover readings, newest first. Scope read_pasture. */
export const GET = farmAppEndpoint("read_pasture", async (tx, { url }) => ({ readings: await api.pastureReadings(tx, await farmFor(tx, url.searchParams.get("farmId")), url.searchParams.get("paddockId")) }));

/** POST `{ paddockId, measuredOn, cover, method, note? }`: records a cover reading (PF1). Scope record_pasture (FA6). */
export const POST = farmAppEndpoint(
  "record_pasture",
  async (tx, { body }) => ({ reading: await api.addReading(tx, { paddockId: body.paddockId, measuredOn: body.measuredOn, cover: body.cover, method: body.method, note: body.note }) }),
  { writes: true, status: 201 },
);
export const OPTIONS = preflight;
