export const PLAN_TOOLS: string[];
export type PlanAction = "on" | "off" | "status";
export interface PlanArgs { action?: PlanAction; error?: string; }
export interface PlanState { enabled: boolean; toolsBeforePlanMode?: string[]; }
export function parsePlanArgs(input?: string): PlanArgs;
export function isReadOnlyBashCommand(command: string): boolean;
export function normalizePlanState(value: unknown): PlanState;
export function buildPlanPrompt(): string;
