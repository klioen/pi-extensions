export function readKeys(env: Record<string, string | undefined>): string[];
export function isRateLimitMessage(message: string | undefined): boolean;
export function createKeyPicker(): {
	pickKey(keys: string[], now: number): string | undefined;
	coolDown(key: string, until: number): void;
};
