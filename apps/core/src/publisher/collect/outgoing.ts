import type { Fact } from '@agentdeck/contracts/core/facts';
import { envReadsIn, type OutgoingScanInput } from '@agentdeck/sieves';
import { readFact } from '../../lib/facts/read-fact.ts';
import { matchesGlob } from '../../lib/glob/glob.ts';
import type { GitOptions } from '../../platform/git/git.types.ts';
import { git } from '../../platform/git/run.ts';

/**
 * Вход сит исходящего (`@agentdeck/sieves scanOutgoing`) из git — ровно то дерево, что уйдёт
 * (`head`), против базы сервера (`base`): изменённые, добавленные и удалённые файлы, строки диффа,
 * файлы дерева, исключённые `.gitignore` добавленные, их размеры, упоминания имён окружения.
 * Не прочиталось — факт `unknown`: сита вслепую не судят (05 §Readiness).
 */

const call = (o: GitOptions, ms = 60_000) => ({ ...o, timeoutMs: ms });
const split0 = (s: string): string[] => s.split('\0').filter((x) => x !== '');

/** `--name-status -z`: `A\0path\0M\0path\0…` (переименования выключены). */
export function parseNameStatus(stdout: string): { status: string; path: string }[] {
  const parts = split0(stdout);
  const out: { status: string; path: string }[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    out.push({ status: parts[i]!.charAt(0), path: parts[i + 1]! });
  }
  return out;
}

/** `diff -U0`: строки `+`/`-` с файлом (`+++ b/<path>`), без заголовков. */
export function parseDiffLines(stdout: string): {
  additions: { path: string; text: string }[];
  removals: { path: string; text: string }[];
} {
  const additions: { path: string; text: string }[] = [];
  const removals: { path: string; text: string }[] = [];
  let path = '';
  let from = '';
  for (const line of stdout.split('\n')) {
    if (line.startsWith('--- ')) {
      from = line.startsWith('--- a/') ? line.slice(6) : '';
      continue;
    }
    if (line.startsWith('+++ ')) {
      path = line.startsWith('+++ b/') ? line.slice(6) : from;
      continue;
    }
    if (line.startsWith('diff --git ') || line.startsWith('@@')) continue;
    if (line.startsWith('+')) additions.push({ path, text: line.slice(1).replace(/\r$/, '') });
    else if (line.startsWith('-')) removals.push({ path, text: line.slice(1).replace(/\r$/, '') });
  }
  return { additions, removals };
}

/** `ls-tree -l -z`: `<mode> blob <sha> <size>\t<path>` → размер по пути. */
export function parseSizes(stdout: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const rec of split0(stdout)) {
    const tab = rec.indexOf('\t');
    const size = Number(rec.slice(0, tab).trim().split(/\s+/)[3]);
    if (tab > 0 && Number.isFinite(size)) out[rec.slice(tab + 1)] = size;
  }
  return out;
}

/**
 * Владение единицы: маски из `unit.created.ownedPaths`; пусто — не задано (`null`). Голая папка
 * (`src`, `src/`) — уже префикс у `matchesGlob` в режиме `rooted`.
 */
export function ownsOf(globs: readonly string[]): ((path: string) => boolean) | null {
  if (globs.length === 0) return null;
  return (path) => globs.some((g) => matchesGlob(path, g, false, 'rooted'));
}

export function collectOutgoing(
  repo: string,
  base: string,
  head: string,
  ownedPaths: readonly string[],
  options: GitOptions = {},
): Promise<Fact<OutgoingScanInput>> {
  return readFact('git.diff-unit', async () => {
    const names = await git(
      repo,
      ['diff', '--name-status', '-z', '--no-renames', base, head, '--'],
      call(options),
    );
    const rows = parseNameStatus(names.stdout);
    const added = rows.filter((r) => r.status === 'A').map((r) => r.path);
    const deleted = rows.filter((r) => r.status === 'D').map((r) => r.path);
    const changed = rows.map((r) => r.path);
    const diff = await git(
      repo,
      ['diff', '-U0', '--no-color', '--no-ext-diff', '--no-renames', base, head, '--'],
      call(options, 120_000),
    );
    const { additions, removals } = parseDiffLines(diff.stdout);
    const tree = await git(repo, ['ls-tree', '-r', '-z', '--name-only', head], call(options));
    const tracked = split0(tree.stdout);
    let ignored: string[] = [];
    let sizes: Record<string, number> = {};
    if (added.length > 0) {
      // `-z` у check-ignore только со `--stdin`; пути здесь — строки вывода, по одной на строку.
      const ig = await git(repo, ['check-ignore', '--no-index', '--', ...added], {
        ...call(options),
        acceptNonZero: true,
      });
      if (ig.code !== 0 && ig.code !== 1) throw new Error(`check-ignore exit ${String(ig.code)}`);
      ignored = ig.stdout
        .split('\n')
        .map((l) => l.replace(/\r$/, ''))
        .filter(Boolean);
      const ls = await git(repo, ['ls-tree', '-l', '-z', head, '--', ...added], call(options));
      sizes = parseSizes(ls.stdout);
    }
    const envMentions: Record<string, string[]> = {};
    for (const name of envReadsIn(additions)) {
      const found = await git(repo, ['grep', '-l', '-F', '-e', name, head, '--'], {
        ...call(options),
        acceptNonZero: true,
      });
      if (found.code !== 0 && found.code !== 1)
        throw new Error(`git grep exit ${String(found.code)}`);
      envMentions[name] = found.stdout
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => (l.startsWith(`${head}:`) ? l.slice(head.length + 1) : l));
    }
    return {
      changed,
      added,
      deleted,
      additions,
      removals,
      tracked,
      ignored,
      sizes,
      envMentions,
      owns: ownsOf(ownedPaths),
    };
  });
}
