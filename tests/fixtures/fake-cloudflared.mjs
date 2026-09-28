// A stand-in for cloudflared in tests: `tunnel --no-autoupdate --metrics HOST:PORT run`.
// A token containing "bad" is refused like Cloudflare would; otherwise it
// "connects", logs like cloudflared does and answers /ready with 200.
import { createServer } from "node:http";

const metrics = process.argv[process.argv.indexOf("--metrics") + 1];
const [host, port] = metrics.split(":");
const token = process.env.TUNNEL_TOKEN ?? "";
const now = () => new Date().toISOString().replace(/\.\d+Z$/, "Z");
process.stderr.write(`${now()} INF Starting tunnel tunnelID=test\n`);
if (Buffer.from(token, "base64").toString("utf8").includes("YmFk")) {
  process.stderr.write(`${now()} ERR Register tunnel error from server side error="Unauthorized: Invalid tunnel secret"\n`);
  process.exit(1);
}
let ready = false;
createServer((request, response) => {
  response.writeHead(ready ? 200 : 503, { "content-type": "application/json" });
  response.end(JSON.stringify({ status: ready ? 200 : 503, readyConnections: ready ? 4 : 0 }));
}).listen(Number(port), host, () => {
  setTimeout(() => {
    ready = true;
    process.stderr.write(`${now()} INF Registered tunnel connection connIndex=0 location=akl01 protocol=quic\n`);
  }, 200);
});
process.on("SIGTERM", () => process.exit(0));
