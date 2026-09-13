import { useEffect, useRef, type FormEvent, type ReactNode } from "react";
import styles from "./Dialog.module.less";

export interface DialogProps {
  open: boolean;
  title: string;
  children: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  onConfirm?: () => void;
  onClose: () => void;
}

export function Dialog({ open, title, children, confirmLabel = "Confirm", cancelLabel = "Cancel", destructive, onConfirm, onClose }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onConfirm?.();
  }

  return <dialog ref={ref} className={styles.dialog} onCancel={onClose} onClose={onClose} aria-labelledby="shared-dialog-title">
    <form onSubmit={submit}>
      <h2 id="shared-dialog-title">{title}</h2>
      <div className={styles.content}>{children}</div>
      <div className={styles.actions}>
        <button className="button" type="button" onClick={onClose}>{cancelLabel}</button>
        {onConfirm && <button className={`button ${destructive ? "danger" : "primary"}`} type="submit">{confirmLabel}</button>}
      </div>
    </form>
  </dialog>;
}
