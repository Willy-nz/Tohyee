// Bundles the camera post box (postbox/main.ts, decisions 1226-1233) into one
// file, dist/tohyee-postbox.cjs, that runs with plain Node: no TypeScript, no
// node_modules. postbox/Dockerfile runs this and ships only that file.
import { readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outfile = path.join(root, "dist", "tohyee-postbox.cjs");

await build({
  entryPoints: [path.join(root, "postbox", "main.ts")],
  outfile,
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  tsconfig: path.join(root, "tsconfig.json"),
  legalComments: "none",
  logLevel: "warning",
});

// The post box must need nothing but Node itself: fail the build if anything else is required.
const builtins = new Set([...builtinModules, ...builtinModules.map((name) => `node:${name}`)]);
const required = [...readFileSync(outfile, "utf8").matchAll(/require\("([^"]+)"\)/g)].map((match) => match[1]);
const outside = [...new Set(required.filter((name) => !builtins.has(name)))];
if (outside.length) {
  console.error(`The post box bundle requires packages it won't have: ${outside.join(", ")}`);
  process.exit(1);
}
console.log(`Built ${path.relative(root, outfile)}`);
