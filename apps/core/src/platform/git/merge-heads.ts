import type { Fact } from '@agentdeck/contracts/core/facts';
import { readFact } from '../../lib/facts/read-fact.ts';
import type { GitOptions } from './git.types.ts';
import { parseMergeTree } from './merge-tree.ts';
import { git } from './run.ts';

/**
 * Слияние голов единиц в один коммит (этап 11, W3-18b, единица интеграции): `merge-tree
 * --write-tree` попарно слева направо, каждый чистый шаг — коммит `commit-tree` с обоими
 * родителями. Только объекты: ни ветки, ни рабочего дерева, ни пуша — коммит живёт в базе
 * объектов репозитория задачи и становится основой копии интеграции. Личность и время коммита
 * постоянные: те же головы дают тот же sha (повтор после краха не плодит второй коммит).
 */

export type MergeHeadsResult =
  | { kind: 'clean'; commit: string }
  | { kind: 'conflict'; files: string[]; between: [string, string] };

const OID = /^[0-9a-f]{40,64}$/;

const IDENTITY = {
  GIT_AUTHOR_NAME: 'agentdeck core',
  GIT_AUTHOR_EMAIL: 'core@agentdeck.invalid',
  GIT_AUTHOR_DATE: '@0 +0000',
  GIT_COMMITTER_NAME: 'agentdeck core',
  GIT_COMMITTER_EMAIL: 'core@agentdeck.invalid',
  GIT_COMMITTER_DATE: '@0 +0000',
};

export function mergeHeads(
  repo: string,
  heads: readonly string[],
  options: GitOptions = {},
): Promise<Fact<MergeHeadsResult>> {
  return readFact('git.merge-tree', async () => {
    const [first, ...rest] = heads;
    if (first === undefined) throw new Error('merge-heads: no heads');
    let acc = first;
    for (const head of rest) {
      const out = await git(
        repo,
        ['merge-tree', '--write-tree', '--name-only', '--no-messages', acc, head],
        { ...options, timeoutMs: 60_000, acceptNonZero: true },
      );
      const merged = parseMergeTree(out.code, out.stdout);
      if (merged.kind === 'conflict')
        return { kind: 'conflict', files: merged.files, between: [acc, head] };
      const made = await git(
        repo,
        [
          'commit-tree',
          merged.tree,
          '-p',
          acc,
          '-p',
          head,
          '-m',
          'agentdeck: integration of unit heads',
        ],
        { ...options, timeoutMs: 30_000, extraEnv: IDENTITY },
      );
      acc = made.stdout.trim();
      if (!OID.test(acc)) throw new Error(`commit-tree garbage: ${acc.slice(0, 80)}`);
    }
    return { kind: 'clean', commit: acc };
  });
}
