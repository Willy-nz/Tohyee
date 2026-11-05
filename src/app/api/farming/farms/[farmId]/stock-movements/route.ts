import { route, searchParams, withFarmWork } from "@/lib/api/http";
import { stockMovementFile } from "@/lib/farming/treatments";

type Context = { params: Promise<{ farmId: string }> };

/** GET: the farm's stock movement history as a file (`format`: csv or pdf; `from`, `to`), for farm assurance and processor audits (TRT6). */
export const GET = route<Context>(async (request, context) => {
  const { farmId } = await context.params;
  const params = searchParams(request);
  const file = await withFarmWork(request, params.get("organisationId"), "read", (tx) => stockMovementFile(tx, { farmId, from: params.get("from"), to: params.get("to"), format: params.get("format") }));
  return new Response(file.content as unknown as BodyInit, {
    status: 200,
    headers: { "content-type": file.contentType, "content-disposition": `attachment; filename="${file.fileName}"`, "cache-control": "private, no-store", "x-content-type-options": "nosniff" },
  });
});
