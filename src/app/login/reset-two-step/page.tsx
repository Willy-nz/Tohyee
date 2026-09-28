import { ResetTwoStepForm } from "@/components/auth/reset-two-step-form";

// Reads the token from the link; never prerender.
export const dynamic = "force-dynamic";

export default async function ResetTwoStepPage({ searchParams }: PageProps<"/login/reset-two-step">) {
  const params = await searchParams;
  const token = typeof params.token === "string" ? params.token : "";
  return <ResetTwoStepForm token={token} />;
}
