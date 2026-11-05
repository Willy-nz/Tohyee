import { route, searchParams, withFarmWork } from "@/lib/api/http";
import { exportObservations } from "@/lib/farming/vegetation/service";

type Context = { params: Promise<{ farmId: string }> };

/** GET: the farm's paddock greenness numbers as CSV, with what they are and the attribution (decision 1538). */
export const GET = route<Context>(async (request, context) => {
  const { farmId } = await context.params;
  const { farmName, csv } = await withFarmWork(request, searchParams(request).get("organisationId"), "read", (tx) => exportObservations(tx, farmId));
  const name = `${farmName.replace(/[^A-Za-z0-9 _-]/g, "").trim() || "farm"} greenness.csv`;
  return new Response(csv, { status: 200, headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${name}"`, "cache-control": "private, no-store" } });
});
