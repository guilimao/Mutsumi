/**
 * Wire-level tests: the request path runs the real production chain
 * (LlmProviderService registry -> LLMClient -> pi-ai SDK -> OpenAI client -> fetch)
 * against a loopback HTTP server, so assertions target the final HTTP payload
 * rather than the SDK's neutral input structures.
 */

import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';

const vscodeState = vi.hoisted(() => ({ profiles: {} as Record<string, unknown> }));
vi.mock('vscode', () => ({
    workspace: {
        getConfiguration: () => ({ get: (_key: string, fallback: unknown) => vscodeState.profiles ?? fallback }),
    },
}));

import { LlmProviderService } from '../src/llm/providerService';
import { LLMClient } from '../src/agent/llmClient';

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

const PROVIDER_ID = 'wire-loop';

interface CapturedRequest {
    method: string;
    url: string;
    headers: Record<string, string | string[] | undefined>;
    body: any;
}

/** Minimal OpenAI chat.completions.chunk SSE stream, terminated with [DONE]. */
function sseResponse(chunks: object[]): string {
    return chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n';
}

function textChunk(delta: Record<string, unknown>, finishReason: string | null = null, usage?: object) {
    return {
        id: 'chatcmpl-wire', object: 'chat.completion.chunk', created: 1, model: 'wire-model',
        choices: [{ index: 0, delta, finish_reason: finishReason }],
        ...(usage ? { usage } : {}),
    };
}

async function startLoopback(responseBodyFor: (path: string) => string) {
    const requests: CapturedRequest[] = [];
    const server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8');
            let body: unknown;
            try { body = JSON.parse(raw); } catch { body = raw; }
            requests.push({
                method: req.method ?? '',
                url: req.url ?? '',
                headers: req.headers,
                body,
            });
            const body_ = responseBodyFor(req.url ?? '');
            res.writeHead(200, {
                'content-type': 'text/event-stream',
                'cache-control': 'no-cache',
            });
            res.end(body_);
        });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    return { server, requests, baseUrl: `http://127.0.0.1:${port}/v1` };
}

function seedRegistry(baseUrl: string, models: unknown[] = ['wire-model']) {
    vscodeState.profiles = {
        [PROVIDER_ID]: { baseUrl, auth: 'apiKey', models },
    };
    return seedSecretContext();
}

function seedSecretContext() {
    const secrets = new MemorySecrets();
    secrets.values.set(
        `mutsumi.llmCredential.${PROVIDER_ID}`,
        JSON.stringify({ type: 'api_key', key: 'wire-secret' }),
    );
    return { secrets: secrets as any, globalState: new MemoryMemento() as any } as any;
}

function lastRequest(loopback: { requests: CapturedRequest[] }): CapturedRequest {
    const request = loopback.requests.at(-1);
    if (!request) throw new Error('expected at least one captured request');
    return request;
}

async function streamOnce(client: LLMClient, options: Parameters<LLMClient['streamChatCompletion']>[0]) {
    const events = [];
    for await (const event of client.streamChatCompletion(options)) events.push(event);
    return events;
}

let activeServer: http.Server | undefined;

afterEach(async () => {
    vscodeState.profiles = {};
    await new Promise<void>(resolve => activeServer ? activeServer.close(() => resolve()) : resolve());
    activeServer = undefined;
});

describe('LLM wire payload (real SDK conversion over loopback HTTP)', () => {
    it('omits the reasoning_effort key entirely when no override is set', async () => {
        const loopback = await startLoopback(() => sseResponse([
            textChunk({ role: 'assistant', content: 'Hello' }),
            textChunk({}, 'stop', { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 }),
        ]));
        activeServer = loopback.server;
        await LlmProviderService.getInstance().initialize(seedRegistry(loopback.baseUrl));

        const client = new LLMClient({ provider: PROVIDER_ID, model: 'wire-model' });
        const events = await streamOnce(client, {
            systemPrompt: 'rules',
            messages: [{ role: 'user', content: 'hi', timestamp: 1 }],
        });

        const request = lastRequest(loopback);
        expect(request.method).toBe('POST');
        expect(request.url).toBe('/v1/chat/completions');
        // Frozen D8 wire contract: the key must be completely absent, not null or undefined.
        expect('reasoning_effort' in request.body).toBe(false);
        expect(request.body.model).toBe('wire-model');
        expect(request.body.stream).toBe(true);
        expect(request.body.store).toBe(false);
        expect(request.body.stream_options).toEqual({ include_usage: true });
        expect(request.body.messages[0]).toMatchObject({ role: 'system', content: 'rules' });
        expect(request.body.messages[1]).toMatchObject({ role: 'user', content: 'hi' });
        expect(events.at(-1)).toMatchObject({
            type: 'done',
            message: { stopReason: 'stop', usage: { input: 5, output: 2, totalTokens: 7 } },
        });
    });

    it('sends reasoning_effort for optimistic-default custom models when an effort is set', async () => {
        const loopback = await startLoopback(() => sseResponse([
            textChunk({ role: 'assistant', content: 'ok' }),
            textChunk({}, 'stop'),
        ]));
        activeServer = loopback.server;
        await LlmProviderService.getInstance().initialize(seedRegistry(loopback.baseUrl));

        // Undeclared capabilities are optimistic (C1): reasoning reaches the wire instead of
        // being silently clamped away by the SDK.
        const client = new LLMClient({ provider: PROVIDER_ID, model: 'wire-model', reasoningEffort: 'high' });
        await streamOnce(client, {
            messages: [{ role: 'user', content: 'hi', timestamp: 1 }],
        });

        const request = lastRequest(loopback);
        expect(request.body.reasoning_effort).toBe('high');
        expect(request.body.enable_thinking).toBeUndefined();
        expect(request.body.thinking).toBeUndefined();
    });

    it('omits reasoning_effort when compat passthrough disables it', async () => {
        const loopback = await startLoopback(() => sseResponse([
            textChunk({ role: 'assistant', content: 'ok' }),
            textChunk({}, 'stop'),
        ]));
        activeServer = loopback.server;
        vscodeState.profiles = {
            [PROVIDER_ID]: {
                baseUrl: loopback.baseUrl, auth: 'apiKey',
                models: [{ id: 'wire-model', compat: { supportsReasoningEffort: false } }],
            },
        };
        await LlmProviderService.getInstance().initialize(seedSecretContext());

        const client = new LLMClient({ provider: PROVIDER_ID, model: 'wire-model', reasoningEffort: 'high' });
        await streamOnce(client, {
            messages: [{ role: 'user', content: 'hi', timestamp: 1 }],
        });

        expect('reasoning_effort' in lastRequest(loopback).body).toBe(false);
    });

    it('raises a visible local error instead of silently clamping when the model declares no reasoning', async () => {
        const loopback = await startLoopback(() => sseResponse([
            textChunk({ role: 'assistant', content: 'ok' }),
            textChunk({}, 'stop'),
        ]));
        activeServer = loopback.server;
        vscodeState.profiles = {
            [PROVIDER_ID]: {
                baseUrl: loopback.baseUrl, auth: 'apiKey',
                models: [{ id: 'wire-model', reasoning: false }],
            },
        };
        await LlmProviderService.getInstance().initialize(seedSecretContext());

        const client = new LLMClient({ provider: PROVIDER_ID, model: 'wire-model', reasoningEffort: 'high' });
        await expect(streamOnce(client, {
            messages: [{ role: 'user', content: 'hi', timestamp: 1 }],
        })).rejects.toThrow('declares no reasoning');
        expect(loopback.requests).toHaveLength(0);
    });

    it('calls keyless providers through the placeholder auth gate', async () => {
        const loopback = await startLoopback(() => sseResponse([
            textChunk({ role: 'assistant', content: 'ok' }),
            textChunk({}, 'stop'),
        ]));
        activeServer = loopback.server;
        vscodeState.profiles = {
            [PROVIDER_ID]: { baseUrl: loopback.baseUrl, auth: 'none', models: ['wire-model'] },
        };
        await LlmProviderService.getInstance().initialize({ secrets: new MemorySecrets(), globalState: new MemoryMemento() } as any);

        const client = new LLMClient({ provider: PROVIDER_ID, model: 'wire-model' });
        await streamOnce(client, {
            messages: [{ role: 'user', content: 'hi', timestamp: 1 }],
        });

        const request = lastRequest(loopback);
        // pi-ai requires an apiKey before building its OpenAI client; keyless routes satisfy
        // the gate with a placeholder instead of failing at request time.
        expect(request.headers.authorization).toBe('Bearer unused');
    });

    it('serializes function tools and streams tool-call events back', async () => {
        const loopback = await startLoopback(() => sseResponse([
            textChunk({ role: 'assistant', content: null, tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name: 'read', arguments: '' } }] }),
            textChunk({ tool_calls: [{ index: 0, function: { arguments: '{"path":"file.ts"}' } }] }),
            textChunk({}, 'tool_calls', { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13 }),
        ]));
        activeServer = loopback.server;
        await LlmProviderService.getInstance().initialize(seedRegistry(loopback.baseUrl));

        const client = new LLMClient({ provider: PROVIDER_ID, model: 'wire-model' });
        const events = await streamOnce(client, {
            systemPrompt: 'rules',
            messages: [{ role: 'user', content: 'read it', timestamp: 1 }],
            tools: [{ type: 'function', function: { name: 'read', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }],
        });

        const request = lastRequest(loopback);
        // detectCompat defaults supportsStrictMode to true for unknown URLs, so the SDK
        // emits an explicit strict:false on every function tool.
        expect(request.body.tools).toEqual([
            { type: 'function', function: { name: 'read', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } }, strict: false } },
        ]);
        expect(events.some(event => event.type === 'toolcall_end')).toBe(true);
        expect(events.at(-1)).toMatchObject({
            type: 'done',
            message: {
                stopReason: 'toolUse',
                content: [{ type: 'toolCall', id: 'call-1', name: 'read', arguments: { path: 'file.ts' } }],
            },
        });
    });

    it('converts image content blocks into image_url data URLs for optimistic-default models', async () => {
        const loopback = await startLoopback(() => sseResponse([
            textChunk({ role: 'assistant', content: 'seen' }),
            textChunk({}, 'stop'),
        ]));
        activeServer = loopback.server;
        await LlmProviderService.getInstance().initialize(seedRegistry(loopback.baseUrl));

        const client = new LLMClient({ provider: PROVIDER_ID, model: 'wire-model' });
        await streamOnce(client, {
            messages: [{
                role: 'user',
                content: [
                    { type: 'text', text: 'look' },
                    { type: 'image', mimeType: 'image/png', data: 'aGk=' },
                ],
                timestamp: 1,
            }],
        });

        // Undeclared input defaults to ['text','image'] (C1): the image survives the SDK's
        // transform instead of being replaced by an omission placeholder.
        const wireContent = lastRequest(loopback).body.messages[0].content;
        expect(wireContent).toEqual([
            { type: 'text', text: 'look' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,aGk=' } },
        ]);
    });

    it('omits images on the wire when the model declares text-only input', async () => {
        const loopback = await startLoopback(() => sseResponse([
            textChunk({ role: 'assistant', content: 'seen' }),
            textChunk({}, 'stop'),
        ]));
        activeServer = loopback.server;
        await LlmProviderService.getInstance().initialize(
            seedRegistry(loopback.baseUrl, [{ id: 'wire-model', input: ['text'] }]),
        );

        const client = new LLMClient({ provider: PROVIDER_ID, model: 'wire-model' });
        await streamOnce(client, {
            messages: [{
                role: 'user',
                content: [
                    { type: 'text', text: 'look' },
                    { type: 'image', mimeType: 'image/png', data: 'aGk=' },
                ],
                timestamp: 1,
            }],
        });

        // Declared text-only input restores the pre-optimistic behavior: the SDK downgrades the
        // image to its omission placeholder instead of sending an image part.
        const wireContent = lastRequest(loopback).body.messages[0].content;
        expect(wireContent).toEqual([
            { type: 'text', text: 'look' },
            { type: 'text', text: '(image omitted: model does not support images)' },
        ]);
    });

    it('sends bearer auth from SecretStorage and uses max_completion_tokens', async () => {
        const loopback = await startLoopback(() => sseResponse([
            textChunk({ role: 'assistant', content: 'done' }),
            textChunk({}, 'stop'),
        ]));
        activeServer = loopback.server;
        await LlmProviderService.getInstance().initialize(seedRegistry(loopback.baseUrl));

        const client = new LLMClient({ provider: PROVIDER_ID, model: 'wire-model' });
        await streamOnce(client, {
            messages: [{ role: 'user', content: 'hi', timestamp: 1 }],
            maxTokens: 1234,
        });

        const request = lastRequest(loopback);
        expect(request.headers.authorization).toBe('Bearer wire-secret');
        expect(request.body.max_completion_tokens).toBe(1234);
        expect('max_tokens' in request.body).toBe(false);
    });
});
