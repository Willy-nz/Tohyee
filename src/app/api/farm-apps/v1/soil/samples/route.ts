import { api, farmFor } from "@/lib/farm-apps/api";
import { farmAppEndpoint, preflight } from "@/lib/farm-apps/http";

/** GET `?farmId=&paddockId=`: soil samples taken in the field, newest first. Scope read_soil. */
export const GET = farmAppEndpoint("read_soil", async (tx, { url }) => ({ samples: await api.soilSamples(tx, await farmFor(tx, url.searchParams.get("farmId")), url.searchParams.get("paddockId")) }));

/** POST `{ paddockId, takenOn, sampleName?, depth?, latitude?, longitude?, note? }`: records a sample. Scope record_soil_samples (FA4). */
export const POST = farmAppEndpoint(
  "record_soil_samples",
  async (tx, { body }) => ({
    sample: await api.addSoilSample(tx, { paddockId: body.paddockId, takenOn: body.takenOn, sampleName: body.sampleName, depth: body.depth, latitude: body.latitude, longitude: body.longitude, note: body.note }),
  }),
  { writes: true, status: 201 },
);
export const OPTIONS = preflight;
