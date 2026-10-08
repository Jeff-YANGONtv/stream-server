import { AppError } from '../utils/errors.js';

export interface ByteRange { start: number; end: number; }

export function parseRange(value: string | undefined, size: number): ByteRange | undefined {
  if (!value) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/i.exec(value.trim());
  if (!match || value.includes(',')) throw new AppError('Requested range is not satisfiable', 416, 'RANGE_NOT_SATISFIABLE');
  const startText = match[1] ?? '';
  const endText = match[2] ?? '';
  if (!startText && !endText) throw new AppError('Requested range is not satisfiable', 416, 'RANGE_NOT_SATISFIABLE');
  if (size <= 0) throw new AppError('Requested range is not satisfiable', 416, 'RANGE_NOT_SATISFIABLE');
  let start: number;
  let end: number;
  if (!startText) {
    const suffix = Number(endText);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) throw new AppError('Requested range is not satisfiable', 416, 'RANGE_NOT_SATISFIABLE');
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(startText);
    end = endText ? Number(endText) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= size) {
      throw new AppError('Requested range is not satisfiable', 416, 'RANGE_NOT_SATISFIABLE');
    }
    end = Math.min(end, size - 1);
  }
  return { start, end };
}
