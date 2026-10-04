import path from "node:path";
import { ValidationError } from "@/lib/errors";

/**
 * Where analytics data files live. Kept apart from the engine so code that
 * only needs the folder (server settings, the command-line tool) doesn't
 * load DuckDB.
 */

/** Where the analytics files are kept (not the folder sources are read from). */
export function analyticsFolder(): string {
  const configured = process.env.TOHYEE_ANALYTICS_DIR?.trim();
  if (configured) return configured;
  if (process.platform === "win32") {
    return path.join(process.env.ProgramData || "C:\\ProgramData", "Tohyee", "analytics");
  }
  return path.join(process.cwd(), "analytics");
}

const ORGANISATION_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;

export function analyticsFilePath(organisationId: string): string {
  if (!ORGANISATION_ID.test(organisationId)) throw new ValidationError("Unknown organisation.");
  return path.join(analyticsFolder(), `${organisationId}.duckdb`);
}

/**
 * The organisation's own working folder inside the analytics folder: the
 * only part of it that organisation's DuckDB may touch (decision 377), for
 * temporary files while sorting or loading. The analytics folder itself
 * holds every organisation's file, so it is never allowed as a whole.
 */
export function analyticsWorkFolder(organisationId: string): string {
  if (!ORGANISATION_ID.test(organisationId)) throw new ValidationError("Unknown organisation.");
  return path.join(analyticsFolder(), `${organisationId}.work`);
}
