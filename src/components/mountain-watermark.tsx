/**
 * Aoraki / Mt Cook from Lake Pukaki: a faint crop of Jess's own photo behind
 * Home's greeting (docs/TOHYEE-UI-SPEC.md, "Mountain treatment"; decision
 * 477). Only the mountain strip is stored (public/images/aoraki-strip.jpg),
 * never the full photo. Screen readers skip it.
 */
export function MountainWatermark({ className }: { className?: string }) {
  return <div className={className} aria-hidden="true" />;
}
