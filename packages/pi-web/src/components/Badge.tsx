import type { HTMLAttributes } from "react";
import styles from "./Badge.module.less";

export type BadgeTone = "neutral" | "info" | "success" | "warning" | "danger";

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
}

export function Badge({ tone = "neutral", className = "", ...props }: BadgeProps) {
  return <span className={`${styles.badge} ${styles[tone]} ${className}`} {...props} />;
}
export { Badge as StatusBadge };
