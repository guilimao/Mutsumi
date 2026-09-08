import * as vscode from 'vscode';
import {
    createModels,
    createProvider,
    getSupportedThinkingLevels,
} from '@earendil-works/pi-ai';
import type {
    Api,
    AuthInteraction,
    Model,
    Models,
    MutableModels,
    Provider,
    RefreshModelsContext,
} from '@earendil-works/pi-ai';
import { builtinProviders } from '@earendil-works/pi-ai/providers/all';
import * as openaiCompletions from '@earendil-works/pi-ai/api/openai-completions';
import * as openaiResponses from '@earendil-works/pi-ai/api/openai-responses';
import type { ModelSelection } from '../types';
import { VsCodeCredentialStore } from './credentialStore';
import { VsCodeModelsStore } from './modelStore';
import type { CustomModelSpec, CustomProviderCapabilities, CustomProviderProfile, ModelInfo, ProviderInfo } from './types';

const DEFAULT_CONTEXT_WINDOW = 262_144;
const DEFAULT_MAX_TOKENS = 32_768;
const DISCOVERY_LIMIT = 4 * 1024 * 1024;
const DISCOVERY_TIMEOUT_MS = 15_000;
const REMOVED_PROVIDER_IDS = new Set(['kimi-for-coding']);
const NO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

interface Snapshot {
    models: MutableModels;
    providers: ReadonlyMap<string, Provider>;
    customProfiles: ReadonlyMap<string, CustomProviderProfile>;
}

interface ListingEntry {
    id?: unknown;
    name?: unknown;
    display_name?: unknown;
    context_window?: unknown;
    context_length?: unknown;
    max_tokens?: unknown;
    max_output_tokens?: unknown;
}

/** Stable serialization for fingerprinting; sorts object keys so settings key order cannot flip it. */
function canonicalize(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value && typeof value === 'object') {
        const record = value as Record<string, unknown>;
        return Object.fromEntries(
            Object.keys(record).sort().map(key => [key, canonicalize(record[key])]),
        );
    }
    return value;
}

/**
 * Fingerprint of the declared fields that shape cached Model objects. displayName/auth are
 * deliberately excluded: they do not appear in discovered Model entries, so changing them must
 * not drop the discovery cache (undeclared discovered models would vanish until a network refresh).
 */
function profileFingerprint(profile: CustomProviderProfile): string {
    return JSON.stringify(canonicalize({
        baseUrl: profile.baseUrl,
        api: profile.api,
        capabilities: profile.capabilities,
        models: profile.models,
    }));
}

/** Extension-level owner of provider catalogs, credentials, and LLM dispatch. */
export class LlmProviderService {
    private static instance: LlmProviderService | undefined;

    private snapshot: Snapshot | undefined;
    private credentialStore: VsCodeCredentialStore | undefined;
    private modelsStore: VsCodeModelsStore | undefined;

    static getInstance(): LlmProviderService {
        LlmProviderService.instance ??= new LlmProviderService();
        return LlmProviderService.instance;
    }

    async initialize(context: vscode.ExtensionContext): Promise<void> {
        this.credentialStore = new VsCodeCredentialStore(context.secrets, context.globalState);
        this.modelsStore = new VsCodeModelsStore(context.globalState);
        await this.reload();
    }

    /** Build a complete candidate registry, restore cached catalogs, then publish atomically. */
    async reload(): Promise<void> {
        const credentials = this.requireCredentialStore();
        const modelsStore = this.requireModelsStore();
        const rawProfiles = vscode.workspace.getConfiguration('mutsumi')
            .get<Record<string, CustomProviderProfile>>('customProviders', {});
        const customProfiles = this.validateProfiles(rawProfiles);
        // pi-ai restores the persisted discovery cache over the declared baseline by id, so a
        // profile edit would otherwise stay shadowed until a successful network refresh — across
        // restarts too, because the cache lives in globalState. Compare the persisted profile
        // fingerprint and drop the cache when the fields that shape Model objects change.
        for (const [id, profile] of customProfiles) {
            const fingerprint = profileFingerprint(profile);
            const previous = await modelsStore.readProfileFingerprint(id);
            if (previous === fingerprint) continue;
            if (previous !== undefined) await modelsStore.delete(id);
            await modelsStore.writeProfileFingerprint(id, fingerprint);
        }
        const models = createModels({ credentials, modelsStore });
        const providers = new Map<string, Provider>();

        for (const provider of builtinProviders()) {
            if (!provider.auth.apiKey) continue;
            providers.set(provider.id, provider);
            models.setProvider(provider);
        }
        for (const [id, profile] of customProfiles) {
            if (providers.has(id)) throw new Error(`Custom provider "${id}" conflicts with a built-in provider`);
            if (REMOVED_PROVIDER_IDS.has(id)) throw new Error(`Custom provider "${id}" uses a removed provider ID`);
            const provider = this.createCustomProvider(id, profile);
            providers.set(id, provider);
            models.setProvider(provider);
        }

        await models.refresh({ allowNetwork: false });
        this.snapshot = { models, providers, customProfiles };
    }

    resolveSelection(selection: ModelSelection): ModelSelection & { modelInfo: ModelInfo } {
        const provider = selection.provider.trim();
        const model = selection.model.trim();
        if (!provider || !model) throw new Error('Model and provider must be non-empty strings');
        const resolved = this.requireSnapshot().models.getModel(provider, model);
        if (!resolved) throw new Error(`Model "${model}" is not available from provider "${provider}"`);
        return { provider, model, modelInfo: this.toModelInfo(resolved) };
    }

    getModel(provider: string, model: string): Model<Api> {
        const resolved = this.requireSnapshot().models.getModel(provider, model);
        if (!resolved) throw new Error(`Model "${model}" is not available from provider "${provider}"`);
        return resolved;
    }

    /** Capture the registry and model used by one request so config reloads cannot split it. */
    prepare(provider: string, model: string): { models: Models; model: Model<Api>; provider: string; isBuiltIn: boolean } {
        const snapshot = this.requireSnapshot();
        const resolved = snapshot.models.getModel(provider, model);
        if (!resolved) throw new Error(`Model "${model}" is not available from provider "${provider}"`);
        return { models: snapshot.models, model: resolved, provider, isBuiltIn: !snapshot.customProfiles.has(provider) };
    }

    async listProviders(): Promise<ProviderInfo[]> {
        const snapshot = this.requireSnapshot();
        const result: ProviderInfo[] = [];
        for (const provider of snapshot.providers.values()) {
            let authSource: string | undefined;
            let configured = false;
            try {
                const auth = await snapshot.models.checkAuth(provider.id);
                configured = auth !== undefined;
                authSource = auth?.source;
            } catch {
                authSource = undefined;
            }
            result.push({
                id: provider.id,
                name: provider.name,
                isCustom: snapshot.customProfiles.has(provider.id),
                isDynamic: provider.refreshModels !== undefined,
                configured,
                canConfigureApiKey: provider.auth.apiKey?.login !== undefined,
                ...(authSource ? { authSource } : {}),
                modelCount: snapshot.models.getModels(provider.id).length,
            });
        }
        return result.sort((a, b) => a.name.localeCompare(b.name));
    }

    async listAvailableModels(autoRefresh = true): Promise<ModelInfo[]> {
        let snapshot = this.requireSnapshot();
        let available = await snapshot.models.getAvailable();
        let needsRefresh = false;
        if (autoRefresh) {
            for (const provider of snapshot.providers.values()) {
                if (!provider.refreshModels || snapshot.models.getModels(provider.id).length > 0) continue;
                try {
                    if (await snapshot.models.checkAuth(provider.id)) {
                        needsRefresh = true;
                        break;
                    }
                } catch {
                    // Authentication diagnostics are surfaced by provider management.
                }
            }
        }
        if (needsRefresh) {
            await this.refreshModels();
            snapshot = this.requireSnapshot();
            available = await snapshot.models.getAvailable();
        }
        return available.map(model => this.toModelInfo(model));
    }

    listModels(provider: string): ModelInfo[] {
        return this.requireSnapshot().models
            .getModels(provider)
            .map(model => this.toModelInfo(model));
    }

    isBuiltInProviderId(provider: string): boolean {
        const snapshot = this.requireSnapshot();
        return snapshot.providers.has(provider) && !snapshot.customProfiles.has(provider);
    }

    async configureApiKey(provider: string, interaction: AuthInteraction): Promise<Error | undefined> {
        const snapshot = this.requireSnapshot();
        const entry = snapshot.providers.get(provider);
        if (!entry?.auth.apiKey?.login) throw new Error(`Provider "${provider}" does not support API-key setup`);
        await snapshot.models.login(provider, 'api_key', interaction);
        if (entry.refreshModels) return (await this.refreshModels()).get(provider);
        return undefined;
    }

    async deleteCredential(provider: string): Promise<void> {
        await this.requireSnapshot().models.logout(provider);
    }

    async refreshModels(): Promise<ReadonlyMap<string, Error>> {
        const result = await this.requireSnapshot().models.refresh({ allowNetwork: true, force: true });
        return result.errors;
    }

    async deleteCachedModels(provider: string): Promise<void> {
        await this.requireModelsStore().delete(provider);
    }

    getCredentialStore(): VsCodeCredentialStore {
        return this.requireCredentialStore();
    }

    private validateProfiles(raw: Record<string, CustomProviderProfile>): Map<string, CustomProviderProfile> {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
            throw new Error('mutsumi.customProviders must be an object keyed by provider route');
        }
        const result = new Map<string, CustomProviderProfile>();
        for (const [untrimmedId, profile] of Object.entries(raw)) {
            const id = untrimmedId.trim();
            if (!id) throw new Error('Custom provider IDs must be non-empty');
            if (result.has(id)) throw new Error(`Custom provider route "${id}" is duplicated after trimming`);
            if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
                throw new Error(`Custom provider "${id}" must be an object`);
            }
            const baseUrl = typeof profile.baseUrl === 'string' ? profile.baseUrl.trim() : '';
            if (!baseUrl) throw new Error(`Custom provider "${id}" has an empty baseUrl`);
            let parsedUrl: URL;
            try {
                parsedUrl = new URL(baseUrl);
            } catch {
                throw new Error(`Custom provider "${id}" has an invalid baseUrl`);
            }
            if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
                throw new Error(`Custom provider "${id}" baseUrl must use HTTP(S)`);
            }
            if (parsedUrl.username || parsedUrl.password) {
                throw new Error(`Custom provider "${id}" baseUrl must not contain credentials`);
            }
            const api = profile.api ?? 'openai-completions';
            if (api !== 'openai-completions' && api !== 'openai-responses') {
                throw new Error(`Custom provider "${id}" has unsupported api "${String(profile.api)}"`);
            }
            const auth = profile.auth ?? 'apiKey';
            if (auth !== 'apiKey' && auth !== 'none') {
                throw new Error(`Custom provider "${id}" has unsupported auth "${String(profile.auth)}"`);
            }
            const models = this.validateModelEntries(id, profile.models ?? []);
            const capabilities = this.validateCapabilities(id, profile.capabilities);
            result.set(id, {
                ...profile.displayName?.trim() ? { displayName: profile.displayName.trim() } : {},
                baseUrl,
                api,
                auth,
                models,
                ...(capabilities ? { capabilities } : {}),
            });
        }
        return result;
    }

    private validateModelEntries(id: string, entries: unknown[]): (string | CustomModelSpec)[] {
        const models: (string | CustomModelSpec)[] = [];
        const seen = new Set<string>();
        for (const entry of entries) {
            if (typeof entry === 'string') {
                const modelId = entry.trim();
                if (!modelId) throw new Error(`Custom provider "${id}" models must contain non-empty strings`);
                if (seen.has(modelId)) continue;
                seen.add(modelId);
                models.push(modelId);
                continue;
            }
            if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
                throw new Error(`Custom provider "${id}" models must contain non-empty strings or model specs`);
            }
            const spec = entry as Record<string, unknown>;
            const modelId = typeof spec.id === 'string' ? spec.id.trim() : '';
            if (!modelId) throw new Error(`Custom provider "${id}" model specs must have a non-empty id`);
            // Validate before deduplicating: a malformed duplicate must still surface as a
            // configuration error instead of being silently ignored (first entry still wins).
            const normalized: CustomModelSpec = { id: modelId };
            if (spec.name !== undefined) {
                if (typeof spec.name !== 'string' || !spec.name.trim()) {
                    throw new Error(`Custom provider "${id}" model "${modelId}" name must be a non-empty string`);
                }
                normalized.name = spec.name.trim();
            }
            if (spec.reasoning !== undefined) {
                if (typeof spec.reasoning !== 'boolean') {
                    throw new Error(`Custom provider "${id}" model "${modelId}" reasoning must be a boolean`);
                }
                normalized.reasoning = spec.reasoning;
            }
            if (spec.input !== undefined) {
                normalized.input = this.validateInputModalities(id, modelId, spec.input);
            }
            if (spec.contextWindow !== undefined) {
                if (typeof spec.contextWindow !== 'number' || !Number.isInteger(spec.contextWindow) || spec.contextWindow <= 0) {
                    throw new Error(`Custom provider "${id}" model "${modelId}" contextWindow must be a positive integer`);
                }
                normalized.contextWindow = spec.contextWindow;
            }
            if (spec.maxTokens !== undefined) {
                if (typeof spec.maxTokens !== 'number' || !Number.isInteger(spec.maxTokens) || spec.maxTokens <= 0) {
                    throw new Error(`Custom provider "${id}" model "${modelId}" maxTokens must be a positive integer`);
                }
                normalized.maxTokens = spec.maxTokens;
            }
            if (spec.thinkingLevelMap !== undefined) {
                if (!spec.thinkingLevelMap || typeof spec.thinkingLevelMap !== 'object' || Array.isArray(spec.thinkingLevelMap)
                    || Object.values(spec.thinkingLevelMap).some(value => value !== null && typeof value !== 'string')) {
                    throw new Error(`Custom provider "${id}" model "${modelId}" thinkingLevelMap must map levels to strings or null`);
                }
                normalized.thinkingLevelMap = spec.thinkingLevelMap as CustomModelSpec['thinkingLevelMap'];
            }
            if (spec.compat !== undefined) {
                // Shallow passthrough (C6): the SDK's compat interfaces carry nested object
                // flags (chatTemplateArgs / chatTemplateKwargs / openRouterRouting / ...), so
                // plain objects are accepted alongside primitives; arrays and null are not part
                // of any SDK compat field shape and stay rejected.
                const validCompatValue = (value: unknown): boolean =>
                    typeof value === 'boolean' || typeof value === 'string' || typeof value === 'number'
                    || (value !== null && typeof value === 'object' && !Array.isArray(value));
                if (!spec.compat || typeof spec.compat !== 'object' || Array.isArray(spec.compat)
                    || Object.values(spec.compat).some(value => !validCompatValue(value))) {
                    throw new Error(`Custom provider "${id}" model "${modelId}" compat must map flag names to booleans, strings, numbers, or plain objects`);
                }
                normalized.compat = spec.compat as CustomModelSpec['compat'];
            }
            if (seen.has(modelId)) continue;
            seen.add(modelId);
            models.push(normalized);
        }
        return models;
    }

    private validateCapabilities(id: string, capabilities: unknown): CustomProviderCapabilities | undefined {
        if (capabilities === undefined) return undefined;
        if (!capabilities || typeof capabilities !== 'object' || Array.isArray(capabilities)) {
            throw new Error(`Custom provider "${id}" capabilities must be an object`);
        }
        const raw = capabilities as Record<string, unknown>;
        const normalized: CustomProviderCapabilities = {};
        if (raw.reasoning !== undefined) {
            if (typeof raw.reasoning !== 'boolean') {
                throw new Error(`Custom provider "${id}" capabilities.reasoning must be a boolean`);
            }
            normalized.reasoning = raw.reasoning;
        }
        if (raw.input !== undefined) {
            normalized.input = this.validateInputModalities(id, 'capabilities', raw.input);
        }
        return normalized;
    }

    private validateInputModalities(id: string, subject: string, input: unknown): ('text' | 'image')[] {
        if (!Array.isArray(input) || input.length === 0
            || input.some(value => value !== 'text' && value !== 'image')) {
            throw new Error(`Custom provider "${id}" ${subject} input must be a non-empty subset of ['text', 'image']`);
        }
        return [...new Set(input as ('text' | 'image')[])];
    }

    private createCustomProvider(id: string, profile: CustomProviderProfile): Provider {
        const api = profile.api ?? 'openai-completions';
        const models = this.declaredModelSpecs(profile).map(spec => this.customModel(id, profile, spec.id, undefined, spec));
        const auth = profile.auth ?? 'apiKey';
        return createProvider({
            id,
            name: profile.displayName ?? id,
            baseUrl: profile.baseUrl,
            auth: {
                apiKey: auth === 'none' ? {
                    name: 'No authentication',
                    check: async () => ({ type: 'api_key', source: 'No authentication' }),
                    // pi-ai's OpenAI APIs require an apiKey (or an authorization header) before they
                    // will build a client; satisfy that gate with a placeholder so keyless local
                    // servers can still be called.
                    resolve: async () => ({ auth: { apiKey: 'unused' }, source: 'No authentication' }),
                } : {
                    name: `${profile.displayName ?? id} API key`,
                    login: async interaction => ({
                        type: 'api_key',
                        key: await interaction.prompt({
                            type: 'secret',
                            message: `Enter the API key for ${profile.displayName ?? id}`,
                        }),
                    }),
                    check: async ({ credential }) => credential?.key
                        ? { type: 'api_key', source: 'VS Code SecretStorage' }
                        : undefined,
                    resolve: async ({ credential }) => credential?.key
                        ? { auth: { apiKey: credential.key }, source: 'VS Code SecretStorage' }
                        : undefined,
                },
            },
            models,
            fetchModels: context => this.discoverCustomModels(id, profile, context),
            api: api === 'openai-responses' ? openaiResponses : openaiCompletions,
        });
    }

    /** Normalizes declared models into specs; the string form is shorthand for `{ id }`. */
    private declaredModelSpecs(profile: CustomProviderProfile): CustomModelSpec[] {
        return (profile.models ?? []).map(entry => typeof entry === 'string' ? { id: entry } : entry);
    }

    private customModel(
        id: string,
        profile: CustomProviderProfile,
        modelId: string,
        entry?: ListingEntry,
        spec?: CustomModelSpec,
    ): Model<Api> {
        const api = profile.api ?? 'openai-completions';
        return {
            id: modelId,
            name: spec?.name ?? this.label(entry?.name, entry?.display_name) ?? modelId,
            api,
            provider: id,
            baseUrl: profile.baseUrl,
            // Unknown capabilities are optimistic, not unsupported (docs/custom-model-capabilities.md C1/C3):
            // provider capabilities < listing numbers < per-model spec.
            reasoning: spec?.reasoning ?? profile.capabilities?.reasoning ?? true,
            input: spec?.input ?? profile.capabilities?.input ?? ['text', 'image'],
            cost: NO_COST,
            contextWindow: spec?.contextWindow
                ?? this.capacity(entry?.context_window, entry?.context_length)
                ?? DEFAULT_CONTEXT_WINDOW,
            maxTokens: spec?.maxTokens
                ?? this.capacity(entry?.max_output_tokens, entry?.max_tokens)
                ?? DEFAULT_MAX_TOKENS,
            ...(spec?.thinkingLevelMap ? { thinkingLevelMap: spec.thinkingLevelMap } : {}),
            // Wire-safety default: pi-ai switches reasoning-capable models to the `developer` role,
            // which Ollama/vLLM/SGLang-class servers commonly reject (SDK README); users can opt
            // back in per model via the compat passthrough.
            compat: { supportsDeveloperRole: false, ...spec?.compat } as Model<Api>['compat'],
        };
    }

    private async discoverCustomModels(
        id: string,
        profile: CustomProviderProfile,
        context: RefreshModelsContext,
    ): Promise<readonly Model<Api>[]> {
        const url = `${profile.baseUrl.replace(/\/+$/, '')}/models`;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), DISCOVERY_TIMEOUT_MS);
        const signal = context.signal ? AbortSignal.any([context.signal, controller.signal]) : controller.signal;
        const key = context.credential?.type === 'api_key' ? context.credential.key : undefined;
        try {
            const response = await fetch(url, {
                headers: {
                    accept: 'application/json',
                    ...(key ? { authorization: `Bearer ${key}` } : {}),
                },
                signal,
            });
            if (!response.ok) {
                throw new Error(`${url} returned HTTP ${response.status}${response.status === 401 || response.status === 403 ? '; check the API key' : ''}`);
            }
            const text = await this.readBounded(response, url);
            let value: unknown;
            try {
                value = JSON.parse(text);
            } catch (error) {
                throw new Error(`${url} did not return JSON`, { cause: error });
            }
            const data = (value as { data?: unknown } | null)?.data;
            if (!Array.isArray(data)) throw new Error(`${url} model listing has no data array`);
            const result: Model<Api>[] = [];
            const seen = new Set<string>();
            // Declared specs must survive refresh even though createProvider lets dynamic listings
            // replace same-id baseline models (docs/custom-model-capabilities.md C4): re-apply each
            // spec onto its discovered entry. Declared-only models need no appending — the SDK
            // merges the baseline, which already carries them, into currentModels().
            const pendingSpecs = new Map(this.declaredModelSpecs(profile).map(spec => [spec.id, spec]));
            for (const raw of data) {
                const entry = raw as ListingEntry | null;
                const modelId = this.label(entry?.id);
                if (!modelId || seen.has(modelId)) continue;
                seen.add(modelId);
                const spec = pendingSpecs.get(modelId);
                pendingSpecs.delete(modelId);
                result.push(this.customModel(id, profile, modelId, entry ?? undefined, spec));
            }
            if (result.length === 0) throw new Error(`${url} returned no usable model IDs`);
            return result;
        } finally {
            clearTimeout(timeout);
        }
    }

    private async readBounded(response: Response, url: string): Promise<string> {
        const declared = Number(response.headers.get('content-length') ?? Number.NaN);
        if (Number.isFinite(declared) && declared > DISCOVERY_LIMIT) {
            await response.body?.cancel();
            throw new Error(`${url} returned more than ${DISCOVERY_LIMIT} bytes`);
        }
        if (!response.body) return '';
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let total = 0;
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.byteLength;
            if (total > DISCOVERY_LIMIT) {
                await reader.cancel();
                throw new Error(`${url} returned more than ${DISCOVERY_LIMIT} bytes`);
            }
            chunks.push(value);
        }
        const body = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
            body.set(chunk, offset);
            offset += chunk.byteLength;
        }
        return new TextDecoder().decode(body);
    }

    private capacity(...values: unknown[]): number | undefined {
        return values.find(value => typeof value === 'number' && Number.isInteger(value) && value > 0) as number | undefined;
    }

    private label(...values: unknown[]): string | undefined {
        return values.find(value => typeof value === 'string' && value.trim())?.toString().trim();
    }

    private toModelInfo(model: Model<Api>): ModelInfo {
        return {
            id: model.id,
            name: model.name,
            provider: model.provider,
            input: [...model.input],
            contextWindow: model.contextWindow,
            maxTokens: model.maxTokens,
            reasoningEfforts: model.reasoning ? getSupportedThinkingLevels(model) : [],
        };
    }

    private requireSnapshot(): Snapshot {
        if (!this.snapshot) throw new Error('LLM provider service has not been initialized');
        return this.snapshot;
    }

    private requireCredentialStore(): VsCodeCredentialStore {
        if (!this.credentialStore) throw new Error('LLM credential store has not been initialized');
        return this.credentialStore;
    }

    private requireModelsStore(): VsCodeModelsStore {
        if (!this.modelsStore) throw new Error('LLM model store has not been initialized');
        return this.modelsStore;
    }
}
