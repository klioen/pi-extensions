import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import todoCore from "../lib/todo-core.cjs";

const core = todoCore;

type TodoStatus = "pending" | "in_progress" | "completed" | "blocked";
interface TodoItem {
	id: string;
	step: string;
	status: TodoStatus;
}
interface TodoState {
	todos: TodoItem[];
	explanation?: string;
}

function marker(status: TodoStatus): string {
	switch (status) {
		case "completed": return "✓";
		case "in_progress": return "●";
		case "blocked": return "!";
		case "pending": return "○";
	}
}

export default function (pi: ExtensionAPI) {
	let todos: TodoItem[] = [];
	let explanation: string | undefined;

	const save = () => pi.appendEntry<TodoState>("pi-todo-state", { todos, explanation });

	// Custom entries are durable session state and, unlike custom messages, are
	// not injected into the model context. Each update is a transcript card,
	// rather than a widget that permanently consumes editor space.
	pi.registerEntryRenderer<TodoState>("pi-todo-state", (entry, { expanded }, theme) => {
		const state = core.normalizeTodoState(entry.data);
		const done = state.todos.filter((todo) => todo.status === "completed").length;
		const box = new Box(1, 0, (text: string) => theme.bg("customMessageBg", text));
		box.addChild(new Text(`${theme.fg("accent", "• Updated Todos")} ${theme.fg("dim", `${done}/${state.todos.length}`)}`, 0, 0));
		if (state.explanation) box.addChild(new Text(theme.fg("dim", state.explanation), 2, 0));
		for (const todo of state.todos) {
			const color = todo.status === "completed" ? "muted" : todo.status === "blocked" ? "warning" : todo.status === "in_progress" ? "accent" : "dim";
			const text = todo.status === "completed" ? theme.strikethrough(todo.step) : todo.step;
			box.addChild(new Text(theme.fg(color, `${marker(todo.status)} ${text}`), 2, 0));
		}
		if (expanded) box.addChild(new Text(theme.fg("dim", `session entry: ${entry.customType}`), 2, 0));
		return box;
	});

	pi.registerTool({
		name: "todo_write",
		label: "Write todos",
		description: "Update the session-scoped todo list. This tracks progress only and never authorizes implementation.",
		parameters: Type.Object({
			explanation: Type.Optional(Type.String()),
			todos: Type.Array(Type.Object({
				id: Type.String(),
				step: Type.String(),
				status: Type.Union([Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("completed"), Type.Literal("blocked")]),
			}), { minItems: 1, maxItems: 20 }),
		}),
		async execute(_id, args, _signal, _update, _ctx) {
			try {
				todos = core.validateTodos(args.todos, args.explanation, todos);
				explanation = args.explanation?.trim() || undefined;
				save();
				return {
					content: [{ type: "text", text: `Todos updated: ${todos.filter((todo) => todo.status === "completed").length}/${todos.length} completed.` }],
					details: { todos, explanation },
				};
			} catch (error) {
				return { content: [{ type: "text", text: `Todo update rejected: ${String(error)}` }], details: {}, isError: true };
			}
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		const entry = ctx.sessionManager.getEntries()
			.filter((item: { type: string; customType?: string }) => item.type === "custom" && item.customType === "pi-todo-state")
			.pop() as { data?: unknown } | undefined;
		const state = core.normalizeTodoState(entry?.data);
		todos = state.todos;
		explanation = state.explanation;
	});
}
