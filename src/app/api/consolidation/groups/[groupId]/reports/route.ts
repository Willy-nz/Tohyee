import { json, requireAuth, route, searchParams } from "@/lib/api/http";
import { ValidationError } from "@/lib/errors";
import { consolidatedBalanceSheet, consolidatedBudgetVsActual, consolidatedProfitAndLoss, consolidationRates } from "@/lib/consolidation/report";

type Context = { params: Promise<{ groupId: string }> };

/**
 * GET `?report=profit_and_loss&from&to`, `balance_sheet&asAt`,
 * `budget_vs_actual&from&to` or `rates&from&to`: a consolidated report in
 * the group's currency (CO3-CO11).
 */
export const GET = route<Context>(async (request, context) => {
  const { groupId } = await context.params;
  const auth = await requireAuth(request);
  const user = { id: auth.user.id, email: auth.user.email };
  const params = searchParams(request);
  const range = { from: params.get("from"), to: params.get("to") };
  switch (params.get("report")) {
    case "profit_and_loss":
      return json({ report: await consolidatedProfitAndLoss(user, groupId, range) });
    case "balance_sheet":
      return json({ report: await consolidatedBalanceSheet(user, groupId, { asAt: params.get("asAt") }) });
    case "budget_vs_actual":
      return json({ report: await consolidatedBudgetVsActual(user, groupId, range) });
    case "rates":
      return json({ rates: await consolidationRates(user, groupId, range) });
    default:
      throw new ValidationError("report must be profit_and_loss, balance_sheet, budget_vs_actual or rates.");
  }
});
