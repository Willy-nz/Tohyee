import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { ValidationError } from "@/lib/errors";
import { type ActivityStatement, activityStatement, type OutstandingStatement, outstandingStatement } from "@/lib/reports/customer-statements";

/**
 * A customer statement (examples CST1-CST5) for `contactId`:
 * `kind=activity` from `from` to `to`, or `kind=outstanding` as at `asAt`;
 * `includeSubCustomers=true` covers the customer's sub-customers too.
 */
export const GET = route(async (request) => {
  const params = searchParams(request);
  const kind = params.get("kind") ?? "activity";
  if (kind !== "activity" && kind !== "outstanding") throw new ValidationError("kind must be activity or outstanding.");
  const statement = await withOrganisation(request, params.get("organisationId"), "viewer", (tx): Promise<ActivityStatement | OutstandingStatement> =>
    kind === "activity"
      ? activityStatement(tx, {
          contactId: params.get("contactId"),
          from: params.get("from"),
          to: params.get("to"),
          includeSubCustomers: params.get("includeSubCustomers"),
        })
      : outstandingStatement(tx, {
          contactId: params.get("contactId"),
          asAt: params.get("asAt"),
          includeSubCustomers: params.get("includeSubCustomers"),
        }),
  );
  return json(statement);
});
