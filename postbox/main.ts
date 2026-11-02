import { X509Certificate } from "node:crypto";
import { readFile } from "node:fs/promises";
import { postboxConfig } from "@/lib/camera-postbox/box/config";
import { POSTBOX_VERSION, startPostbox } from "@/lib/camera-postbox/box/server";
import { newPairingCode, paths } from "@/lib/camera-postbox/box/state";
import { callBox } from "@/lib/camera-postbox/client";
import { decodePairingCode, displayFingerprint, normaliseFingerprint } from "@/lib/camera-postbox/protocol";

/*
 * The camera post box program (decisions 1226-1233). Bundled into one file
 * with no dependencies by scripts/build-postbox.mjs, and run in its own
 * Docker image (postbox/Dockerfile) on a small rented server:
 *
 *   node postbox.cjs serve          runs it
 *   node postbox.cjs pairing-code   makes a new one-time pairing code for Tohyee (works for a day)
 *   node postbox.cjs health         exits 0 when it's answering (Docker's health check)
 */

async function main(command: string | undefined) {
  const config = postboxConfig(process.env);
  if (command === "health") {
    // Checked as Tohyee checks it: pinned to the post box's own certificate.
    const fingerprint = normaliseFingerprint(new X509Certificate(await readFile(config.certPath ?? paths(config.dataDir).cert)).raw);
    const ok = await callBox({ address: "127.0.0.1", port: config.apiPort, tlsMode: "pinned", fingerprint, token: null }, { method: "GET", path: "/v1/health", auth: false }).then(
      (answer) => answer.ok === true,
      () => false,
    );
    process.exit(ok ? 0 : 1);
  }
  if (command === "pairing-code") {
    const code = await newPairingCode(config);
    const parsed = decodePairingCode(code)!;
    console.log("");
    console.log("Pairing code for Tohyee (Farm > Security > Post box). It works once, within 24 hours:");
    console.log("");
    console.log(code);
    console.log("");
    console.log(`Post box address: ${parsed.address}, port ${parsed.port}`);
    console.log(`Certificate fingerprint: ${displayFingerprint(parsed.fingerprint)}`);
    console.log("");
    return;
  }
  if (command === "serve" || command === undefined) {
    const box = await startPostbox(config);
    console.log(`Tohyee camera post box ${POSTBOX_VERSION}: cameras on port ${config.ftpPublicPort} (FTPS), Tohyee on port ${config.apiPublicPort} (HTTPS). Listening on ${box.ftpPort} and ${box.apiPort}.`);
    const stop = () => {
      void box.close().then(() => process.exit(0));
    };
    process.on("SIGTERM", stop);
    process.on("SIGINT", stop);
    return;
  }
  console.error("Use: node postbox.cjs serve | pairing-code | health");
  process.exit(2);
}

main(process.argv[2]).catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
