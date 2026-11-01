import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FP_READ_CAP, fileFp } from './file-fp.ts';

/**
 * Отпечаток файла (этап 8, F3/F4) на НАСТОЯЩЕМ файловом вводе платформы: тот же текст — тот же
 * отпечаток, правка — другой; крупнее 1 МиБ — `size:mtime` без чтения; нет файла — `null`.
 */

const dir = () => {
  const d = mkdtempSync(join(tmpdir(), 'fp-'));
  mkdirSync(d, { recursive: true });
  return d;
};

describe('stage 8 file fingerprint at tool.result', () => {
  it('same bytes give the same sha256 fingerprint and size; an edit changes it', () => {
    const d = dir();
    const a = join(d, 'a.txt');
    const b = join(d, 'b.txt');
    writeFileSync(a, 'hello\n');
    writeFileSync(b, 'hello\n');
    const fa = fileFp(a);
    expect(fa).toEqual({ fp: fileFp(b)?.fp, sizeBytes: 6 });
    expect(fa?.fp).toMatch(/^sha256:[0-9a-f]{64}$/);
    writeFileSync(a, 'hello!\n');
    expect(fileFp(a)?.fp).not.toBe(fa?.fp);
  });

  it('a file above the read cap is fingerprinted by size and mtime without reading it', () => {
    const d = dir();
    const big = join(d, 'Big.bin');
    writeFileSync(big, Buffer.alloc(FP_READ_CAP + 1, 1));
    utimesSync(big, 1_700_000_000, 1_700_000_000);
    const got = fileFp(big);
    expect(got).toEqual({
      fp: `size:${FP_READ_CAP + 1}:1700000000000`,
      sizeBytes: FP_READ_CAP + 1,
    });
    utimesSync(big, 1_700_000_100, 1_700_000_100);
    expect(fileFp(big)?.fp).not.toBe(got?.fp);
    let reads = 0;
    const io = {
      size: () => ({ value: FP_READ_CAP + 5 }),
      read: () => {
        reads += 1;
        return { value: Buffer.alloc(0) };
      },
      mtime: () => ({ value: 42 }),
    };
    expect(fileFp('/x', io)).toEqual({
      fp: `size:${FP_READ_CAP + 5}:42`,
      sizeBytes: FP_READ_CAP + 5,
    });
    expect(reads).toBe(0);
  });

  it('a missing path, an empty path or an unreadable file has no fingerprint', () => {
    const d = dir();
    expect(fileFp(join(d, 'nope.txt'))).toBeNull();
    expect(fileFp('')).toBeNull();
    expect(fileFp(d)).toBeNull();
    const io = {
      size: () => ({ value: 3 }),
      read: () => ({ unknown: 'EACCES' }),
      mtime: () => ({ value: 1 }),
    };
    expect(fileFp('/x', io)).toBeNull();
  });
});
