/**
 * `verify.mjs`, put in every WorkSafe pack (#446, decision 934): a short
 * Node.js script with no dependencies that checks the pack on any computer,
 * the same way Tohyee does (src/lib/safety/chain.ts). Run it with
 * `node verify.mjs` in the unzipped folder.
 */
export const PACK_VERIFY_SCRIPT = String.raw`// Checks a Tohyee farm safety pack. Run: node verify.mjs  (in the unzipped folder)
import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const folder = process.argv[2] ?? dirname(fileURLToPath(import.meta.url));
const read = (name) => JSON.parse(readFileSync(join(folder, name), "utf8"));
const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const entries = read("entries.json");
const chain = read("chain.json");
const problems = [];

// 1. The whole chain of hashes: numbers go up by one, each names the one before.
let previous = "0".repeat(64);
chain.forEach((link, index) => {
  if (String(index + 1) !== link.seq) problems.push("Entry " + link.seq + ": the numbers skip or repeat.");
  if (link.previousHash !== previous) problems.push("Entry " + link.seq + ": doesn't follow on from the entry before it.");
  previous = link.hash;
});
const bySeq = new Map(chain.map((link) => [link.seq, link]));

// 2. Each entry in the pack: its details give its hash, and that hash is in the chain.
let checked = 0;
let withheld = 0;
for (const e of entries) {
  const link = bySeq.get(e.seq);
  if (!link || link.hash !== e.hash || link.previousHash !== e.previousHash) problems.push("Entry " + e.seq + ": isn't the entry the chain has at that number.");
  if (e.body === null) { withheld += 1; continue; }
  const text = ["tohyee-safety-entry-v1", e.seq, e.kind, e.recordId, String(e.version), e.change, e.farmId ?? "",
    e.restricted ? "true" : "false", e.happenedOn ?? "", e.enteredAt, e.enteredByUserId ?? "", e.enteredByEmail,
    e.via ?? "", e.operationId ?? "", e.body, e.previousHash].join("\n");
  if (sha256(text) !== e.hash) problems.push("Entry " + e.seq + ": its details don't match its hash (changed after it was saved).");
  else checked += 1;
}

// 3. Photos and documents: each file's hash matches the one recorded.
let files = 0;
if (existsSync(join(folder, "files.json"))) {
  for (const f of read("files.json")) {
    if (!f.path) continue;
    const content = readFileSync(join(folder, f.path));
    if (sha256(content) !== f.sha256) problems.push("File " + f.path + ": doesn't match its recorded hash.");
    else files += 1;
  }
}

const head = chain.at(-1);
console.log("Entries checked: " + checked + (withheld ? " (and " + withheld + " restricted, withheld from this pack: only their place in the chain was checked)" : ""));
console.log("Files checked: " + files);
console.log("Chain: " + chain.length + " entries; latest is number " + (head ? head.seq + ", hash " + head.hash : "none"));
console.log("To check nothing was rewritten later, compare that number and hash with a copy sent off the farm (the weekly email).");
if (problems.length) {
  console.log("\nPROBLEMS FOUND:");
  for (const p of problems) console.log(" - " + p);
  process.exitCode = 1;
} else {
  console.log("\nEverything in this pack checks out.");
}
`;
