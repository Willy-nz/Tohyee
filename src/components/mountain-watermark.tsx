/**
 * Decorative crop of the owner's Aoraki / Mount Cook photograph. The original
 * image is preserved; CSS selects only the mountain and adjoining ridge.
 */
export function MountainWatermark({ className }: { className?: string }) {
  return <div className={className} aria-hidden="true" />;
}
