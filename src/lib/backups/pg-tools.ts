import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { getAdminDatabaseUrl } from "@/lib/db/connection";
import { UnavailableError } from "@/lib/errors";

/**
 * Runs PostgreSQL's own pg_dump and pg_restore. They come with PostgreSQL:
 * the Windows installer bundles them (TOHYEE_PG_BIN points at its pgsql\bin),
 * the Docker image installs the client, and elsewhere they're on the PATH.
 * The version must be at least the database server's.
 */
export function pgProgram(name: "pg_dump" | "pg_restore"): string {
  const dir = process.env.TOHYEE_PG_BIN?.trim();
  if (dir) {
    const exe = path.join(dir, process.platform === "win32" ? `${name}.exe` : name);
    if (!existsSync(exe)) {
      throw new UnavailableError(`TOHYEE_PG_BIN is set to ${dir}, but ${path.basename(exe)} isn't there.`);
    }
    return exe;
  }
  return name;
}

/**
 * Connection details for one database as libpq environment variables, using
 * the admin login (which owns the organisation databases). The password goes
 * in PGPASSWORD, never on the command line.
 */
export function pgEnvironment(databaseName: string): NodeJS.ProcessEnv {
  const url = new URL(getAdminDatabaseUrl());
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PGHOST: decodeURIComponent(url.hostname.replace(/^\[|\]$/g, "")) || "localhost",
    PGPORT: url.port || "5432",
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    PGDATABASE: databaseName,
    PGAPPNAME: "tohyee-backup",
  };
  const sslmode = url.searchParams.get("sslmode");
  if (sslmode) env.PGSSLMODE = sslmode;
  const host = url.searchParams.get("host");
  if (host) env.PGHOST = host;
  return env;
}

/** Starts a PostgreSQL tool. Its errors are collected for the message if it fails. */
export function startPgTool(name: "pg_dump" | "pg_restore", args: string[], databaseName: string): { child: ChildProcess; done: Promise<void> } {
  const program = pgProgram(name);
  const child = spawn(program, args, { env: pgEnvironment(databaseName), stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  let errors = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (text: string) => {
    if (errors.length < 4000) errors += text;
  });
  const done = new Promise<void>((resolve, reject) => {
    child.on("error", (error: NodeJS.ErrnoException) => {
      reject(
        error.code === "ENOENT"
          ? new UnavailableError(`${name} wasn't found. Install PostgreSQL's client tools, or set TOHYEE_PG_BIN to the folder they're in.`)
          : error,
      );
    });
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${name} failed (exit code ${code}): ${errors.trim() || "no message"}`));
    });
  });
  return { child, done };
}
