/**
 * @fileoverview Compact value formatting for the notebook renderer (token counts and the
 * usage-metric values derived from them).
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

/**
 * Percentage with a `1%` floor so a tiny but nonzero share never rounds to a flat `0%`.
 * Non-finite or non-positive ratios render as `0%` (which also keeps an overflowing context
 * share, e.g. 120%, readable rather than clamped).
 */
export function formatPercent(ratio: number): string {
  if (!Number.isFinite(ratio) || ratio <= 0) return '0%';
  const percent = ratio * 100;
  if (percent < 1) return '<1%';
  return `${Math.round(percent)}%`;
}

/**
 * Sub-second as whole ms, longer as one-decimal seconds ("820ms", "1.0s"). The rounding
 * happens first so a value at the boundary (999.5ms) reads as "1.0s", never "1000ms".
 * Non-finite or negative input renders as "0ms", like the sibling formatters.
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0ms';
  const rounded = Math.round(ms);
  return rounded < 1000 ? `${rounded}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/**
 * One decimal below 10 tok/s so slow streams do not all collapse to "0"/"1"; integers at and
 * above 10, with the same pre-rounding so 9.95 never renders as "10.0".
 */
export function formatThroughput(tokensPerSecond: number): string {
  if (!Number.isFinite(tokensPerSecond) || tokensPerSecond <= 0) return '0';
  const rounded = Math.round(tokensPerSecond * 10) / 10;
  return rounded < 10 ? rounded.toFixed(1) : String(Math.round(tokensPerSecond));
}

/** One unit's worth of formatting; values at the top of a unit roll into the next one. */
function formatUnit(value: number, suffix: string, nextSuffix: string): string {
  if (value >= 999.5) return `1${nextSuffix}`;
  return `${value < 10 ? trimZero(value.toFixed(1)) : Math.round(value)}${suffix}`;
}

function trimZero(value: string): string {
  return value.replace(/\.0$/, '');
}
