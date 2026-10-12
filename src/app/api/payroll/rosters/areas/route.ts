import { json, readJson, route, searchParams, withPayrollAccess } from "@/lib/api/http";
import { listRosterAreas, saveRosterArea } from "@/lib/payroll/rosters";

/** GET: the roster areas (such as the shop) with their weekly budgets (RS1). Payroll access. */
export const GET = route(async (request) => {
  const areas = await withPayrollAccess(request, searchParams(request).get("organisationId"), (tx) => listRosterAreas(tx));
  return json({ areas });
});

/** Adds an area, or changes one (`id`): its name, weekly budget and whether it's in use. */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const areas = await withPayrollAccess(request, body.organisationId, (tx) =>
    saveRosterArea(tx, { id: body.id, name: body.name, weeklyBudget: body.weeklyBudget, isActive: body.isActive }),
  );
  return json({ areas });
});
