export interface ObservatoryTableCapability { available: boolean; columns: string[] }
export interface ObservatoryCapabilities {
	tables: Record<string, ObservatoryTableCapability>;
	features: Record<string, boolean>;
}
export interface MemoryObservatory {
	db: any | null;
	dbPath: string;
	memoryDir: string;
	availability: { available: boolean; reason?: string };
	capabilities: ObservatoryCapabilities;
	close(): void;
}
export interface PageOptions { limit?: number; offset?: number }
export interface PageInfo { limit: number; offset: number; returned: number; hasMore: boolean }
export interface Paged<T> { items: T[]; page: PageInfo; unavailable?: string }
export interface JobView {
	kind: string; jobKey: string; status: string; state: string; workerId: string | null;
	leaseUntil: number | null; retryUntil: number | null; retryRemaining: number | null; lastError: string | null;
	createdAt: number | null; startedAt: number | null; finishedAt: number | null;
	inputWatermark: number | null; lastSuccessWatermark: number | null;
}
export interface Phase1Metadata {
	sessionId: string; sourceUpdatedAt: number; generatedAt: number | null; rolloutSlug: string | null;
	rawMemoryBytes: number; rolloutSummaryBytes: number; usageCount: number; lastUsage: number | null;
	selectedForPhase2: boolean; selectedSourceUpdatedAt: number | null;
}
export interface RecallUsage { total: number; usedOutputs: number; lastUsedAt: number | null }
export interface ArtifactSummary {
	total: number; consistent: number; mismatched: number; missing: number; orphaned: number; unknown: number;
	consistency: "consistent" | "mismatch" | "unknown";
}
export interface ArtifactMetadata {
	id: string; name: string; kind: "file" | "directory"; type: string; exists: boolean; bytes: number;
	modifiedAt: string | null; itemCount: number | null; status: string; consistency: string;
}
export interface ArtifactDetail extends ArtifactMetadata { entries?: ArtifactMetadata[] }
export interface PipelineStage { name: string; status: string; updatedAt: number | null }
export interface ScanState { scanKey?: string; state: string; requestedGeneration: number | null; completedGeneration: number | null; requestedAt: number | null }
export const DEFAULT_LIMIT: number;
export const MAX_LIMIT: number;
export function openMemoryObservatory(options: { dbPath: string; memoryDir?: string }): MemoryObservatory;
export function probeCapabilities(db: any): ObservatoryCapabilities;
export function deriveWorkerState(row: { lease_until?: number | null }, now: number): string;
export function deriveJobState(row: { status?: string; lease_until?: number | null; retry_until?: number | null; retry_remaining?: number | null }, now: number): string;
export function queryOverview(observatory: MemoryObservatory, options?: { now?: number }): {
	availability: MemoryObservatory["availability"]; capabilities: ObservatoryCapabilities;
	counts: { jobs: number; phase1: number; sessions: number; workers: number; artifacts: number };
	statuses?: Array<{ status: string; count: number }>; activeWorkers?: number; pipelineStatus?: string; pipeline: PipelineStage[];
	scanState?: ScanState; lastScanAt?: number | null; lastPhase1At?: number | null; lastPhase2At?: number | null;
	recallUsage?: number; recallUsageSummary?: RecallUsage; artifacts?: ArtifactSummary;
};
export function queryWorkers(observatory: MemoryObservatory, options?: PageOptions & { now?: number }): Paged<any>;
export function queryJobs(observatory: MemoryObservatory, options?: PageOptions & { now?: number; kind?: string; status?: string }): Paged<JobView>;
export function querySessions(observatory: MemoryObservatory, options?: PageOptions & { q?: string; now?: number }): Paged<{ sessionId: string; updatedAt: number; lastSeenAt: number; phase1State: string; scanStatus: string; phase1Status: string }>;
export function queryPhase1(observatory: MemoryObservatory, options?: PageOptions & { selected?: boolean | string | number; used?: boolean | string | number; q?: string }): Paged<Phase1Metadata>;
export function queryPhase1Detail(observatory: MemoryObservatory, sessionId: string): (Phase1Metadata & { materialized: { name: string; exists: boolean; consistent: boolean } }) | null;
export function queryPhase1Content(observatory: MemoryObservatory, sessionId: string, field: "rolloutSummary" | "rawMemory", options?: { maxBytes?: number }): { field: string; content: string; bytes: number; totalBytes: number; truncated: boolean } | null;
export function queryPhase2(observatory: MemoryObservatory, options?: { now?: number }): {
	available: boolean; job: JobView | null; jobStatus?: string; watermark: unknown; lastSuccessAt: unknown;
	selectedOutputs: Array<Phase1Metadata & { materialized: { name: string; exists: boolean; consistent: boolean; consistency: string } }>;
	consistency: string; recallUsage: RecallUsage; artifactSummary: ArtifactSummary; artifacts: ArtifactMetadata[];
};
export function queryArtifacts(observatory: MemoryObservatory, options?: PageOptions): Paged<ArtifactMetadata> & { summary: ArtifactSummary };
export function queryArtifactDetail(observatory: MemoryObservatory, artifactId: string): ArtifactDetail;
export function queryArtifactContent(observatory: MemoryObservatory, artifactId: string, options?: { maxBytes?: number }): { id: string; name: string; kind: "file"; type: string; consistency: string; content: string; bytes: number; totalBytes: number; truncated: boolean };
export function queryLogs(observatory: MemoryObservatory, options?: { lines?: number; maxBytes?: number }): { lines: string[]; lineCount: number; bytes: number; truncated: boolean };
export function sanitizeDiagnosticText(value: unknown): string;
