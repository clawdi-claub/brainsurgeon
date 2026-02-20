import { describe, it, expect } from 'vitest';
import {
  parseDurationMs,
  parseDuration,
  formatDuration,
  isValidDuration,
} from './duration-parser.js';

describe('parseDurationMs', () => {
  it('parses milliseconds', () => {
    expect(parseDurationMs('500ms')).toBe(500);
    expect(parseDurationMs('0ms')).toBe(0);
  });

  it('parses seconds', () => {
    expect(parseDurationMs('30s')).toBe(30_000);
    expect(parseDurationMs('1s')).toBe(1000);
  });

  it('parses minutes', () => {
    expect(parseDurationMs('1m')).toBe(60_000);
    expect(parseDurationMs('30m')).toBe(1_800_000);
    expect(parseDurationMs('90m')).toBe(5_400_000);
  });

  it('parses hours', () => {
    expect(parseDurationMs('1h')).toBe(3_600_000);
    expect(parseDurationMs('6h')).toBe(21_600_000);
    expect(parseDurationMs('24h')).toBe(86_400_000);
  });

  it('parses days', () => {
    expect(parseDurationMs('1d')).toBe(86_400_000);
    expect(parseDurationMs('7d')).toBe(604_800_000);
    expect(parseDurationMs('30d')).toBe(2_592_000_000);
    expect(parseDurationMs('365d')).toBe(31_536_000_000);
  });

  it('parses weeks', () => {
    expect(parseDurationMs('1w')).toBe(604_800_000);
    expect(parseDurationMs('2w')).toBe(1_209_600_000);
    expect(parseDurationMs('52w')).toBe(52 * 604_800_000);
  });

  it('parses decimals', () => {
    expect(parseDurationMs('1.5h')).toBe(5_400_000);
    expect(parseDurationMs('0.5d')).toBe(43_200_000);
  });

  it('case insensitive', () => {
    expect(parseDurationMs('30M')).toBe(1_800_000);
    expect(parseDurationMs('24H')).toBe(86_400_000);
    expect(parseDurationMs('1D')).toBe(86_400_000);
    expect(parseDurationMs('1W')).toBe(604_800_000);
  });

  it('trims whitespace', () => {
    expect(parseDurationMs(' 30m ')).toBe(1_800_000);
    expect(parseDurationMs('  1d  ')).toBe(86_400_000);
  });

  it('uses defaultUnit when no unit specified', () => {
    expect(parseDurationMs('100', { defaultUnit: 'ms' })).toBe(100);
    expect(parseDurationMs('5', { defaultUnit: 's' })).toBe(5000);
    expect(parseDurationMs('10', { defaultUnit: 'm' })).toBe(600_000);
  });

  it('defaults to ms when no unit and no defaultUnit', () => {
    expect(parseDurationMs('1000')).toBe(1000);
  });

  it('throws on empty', () => {
    expect(() => parseDurationMs('')).toThrow('invalid duration (empty)');
  });

  it('throws on invalid format', () => {
    expect(() => parseDurationMs('abc')).toThrow('invalid duration');
    expect(() => parseDurationMs('1x')).toThrow('invalid duration');
    expect(() => parseDurationMs('h')).toThrow('invalid duration');
  });

  it('throws on null/undefined', () => {
    expect(() => parseDurationMs(null as any)).toThrow('invalid duration');
    expect(() => parseDurationMs(undefined as any)).toThrow('invalid duration');
  });

  it('no min/max limits', () => {
    // Small durations are valid
    expect(parseDurationMs('1m')).toBe(60_000);
    expect(parseDurationMs('1s')).toBe(1000);
    // Large durations are valid
    expect(parseDurationMs('365d')).toBe(31_536_000_000);
    expect(parseDurationMs('100w')).toBe(100 * 604_800_000);
  });
});

describe('parseDuration (alias)', () => {
  it('is the same function as parseDurationMs', () => {
    expect(parseDuration).toBe(parseDurationMs);
  });

  it('works identically', () => {
    expect(parseDuration('6h')).toBe(21_600_000);
    expect(parseDuration('24h')).toBe(86_400_000);
    expect(parseDuration('1d')).toBe(86_400_000);
  });
});

describe('formatDuration', () => {
  it('formats exact minutes', () => {
    expect(formatDuration(1_800_000)).toBe('30m');
    expect(formatDuration(3_600_000)).toBe('1h');
  });

  it('formats exact hours', () => {
    expect(formatDuration(3_600_000)).toBe('1h');
    expect(formatDuration(21_600_000)).toBe('6h');
  });

  it('formats exact days', () => {
    expect(formatDuration(86_400_000)).toBe('1d');
  });

  it('formats exact weeks', () => {
    expect(formatDuration(604_800_000)).toBe('1w');
    expect(formatDuration(1_209_600_000)).toBe('2w');
  });

  it('throws on negative', () => {
    expect(() => formatDuration(-1)).toThrow('Cannot format negative duration');
  });

  it('formats zero as 0ms', () => {
    expect(formatDuration(0)).toBe('0ms');
  });

  it('formats sub-second as ms', () => {
    expect(formatDuration(500)).toBe('500ms');
  });
});

describe('isValidDuration', () => {
  it('returns true for valid durations', () => {
    expect(isValidDuration('1m')).toBe(true);
    expect(isValidDuration('30m')).toBe(true);
    expect(isValidDuration('6h')).toBe(true);
    expect(isValidDuration('1d')).toBe(true);
    expect(isValidDuration('52w')).toBe(true);
    expect(isValidDuration('500ms')).toBe(true);
  });

  it('returns false for invalid durations', () => {
    expect(isValidDuration('')).toBe(false);
    expect(isValidDuration('abc')).toBe(false);
    expect(isValidDuration('1x')).toBe(false);
  });
});

describe('retention config integration', () => {
  it('parses typical retention values', () => {
    expect(parseDurationMs('6h')).toBe(21_600_000);
    expect(parseDurationMs('24h')).toBe(86_400_000);
    expect(parseDurationMs('7d')).toBe(604_800_000);
    expect(parseDurationMs('30d')).toBe(2_592_000_000);
  });
});
