import type { HTMLAttributes, ReactNode } from "react";
import styles from "./Card.module.less";

export interface CardProps extends Omit<HTMLAttributes<HTMLElement>, "title"> {
  title?: ReactNode;
  action?: ReactNode;
}

export function Card({ title, action, children, className = "", ...props }: CardProps) {
  return <section className={`${styles.card} ${className}`} {...props}>
    {(title || action) && <header className={styles.header}>{title && <h2>{title}</h2>}{action}</header>}
    {children}
  </section>;
}
