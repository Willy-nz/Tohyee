import { readJson } from "@/lib/api/http";
import { optionalFormFile, readUploadForm } from "@/lib/api/upload";
import { ValidationError } from "@/lib/errors";

/**
 * A request body that's JSON, or a multipart form with the JSON in a "data"
 * field and files beside it (leave records that keep a written request or
 * agreement, P8). Files are only read from a form.
 */
export async function readJsonOrForm(
  request: Request,
  fileFields: readonly string[],
): Promise<{ body: Record<string, unknown>; files: Record<string, { fileName: string; content: Uint8Array } | null> }> {
  const type = request.headers.get("content-type") ?? "";
  if (!type.includes("multipart/form-data")) return { body: await readJson(request), files: Object.fromEntries(fileFields.map((field) => [field, null])) };
  const form = await readUploadForm(request);
  const data = form.get("data");
  let body: Record<string, unknown> = {};
  if (typeof data === "string" && data.trim() !== "") {
    try {
      const parsed: unknown = JSON.parse(data);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
      body = parsed as Record<string, unknown>;
    } catch {
      throw new ValidationError("The form's data field must be a JSON object.");
    }
  }
  const files: Record<string, { fileName: string; content: Uint8Array } | null> = {};
  for (const field of fileFields) files[field] = await optionalFormFile(form, field);
  return { body, files };
}
