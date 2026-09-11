export type DiskUsageSort = "size" | "name" | "modified" | "type";
export type DiskUsageOrder = "asc" | "desc";
export interface DiskUsageDiagnostic { relativePath: string; operation: string; code: string }
export interface DiskUsageItem {
	name: string;
	relativePath: string;
	type: "directory" | "file" | "symlink" | "other";
	size: number;
	fileCount: number;
	directoryCount: number;
	modifiedAt: string;
	percent: number;
	canDrillDown: boolean;
}
export interface DiskUsageResult {
	current: { name: string; relativePath: string; type: "directory"; modifiedAt: string | null };
	breadcrumbs: Array<{ name: string; relativePath: string }>;
	parent: string | null;
	totalSize: number;
	fileCount: number;
	directoryCount: number;
	scannedAt: string;
	durationMs: number;
	items: DiskUsageItem[];
	diagnostics: DiskUsageDiagnostic[];
	partial: boolean;
}
export interface DiskUsageOptions {
	sort?: DiskUsageSort;
	order?: DiskUsageOrder;
	refresh?: boolean;
	concurrency?: number;
	maxEntries?: number;
	maxDepth?: number;
	fs?: any;
}
export interface DiskUsageService {
	rootDir: string;
	get(relativePath?: string, options?: DiskUsageOptions): Promise<DiskUsageResult>;
	clear(): void;
}
export function normalizeRelativePath(value?: string): string;
export function scanDiskUsage(rootDir: string, relativePath?: string, options?: DiskUsageOptions): Promise<DiskUsageResult>;
export function createDiskUsageService(options?: { rootDir?: string; ttlMs?: number; concurrency?: number; maxEntries?: number; maxDepth?: number; fs?: any }): DiskUsageService;
