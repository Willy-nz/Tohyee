import { json, readJson, requireAuth, route, searchParams, withOrganisation } from "@/lib/api/http";
import { ValidationError } from "@/lib/errors";
import { getLogo, getLogoInfo, MAX_LOGO_BYTES, removeLogo, saveLogo } from "@/lib/organisations/logo";

type Context = { params: Promise<{ organisationId: string }> };

/**
 * GET: the logo image (viewers and above, for printed documents), or with
 * `info=1` what's saved (null when there's none). PUT (admins): saves a
 * logo sent as `{ fileName, fileBase64 }`, replacing any before it. DELETE
 * (admins): removes it.
 */
export const GET = route<Context>(async (request, context) => {
  const { organisationId } = await context.params;
  if (searchParams(request).get("info") === "1") {
    const logo = await withOrganisation(request, organisationId, "viewer", (tx) => getLogoInfo(tx));
    return json({ logo });
  }
  const logo = await withOrganisation(request, organisationId, "viewer", (tx) => getLogo(tx));
  if (!logo) return json({ error: "There's no logo." }, { status: 404 });
  return new Response(Buffer.from(logo.content), {
    status: 200,
    headers: {
      "content-type": logo.contentType,
      "content-length": String(logo.content.length),
      "cache-control": "private, max-age=300",
      etag: `"${logo.sha256}"`,
      "x-content-type-options": "nosniff",
      "content-security-policy": "sandbox; default-src 'none'",
    },
  });
});

export const PUT = route<Context>(async (request, context) => {
  const { organisationId } = await context.params;
  // Signed in before the body is read.
  await requireAuth(request);
  const length = Number(request.headers.get("content-length") ?? "0");
  if (length > MAX_LOGO_BYTES * 2) throw new ValidationError("A logo can be at most 512 KB.");
  const body = await readJson(request);
  if (typeof body.fileBase64 !== "string" || !/^[A-Za-z0-9+/=\s]*$/.test(body.fileBase64)) {
    throw new ValidationError("Choose a logo file.");
  }
  const content = new Uint8Array(Buffer.from(body.fileBase64, "base64"));
  const logo = await withOrganisation(request, organisationId, "admin", (tx) => saveLogo(tx, { fileName: body.fileName, content }));
  return json({ logo });
});

export const DELETE = route<Context>(async (request, context) => {
  const { organisationId } = await context.params;
  await withOrganisation(request, organisationId, "admin", (tx) => removeLogo(tx));
  return json({ logo: null });
});
