import { describe, expect, it } from 'vitest';
import { VsCodeCredentialStore } from '../src/llm/credentialStore';

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

describe('VsCodeCredentialStore', () => {
    it('stores full credentials only in SecretStorage and lists metadata without secrets', async () => {
        const secrets = new MemorySecrets();
        const state = new MemoryMemento();
        const store = new VsCodeCredentialStore(secrets as any, state as any);

        await store.storeApiKey('anthropic', 'secret-value');

        expect(await store.read('anthropic')).toEqual({ type: 'api_key', key: 'secret-value' });
        expect(await store.list()).toEqual([{ providerId: 'anthropic', type: 'api_key' }]);
        expect(JSON.stringify([...state.values])).not.toContain('secret-value');
        expect([...secrets.values.values()][0]).toContain('secret-value');
    });

    it('serializes concurrent writes for the same provider and deletes the index entry', async () => {
        const secrets = new MemorySecrets();
        const state = new MemoryMemento();
        const store = new VsCodeCredentialStore(secrets as any, state as any);
        await store.storeApiKey('openai', 'first');

        await Promise.all([
            store.modify('openai', async current => ({ ...current!, key: `${(current as any).key}-second` })),
            store.modify('openai', async current => ({ ...current!, key: `${(current as any).key}-third` })),
        ]);

        expect((await store.read('openai') as any).key).toBe('first-second-third');
        await store.delete('openai');
        expect(await store.read('openai')).toBeUndefined();
        expect(await store.list()).toEqual([]);
    });
});
