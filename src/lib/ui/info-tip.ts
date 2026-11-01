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

export function placeInfoTip(button: Box, viewport: { width: number; height: number }): InfoTipPlacement {
  const width = Math.max(0, Math.min(INFO_TIP_MAX_WIDTH, viewport.width - INFO_TIP_MARGIN * 2));
  // Start the panel's left edge near the button, then slide it back inside the window.
  const wanted = button.left - 12;
  const left = Math.max(INFO_TIP_MARGIN, Math.min(wanted, viewport.width - INFO_TIP_MARGIN - width));
  const roomBelow = viewport.height - button.bottom - GAP - INFO_TIP_MARGIN;
  const roomAbove = button.top - GAP - INFO_TIP_MARGIN;
  if (roomBelow >= MIN_ROOM || roomBelow >= roomAbove) {
    return { left, top: button.bottom + GAP, width, maxHeight: Math.max(MIN_ROOM / 2, roomBelow), side: "below" };
  }
  // Above: the panel's bottom sits just over the button; its top is worked out from its height in CSS (translateY(-100%)).
  return { left, top: button.top - GAP, width, maxHeight: roomAbove, side: "above" };
}
