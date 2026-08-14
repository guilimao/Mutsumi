/**
 * @fileoverview Utility functions for the Mutsumi VSCode extension.
 * @module utils
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import {
    ModelSelection,
    DEFAULT_MODEL_SELECTION
} from './types';
import { LlmProviderService } from './llm/providerService';

/**
 * Resolved model selection: the canonical { model, provider } pair plus the
 * matched provider entry from the same single provider lookup.
 * @interface ResolvedModelSelection
 */
export interface ResolvedModelSelection extends ModelSelection {
    /** Resolved model capability metadata */
    modelInfo: import('./llm/types').ModelInfo;
}

/**
 * Validates and canonicalizes a model selection.
 * @description Trims names, verifies the provider exists, and verifies the
 * provider declares the requested model. Returns a canonical { model, provider }
 * pair together with the matched provider entry. Legacy string values and
 * incomplete objects are rejected.
 * @param {unknown} selection - The value to validate
 * @returns {ResolvedModelSelection} Canonical model/provider pair plus the matched provider entry
 * @throws {Error} If selection is not a complete valid pair or provider/model is missing
 */
export function resolveModelSelection(selection: unknown): ResolvedModelSelection {
    if (!selection || typeof selection !== 'object' || Array.isArray(selection)) {
        throw new Error('Model selection must be an object with "model" and "provider"');
    }

    const s = selection as Record<string, unknown>;
    if (typeof s.model !== 'string' || typeof s.provider !== 'string') {
        throw new Error('Model selection must have string "model" and "provider"');
    }

    const model = s.model.trim();
    const provider = s.provider.trim();

    if (!model) {
        throw new Error('Model selection "model" must be a non-empty string');
    }
    if (!provider) {
        throw new Error('Model selection "provider" must be a non-empty string');
    }

    return LlmProviderService.getInstance().resolveSelection({ model, provider });
}

/**
 * Resolves the default model selection from VS Code settings.
 * @description Reads mutsumi.defaultModel and validates it through the gate.
 * Falls back to the built-in default pair when unset.
 * @returns {ModelSelection} Validated default model/provider pair
 * @throws {Error} If the configured value is invalid
 */
export function getDefaultModelSelection(): ModelSelection {
    const config = vscode.workspace.getConfiguration('mutsumi');
    const defaultModel = config.get<ModelSelection>('defaultModel');
    if (defaultModel === undefined || defaultModel === null) {
        return DEFAULT_MODEL_SELECTION;
    }
    return resolveModelSelection(defaultModel);
}

/**
 * Resolves the title generator model selection from VS Code settings.
 * @description Reads mutsumi.titleGeneratorModel and validates it through the
 * gate. Returns undefined when unset.
 * @returns {ModelSelection | undefined} Validated title model/provider pair, or undefined
 * @throws {Error} If the configured value is invalid
 */
export function getTitleModelSelection(): ModelSelection | undefined {
    const config = vscode.workspace.getConfiguration('mutsumi');
    const titleModel = config.get<ModelSelection>('titleGeneratorModel');
    if (titleModel === undefined || titleModel === null) {
        return undefined;
    }
    return resolveModelSelection(titleModel);
}

/**
 * Resolves the conversation compression model selection from VS Code settings.
 * @description Reads mutsumi.compressModel and validates it through the gate.
 * Falls back to titleGeneratorModel, then to the default model selection.
 * @returns {ModelSelection} Validated compress model/provider pair
 * @throws {Error} If no valid selection can be resolved
 */
export function getCompressModelSelection(): ModelSelection {
    const config = vscode.workspace.getConfiguration('mutsumi');
    const compressModel = config.get<ModelSelection>('compressModel');
    if (compressModel !== undefined && compressModel !== null) {
        return resolveModelSelection(compressModel);
    }

    const titleModel = getTitleModelSelection();
    if (titleModel) {
        return titleModel;
    }

    return getDefaultModelSelection();
}

/**
 * Sanitizes a string to be safe for use as a file name.
 * @description Removes or replaces characters that are invalid in file systems
 * and normalizes whitespace.
 * @param {string} name - Original name to sanitize
 * @returns {string} Sanitized name safe for file system use
 */
export function sanitizeFileName(name: string): string {
    return name
        .replace(/[\\/:*?"<>|]/g, '-')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Ensures a file name is unique by appending a numeric suffix if needed.
 * @description Checks against existing names and generates a unique variant
 * by adding "-1", "-2", etc. as needed.
 * @param {string} baseName - Base file name without extension
 * @param {string[]} existingNames - Array of existing file names to check against
 * @returns {string} Unique file name
 */
export function ensureUniqueFileName(baseName: string, existingNames: string[]): string {
    if (!existingNames.includes(baseName)) {
        return baseName;
    }

    let counter = 1;
    let newName = `${baseName}-${counter}`;

    while (existingNames.includes(newName)) {
        counter++;
        newName = `${baseName}-${counter}`;
    }

    return newName;
}

/**
 * Get language identifier for Markdown code block based on file extension
 */
export function getLanguageIdentifier(ext: string): string {
    const langMap: Record<string, string> = {
        'ts': 'typescript',
        'tsx': 'tsx',
        'js': 'javascript',
        'jsx': 'jsx',
        'py': 'python',
        'rb': 'ruby',
        'go': 'go',
        'rs': 'rust',
        'java': 'java',
        'kt': 'kotlin',
        'swift': 'swift',
        'c': 'c',
        'cpp': 'cpp',
        'cc': 'cpp',
        'h': 'c',
        'hpp': 'cpp',
        'cs': 'csharp',
        'php': 'php',
        'html': 'html',
        'htm': 'html',
        'css': 'css',
        'scss': 'scss',
        'sass': 'sass',
        'less': 'less',
        'json': 'json',
        'xml': 'xml',
        'yaml': 'yaml',
        'yml': 'yaml',
        'toml': 'toml',
        'md': 'markdown',
        'sh': 'bash',
        'bash': 'bash',
        'zsh': 'zsh',
        'fish': 'fish',
        'ps1': 'powershell',
        'sql': 'sql',
        'dockerfile': 'dockerfile',
        'makefile': 'makefile',
        'vue': 'vue',
        'svelte': 'svelte',
        'astro': 'astro'
    };
    return langMap[ext.toLowerCase()] || '';
}

/**
 * Resolves the better-sqlite3 native binding path for the current platform/arch.
 * @description Returns the absolute path to the bundled `.node` binary when
 * running inside a universal VSIX. If the current platform is unsupported or
 * the binary does not exist, returns `undefined` so better-sqlite3 falls back
 * to its default binding resolution (preserving platform-specific package behavior).
 * @param {string} extensionPath - The extension root path (from `vscode.ExtensionContext.extensionPath`)
 * @returns {string | undefined} Absolute path to the native binary, or undefined to fall back
 */
export function getBetterSqlite3NativeBinding(extensionPath: string): string | undefined {
    const supportedPlatforms = [
        'win32-x64',
        'darwin-arm64',
        'linux-x64',
        'linux-arm64',
    ] as const;

    type SupportedPlatform = typeof supportedPlatforms[number];

    const filenameMap: Record<SupportedPlatform, string> = {
        'win32-x64': 'better_sqlite3-win32-x64.node',
        'darwin-arm64': 'better_sqlite3-darwin-arm64.node',
        'linux-x64': 'better_sqlite3-linux-x64.node',
        'linux-arm64': 'better_sqlite3-linux-arm64.node',
    };

    const platformKey = `${process.platform}-${process.arch}` as SupportedPlatform;
    if (!supportedPlatforms.includes(platformKey)) {
        return undefined;
    }

    const filename = filenameMap[platformKey];
    const nativePath = path.join(extensionPath, 'native', 'better-sqlite3', filename);

    if (!fs.existsSync(nativePath)) {
        return undefined;
    }

    return nativePath;
}
