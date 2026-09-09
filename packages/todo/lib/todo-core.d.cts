export type TodoStatus = "pending" | "in_progress" | "completed" | "blocked";
export interface TodoItem { id: string; step: string; status: TodoStatus; }
export interface TodoState { todos: TodoItem[]; explanation?: string; }
export function normalizeTodoState(value: unknown): TodoState;
export function validateTodos(todos: TodoItem[], explanation?: string, previous?: TodoItem[]): TodoItem[];
