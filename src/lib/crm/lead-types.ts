/** Leads (decision 492): what the screens and the server share. Browser-safe. */
export const LEAD_STATUSES = ["new", "working", "unqualified", "converted"] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];
export const LEAD_STATUS_LABELS: Record<LeadStatus, string> = { new: "New", working: "Working", unqualified: "Unqualified", converted: "Converted" };
export const LEAD_SOURCES = ["manual", "import", "web_form", "email"] as const;
export type LeadSource = (typeof LEAD_SOURCES)[number];
export const LEAD_SOURCE_LABELS: Record<LeadSource, string> = { manual: "Typed in", import: "Imported", web_form: "Web form", email: "Email" };

/** At most this many rows in one lead import. */
export const MAX_LEAD_IMPORT_ROWS = 2000;

export type Lead = {
  id: string;
  firstName: string | null;
  lastName: string | null;
  /** The person's name, else the company's, else the email: what the lead is called in lists. */
  name: string;
  companyName: string | null;
  email: string | null;
  phone: string | null;
  jobTitle: string | null;
  description: string | null;
  source: LeadSource;
  sourceDetail: string | null;
  status: LeadStatus;
  unqualifiedReason: string | null;
  /** From a web form or email, waiting for someone to look at it (decision 492). */
  needsReview: boolean;
  ownerUserId: string | null;
  convertedAt: string | null;
  convertedContactId: string | null;
  convertedPersonId: string | null;
  convertedOpportunityId: string | null;
  /** Asked not to be emailed (decision 496). */
  emailOptOut: boolean;
  /** The campaign it came from (decision 498): at most one, so revenue is counted once. */
  sourceCampaignId: string | null;
  sourceCampaignName: string | null;
  createdByEmail: string | null;
  createdAt: string;
  updatedAt: string;
};


export type LeadImportResult = {
  created: number;
  /** Rows already imported with this key (a retry), or whose email is already an open lead. */
  skipped: Array<{ row: number; reason: string }>;
  leads: Lead[];
};
