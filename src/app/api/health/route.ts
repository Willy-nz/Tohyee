import packageJson from "../../../../package.json";
import { json } from "@/lib/api/http";
import { coreQuery } from "@/lib/db/transactions";

/** Liveness and core-database check for monitoring. Public, no details leaked. */
export async function GET() {
  let database: "ok" | "unreachable" = "ok";
  try {
    await coreQuery("select 1");
  } catch {
    database = "unreachable";
  }
  return json(
    { status: database === "ok" ? "ok" : "degraded", database, version: packageJson.version },
    { status: database === "ok" ? 200 : 503 },
  );
}
