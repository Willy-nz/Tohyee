// Builds the Android app's bundled first-run page script (#502):
// android-shell/src/shell.ts → android-shell/www/app.js. Run before
// `npx cap sync android` (the Android workflow does).
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

await build({
  entryPoints: [`${root}android-shell/src/shell.ts`],
  outfile: `${root}android-shell/www/app.js`,
  bundle: true,
  format: "iife",
  target: ["chrome90"],
  minify: true,
  legalComments: "none",
  logLevel: "info",
});
