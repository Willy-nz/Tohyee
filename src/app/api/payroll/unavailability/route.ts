import { json, readJson, route, searchParams, withOrganisation } from "@/lib/api/http";
import { addUnavailability, listUnavailability, ownEmployeeId } from "@/lib/payroll/rosters";

/** GET: when an employee can't work (RS2); without `employeeId`, your own. The employee themselves or payroll access. */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const result = await withOrganisation(request, params.get("organisationId"), "viewer", async (tx) => {
    const employeeId = params.get("employeeId");
    // Your own, when your login isn't linked to an employee record: nothing to show.
    if (!employeeId && !(await ownEmployeeId(tx))) return { unavailability: [], linked: false };
    return { unavailability: await listUnavailability(tx, { employeeId }), linked: true };
  });
  return json(result);
});

/** Adds a weekday (`weekday`, 1 = Monday) or dates (`fromDate`, `toDate`) the employee can't work. */
export const POST = route(async (request) => {
  const body = await readJson(request);
  const unavailability = await withOrganisation(request, body.organisationId, "viewer", (tx) =>
    addUnavailability(tx, { employeeId: body.employeeId, weekday: body.weekday, fromDate: body.fromDate, toDate: body.toDate, note: body.note }),
  );
  return json({ unavailability }, { status: 201 });
});
