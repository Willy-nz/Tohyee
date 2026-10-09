import fs from "node:fs";
import path from "node:path";
import { type ServerAdminAuth, writeAdminAuditEvent } from "@/lib/audit";
import { coreQuery, withCoreTransaction } from "@/lib/db/transactions";
import { ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { analyticsFolder } from "@/lib/analytics/paths";
import { readServerSetting } from "@/lib/server-settings";
import { canListFolder, folderAccessHint } from "@/lib/server-admin/folder-access";

/**
 * The folder on the server each organisation's analytics files are read
 * from (decision 358). Chosen by a server admin, so an organisation can't
 * point Tohyee at other folders on the server. A server setting, in the core
 * database; the files themselves are never copied there.
 */

const KEY = "analytics_folders";
type FoldersValue = { folders: Record<string, string> };

export async function analyticsFolders(): Promise<Record<string, string>> {
  const stored = await readServerSetting<FoldersValue, Record<string, never>>(KEY);
  return { ...(stored.value.folders ?? {}) };
}

/** The organisation's source folder, or null when a server admin hasn't chosen one. */
export async function organisationSourceFolder(organisationId: string): Promise<string | null> {
  return (await analyticsFolders())[organisationId] ?? null;
}

/** For the organisation's own pages: whether a folder is set and readable. The path stays on the server. */
export async function sourceFolderStatus(organisationId: string): Promise<{ chosen: boolean; readable: boolean }> {
  const folder = await organisationSourceFolder(organisationId);
  if (!folder) return { chosen: false, readable: false };
  return { chosen: true, readable: canListFolder(folder) };
}

/** Server admins: every organisation with its folder (or none) and whether it can be read. */
export async function listSourceFolders(): Promise<Array<{ organisationId: string; displayName: string; folder: string | null; readable: boolean }>> {
  const folders = await analyticsFolders();
  const organisations = await coreQuery<{ id: string; display_name: string }>(
    "select id, display_name from organisations where is_active order by display_name",
  );
  return organisations.rows.map((row) => {
    const folder = folders[row.id] ?? null;
    const readable = folder ? canListFolder(folder) : false;
    return { organisationId: row.id, displayName: row.display_name, folder, readable };
  });
}

/** Sets (or, with a blank folder, clears) an organisation's source folder. Server admins only. */
export async function setSourceFolder(auth: ServerAdminAuth, organisationId: string, input: unknown): Promise<string | null> {
  if (!auth.user.isServerAdmin) throw new ForbiddenError("Only a server admin can choose analytics folders.");
  const organisation = await coreQuery<{ id: string }>("select id from organisations where id = $1", [organisationId]);
  if (!organisation.rows[0]) throw new NotFoundError("Organisation not found.");
  if (input !== null && input !== undefined && typeof input !== "string") throw new ValidationError("folder must be a path.");
  const text = (input ?? "").trim();
  let folder: string | null = null;
  if (text) {
    if (!path.isAbsolute(text)) throw new ValidationError("The folder must be a full path, e.g. D:\\Reports\\Glimmers.");
    folder = path.normalize(text);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(/* turbopackIgnore: true */ folder);
    } catch {
      throw new ValidationError("Tohyee can't find that folder. Check it exists.");
    }
    if (!stat.isDirectory()) throw new ValidationError("That's a file, not a folder.");
    if (!canListFolder(folder)) throw new ValidationError(`Tohyee can't open that folder.${folderAccessHint(folder, "read")}`);
    // Tohyee's own analytics data isn't a source.
    const own = path.resolve(analyticsFolder());
    const chosen = path.resolve(/* turbopackIgnore: true */ folder);
    if (chosen === own || chosen.startsWith(own + path.sep) || own.startsWith(chosen + path.sep)) {
      throw new ValidationError("Choose a folder outside Tohyee's own analytics data folder.");
    }
  }
  const folders = await analyticsFolders();
  if (folder) folders[organisationId] = folder;
  else delete folders[organisationId];
  await withCoreTransaction(async (client) => {
    // No secrets, so this works without TOHYEE_SECRET_KEY.
    await client.query(
      `insert into server_settings (key, value, secret_ciphertext, updated_by_email, updated_at)
       values ($1, $2::jsonb, null, $3, now())
       on conflict (key) do update set value = excluded.value, updated_by_email = excluded.updated_by_email, updated_at = now()`,
      [KEY, JSON.stringify({ folders } satisfies FoldersValue), auth.user.email],
    );
    await writeAdminAuditEvent(client, { userId: auth.user.id, email: auth.user.email }, {
      eventType: "server.analytics_folder_updated",
      entityType: "organisation",
      entityId: organisationId,
      details: { folder },
    });
  });
  return folder;
}
