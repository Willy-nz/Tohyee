import { parseIsoDate, todayIsoDate } from "@/lib/dates";
import type { OrgTx } from "@/lib/db/org-transaction";
import { type ComparisonInput, type ComparisonPlan, compareFarms, type FarmComparison } from "@/lib/farming/comparison-rules";
import { getPlanReport, listPlans } from "@/lib/farming/fertiliser";
import { listFarms, requireFarming } from "@/lib/farming/paddocks";
import { pastureSummary } from "@/lib/farming/pasture";
import { dec, sum, toFixedString } from "@/lib/money/decimal";

export * from "@/lib/farming/comparison-rules";

/** Loads each active farm's paddocks, latest readings and latest fertiliser plan, then compares them. */
export async function farmComparison(tx: OrgTx, input: { onDate?: unknown }): Promise<FarmComparison> {
  await requireFarming(tx);
  const onDate = input.onDate ? parseIsoDate(input.onDate, "On date") : todayIsoDate();
  const farms = (await listFarms(tx)).filter((farm) => farm.isActive);
  const inputs: ComparisonInput[] = [];
  for (const farm of farms) {
    const summary = await pastureSummary(tx, { farmId: farm.id, onDate });
    const latestPlan = (await listPlans(tx, { farmId: farm.id }))[0];
    let plan: ComparisonPlan | null = null;
    if (latestPlan) {
      const report = await getPlanReport(tx, latestPlan.id);
      const version = report.versions.at(-1) ?? null;
      plan = {
        planId: latestPlan.id,
        planName: latestPlan.name,
        plannedTonnes: version ? version.totals.tonnes : null,
        appliedTonnes: toFixedString(sum(report.products.map((product) => dec(product.appliedTonnes))), 3),
        applications: report.applications.length,
        lastAppliedOn: report.applications.map((application) => application.appliedOn).sort().at(-1) ?? null,
      };
    }
    inputs.push({
      farmId: farm.id,
      farmName: farm.name,
      effectiveHa: farm.effectiveHa,
      mappedHa: farm.mappedHa,
      paddocks: summary.paddocks.map((paddock) => ({ paddockId: paddock.paddockId, name: paddock.name, hectares: paddock.hectares, latest: paddock.latest })),
      plan,
    });
  }
  return compareFarms(onDate, inputs);
}
