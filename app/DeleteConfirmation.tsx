"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Button } from "./components/ui";
import "./delete-confirmation.css";

export default function DeleteConfirmation({ open, title, description, busy = false, confirmDisabled = false, confirmLabel = "Delete", busyLabel = "Deleting...", children, onCancel, onConfirm }: {
  open: boolean;
  title: string;
  description: string;
  busy?: boolean;
  confirmDisabled?: boolean;
  confirmLabel?: string;
  busyLabel?: string;
  children?: ReactNode;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const dialogRef = useRef<HTMLElement>(null);
  const cancelButtonRef = useRef<HTMLButtonElement>(null);
  const confirmButtonRef = useRef<HTMLButtonElement>(null);
  const onCancelRef = useRef(onCancel);
  const busyRef = useRef(busy);
  onCancelRef.current = onCancel;
  busyRef.current = busy;

  useEffect(() => {
    if (!open) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const initialInput = dialogRef.current?.querySelector<HTMLElement>("input:not(:disabled), select:not(:disabled), textarea:not(:disabled)");
    (initialInput ?? cancelButtonRef.current)?.focus();
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !busyRef.current) {
        event.preventDefault();
        onCancelRef.current();
      }
      if (event.key !== "Tab") return;
      if (busyRef.current) {
        event.preventDefault();
        dialogRef.current?.focus();
        return;
      }
      const focusableElements = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]:not([tabindex='-1'])") ?? []);
      const firstFocusable = focusableElements[0];
      const lastFocusable = focusableElements[focusableElements.length - 1];
      if (!firstFocusable || !lastFocusable) return;
      if (event.shiftKey && (document.activeElement === firstFocusable || !dialogRef.current?.contains(document.activeElement))) {
        event.preventDefault();
        lastFocusable.focus();
      } else if (!event.shiftKey && (document.activeElement === lastFocusable || !dialogRef.current?.contains(document.activeElement))) {
        event.preventDefault();
        firstFocusable.focus();
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      previousFocus?.focus();
    };
  }, [open]);

  if (!open || typeof document === "undefined") return null;

  return createPortal(<div className="delete-confirmation-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onCancel(); }}>
    <section ref={dialogRef} className="delete-confirmation-dialog" role="alertdialog" aria-modal="true" aria-busy={busy} aria-labelledby="delete-confirmation-title" aria-describedby="delete-confirmation-description" tabIndex={-1}>
      <h2 id="delete-confirmation-title">{title}</h2>
      <p id="delete-confirmation-description">{description}</p>
      {children}
      <div className="delete-confirmation-actions">
        <Button type="button" variant="outline" size="lg" className="delete-confirmation-cancel" ref={cancelButtonRef} disabled={busy} onClick={onCancel}>Cancel</Button>
        <Button type="button" variant="destructive" size="lg" className="delete-confirmation-confirm" ref={confirmButtonRef} disabled={busy || confirmDisabled} onClick={onConfirm}>{busy ? busyLabel : confirmLabel}</Button>
      </div>
    </section>
  </div>, document.body);
}
