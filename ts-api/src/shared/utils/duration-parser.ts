/**
 * Duration Parser Utility
 * Parses human-readable duration strings to milliseconds
 * 
 * Supported formats:
 * - "30m" → 30 minutes (1,800,000 ms)
 * - "6h" → 6 hours (21,600,000 ms)
 * - "1d" → 1 day (86,400,000 ms)
 * - "7d" → 7 days (604,800,000 ms)
 * - "2w" → 2 weeks (1,209,600,000 ms)
 * 
 * Range: 30 minutes to 52 weeks (1 year)
 */

export type DurationUnit = 'm' | 'h' | 'd' | 'w';

const DURATION_UNITS: Record<DurationUnit, number> = {
  m: 60 * 1000,        // 1 minute = 60,000 ms
  h: 60 * 60 * 1000,   // 1 hour = 3,600,000 ms
  d: 24 * 60 * 60 * 1000,  // 1 day = 86,400,000 ms
  w: 7 * 24 * 60 * 60 * 1000,  // 1 week = 604,800,000 ms
};

const MIN_DURATION_MS = 30 * 60 * 1000;  // 30 minutes
const MAX_DURATION_MS = 52 * 7 * 24 * 60 * 60 * 1000;  // 52 weeks (1 year)

/**
 * Parse a duration string to milliseconds
 * @param duration - Duration string (e.g., "24h", "1d", "30m")
 * @returns Milliseconds
 * @throws ParseError if format is invalid or out of range
 */
export function parseDuration(duration: string): number {
  if (typeof duration !== 'string') {
    throw new ParseError('Duration must be a string');
  }

  // Normalize: lowercase and trim
  const normalized = duration.trim().toLowerCase();
  
  // Match pattern: number + unit (m, h, d, w)
  const match = normalized.match(/^(\d+)([mhdw])$/);
  
  if (!match) {
    throw new ParseError(
      `Invalid duration format: "${duration}". ` +
      `Expected format like "30m", "6h", "1d", "7d", "2w"`
    );
  }

  const value = parseInt(match[1], 10);
  const unit = match[2] as DurationUnit;
  
  const milliseconds = value * DURATION_UNITS[unit];
  
  // Range check
  if (milliseconds < MIN_DURATION_MS) {
    throw new ParseError(
      `Duration too short: ${duration} = ${milliseconds}ms. ` +
      `Minimum: 30 minutes (30m)`
    );
  }
  
  if (milliseconds > MAX_DURATION_MS) {
    throw new ParseError(
      `Duration too long: ${duration} = ${milliseconds}ms. ` +
      `Maximum: 52 weeks (52w)`
    );
  }

  return milliseconds;
}

/**
 * Format milliseconds to a human-readable duration string
 * @param ms - Milliseconds
 * @returns Duration string (e.g., "1d", "6h")
 */
export function formatDuration(ms: number): string {
  if (ms < 0) {
    throw new ParseError('Cannot format negative duration');
  }

  // Find the best unit
  const units: { unit: DurationUnit; threshold: number }[] = [
    { unit: 'w', threshold: DURATION_UNITS.w },
    { unit: 'd', threshold: DURATION_UNITS.d },
    { unit: 'h', threshold: DURATION_UNITS.h },
    { unit: 'm', threshold: DURATION_UNITS.m },
  ];

  for (const { unit, threshold } of units) {
    if (ms >= threshold && ms % threshold === 0) {
      const value = ms / threshold;
      return `${value}${unit}`;
    }
  }

  // Fallback: use largest unit that divides evenly
  for (const { unit, threshold } of units) {
    if (ms >= threshold) {
      const value = Math.floor(ms / threshold);
      return `${value}${unit}`;
    }
  }

  // Very small duration - return in minutes
  return `${Math.max(1, Math.ceil(ms / DURATION_UNITS.m))}m`;
}

/**
 * Validate if a string is a valid duration format
 * @param duration - String to validate
 * @returns true if valid, false otherwise
 */
export function isValidDuration(duration: string): boolean {
  try {
    parseDuration(duration);
    return true;
  } catch {
    return false;
  }
}

/**
 * Get duration in a specific unit
 * @param duration - Duration string
 * @param unit - Target unit (m, h, d, w)
 * @returns Value in target unit
 */
export function toUnit(duration: string, unit: DurationUnit): number {
  const ms = parseDuration(duration);
  return ms / DURATION_UNITS[unit];
}

/**
 * Custom error class for parse failures
 */
export class ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ParseError';
  }
}

/**
 * Duration constants for common values
 */
export const DURATION = {
  MINUTES: {
    30: 30 * 60 * 1000,
    60: 60 * 60 * 1000,
  },
  HOURS: {
    1: 1 * 60 * 60 * 1000,
    6: 6 * 60 * 60 * 1000,
    12: 12 * 60 * 60 * 1000,
    24: 24 * 60 * 60 * 1000,
  },
  DAYS: {
    1: 1 * 24 * 60 * 60 * 1000,
    7: 7 * 24 * 60 * 60 * 1000,
    30: 30 * 24 * 60 * 60 * 1000,
  },
  WEEKS: {
    1: 7 * 24 * 60 * 60 * 1000,
    2: 14 * 24 * 60 * 60 * 1000,
    4: 28 * 24 * 60 * 60 * 1000,
    52: 52 * 7 * 24 * 60 * 60 * 1000,
  },
} as const;
