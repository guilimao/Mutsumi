import * as vscode from 'vscode';
import { t } from '../i18n';
import { LlmProviderService } from './providerService';
import type { CustomProviderProfile } from './types';

interface LegacyProvider {
    name: string;
    baseurl: string;
    api_key?: string;
}

interface Layer {
    target: vscode.ConfigurationTarget;
    resource?: vscode.Uri;
    providers: LegacyProvider[];
    models: Record<string, string[]>;
    customProviders: Record<string, CustomProviderProfile>;
}

const PROMPTED_KEY = 'mutsumi.legacyCredentialMigration.prompted.v1';
const DEFAULT_KIMI_URL = 'https://api.kimi.com/coding/v1';

function inspectLayers(resource?: vscode.Uri, includeShared = true): Layer[] {
    const config = vscode.workspace.getConfiguration('mutsumi', resource);
    const providers = config.inspect<LegacyProvider[]>('providers');
    const models = config.inspect<Record<string, string[]>>('models');
    const custom = config.inspect<Record<string, CustomProviderProfile>>('customProviders');
    const layers: Layer[] = [];
    const add = (
        target: vscode.ConfigurationTarget,
        providerValue: LegacyProvider[] | undefined,
        modelValue: Record<string, string[]> | undefined,
        customValue: Record<string, CustomProviderProfile> | undefined,
    ) => {
        if (Array.isArray(providerValue) && providerValue.length > 0) {
            layers.push({ target, resource, providers: providerValue, models: modelValue ?? {}, customProviders: customValue ?? {} });
        }
    };
    if (includeShared) {
        add(vscode.ConfigurationTarget.Global, providers?.globalValue, models?.globalValue, custom?.globalValue);
        add(vscode.ConfigurationTarget.Workspace, providers?.workspaceValue, models?.workspaceValue, custom?.workspaceValue);
    }
    add(vscode.ConfigurationTarget.WorkspaceFolder, providers?.workspaceFolderValue, models?.workspaceFolderValue, custom?.workspaceFolderValue);
    return layers;
}

function allLayers(): Layer[] {
    const layers = inspectLayers(undefined, true).filter(layer => layer.target !== vscode.ConfigurationTarget.WorkspaceFolder);
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
        layers.push(...inspectLayers(folder.uri, false));
    }
    return layers;
}

function secretConflicts(layers: Layer[]): string[] {
    const keys = new Map<string, Set<string>>();
    for (const layer of layers) for (const provider of layer.providers) {
        if (!provider.api_key) continue;
        const route = provider.name === 'kimi-for-coding' && provider.baseurl.replace(/\/+$/, '') === DEFAULT_KIMI_URL
            ? 'kimi-coding'
            : provider.name;
        const values = keys.get(route) ?? new Set<string>();
        values.add(provider.api_key);
        keys.set(route, values);
    }
    return [...keys].filter(([, values]) => values.size > 1).map(([route]) => route);
}

/** Move legacy plaintext provider credentials into SecretStorage, then remove their settings. */
export async function migrateLegacyProviders(): Promise<boolean> {
    const layers = allLayers();
    if (layers.length === 0) return false;
    const conflicts = secretConflicts(layers);
    if (conflicts.length > 0) {
        throw new Error(t('migration.conflicts', conflicts.join(', ')));
    }

    const service = LlmProviderService.getInstance();
    const reservedLegacyRoutes = layers.flatMap(layer => layer.providers).filter(provider => {
        const isDefaultKimi = provider.name === 'kimi-for-coding'
            && provider.baseurl.replace(/\/+$/, '') === DEFAULT_KIMI_URL;
        return !isDefaultKimi && service.isBuiltInProviderId(provider.name);
    }).map(provider => provider.name);
    if (reservedLegacyRoutes.length > 0) {
        throw new Error(t('migration.routeConflicts', [...new Set(reservedLegacyRoutes)].join(', ')));
    }
    const credentials = service.getCredentialStore();
    // Store every secret first. Configuration remains untouched if any secure write fails.
    for (const layer of layers) for (const provider of layer.providers) {
        if (!provider.api_key) continue;
        const isDefaultKimi = provider.name === 'kimi-for-coding'
            && provider.baseurl.replace(/\/+$/, '') === DEFAULT_KIMI_URL;
        await credentials.storeApiKey(isDefaultKimi ? 'kimi-coding' : provider.name, provider.api_key);
    }

    const migratedCustom = new Map<Layer, Record<string, CustomProviderProfile>>();
    for (const layer of layers) {
        const customProviders = { ...layer.customProviders };
        for (const provider of layer.providers) {
            const isDefaultKimi = provider.name === 'kimi-for-coding'
                && provider.baseurl.replace(/\/+$/, '') === DEFAULT_KIMI_URL;
            if (isDefaultKimi) continue;
            customProviders[provider.name] = {
                displayName: provider.name,
                baseUrl: provider.baseurl,
                api: 'openai-completions',
                auth: 'apiKey',
                models: layer.models[provider.name] ?? [],
            };
        }
        migratedCustom.set(layer, customProviders);
    }

    // Finish every non-secret write before removing any legacy value.
    for (const [layer, customProviders] of migratedCustom) {
        await vscode.workspace.getConfiguration('mutsumi', layer.resource)
            .update('customProviders', customProviders, layer.target);
    }

    const cleared: Layer[] = [];
    try {
        for (const layer of layers) {
            const config = vscode.workspace.getConfiguration('mutsumi', layer.resource);
            cleared.push(layer);
            await config.update('providers', undefined, layer.target);
            await config.update('models', undefined, layer.target);
        }
    } catch (error) {
        // Best-effort rollback ensures a partial settings failure does not silently discard secrets.
        for (const layer of cleared.reverse()) {
            const config = vscode.workspace.getConfiguration('mutsumi', layer.resource);
            try { await config.update('providers', layer.providers, layer.target); } catch { /* best effort */ }
            try { await config.update('models', layer.models, layer.target); } catch { /* best effort */ }
        }
        throw error;
    }
    await service.reload();
    void vscode.window.showWarningMessage(
        t('migration.rotationWarning'),
    );
    return true;
}

/** Register the manual migration command and show the one-time activation prompt. */
export function registerLegacyProviderMigration(context: vscode.ExtensionContext): void {
    const run = async () => {
        try {
            const migrated = await migrateLegacyProviders();
            if (!migrated) void vscode.window.showInformationMessage(t('migration.noneFound'));
        } catch (error: any) {
            void vscode.window.showErrorMessage(t('migration.failed', error.message ?? String(error)));
        }
    };
    context.subscriptions.push(vscode.commands.registerCommand('mutsumi.migrateProviderCredentials', run));
    if (allLayers().length === 0
        || context.globalState.get<boolean>(PROMPTED_KEY, false)) return;
    void context.globalState.update(PROMPTED_KEY, true).then(async () => {
        const migrate = t('migration.action');
        const selected = await vscode.window.showWarningMessage(
            t('migration.prompt'),
            migrate,
        );
        if (selected === migrate) await run();
    });
}
