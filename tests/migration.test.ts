import { beforeEach, describe, expect, it, vi } from 'vitest';

type Values = Record<string, unknown>;
const state = vi.hoisted(() => ({
    global: {} as Values,
    workspace: {} as Values,
    folders: new Map<string, Values>(),
    updates: [] as Array<{ resource?: string; key: string; value: unknown; target: number }>,
    fail: undefined as undefined | ((resource: string | undefined, key: string, value: unknown, target: number) => boolean),
    storeApiKey: vi.fn(),
    reload: vi.fn(),
    builtInRoutes: new Set(['kimi-coding']),
}));

vi.mock('vscode', () => {
    const ConfigurationTarget = { Global: 1, Workspace: 2, WorkspaceFolder: 3 };
    const getValues = (resource?: { path: string }) => resource ? state.folders.get(resource.path) ?? {} : {};
    return {
        ConfigurationTarget,
        workspace: {
            workspaceFolders: [{ uri: { path: '/one' } }, { uri: { path: '/two' } }],
            getConfiguration: (_section: string, resource?: { path: string }) => ({
                inspect: (key: string) => ({
                    globalValue: state.global[key],
                    workspaceValue: state.workspace[key],
                    workspaceFolderValue: getValues(resource)[key],
                }),
                update: async (key: string, value: unknown, target: number) => {
                    const resourcePath = resource?.path;
                    state.updates.push({ resource: resourcePath, key, value, target });
                    if (state.fail?.(resourcePath, key, value, target)) throw new Error('write failed');
                    const values = target === 1 ? state.global : target === 2 ? state.workspace : getValues(resource);
                    if (value === undefined) delete values[key]; else values[key] = value;
                },
            }),
        },
        window: { showWarningMessage: vi.fn(), showInformationMessage: vi.fn(), showErrorMessage: vi.fn() },
        commands: { registerCommand: vi.fn(() => ({ dispose() {} })) },
        l10n: { t: (key: string, ...args: unknown[]) => `${key}${args.length ? `: ${args.join(', ')}` : ''}` },
    };
});

vi.mock('../src/llm/providerService', () => ({
    LlmProviderService: {
        getInstance: () => ({
            getCredentialStore: () => ({ storeApiKey: state.storeApiKey }),
            reload: state.reload,
            isBuiltInProviderId: (id: string) => state.builtInRoutes.has(id),
        }),
    },
}));

import { migrateLegacyProviders } from '../src/llm/migration';

const legacy = (name: string, key: string, baseurl = 'https://example.test/v1') => ({ name, baseurl, api_key: key });

beforeEach(() => {
    state.global = {};
    state.workspace = {};
    state.folders = new Map([['/one', {}], ['/two', {}]]);
    state.updates = [];
    state.fail = undefined;
    state.storeApiKey.mockReset().mockResolvedValue(undefined);
    state.reload.mockReset().mockResolvedValue(undefined);
    state.builtInRoutes = new Set(['kimi-coding']);
});

describe('legacy provider migration', () => {
    it('stops before writes when one route has conflicting plaintext keys across scopes', async () => {
        state.global.providers = [legacy('shared', 'one')];
        state.folders.get('/two')!.providers = [legacy('shared', 'two')];
        await expect(migrateLegacyProviders()).rejects.toThrow('migration.conflicts');
        expect(state.storeApiKey).not.toHaveBeenCalled();
        expect(state.updates).toEqual([]);
    });

    it('requires legacy custom routes that collide with built-ins to be renamed', async () => {
        state.global.providers = [legacy('kimi-coding', 'key', 'https://proxy.example.test/v1')];
        await expect(migrateLegacyProviders()).rejects.toThrow('migration.routeConflicts');
        expect(state.storeApiKey).not.toHaveBeenCalled();
    });

    it('migrates all scopes, aliases exact Kimi defaults, and removes plaintext only after secure writes', async () => {
        state.global.providers = [legacy('kimi-for-coding', 'kimi-key', 'https://api.kimi.com/coding/v1')];
        state.workspace.providers = [legacy('proxy', 'proxy-key')];
        state.workspace.models = { proxy: ['model-a'] };
        state.folders.get('/one')!.providers = [legacy('folder-route', 'folder-key')];

        await expect(migrateLegacyProviders()).resolves.toBe(true);

        expect(state.storeApiKey.mock.calls).toEqual([
            ['kimi-coding', 'kimi-key'], ['proxy', 'proxy-key'], ['folder-route', 'folder-key'],
        ]);
        expect((state.workspace.customProviders as any).proxy).toMatchObject({ models: ['model-a'], auth: 'apiKey' });
        expect(state.global.providers).toBeUndefined();
        expect(state.workspace.providers).toBeUndefined();
        expect(state.folders.get('/one')!.providers).toBeUndefined();
        const firstCleanup = state.updates.findIndex(update => update.key === 'providers' && update.value === undefined);
        const lastCustom = state.updates.reduce((last, update, index) => update.key === 'customProviders' ? index : last, -1);
        expect(firstCleanup).toBeGreaterThan(lastCustom);
    });

    it('restores already-cleared plaintext settings if cleanup fails midway', async () => {
        state.global.providers = [legacy('global', 'one')];
        state.workspace.providers = [legacy('workspace', 'two')];
        state.fail = (_resource, key, value, target) => key === 'models' && value === undefined && target === 2;

        await expect(migrateLegacyProviders()).rejects.toThrow('write failed');

        expect(state.global.providers).toEqual([legacy('global', 'one')]);
        expect(state.workspace.providers).toEqual([legacy('workspace', 'two')]);
    });
});
