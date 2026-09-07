export interface GoalLike {
	status: string;
	tokenBudget: number | null;
	tokensUsed: number;
	turns: number;
	objective: string;
	timeUsedSeconds: number;
}
export function extractTokenUsage(event: { messages: Array<{ usage?: { input?: number; output?: number } }> }): number;
export function enforceLimits(g: GoalLike, maxTurns?: number): string;
export function statusLabel(s: string): string;
export function formatSeconds(seconds: number): string;
export function continuationMessage(g: GoalLike): string;
export function parseGoalArgs(
	args: string,
	defaultBudget?: number,
): { action: string; objective: string; budget: number | null; error?: string };
