import * as vscode from 'vscode';
import {
    createModels,
    createProvider,
    getSupportedThinkingLevels,
} from '@earendil-works/pi-ai';
import type {
    Api,
    AuthInteraction,
    Credential,
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
import type { CustomProviderProfile, ModelInfo, ProviderInfo } from './types';

const DEFAULT_CONTEXT_WINDOW = 262_144;
const DEFAULT_MAX_TOKENS = 32_768;
const DISCOVERY_LIMIT = 4 * 1024 * 1024;
const DISCOVERY_TIMEOUT_MS = 15_000;
const LEGACY_PROVIDER_ALIASES: Readonly<Record<string, string>> = {
    'kimi-for-coding': 'kimi-coding',
};
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

/** Extension-level owner of provider catalogs, credentials, and LLM dispatch. */
export class LlmProviderService {
    private static instance: LlmProviderService | undefined;

    private snapshot: Snapshot | undefined;
    private credentialStore: VsCodeCredentialStore | undefined;
    private modelsStore: VsCodeModelsStore | undefined;
    private context: vscode.ExtensionContext | undefined;

    static getInstance(): LlmProviderService {
        LlmProviderService.instance ??= new LlmProviderService();
        return LlmProviderService.instance;
    }

    async initialize(context: vscode.ExtensionContext): Promise<void> {
        this.context = context;
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
        const models = createModels({ credentials, modelsStore });
        const providers = new Map<string, Provider>();

        for (const provider of builtinProviders()) {
            if (!provider.auth.apiKey) continue;
            providers.set(provider.id, provider);
            models.setProvider(provider);
        }
        for (const [id, profile] of customProfiles) {
            if (providers.has(id) || LEGACY_PROVIDER_ALIASES[id]) {
                throw new Error(`Custom provider "${id}" conflicts with a built-in provider`);
            }
            const provider = this.createCustomProvider(id, profile);
            providers.set(id, provider);
            models.setProvider(provider);
        }

        await models.refresh({ allowNetwork: false });
        this.snapshot = { models, providers, customProfiles };
    }

    canonicalProvider(provider: string): string {
        return LEGACY_PROVIDER_ALIASES[provider] ?? provider;
    }

    resolveSelection(selection: ModelSelection): ModelSelection & { modelInfo: ModelInfo } {
        const provider = this.canonicalProvider(selection.provider.trim());
        const model = selection.model.trim();
        if (!provider || !model) throw new Error('Model and provider must be non-empty strings');
        const resolved = this.requireSnapshot().models.getModel(provider, model);
        if (!resolved) throw new Error(`Model "${model}" is not available from provider "${provider}"`);
        return { provider, model, modelInfo: this.toModelInfo(resolved) };
    }

    getModel(provider: string, model: string): Model<Api> {
        const canonical = this.canonicalProvider(provider);
        const resolved = this.requireSnapshot().models.getModel(canonical, model);
        if (!resolved) throw new Error(`Model "${model}" is not available from provider "${canonical}"`);
        return resolved;
    }

    /** Capture the registry and model used by one request so config reloads cannot split it. */
    prepare(provider: string, model: string): { models: Models; model: Model<Api>; provider: string } {
        const snapshot = this.requireSnapshot();
        const canonical = this.canonicalProvider(provider);
        const resolved = snapshot.models.getModel(canonical, model);
        if (!resolved) throw new Error(`Model "${model}" is not available from provider "${canonical}"`);
        return { models: snapshot.models, model: resolved, provider: canonical };
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
            .getModels(this.canonicalProvider(provider))
            .map(model => this.toModelInfo(model));
    }

    isBuiltInProviderId(provider: string): boolean {
        const canonical = this.canonicalProvider(provider);
        const snapshot = this.requireSnapshot();
        return snapshot.providers.has(canonical) && !snapshot.customProfiles.has(canonical);
    }

    async configureApiKey(provider: string, interaction: AuthInteraction): Promise<Error | undefined> {
        const canonical = this.canonicalProvider(provider);
        const snapshot = this.requireSnapshot();
        const entry = snapshot.providers.get(canonical);
        if (!entry?.auth.apiKey?.login) throw new Error(`Provider "${canonical}" does not support API-key setup`);
        await snapshot.models.login(canonical, 'api_key', interaction);
        if (entry.refreshModels) return (await this.refreshModels()).get(canonical);
        return undefined;
    }

    async deleteCredential(provider: string): Promise<void> {
        await this.requireSnapshot().models.logout(this.canonicalProvider(provider));
    }

    async refreshModels(): Promise<ReadonlyMap<string, Error>> {
        const result = await this.requireSnapshot().models.refresh({ allowNetwork: true, force: true });
        return result.errors;
    }

    async deleteCachedModels(provider: string): Promise<void> {
        await this.requireModelsStore().delete(this.canonicalProvider(provider));
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
            const models = profile.models ?? [];
            if (!Array.isArray(models) || models.some(model => typeof model !== 'string' || !model.trim())) {
                throw new Error(`Custom provider "${id}" models must contain non-empty strings`);
            }
            result.set(id, {
                ...profile.displayName?.trim() ? { displayName: profile.displayName.trim() } : {},
                baseUrl,
                api,
                auth,
                models: [...new Set(models.map(model => model.trim()))],
            });
        }
        return result;
    }

    private createCustomProvider(id: string, profile: CustomProviderProfile): Provider {
        const api = profile.api ?? 'openai-completions';
        const models = (profile.models ?? []).map(modelId => this.customModel(id, profile, modelId));
        const auth = profile.auth ?? 'apiKey';
        return createProvider({
            id,
            name: profile.displayName ?? id,
            baseUrl: profile.baseUrl,
            auth: {
                apiKey: auth === 'none' ? {
                    name: 'No authentication',
                    check: async () => ({ type: 'api_key', source: 'No authentication' }),
                    resolve: async () => ({ auth: {}, source: 'No authentication' }),
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

    private customModel(id: string, profile: CustomProviderProfile, modelId: string, entry?: ListingEntry): Model<Api> {
        const api = profile.api ?? 'openai-completions';
        return {
            id: modelId,
            name: this.label(entry?.name, entry?.display_name) ?? modelId,
            api,
            provider: id,
            baseUrl: profile.baseUrl,
            reasoning: false,
            input: ['text'],
            cost: NO_COST,
            contextWindow: this.capacity(entry?.context_window, entry?.context_length) ?? DEFAULT_CONTEXT_WINDOW,
            maxTokens: this.capacity(entry?.max_output_tokens, entry?.max_tokens) ?? DEFAULT_MAX_TOKENS,
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
            for (const raw of data) {
                const entry = raw as ListingEntry | null;
                const modelId = this.label(entry?.id);
                if (!modelId || seen.has(modelId)) continue;
                seen.add(modelId);
                result.push(this.customModel(id, profile, modelId, entry ?? undefined));
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
            reasoningEfforts: model.reasoning
                ? getSupportedThinkingLevels(model).map(level => level === 'off' ? 'none' : level)
                : [],
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
