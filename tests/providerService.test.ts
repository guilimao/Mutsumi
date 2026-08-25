import { afterEach, describe, expect, it, vi } from 'vitest';

const vscodeState = vi.hoisted(() => ({ profiles: {} as Record<string, unknown> }));
vi.mock('vscode', () => ({
    workspace: {
        getConfiguration: () => ({ get: (_key: string, fallback: unknown) => vscodeState.profiles ?? fallback }),
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

    it('normalizes custom routes and applies conservative manual model defaults', async () => {
        vscodeState.profiles = {
            local: {
                displayName: ' Local ', baseUrl: 'http://localhost:8080/v1/',
                auth: 'none', models: [' test-model ', 'test-model'],
            },
        };
        const service = new LlmProviderService();
        await service.initialize(context());
        const model = service.getModel('local', 'test-model');
        expect(model).toMatchObject({ contextWindow: 262144, maxTokens: 32768, input: ['text'] });
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
