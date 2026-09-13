export type LarkAction =
	| { action: "on" }
	| { action: "off" }
	| { action: "status" }
	| { action: "request"; request: string };
export interface LarkState { enabled: boolean; }
export interface NamedSkill { name: string; [key: string]: unknown; }
export const LARK_SKILL_PREFIX: "lark-";
export function parseLarkArgs(input?: string): LarkAction;
export function isLarkSkill(value: unknown): value is NamedSkill;
export function filterLarkSkills<T>(skills?: T[]): T[];
export function filterLarkSkillsFromPrompt(prompt: string): string;
export function normalizeLarkState(value: unknown): LarkState;
