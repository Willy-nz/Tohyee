import { redirect } from "next/navigation";
import { readSafetyLink, safetyHref } from "@/lib/safety/screens";

/**
 * The first Safety page's address (#446). Safety now lives in the farmer's
 * workspace as an overview and focused screens (decision 976); this keeps
 * old links and machines' printed QR codes (`?farm=&equipment=`) working,
 * opening the same farm and machine there.
 */
export default async function OldFarmSafetyPage({ searchParams }: PageProps<"/operations/farming/safety">) {
  const params = await searchParams;
  redirect(safetyHref(readSafetyLink({ get: (name) => (typeof params[name] === "string" ? (params[name] as string) : null) })));
}
