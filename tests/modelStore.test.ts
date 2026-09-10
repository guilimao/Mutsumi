/**
 * The catalog store pairs every cached catalog with the fingerprint of the declaration that
 * produced it, inside the same value, so a catalog can never be attributed to a declaration it
 * did not come from. These tests pin that pairing at the storage layer.
 */

import { describe, expect, it } from 'vitest';
import { VsCodeModelsStore } from '../src/llm/modelStore';

class MemoryMemento {
    readonly values = new Map<string, unknown>();
    get<T>(key: string, fallback?: T): T { return (this.values.has(key) ? this.values.get(key) : fallback) as T; }
    async update(key: string, value: unknown) { this.values.set(key, value); }
}

const CACHE_KEY = 'mutsumi.llmModels.v1.local';

function store(memento: MemoryMemento, fingerprint?: string): VsCodeModelsStore {
    return new VsCodeModelsStore(
        memento as any,
        fingerprint === undefined ? new Map() : new Map([['local', fingerprint]]),
    );
}

describe('VsCodeModelsStore fingerprint pairing', () => {
    it('stamps a written catalog with the expected fingerprint and only serves it for that fingerprint', async () => {
        const memento = new MemoryMemento();
        await store(memento, 'fp-1').write('local', { models: [{ id: 'm' }] } as any);

        expect((memento.values.get(CACHE_KEY) as any).mutsumiProfileFingerprint).toBe('fp-1');
        await expect(store(memento, 'fp-1').read('local')).resolves.toMatchObject({ models: [{ id: 'm' }] });
        // A catalog from another declaration is invisible even if its write landed last.
        await expect(store(memento, 'fp-2').read('local')).resolves.toBeUndefined();
    });

    it('ignores and purges a catalog stored before fingerprints existed', async () => {
        const memento = new MemoryMemento();
        memento.values.set(CACHE_KEY, { models: [{ id: 'legacy' }] });
        const local = store(memento, 'fp-1');

        await expect(local.read('local')).resolves.toBeUndefined();
        await local.purgeMismatched(['local']);
        expect(memento.values.get(CACHE_KEY)).toBeUndefined();
    });

    it('leaves built-in providers (no expected fingerprint) untagged and visible', async () => {
        const memento = new MemoryMemento();
        const local = store(memento, 'fp-1');

        await local.write('openai', { models: [{ id: 'gpt' }] } as any);
        expect((memento.values.get('mutsumi.llmModels.v1.openai') as any).mutsumiProfileFingerprint).toBeUndefined();
        await expect(local.read('openai')).resolves.toMatchObject({ models: [{ id: 'gpt' }] });
    });

    it('keeps a matching catalog when purging', async () => {
        const memento = new MemoryMemento();
        const local = store(memento, 'fp-1');
        await local.write('local', { models: [{ id: 'current' }] } as any);

        await local.purgeMismatched(['local']);
        await expect(local.read('local')).resolves.toMatchObject({ models: [{ id: 'current' }] });
    });
});
