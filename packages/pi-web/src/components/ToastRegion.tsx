import { useSnapshot } from "valtio";
import { appStore, dismissToast } from "../app/store";
import styles from "./ToastRegion.module.less";

export function ToastRegion() {
  const state = useSnapshot(appStore);
  return <div className={styles.region} aria-live="polite" aria-atomic="false">
    {state.toasts.map((toast) => <div className={`${styles.toast} ${styles[toast.tone]}`} key={toast.id}>
      <span>{toast.message}</span>
      <button type="button" onClick={() => dismissToast(toast.id)} aria-label="Dismiss notification">×</button>
    </div>)}
  </div>;
}
