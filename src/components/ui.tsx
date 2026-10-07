"use client";

import { type ButtonHTMLAttributes, Children, cloneElement, isValidElement, type ReactElement, type ReactNode, useId } from "react";
import { MountainWatermark } from "@/components/mountain-watermark";
import styles from "./ui.module.css";

export { styles as ui };

export function Page({ children }: { children: ReactNode }) {
  return <div className={styles.page}>{children}</div>;
}

export function PageHeader({
  title,
  description,
  actions,
  decorated = false,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  /** Adds the faint mountain watermark behind the header (Home only). */
  decorated?: boolean;
}) {
  return (
    <header className={decorated ? `${styles.pageHeader} ${styles.pageHeaderDecorated}` : styles.pageHeader}>
      {decorated ? <MountainWatermark className={styles.watermark} /> : null}
      <div>
        <h1 className={styles.pageTitle}>{title}</h1>
        {description ? <p className={styles.pageDescription}>{description}</p> : null}
      </div>
      {actions ? <div className={styles.actions}>{actions}</div> : null}
    </header>
  );
}

export function Card({
  title,
  description,
  actions,
  children,
}: {
  title?: string;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className={styles.card}>
      {title || actions ? (
        <div className={styles.cardHeader}>
          <div>
            {title ? <h2 className={styles.cardTitle}>{title}</h2> : null}
            {description ? <p className={styles.cardDescription}>{description}</p> : null}
          </div>
          {actions ? <div className={styles.actions}>{actions}</div> : null}
        </div>
      ) : null}
      {children}
    </section>
  );
}

/**
 * A labelled form control. The label is tied to the control with htmlFor/id
 * and the hint with aria-describedby, so screen readers (and tests) get a
 * clean name like "Password" rather than "Password At least 10 characters."
 */
export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  const generatedId = useId();
  const hintId = `${generatedId}-hint`;
  let control: ReactNode = children;
  let controlId = generatedId;
  // The first element is the control, also when something sits beside it (e.g. the Export badge by Customer, #157).
  const parts = Children.toArray(children);
  const at = parts.findIndex((part) => isValidElement(part));
  if (at >= 0) {
    const first = parts[at] as ReactElement<{ id?: string; "aria-describedby"?: string }>;
    controlId = first.props.id ?? generatedId;
    const labelled = cloneElement(first, {
      id: controlId,
      "aria-describedby": hint ? hintId : first.props["aria-describedby"],
    });
    control = parts.length === 1 ? labelled : parts.map((part, index) => (index === at ? labelled : part));
  }
  return (
    <div className={styles.field}>
      <label htmlFor={controlId} className={styles.fieldLabel}>
        {label}
      </label>
      {control}
      {hint ? (
        <span id={hintId} className={styles.fieldHint}>
          {hint}
        </span>
      ) : null}
    </div>
  );
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "danger";
  size?: "normal" | "small";
};

export function Button({ variant = "primary", size = "normal", className, type, ...rest }: ButtonProps) {
  return (
    <button
      type={type ?? "button"}
      className={[styles.button, styles[variant], size === "small" ? styles.small : "", className ?? ""]
        .filter(Boolean)
        .join(" ")}
      {...rest}
    />
  );
}

export function Notice({
  tone = "info",
  children,
}: {
  tone?: "info" | "success" | "error" | "warning";
  children: ReactNode;
}) {
  return (
    <div className={`${styles.notice} ${styles[tone]}`} role={tone === "error" ? "alert" : "status"}>
      {children}
    </div>
  );
}

export function Badge({
  tone = "neutral",
  children,
}: {
  tone?: "neutral" | "blue" | "green" | "amber" | "red";
  children: ReactNode;
}) {
  const toneClass = {
    neutral: styles.badgeNeutral,
    blue: styles.badgeBlue,
    green: styles.badgeGreen,
    amber: styles.badgeAmber,
    red: styles.badgeRed,
  }[tone];
  return <span className={`${styles.badge} ${toneClass}`}>{children}</span>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className={styles.empty}>{children}</div>;
}

export function Stat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className={styles.stat}>
      <div className={styles.statLabel}>{label}</div>
      <div className={styles.statValue}>{value}</div>
    </div>
  );
}
