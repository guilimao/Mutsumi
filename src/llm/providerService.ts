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
import { isModelThinkingLevel } from './thinkingLevels';
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
    /**
     * Aborted when this snapshot is superseded. In-flight refreshes share it, so a reload can
     * stop a network refresh that would otherwise persist a catalog built from the old profiles.
     */
    refreshAbort: AbortController;
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
    private globalState: vscode.Memento | undefined;
    /**
     * Catalog mutations from every snapshot's store view. Shared so a reload drains writes started
     * by earlier snapshots, not just the ones the current view would see.
     */
    private readonly catalogMutations = new Set<Promise<unknown>>();
    /** Tail of the serialized reload chain; overlapping config changes must publish in order. */
    private reloadChain: Promise<void> = Promise.resolve();

    static getInstance(): LlmProviderService {
        LlmProviderService.instance ??= new LlmProviderService();
        return LlmProviderService.instance;
    }

    async initialize(context: vscode.ExtensionContext): Promise<void> {
        this.credentialStore = new VsCodeCredentialStore(context.secrets, context.globalState);
        this.globalState = context.globalState;
        await this.reload();
    }

    /**
     * Rebuilds the registry from the current settings, one reload at a time.
     * @remarks Successive configuration changes fire overlapping reloads. Without serialization a
     * slower earlier reload could publish after a later one and restore the older config. Each
     * call is chained behind the previous one; the returned promise still rejects on failure so
     * callers can surface it, and the chain itself advances regardless.
     */
    reload(): Promise<void> {
        const result = this.reloadChain.then(() => this.doReload());
        this.reloadChain = result.catch(() => undefined);
        return result;
    }

    /** Build a complete candidate registry, restore cached catalogs, then publish atomically. */
    private async doReload(): Promise<void> {
        const credentials = this.requireCredentialStore();
        // Untrusted external input: validated into typed profiles by validateProfiles.
        const rawProfiles = vscode.workspace.getConfiguration('mutsumi')
            .get<unknown>('customProviders', {});
        const customProfiles = this.validateProfiles(rawProfiles);
        // Each custom provider's catalog is cached together with this fingerprint of the
        // declaration that produced it; see VsCodeModelsStore. Computing it before touching the
        // store makes a catalog and its declaration inseparable even if a later step fails.
        const fingerprints = new Map<string, string>();
        for (const [id, profile] of customProfiles) fingerprints.set(id, profileFingerprint(profile));

        // Build every provider and reject conflicts before touching persisted state: a failed
        // reload must leave the current snapshot — and its ability to refresh — intact.
        const providers = new Map<string, Provider>();
        for (const provider of builtinProviders()) {
            if (!provider.auth.apiKey) continue;
            providers.set(provider.id, provider);
        }
        for (const [id, profile] of customProfiles) {
            if (providers.has(id)) throw new Error(`Custom provider "${id}" conflicts with a built-in provider`);
            if (REMOVED_PROVIDER_IDS.has(id)) throw new Error(`Custom provider "${id}" uses a removed provider ID`);
            providers.set(id, this.createCustomProvider(id, profile));
        }

        // No refresh may outlive the snapshot it started from. Aborting stops new catalog writes,
        // but pi-ai races each refresh against the abort signal, so an already-started store write
        // can still be running after the refresh promise resolves. Drain the writes themselves
        // through the shared tracker, then drop catalogs tagged for the previous declarations.
        const outgoing = this.snapshot;
        outgoing?.refreshAbort.abort();
        try {
            const modelsStore = this.createCatalogStore(fingerprints);
            await modelsStore.drain();
            await modelsStore.purgeMismatched(fingerprints.keys());

            const models = createModels({ credentials, modelsStore });
            for (const provider of providers.values()) models.setProvider(provider);

            // Offline restore replays only catalogs whose embedded fingerprint matches this
            // candidate; a catalog from an earlier declaration reads as absent, so an edit can
            // never stay shadowed by its own old cache.
            await models.refresh({ allowNetwork: false });
            this.snapshot = { models, providers, customProfiles, refreshAbort: new AbortController() };
        } catch (error) {
            // A step above can fail (storage error) after the outgoing snapshot was aborted. Abort
            // is irreversible, so hand the retained snapshot a fresh controller — otherwise every
            // later refreshModels() would silently no-op against an aborted signal.
            if (outgoing) outgoing.refreshAbort = new AbortController();
            throw error;
        }
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
        const snapshot = this.requireSnapshot();
        // A superseded snapshot never refreshes: reload aborts this controller, and a call that
        // slips in during the swap returns without resurrecting the stale catalog.
        if (snapshot.refreshAbort.signal.aborted) return new Map();
        const result = await snapshot.models.refresh({
            allowNetwork: true,
            force: true,
            signal: snapshot.refreshAbort.signal,
        });
        return result.errors;
    }

    async deleteCachedModels(provider: string): Promise<void> {
        await this.createCatalogStore(new Map()).delete(provider);
    }

    getCredentialStore(): VsCodeCredentialStore {
        return this.requireCredentialStore();
    }

    /**
     * Validates the untrusted `mutsumi.customProviders` value into typed profiles.
     * @remarks The parameter stays `unknown` on purpose: settings JSON is external input and
     * a typed signature would only pretend the shape was checked. Every field is narrowed here
     * before it reaches {@link CustomProviderProfile}.
     */
    private validateProfiles(raw: unknown): Map<string, CustomProviderProfile> {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
            throw new Error('mutsumi.customProviders must be an object keyed by provider route');
        }
        const result = new Map<string, CustomProviderProfile>();
        for (const [untrimmedId, rawProfile] of Object.entries(raw as Record<string, unknown>)) {
            const id = untrimmedId.trim();
            if (!id) throw new Error('Custom provider IDs must be non-empty');
            if (result.has(id)) throw new Error(`Custom provider route "${id}" is duplicated after trimming`);
            if (!rawProfile || typeof rawProfile !== 'object' || Array.isArray(rawProfile)) {
                throw new Error(`Custom provider "${id}" must be an object`);
            }
            const profile = rawProfile as Record<string, unknown>;
            if (profile.displayName !== undefined && typeof profile.displayName !== 'string') {
                throw new Error(`Custom provider "${id}" displayName must be a string`);
            }
            const displayName = typeof profile.displayName === 'string' ? profile.displayName.trim() : '';
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
            const models = this.validateModelEntries(id, profile.models);
            const capabilities = this.validateCapabilities(id, profile.capabilities);
            result.set(id, {
                ...displayName ? { displayName } : {},
                baseUrl,
                api,
                auth,
                models,
                ...(capabilities ? { capabilities } : {}),
            });
        }
        return result;
    }

    private validateModelEntries(id: string, entries: unknown): (string | CustomModelSpec)[] {
        if (entries === undefined) return [];
        if (!Array.isArray(entries)) {
            throw new Error(`Custom provider "${id}" models must be an array of model IDs or specs`);
        }
        const models: (string | CustomModelSpec)[] = [];
        const seen = new Map<string, number>();
        for (let index = 0; index < entries.length; index++) {
            const entry: unknown = entries[index];
            if (typeof entry === 'string') {
                const modelId = entry.trim();
                if (!modelId) throw new Error(`Custom provider "${id}" models must contain non-empty strings`);
                this.assertUniqueModelId(id, seen, modelId, index);
                models.push(modelId);
                continue;
            }
            if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
                throw new Error(`Custom provider "${id}" models must contain non-empty strings or model specs`);
            }
            const spec = entry as Record<string, unknown>;
            const modelId = typeof spec.id === 'string' ? spec.id.trim() : '';
            if (!modelId) throw new Error(`Custom provider "${id}" model specs must have a non-empty id`);
            this.assertUniqueModelId(id, seen, modelId, index);
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
                const map = spec.thinkingLevelMap;
                if (!map || typeof map !== 'object' || Array.isArray(map)) {
                    throw new Error(`Custom provider "${id}" model "${modelId}" thinkingLevelMap must be an object`);
                }
                // Keys are Mutsumi's own vocabulary (the SDK level names); values stay opaque
                // passthrough (C6). An unknown key would otherwise be silently inert.
                for (const [level, value] of Object.entries(map as Record<string, unknown>)) {
                    if (!isModelThinkingLevel(level)) {
                        throw new Error(`Custom provider "${id}" model "${modelId}" thinkingLevelMap has unknown level "${level}"`);
                    }
                    if (value !== null && typeof value !== 'string') {
                        throw new Error(`Custom provider "${id}" model "${modelId}" thinkingLevelMap.${level} must be a string or null`);
                    }
                }
                normalized.thinkingLevelMap = map as CustomModelSpec['thinkingLevelMap'];
            }
            if (spec.compat !== undefined) {
                // Opaque advanced passthrough (C6): only the container shape is checked. Key names
                // and nested values belong to the SDK's compat interfaces, which carry nested
                // objects, string arrays and nulls; mirroring those shapes here would rot on every
                // SDK upgrade, and a partial check that lets unknown keys through anyway is worse
                // than an explicit passthrough contract.
                if (!spec.compat || typeof spec.compat !== 'object' || Array.isArray(spec.compat)) {
                    throw new Error(`Custom provider "${id}" model "${modelId}" compat must be an object`);
                }
                normalized.compat = spec.compat as CustomModelSpec['compat'];
            }
            models.push(normalized);
        }
        return models;
    }

    /**
     * Rejects duplicate declared model IDs instead of picking a winner.
     * @remarks "First declaration wins" and the provider editor's "spec wins" write-back
     * ordering used to disagree, so an unrelated UI edit could flip a model's capabilities.
     * The conflict is reported with both array positions; string and spec forms share one
     * namespace because they are compared after trimming.
     */
    private assertUniqueModelId(id: string, seen: Map<string, number>, modelId: string, index: number): void {
        const previous = seen.get(modelId);
        if (previous !== undefined) {
            throw new Error(`Custom provider "${id}" declares model "${modelId}" more than once (models[${previous}] and models[${index}])`);
        }
        seen.set(modelId, index);
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

    /** One snapshot's view of the catalog store, keyed by that snapshot's declared fingerprints. */
    private createCatalogStore(fingerprints: ReadonlyMap<string, string>): VsCodeModelsStore {
        if (!this.globalState) throw new Error('LLM model store has not been initialized');
        return new VsCodeModelsStore(this.globalState, fingerprints, this.catalogMutations);
    }
}
