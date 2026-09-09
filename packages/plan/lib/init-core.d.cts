export interface InitArgs {
	force?: boolean;
	error?: string;
}

export type InitMode = "create" | "update" | "replace";

export function parseInitArgs(input?: string): InitArgs;
export function initMode(agentsExists: boolean, force: boolean): InitMode;
export function buildInitPrompt(input: { agentsPath: string; mode: InitMode }): string;
