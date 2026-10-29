import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { currentOs } from './os-kind.ts';
import { isInside } from './paths.ts';

const root = mkdtempSync(join(tmpdir(), 'inside-'));
mkdirSync(join(root, 'copy', '..foo'), { recursive: true });
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('F-44 isInside — segment comparison, not a string prefix', () => {
  const copy = join(root, 'copy');

  it('F-44 a child segment that merely starts with two dots is inside', () => {
    expect(isInside(copy, join(copy, '..foo'))).toBe(true);
    expect(isInside(copy, join(copy, '..foo', 'bar'))).toBe(true);
    expect(isInside(copy, join(copy, '...'))).toBe(true);
  });

  it('F-44 the parent itself is inside; `..` and siblings are outside', () => {
    expect(isInside(copy, copy)).toBe(true);
    expect(isInside(copy, join(copy, '..'))).toBe(false);
    expect(isInside(copy, join(copy, '..', 'copy-other'))).toBe(false);
    expect(isInside(copy, `${copy}-other`)).toBe(false);
    expect(isInside(copy, root)).toBe(false);
  });

  it('F-44 win32: another drive is outside; case differences on a case-folding volume are inside', () => {
    expect(isInside('C:\\a', 'D:\\a\\b', 'win32')).toBe(false);
    if (currentOs() === 'win32') expect(isInside(copy, join(copy.toUpperCase(), 'x'))).toBe(true);
  });
});
