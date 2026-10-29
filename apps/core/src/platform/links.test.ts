import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../journal/__fixtures__/journal-harness.ts';
import { pathKind, realExistingPrefix, scanLinks } from './links.ts';

/**
 * Обход ссылок под корнем поиска (F-87, проход 2): junction на Windows и symlink на POSIX видны
 * ссылкой с настоящей целью; висячая — цель `null`; `.git`/`node_modules` не обходятся, но сами,
 * если ссылки, видны; бюджет исчерпан — `complete:false` с причиной.
 */

const base = tempDir('links-');
const outside = join(base, 'outside');
mkdirSync(outside, { recursive: true });
const link = (target: string, at: string): void => symlinkSync(target, at, 'junction');

describe('F-87 platform links', () => {
  it('scanLinks reports links with their real targets, dangling ones as null, without descending into them', () => {
    const root = join(base, 'tree');
    mkdirSync(join(root, 'a', 'b'), { recursive: true });
    link(outside, join(root, 'a', 'b', 'out'));
    link(join(base, 'nowhere'), join(root, 'a', 'dangling'));
    const scan = scanLinks(root);
    expect(scan.complete).toBe(true);
    expect(scan.links).toEqual(
      expect.arrayContaining([
        { at: join(root, 'a', 'b', 'out'), target: realpathSync.native(outside) },
        { at: join(root, 'a', 'dangling'), target: null },
      ]),
    );
    expect(scan.links).toHaveLength(2);
  });

  it('.git and node_modules are not walked, but a node_modules that is itself a link is reported', () => {
    const root = join(base, 'skip');
    mkdirSync(join(root, '.git', 'objects'), { recursive: true });
    mkdirSync(join(root, 'pkg', 'node_modules', 'x'), { recursive: true });
    link(outside, join(root, '.git', 'objects', 'hidden'));
    link(outside, join(root, 'pkg', 'node_modules', 'x', 'hidden'));
    link(outside, join(root, 'node_modules'));
    const scan = scanLinks(root);
    expect(scan.links.map((l) => l.at)).toEqual([join(root, 'node_modules')]);
  });

  it('a tree larger than the budget is not complete and says why', () => {
    const root = join(base, 'big');
    mkdirSync(root, { recursive: true });
    for (let i = 0; i < 10; i++) writeFileSync(join(root, `f${i}`), 'x');
    expect(scanLinks(root, 4)).toMatchObject({
      complete: false,
      reason: expect.stringContaining('budget'),
    });
    expect(scanLinks(root, 10)).toMatchObject({ complete: true, seen: 10 });
  });

  it('a root that cannot be read is not complete', () => {
    expect(scanLinks(join(base, 'no-such-dir'))).toMatchObject({ complete: false });
  });

  it('realExistingPrefix resolves the deepest existing part, refuses a dangling link', () => {
    const root = join(base, 'prefix');
    mkdirSync(root, { recursive: true });
    link(outside, join(root, 'out'));
    link(join(base, 'gone'), join(root, 'dangling'));
    expect(realExistingPrefix(join(root, 'out', 'new', 'file.txt'))).toEqual({
      real: join(realpathSync.native(outside), 'new', 'file.txt'),
    });
    expect(realExistingPrefix(join(root, 'dangling', 'x'))).toMatchObject({
      unknown: expect.stringContaining('does not resolve'),
    });
    expect(pathKind(root)).toBe('dir');
    expect(pathKind(join(root, 'missing'))).toBe('missing');
    expect(pathKind(join(root, 'dangling'))).toBe('missing');
  });
});
