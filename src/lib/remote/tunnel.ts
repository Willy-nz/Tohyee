import { type ChildProcess, spawn } from "node:child_process";
import { createServer } from "node:net";

/**
 * Runs Cloudflare's `cloudflared` connector so this server can be reached
 * from anywhere through a Cloudflare Tunnel, without opening router ports.
 * Tohyee only needs the tunnel's token: from the Tohyee address service, from
 * the server app's Connect to Cloudflare, or pasted from Cloudflare's
 * dashboard. One connector per server process, kept on globalThis so every
 * route bundle sees the same one.
 *
 * It runs `cloudflared tunnel run --url http://127.0.0.1:<port>` with the
 * token in TUNNEL_TOKEN. A tunnel made in Cloudflare's dashboard (or by the
 * address service) is "remotely managed": Cloudflare sends its routes to the
 * connector, and they replace the --url. A tunnel made with `cloudflared tunnel
 * create` (Connect to Cloudflare) has no routes of its own, so --url is what
 * sends its address to Tohyee; without it cloudflared answers 503 to
 * everything (cloudflared's ingress/ingress.go, ParseIngressFromConfigAndCLI).
 */
export type TunnelStatus = "off" | "starting" | "connected" | "reconnecting" | "error" | "missing_program";

export type TunnelState = {
  status: TunnelStatus;
  message: string | null;
  startedAt: string | null;
  connectedAt: string | null;
  restarts: number;
  program: string | null;
  log: string[];
};

type Runner = {
  child: ChildProcess | null;
  token: string | null;
  /** Where the connector sends requests when the tunnel has no routes of its own. */
  service: string | null;
  metricsPort: number | null;
  restartTimer: NodeJS.Timeout | null;
  state: TunnelState;
  version: number;
};

const LOG_LINES = 60;
const MAX_BACKOFF_MS = 5 * 60 * 1000;
const holder = globalThis as typeof globalThis & { __tohyeeTunnel?: Runner };

function runner(): Runner {
  holder.__tohyeeTunnel ??= {
    child: null,
    token: null,
    service: null,
    metricsPort: null,
    restartTimer: null,
    version: 0,
    state: { status: "off", message: null, startedAt: null, connectedAt: null, restarts: 0, program: null, log: [] },
  };
  return holder.__tohyeeTunnel;
}

let commandForTests: { program: string; prefix: string[] } | null = null;
/** Lets tests run a stand-in for cloudflared (e.g. node and a script). */
export function setTunnelCommandForTests(command: { program: string; prefix: string[] } | null): void {
  commandForTests = command;
}

/**
 * Where cloudflared is: TOHYEE_CLOUDFLARED_PATH (the Windows installer and the
 * Docker image set it), otherwise whatever `cloudflared` is on the PATH.
 */
export function cloudflaredProgram(): string {
  return process.env.TOHYEE_CLOUDFLARED_PATH?.trim() || (process.platform === "win32" ? "cloudflared.exe" : "cloudflared");
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function remember(line: string): void {
  const state = runner().state;
  // cloudflared never prints the token, but make sure a pasted one can't reach the page.
  const clean = line.replace(/eyJ[A-Za-z0-9_-]{20,}/g, "[token]").slice(0, 400);
  state.log = [...state.log, clean].slice(-LOG_LINES);
  if (/Registered tunnel connection/i.test(clean)) {
    if (state.status !== "connected") state.connectedAt = new Date().toISOString();
    state.status = "connected";
    state.message = null;
  } else if (/\b(ERR|FTL)\b/.test(clean)) {
    const text = clean.replace(/^\S+\s+(ERR|FTL)\s+/, "").trim();
    if (/Unauthorized|Invalid tunnel secret|token|not found/i.test(text)) {
      state.status = "error";
      state.message = `Cloudflare refused the tunnel: ${text}`;
    } else if (state.status === "connected") {
      state.status = "reconnecting";
      state.message = text;
    } else {
      state.message = text;
    }
  }
}

function attachLines(stream: NodeJS.ReadableStream | null): void {
  if (!stream) return;
  let buffered = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    buffered += chunk;
    const lines = buffered.split(/\r?\n/);
    buffered = lines.pop() ?? "";
    for (const line of lines) if (line.trim()) remember(line);
  });
}

async function launch(version: number): Promise<void> {
  const current = runner();
  if (current.version !== version || !current.token) return;
  const program = commandForTests?.program ?? cloudflaredProgram();
  const prefix = commandForTests?.prefix ?? [];
  const service = current.service ? ["--url", current.service] : [];
  current.metricsPort = await freePort();
  if (current.version !== version) return;
  current.state = {
    ...current.state,
    status: current.state.restarts > 0 ? "reconnecting" : "starting",
    startedAt: new Date().toISOString(),
    program,
  };
  let child: ChildProcess;
  try {
    child = spawn(/* turbopackIgnore: true */ program, [...prefix, "tunnel", "--no-autoupdate", "--metrics", `127.0.0.1:${current.metricsPort}`, "run", ...service], {
      env: { ...process.env, TUNNEL_TOKEN: current.token },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch (error) {
    current.state.status = "missing_program";
    current.state.message = `cloudflared couldn't be started (${error instanceof Error ? error.message : String(error)}).`;
    return;
  }
  current.child = child;
  attachLines(child.stdout);
  attachLines(child.stderr);
  child.on("error", (error: NodeJS.ErrnoException) => {
    if (runner().version !== version) return;
    if (error.code === "ENOENT") {
      current.state.status = "missing_program";
      current.state.message = `cloudflared isn't installed where Tohyee looked (${program}). The Windows installer includes it; elsewhere install it or set TOHYEE_CLOUDFLARED_PATH.`;
      current.child = null;
    } else {
      current.state.status = "error";
      current.state.message = error.message;
    }
  });
  child.on("exit", (code) => {
    const now = runner();
    if (now.child === child) now.child = null;
    if (now.version !== version || !now.token || now.state.status === "missing_program") return;
    // Crashed or refused: try again, waiting longer each time (up to 5 minutes).
    now.state.restarts += 1;
    if (now.state.status !== "error") now.state.status = "reconnecting";
    now.state.message ??= `cloudflared stopped (exit code ${code ?? "none"}).`;
    const wait = Math.min(MAX_BACKOFF_MS, 5000 * 2 ** Math.min(now.state.restarts - 1, 6));
    now.restartTimer = setTimeout(() => void launch(version), wait);
    now.restartTimer.unref?.();
  });
}

function killChild(current: Runner): void {
  if (current.restartTimer) clearTimeout(current.restartTimer);
  current.restartTimer = null;
  const child = current.child;
  current.child = null;
  if (child && child.exitCode === null) child.kill();
}

/** Starts (or restarts with a new token) the tunnel connector, sending requests to `service` (e.g. http://127.0.0.1:3000). */
export function startTunnel(token: string, service: string | null = null): void {
  const current = runner();
  if (current.token === token && current.service === service && (current.child || current.restartTimer)) return;
  killChild(current);
  current.token = token;
  current.service = service;
  current.version += 1;
  current.state = { status: "starting", message: null, startedAt: null, connectedAt: null, restarts: 0, program: null, log: [] };
  void launch(current.version);
}

/** Stops the tunnel connector. */
export function stopTunnel(): void {
  const current = runner();
  current.version += 1;
  current.token = null;
  killChild(current);
  current.state = { ...current.state, status: "off", message: null, connectedAt: null };
}

/**
 * The connector's state, checked against cloudflared's own readiness endpoint
 * (it answers 200 once at least one connection to Cloudflare is up).
 */
export async function tunnelState(): Promise<TunnelState> {
  const current = runner();
  if (current.child && current.metricsPort) {
    try {
      const response = await fetch(`http://127.0.0.1:${current.metricsPort}/ready`, { signal: AbortSignal.timeout(2000) });
      if (response.ok) {
        if (current.state.status !== "connected") current.state.connectedAt ??= new Date().toISOString();
        current.state.status = "connected";
        current.state.message = null;
      } else if (current.state.status === "connected") {
        current.state.status = "reconnecting";
      }
    } catch {
      // Not listening yet (still starting) or stopped; keep what the log says.
    }
  }
  return { ...current.state, log: [...current.state.log] };
}

let exitHookAdded = false;
/** Makes sure cloudflared stops when the server does. */
export function stopTunnelOnExit(): void {
  if (exitHookAdded) return;
  exitHookAdded = true;
  process.once("exit", () => killChild(runner()));
}
