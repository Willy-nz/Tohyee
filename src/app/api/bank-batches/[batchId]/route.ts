import { json, route, searchParams, withOrganisation } from "@/lib/api/http";
import { batchLines } from "@/lib/bank/batches";
import { getBatch } from "@/lib/batches/service";

type Context = { params: Promise<{ batchId: string }> };

/** GET: one batch with each action's status (#547), and the statement lines it names. */
export const GET = route<Context>(async (request, context) => {
  const { batchId } = await context.params;
  const answer = await withOrganisation(request, searchParams(request).get("organisationId"), "viewer", async (tx) => {
    const batch = await getBatch(tx, batchId);
    return { batch, lines: await batchLines(tx, batch) };
  });
  return json(answer);
});
