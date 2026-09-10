import type * as vscode from 'vscode';
import type { ModelsStore, ModelsStoreEntry } from '@earendil-works/pi-ai';

const CACHE_PREFIX = 'mutsumi.llmModels.v1.';

/**
 * A cached catalog plus the fingerprint of the declaration that produced it.
 * @description The fingerprint travels inside the same stored value as the models, so a catalog
 * can never be paired with a declaration it did not come from: either a write persists both or
 * neither. This replaces a separately stored fingerprint key, whose partial update could attribute
 * a stale catalog to the new declaration.
 */
interface StoredCatalog extends ModelsStoreEntry {
    mutsumiProfileFingerprint?: string;
}

/** Non-secret persistent cache for dynamically discovered model catalogs. */
export class VsCodeModelsStore implements ModelsStore {
    /**
     * @param fingerprints Fingerprint of the declared profile a provider's catalog must carry to be
     * visible. Reads of a catalog tagged for a different declaration miss, and
     * {@link purgeMismatched} drops them. Providers absent from the map (built-ins) are always
     * visible and un-tagged.
     * @param inFlightMutations Shared by every store view a snapshot creates, so {@link drain}
     * waits for mutations started through any of them rather than only the current one.
     */
    constructor(
        private readonly globalState: vscode.Memento,
        private readonly fingerprints: ReadonlyMap<string, string> = new Map(),
        private readonly inFlightMutations: Set<Promise<unknown>> = new Set(),
    ) {}

    read(providerId: string): Promise<ModelsStoreEntry | undefined> {
        const entry = this.globalState.get<StoredCatalog>(this.key(providerId));
        if (!entry) return Promise.resolve(undefined);
        const expected = this.fingerprints.get(providerId);
        if (expected !== undefined && entry.mutsumiProfileFingerprint !== expected) {
            // Produced by a different declaration: not a cache hit.
            return Promise.resolve(undefined);
        }
        return Promise.resolve(entry);
    }

    write(providerId: string, entry: ModelsStoreEntry): Promise<void> {
        const expected = this.fingerprints.get(providerId);
        const stored: StoredCatalog = expected === undefined
            ? entry
            : { ...entry, mutsumiProfileFingerprint: expected };
        return this.track(this.globalState.update(this.key(providerId), stored));
    }

    delete(providerId: string): Promise<void> {
        return this.track(this.globalState.update(this.key(providerId), undefined));
    }

    /**
     * Deletes cached catalogs that are tagged for a declaration other than this store's.
     * @remarks Purely storage hygiene: a mismatching catalog is already invisible to {@link read},
     * so a failure here cannot corrupt what is served and may safely abort the reload that asked
     * for it.
     */
    async purgeMismatched(providerIds: Iterable<string>): Promise<void> {
        for (const providerId of providerIds) {
            const entry = this.globalState.get<StoredCatalog>(this.key(providerId));
            const expected = this.fingerprints.get(providerId);
            if (entry && expected !== undefined && entry.mutsumiProfileFingerprint !== expected) {
                await this.delete(providerId);
            }
        }
    }

    /** Resolves once every catalog mutation started so far has settled, including later ones. */
    async drain(): Promise<void> {
        while (this.inFlightMutations.size > 0) {
            await Promise.allSettled([...this.inFlightMutations]);
        }
    }

    private key(providerId: string): string {
        return `${CACHE_PREFIX}${encodeURIComponent(providerId)}`;
    }

    private track(mutation: Thenable<void>): Promise<void> {
        const tracked = Promise.resolve(mutation);
        this.inFlightMutations.add(tracked);
        const settled = () => { this.inFlightMutations.delete(tracked); };
        void tracked.then(settled, settled);
        return tracked;
    }
}
