import { apiReply, preflight } from "@/lib/farm-apps/http";
import { farmAppsOpenApi } from "@/lib/farm-apps/openapi";

/** GET: the Farming API v1 contract (OpenAPI 3.1), for people and their AI tools building apps (FA8). No key needed. */
export async function GET(request: Request) {
  return apiReply(farmAppsOpenApi(new URL(request.url).origin), 200, { "cache-control": "public, max-age=300" });
}
export const OPTIONS = preflight;
