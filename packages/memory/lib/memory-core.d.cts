export const SCHEMA: string;
export const DEFAULT_ROLLOUT_TOKEN_LIMIT: number;
export const ROLLOUT_CONTEXT_WINDOW_PERCENT: number;
export function estimateTextTokens(text: string): number;
export function resolveRolloutTokenBudget(contextWindow?: number): number;
export function truncateTextToTokenBudget(text: string, maxTokens: number): string;
export function phase1PiArgs(modelSpec?: string): string[];
export function phase1Prompt(transcript: string, rolloutPath: string, rolloutCwd: string): string;
export function parseJsonObj(text: string): Record<string, any> | null;
export function repairJsonText(text: string): string;
export function redactSecrets(text: string): string;
export function sessionTranscriptFromJsonl(
	jsonl: string,
	maxTokens: number,
): { transcript: string; lastTs: number; cwd: string };
export interface SqliteLike {
	prepare(sql: string): {
		run(...args: any[]): { changes: number | bigint };
		get(...args: any[]): any;
		all(...args: any[]): any[];
	};
}
export interface WorkerLease {
	lease_key: string;
	owner_id: string;
	ownership_token: string;
	lease_until: number;
	heartbeat_at: number;
	created_at: number;
}
export function upsertPhase1Job(db: SqliteLike, jobKey: string, inputWatermark: number, payload: unknown, now?: number): boolean;
export function upsertSession(db: SqliteLike, sessionId: string, rolloutPath: string, updatedAt: number, cwd?: string, now?: number): boolean;
export function requestSessionScan(db: SqliteLike, currentSessionId: string, scanKey?: string, now?: number): number;
export function pendingSessionScan(db: SqliteLike, scanKey?: string): { requested_generation: number; completed_generation: number; requested_at: number; current_session_id?: string } | null;
export function completeSessionScan(db: SqliteLike, generation: number, scanKey?: string): boolean;
export function selectIdleSessions(db: SqliteLike, currentSessionId: string, now: number, minIdleMs: number, maxAgeMs: number, limit: number): Array<{ session_id: string; rollout_path: string; updated_at: number; cwd?: string }>;
export function claimWorkerLease(db: SqliteLike, leaseKey: string, ownerId: string, ownershipToken: string, leaseMs: number, now?: number): boolean;
export function heartbeatWorkerLease(db: SqliteLike, leaseKey: string, ownershipToken: string, leaseMs: number, now?: number): boolean;
export function releaseWorkerLease(db: SqliteLike, leaseKey: string, ownershipToken: string): boolean;
export function inspectWorkerLease(db: SqliteLike, leaseKey: string): WorkerLease | null;
