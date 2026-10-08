import { SetupAccountForm } from "@/components/auth/setup-account-form";

// Reads the token from the link; never prerender.
export const dynamic = "force-dynamic";

export default async function SetupAccountPage({ searchParams }: PageProps<"/login/setup-account">) {
  const params = await searchParams;
  const token = typeof params.token === "string" ? params.token : "";
  return <SetupAccountForm token={token} />;
}
