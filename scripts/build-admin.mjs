// Bundles the command-line tool (scripts/admin.ts) into one file,
// dist/tohyee-admin.cjs, that runs with plain Node: no TypeScript, no
// node_modules. The Docker image and the Windows installer ship it next to the
// server, so `node tohyee-admin.cjs help` works on a server without a checkout
// of this repository.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outfile = path.join(root, "dist", "tohyee-admin.cjs");

await build({
  entryPoints: [path.join(root, "scripts", "admin.ts")],
  outfile,
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  tsconfig: path.join(root, "tsconfig.json"),
  // pg's optional native binding; the pure JavaScript driver is used. DuckDB
  // and the database drivers stay outside the bundle, as they do for the
  // server (next.config.ts): the demo farm's Analytics step (#437) loads them
  // from the server's node_modules beside this file, and only when it runs.
  external: ["pg-native", "@duckdb/node-api", "@duckdb/node-bindings", "mysql2", "mssql", "tedious"],
  legalComments: "none",
  logLevel: "warning",
});
console.log(`Built ${path.relative(root, outfile)}`);
