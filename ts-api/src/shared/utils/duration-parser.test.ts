import { describe, it, expect } from 'vitest';
import {
  parseDuration,
  formatDuration,
  isValidDuration,
  toUnit,
  ParseError,
} from './duration-parser.js';

describe('parseDuration', () => {
  it('parses minutes', () => {
    expect(parseDuration('30m')).toBe(30 * 60 * 1000);
    expect(parseDuration('60m')).toBe(60 * 60 * 1000);
    expect(parseDuration('90m')).toBe(90 * 60 * 1000);
  });

  it('parses hours', () => {
    expect(parseDuration('1h')).toBe(1 * 60 * 60 * 1000);
    expect(parseDuration('6h')).toBe(6 * 60 * 60 * 1000);
    expect(parseDuration('24h')).toBe(24 * 60 * 60 * 1000);
  });

  it('parses days', () => {
    expect(parseDuration('1d')).toBe(1 * 24 * 60 * 60 * 1000);
    expect(parseDuration('7d')).toBe(7 * 24 * 60 * 60 * 1000);
    expect(parseDuration('30d')).toBe(30 * 24 * 60 * 60 * 1000);
  });

  it('parses weeks', () => {
    expect(parseDuration('1w')).toBe(7 * 24 * 60 * 60 * 1000);
    expect(parseDuration('2w')).toBe(14 * 24 * 60 * 60 * 1000);
    expect(parseDuration('4w')).toBe(28 * 24 * 60 * 60 * 1000);
  });

  it('handles case insensitivity', () => {
    expect(parseDuration('30M')).toBe(30 * 60 * 1000);
    expect(parseDuration('24H')).toBe(24 * 60 * 60 * 1000);
    expect(parseDuration('1D')).toBe(1 * 24 * 60 * 60 * 1000);
    expect(parseDuration('1W')).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it('handles whitespace', () => {
    expect(parseDuration(' 30m ')).toBe(30 * 60 * 1000);
    expect(parseDuration('  1d  ')).toBe(1 * 24 * 60 * 60 * 1000);
  });

  it('throws for invalid formats', () => {
    expect(() => parseDuration('')).toThrow(ParseError);
    expect(() => parseDuration('abc')).toThrow(ParseError);
    expect(() => parseDuration('123')).toThrow(ParseError);
    expect(() => parseDuration('1x')).toThrow(ParseError);
    expect(() => parseDuration('h')).toThrow(ParseError);
  });

  it('throws for non-strings', () => {
    expect(() => parseDuration(null as any)).toThrow(ParseError);
    expect(() => parseDuration(undefined as any)).toThrow(ParseError);
    expect(() => parseDuration(123 as any)).toThrow(ParseError);
  });

  it('throws for durations too short', () => {
    expect(() => parseDuration('1m')).toThrow(ParseError);
    expect(() => parseDuration('29m')).toThrow(ParseError);
  });

  it('throws for durations too long', () => {
    expect(() => parseDuration('53w')).toThrow(ParseError);
    expect(() => parseDuration('100w')).toThrow(ParseError);
    expect(() => parseDuration('365d')).toThrow(ParseError);
  });

  it('accepts minimum duration (30m)', () => {
    expect(parseDuration('30m')).toBe(30 * 60 * 1000);
  });

  it('accepts maximum duration (52w)', () => {
    expect(parseDuration('52w')).toBe(52 * 7 * 24 * 60 * 60 * 1000);
  });
});

describe('formatDuration', () => {
  it('formats to minutes', () => {
    expect(formatDuration(30 * 60 * 1000)).toBe('30m');
    // 60m is formatted as 1h (more compact representation)
    expect(formatDuration(60 * 60 * 1000)).toBe('1h');
  });

  it('formats to hours', () => {
    expect(formatDuration(1 * 60 * 60 * 1000)).toBe('1h');
    expect(formatDuration(6 * 60 * 60 * 1000)).toBe('6h');
    // 24h is formatted as 1d (more compact representation)
    expect(formatDuration(24 * 60 * 60 * 1000)).toBe('1d');
  });

  it('formats to days', () => {
    expect(formatDuration(1 * 24 * 60 * 60 * 1000)).toBe('1d');
    // 7d is formatted as 1w (more compact representation)
    expect(formatDuration(7 * 24 * 60 * 60 * 1000)).toBe('1w');
  });

  it('formats to weeks', () => {
    expect(formatDuration(7 * 24 * 60 * 60 * 1000)).toBe('1w');
    expect(formatDuration(14 * 24 * 60 * 60 * 1000)).toBe('2w');
  });

  it('throws for negative durations', () => {
    expect(() => formatDuration(-1)).toThrow(ParseError);
  });

  it('handles zero', () => {
    expect(formatDuration(0)).toBe('1m');
  });
});

describe('isValidDuration', () => {
  it('returns true for valid durations', () => {
    expect(isValidDuration('30m')).toBe(true);
    expect(isValidDuration('6h')).toBe(true);
    expect(isValidDuration('1d')).toBe(true);
    expect(isValidDuration('7d')).toBe(true);
    expect(isValidDuration('52w')).toBe(true);
  });

  it('returns false for invalid durations', () => {
    expect(isValidDuration('')).toBe(false);
    expect(isValidDuration('abc')).toBe(false);
    expect(isValidDuration('1m')).toBe(false); // too short
    expect(isValidDuration('53w')).toBe(false); // too long
  });
});

describe('toUnit', () => {
  it('converts to minutes', () => {
    expect(toUnit('1h', 'm')).toBe(60);
    expect(toUnit('1d', 'm')).toBe(24 * 60);
  });

  it('converts to hours', () => {
    expect(toUnit('30m', 'h')).toBe(0.5);
    expect(toUnit('1d', 'h')).toBe(24);
  });

  it('converts to days', () => {
    expect(toUnit('24h', 'd')).toBe(1);
    expect(toUnit('1w', 'd')).toBe(7);
  });

  it('converts to weeks', () => {
    expect(toUnit('7d', 'w')).toBe(1);
    expect(toUnit('14d', 'w')).toBe(2);
  });

  it('throws for invalid duration', () => {
    expect(() => toUnit('invalid', 'h')).toThrow(ParseError);
  });
});

describe('retention use cases', () => {
  it('handles common retention values', () => {
    // Common values from documentation
    expect(parseDuration('6h')).toBe(6 * 60 * 60 * 1000);
    expect(parseDuration('24h')).toBe(24 * 60 * 60 * 1000);
    expect(parseDuration('1d')).toBe(24 * 60 * 60 * 1000);
    expect(parseDuration('7d')).toBe(7 * 24 * 60 * 60 * 1000);
    expect(parseDuration('30d')).toBe(30 * 24 * 60 * 60 * 1000);
  });
});
