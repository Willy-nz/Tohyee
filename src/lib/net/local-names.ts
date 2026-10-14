import { isIP } from "node:net";
import { privateAddress } from "@/lib/analytics/mail-host";

/** Names that only mean something on a local network: one word ("farm-pc"), or a local-only or reserved ending (.test is never on the internet). */
const LOCAL_SUFFIXES = [".localhost", ".local", ".lan", ".home", ".home.arpa", ".internal", ".localdomain", ".test"];

/** Whether a Host value names this computer or the local network (decision 534). */
export function localHostName(value: string): boolean {
  let name = value.trim().toLowerCase();
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(name);
  if (bracketed) name = bracketed[1];
  else if (isIP(name) !== 6) name = name.split(":")[0];
  name = name.replace(/\.$/, "");
  if (name === "") return true;
  if (isIP(name)) return privateAddress(name);
  if (name === "localhost" || !name.includes(".")) return true;
  return LOCAL_SUFFIXES.some((suffix) => name.endsWith(suffix));
}
