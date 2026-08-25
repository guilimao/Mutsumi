import type * as vscode from 'vscode';
import type { Credential, CredentialInfo, CredentialStore } from '@earendil-works/pi-ai';

const SECRET_PREFIX = 'mutsumi.llmCredential.';
const INDEX_KEY = 'mutsumi.llmCredentialProviders.v1';

/** pi-ai credential store backed by VS Code's encrypted SecretStorage. */
export class VsCodeCredentialStore implements CredentialStore {
    private readonly queues = new Map<string, Promise<unknown>>();

    constructor(
        private readonly secrets: vscode.SecretStorage,
        private readonly globalState: vscode.Memento,
    ) {}

    async read(providerId: string): Promise<Credential | undefined> {
        const raw = await this.secrets.get(this.key(providerId));
        if (!raw) return undefined;
        try {
            const value: unknown = JSON.parse(raw);
            if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
            const type = (value as { type?: unknown }).type;
            return type === 'api_key' || type === 'oauth' ? value as Credential : undefined;
        } catch {
            return undefined;
        }
    }

    async list(): Promise<readonly CredentialInfo[]> {
        const ids = this.globalState.get<string[]>(INDEX_KEY, []);
        const result: CredentialInfo[] = [];
        for (const providerId of ids) {
            const credential = await this.read(providerId);
            if (credential) result.push({ providerId, type: credential.type });
        }
        return result;
    }

    modify(
        providerId: string,
        fn: (current: Credential | undefined) => Promise<Credential | undefined>,
    ): Promise<Credential | undefined> {
        return this.serialized(providerId, async () => {
            const next = await fn(await this.read(providerId));
            if (next === undefined) return this.read(providerId);
            await this.secrets.store(this.key(providerId), JSON.stringify(next));
            await this.addToIndex(providerId);
            return next;
        });
    }

    delete(providerId: string): Promise<void> {
        return this.serialized(providerId, async () => {
            await this.secrets.delete(this.key(providerId));
            const ids = this.globalState.get<string[]>(INDEX_KEY, []);
            await this.globalState.update(INDEX_KEY, ids.filter(id => id !== providerId));
        });
    }

    /** Store an API key without ever projecting it into ordinary settings. */
    async storeApiKey(providerId: string, key: string): Promise<void> {
        await this.modify(providerId, async current => ({
            type: 'api_key',
            ...current?.type === 'api_key' && current.env ? { env: current.env } : {},
            key,
        }));
    }

    private key(providerId: string): string {
        return `${SECRET_PREFIX}${encodeURIComponent(providerId)}`;
    }

    private async addToIndex(providerId: string): Promise<void> {
        const ids = this.globalState.get<string[]>(INDEX_KEY, []);
        if (!ids.includes(providerId)) await this.globalState.update(INDEX_KEY, [...ids, providerId]);
    }

    private serialized<T>(providerId: string, operation: () => Promise<T>): Promise<T> {
        const previous = this.queues.get(providerId) ?? Promise.resolve();
        const next = previous.catch(() => undefined).then(operation);
        const tracked = next.finally(() => {
            if (this.queues.get(providerId) === tracked) this.queues.delete(providerId);
        });
        this.queues.set(providerId, tracked);
        return next;
    }
}
