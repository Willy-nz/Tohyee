import { json, MAX_FILE_JSON_BYTES, readJson, route, withOrganisation } from "@/lib/api/http";
import { ValidationError } from "@/lib/errors";
import { checkSigningCopy } from "@/lib/signing/service";

type Context = { params: Promise<{ requestId: string }> };

/** POST `{ contentBase64 }`: checks a copy against the signed copy kept (its SHA-256). Nothing is saved. */
export const POST = route<Context>(async (request, context) => {
  const { requestId } = await context.params;
  const body = await readJson(request, { maxBytes: MAX_FILE_JSON_BYTES * 2 });
  if (typeof body.contentBase64 !== "string" || !body.contentBase64) throw new ValidationError("Choose the PDF to check.");
  const bytes = new Uint8Array(Buffer.from(body.contentBase64, "base64"));
  const result = await withOrganisation(request, body.organisationId, "farm_worker", (tx) => checkSigningCopy(tx, bytes, requestId));
  return json(result);
});
