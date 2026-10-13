/*
 * Keyboard entry in forms (#258), for the browser:
 * - Ctrl or Cmd + Enter clicks the form's main (first enabled) submit
 *   button, as if it were clicked: Save on an invoice or bill, Post on a
 *   journal.
 * - Enter in a line table (the rows of an invoice, bill or journal) moves to
 *   the next field instead of saving the whole form.
 * A field that handles Enter itself (a search list choosing an item) calls
 * preventDefault, and is left alone.
 */

const FIELDS = "input:not([type=hidden]):not([disabled]):not([tabindex='-1']), select:not([disabled]), textarea:not([disabled]), button:not([disabled]):not([tabindex='-1'])";

export function handleFormKeys(event: KeyboardEvent): void {
  if (event.defaultPrevented || event.key !== "Enter" || event.altKey || event.isComposing) return;
  const target = event.target instanceof HTMLElement ? event.target : null;
  const form = target?.closest("form");
  if (!target || !form) return;
  if (event.ctrlKey || event.metaKey) {
    const submit = form.querySelector<HTMLButtonElement | HTMLInputElement>("button[type=submit]:not([disabled]), input[type=submit]:not([disabled])");
    if (!submit) return;
    event.preventDefault();
    // After the field's own Enter (a typed date being read) has updated the form.
    setTimeout(() => submit.click(), 0);
    return;
  }
  if (event.shiftKey || !(target instanceof HTMLInputElement || target instanceof HTMLSelectElement) || !target.closest("table")) return;
  if (target instanceof HTMLInputElement && ["submit", "button", "checkbox", "radio", "file"].includes(target.type)) return;
  event.preventDefault();
  const fields = [...form.querySelectorAll<HTMLElement>(FIELDS)].filter((field) => field.offsetParent !== null || field === target);
  const next = fields[fields.indexOf(target) + 1];
  if (next) {
    next.focus();
    if (next instanceof HTMLInputElement && next.type === "text") next.select();
  }
}
