"use client";

import { usePathname } from "next/navigation";
import { IllustratedIcon } from "./illustrated-icon";
import { iconForDestination, iconForMenu } from "./navigation-art";

/** Never replaces a link's text or accessible name. */
export function DestinationArt({ href, menu, size = 28 }: { href?: string; menu?: Parameters<typeof iconForMenu>[0]; size?: 28 | 32 | 40 | 48 }) {
  const name = menu ? iconForMenu(menu) : iconForDestination(href ?? null);
  return name ? <IllustratedIcon name={name} size={size} /> : null;
}

export function PageHeadingArt() {
  const name = iconForDestination(usePathname());
  return name ? <IllustratedIcon name={name} size={40} /> : null;
}
