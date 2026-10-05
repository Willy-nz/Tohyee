import { MAX_FILE_JSON_BYTES, json, readJson, route, withOrganisation } from "@/lib/api/http";
import { previewImport } from "@/lib/bank/imports";

type Context = { params: Promise<{ accountId: string }> };

/** Reads a statement file and says what importing it would add, changing nothing. */
export const POST = route<Context>(async (request, context) => {
  const { accountId } = await context.params;
  const body = await readJson(request, { maxBytes: MAX_FILE_JSON_BYTES });
  const preview = await withOrganisation(request, body.organisationId, "bookkeeper", (tx) =>
    previewImport(tx, accountId, { fileName: body.fileName, fileBase64: body.fileBase64, layout: body.layout }),
  );
  return json({ preview });
});
