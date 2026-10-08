import { describe, expect, it } from 'vitest';
import { parseRange } from '../src/streaming/range.js';

describe('parseRange', () => {
  it('returns undefined for full-object requests', () => expect(parseRange(undefined, 10)).toBeUndefined());
  it('parses a bounded range and clamps its end', () => expect(parseRange('bytes=2-99', 10)).toEqual({ start: 2, end: 9 }));
  it('parses suffix ranges', () => expect(parseRange('bytes=-4', 10)).toEqual({ start: 6, end: 9 }));
  it('rejects malformed and multi-range values', () => {
    expect(() => parseRange('units=0-1', 10)).toThrow();
    expect(() => parseRange('bytes=0-1,4-5', 10)).toThrow();
    expect(() => parseRange('bytes=10-', 10)).toThrow();
  });
});
