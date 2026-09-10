import { afterEach, describe, expect, it, vi } from 'vitest';

const vscodeState = vi.hoisted(() => ({ profiles: {} as Record<string, unknown>, configReads: 0 }));
vi.mock('vscode', () => ({
    workspace: {
        getConfiguration: () => {
            vscodeState.configReads++;
            return { get: (_key: string, fallback: unknown) => vscodeState.profiles ?? fallback };
        },
    },
}));

import { LlmProviderService } from '../src/llm/providerService';

class MemorySecrets {
    readonly values = new Map<string, string>();
    async get(key: string) { return this.values.get(key); }
    async store(key: string, value: string) { this.values.set(key, value); }
    async delete(key: string) { this.values.delete(key); }
}

class MemoryMemento {
    readonly values = new Map<string, unknown>();
    get<T>(key: string, fallback?: T): T { return (this.values.has(key) ? this.values.get(key) : fallback) as T; }
    async update(key: string, value: unknown) { this.values.set(key, value); }
}

function context() {
    return { secrets: new MemorySecrets(), globalState: new MemoryMemento() } as any;
}

afterEach(() => {
    vscodeState.profiles = {};
    vscodeState.configReads = 0;
    vi.restoreAllMocks();
    vi.useRealTimers();
});

describe('LlmProviderService registry', () => {
    it('loads the built-in catalog and rejects the removed legacy Kimi provider ID', async () => {
        const service = new LlmProviderService();
        await service.initialize(context());
        const selection = service.resolveSelection({ provider: 'kimi-coding', model: 'kimi-for-coding' });
        expect(selection.modelInfo.input).toContain('image');
        expect(() => service.resolveSelection({ provider: 'kimi-for-coding', model: 'kimi-for-coding' })).toThrow('not available');
    });

    it('rejects custom route collisions without replacing the previous registry', async () => {
        const service = new LlmProviderService();
        await service.initialize(context());
        vscodeState.profiles = {
            'kimi-coding': { baseUrl: 'https://example.test/v1', auth: 'none' },
        };

        await expect(service.reload()).rejects.toThrow('conflicts with a built-in provider');
        expect(service.getModel('kimi-coding', 'kimi-for-coding').id).toBe('kimi-for-coding');
    });

    it.each([
        [{ 'kimi-for-coding': { baseUrl: 'https://example.test/v1' } }, 'uses a removed provider ID'],
        [{ local: { baseUrl: 'file:///tmp/models' } }, 'must use HTTP(S)'],
        [{ local: { baseUrl: 'https://user:secret@example.test/v1' } }, 'must not contain credentials'],
    ])('rejects unsafe or conflicting custom configuration', async (profiles, message) => {
        vscodeState.profiles = profiles;
        const service = new LlmProviderService();
        await expect(service.initialize(context())).rejects.toThrow(message);
    });

    it('normalizes custom routes and applies optimistic undeclared capability defaults', async () => {
        vscodeState.profiles = {
            local: {
                displayName: ' Local ', baseUrl: 'http://localhost:8080/v1/',
                auth: 'none', models: [' test-model '],
            },
        };
        const service = new LlmProviderService();
        await service.initialize(context());
        const model = service.getModel('local', 'test-model');
        expect(model).toMatchObject({
            contextWindow: 262144, maxTokens: 32768,
            // Unknown capabilities are optimistic, not unsupported (C1).
            reasoning: true, input: ['text', 'image'],
            compat: { supportsDeveloperRole: false },
        });
        expect(service.listModels('local')[0].reasoningEfforts).toContain('off');
        expect(service.listModels('local')[0].reasoningEfforts).toContain('high');
    });

    it('resolves declared capabilities with spec over provider defaults', async () => {
        vscodeState.profiles = {
            local: {
                baseUrl: 'http://localhost:8080/v1', auth: 'none',
                capabilities: { reasoning: false, input: ['text'] },
                models: [
                    'plain-string-model',
                    { id: 'spec-model', reasoning: true, input: ['text'], contextWindow: 4096, maxTokens: 512 },
                ],
            },
        };
        const service = new LlmProviderService();
        await service.initialize(context());
        expect(service.getModel('local', 'plain-string-model')).toMatchObject({
            reasoning: false, input: ['text'], contextWindow: 262144,
        });
        expect(service.getModel('local', 'spec-model')).toMatchObject({
            reasoning: true, input: ['text'], contextWindow: 4096, maxTokens: 512,
        });
        expect(service.listModels('local').find(model => model.id === 'plain-string-model')?.reasoningEfforts)
            .toEqual([]);
    });

    it.each([
        [{ local: { baseUrl: 'https://example.test/v1', models: [{ id: '' }] } }, 'non-empty id'],
        [{ local: { baseUrl: 'https://example.test/v1', models: [{ id: 'm', reasoning: 'yes' }] } }, 'reasoning must be a boolean'],
        [{ local: { baseUrl: 'https://example.test/v1', models: [{ id: 'm', input: ['video'] }] } }, 'subset of'],
        [{ local: { baseUrl: 'https://example.test/v1', models: [{ id: 'm', contextWindow: 0 }] } }, 'positive integer'],
        [{ local: { baseUrl: 'https://example.test/v1', capabilities: { reasoning: 1 } } }, 'must be a boolean'],
        [{ local: { baseUrl: 'https://example.test/v1', models: [{ id: 'm', compat: [] }] } }, 'compat must be an object'],
        [{ local: { baseUrl: 'https://example.test/v1', models: [{ id: 'm', thinkingLevelMap: { medum: null } }] } }, 'unknown level "medum"'],
        [{ local: { baseUrl: 'https://example.test/v1', models: [{ id: 'm', thinkingLevelMap: { off: true } }] } }, 'thinkingLevelMap.off must be a string or null'],
        [{ local: { baseUrl: 'https://example.test/v1', models: 'gpt' } }, 'models must be an array'],
        [{ local: { baseUrl: 'https://example.test/v1', models: {} } }, 'models must be an array'],
        [{ local: { baseUrl: 'https://example.test/v1', displayName: 123 } }, 'displayName must be a string'],
    ])('rejects invalid capability declarations (%j)', async (profiles, message) => {
        vscodeState.profiles = profiles;
        const service = new LlmProviderService();
        await expect(service.initialize(context())).rejects.toThrow(message);
    });

    it('accepts nested-object compat flags and level maps as SDK passthrough (C6)', async () => {
        vscodeState.profiles = {
            local: {
                baseUrl: 'https://example.test/v1', auth: 'none',
                models: [{
                    id: 'chat-template-model',
                    thinkingLevelMap: { off: null, high: 'high' },
                    compat: {
                        supportsDeveloperRole: true,
                        chatTemplateArgs: { enable_thinking: { $var: 'thinking.enabled' } },
                    },
                }],
            },
        };
        const service = new LlmProviderService();
        await service.initialize(context());
        const model = service.getModel('local', 'chat-template-model');
        expect(model.thinkingLevelMap).toEqual({ off: null, high: 'high' });
        expect(model.compat).toMatchObject({
            supportsDeveloperRole: true,
            chatTemplateArgs: { enable_thinking: { $var: 'thinking.enabled' } },
        });
    });

    it.each([
        [['dup-model', 'dup-model'], 'models[0] and models[1]'],
        [[' m ', 'm'], 'models[0] and models[1]'],
        [['dup-model', { id: 'dup-model', reasoning: true }], 'models[0] and models[1]'],
        [[{ id: 'dup-model' }, { id: 'dup-model' }], 'models[0] and models[1]'],
        [['a', 'b', 'a'], 'models[0] and models[2]'],
    ])('rejects duplicate model IDs instead of letting order decide capabilities (%j)', async (models, message) => {
        vscodeState.profiles = { local: { baseUrl: 'https://example.test/v1', models } };
        const service = new LlmProviderService();
        await expect(service.initialize(context())).rejects.toThrow(message);
    });

    it('still validates spec fields when the model ID is unique', async () => {
        vscodeState.profiles = {
            local: {
                baseUrl: 'https://example.test/v1',
                models: [{ id: 'only-model', reasoning: 'not-a-boolean' }],
            },
        };
        const service = new LlmProviderService();
        await expect(service.initialize(context())).rejects.toThrow('reasoning must be a boolean');
    });

    it('invalidates a cached discovered catalog when the declared profile changes, including across restarts', async () => {
        const globalState = new MemoryMemento();
        const restartContext = () => ({ secrets: new MemorySecrets(), globalState }) as any;
        vscodeState.profiles = {
            local: {
                baseUrl: 'https://example.test/v1', auth: 'none',
                models: [{ id: 'discovered-model', reasoning: false }],
            },
        };
        const first = new LlmProviderService();
        await first.initialize(restartContext());
        const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(
            JSON.stringify({ data: [{ id: 'discovered-model' }, { id: 'server-only-model' }] }),
            { status: 200, headers: { 'content-type': 'application/json' } },
        ));
        await first.refreshModels();
        expect(first.getModel('local', 'discovered-model').reasoning).toBe(false);
        expect(first.getModel('local', 'server-only-model').id).toBe('server-only-model');

        // Edit the declaration, then simulate an extension restart: a fresh service instance
        // sharing globalState. The persisted catalog must not shadow the new declaration.
        vscodeState.profiles = {
            local: {
                baseUrl: 'https://example.test/v1', auth: 'none',
                models: [{ id: 'discovered-model', reasoning: true }],
            },
        };
        const second = new LlmProviderService();
        await second.initialize(restartContext());
        expect(second.getModel('local', 'discovered-model').reasoning).toBe(true);
        // The invalidated cache's server-only model is gone until the next network refresh.
        expect(() => second.getModel('local', 'server-only-model')).toThrow('not available');
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('drops a catalog cached before profile fingerprints existed (upgrade path)', async () => {
        const globalState = new MemoryMemento();
        // Upgrade scenario: the discovery cache key exists from an older extension version, the
        // fingerprint key introduced with the invalidation fix does not. A "no fingerprint" cache
        // must be treated as changed, not as unchanged.
        globalState.values.set('mutsumi.llmModels.v1.local', {
            checkedAt: 1,
            models: [{
                id: 'discovered-model', name: 'stale', api: 'openai-completions', provider: 'local',
                baseUrl: 'https://example.test/v1', reasoning: false, input: ['text'],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 8192, maxTokens: 1024,
            }],
        });
        vscodeState.profiles = {
            local: {
                baseUrl: 'https://example.test/v1', auth: 'none',
                models: [{ id: 'discovered-model', reasoning: true }],
            },
        };

        const service = new LlmProviderService();
        await service.initialize({ secrets: new MemorySecrets(), globalState } as any);

        // The restored stale entry (reasoning: false) must not shadow the declaration.
        expect(service.getModel('local', 'discovered-model').reasoning).toBe(true);
        expect(globalState.values.get('mutsumi.llmModels.v1.local')).toBeUndefined();
    });

    it('invalidates the cache on api or model-list changes, not only capability specs', async () => {
        const globalState = new MemoryMemento();
        const restartContext = () => ({ secrets: new MemorySecrets(), globalState }) as any;
        vscodeState.profiles = {
            local: {
                baseUrl: 'https://example.test/v1', auth: 'none', api: 'openai-completions',
                models: ['kept-model', 'removed-model'],
            },
        };
        const first = new LlmProviderService();
        await first.initialize(restartContext());
        vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(
            JSON.stringify({ data: [{ id: 'kept-model' }, { id: 'removed-model' }] }),
            { status: 200, headers: { 'content-type': 'application/json' } },
        ));
        await first.refreshModels();
        expect(first.getModel('local', 'kept-model').api).toBe('openai-completions');

        vscodeState.profiles = {
            local: {
                baseUrl: 'https://example.test/v1', auth: 'none', api: 'openai-responses',
                models: ['kept-model'],
            },
        };
        const second = new LlmProviderService();
        await second.initialize(restartContext());
        expect(second.getModel('local', 'kept-model').api).toBe('openai-responses');
        expect(() => second.getModel('local', 'removed-model')).toThrow('not available');
    });

    it('keeps declared specs authoritative over discovered listing entries on refresh', async () => {
        vscodeState.profiles = {
            local: {
                baseUrl: 'https://example.test/v1', auth: 'none',
                models: [{ id: 'discovered-model', reasoning: false, input: ['text'] }, 'declared-only-model'],
            },
        };
        const service = new LlmProviderService();
        await service.initialize(context());
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
            data: [
                { id: 'discovered-model', context_window: 8192 },
                { id: 'server-extra-model' },
            ],
        }), { status: 200, headers: { 'content-type': 'application/json' } }));

        await service.refreshModels();

        // Discovered entry keeps its server-provided numbers but the declared spec wins on capabilities.
        expect(service.getModel('local', 'discovered-model')).toMatchObject({
            reasoning: false, input: ['text'], contextWindow: 8192,
        });
        // Declared-only and server-extra models both survive the merge.
        expect(service.getModel('local', 'declared-only-model').id).toBe('declared-only-model');
        expect(service.getModel('local', 'server-extra-model')).toMatchObject({ reasoning: true, input: ['text', 'image'] });
    });

    it('drains a catalog write that is already running when the profile reloads', async () => {
        const globalState = new MemoryMemento();
        const restartContext = () => ({ secrets: new MemorySecrets(), globalState }) as any;
        vscodeState.profiles = {
            local: {
                baseUrl: 'https://example.test/v1', auth: 'none',
                models: [{ id: 'mutable-model', reasoning: false }],
            },
        };
        const service = new LlmProviderService();
        await service.initialize(restartContext());

        // Stall the catalog write itself. The SDK races refresh against the abort signal, so its
        // refresh promise resolves while this write is still running; the reload must wait for the
        // write, not for the promise.
        const catalogKey = 'mutsumi.llmModels.v1.local';
        const update = globalState.update.bind(globalState);
        let writeStarted!: () => void;
        const started = new Promise<void>(resolve => { writeStarted = resolve; });
        let releaseWrite!: () => void;
        const writeGate = new Promise<void>(resolve => { releaseWrite = resolve; });
        vi.spyOn(globalState, 'update').mockImplementation(async (key: string, value: unknown) => {
            if (key === catalogKey && value !== undefined) {
                writeStarted();
                await writeGate;
            }
            await update(key, value);
        });

        vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
            JSON.stringify({ data: [{ id: 'mutable-model' }] }),
            { status: 200, headers: { 'content-type': 'application/json' } },
        ));
        const pendingRefresh = service.refreshModels();
        await started;

        // Flip the declaration and reload while the stale catalog write is still in flight.
        vscodeState.profiles = {
            local: {
                baseUrl: 'https://example.test/v1', auth: 'none',
                models: [{ id: 'mutable-model', reasoning: true }],
            },
        };
        const reload = service.reload();
        let reloadSettled = false;
        void reload.then(() => { reloadSettled = true; }, () => { reloadSettled = true; });
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(reloadSettled).toBe(false);

        releaseWrite();
        await reload;
        await pendingRefresh;

        // The stale catalog must be deleted after its write completes, not left under the freshly
        // written fingerprint.
        expect(globalState.values.get(catalogKey)).toBeUndefined();
        const restarted = new LlmProviderService();
        await restarted.initialize(restartContext());
        expect(restarted.getModel('local', 'mutable-model').reasoning).toBe(true);
    });

    it('serializes overlapping reloads so a slower earlier reload cannot publish last', async () => {
        const globalState = new MemoryMemento();
        const restartContext = () => ({ secrets: new MemorySecrets(), globalState }) as any;
        vscodeState.profiles = {
            local: { baseUrl: 'https://example.test/v1', auth: 'none', models: [{ id: 'm', reasoning: false }] },
        };
        const service = new LlmProviderService();
        await service.initialize(restartContext());

        // Seed a catalog tagged for another declaration so the first reload purges it, and stall
        // that purge so a second reload overlaps the first.
        const catalogKey = 'mutsumi.llmModels.v1.local';
        globalState.values.set(catalogKey, { models: [], mutsumiProfileFingerprint: 'stale' });
        const update = globalState.update.bind(globalState);
        let gateFirstPurge = true;
        let releaseFirst!: () => void;
        const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
        vi.spyOn(globalState, 'update').mockImplementation(async (key: string, value: unknown) => {
            if (key === catalogKey && gateFirstPurge) {
                gateFirstPurge = false;
                await firstGate;
            }
            await update(key, value);
        });

        vscodeState.configReads = 0;
        vscodeState.profiles = {
            local: { baseUrl: 'https://example.test/v1', auth: 'none', models: [{ id: 'm', reasoning: true }] },
        };
        const first = service.reload();
        vscodeState.profiles = {
            local: { baseUrl: 'https://example.test/v1', auth: 'none', models: [{ id: 'm', reasoning: false }] },
        };
        const second = service.reload();
        await new Promise(resolve => setTimeout(resolve, 0));

        // The second reload must not have started while the first is still running.
        expect(vscodeState.configReads).toBe(1);
        releaseFirst();
        await Promise.all([first, second]);
        expect(service.getModel('local', 'm').reasoning).toBe(false);
    });

    it('keeps the previous snapshot refreshable when a reload fails after aborting it', async () => {
        const globalState = new MemoryMemento();
        const restartContext = () => ({ secrets: new MemorySecrets(), globalState }) as any;
        vscodeState.profiles = {
            local: { baseUrl: 'https://example.test/v1', auth: 'none', models: ['declared-model'] },
        };
        const service = new LlmProviderService();
        await service.initialize(restartContext());

        // Seed a catalog tagged for another declaration so the reload purges it, and make that
        // purge fail — a storage error after the outgoing snapshot was aborted.
        const catalogKey = 'mutsumi.llmModels.v1.local';
        globalState.values.set(catalogKey, { models: [], mutsumiProfileFingerprint: 'stale' });
        const update = globalState.update.bind(globalState);
        const updateSpy = vi.spyOn(globalState, 'update').mockImplementation(async (key: string, value: unknown) => {
            if (key === catalogKey) throw new Error('disk full');
            await update(key, value);
        });
        vscodeState.profiles = {
            local: { baseUrl: 'https://example.test/v1', auth: 'none', models: ['declared-model', 'second-model'] },
        };
        await expect(service.reload()).rejects.toThrow('disk full');
        updateSpy.mockRestore();

        // The retained snapshot must still refresh instead of silently returning an empty result.
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
            JSON.stringify({ data: [{ id: 'declared-model' }, { id: 'server-only-model' }] }),
            { status: 200, headers: { 'content-type': 'application/json' } },
        ));
        const errors = await service.refreshModels();
        expect(errors.size).toBe(0);
        expect(service.getModel('local', 'server-only-model').id).toBe('server-only-model');
    });

    it('never pairs a stale catalog with a new declaration after a partially persisted reload', async () => {
        const globalState = new MemoryMemento();
        const restartContext = () => ({ secrets: new MemorySecrets(), globalState }) as any;
        vscodeState.profiles = {
            alpha: { baseUrl: 'https://a.test/v1', auth: 'none', models: [{ id: 'alpha-model', reasoning: false }] },
            beta: { baseUrl: 'https://b.test/v1', auth: 'none', models: ['beta-model'] },
        };
        const service = new LlmProviderService();
        await service.initialize(restartContext());

        // Cache catalogs for both providers under the current declarations.
        vi.spyOn(globalThis, 'fetch').mockImplementation(async url => new Response(
            JSON.stringify({ data: [{ id: String(url).includes('a.test') ? 'alpha-model' : 'beta-model' }] }),
            { status: 200, headers: { 'content-type': 'application/json' } },
        ));
        await service.refreshModels();
        expect(service.getModel('alpha', 'alpha-model').reasoning).toBe(false);
        const alphaKey = 'mutsumi.llmModels.v1.alpha';
        const cachedUnderOldDeclaration = (globalState.values.get(alphaKey) as any)?.mutsumiProfileFingerprint;
        expect(cachedUnderOldDeclaration).toBeDefined();

        // Change alpha's declaration and let beta's cache purge fail, so the reload stops after
        // alpha's cache was already dropped.
        vscodeState.profiles = {
            alpha: { baseUrl: 'https://a.test/v1', auth: 'none', models: [{ id: 'alpha-model', reasoning: true }] },
            beta: { baseUrl: 'https://b.test/v1', auth: 'none', models: ['beta-model'] },
        };
        const betaKey = 'mutsumi.llmModels.v1.beta';
        globalState.values.set(betaKey, { models: [], mutsumiProfileFingerprint: 'stale' });
        const update = globalState.update.bind(globalState);
        const updateSpy = vi.spyOn(globalState, 'update').mockImplementation(async (key: string, value: unknown) => {
            if (key === betaKey) throw new Error('disk full');
            await update(key, value);
        });
        await expect(service.reload()).rejects.toThrow('disk full');
        updateSpy.mockRestore();

        // The retained (old) snapshot refreshes and writes alpha's old catalog back to disk,
        // still tagged with the declaration that produced it.
        await service.refreshModels();
        expect((globalState.values.get(alphaKey) as any)?.mutsumiProfileFingerprint).toBe(cachedUnderOldDeclaration);

        // A restart under the new declaration must ignore that old catalog.
        const restarted = new LlmProviderService();
        await restarted.initialize(restartContext());
        expect(restarted.getModel('alpha', 'alpha-model').reasoning).toBe(true);
    });

    it('uses built-in ambient environment credentials as a SecretStorage fallback', async () => {
        const previous = process.env.OPENAI_API_KEY;
        process.env.OPENAI_API_KEY = 'environment-secret';
        try {
            const service = new LlmProviderService();
            await service.initialize(context());
            const openai = (await service.listProviders()).find(provider => provider.id === 'openai');
            expect(openai).toMatchObject({ configured: true });
            expect(JSON.stringify(openai)).not.toContain('environment-secret');
        } finally {
            if (previous === undefined) delete process.env.OPENAI_API_KEY;
            else process.env.OPENAI_API_KEY = previous;
        }
    });
});

describe('custom /models discovery', () => {
    it('uses Bearer auth and validates a successful OpenAI-shaped listing', async () => {
        const service = new LlmProviderService();
        const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
            data: [{ id: 'remote-model', display_name: 'Remote', context_window: 8192, max_output_tokens: 2048 }],
        }), { status: 200, headers: { 'content-type': 'application/json' } }));

        const models = await (service as any).discoverCustomModels(
            'custom', { baseUrl: 'https://example.test/v1', api: 'openai-completions' },
            { credential: { type: 'api_key', key: 'secret' } },
        );

        expect(fetchMock).toHaveBeenCalledWith('https://example.test/v1/models', expect.objectContaining({
            headers: expect.objectContaining({ authorization: 'Bearer secret' }),
        }));
        expect(models[0]).toMatchObject({ id: 'remote-model', name: 'Remote', contextWindow: 8192, maxTokens: 2048 });
    });

    it.each([
        ['invalid JSON', new Response('{', { status: 200 }), 'did not return JSON'],
        ['authentication failure', new Response('', { status: 401 }), 'check the API key'],
        ['oversized response', new Response('', { status: 200, headers: { 'content-length': String(4 * 1024 * 1024 + 1) } }), 'returned more than'],
    ])('rejects %s without accepting a bad catalog', async (_name, response, expected) => {
        const service = new LlmProviderService();
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(response);
        await expect((service as any).discoverCustomModels(
            'custom', { baseUrl: 'https://example.test/v1' }, { credential: undefined },
        )).rejects.toThrow(expected);
    });

    it('honors caller cancellation', async () => {
        const service = new LlmProviderService();
        vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => new Promise((_resolve, reject) => {
            (init?.signal as AbortSignal).addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
        }));
        const controller = new AbortController();
        const pending = (service as any).discoverCustomModels(
            'custom', { baseUrl: 'https://example.test/v1' }, { signal: controller.signal },
        );
        controller.abort();
        await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    });

    it('times out a stalled discovery request', async () => {
        vi.useFakeTimers();
        const service = new LlmProviderService();
        vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => new Promise((_resolve, reject) => {
            (init?.signal as AbortSignal).addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
        }));
        const pending = expect((service as any).discoverCustomModels(
            'custom', { baseUrl: 'https://example.test/v1' }, { credential: undefined },
        )).rejects.toMatchObject({ name: 'AbortError' });
        await vi.advanceTimersByTimeAsync(15_000);
        await pending;
    });

    it('retains the previous manual catalog when a refresh fails', async () => {
        vscodeState.profiles = {
            local: { baseUrl: 'https://example.test/v1', auth: 'none', models: ['fallback-model'] },
        };
        const service = new LlmProviderService();
        await service.initialize(context());
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 503 }));
        const errors = await service.refreshModels();
        expect(errors.get('local')).toBeInstanceOf(Error);
        expect(service.getModel('local', 'fallback-model').id).toBe('fallback-model');
    });
});
