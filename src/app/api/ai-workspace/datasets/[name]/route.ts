import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { archiveDataset, getDataset, queryDataset } from "@/lib/ai-workspace/datasets";

type Context = { params: Promise<{ name: string }> };

/** One of the AI's tables with its first 500 rows. */
export const GET = route<Context>(async (request, context) => {
  const { name } = await context.params;
  const result = await withOrganisation(request, searchParams(request).get("organisationId"), "viewer", async (tx) => ({
    dataset: await getDataset(tx, name),
    rows: await queryDataset(tx, { name, limit: 500 }),
  }));
  return json(result);
});

/** Archives one of the AI's tables. Bookkeepers. */
export const DELETE = route<Context>(async (request, context) => {
  const { name } = await context.params;
  await withOrganisation(request, searchParams(request).get("organisationId"), "bookkeeper", (tx) => archiveDataset(tx, name));
  return json({ archived: true });
});
