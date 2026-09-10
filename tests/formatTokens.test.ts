import { describe, expect, it } from 'vitest';
import { formatDuration, formatPercent, formatThroughput, formatTokens } from '../src/notebook/formatTokens';

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

describe('formatPercent', () => {
    it('floors a tiny nonzero share below 1%', () => {
        expect(formatPercent(0.0001)).toBe('<1%');
        expect(formatPercent(0.0099)).toBe('<1%');
        expect(formatPercent(0.01)).toBe('1%');
    });

    it('rounds to whole percent and keeps overflow readable', () => {
        expect(formatPercent(0.755)).toBe('76%');
        expect(formatPercent(1.2)).toBe('120%');
    });

    it('renders zero, negative and non-finite as 0%', () => {
        expect(formatPercent(0)).toBe('0%');
        expect(formatPercent(-0.5)).toBe('0%');
        expect(formatPercent(Number.NaN)).toBe('0%');
    });
});

describe('formatDuration', () => {
    it('uses ms below one second and seconds above', () => {
        expect(formatDuration(0)).toBe('0ms');
        expect(formatDuration(820)).toBe('820ms');
        expect(formatDuration(1000)).toBe('1.0s');
        expect(formatDuration(1400)).toBe('1.4s');
    });

    it('rounds before choosing the unit so 999.5ms never renders as 1000ms', () => {
        expect(formatDuration(999.5)).toBe('1.0s');
        expect(formatDuration(999.4)).toBe('999ms');
    });

    it('renders negative and non-finite as 0ms', () => {
        expect(formatDuration(-1)).toBe('0ms');
        expect(formatDuration(Number.NaN)).toBe('0ms');
    });
});

describe('formatThroughput', () => {
    it('uses one decimal below 10 tok/s and integers above', () => {
        expect(formatThroughput(4.25)).toBe('4.3');
        expect(formatThroughput(9.9)).toBe('9.9');
        expect(formatThroughput(12.5)).toBe('13');
    });

    it('rounds before choosing the form so 9.95 never renders as 10.0', () => {
        expect(formatThroughput(9.95)).toBe('10');
        expect(formatThroughput(9.94)).toBe('9.9');
    });

    it('renders zero, negative and non-finite as 0', () => {
        expect(formatThroughput(0)).toBe('0');
        expect(formatThroughput(-3)).toBe('0');
        expect(formatThroughput(Number.NaN)).toBe('0');
    });
});
