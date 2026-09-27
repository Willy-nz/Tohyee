// Packages the Windows (Docker Desktop) installer into
// dist/release/tohyee-v<version>-windows.zip, with this release's version
// written into Install-Tohyee.ps1 so it runs that version's image.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const version = String(JSON.parse(fs.readFileSync(path.join(repositoryRoot, "package.json"), "utf8")).version);
const sourceDir = path.join(repositoryRoot, "deploy", "windows");
const releaseDir = path.join(repositoryRoot, "dist", "release");
const folderName = `tohyee-v${version}-windows`;
const folder = path.join(releaseDir, folderName);
const zipPath = path.join(releaseDir, `${folderName}.zip`);

const zipCheck = spawnSync("zip", ["-v"], { encoding: "utf8" });
if (zipCheck.error || zipCheck.status !== 0) {
  throw new Error("The `zip` command is required to package the Windows release.");
}

fs.rmSync(folder, { recursive: true, force: true });
fs.rmSync(zipPath, { force: true });
fs.mkdirSync(folder, { recursive: true });

for (const name of fs.readdirSync(sourceDir)) {
  let content = fs.readFileSync(path.join(sourceDir, name), "utf8");
  if (name === "Install-Tohyee.ps1") {
    if (!content.includes("'__TOHYEE_VERSION__'")) {
      throw new Error("Install-Tohyee.ps1 is missing the __TOHYEE_VERSION__ placeholder.");
    }
    content = content.replace("'__TOHYEE_VERSION__'", `'${version}'`);
  }
  if (name.endsWith(".cmd") || name.endsWith(".ps1") || name.endsWith(".txt")) {
    // Windows line endings, so Notepad and cmd.exe are happy.
    content = content.replace(/\r?\n/g, "\r\n");
  }
  fs.writeFileSync(path.join(folder, name), content, "utf8");
}

const zipResult = spawnSync("zip", ["-r", "-X", zipPath, folderName], { cwd: releaseDir, encoding: "utf8" });
if (zipResult.status !== 0) {
  throw new Error(`Failed to create the Windows zip.\n${zipResult.stderr || zipResult.stdout}`);
}
fs.rmSync(folder, { recursive: true, force: true });

const hash = crypto.createHash("sha256").update(fs.readFileSync(zipPath)).digest("hex");
fs.writeFileSync(`${zipPath}.sha256`, `${hash}  ${path.basename(zipPath)}\n`, "utf8");
console.log(`Created Windows release: ${zipPath}`);
