import { redirect } from "next/navigation";
import { SetupForm } from "@/components/auth/setup-form";
import { needsSetup } from "@/lib/auth/service";

// Reads the session/database on every request; never prerender.
export const dynamic = "force-dynamic";

export default async function SetupPage() {
  if (!(await needsSetup())) {
    redirect("/login");
  }
  return <SetupForm />;
}
