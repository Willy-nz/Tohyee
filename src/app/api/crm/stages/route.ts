import { json, readJson, route, searchParams, withCrm } from "@/lib/api/http";
import { createStage, listSalesProcesses, listStages } from "@/lib/crm/stages";

/** The organisation's opportunity stages, archived ones too, in order, and each opportunity record type's sales process (CRMS2, CRMS7). */
export const GET = route(async (request) => {
  const result = await withCrm(request, searchParams(request).get("organisationId"), "read", async (tx) => ({
    stages: await listStages(tx),
    salesProcesses: await listSalesProcesses(tx),
  }));
  return json(result);
});

/** Adds a stage at the end (CRMS2). Admins and owners only. */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const stage = await withCrm(request, body.organisationId, "admin", (tx) =>
    createStage(tx, { name: body.name, type: body.type, probability: body.probability, forecastCategory: body.forecastCategory }),
  );
  return json({ stage }, { status: 201 });
});
