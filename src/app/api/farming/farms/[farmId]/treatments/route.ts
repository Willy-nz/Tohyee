import { json, readJson, route, searchParams, withFarmWork } from "@/lib/api/http";
import { listTreatments, recordTreatment } from "@/lib/farming/treatments";

type Context = { params: Promise<{ farmId: string }> };

/** GET: the farm's treatment register, newest first (`from`, `to`, `mobId`, `includeRemoved=1`). */
export const GET = route<Context>(async (request, context) => {
  const { farmId } = await context.params;
  const params = searchParams(request);
  const treatments = await withFarmWork(request, params.get("organisationId"), "read", (tx) =>
    listTreatments(tx, { farmId, from: params.get("from"), to: params.get("to"), mobId: params.get("mobId"), includeRemoved: params.get("includeRemoved") }),
  );
  return json({ treatments });
});

/** Records a treatment (TRT1-TRT2). Farm staff too. Withholding is what the label says, as typed. */
export const POST = route<Context>(async (request, context) => {
  const { farmId } = await context.params;
  const body = await readJson(request);
  const result = await withFarmWork(request, body.organisationId, "record", (tx) => recordTreatment(tx, { ...body, farmId }));
  return json(result, { status: 201 });
});
