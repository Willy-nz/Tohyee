import fs from "node:fs";
import path from "node:path";
import { type ServerAdminAuth, writeAdminAuditEvent } from "@/lib/audit";
import { coreQuery, withCoreTransaction } from "@/lib/db/transactions";
import { ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { readServerSetting } from "@/lib/server-settings";

/**
 * Each organisation's bank files folder on the server (BF1-BF10, decision
 * 386): the folder its folder feeds read statement files from, one
 * subfolder per bank account. Chosen by a server admin, as Analytics folders
 * are (decision 358), so an organisation can't point Tohyee at other folders
 * on the server. A server setting in the core database; files are only read.
 */

const KEY = "bank_file_folders";
type FoldersValue = { folders: Record<string, string> };

export async function bankFileFolders(): Promise<Record<string, string>> {
  const stored = await readServerSetting<FoldersValue, Record<string, never>>(KEY);
  return { ...(stored.value.folders ?? {}) };
}

/** The organisation's bank files folder, or null when a server admin hasn't chosen one. */
export async function organisationBankFilesFolder(organisationId: string): Promise<string | null> {
  return (await bankFileFolders())[organisationId] ?? null;
}

function readableFolder(folder: string): boolean {
  try {
    fs.accessSync(folder, fs.constants.R_OK);
    return fs.statSync(folder).isDirectory();
  } catch {
    return false;
  }
}

/** For the organisation's own pages: whether a folder is chosen and readable, and its subfolders' names (the path stays on the server). */
export async function bankFilesFolderStatus(organisationId: string): Promise<{ chosen: boolean; readable: boolean; subfolders: string[] }> {
  const folder = await organisationBankFilesFolder(organisationId);
  if (!folder) return { chosen: false, readable: false, subfolders: [] };
  if (!readableFolder(folder)) return { chosen: true, readable: false, subfolders: [] };
  let subfolders: string[] = [];
  try {
    subfolders = fs
      .readdirSync(/* turbopackIgnore: true */ folder, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right));
  } catch {
    subfolders = [];
  }
  return { chosen: true, readable: true, subfolders };
}

/** Server admins: every organisation with its folder (or none) and whether it can be read. */
export async function listBankFileFolders(): Promise<Array<{ organisationId: string; displayName: string; folder: string | null; readable: boolean }>> {
  const folders = await bankFileFolders();
  const organisations = await coreQuery<{ id: string; display_name: string }>(
    "select id, display_name from organisations where is_active order by display_name",
  );
  return organisations.rows.map((row) => {
    const folder = folders[row.id] ?? null;
    return { organisationId: row.id, displayName: row.display_name, folder, readable: folder ? readableFolder(folder) : false };
  });
}

/** Sets (or, with a blank folder, clears) an organisation's bank files folder. Server admins only. */
export async function setBankFilesFolder(auth: ServerAdminAuth, organisationId: string, input: unknown): Promise<string | null> {
  if (!auth.user.isServerAdmin) throw new ForbiddenError("Only a server admin can choose bank files folders.");
  const organisation = await coreQuery<{ id: string }>("select id from organisations where id = $1", [organisationId]);
  if (!organisation.rows[0]) throw new NotFoundError("Organisation not found.");
  if (input !== null && input !== undefined && typeof input !== "string") throw new ValidationError("folder must be a path.");
  const text = (input ?? "").trim();
  let folder: string | null = null;
  if (text) {
    if (!path.isAbsolute(text)) throw new ValidationError("The folder must be a full path, e.g. D:\\BankFiles\\Glimmers.");
    folder = path.normalize(text);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(/* turbopackIgnore: true */ folder);
      fs.accessSync(folder, fs.constants.R_OK);
    } catch {
      throw new ValidationError("Tohyee can't open that folder. Check it exists and the Tohyee service can read it.");
    }
    if (!stat.isDirectory()) throw new ValidationError("That's a file, not a folder.");
  }
  const folders = await bankFileFolders();
  if (folder) folders[organisationId] = folder;
  else delete folders[organisationId];
  await withCoreTransaction(async (client) => {
    await client.query(
      `insert into server_settings (key, value, secret_ciphertext, updated_by_email, updated_at)
       values ($1, $2::jsonb, null, $3, now())
       on conflict (key) do update set value = excluded.value, updated_by_email = excluded.updated_by_email, updated_at = now()`,
      [KEY, JSON.stringify({ folders } satisfies FoldersValue), auth.user.email],
    );
    await writeAdminAuditEvent(client, { userId: auth.user.id, email: auth.user.email }, {
      eventType: "server.bank_files_folder_updated",
      entityType: "organisation",
      entityId: organisationId,
      details: { folder },
    });
  });
  return folder;
}

/**
 * A subfolder of the organisation's bank files folder, resolved and checked
 * to stay inside it (BF9): a plain name, no `..`, no separators, and its real
 * path (after links) still under the folder. Null when it's not usable.
 */
export function resolveSubfolder(root: string, name: string): string | null {
  if (!name || name === "." || name === ".." || /[\\/]/.test(name) || name.includes("\u0000")) return null;
  try {
    const realRoot = fs.realpathSync(root);
    const real = fs.realpathSync(path.join(root, name));
    if (!real.startsWith(realRoot + path.sep)) return null;
    return fs.statSync(real).isDirectory() ? real : null;
  } catch {
    return null;
  }
}
