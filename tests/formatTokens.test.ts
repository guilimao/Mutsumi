import { describe, expect, it } from 'vitest';
import { formatTokens } from '../src/notebook/formatTokens';

describe('formatTokens', () => {
    it('renders raw counts below 1000', () => {
        expect(formatTokens(0)).toBe('0');
        expect(formatTokens(1)).toBe('1');
        expect(formatTokens(950)).toBe('950');
        expect(formatTokens(999)).toBe('999');
    });

    it('uses one decimal below 10 of a unit and integers above', () => {
        expect(formatTokens(1000)).toBe('1K');
        expect(formatTokens(1234)).toBe('1.2K');
        expect(formatTokens(9960)).toBe('10K');
        expect(formatTokens(12500)).toBe('13K');
        expect(formatTokens(120000)).toBe('120K');
    });

    it('has no 1000K seam: values at the K boundary roll into M', () => {
        expect(formatTokens(999499)).toBe('999K');
        expect(formatTokens(999500)).toBe('1M');
        expect(formatTokens(999999)).toBe('1M');
        expect(formatTokens(1_000_000)).toBe('1M');
    });

    it('renders millions with the same seams', () => {
        expect(formatTokens(1_200_000)).toBe('1.2M');
        expect(formatTokens(9_960_000)).toBe('10M');
        expect(formatTokens(12_400_000)).toBe('12M');
        expect(formatTokens(9_999_999)).toBe('10M');
    });

    it('treats non-finite and negative input as zero', () => {
        expect(formatTokens(Number.NaN)).toBe('0');
        expect(formatTokens(Number.POSITIVE_INFINITY)).toBe('0');
        expect(formatTokens(-5)).toBe('0');
    });
});
