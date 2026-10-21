"use client";
import { Suspense } from "react";
import { RequireOrganisation } from "@/components/books";
import { IncomeTaxView } from "@/components/income-tax";
import { Page } from "@/components/ui";
export default function IncomeTaxPage() {
  return <Page><Suspense fallback={<p>Loading tax workspace…</p>}><RequireOrganisation>{(organisationId) => <IncomeTaxView key={organisationId} organisationId={organisationId} />}</RequireOrganisation></Suspense></Page>;
}
