import type { Fact } from '@agentdeck/contracts/core/facts';
import type { CheckEntry, CheckRegistry } from '@agentdeck/contracts/core/records';
import { inputDigests, treeRows, type GitOptions, type TreeRev } from '../../platform/git.ts';
import { hmac } from './canonical.ts';
import { inputPatterns, keyOf } from './key.ts';
import type { KeyContext, KeyOf } from './key.types.ts';

/** Ключевой хеш значений окружения ключом дома ядра: перебором короткий секрет не подобрать. */
export function envDigester(key: Uint8Array): (value: string) => string {
  return (value) => hmac(key, value);
}

export interface KeyReadInput {
  repo: string;
  entry: CheckEntry;
  registry: CheckRegistry;
  unit: string;
  selection: string[];
  /** `'worktree'` — рабочая копия; иначе ревизия уходящего содержимого. */
  rev: TreeRev;
  /** База на сервере (G2) для проверок, зависящих от базы; `null` — не дана (ключ `unknown`). */
  baseRev: string | null;
  tools: Record<string, string>;
  env: KeyContext['env'];
  envDigest: KeyContext['envDigest'];
  git?: GitOptions;
}

/** Все чтения ключа одной единицы через платформу, затем чистый `keyOf`. */
export async function readKey(input: KeyReadInput): Promise<Fact<KeyOf>> {
  const [rows, baseRows, inputs] = await Promise.all([
    treeRows(input.repo, input.rev, input.git),
    input.entry.baseDependent
      ? input.baseRev === null
        ? Promise.resolve<Fact<never>>({ unknown: 'no base revision' })
        : treeRows(input.repo, input.baseRev, input.git)
      : Promise.resolve(null),
    inputDigests(input.repo, inputPatterns(input.entry, input.registry, input.unit)),
  ]);
  return keyOf(input.entry, input.unit, {
    registry: input.registry,
    rows,
    baseRows,
    selection: input.selection,
    inputs,
    tools: input.tools,
    env: input.env,
    envDigest: input.envDigest,
  });
}
