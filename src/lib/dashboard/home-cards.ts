import { addDays } from "@/lib/financial-year";
import type { JobSummary } from "@/lib/projects/jobs";

/**
 * Home's Jobs card (decision 662): open jobs, those with a visit in the next
 * seven days, those with no visit booked, and services due (JV8). Pure, so
 * the screen and its tests share it.
 */
export function jobsAtAGlance(jobs: JobSummary[], servicesDue: number, today: string): { open: number; visitSoon: number; noVisit: number; servicesDue: number } {
  const open = jobs.filter((job) => job.status !== "closed");
  const last = addDays(today, 6);
  const soon = open.filter((job) => job.nextVisit !== null && job.nextVisit.slice(0, 10) <= last);
  return { open: open.length, visitSoon: soon.length, noVisit: open.filter((job) => job.nextVisit === null).length, servicesDue };
}
