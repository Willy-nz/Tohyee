"use client";

import Link from "next/link";
import { Card } from "@/components/ui";
import type { FarmContext } from "@/components/farm-workspace";
import styles from "./farm-workspace.module.css";

/** The Log tab (#447): what can be recorded. Step-by-step quick logs replace these links in the next change. */
export function FarmLog({ farm }: FarmContext) {
  const pasture = `/operations/farming/pasture?farm=${farm.id}`;
  return (
    <Card title={`Log on ${farm.name}`}>
      <div className={styles.bigButtons}>
        <Link className={styles.bigButton} href={pasture}>
          Cover reading
        </Link>
        <Link className={styles.bigButton} href={pasture}>
          Grazing
        </Link>
        <Link className={styles.bigButton} href={pasture}>
          Feed
        </Link>
      </div>
    </Card>
  );
}
