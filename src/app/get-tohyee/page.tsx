import type { Metadata } from "next";
import { GetTohyee } from "@/components/get-tohyee";

export const metadata: Metadata = {
  title: "Get Tohyee on this device · Tohyee",
  description: "Add Tohyee to your phone or tablet's Home Screen, and what works without a connection.",
};

/** Get Tohyee on this device (#472, decision 991): open to everyone, signed in or not, so it can be sent as a link. */
export default function GetTohyeePage() {
  return <GetTohyee />;
}
