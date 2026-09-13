import type { ReactNode } from "react";
import styles from "./Table.module.less";

export interface TableColumn<Row> {
  key: string;
  header: ReactNode;
  render: (row: Row) => ReactNode;
  className?: string;
}

export interface TableProps<Row> {
  columns: TableColumn<Row>[];
  rows: Row[];
  rowKey: (row: Row) => string;
  caption?: string;
  empty?: ReactNode;
}

export function Table<Row>({ columns, rows, rowKey, caption, empty = "No data" }: TableProps<Row>) {
  if (!rows.length) return <div className={styles.empty}>{empty}</div>;
  return <div className={styles.wrap}><table className={styles.table}>
    {caption && <caption>{caption}</caption>}
    <thead><tr>{columns.map((column) => <th key={column.key} className={column.className}>{column.header}</th>)}</tr></thead>
    <tbody>{rows.map((row) => <tr key={rowKey(row)}>{columns.map((column) => <td key={column.key} className={column.className}>{column.render(row)}</td>)}</tr>)}</tbody>
  </table></div>;
}
export { Table as DataTable };
