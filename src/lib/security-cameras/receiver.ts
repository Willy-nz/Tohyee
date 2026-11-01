import { readFileSync } from "node:fs";
import { startCameraReceiver, type CameraReceiver } from "@/lib/security-cameras/ftp-receiver";
import { authenticateCamera, ingestUpload } from "@/lib/security-cameras/ingest";
import { incomingFolder } from "@/lib/security-cameras/storage";

/*
 * Starts the camera upload receiver from the server's settings (#508,
 * decision 1219). Off unless TOHYEE_CAMERA_FTP_PORT is set: it opens a port
 * to the internet, so it's never on by surprise. FTPS needs a certificate
 * (TOHYEE_CAMERA_FTP_TLS_CERT and _KEY, PEM files); plain FTP sends the
 * camera's password readable, so it only starts without one when
 * TOHYEE_CAMERA_FTP_ALLOW_PLAIN=on (a camera on the same network).
 */

export type ReceiverSettings = {
  port: number;
  host: string;
  passivePorts: [number, number];
  publicAddress: string | null;
  certPath: string | null;
  keyPath: string | null;
  allowPlain: boolean;
  maxFileBytes: number;
};

/** The settings from the environment, or why the receiver stays off. Pure (given `env`); tested. */
export function receiverSettings(env: Record<string, string | undefined>): ReceiverSettings | { off: string } {
  const portText = env.TOHYEE_CAMERA_FTP_PORT?.trim();
  if (!portText || portText === "off") return { off: "TOHYEE_CAMERA_FTP_PORT isn't set" };
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { off: "TOHYEE_CAMERA_FTP_PORT isn't a port number" };
  const range = (env.TOHYEE_CAMERA_FTP_PASSIVE_PORTS?.trim() || "50000-50019").split("-").map(Number);
  if (range.length !== 2 || !range.every((value) => Number.isInteger(value) && value > 0 && value <= 65535) || range[0] > range[1] || range[1] - range[0] > 1000) {
    return { off: "TOHYEE_CAMERA_FTP_PASSIVE_PORTS isn't a range like 50000-50019" };
  }
  const certPath = env.TOHYEE_CAMERA_FTP_TLS_CERT?.trim() || null;
  const keyPath = env.TOHYEE_CAMERA_FTP_TLS_KEY?.trim() || null;
  if ((certPath === null) !== (keyPath === null)) return { off: "set both TOHYEE_CAMERA_FTP_TLS_CERT and TOHYEE_CAMERA_FTP_TLS_KEY" };
  const allowPlain = env.TOHYEE_CAMERA_FTP_ALLOW_PLAIN?.trim() === "on";
  if (!certPath && !allowPlain) return { off: "there's no FTPS certificate (TOHYEE_CAMERA_FTP_TLS_CERT and _KEY), and plain FTP isn't allowed" };
  const megabytes = Number(env.TOHYEE_CAMERA_MAX_FILE_MB?.trim() || "200");
  if (!Number.isFinite(megabytes) || megabytes < 1 || megabytes > 2048) return { off: "TOHYEE_CAMERA_MAX_FILE_MB must be 1 to 2048" };
  return {
    port,
    host: env.TOHYEE_CAMERA_FTP_HOST?.trim() || "0.0.0.0",
    passivePorts: [range[0], range[1]],
    publicAddress: env.TOHYEE_CAMERA_FTP_PUBLIC_ADDRESS?.trim() || null,
    certPath,
    keyPath,
    allowPlain,
    maxFileBytes: Math.round(megabytes * 1024 * 1024),
  };
}

const holder = globalThis as typeof globalThis & { __tohyeeCameraReceiver?: Promise<CameraReceiver | null> };

export function startCameraUploads(): Promise<CameraReceiver | null> {
  holder.__tohyeeCameraReceiver ??= (async () => {
    const settings = receiverSettings(process.env);
    if ("off" in settings) {
      if (process.env.TOHYEE_CAMERA_FTP_PORT) console.warn(`[tohyee] Camera uploads are off: ${settings.off}.`);
      return null;
    }
    try {
      const receiver = await startCameraReceiver({
        host: settings.host,
        port: settings.port,
        tls: settings.certPath && settings.keyPath ? { cert: readFileSync(settings.certPath), key: readFileSync(settings.keyPath) } : null,
        allowPlain: settings.allowPlain,
        passivePorts: settings.passivePorts,
        publicAddress: settings.publicAddress,
        maxFileBytes: settings.maxFileBytes,
        incomingFolder: incomingFolder(),
        authenticate: (username, password) => authenticateCamera(username, password),
        receive: async (uploader, file) => (await ingestUpload(uploader, file)).status,
        log: (message) => console.warn(`[tohyee] ${message}`),
      });
      console.log(`[tohyee] Camera uploads: listening on port ${receiver.port}${settings.certPath ? " (FTPS)" : " (plain FTP allowed)"}.`);
      return receiver;
    } catch (error) {
      console.warn("[tohyee] Camera uploads couldn't start:", error instanceof Error ? error.message : error);
      return null;
    }
  })();
  return holder.__tohyeeCameraReceiver;
}
