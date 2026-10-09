export const SEARCH_FILTERS = ["all", "contacts", "sales", "purchases", "banking", "accounts", "crm"] as const;

export type SearchFilter = (typeof SEARCH_FILTERS)[number];

export type SearchKind =
  | "contact"
  | "invoice"
  | "bill"
  | "sales_credit_note"
  | "supplier_credit_note"
  | "quote"
  | "sales_order"
  | "purchase_order"
  | "customer_payment"
  | "supplier_payment"
  | "journal"
  | "item"
  | "account"
  | "bank_statement_line"
  | "fixed_asset"
  | "crm_company"
  | "crm_person"
  | "crm_opportunity"
  | "crm_lead"
  | "dashboard";

export type SearchRecord = {
  kind: SearchKind;
  title: string;
  subtitle: string;
  status: string | null;
  href: string;
};

export type SearchGroup = {
  key: SearchKind;
  label: string;
  records: SearchRecord[];
};

export type SearchResponse = {
  query: string;
  filter: SearchFilter;
  groups: SearchGroup[];
};

