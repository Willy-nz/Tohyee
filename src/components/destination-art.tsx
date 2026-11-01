"use client";

import { usePathname } from "next/navigation";
import { IllustratedIcon } from "./illustrated-icon";
import { iconForDestination, iconForSection } from "./navigation-art";

/** Never replaces a link's text or accessible name. */
export function DestinationArt({ href, section, size = 28 }: { href?: string; section?: string; size?: 28 | 32 | 40 | 48 }) {
  const name = (section ? iconForSection(section) : undefined) ?? iconForDestination(href ?? null);
  return name ? <IllustratedIcon name={name} size={size} /> : null;
}

export function PageHeadingArt() {
  const name = iconForDestination(usePathname());
  return name ? <IllustratedIcon name={name} size={40} /> : null;
}
