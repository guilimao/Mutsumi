import * as vscode from 'vscode';
import type { AuthEvent, AuthInteraction, AuthPrompt } from '@earendil-works/pi-ai';
import { LlmProviderService } from '../../llm/providerService';
import type { CustomModelSpec, CustomProviderProfile, ProviderInfo } from '../../llm/types';
import { t } from '../../i18n';

interface ProviderPick extends vscode.QuickPickItem {
    provider?: ProviderInfo;
    action?: 'add';
}

function cancelled(): never {
    throw new vscode.CancellationError();
}

function createInteraction(): AuthInteraction {
    return {
        async prompt(prompt: AuthPrompt): Promise<string> {
            if (prompt.signal?.aborted) cancelled();
            if (prompt.type === 'select') {
                const selected = await vscode.window.showQuickPick(
                    prompt.options.map(option => ({
                        label: option.label,
                        description: option.description,
                        value: option.id,
                    })),
                    { placeHolder: prompt.message },
                );
                return selected?.value ?? cancelled();
            }
            const value = await vscode.window.showInputBox({
                title: prompt.message,
                prompt: prompt.message,
                placeHolder: prompt.placeholder,
                password: prompt.type === 'secret',
                ignoreFocusOut: true,
            });
            return value ?? cancelled();
        },
        notify(event: AuthEvent): void {
            if (event.type === 'auth_url') {
                void vscode.env.openExternal(vscode.Uri.parse(event.url));
            } else if (event.type === 'device_code') {
                void vscode.env.clipboard.writeText(event.userCode);
                void vscode.env.openExternal(vscode.Uri.parse(event.verificationUri));
                void vscode.window.showInformationMessage(t('providers.deviceCode', event.userCode));
            } else {
                void vscode.window.showInformationMessage(event.message);
            }
        },
    };
}

async function updateCustomProvider(id: string, existing?: CustomProviderProfile): Promise<boolean> {
    const displayName = await vscode.window.showInputBox({
        title: t('providers.displayName'),
        value: existing?.displayName ?? id,
        ignoreFocusOut: true,
    });
    if (displayName === undefined) return false;
    const baseUrl = await vscode.window.showInputBox({
        title: t('providers.baseUrl'),
        value: existing?.baseUrl ?? 'http://localhost:8080/v1',
        validateInput: value => {
            try {
                const url = new URL(value);
                return url.protocol === 'http:' || url.protocol === 'https:' ? undefined : t('providers.httpUrl');
            } catch {
                return t('providers.validUrl');
            }
        },
        ignoreFocusOut: true,
    });
    if (!baseUrl) return false;
    const api = await vscode.window.showQuickPick([
        { label: t('providers.openaiCompletions'), value: 'openai-completions' as const },
        { label: t('providers.openaiResponses'), value: 'openai-responses' as const },
    ], { placeHolder: t('providers.protocol') });
    if (!api) return false;
    const auth = await vscode.window.showQuickPick([
        { label: 'API Key', value: 'apiKey' as const },
        { label: t('providers.noAuth'), value: 'none' as const },
    ], { placeHolder: t('providers.authentication') });
    if (!auth) return false;
    const manualModels = await vscode.window.showInputBox({
        title: t('providers.manualModels'),
        prompt: t('providers.manualModelsPrompt'),
        // Only string-form entries are editable here; capability-declaring specs from
        // settings JSON are preserved verbatim on write-back (docs/custom-model-capabilities.md C7).
        value: (existing?.models ?? []).filter((model): model is string => typeof model === 'string').join(', '),
        ignoreFocusOut: true,
    });
    if (manualModels === undefined) return false;

    const declaredSpecs = (existing?.models ?? []).filter((model): model is CustomModelSpec => typeof model !== 'string');
    const declaredIds = new Set(declaredSpecs.map(spec => spec.id));
    const config = vscode.workspace.getConfiguration('mutsumi');
    const profiles = config.get<Record<string, CustomProviderProfile>>('customProviders', {});
    await config.update('customProviders', {
        ...profiles,
        [id]: {
            ...existing,
            displayName: displayName.trim() || id,
            baseUrl: baseUrl.trim(),
            api: api.value,
            auth: auth.value,
            models: [
                ...declaredSpecs,
                // String entries already declared as specs are dropped so the write-back cannot
                // leave duplicate ids in settings (the spec form wins, matching validation).
                ...[...new Set(manualModels.split(',').map(model => model.trim()).filter(Boolean))]
                    .filter(modelId => !declaredIds.has(modelId)),
            ],
        },
    }, vscode.ConfigurationTarget.Global);
    const service = LlmProviderService.getInstance();
    await service.reload();
    if (auth.value === 'apiKey') {
        const error = await service.configureApiKey(id, createInteraction());
        if (error) void vscode.window.showWarningMessage(t('providers.savedDiscoveryFailed', error.message));
    } else {
        if (existing && (existing.auth ?? 'apiKey') === 'apiKey') await service.deleteCredential(id);
        const errors = await service.refreshModels();
        if (errors.has(id)) void vscode.window.showWarningMessage(t('providers.savedDiscoveryFailed', errors.get(id)?.message ?? ''));
    }
    return true;
}

async function addCustomProvider(): Promise<void> {
    const service = LlmProviderService.getInstance();
    const existingIds = new Set((await service.listProviders()).map(provider => provider.id));
    const id = await vscode.window.showInputBox({
        title: t('providers.routeId'),
        prompt: t('providers.routeIdPrompt'),
        validateInput: value => !value.trim()
            ? t('providers.routeIdRequired')
            : existingIds.has(value.trim()) ? t('providers.routeIdExists') : undefined,
        ignoreFocusOut: true,
    });
    if (!id) return;
    if (await updateCustomProvider(id.trim())) {
        void vscode.window.showInformationMessage(t('providers.added', id.trim()));
    }
}

async function removeCustomProvider(provider: ProviderInfo): Promise<void> {
    const confirmation = await vscode.window.showWarningMessage(
        t('providers.removeConfirm', provider.name),
        { modal: true },
        t('providers.remove'),
    );
    if (confirmation !== t('providers.remove')) return;
    const config = vscode.workspace.getConfiguration('mutsumi');
    const profiles = { ...config.get<Record<string, CustomProviderProfile>>('customProviders', {}) };
    delete profiles[provider.id];
    await config.update('customProviders', profiles, vscode.ConfigurationTarget.Global);
    const service = LlmProviderService.getInstance();
    await service.deleteCredential(provider.id);
    await service.deleteCachedModels(provider.id);
    await service.reload();
}

async function manageProvider(provider: ProviderInfo): Promise<void> {
    const service = LlmProviderService.getInstance();
    const actions: Array<vscode.QuickPickItem & { value: string }> = [
        { label: `$(refresh) ${t('providers.refresh')}`, value: 'refresh' },
    ];
    if (provider.canConfigureApiKey) actions.unshift(
        { label: `$(key) ${t('providers.configureKey')}`, value: 'credential' },
        { label: `$(sign-out) ${t('providers.removeCredential')}`, value: 'logout' },
    );
    if (provider.isCustom) actions.push(
        { label: `$(edit) ${t('providers.edit')}`, value: 'edit' },
        { label: `$(trash) ${t('providers.removeCustom')}`, value: 'remove' },
    );
    const selected = await vscode.window.showQuickPick(actions, {
        title: provider.name,
        placeHolder: provider.authSource ? t('providers.authenticatedBy', provider.authSource) : t('providers.notConfigured'),
    });
    if (!selected) return;
    if (selected.value === 'credential') {
        const error = await service.configureApiKey(provider.id, createInteraction());
        void vscode.window.showInformationMessage(t('providers.credentialStored', provider.name));
        if (error) void vscode.window.showWarningMessage(t('providers.savedDiscoveryFailed', error.message));
    } else if (selected.value === 'logout') {
        await service.deleteCredential(provider.id);
        void vscode.window.showInformationMessage(t('providers.credentialRemoved', provider.name));
    } else if (selected.value === 'refresh') {
        const errors = await service.refreshModels();
        const error = errors.get(provider.id);
        if (error) throw error;
        void vscode.window.showInformationMessage(t('providers.refreshed', provider.name));
    } else if (selected.value === 'edit') {
        const profile = vscode.workspace.getConfiguration('mutsumi')
            .get<Record<string, CustomProviderProfile>>('customProviders', {})[provider.id];
        await updateCustomProvider(provider.id, profile);
    } else if (selected.value === 'remove') {
        await removeCustomProvider(provider);
    }
}

/** Register provider management backed by SecretStorage and pi-ai catalogs. */
export function registerManageProvidersCommand(context: vscode.ExtensionContext): void {
    context.subscriptions.push(vscode.commands.registerCommand('mutsumi.manageProviders', async () => {
        try {
            const providers = await LlmProviderService.getInstance().listProviders();
            const picks: ProviderPick[] = providers.map(provider => ({
                label: provider.configured ? `$(pass-filled) ${provider.name}` : `$(circle-outline) ${provider.name}`,
                description: provider.id,
                detail: provider.authSource
                    ? t('providers.modelCountSource', provider.modelCount, provider.authSource)
                    : t('providers.modelCountUnconfigured', provider.modelCount),
                provider,
            }));
            picks.unshift({ label: `$(add) ${t('providers.addCustom')}`, action: 'add' });
            const selected = await vscode.window.showQuickPick(picks, {
                title: t('providers.title'),
                placeHolder: t('providers.choose'),
                matchOnDescription: true,
                matchOnDetail: true,
            });
            if (selected?.action === 'add') await addCustomProvider();
            else if (selected?.provider) await manageProvider(selected.provider);
        } catch (error: any) {
            if (error instanceof vscode.CancellationError) return;
            void vscode.window.showErrorMessage(t('providers.failed', error.message ?? String(error)));
        }
    }));
}
