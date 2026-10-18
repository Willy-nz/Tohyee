import { farmsWithPaddocks } from "@/lib/farm-apps/api";
import { farmAppEndpoint, preflight } from "@/lib/farm-apps/http";

/** GET: active farms with their current paddocks, areas and shapes (GeoJSON). Scope read_farm. */
export const GET = farmAppEndpoint("read_farm", (tx) => farmsWithPaddocks(tx));
export const OPTIONS = preflight;
