/**
 * @fileoverview Compact token-count formatting for the notebook renderer.
 * Pure and DOM-free so both the renderer bundle and unit tests can import it.
 * @module notebook/formatTokens
 */

/**
 * Compact token count with consistent seams, e.g. 950 -> "950", 1234 -> "1.2K",
 * 999_499 -> "999K", 999_500 -> "1M", 1_200_000 -> "1.2M", 12_400_000 -> "12M".
 * One decimal below 10 of a unit and integer above, so boundaries never render
 * "1.0K" / "10.0K" / "1000K" artifacts.
 */
export function formatTokens(count: number): string {
  if (!Number.isFinite(count) || count <= 0) return '0';
  if (count < 1000) return String(Math.round(count));
  if (count < 1_000_000) return formatUnit(count / 1000, 'K', 'M');
  return formatUnit(count / 1_000_000, 'M', 'B');
}

/** One unit's worth of formatting; values at the top of a unit roll into the next one. */
function formatUnit(value: number, suffix: string, nextSuffix: string): string {
  if (value >= 999.5) return `1${nextSuffix}`;
  return `${value < 10 ? trimZero(value.toFixed(1)) : Math.round(value)}${suffix}`;
}

function trimZero(value: string): string {
  return value.replace(/\.0$/, '');
}
