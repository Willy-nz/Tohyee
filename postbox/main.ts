import https from "node:https";
import { postboxConfig } from "@/lib/camera-postbox/box/config";
import { POSTBOX_VERSION, startPostbox } from "@/lib/camera-postbox/box/server";
import { newPairingCode } from "@/lib/camera-postbox/box/state";
import { displayFingerprint, decodePairingCode } from "@/lib/camera-postbox/protocol";

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
  if (command === "health") {
    const port = Number(process.env.POSTBOX_API_PORT || 8443);
    // Its own certificate on its own machine: only "is it answering" is checked here.
    const ok = await new Promise<boolean>((resolve) => {
      const request = https.get({ host: "127.0.0.1", port, path: "/v1/health", rejectUnauthorized: false, timeout: 4000 }, (response) => {
        response.resume();
        resolve(response.statusCode === 200);
      });
      request.on("error", () => resolve(false));
      request.on("timeout", () => request.destroy());
    });
    process.exit(ok ? 0 : 1);
  }
  const config = postboxConfig(process.env);
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
