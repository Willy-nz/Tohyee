"use client";

/*
 * The small part of Office.js the PowerPoint add-in uses (#429), typed here
 * rather than pulling in @types/office-js. Office.js itself is loaded from
 * Microsoft's CDN by the add-in's pages, as Microsoft requires
 * (https://appsforoffice.microsoft.com/lib/1/hosted/office.js).
 */

export const OFFICE_JS_URL = "https://appsforoffice.microsoft.com/lib/1/hosted/office.js";

type AsyncResult<T> = { status: "succeeded" | "failed"; value: T; error?: { message: string; code?: number } };
type Callback<T> = (result: AsyncResult<T>) => void;

export type OfficeDialog = {
  close(): void;
  addEventHandler(type: string, handler: (event: { message?: string; origin?: string; error?: number }) => void): void;
};

export type OfficeGlobal = {
  onReady(): Promise<{ host: string | null; platform: string | null }>;
  context: {
    partitionKey?: string;
    document?: {
      settings: {
        get(name: string): unknown;
        set(name: string, value: unknown): void;
        remove(name: string): void;
        saveAsync(callback?: Callback<void>): void;
      };
      getActiveViewAsync?(callback: Callback<"edit" | "read">): void;
    };
    ui: {
      displayDialogAsync(url: string, options: { height: number; width: number; promptBeforeOpen?: boolean }, callback: Callback<OfficeDialog>): void;
      messageParent(message: string, options?: { targetOrigin: string }): void;
      openBrowserWindow?(url: string): void;
    };
    requirements?: { isSetSupported(name: string, version?: string): boolean };
  };
  EventType: { DialogMessageReceived: string; DialogEventReceived: string };
};

/** Office.js once it's loaded (null in a plain browser tab, or before it loads). */
export function officeGlobal(): OfficeGlobal | null {
  const value = (globalThis as { Office?: OfficeGlobal }).Office;
  return value && typeof value.onReady === "function" ? value : null;
}

/** Adds Office.js from Microsoft's CDN to the page, once. */
function loadOfficeJs(): void {
  if (officeGlobal() || document.querySelector(`script[src="${OFFICE_JS_URL}"]`)) return;
  const script = document.createElement("script");
  script.src = OFFICE_JS_URL;
  script.async = true;
  document.head.appendChild(script);
}

/** Loads Office.js and waits for Office to be ready; null when the page isn't running inside Office. */
export async function officeReady(timeoutMs = 8000): Promise<{ office: OfficeGlobal; host: string | null } | null> {
  loadOfficeJs();
  const started = Date.now();
  while (!officeGlobal()) {
    if (Date.now() - started > timeoutMs) return null;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const office = officeGlobal()!;
  const info = await Promise.race([office.onReady(), new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs))]);
  if (!info) return null;
  return { office, host: info.host };
}

/** "read" during a slide show or in Reading view, "edit" otherwise (decision 841). */
export function activeView(office: OfficeGlobal): Promise<"edit" | "read"> {
  return new Promise((resolve) => {
    const getter = office.context.document?.getActiveViewAsync;
    if (!getter) return resolve("edit");
    try {
      office.context.document!.getActiveViewAsync!((result) => resolve(result.status === "succeeded" && result.value === "read" ? "read" : "edit"));
    } catch {
      resolve("edit");
    }
  });
}

/** Saves the add-in's settings into the presentation (the person still saves the file itself). */
export function saveSettings(office: OfficeGlobal): Promise<boolean> {
  return new Promise((resolve) => {
    const settings = office.context.document?.settings;
    if (!settings) return resolve(false);
    try {
      settings.saveAsync((result) => resolve(result.status === "succeeded"));
    } catch {
      resolve(false);
    }
  });
}

/** Opens an address in the person's browser: Office's own way where there is one, a new tab otherwise. */
export function openInBrowser(office: OfficeGlobal | null, url: string): void {
  if (office?.context.ui.openBrowserWindow) {
    try {
      office.context.ui.openBrowserWindow(url);
      return;
    } catch {
      // Older Office: a new window instead.
    }
  }
  window.open(url, "_blank", "noopener");
}
