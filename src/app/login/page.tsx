import { redirect } from "next/navigation";
import { LoginForm } from "@/components/auth/login-form";
import { getPageSession } from "@/lib/auth/page-session";
import { needsSetup } from "@/lib/auth/service";

// Reads the session/database on every request; never prerender.
export const dynamic = "force-dynamic";

export default async function LoginPage() {
  if (await needsSetup()) {
    redirect("/setup");
  }
  if (await getPageSession()) {
    redirect("/operations");
  }
  return <LoginForm />;
}
