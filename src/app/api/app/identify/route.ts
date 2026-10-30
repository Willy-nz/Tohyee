import packageJson from "../../../../../package.json";
import { json } from "@/lib/api/http";
import { cameThroughRemoteAccess } from "@/lib/auth/remote";
import { APP_API } from "@/lib/native/server-address";

/*
 * GET: "is this a Tohyee server?", for the Android app's first-run screen
 * (#502, decision 1141). Public, like /api/health, and it says nothing
 * about anyone's data: the app's protocol version, the name "Tohyee" and,
 * only on the server's own network, the exact version (through Remote
 * access the version isn't given out, #208 item 8). Any origin may read it
 * (the app's first-run page is its own origin), without cookies.
 */

const CORS = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, OPTIONS", "access-control-allow-headers": "accept", "access-control-max-age": "600" };

export async function GET(request: Request) {
  const remote = cameThroughRemoteAccess(request.headers);
  return json({ app: "tohyee", api: APP_API, name: "Tohyee", version: remote ? null : packageJson.version }, { headers: CORS });
}

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}
