/**
 * @fileoverview Global tool variable cache for Mutsumi.
 * @module tools.d/cache
 * @description
 * This module provides a global, shared cache for tool execution results and
 * intermediate variables used by tools. It is used by both:
 * - ToolExecutor (for Agent runtime tool execution)
 * - ToolManager (for pre-execution in context management)
 *
 * The cache is intentionally global and not tied to any specific Agent,
 * as tool results and intermediate variables depend only on the code state,
 * file system, and environment, not on which Agent is requesting them.
 */

import * as cp from "child_process";
import { debugLogger } from "../debugLogger";

/** Global tool variable cache Map. Values can be any type. */
const toolVariableCache = new Map<string, any>();

const CACHE_LOG_PREFIX = "[ToolCache]";

/**
 * Unified logging function for tool cache operations.
 * @param message - The message to log
 */
function cacheLog(message: string): void {
	debugLogger.log(`${CACHE_LOG_PREFIX} ${message}`);
}

/**
 * Get a generic tool variable from the cache.
 * @param name - Variable name
 * @returns The cached value, or undefined if not found
 */
export function getToolVar<T>(name: string): T | undefined {
	const value = toolVariableCache.get(name) as T | undefined;
	if (value !== undefined) {
		cacheLog(`VAR HIT for "${name}"`);
	}
	return value;
}

/**
 * Store a generic tool variable in the cache.
 * @param name - Variable name
 * @param value - Value to cache
 */
export function setToolVar<T>(name: string, value: T): void {
	toolVariableCache.set(name, value);
	cacheLog(
		`Stored var "${name}" - cache size: ${toolVariableCache.size}`,
	);
}

/**
 * Clear all cached tool variables and results.
 */
export function clearToolCache(): void {
	cacheLog(`Clearing cache. Previous size: ${toolVariableCache.size}`);
	toolVariableCache.clear();
}

/**
 * Generate a cache key from tool name and arguments.
 * @param toolName - Tool name
 * @param args - Tool arguments
 * @returns Cache key string
 */
function generateCacheKey(toolName: string, args: unknown): string {
	const key = `${toolName}:${JSON.stringify(args)}`;
	cacheLog(`Generated key: ${key}`);
	return key;
}

/**
 * Execute a tool through the shared cache policy used by both runtime and
 * user-authored pre-execution paths. The caller retains ownership of approval,
 * cancellation, and tool-session lifecycle inside the supplied operation.
 */
export async function executeWithToolCache(
	toolName: string,
	args: unknown,
	shouldCache: boolean,
	operation: () => Promise<string>,
): Promise<string> {
	if (!shouldCache) {
		return operation();
	}

	const key = generateCacheKey(toolName, args);
	const cached = getToolVar<string>(key);
	if (cached !== undefined) {
		return cached;
	}

	const result = await operation();
	setToolVar(key, result);
	return result;
}

/**
 * Mapping from Windows code page identifiers to iconv-lite/TEXT encoding names.
 * Keep this as a plain constant table so it is easy to extend and inspect.
 */
export const CODEPAGE_TO_ENCODING: Record<number, string> = {
	65001: "utf8",
	1200: "utf16le",
	1201: "utf16be",
	437: "cp437",
	850: "cp850",
	852: "cp852",
	866: "cp866",
	932: "shift_jis",
	936: "gbk",
	949: "euc-kr",
	950: "big5",
	1250: "windows-1250",
	1251: "windows-1251",
	1252: "windows-1252",
	1253: "windows-1253",
	1254: "windows-1254",
	1255: "windows-1255",
	1256: "windows-1256",
	1257: "windows-1257",
	1258: "windows-1258",
};

/**
 * Convert a Windows code page number to an encoding name.
 * @param codepage - Windows code page number
 * @returns Encoding name, or null if not in the mapping
 */
export function codepageToEncoding(codepage: number): string | null {
	return CODEPAGE_TO_ENCODING[codepage] ?? null;
}

const SYSTEM_CODEPAGE_KEY = "system_info.codepage";

/**
 * Get the cached Windows console code page, if any.
 * @returns Code page number, or null if not cached
 */
export function getWindowsCodepage(): number | null {
	const cp = getToolVar<number>(SYSTEM_CODEPAGE_KEY);
	return cp ?? null;
}

/**
 * Set the cached Windows console code page.
 * @param codepage - Code page number
 */
export function setWindowsCodepage(codepage: number): void {
	setToolVar(SYSTEM_CODEPAGE_KEY, codepage);
}

/**
 * Detect the active Windows console code page by running `chcp`.
 * The result is cached so subsequent calls are cheap.
 * @returns Code page number, or null on non-Windows or failure
 */
export function detectWindowsCodepage(): number | null {
	const cached = getWindowsCodepage();
	if (cached !== null) {
		return cached;
	}

	if (process.platform !== "win32") {
		return null;
	}

	try {
		// chcp output examples:
		// English: "Active code page: 936"
		// Chinese: "活动代码页: 936"
		// The number after the colon is ASCII, so UTF-8 decoding is safe.
		const output = cp.execSync("chcp", {
			encoding: "utf8",
			timeout: 5000,
		});
		const match = output.match(/:\s*(\d+)/);
		const codepage = match ? parseInt(match[1], 10) : null;
		if (codepage !== null) {
			setWindowsCodepage(codepage);
			cacheLog(`Detected Windows codepage: ${codepage}`);
		}
		return codepage;
	} catch (err: any) {
		cacheLog(`Failed to detect Windows codepage: ${err.message}`);
		return null;
	}
}
