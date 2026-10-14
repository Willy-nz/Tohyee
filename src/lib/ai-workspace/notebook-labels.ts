/** The farm notebook's categories and labels (browser-safe; the service is `./notebook`). */
export const NOTEBOOK_CATEGORIES = ["history", "goals", "people", "practices", "places", "other"] as const;
export type NotebookCategory = (typeof NOTEBOOK_CATEGORIES)[number];
export const NOTEBOOK_CATEGORY_LABELS: Record<NotebookCategory, string> = {
  history: "History",
  goals: "Goals",
  people: "People",
  practices: "How we farm",
  places: "Places and paddocks",
  other: "Other",
};

export type NotebookEntry = {
  id: string;
  category: NotebookCategory;
  title: string;
  body: string;
  happenedOn: string | null;
  writtenBy: "person" | "ai";
  createdByEmail: string;
  createdAt: string;
  updatedByEmail: string;
  updatedAt: string;
};
