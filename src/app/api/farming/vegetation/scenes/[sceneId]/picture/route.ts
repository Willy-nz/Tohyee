import { route, searchParams, withFarmWork } from "@/lib/api/http";
import { NotFoundError } from "@/lib/errors";
import { scenePicture } from "@/lib/farming/vegetation/service";
import { readPicture } from "@/lib/farming/vegetation/storage";

type Context = { params: Promise<{ sceneId: string }> };

/** GET: a date's map picture (`kind=overlay` or `change`), for people who may see its farm. */
export const GET = route<Context>(async (request, context) => {
  const { sceneId } = await context.params;
  const query = searchParams(request);
  const kind = query.get("kind") === "change" ? "change" : "overlay";
  const { organisationId, picture } = await withFarmWork(request, query.get("organisationId"), "read", async (tx, { membership }) => ({ organisationId: membership.organisation.id, picture: await scenePicture(tx, sceneId, kind) }));
  const bytes = picture ? await readPicture(organisationId, picture.path) : null;
  if (!bytes) throw new NotFoundError("That picture is no longer kept. The numbers worked out from it are.");
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: { "content-type": "image/png", "cache-control": "private, no-store", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; sandbox" },
  });
});
