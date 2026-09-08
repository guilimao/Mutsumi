import type * as vscode from 'vscode';
import type { ModelsStore, ModelsStoreEntry } from '@earendil-works/pi-ai';

const CACHE_PREFIX = 'mutsumi.llmModels.v1.';
const PROFILE_FINGERPRINT_PREFIX = 'mutsumi.llmModelProfileFp.v1.';

/** Non-secret persistent cache for dynamically discovered model catalogs. */
export class VsCodeModelsStore implements ModelsStore {
    constructor(private readonly globalState: vscode.Memento) {}

    read(providerId: string): Promise<ModelsStoreEntry | undefined> {
        const value = this.globalState.get<ModelsStoreEntry>(this.key(providerId));
        return Promise.resolve(value);
    }

    async write(providerId: string, entry: ModelsStoreEntry): Promise<void> {
        await this.globalState.update(this.key(providerId), entry);
    }

    async delete(providerId: string): Promise<void> {
        await this.globalState.update(this.key(providerId), undefined);
    }

    /**
     * Fingerprint of the declared profile that produced the cached catalog. Persisted next to
     * the cache so a profile edit invalidates it even after an extension restart, where the
     * in-memory snapshot is gone.
     */
    readProfileFingerprint(providerId: string): Promise<string | undefined> {
        const value = this.globalState.get<string>(this.fingerprintKey(providerId));
        return Promise.resolve(value);
    }

    async writeProfileFingerprint(providerId: string, fingerprint: string): Promise<void> {
        await this.globalState.update(this.fingerprintKey(providerId), fingerprint);
    }

    private key(providerId: string): string {
        return `${CACHE_PREFIX}${encodeURIComponent(providerId)}`;
    }

    private fingerprintKey(providerId: string): string {
        return `${PROFILE_FINGERPRINT_PREFIX}${encodeURIComponent(providerId)}`;
    }
}
