import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  collectOutgoing,
  ownsOf,
  parseDiffLines,
  parseNameStatus,
  parseSizes,
} from './outgoing.ts';

/**
 * Вход сит исходящего читается из настоящего git временного репозитория: ровно дерево головы
 * против базы — добавленные, удалённые, изменённые, строки диффа, файлы дерева, добавленные
 * силой мимо `.gitignore`, их размеры, упоминания имён окружения. Нечитаемая база — `unknown`.
 */

const root = mkdtempSync(join(tmpdir(), 'agentdeck-core-outgoing-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const ID = ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false'];
const g = (...args: string[]): string =>
  execFileSync('git', [...ID, ...args], { cwd: root, encoding: 'utf8' }).trim();

execFileSync('git', ['init', '-q', '-b', 'main', root]);
mkdirSync(join(root, 'src'));
writeFileSync(join(root, '.gitignore'), 'secret.env\n');
writeFileSync(join(root, 'src', 'app.ts'), 'export const a = 1;\n');
writeFileSync(join(root, 'old.txt'), 'gone\n');
g('add', '-A');
g('commit', '-qm', 'base');
const base = g('rev-parse', 'HEAD');
writeFileSync(
  join(root, 'src', 'app.ts'),
  'export const a = 2;\nexport const t = process.env.FOO_TOKEN;\n',
);
writeFileSync(join(root, 'docs.md'), 'Set FOO_TOKEN before start.\n');
writeFileSync(join(root, 'secret.env'), 'X=1\n');
g('rm', '-q', 'old.txt');
g('add', '-A');
g('add', '-f', 'secret.env');
g('commit', '-qm', 'head');
const head = g('rev-parse', 'HEAD');
// Рабочее дерево после коммита грязное: уходит дерево головы, не рабочие файлы.
writeFileSync(join(root, 'docs.md'), 'uncommitted WORKTREE_ONLY change\n');
writeFileSync(join(root, 'stray.txt'), 'never committed\n');
rmSync(join(root, 'secret.env'));

describe('publisher collect outgoing', () => {
  it('reads exactly the outgoing tree against the base: rows, lines, forced-ignored files, sizes, env mentions', async () => {
    const got = await collectOutgoing(root, base, head, ['src']);
    if (!('value' in got)) throw new Error(`outgoing unreadable: ${JSON.stringify(got)}`);
    const v = got.value;
    expect([...v.added].sort()).toEqual(['docs.md', 'secret.env']);
    expect(v.deleted).toEqual(['old.txt']);
    expect([...v.changed].sort()).toEqual(['docs.md', 'old.txt', 'secret.env', 'src/app.ts']);
    expect(v.additions).toContainEqual({
      path: 'src/app.ts',
      text: 'export const t = process.env.FOO_TOKEN;',
    });
    expect(v.removals).toContainEqual({ path: 'src/app.ts', text: 'export const a = 1;' });
    expect(v.removals).toContainEqual({ path: 'old.txt', text: 'gone' });
    expect([...v.tracked].sort()).toEqual(['.gitignore', 'docs.md', 'secret.env', 'src/app.ts']);
    expect(v.ignored).toEqual(['secret.env']);
    expect(v.sizes).toEqual({ 'docs.md': 28, 'secret.env': 4 });
    expect([...(v.envMentions['FOO_TOKEN'] ?? [])].sort()).toEqual(['docs.md', 'src/app.ts']);
    expect(v.owns?.('src/app.ts')).toBe(true);
    expect(v.owns?.('docs.md')).toBe(false);
    // Папка — граница сегмента, не префикс строки.
    expect(v.owns?.('srcx/a.ts')).toBe(false);
  });

  it('an unreadable base is unknown, never an empty diff', async () => {
    const got = await collectOutgoing(root, 'no-such-ref', head, []);
    expect(got).toMatchObject({ unknown: expect.any(String) });
  });

  it('parsers: NUL-separated name-status, -U0 lines by file, ls-tree sizes; no globs owns nothing', () => {
    expect(parseNameStatus('A\0a b\0D\0c\0M\0d\0')).toEqual([
      { status: 'A', path: 'a b' },
      { status: 'D', path: 'c' },
      { status: 'M', path: 'd' },
    ]);
    const diff = [
      'diff --git a/x b/x',
      '--- a/x',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-bye\r',
      'diff --git a/y b/y',
      '--- /dev/null',
      '+++ b/y',
      '@@ -0,0 +1 @@',
      '+hi',
    ].join('\n');
    expect(parseDiffLines(diff)).toEqual({
      additions: [{ path: 'y', text: 'hi' }],
      removals: [{ path: 'x', text: 'bye' }],
    });
    expect(parseSizes('100644 blob abc     12\ta.txt\x00100644 blob def 7\tb c\x00')).toEqual({
      'a.txt': 12,
      'b c': 7,
    });
    expect(ownsOf([])).toBeNull();
  });
});
