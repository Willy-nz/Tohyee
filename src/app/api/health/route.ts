import packageJson from "../../../../package.json";
import { json } from "@/lib/api/http";
import { cameThroughRemoteAccess } from "@/lib/auth/remote";
import { coreQuery } from "@/lib/db/transactions";

/**
 * Liveness and core-database check for monitoring. Public. Through remote
 * access (a tunnel or Funnel) it says only whether the server is up: the exact
 * version and the database's state are for this network (#208 item 8).
 */
export async function GET(request: Request) {
  let database: "ok" | "unreachable" = "ok";
  try {
    await coreQuery("select 1");
  } catch {
    database = "unreachable";
  }
  const status = database === "ok" ? "ok" : "degraded";
  const httpStatus = database === "ok" ? 200 : 503;
  if (cameThroughRemoteAccess(request.headers)) return json({ status }, { status: httpStatus });
  return json({ status, database, version: packageJson.version }, { status: httpStatus });
}
