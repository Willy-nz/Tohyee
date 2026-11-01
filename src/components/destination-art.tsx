"use client";

import { usePathname } from "next/navigation";
import { IllustratedIcon } from "./illustrated-icon";
import { iconForDestination, iconForMenu } from "./navigation-art";

/**
 * Never replaces a link's text or accessible name. A destination with no
 * artwork (e.g. Get Tohyee) keeps an empty space the same size, so its label
 * lines up with the others in the list.
 */
export function DestinationArt({ href, menu, size = 28 }: { href?: string; menu?: Parameters<typeof iconForMenu>[0]; size?: 28 | 32 | 40 | 48 }) {
  const name = menu ? iconForMenu(menu) : iconForDestination(href ?? null);
  return name ? <IllustratedIcon name={name} size={size} /> : <span aria-hidden="true" style={{ width: size, height: size, flex: "0 0 auto" }} />;
}

export function PageHeadingArt() {
  const name = iconForDestination(usePathname());
  return name ? <IllustratedIcon name={name} size={40} /> : null;
}
