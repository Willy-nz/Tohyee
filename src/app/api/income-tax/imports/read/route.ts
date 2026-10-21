import { MAX_FILE_JSON_BYTES, json, readJson, route, withOrganisation } from "@/lib/api/http";
import { findHeadings, guessHeaderRow, headingsAt } from "@/lib/tax/income/ird-import-kinds";
import { listIrdMappings, readIrdImportFile } from "@/lib/tax/income/ird-imports";

/**
 * POST: reads an IRD account file (CSV or Excel) and sends back its rows, a
 * guess at the headings row, and the saved mappings, marking the one made
 * for these headings (ITX-IMP2, ITX-IMP3). Saves nothing. Owners and admins.
 */
export const POST = route(async (request) => {
  const body = await readJson(request, { maxBytes: MAX_FILE_JSON_BYTES });
  const result = await withOrganisation(request, body.organisationId, "admin", async (tx) => {
    const file = readIrdImportFile({ fileName: body.fileName, fileBase64: body.fileBase64 });
    const mappings = await listIrdMappings(tx);
    const matched = mappings.map((saved) => ({ saved, row: findHeadings(file.rows, saved.headings) })).find((entry) => entry.row !== null) ?? null;
    const headerRow = matched?.row ?? guessHeaderRow(file.rows);
    return {
      file: { fileName: file.fileName, rows: file.rows, headerRow, headings: headingsAt(file.rows, headerRow) },
      mappings,
      suggestedMappingId: matched?.saved.id ?? null,
    };
  });
  return json(result);
});
