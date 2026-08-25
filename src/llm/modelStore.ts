import type * as vscode from 'vscode';
import type { ModelsStore, ModelsStoreEntry } from '@earendil-works/pi-ai';

const CACHE_PREFIX = 'mutsumi.llmModels.v1.';

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

    private key(providerId: string): string {
        return `${CACHE_PREFIX}${encodeURIComponent(providerId)}`;
    }
}
