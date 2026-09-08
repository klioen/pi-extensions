export const PLAN_TOOLS: string[];
export type PlanStatus = "pending" | "in_progress" | "completed" | "blocked";
export interface PlanStep { id: string; step: string; status: PlanStatus; }
export interface PlanState { enabled: boolean; toolsBeforePlanMode?: string[]; plan: PlanStep[]; explanation?: string; }
export function parsePlanArgs(input?: string): { action?: "on" | "off" | "status"; error?: string };
export function isReadOnlyBashCommand(command: string): boolean;
export function normalizePlanState(value: unknown): PlanState;
export function validatePlan(plan: unknown, explanation?: string, previous?: PlanStep[]): PlanStep[];
export function buildPlanPrompt(): string;
