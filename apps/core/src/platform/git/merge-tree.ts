import type { Fact } from '@agentdeck/contracts/core/facts';
import { readFact } from '../../lib/facts/read-fact.ts';
import type { GitOptions } from './git.types.ts';
import { git } from './run.ts';

/**
 * Слияние без рабочего дерева (класс `git.merge-tree`, 05 §Push and MR): `git merge-tree
 * --write-tree` (git ≥ 2.38) отвечает, сольётся ли ветка с базой, ничего не трогая. Код 0 —
 * чисто, 1 — конфликт с перечнем файлов, иное — сбой (`unknown`: «не смог проверить» ≠ «чисто»).
 */

export const MERGE_TREE_MIN_GIT = '2.38.0';

export type MergeTreeResult =
  { kind: 'clean'; tree: string } | { kind: 'conflict'; tree: string; files: string[] };

const OID = /^[0-9a-f]{40,64}$/;

export function parseMergeTree(code: number | null, stdout: string): MergeTreeResult {
  const lines = stdout.split('\n').map((l) => l.trimEnd());
  const tree = lines[0]?.trim() ?? '';
  if (!OID.test(tree)) throw new Error(`merge-tree garbage: ${tree.slice(0, 80)}`);
  if (code === 0) return { kind: 'clean', tree };
  if (code !== 1) throw new Error(`merge-tree exit ${String(code)}`);
  // `--name-only --no-messages`: после id дерева — файлы с конфликтом, до пустой строки.
  const files: string[] = [];
  for (const line of lines.slice(1)) {
    if (line === '') break;
    if (!files.includes(line)) files.push(line);
  }
  return { kind: 'conflict', tree, files };
}

export function mergeTree(
  repo: string,
  base: string,
  head: string,
  options: GitOptions = {},
): Promise<Fact<MergeTreeResult>> {
  return readFact('git.merge-tree', async () => {
    const out = await git(
      repo,
      ['merge-tree', '--write-tree', '--name-only', '--no-messages', base, head],
      { ...options, timeoutMs: 60_000, acceptNonZero: true },
    );
    return parseMergeTree(out.code, out.stdout);
  });
}

/** `git version 2.55.0.windows.3` → [2, 55, 0]; не разобрать — null. */
export function gitVersionOf(text: string): [number, number, number] | null {
  const m = text.match(/git version (\d+)\.(\d+)(?:\.(\d+))?/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : null;
}

/** Версия не ниже `min` (`2.38.0`). */
export function versionAtLeast(have: readonly number[], min: string): boolean {
  const want = min.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    const a = have[i] ?? 0;
    const b = want[i] ?? 0;
    if (a !== b) return a > b;
  }
  return true;
}
