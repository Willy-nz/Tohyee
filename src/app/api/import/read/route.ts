import { MAX_FILE_JSON_BYTES, json, readJson, route, withOrganisation } from "@/lib/api/http";
import { readImportFile } from "@/lib/import/read";
import { getMappings } from "@/lib/import/service";

/**
 * Reads an import file (CSV or Excel) and sends back its rows and headings,
 * with the mapping last used for this kind of file. Saves nothing. Admins.
 */
export const POST = route(async (request) => {
  const body = await readJson(request, { maxBytes: MAX_FILE_JSON_BYTES });
  const result = await withOrganisation(request, body.organisationId, "admin", async (tx) => {
    const file = readImportFile({ kind: body.kind, fileName: body.fileName, fileBase64: body.fileBase64 });
    const mappings = await getMappings(tx);
    return { file, mapping: mappings[body.kind as keyof typeof mappings] ?? null };
  });
  return json(result);
});
