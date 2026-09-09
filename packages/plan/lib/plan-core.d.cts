export const PLAN_TOOLS: string[];
export function parsePlanArgs(input?: string): { action?: string; error?: string };
export function isReadOnlyBashCommand(command: string): boolean;
export function normalizePlanState(value: unknown): { enabled: boolean; toolsBeforePlanMode?: string[] };
export function buildPlanPrompt(): string;
export function buildNormalPrompt(): string;
