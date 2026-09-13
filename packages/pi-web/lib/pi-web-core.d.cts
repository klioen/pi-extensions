export interface Diagnostic { path?: string; scope?: string; line?: number; message: string }
export interface RevisionWriteResult { path: string; revision: string; bytes: number }
export interface SkillValidation { valid: boolean; errors: string[]; warnings: string[]; name?: string; description?: string; metadata: Record<string, unknown>; body: string; attributes: Record<string, unknown> }
export const SKILL_NAME_RE: RegExp;
export const MEMORY_DOCUMENTS: Readonly<Record<"summary" | "handbook", string>>;
export function sha256Revision(value: string | Buffer): string;
export function isPathContained(root: string, candidate: string): boolean;
export function resolveContainedPath(root: string, ...parts: string[]): string;
export function assertExpectedRevision(current: string | Buffer, expectedRevision: string): string;
export function atomicWriteFile(filePath: string, content: string | Buffer, options?: { mode?: number; exclusive?: boolean }): RevisionWriteResult;
export function createFileExclusive(filePath: string, content: string | Buffer): RevisionWriteResult;
export function writeFileWithRevision(filePath: string, content: string | Buffer, expectedRevision: string, options?: { maxCurrentBytes?: number }): RevisionWriteResult;
export function deleteFileWithRevision(filePath: string, expectedRevision: string): RevisionWriteResult;
export function normalizeSessionName(name: unknown): string;
export function renameSessionWithRevision(filePath: string, name: unknown, expectedRevision: string, rename: (name: string) => void, maxBytes?: number): { name: string; revision: string; bytes: number };
export function removeSessionWithRevision(filePath: string, expectedRevision: string, remove: (filePath: string) => { method?: string } | void, maxBytes?: number): { deleted: true; method?: string; revision: string; bytes: number };
export function readTextBounded(filePath: string, maxBytes?: number): { text: string; bytes: number; truncated: boolean };
export function readTailLinesBounded(filePath: string, lineCount?: number, maxBytes?: number): string[];
export function parseSkillFrontmatter(text: string): { attributes: Record<string, any>; body: string; errors: string[] };
export function validateSkillDocument(text: string): SkillValidation;
export function serializeSkillDocument(input: { name: string; description: string; body?: string; license?: string; compatibility?: string; metadata?: Record<string, string>; "allowed-tools"?: string; "disable-model-invocation"?: boolean }): string;
export function parseJsonFile(filePath: string): { path: string; exists: boolean; value: Record<string, any>; revision?: string; diagnostics: string[] };
export function catalogSettings(globalSettingsPath?: string, projectSettingsPath?: string): { settings: any[]; packages: any[]; extensionPaths: any[]; diagnostics: Diagnostic[] };
export function catalogExtensions(roots: Array<string | { path: string; scope: string }>): { entries: any[]; diagnostics: Diagnostic[] };
export function catalogSkills(roots: Array<string | { path: string; scope: string; mutable?: boolean }>): { skills: any[]; diagnostics: Diagnostic[] };
export function catalogEffectiveSkills(commands: any[], writableRoots?: Array<{ path: string; scope: string; mutable?: boolean }>): { skills: any[]; diagnostics: Diagnostic[] };
export function validateMemoryDocument(document: string, content: string): { valid: boolean; errors: string[]; fileName?: string };
export interface SessionChatTextContent { type: "text"; text: string; truncated?: true }
export interface SessionChatToolCallContent { type: "toolCall"; id: string; name: string }
export interface SessionChatHistoryEntry {
	id?: string;
	role: "user" | "assistant" | "toolResult" | "custom";
	timestamp?: string;
	content: Array<SessionChatTextContent | SessionChatToolCallContent>;
	toolCallId?: string;
	toolName?: string;
	isError?: boolean;
	customType?: string;
}
export interface SessionChatHistory {
	entries: SessionChatHistoryEntry[];
	metadata: { sourceEntries: number; displayableEntries: number; returnedEntries: number; omittedEntries: number; truncated: boolean; contentTruncated: boolean };
}
export function selectActiveSessionBranch<T>(records: T[]): T[];
export function normalizeSessionChatHistory(records: unknown[], options?: { maxEntries?: number; maxTextChars?: number; maxContentBlocks?: number }): SessionChatHistory;
export function parseSessionJsonl(text: string, options?: { maxEntries?: number; keepLatest?: boolean }): { header: any; entries: any[]; diagnostics: Diagnostic[]; summary: { sessionId?: string; cwd?: string; totalEntries: number; returnedEntries: number; truncated: boolean; counts: Record<string, number>; firstTimestamp?: number; lastTimestamp?: number } };
export function summarizeSessions(sessions: any[], query?: string): any[];
export interface SessionTreeNode { id: string; name: string; children: SessionTreeNode[]; sessions: any[]; sessionCount: number; modified?: string | number }
export function buildSessionTree(sessions: any[]): SessionTreeNode[];
