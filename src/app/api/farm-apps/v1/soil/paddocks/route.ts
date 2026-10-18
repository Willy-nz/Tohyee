import { farmFor, soilByPaddock } from "@/lib/farm-apps/api";
import { farmAppEndpoint, preflight } from "@/lib/farm-apps/http";

/** GET `?farmId=`: each current paddock's latest soil test, oldest first (never tested first). Scope read_soil (FA5). */
export const GET = farmAppEndpoint("read_soil", async (tx, { url }) => soilByPaddock(tx, await farmFor(tx, url.searchParams.get("farmId"))));
export const OPTIONS = preflight;
