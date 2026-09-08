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

function seedRegistry(baseUrl: string) {
    vscodeState.profiles = {
        [PROVIDER_ID]: { baseUrl, auth: 'apiKey', models: ['wire-model'] },
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
});
