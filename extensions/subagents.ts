/**
 * Subagents: spawn and manage child agent sessions, modeled after codex's
 * multi_agent_v1 tool surface (spawn_agent / send_input / wait_agent /
 * list_agents / close_agent in codex-rs/core/src/tools/handlers/multi_agents/).
 *
 * Each spawned agent is an in-process pi AgentSession (createAgentSession +
 * SessionManager.inMemory) running with a restricted tool allowlist (default
 * read + bash) and the parent session's current model. spawn_agent returns
 * immediately; use wait_agent to collect results. Multiple agents run in
 * parallel.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";

const MAX_LIVE_AGENTS = 8;
const DEFAULT_WAIT_TIMEOUT_MS = 120_000;
const MAX_WAIT_TIMEOUT_MS = 600_000;
const DEFAULT_TOOLS = ["read", "bash"];

type AgentStatus = "starting" | "running" | "completed" | "error" | "aborted";

interface AgentEntry {
	id: string;
	name: string;
	status: AgentStatus;
	startedAt: number;
	error?: string;
	turns: number;
	finalMessages?: AgentMessage[];
	session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
	done: Promise<void>;
	subscribe?: () => void;
}

const agents = new Map<string, AgentEntry>();
let nextAgentNumber = 1;

function lastAssistantText(messages: AgentMessage[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role !== "assistant") continue;
		const text = message.content
			.filter((part): part is { type: "text"; text: string } => part.type === "text")
			.map((part) => part.text)
			.join("")
			.trim();
		if (text) return text;
	}
	return "";
}

function agentBrief(entry: AgentEntry): string {
	const elapsed = Math.round((Date.now() - entry.startedAt) / 1000);
	const parts = [`${entry.name}`, `status: ${entry.status}`, `${elapsed}s`, `turns: ${entry.turns}`];
	if (entry.error) parts.push(`error: ${entry.error}`);
	return parts.join(" | ");
}

async function runAgent(entry: AgentEntry, firstMessage: string, model: unknown, cwd: string, tools: string[]) {
	try {
		const { session } = await createAgentSession({
			model: model as never,
			cwd,
			tools,
			sessionManager: SessionManager.inMemory(),
		});
		entry.session = session;
		if (entry.status === "aborted") {
			// close_agent was called while the session was still starting.
			session.dispose();
			return;
		}
		entry.status = "running";
		let pending: AgentMessage[] = [];
		entry.subscribe = session.subscribe((event) => {
			if (event.type === "agent_end") {
				entry.finalMessages = event.messages;
				entry.turns++;
			}
		});
		await session.prompt(firstMessage);
		entry.status = "completed";
	} catch (err) {
		entry.status = "error";
		entry.error = err instanceof Error ? err.message : String(err);
	} finally {
		entry.subscribe?.();
		entry.subscribe = undefined;
	}
}

export default function (pi: ExtensionAPI) {
	function liveCount(): number {
		let count = 0;
		for (const entry of agents.values()) {
			if (entry.status === "starting" || entry.status === "running") count++;
		}
		return count;
	}

	function findByIdOrName(idOrName: string): AgentEntry | undefined {
		return agents.get(idOrName) ?? [...agents.values()].find((entry) => entry.name === idOrName);
	}

	pi.registerTool({
		name: "spawn_agent",
		label: "Spawn Agent",
		description:
			"Spawn a subagent that runs a task in the background with its own context window and a restricted tool set " +
			"(default: read, bash). Returns immediately with an agent id; poll results with wait_agent. " +
			"Spawn multiple agents for parallel work. The subagent does not share this conversation's context; " +
			"the message must be a self-contained task description.",
		promptSnippet: "Use for parallel background tasks: spawn_agent, then wait_agent to collect results.",
		parameters: Type.Object({
			message: Type.String({ description: "Complete, self-contained task description for the subagent." }),
			name: Type.Optional(Type.String({ description: "Short label for the agent (default: agent-N)." })),
			tools: Type.Optional(
				Type.Array(Type.String(), {
					description: 'Tool allowlist for the subagent (default ["read", "bash"]).',
				}),
			),
		}),
		async execute(_callId, params, _signal, _onUpdate, ctx) {
			const live = liveCount();
			if (live >= MAX_LIVE_AGENTS) {
				return {
					content: [{ type: "text", text: `Error: too many live agents (${live}/${MAX_LIVE_AGENTS}). Wait for or close running agents first.` }],
					details: { error: "agent limit reached" },
				};
			}
			const message = params.message.trim();
			if (!message) {
				return { content: [{ type: "text", text: "Error: message is required." }], details: { error: "message required" } };
			}
			const id = `agent-${nextAgentNumber++}`;
			const name = params.name?.trim() || id;
			const tools = params.tools?.length ? [...new Set(params.tools)] : DEFAULT_TOOLS;

			const entry: AgentEntry = {
				id,
				name,
				status: "starting",
				startedAt: Date.now(),
				turns: 0,
				session: undefined,
				done: Promise.resolve(),
			};
			agents.set(id, entry);
			entry.done = runAgent(entry, message, ctx?.model, ctx?.cwd ?? process.cwd(), tools);
			return {
				content: [{ type: "text", text: `Spawned ${name} (id: ${id}, tools: ${tools.join(", ")}). Use wait_agent to get results.` }],
				details: { agentId: id, name, tools },
			};
		},
	});

	pi.registerTool({
		name: "wait_agent",
		label: "Wait For Agents",
		description:
			"Wait for spawned agents to finish and return their final messages. Waits for all running agents by default, " +
			"or only the listed agent ids. Returns per-agent status and result; agents still running at the timeout are reported as such.",
		promptSnippet: "Collect subagent results after spawn_agent.",
		parameters: Type.Object({
			agent_ids: Type.Optional(
				Type.Array(Type.String(), { description: "Agent ids or names to wait for (default: all running agents)." }),
			),
			timeout_ms: Type.Optional(
				Type.Integer({ minimum: 1000, maximum: MAX_WAIT_TIMEOUT_MS, description: `Timeout in ms (default ${DEFAULT_WAIT_TIMEOUT_MS}).` }),
			),
		}),
		async execute(_callId, params, signal) {
			const targets = (params.agent_ids?.length ? params.agent_ids : [...agents.keys()])
				.map((id) => findByIdOrName(id))
				.filter((entry): entry is AgentEntry => entry !== undefined);
			if (targets.length === 0) {
				return { content: [{ type: "text", text: "No matching agents." }], details: { agents: [] } };
			}
			const timeoutMs = params.timeout_ms ?? DEFAULT_WAIT_TIMEOUT_MS;
			const deadline = Date.now() + timeoutMs;
			try {
				await Promise.race([
					Promise.all(targets.map((entry) => entry.done)),
					new Promise((_resolve, reject) => {
						const timer = setTimeout(() => reject(new Error(`__timeout__`)), timeoutMs);
						signal?.addEventListener("abort", () => {
							clearTimeout(timer);
							reject(new Error("__aborted__"));
						}, { once: true });
					}),
				]);
			} catch (err) {
				const kind = err instanceof Error ? err.message : "";
				if (kind !== "__timeout__" && kind !== "__aborted__") throw err;
			}
			const lines = targets.map((entry) => {
				const header = agentBrief(entry);
				if (entry.status === "completed") {
					const text = lastAssistantText(entry.finalMessages ?? []);
					return `${header}\n${text || "(no output)"}`;
				}
				return header;
			});
			return {
				content: [{ type: "text", text: lines.join("\n\n---\n\n") }],
				details: {
					deadlinePassed: Date.now() >= deadline,
					agents: targets.map((entry) => ({ id: entry.id, name: entry.name, status: entry.status })),
				},
			};
		},
	});

	pi.registerTool({
		name: "send_input",
		label: "Send Input To Agent",
		description:
			"Send a follow-up message to an existing agent. If the agent is running, the message is queued and delivered " +
			"at the next turn boundary; if it is idle, it starts a new turn. Reuse an agent when the next task depends " +
			"on its accumulated context.",
		promptSnippet: "Follow up with a spawned agent instead of spawning a new one when context matters.",
		parameters: Type.Object({
			agent_id: Type.String({ description: "Agent id or name." }),
			message: Type.String({ description: "Message to deliver." }),
		}),
		async execute(_callId, params, _signal, _onUpdate, ctx) {
			const entry = findByIdOrName(params.agent_id);
			if (!entry) {
				return { content: [{ type: "text", text: `Error: unknown agent '${params.agent_id}'.` }], details: { error: "unknown agent" } };
			}
			if (!entry.session || entry.status === "starting") {
				return { content: [{ type: "text", text: `Error: agent ${entry.name} is still starting.` }], details: { error: "agent starting" } };
			}
			if (entry.status === "aborted") {
				return { content: [{ type: "text", text: `Error: agent ${entry.name} was closed.` }], details: { error: "agent closed" } };
			}
			entry.status = "running";
			entry.done = (async () => {
				try {
					if (entry.session!.isStreaming) {
						await entry.session!.followUp(params.message);
					} else {
						await entry.session!.prompt(params.message);
					}
					entry.status = "completed";
				} catch (err) {
					entry.status = "error";
					entry.error = err instanceof Error ? err.message : String(err);
				}
			})();
			return {
				content: [{ type: "text", text: `Message delivered to ${entry.name}.` }],
				details: { agentId: entry.id, name: entry.name },
			};
		},
	});

	pi.registerTool({
		name: "list_agents",
		label: "List Agents",
		description: "List all spawned subagents with their status, runtime, and completed turn count.",
		parameters: Type.Object({}),
		async execute() {
			if (agents.size === 0) {
				return { content: [{ type: "text", text: "No agents spawned yet." }], details: { agents: [] } };
			}
			return {
				content: [{ type: "text", text: [...agents.values()].map(agentBrief).join("\n") }],
				details: { agents: [...agents.values()].map((entry) => ({ id: entry.id, name: entry.name, status: entry.status })) },
			};
		},
	});

	pi.registerTool({
		name: "close_agent",
		label: "Close Agent",
		description: "Stop an agent (aborting any running turn) and release its session. Its accumulated context is discarded.",
		parameters: Type.Object({
			agent_id: Type.String({ description: "Agent id or name (or 'all' to close every agent)." }),
		}),
		async execute(_callId, params) {
			const targets =
				params.agent_id === "all"
					? [...agents.values()]
					: [findByIdOrName(params.agent_id)].filter((entry): entry is AgentEntry => entry !== undefined);
			if (targets.length === 0) {
				return { content: [{ type: "text", text: `Error: unknown agent '${params.agent_id}'.` }], details: { error: "unknown agent" } };
			}
			for (const entry of targets) {
				entry.status = "aborted";
				entry.subscribe?.();
				entry.subscribe = undefined;
				try {
					await entry.session?.abort();
				} catch {
					// Session may already be disposed.
				}
				entry.session?.dispose();
				agents.delete(entry.id);
			}
			return {
				content: [{ type: "text", text: `Closed: ${targets.map((entry) => entry.name).join(", ")}` }],
				details: { closed: targets.map((entry) => entry.id) },
			};
		},
	});

	pi.on("session_shutdown", () => {
		for (const entry of agents.values()) {
			entry.status = "aborted";
			entry.subscribe?.();
			try {
				entry.session?.abort();
				entry.session?.dispose();
			} catch {
				// Best-effort cleanup.
			}
		}
		agents.clear();
	});
}
