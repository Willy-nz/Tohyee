/**
 * Decorative AI-restored crop of the supplied Aoraki / Lake Pukaki photo.
 * The original strip is retained; see docs/AORAKI-RESTORATION.md for provenance.
 * No full source screenshot or identifying foreground is included.
 */
export function MountainWatermark({ className }: { className?: string }) {
  return <div className={className} aria-hidden="true" />;
}
