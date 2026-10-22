"use client";

import { useState } from "react";
import { Button, ui } from "@/components/ui";
import type { Tile } from "@/lib/analytics/dashboards";
import { alignRowHeights, matchSize, shareRow, type ArrangeResult } from "@/lib/analytics/layout";
import styles from "./arrange-bar.module.css";

/**
 * Lining up and sizing the chosen tiles in the grid (#387, decision 752),
 * from buttons, so it works from the keyboard. Each change is one step in
 * the draft (and one Undo).
 */
export function ArrangeBar({ tiles, chosen, onArrange, onClear }: { tiles: Tile[]; chosen: string[]; onArrange: (tiles: Tile[], label: string) => void; onClear: () => void }) {
  const [message, setMessage] = useState<string | null>(null);
  if (chosen.length === 0) return message ? <p className={styles.message} role="status">{message}</p> : null;
  const run = (result: ArrangeResult, label: string) => {
    if ("error" in result) {
      setMessage(result.error);
      return;
    }
    setMessage(result.message);
    onArrange(result.tiles, label);
  };
  const names = chosen.map((id) => tiles.find((tile) => tile.id === id)?.title).filter(Boolean);
  return (
    <div className={styles.bar} role="toolbar" aria-label="Arrange the chosen tiles">
      <span className={styles.count}>
        {chosen.length} chosen{names.length <= 3 ? `: ${names.join(", ")}` : ""}
      </span>
      <div className={ui.rowButtons}>
        <Button size="small" variant="secondary" disabled={chosen.length < 2} title="Every chosen tile as wide as the first chosen" onClick={() => run(matchSize(tiles, chosen, "width"), "give tiles the same width")}>Same width</Button>
        <Button size="small" variant="secondary" disabled={chosen.length < 2} title="Every chosen tile as tall as the first chosen" onClick={() => run(matchSize(tiles, chosen, "height"), "give tiles the same height")}>Same height</Button>
        <Button size="small" variant="secondary" disabled={chosen.length < 2 || chosen.length > 4} title="Two to four tiles side by side, sharing a row evenly" onClick={() => run(shareRow(tiles, chosen), "share a row")}>Share a row</Button>
        <Button size="small" variant="secondary" title="Every tile in the chosen tiles' rows as tall as the tallest" onClick={() => run(alignRowHeights(tiles, chosen), "line up heights")}>Line up heights</Button>
        <Button size="small" variant="secondary" onClick={() => { setMessage(null); onClear(); }}>Clear choice</Button>
      </div>
      {message ? <p className={styles.message} role="status">{message}</p> : null}
    </div>
  );
}
