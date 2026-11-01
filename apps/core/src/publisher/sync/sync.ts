import type { Fact } from '@agentdeck/contracts/core/facts';
import { readFact } from '../../lib/facts/read-fact.ts';
import { rebaseOnto, type RebaseResult } from '../../platform/git/commit-shape.ts';
import type { GitOptions } from '../../platform/git/git.types.ts';
import { mergeTree, type MergeTreeResult } from '../../platform/git/merge-tree.ts';
import type { PushRoute } from '../../platform/git/push.ts';
import { git } from '../../platform/git/run.ts';

/**
 * Синхронизация с базой сервера (05 §Push and MR, G14): база читается ОДИН раз за попытку
 * публикации, слияние проверяется `merge-tree` без рабочего дерева. Без конфликта ядро не
 * перебазирует никогда. Конфликт до MR — перебазировка ядром; остановилась — отмена и шаг правки
 * `resolve-conflict`. После MR — никакой перебазировки: конфликт решает шаг правки слиянием базы.
 */

export type SyncOutcome =
  | { kind: 'clean' }
  /** Ядро перебазировало ветку: дерево сменилось — финальная проверка заново. */
  | { kind: 'rebased'; head: string }
  | { kind: 'conflict'; files: string[] }
  | { kind: 'unknown'; reason: string };

export interface SyncDeps {
  mergeTree(base: string, head: string): Promise<Fact<MergeTreeResult>>;
  rebase(base: string): Promise<RebaseResult>;
}

export async function syncWithBase(
  deps: SyncDeps,
  input: { baseSha: string; head: string; mrExists: boolean },
): Promise<SyncOutcome> {
  const merged = await deps.mergeTree(input.baseSha, input.head);
  if (!('value' in merged)) {
    return { kind: 'unknown', reason: 'unknown' in merged ? merged.unknown : 'absent' };
  }
  if (merged.value.kind === 'clean') return { kind: 'clean' };
  if (input.mrExists) return { kind: 'conflict', files: merged.value.files };
  const rebased = await deps.rebase(input.baseSha);
  if (rebased.kind === 'stopped') return { kind: 'conflict', files: rebased.files };
  return { kind: 'rebased', head: rebased.head };
}

export function gitSyncDeps(repo: string, options: GitOptions = {}): SyncDeps {
  return {
    mergeTree: (base, head) => mergeTree(repo, base, head, options),
    rebase: (base) => rebaseOnto(repo, base, options),
  };
}

const OID = /^[0-9a-f]{40,64}$/;

/**
 * База на сервере — один `fetch` ветки базы по настоящему адресу (тем же маршрутом, что пуш:
 * доступ парами окружения, без имени remote). Объекты ложатся в репозиторий, sha — из FETCH_HEAD.
 */
export function fetchBase(
  repo: string,
  route: PushRoute,
  baseBranch: string,
  options: GitOptions = {},
): Promise<Fact<{ ref: string; sha: string }>> {
  return readFact('git.fetch-base', async () => {
    const names = new Set(route.dropEnv.map((d) => d.toUpperCase()));
    const env: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(options.env ?? process.env)) {
      if (!names.has(k.toUpperCase())) env[k] = v;
    }
    const ref = `refs/heads/${baseBranch}`;
    await git(repo, [...route.gitArgs, 'fetch', '--no-tags', '--', route.url, ref], {
      ...options,
      env,
      extraEnv: { ...route.env, GCM_INTERACTIVE: 'never' },
      timeoutMs: 60_000,
    });
    const head = await git(repo, ['rev-parse', '--verify', 'FETCH_HEAD^{commit}'], {
      ...options,
      timeoutMs: 15_000,
    });
    const sha = head.stdout.trim();
    if (!OID.test(sha)) throw new Error(`FETCH_HEAD garbage: ${sha.slice(0, 80)}`);
    return { ref, sha };
  });
}
