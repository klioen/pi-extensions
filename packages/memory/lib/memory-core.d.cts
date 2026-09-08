export const SCHEMA: string;
export function phase1Prompt(transcript: string, rolloutPath: string, rolloutCwd: string): string;
export function completeLLM(config: unknown, prompt: string, signal?: AbortSignal): Promise<string>;
export function parseJsonObj(text: string): Record<string, any> | null;
export function repairJsonText(text: string): string;
export function redactSecrets(text: string): string;
export function sessionTranscriptFromJsonl(
	jsonl: string,
	maxChars: number,
): { transcript: string; lastTs: number; cwd: string };
export function upsertPhase1Job(
	db: { prepare(sql: string): { run(...args: any[]): { changes: number | bigint } } },
	jobKey: string,
	inputWatermark: number,
	payload: unknown,
	now?: number,
): boolean;
