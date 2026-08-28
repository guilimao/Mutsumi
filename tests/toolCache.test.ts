import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
    l10n: { t: (message: string) => message },
}));

import { clearToolCache, executeWithToolCache } from '../src/tools.d/cache';

describe('executeWithToolCache', () => {
    beforeEach(() => clearToolCache());

    it('executes every time when caching is disabled', async () => {
        const operation = vi.fn()
            .mockResolvedValueOnce('first')
            .mockResolvedValueOnce('second');

        await expect(executeWithToolCache('read', { uri: 'a' }, false, operation)).resolves.toBe('first');
        await expect(executeWithToolCache('read', { uri: 'a' }, false, operation)).resolves.toBe('second');
        expect(operation).toHaveBeenCalledTimes(2);
    });

    it('reuses a completed result when caching is enabled', async () => {
        const operation = vi.fn().mockResolvedValue('result');

        await expect(executeWithToolCache('system_info', {}, true, operation)).resolves.toBe('result');
        await expect(executeWithToolCache('system_info', {}, true, operation)).resolves.toBe('result');
        expect(operation).toHaveBeenCalledTimes(1);
    });

    it('does not cache a rejected operation', async () => {
        const operation = vi.fn()
            .mockRejectedValueOnce(new Error('cancelled'))
            .mockResolvedValueOnce('recovered');

        await expect(executeWithToolCache('system_info', {}, true, operation)).rejects.toThrow('cancelled');
        await expect(executeWithToolCache('system_info', {}, true, operation)).resolves.toBe('recovered');
        expect(operation).toHaveBeenCalledTimes(2);
    });
});
