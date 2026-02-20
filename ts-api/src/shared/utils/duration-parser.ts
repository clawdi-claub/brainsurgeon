/**
 * Duration Parser — based on OpenClaw's parse-duration.ts
 * https://github.com/openclaw/openclaw/blob/main/src/cli/parse-duration.ts
 *
 * Extended with 'w' (weeks) unit for retention config compatibility.
 */

export type DurationUnit = 'ms' | 's' | 'm' | 'h' | 'd' | 'w';

export type DurationMsParseOptions = {
  defaultUnit?: DurationUnit;
};

/**
 * Parse a duration string to milliseconds.
 * Accepts: "500ms", "30s", "5m", "6h", "1d", "2w"
 */
export function parseDurationMs(raw: string, opts?: DurationMsParseOptions): number {
  const trimmed = String(raw ?? '')
    .trim()
    .toLowerCase();
  if (!trimmed) {
    throw new Error('invalid duration (empty)');
  }

  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h|d|w)?$/.exec(trimmed);
  if (!m) {
    throw new Error(`invalid duration: ${raw}`);
  }

  const value = Number(m[1]);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`invalid duration: ${raw}`);
  }

  const unit = (m[2] ?? opts?.defaultUnit ?? 'ms') as DurationUnit;
  const multiplier =
    unit === 'ms'
      ? 1
      : unit === 's'
        ? 1000
        : unit === 'm'
          ? 60_000
          : unit === 'h'
            ? 3_600_000
            : unit === 'd'
              ? 86_400_000
              : 604_800_000; // w
  const ms = Math.round(value * multiplier);
  if (!Number.isFinite(ms)) {
    throw new Error(`invalid duration: ${raw}`);
  }
  return ms;
}

/** Alias for backward compatibility */
export const parseDuration = parseDurationMs;

/**
 * Format milliseconds to a compact human-readable duration string.
 */
export function formatDuration(ms: number): string {
  if (ms < 0) {
    throw new Error('Cannot format negative duration');
  }

  const units: { unit: string; divisor: number }[] = [
    { unit: 'w', divisor: 604_800_000 },
    { unit: 'd', divisor: 86_400_000 },
    { unit: 'h', divisor: 3_600_000 },
    { unit: 'm', divisor: 60_000 },
    { unit: 's', divisor: 1000 },
  ];

  for (const { unit, divisor } of units) {
    if (ms >= divisor && ms % divisor === 0) {
      return `${ms / divisor}${unit}`;
    }
  }

  for (const { unit, divisor } of units) {
    if (ms >= divisor) {
      return `${Math.floor(ms / divisor)}${unit}`;
    }
  }

  return `${ms}ms`;
}

/**
 * Validate if a string is a valid duration format.
 */
export function isValidDuration(duration: string): boolean {
  try {
    parseDurationMs(duration);
    return true;
  } catch {
    return false;
  }
}
