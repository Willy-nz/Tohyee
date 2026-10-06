import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJsonPath = path.join(repositoryRoot, "package.json");
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
const version = String(packageJson.version);

const standaloneDir = path.join(repositoryRoot, ".next", "standalone");
const staticDir = path.join(repositoryRoot, ".next", "static");
const publicDir = path.join(repositoryRoot, "public");
const releaseDir = path.join(repositoryRoot, "dist", "release");
const bundleName = `tohyee-v${version}-linux-x64`;
const bundleRoot = path.join(releaseDir, bundleName);
const runtimeRoot = path.join(bundleRoot, ".next", "standalone");
const tarballPath = path.join(releaseDir, `${bundleName}.tar.gz`);
const checksumPath = `${tarballPath}.sha256`;

const tarCheck = spawnSync("tar", ["--version"], { encoding: "utf8" });
if (tarCheck.error || tarCheck.status !== 0) {
  throw new Error(
    "The `tar` command is required to package releases. Install tar and retry `npm run package:release`.",
  );
}

if (!fs.existsSync(standaloneDir)) {
  throw new Error(
    "Missing .next/standalone output. Run `npm run build` with Next.js standalone output first.",
  );
}

fs.rmSync(releaseDir, { recursive: true, force: true });
fs.mkdirSync(bundleRoot, { recursive: true });
fs.mkdirSync(path.dirname(runtimeRoot), { recursive: true });

fs.cpSync(standaloneDir, runtimeRoot, { recursive: true });

// The build can trace data a development server wrote into the working copy
// (DuckDB copies of real books, backups) into .next/standalone (issue #155).
// It's never part of a release.
for (const folder of ["analytics", "backups", "data"]) {
  fs.rmSync(path.join(runtimeRoot, folder), { recursive: true, force: true });
}

const bundledStaticDir = path.join(runtimeRoot, ".next", "static");
fs.mkdirSync(path.dirname(bundledStaticDir), { recursive: true });
if (fs.existsSync(staticDir)) {
  fs.cpSync(staticDir, bundledStaticDir, { recursive: true });
}

if (fs.existsSync(publicDir)) {
  fs.cpSync(publicDir, path.join(runtimeRoot, "public"), { recursive: true });
}

const startScriptPath = path.join(bundleRoot, "start.sh");
fs.writeFileSync(
  startScriptPath,
  "#!/usr/bin/env bash\nset -euo pipefail\nexec env PORT=\"${PORT:-3000}\" node .next/standalone/server.js\n",
  "utf8",
);
fs.chmodSync(startScriptPath, 0o755);

const tarResult = spawnSync("tar", ["-czf", tarballPath, "-C", releaseDir, bundleName], {
  cwd: repositoryRoot,
  encoding: "utf8",
});

if (tarResult.status !== 0) {
  throw new Error(`Failed to create release archive.\n${tarResult.stderr || tarResult.stdout}`);
}

const hash = crypto.createHash("sha256").update(fs.readFileSync(tarballPath)).digest("hex");
fs.writeFileSync(checksumPath, `${hash}  ${path.basename(tarballPath)}\n`, "utf8");

console.log(`Created release bundle: ${tarballPath}`);
console.log(`Created checksum file: ${checksumPath}`);
