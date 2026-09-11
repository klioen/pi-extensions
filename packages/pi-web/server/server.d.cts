export interface PiWebAddress { host: string; port: number; url: string }
export interface PiWebServerOptions {
  host?: string;
  port?: number;
  cwd?: string;
  agentDir?: string;
  memoryDir?: string;
  memoryDbPath?: string;
  piRootDir?: string;
  diskUsageTtlMs?: number;
  diskUsageConcurrency?: number;
  diskUsageMaxEntries?: number;
  diskUsageMaxDepth?: number;
  publicDir?: string;
  projectTrusted?: boolean;
  listSessions?: () => Promise<any[]>;
  listEffectiveSkills?: () => any[];
  getCurrentSessionId?: () => string | undefined;
  renameSession?: (session: any, name: string, current: boolean) => void;
  deleteSession?: (session: any) => { method?: string } | void;
}
export interface PiWebServer {
  host: string;
  requestedPort: number;
  catalog: any;
  start(): Promise<PiWebAddress | undefined>;
  stop(): Promise<void>;
  address(): PiWebAddress | undefined;
}
export function createPiWebServer(options?: PiWebServerOptions): PiWebServer;
export function createCatalog(options?: PiWebServerOptions): any;
