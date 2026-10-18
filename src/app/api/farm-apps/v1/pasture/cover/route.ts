import { api, farmFor } from "@/lib/farm-apps/api";
import { farmAppEndpoint, preflight } from "@/lib/farm-apps/http";

/** GET `?farmId=&onDate=`: the farm's cover, feed wedge and growth on a date (PF2-PF4). Scope read_pasture. */
export const GET = farmAppEndpoint("read_pasture", async (tx, { url }) => ({ summary: await api.pastureCover(tx, await farmFor(tx, url.searchParams.get("farmId")), url.searchParams.get("onDate")) }));
export const OPTIONS = preflight;
