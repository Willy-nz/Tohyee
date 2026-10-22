"use client";

import { MAX_SNAPSHOT_CHARACTERS } from "@/lib/office/settings";

/*
 * The saved picture of a report on a slide (#429, decision 840), for people
 * who can't sign in: what the report looked like the last time someone
 * signed in saw it, as Power BI's add-in keeps a snapshot. It's made from
 * the report as drawn on the slide (the charts are already SVG), copied
 * with the styles each element was drawn with into an SVG picture. An SVG
 * rather than a PNG because turning HTML into pixels in the browser isn't
 * allowed everywhere (Safari, which PowerPoint for Mac uses, refuses to
 * read such a canvas back), while every browser can show the SVG.
 */

/** Styles copied onto each element, with the value that needn't be written. */
const PROPERTIES: Record<string, string | null> = {
  display: null,
  appearance: null,
  position: "static",
  top: "auto",
  right: "auto",
  bottom: "auto",
  left: "auto",
  "box-sizing": "content-box",
  width: null,
  height: null,
  "min-width": "0px",
  "min-height": "0px",
  "max-width": "none",
  "margin-top": "0px",
  "margin-right": "0px",
  "margin-bottom": "0px",
  "margin-left": "0px",
  "padding-top": "0px",
  "padding-right": "0px",
  "padding-bottom": "0px",
  "padding-left": "0px",
  "border-top-width": "0px",
  "border-right-width": "0px",
  "border-bottom-width": "0px",
  "border-left-width": "0px",
  "border-top-style": null,
  "border-right-style": null,
  "border-bottom-style": null,
  "border-left-style": null,
  "border-top-color": null,
  "border-right-color": null,
  "border-bottom-color": null,
  "border-left-color": null,
  "border-top-left-radius": "0px",
  "border-top-right-radius": "0px",
  "border-bottom-left-radius": "0px",
  "border-bottom-right-radius": "0px",
  "background-color": "rgba(0, 0, 0, 0)",
  "background-image": "none",
  color: null,
  "font-family": null,
  "font-size": null,
  "font-weight": "400",
  "font-style": "normal",
  "line-height": "normal",
  "letter-spacing": "normal",
  "text-align": "start",
  "text-transform": "none",
  "text-decoration-line": "none",
  "text-overflow": "clip",
  "white-space": "normal",
  "overflow-x": "visible",
  "overflow-y": "visible",
  "flex-direction": "row",
  "flex-wrap": "nowrap",
  "flex-grow": "0",
  "flex-shrink": "1",
  "flex-basis": "auto",
  "align-items": "normal",
  "align-self": "auto",
  "justify-content": "normal",
  gap: "normal",
  "grid-template-columns": "none",
  "grid-template-rows": "none",
  "grid-column-start": "auto",
  "grid-column-end": "auto",
  "grid-row-start": "auto",
  "grid-row-end": "auto",
  "vertical-align": "baseline",
  "box-shadow": "none",
  opacity: "1",
  visibility: "visible",
  "table-layout": "auto",
  "border-collapse": "separate",
};

// Form controls drawn inside a picture get the browser's own look unless told otherwise, so border styles and appearance are always written.
function borderNeeded(style: CSSStyleDeclaration, side: string): boolean {
  return style.getPropertyValue(`border-${side}-style`) !== "none" && style.getPropertyValue(`border-${side}-width`) !== "0px";
}

function styleText(style: CSSStyleDeclaration): string {
  let text = "";
  for (const [name, skip] of Object.entries(PROPERTIES)) {
    if (name.startsWith("border-") && name.endsWith("-color") && !borderNeeded(style, name.split("-")[1])) continue;
    const value = style.getPropertyValue(name);
    if (!value || value === skip) continue;
    // Only gradients: an image address wouldn't load inside the picture.
    if (name === "background-image" && value.includes("url(")) continue;
    // Scroll bars don't belong in a picture: what's past the edge is cut off instead.
    if ((name === "overflow-x" || name === "overflow-y") && (value === "auto" || value === "scroll")) {
      text += `${name}:hidden;`;
      continue;
    }
    text += `${name}:${value};`;
  }
  return text;
}

/** A picture element's pixels as a data: address (same-origin blob: images can be read back), or null. */
function imageData(image: HTMLImageElement): string | null {
  if (image.src.startsWith("data:")) return image.src;
  if (!image.complete || !image.naturalWidth) return null;
  try {
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    canvas.getContext("2d")?.drawImage(image, 0, 0);
    return canvas.toDataURL("image/png");
  } catch {
    return null;
  }
}

function copy(source: Element, inSvg: boolean): Node | null {
  if (source instanceof HTMLScriptElement || source instanceof HTMLStyleElement || source instanceof HTMLTemplateElement) return null;
  if (!inSvg) {
    const style = getComputedStyle(source);
    if (style.display === "none") return null;
    if (source instanceof HTMLCanvasElement) {
      const image = document.createElement("img");
      try {
        image.src = source.toDataURL("image/png");
      } catch {
        return null;
      }
      image.setAttribute("style", styleText(style));
      return image;
    }
    if (source instanceof HTMLSelectElement) {
      // A drop-down is drawn as the choice it shows (a copy wouldn't remember which one is chosen).
      const shown = document.createElement("span");
      shown.textContent = source.selectedOptions[0]?.textContent ?? "";
      shown.setAttribute("style", `${styleText(style)}display:inline-block;overflow:hidden;white-space:nowrap;`);
      return shown;
    }
    if (source instanceof HTMLImageElement) {
      const data = imageData(source);
      const image = document.createElement(data ? "img" : "span");
      if (data) image.setAttribute("src", data);
      image.setAttribute("style", `${styleText(style)}display:inline-block;`);
      return image;
    }
  }
  const target = source.cloneNode(false) as Element;
  // Ids, handlers and the like don't mean anything in a picture.
  for (const attribute of [...target.attributes]) {
    if (attribute.name.startsWith("on") || attribute.name === "id" || attribute.name === "class" || (!inSvg && attribute.name === "style")) target.removeAttribute(attribute.name);
  }
  if (!inSvg) target.setAttribute("style", styleText(getComputedStyle(source)));
  if (source instanceof HTMLInputElement) target.setAttribute("value", source.value);
  const svg = inSvg || source instanceof SVGSVGElement;
  for (const child of source.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) target.appendChild(child.cloneNode());
    else if (child instanceof Element) {
      const copied = copy(child, svg);
      if (copied) target.appendChild(copied);
    }
  }
  return target;
}

function utf8Base64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
}

/**
 * A picture of `element` as drawn now, as an SVG data: address; null when it
 * can't be made or is too big to keep. Only the part that shows in the
 * add-in's box on the slide: anything below it is cut off.
 */
export function snapshotElement(element: HTMLElement): string | null {
  const box = element.getBoundingClientRect();
  const width = Math.ceil(box.width);
  const height = Math.ceil(Math.min(box.height, window.innerHeight - Math.max(box.top, 0)));
  if (width < 10 || height < 10) return null;
  const body = copy(element, false) as HTMLElement | null;
  if (!body) return null;
  body.setAttribute("xmlns", "http://www.w3.org/1999/xhtml");
  body.style.margin = "0";
  const page = getComputedStyle(document.body);
  const background = page.backgroundColor && page.backgroundColor !== "rgba(0, 0, 0, 0)" ? page.backgroundColor : "#ffffff";
  const markup = new XMLSerializer().serializeToString(body);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="${background}"/><foreignObject x="0" y="0" width="${width}" height="${Math.ceil(box.height)}">${markup}</foreignObject></svg>`;
  const image = `data:image/svg+xml;base64,${utf8Base64(svg)}`;
  return image.length <= MAX_SNAPSHOT_CHARACTERS ? image : null;
}

/**
 * Waits until the report has finished drawing: nothing has changed for a
 * moment and no tile says it's still working. Gives up after `limitMs`.
 */
export function whenSettled(element: HTMLElement, options: { quietMs?: number; limitMs?: number } = {}): Promise<boolean> {
  const quietMs = options.quietMs ?? 1500;
  const limitMs = options.limitMs ?? 20_000;
  return new Promise((resolve) => {
    let timer = 0;
    const started = Date.now();
    const busy = () => /Working it out…|Loading…/.test(element.textContent ?? "");
    const check = () => {
      window.clearTimeout(timer);
      if (Date.now() - started > limitMs) {
        observer.disconnect();
        resolve(false);
        return;
      }
      timer = window.setTimeout(() => {
        if (busy()) return check();
        observer.disconnect();
        resolve(true);
      }, quietMs);
    };
    const observer = new MutationObserver(check);
    observer.observe(element, { subtree: true, childList: true, characterData: true, attributes: true });
    check();
  });
}
