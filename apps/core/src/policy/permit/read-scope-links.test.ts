import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PermissionAsk } from '../../adapters/adapter.types.ts';
import { tempDir } from '../../journal/__fixtures__/journal-harness.ts';
import { decidePermit } from './permit.ts';
import type { PermitContext, ReadScope } from './permit.types.ts';

/**
 * Ссылки внутри копии, ведущие наружу (F-87, проход 2): чтение по литеральному пути судится по
 * цели ссылки (realpath самого глубокого существующего префикса), нечитаемая ссылка — отказ;
 * поиск (маска или каталог), чей корень содержит ссылку за пределы области, — отказ: судья не
 * знает, пойдёт ли инструмент по ссылке. Обход ограничен бюджетом; не досмотрел — отказ.
 */

const base = tempDir('read-links-');
const copy = join(base, 'copy');
const outside = join(base, 'outside');
const toolchain = join(base, 'toolchain');
const coreHome = join(base, 'core-home');
for (const dir of [join(copy, 'src', 'deep'), join(copy, 'clean'), outside, toolchain, coreHome]) {
  mkdirSync(dir, { recursive: true });
}
writeFileSync(join(copy, 'src', 'a.ts'), 'x');
writeFileSync(join(copy, 'clean', 'b.ts'), 'x');
writeFileSync(join(outside, 'secret.txt'), 'x');
writeFileSync(join(toolchain, 'pkg.js'), 'x');
writeFileSync(join(coreHome, 'token'), 'x');
// Junction на Windows (без прав администратора), symlink каталога на POSIX.
const link = (target: string, at: string): void => symlinkSync(target, at, 'junction');
link(outside, join(copy, 'src', 'deep', 'out-link'));
link(join(base, 'missing'), join(copy, 'dangling'));

const ctx = (copyRoot: string, readScope?: ReadScope): PermitContext => ({
  copyRoot,
  ownedPaths: [],
  deny: { paths: [], commands: [], mcpTools: [], tools: [] },
  platformPaths: [coreHome],
  endpointSources: [],
  grantRequired: [],
  grants: [],
  ...(readScope ? { readScope } : {}),
});

const read = (target: string, tool = 'Grep'): PermissionAsk => ({
  action: 'read',
  target,
  tool,
  display: `${tool} ${target}`,
});

/** Отдельная копия на случай: ссылки одного случая не мешают другому. */
function freshCopy(name: string): string {
  const root = join(base, name);
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'a.ts'), 'x');
  return root;
}

describe('F-87 links inside the copy', () => {
  describe('(a) literal paths are judged by the link target', () => {
    it('a search root through a link leaving the copy → outside-copy', () => {
      const c = ctx(copy);
      expect(decidePermit(read(join(copy, 'src', 'deep', 'out-link')), c)).toMatchObject({
        code: 'outside-copy',
      });
      expect(decidePermit(read('src/deep/out-link/**', 'Glob'), c)).toMatchObject({
        code: 'outside-copy',
      });
    });

    it('an unreadable (dangling) link is refused, not taken as written', () => {
      expect(decidePermit(read(join(copy, 'dangling', 'x.txt'), 'Read'), ctx(copy))).toMatchObject({
        allow: false,
        code: 'outside-copy',
      });
    });
  });

  describe('(b) a search whose root contains a link leaving the read scope', () => {
    it('a wildcard that can match the link → outside-copy', () => {
      expect(decidePermit(read('src/deep/out*/secret.txt', 'Glob'), ctx(copy))).toMatchObject({
        allow: false,
        code: 'outside-copy',
      });
    });

    it('a directory search containing the link (deep) → outside-copy; a sibling subtree is searched', () => {
      const c = ctx(copy);
      expect(decidePermit(read(copy), c)).toMatchObject({ code: 'outside-copy' });
      expect(decidePermit(read(join(copy, 'src')), c)).toMatchObject({ code: 'outside-copy' });
      expect(decidePermit(read(join(copy, 'clean')), c)).toMatchObject({ allow: true });
      expect(decidePermit(read('clean/**/*.ts', 'Glob'), c)).toMatchObject({ allow: true });
      // Корня поиска ещё нет: обходить нечего — не отказ.
      expect(decidePermit(read('not-yet/**/*.ts', 'Glob'), c)).toMatchObject({ allow: true });
      // Литеральный файл рядом со ссылкой — не поиск: ссылку он не обходит.
      expect(decidePermit(read(join(copy, 'src', 'a.ts'), 'Read'), c)).toMatchObject({
        allow: true,
      });
    });

    it('a link that stays inside the copy or lands in an allowed root is fine', () => {
      const root = freshCopy('inside-links');
      link(join(root, 'src'), join(root, 'src-alias'));
      link(toolchain, join(root, 'tc'));
      expect(decidePermit(read(root), ctx(root))).toMatchObject({ code: 'outside-copy' });
      const scoped = ctx(root, { roots: [toolchain], human: [], credentials: [] });
      expect(decidePermit(read(root), scoped)).toMatchObject({ allow: true });
    });

    it('a search root holding a link that does not resolve → outside-copy', () => {
      const root = freshCopy('dangling-only');
      link(join(base, 'gone'), join(root, 'src', 'gone'));
      expect(decidePermit(read(root), ctx(root))).toMatchObject({
        allow: false,
        code: 'outside-copy',
        reason: expect.stringContaining('does not resolve'),
      });
    });

    it('a link to the core home inside a search root → platform-path', () => {
      const root = freshCopy('home-link');
      link(coreHome, join(root, 'src', 'home'));
      expect(decidePermit(read('src/**', 'Glob'), ctx(root))).toMatchObject({
        allow: false,
        code: 'platform-path',
      });
    });

    it('a link made after an earlier allowed search is seen by the next search (no stale snapshot)', () => {
      const root = freshCopy('mid-session');
      const c = ctx(root);
      expect(decidePermit(read(root), c)).toMatchObject({ allow: true });
      link(outside, join(root, 'src', 'later'));
      expect(decidePermit(read(root), c)).toMatchObject({ code: 'outside-copy' });
    });

    it('an allowed root reached through a link is scanned too: its own link outward refuses', () => {
      const root = freshCopy('chain');
      const tc = join(base, 'tc-chain');
      mkdirSync(tc, { recursive: true });
      link(outside, join(tc, 'escape'));
      link(tc, join(root, 'tc'));
      const scoped = ctx(root, { roots: [tc], human: [], credentials: [] });
      expect(decidePermit(read(root), scoped)).toMatchObject({ code: 'outside-copy' });
    });

    it('a search root larger than the scan budget is refused (not fully seen)', () => {
      const root = freshCopy('budget');
      for (let i = 0; i < 12; i++) writeFileSync(join(root, 'src', `f${i}.ts`), 'x');
      const tight = ctx(root, { roots: [], human: [], credentials: [], scanBudget: 5 });
      expect(decidePermit(read(root), tight)).toMatchObject({
        allow: false,
        code: 'outside-copy',
        reason: expect.stringContaining('budget'),
      });
      const wide = ctx(root, { roots: [], human: [], credentials: [], scanBudget: 1000 });
      expect(decidePermit(read(root), wide)).toMatchObject({ allow: true });
    });
  });
});
