import { writeAuditEvent } from "@/lib/audit";
import type { OrgTx } from "@/lib/db/org-transaction";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { checkAttachment } from "@/lib/records/file-types";

/**
 * Images on Analytics reports (#376 phase 2, decision 684). Stored in the
 * organisation's database like record attachments, checked the same way
 * (the type from the name, confirmed by the contents), JPG and PNG only, up
 * to 5 MB. An image belongs to one report: reading it needs the same access
 * as reading the report, which the routes check first.
 */

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_IMAGES_PER_DASHBOARD = 40;
const IMAGE_TYPES = new Set(["image/jpeg", "image/png"]);

export type StoredImage = { id: string; fileName: string; contentType: string; byteSize: number };

export async function addDashboardImage(tx: OrgTx, dashboardId: string, file: { fileName: string; content: Uint8Array }): Promise<StoredImage> {
  const checked = checkAttachment(file.fileName, file.content);
  if (!IMAGE_TYPES.has(checked.contentType)) throw new ValidationError(`${checked.fileName} can't be used: a report's images are JPG or PNG.`);
  if (file.content.length > MAX_IMAGE_BYTES) throw new ValidationError(`${checked.fileName} is too big: a report's images can be up to 5 MB.`);
  const count = await tx.query<{ count: string }>("select count(*)::text as count from analytics_dashboard_images where dashboard_id = $1", [dashboardId]);
  if (Number(count.rows[0]?.count ?? 0) >= MAX_IMAGES_PER_DASHBOARD) throw new ValidationError(`A report can have up to ${MAX_IMAGES_PER_DASHBOARD} images.`);
  const result = await tx.query<{ id: string }>(
    `insert into analytics_dashboard_images (dashboard_id, file_name, content_type, byte_size, content, created_by_email)
     values ($1, $2, $3, $4, $5, $6) returning id::text`,
    [dashboardId, checked.fileName, checked.contentType, file.content.length, Buffer.from(file.content), tx.actor.email],
  );
  const id = result.rows[0].id;
  await writeAuditEvent(tx, { eventType: "analytics.dashboard_image_added", entityType: "analytics_dashboard", entityId: dashboardId, details: { image: id, fileName: checked.fileName } });
  return { id, fileName: checked.fileName, contentType: checked.contentType, byteSize: file.content.length };
}

export async function readDashboardImage(tx: OrgTx, dashboardId: string, imageId: string): Promise<{ fileName: string; contentType: string; content: Uint8Array }> {
  const id = /^\d{1,18}$/.test(imageId) ? imageId : "0";
  const result = await tx.query<{ file_name: string; content_type: string; content: Buffer }>(
    "select file_name, content_type, content from analytics_dashboard_images where id = $1 and dashboard_id = $2",
    [id, dashboardId],
  );
  const row = result.rows[0];
  if (!row) throw new NotFoundError("That image wasn't found.");
  return { fileName: row.file_name, contentType: row.content_type, content: new Uint8Array(row.content) };
}

/**
 * When a report's tiles are saved: every image tile must use one of this
 * report's images, and images no tile uses any more are removed (an image
 * uploaded and then not used, or a removed image tile).
 */
export async function checkDashboardImages(tx: OrgTx, dashboardId: string, tiles: Array<{ title: string; visual: string; image?: { id: string } }>): Promise<void> {
  const used = tiles.flatMap((tile) => (tile.visual === "image" && tile.image ? [tile.image.id] : []));
  const result = await tx.query<{ id: string }>("select id::text from analytics_dashboard_images where dashboard_id = $1", [dashboardId]);
  const own = new Set(result.rows.map((row) => row.id));
  const missing = tiles.find((tile) => tile.visual === "image" && tile.image && !own.has(tile.image.id));
  if (missing) throw new ValidationError(`${missing.title}: that image isn't one of this report's. Upload it again.`);
  await tx.query("delete from analytics_dashboard_images where dashboard_id = $1 and not (id = any($2::bigint[]))", [dashboardId, used]);
}
