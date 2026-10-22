import Link from "next/link";
import { BrandMark } from "@/components/brand-mark";
import { Notice } from "@/components/ui";
import styles from "@/components/auth/auth.module.css";
import { connectProblemMessage } from "@/lib/ai/oauth/messages";

/** Why an AI app's sign-in stopped (#427): a fixed message for a known code, never text from the address. */
export default async function ConnectProblemPage({ searchParams }: PageProps<"/connect/problem">) {
  const params = await searchParams;
  return (
    <div className={styles.screen}>
      <main className={styles.panel}>
        <div className={styles.brand}>
          <BrandMark size={30} className={styles.brandMark} />
          Tohyee
        </div>
        <h1 className={styles.title}>Couldn&apos;t connect the AI app</h1>
        <Notice tone="warning">{connectProblemMessage(params.reason)}</Notice>
        <p className={styles.text}>
          <Link href="/operations/ai">Go to the AI page</Link>
        </p>
      </main>
    </div>
  );
}
