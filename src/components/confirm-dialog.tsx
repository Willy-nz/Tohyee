"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import styles from "./ui.module.css";

export type ConfirmOptions = {
  /** Label for the OK button. Defaults to "OK". */
  confirmLabel?: string;
  /** Label for the Cancel button. Defaults to "Cancel". */
  cancelLabel?: string;
  /** Use the danger style for the OK button (Void, Delete, ...). */
  danger?: boolean;
  /** Optional heading above the message. */
  title?: string;
};

export type ConfirmFunction = (message: string, options?: ConfirmOptions) => Promise<boolean>;

type Pending = {
  message: string;
  options: ConfirmOptions;
  resolve: (result: boolean) => void;
};

const ConfirmContext = createContext<ConfirmFunction | null>(null);

/**
 * Replaces window.confirm with an in-page dialog. Place once near the root;
 * call useConfirm() in any client component below it.
 */
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null);
  const pendingRef = useRef<Pending | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);

  const confirm = useCallback<ConfirmFunction>((message, options = {}) => {
    return new Promise<boolean>((resolve) => {
      // A second call while one is open cancels the first.
      pendingRef.current?.resolve(false);
      const next = { message, options, resolve };
      pendingRef.current = next;
      setPending(next);
    });
  }, []);

  const settle = useCallback((result: boolean) => {
    const current = pendingRef.current;
    pendingRef.current = null;
    setPending(null);
    current?.resolve(result);
  }, []);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (pending && dialog && !dialog.open) dialog.showModal();
  }, [pending]);

  // Never leave a caller hanging if the provider goes away.
  useEffect(() => () => pendingRef.current?.resolve(false), []);

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {pending ? (
        <dialog
          ref={dialogRef}
          className={styles.confirmDialog}
          aria-labelledby={pending.options.title ? "confirm-dialog-title" : undefined}
          aria-describedby="confirm-dialog-message"
          onCancel={(event) => {
            event.preventDefault();
            settle(false);
          }}
          onClick={(event) => {
            if (event.target === event.currentTarget) settle(false);
          }}
        >
          <div className={styles.confirmBody}>
            {pending.options.title ? (
              <h2 id="confirm-dialog-title" className={styles.confirmTitle}>
                {pending.options.title}
              </h2>
            ) : null}
            <p id="confirm-dialog-message" className={styles.confirmMessage}>
              {pending.message}
            </p>
            <div className={styles.confirmActions}>
              <button
                type="button"
                className={`${styles.button} ${styles.secondary}`}
                autoFocus
                onClick={() => settle(false)}
              >
                {pending.options.cancelLabel ?? "Cancel"}
              </button>
              <button
                type="button"
                className={`${styles.button} ${pending.options.danger ? styles.danger : styles.primary}`}
                onClick={() => settle(true)}
              >
                {pending.options.confirmLabel ?? "OK"}
              </button>
            </div>
          </div>
        </dialog>
      ) : null}
    </ConfirmContext.Provider>
  );
}

/** Returns confirm(message, options?) => Promise<boolean>. */
export function useConfirm(): ConfirmFunction {
  const confirm = useContext(ConfirmContext);
  if (!confirm) throw new Error("useConfirm must be used inside <ConfirmProvider>.");
  return confirm;
}
