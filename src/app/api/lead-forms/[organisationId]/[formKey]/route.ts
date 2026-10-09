import { clientAddress } from "@/lib/auth/sessions";
import { receiveFormLead } from "@/lib/crm/lead-intake";

type Context = { params: Promise<{ organisationId: string; formKey: string }> };

/** A form sends a few fields; anything bigger is refused before it's read in full. */
const MAX_BODY_BYTES = 64 * 1024;

function escape(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** A plain page for a browser that posted the form, or JSON for a script. */
function answer(request: Request, status: number, message: string, thankYouUrl: string | null = null): Response {
  const headers: Record<string, string> = { "access-control-allow-origin": "*", "cache-control": "no-store" };
  if ((request.headers.get("accept") ?? "").includes("application/json")) {
    return new Response(JSON.stringify(status < 300 ? { ok: true } : { error: message }), { status, headers: { ...headers, "content-type": "application/json" } });
  }
  if (status < 300 && thankYouUrl) return new Response(null, { status: 303, headers: { ...headers, location: thankYouUrl } });
  const page = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(
    status < 300 ? "Thank you" : "Not sent",
  )}</title></head><body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem"><p>${escape(message)}</p></body></html>`;
  return new Response(page, { status, headers: { ...headers, "content-type": "text/html; charset=utf-8" } });
}

async function readFields(request: Request): Promise<Record<string, string> | null> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) return null;
  const body = Buffer.from(await request.arrayBuffer());
  if (body.length > MAX_BODY_BYTES) return null;
  const type = (request.headers.get("content-type") ?? "").toLowerCase();
  const fields: Record<string, string> = {};
  if (type.startsWith("application/json")) {
    const parsed = JSON.parse(body.toString("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    for (const [name, value] of Object.entries(parsed)) if (typeof value === "string" || typeof value === "number") fields[name.slice(0, 100)] = String(value).slice(0, 5000);
    return fields;
  }
  if (type.startsWith("multipart/form-data")) {
    const form = await new Response(body, { headers: { "content-type": type } }).formData();
    for (const [name, value] of form.entries()) if (typeof value === "string") fields[name.slice(0, 100)] = value.slice(0, 5000);
    return fields;
  }
  for (const [name, value] of new URLSearchParams(body.toString("utf8"))) fields[name.slice(0, 100)] = value.slice(0, 5000);
  return fields;
}

/**
 * Where a website's lead form posts (decision 493). No sign-in: the random
 * form key in the address is what lets it in. See `receiveFormLead`.
 */
export async function POST(request: Request, context: Context): Promise<Response> {
  const { organisationId, formKey } = await context.params;
  let fields: Record<string, string> | null;
  try {
    fields = await readFields(request);
  } catch {
    return answer(request, 400, "The form couldn't be read. Please try again.");
  }
  if (fields === null) return answer(request, 413, "That was too much to send. Please shorten your message.");
  const outcome = await receiveFormLead(organisationId, formKey, fields, clientAddress(request.headers));
  if (outcome.status === "refused") return answer(request, 404, "This form isn't taking messages.");
  if (outcome.status === "limited") return answer(request, 429, "Too many messages have been sent. Please try again later.");
  if (outcome.status === "invalid") return answer(request, 400, `Not sent: ${outcome.message}`);
  return answer(request, 200, "Thank you. We've got your message and will be in touch.", outcome.thankYouUrl);
}
