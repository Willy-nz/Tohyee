import { api, farmFor } from "@/lib/farm-apps/api";
import { farmAppEndpoint, preflight } from "@/lib/farm-apps/http";

/** GET `?farmId=&paddockId=`: soil tests with results as the lab reported them, newest first. Scope read_soil. */
export const GET = farmAppEndpoint("read_soil", async (tx, { url }) => ({ tests: await api.soilTests(tx, await farmFor(tx, url.searchParams.get("farmId")), url.searchParams.get("paddockId")) }));
export const OPTIONS = preflight;
