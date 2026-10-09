"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Notice } from "@/components/ui";
import { api } from "@/lib/client/api";

type Similar = {
  companies: Array<{ id: string; name: string; reason: string }>;
  people: Array<{ id: string; name: string; company: string | null }>;
  leads: Array<{ id: string; name: string }>;
};

const REASONS: Record<string, string> = { name: "same name", email: "same email", phone: "same phone" };

/**
 * A warning while adding a company or a lead (decision 494): companies,
 * people and open leads that look like the one being typed. It only warns;
 * saving still works.
 */
export function SimilarRecords({ organisationId, name, email, phone }: { organisationId: string; name?: string; email?: string; phone?: string }) {
  const [similar, setSimilar] = useState<Similar | null>(null);
  useEffect(() => {
    const trimmed = { name: name?.trim() ?? "", email: email?.trim() ?? "", phone: phone?.trim() ?? "" };
    if (trimmed.name.length < 3 && !trimmed.email.includes("@") && trimmed.phone.length < 7) {
      const clear = setTimeout(() => setSimilar(null), 0);
      return () => clearTimeout(clear);
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      api<Similar>("/api/crm/duplicates/similar", {
        method: "POST",
        body: { organisationId, name: trimmed.name || null, email: trimmed.email.includes("@") ? trimmed.email : null, phone: trimmed.phone || null },
      })
        .then((found) => {
          if (!cancelled) setSimilar(found);
        })
        .catch(() => {
          // Only a hint: if it can't be checked, nothing is shown.
          if (!cancelled) setSimilar(null);
        });
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [organisationId, name, email, phone]);
  if (!similar || similar.companies.length + similar.people.length + similar.leads.length === 0) return null;
  return (
    <Notice tone="warning">
      Already in the CRM:
      <ul style={{ margin: "4px 0 0" }}>
        {similar.companies.map((company) => (
          <li key={`c${company.id}`}>
            Company <Link href={`/crm/companies/${company.id}`}>{company.name}</Link> ({REASONS[company.reason] ?? company.reason})
          </li>
        ))}
        {similar.people.map((person) => (
          <li key={`p${person.id}`}>
            Person <Link href={`/crm/people/${person.id}`}>{person.name}</Link>
            {person.company ? ` at ${person.company}` : ""} (same email)
          </li>
        ))}
        {similar.leads.map((lead) => (
          <li key={`l${lead.id}`}>
            Open lead <Link href={`/crm/leads/${lead.id}`}>{lead.name}</Link> (same email)
          </li>
        ))}
      </ul>
    </Notice>
  );
}
