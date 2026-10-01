import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { projectTimeSuggestions } from "@/lib/payroll/timesheets";

type Context = { params: Promise<{ timesheetId: string }> };

/** "Fill from project time" (TS2; decision 91): suggested rows from the linked member's project time. Saves nothing. */
export const GET = route<Context>(async (request, context) => {
  const { timesheetId } = await context.params;
  const params = searchParams(request);
  const suggestions = await withOrganisation(request, params.get("organisationId"), "viewer", (tx, { membership }) =>
    projectTimeSuggestions(tx, membership.role, timesheetId),
  );
  return json({ suggestions });
});
