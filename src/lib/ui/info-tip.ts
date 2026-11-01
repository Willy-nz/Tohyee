/**
 * Where an info popover goes (decision 1210). Pure, so it can be tested
 * without a browser: given the (i) button's box and the window's size, it
 * returns a fixed position that keeps the whole panel on screen, also on a
 * 390px phone.
 */

export type Box = { left: number; top: number; right: number; bottom: number };

export type InfoTipPlacement = {
  left: number;
  top: number;
  width: number;
  maxHeight: number;
  side: "below" | "above";
};

/** The gap kept between the panel and the window's edges, in pixels. */
export const INFO_TIP_MARGIN = 8;
/** The widest the panel gets, in pixels. */
export const INFO_TIP_MAX_WIDTH = 360;
const GAP = 6;
/** Below this, the panel goes above the button when there's more room there. */
const MIN_ROOM = 160;

/**
 * The part of the page that can be seen. `left` and `top` are the visible
 * area's offset inside the layout viewport (non-zero when a phone is pinch
 * zoomed or the on-screen keyboard has scrolled the page); they default to 0.
 */
export type Viewport = { width: number; height: number; left?: number; top?: number };

export function placeInfoTip(button: Box, viewport: Viewport): InfoTipPlacement {
  const vLeft = viewport.left ?? 0;
  const vTop = viewport.top ?? 0;
  const width = Math.max(0, Math.min(INFO_TIP_MAX_WIDTH, viewport.width - INFO_TIP_MARGIN * 2));
  // Start the panel's left edge near the button, then slide it back inside the visible area.
  const wanted = button.left - 12;
  const left = Math.max(vLeft + INFO_TIP_MARGIN, Math.min(wanted, vLeft + viewport.width - INFO_TIP_MARGIN - width));
  const roomBelow = Math.max(0, vTop + viewport.height - button.bottom - GAP - INFO_TIP_MARGIN);
  const roomAbove = Math.max(0, button.top - vTop - GAP - INFO_TIP_MARGIN);
  // Never taller than the room actually there (issue #523): the panel scrolls instead.
  if (roomBelow >= MIN_ROOM || roomBelow >= roomAbove) {
    return { left, top: button.bottom + GAP, width, maxHeight: roomBelow, side: "below" };
  }
  // Above: the panel's bottom sits just over the button; its top is worked out from its height in CSS (translateY(-100%)).
  return { left, top: button.top - GAP, width, maxHeight: roomAbove, side: "above" };
}
