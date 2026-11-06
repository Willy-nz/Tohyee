import { json, MAX_FILE_JSON_BYTES, readJson, route, withFarmWork } from "@/lib/api/http";
import { ForbiddenError } from "@/lib/errors";
import { roleAtLeast } from "@/lib/auth/roles";
import { importAnimals, importRecords, previewAnimalImport, previewRecordImport } from "@/lib/farming/animal-import";

type Context = { params: Promise<{ farmId: string }> };

/**
 * Imports a CSV or .xlsx (`what`: "animals" or "records", scores and weights
 * by tag and date). `preview: true` checks it and saves nothing. Bookkeepers
 * and up, as mob imports are.
 */
export const POST = route<Context>(async (request, context) => {
  const { farmId } = await context.params;
  const body = await readJson(request, { maxBytes: MAX_FILE_JSON_BYTES });
  const result = await withFarmWork(request, body.organisationId, "record", async (tx) => {
    if (tx.actor.role && !roleAtLeast(tx.actor.role, "bookkeeper")) throw new ForbiddenError("Importing needs the bookkeeper role or higher.");
    if (body.what === "records") return body.preview ? { preview: await previewRecordImport(tx, farmId, body) } : await importRecords(tx, farmId, body);
    return body.preview ? { preview: await previewAnimalImport(tx, farmId, body) } : await importAnimals(tx, farmId, body);
  });
  return json(result, { status: body.preview ? 200 : 201 });
});
