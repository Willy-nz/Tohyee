import { redirect } from "next/navigation";
import { needsSetup } from "@/lib/auth/service";

// Reads the session/database on every request; never prerender.
export const dynamic = "force-dynamic";

export default async function Home() {
  redirect((await needsSetup()) ? "/setup" : "/operations");
}
