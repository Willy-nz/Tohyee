/**
 * Rich text for a report's text items (#376 phase 2, decision 683): a small,
 * safe subset of Markdown. **bold**, *italic*, [a link](https://...), lines
 * starting "- " or "1. " as lists, a blank line between paragraphs, and
 * {Value name} for one of the item's values (e.g. "Sales this month:
 * {Sales}"). It's parsed into a tree that the page draws as React elements,
 * so text is always text: nothing typed here ever becomes HTML, and only
 * http(s) and mailto links are made into links. Shared with the browser.
 */

export type Inline =
  | { kind: "text"; text: string }
  | { kind: "strong"; children: Inline[] }
  | { kind: "em"; children: Inline[] }
  | { kind: "link"; href: string; children: Inline[] }
  | { kind: "value"; name: string }
  | { kind: "break" };

export type Block = { kind: "p"; children: Inline[] } | { kind: "ul" | "ol"; items: Inline[][] };

export const MAX_RICH_TEXT = 4000;

/** Only web and email links: anything else (javascript:, data:, relative paths) stays as plain text. */
export function safeHref(raw: string): string | null {
  const href = raw.trim();
  if (/^mailto:[^\s<>"]+@[^\s<>"]+$/i.test(href)) return href;
  try {
    const url = new URL(href);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function pushText(list: Inline[], text: string) {
  if (!text) return;
  const last = list[list.length - 1];
  if (last?.kind === "text") last.text += text;
  else list.push({ kind: "text", text });
}

/** One line's (or paragraph's) inline formatting. Unmatched markers are kept as typed. */
export function parseInline(source: string): Inline[] {
  const out: Inline[] = [];
  let at = 0;
  while (at < source.length) {
    const rest = source.slice(at);
    // A backslash keeps the next marker as a plain character: \* \{ \[
    if (rest[0] === "\\" && /^[\\*{}[\]]/.test(rest.slice(1))) {
      pushText(out, rest[1]);
      at += 2;
      continue;
    }
    if (rest[0] === "\n") {
      out.push({ kind: "break" });
      at += 1;
      continue;
    }
    const bold = /^\*\*(?=\S)([\s\S]*?\S)\*\*/.exec(rest);
    if (bold) {
      out.push({ kind: "strong", children: parseInline(bold[1]) });
      at += bold[0].length;
      continue;
    }
    const italic = /^\*(?=[^\s*])([\s\S]*?[^\s*])\*(?!\*)/.exec(rest);
    if (italic) {
      out.push({ kind: "em", children: parseInline(italic[1]) });
      at += italic[0].length;
      continue;
    }
    const link = /^\[([^\]\n]+)\]\(([^)\s]+)\)/.exec(rest);
    if (link) {
      const href = safeHref(link[2]);
      if (href) out.push({ kind: "link", href, children: parseInline(link[1]) });
      else pushText(out, link[0]);
      at += link[0].length;
      continue;
    }
    const value = /^\{([^{}\n]{1,80})\}/.exec(rest);
    if (value) {
      out.push({ kind: "value", name: value[1].trim() });
      at += value[0].length;
      continue;
    }
    const next = rest.slice(1).search(/[\\*[{\n]/);
    const take = next === -1 ? rest.length : next + 1;
    pushText(out, rest.slice(0, take));
    at += take;
  }
  return out;
}

/** The whole text: paragraphs split by blank lines; a paragraph whose lines all start "- " or "1. " is a list. */
export function parseRichText(text: string | undefined): Block[] {
  return (text ?? "")
    .replace(/\r\n/g, "\n")
    .split(/\n\s*\n/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part): Block => {
      const lines = part.split("\n");
      if (lines.every((line) => /^\s*[-*•]\s+/.test(line))) return { kind: "ul", items: lines.map((line) => parseInline(line.replace(/^\s*[-*•]\s+/, ""))) };
      if (lines.every((line) => /^\s*\d{1,3}[.)]\s+/.test(line))) return { kind: "ol", items: lines.map((line) => parseInline(line.replace(/^\s*\d{1,3}[.)]\s+/, ""))) };
      return { kind: "p", children: parseInline(part) };
    });
}

/** Every {Value name} the text uses, once each, in order. */
export function valueNames(blocks: Block[]): string[] {
  const names: string[] = [];
  const walk = (list: Inline[]) => {
    for (const inline of list) {
      if (inline.kind === "value" && !names.includes(inline.name)) names.push(inline.name);
      if (inline.kind === "strong" || inline.kind === "em" || inline.kind === "link") walk(inline.children);
    }
  };
  for (const block of blocks) {
    if (block.kind === "p") walk(block.children);
    else block.items.forEach(walk);
  }
  return names;
}

/** The text with each {Value} filled in (for plain-text uses such as a screen reader summary or a test); unknown names stay as typed. */
export function fillText(blocks: Block[], value: (name: string) => string | null): string {
  const flat = (list: Inline[]): string =>
    list
      .map((inline) => {
        if (inline.kind === "text") return inline.text;
        if (inline.kind === "break") return "\n";
        if (inline.kind === "value") return value(inline.name) ?? `{${inline.name}}`;
        return flat(inline.children);
      })
      .join("");
  return blocks.map((block) => (block.kind === "p" ? flat(block.children) : block.items.map((item) => `• ${flat(item)}`).join("\n"))).join("\n\n");
}
