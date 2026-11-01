import type { Fact } from '@agentdeck/contracts/core/facts';
import { readClass, readFact } from '../../lib/facts/read-fact.ts';
import type { GitOptions } from './git.types.ts';
import { git } from './run.ts';

/**
 * Конфиг git по слоям (класс `git.worktree-config`): общий файл репозитория, покопийный
 * `config.worktree` и действующее значение со всеми слоями. Закрытие пуша пишет только покопийный
 * слой и один ключ общего (`extensions.worktreeConfig`, G6); сверка дрейфа читает те же слои.
 *
 * Код выхода 1 у `git config --get*` — «ключа нет», это ответ, а не сбой.
 */

/** Слой: `worktree` — `config.worktree` копии, `file` — названный файл, `effective` — все слои. */
export type ConfigScope = 'worktree' | 'effective' | 'global' | 'system' | { file: string };

function scopeArgs(scope: ConfigScope): string[] {
  if (scope === 'effective') return [];
  return typeof scope === 'string' ? [`--${scope}`] : ['--file', scope.file];
}

/** Все значения ключа в слое; нет ключа — пустой список. */
export function configValues(
  repo: string,
  key: string,
  scope: ConfigScope,
  options: GitOptions = {},
): Promise<Fact<string[]>> {
  return readFact('git.worktree-config', async () => {
    const out = await git(repo, ['config', ...scopeArgs(scope), '--get-all', key], {
      ...options,
      timeoutMs: readClass('git.worktree-config').timeoutMs,
      acceptNonZero: true,
    });
    if (out.code === 1) return [];
    if (out.code !== 0) throw new Error(`git config --get-all ${key}: exit ${out.code}`);
    return out.stdout.split('\n').filter((line) => line !== '');
  });
}

/**
 * Ключи слоя по регулярному выражению git (`^alias\.`, `^remote\..*\.pushurl$`) → ключ → значения.
 * Разделитель NUL (`-z`): значение алиаса бывает многострочным.
 */
export function configMatching(
  repo: string,
  pattern: string,
  scope: ConfigScope,
  options: GitOptions = {},
): Promise<Fact<Record<string, string[]>>> {
  return readFact('git.worktree-config', async () => {
    const out = await git(repo, ['config', ...scopeArgs(scope), '-z', '--get-regexp', pattern], {
      ...options,
      timeoutMs: readClass('git.worktree-config').timeoutMs,
      acceptNonZero: true,
    });
    if (out.code === 1) return {};
    if (out.code !== 0) throw new Error(`git config --get-regexp ${pattern}: exit ${out.code}`);
    const found: Record<string, string[]> = {};
    for (const entry of out.stdout.split('\0')) {
      if (entry === '') continue;
      const cut = entry.indexOf('\n');
      const key = cut === -1 ? entry : entry.slice(0, cut);
      const value = cut === -1 ? '' : entry.slice(cut + 1);
      (found[key] ??= []).push(value);
    }
    return found;
  });
}

/** Записать ключ в слой, заменив все прежние значения слоя (`--replace-all`). */
export async function configSet(
  repo: string,
  key: string,
  value: string,
  scope: Exclude<ConfigScope, 'effective'>,
  options: GitOptions = {},
): Promise<void> {
  await git(repo, ['config', ...scopeArgs(scope), '--replace-all', key, value], {
    ...options,
    timeoutMs: readClass('git.worktree-config').timeoutMs,
  });
}

/** Имена удалённых репозитория (`git remote`). */
export function remotesOfCopy(repo: string, options: GitOptions = {}): Promise<Fact<string[]>> {
  return readFact('git.worktree-config', async () => {
    const out = await git(repo, ['remote'], {
      ...options,
      timeoutMs: readClass('git.worktree-config').timeoutMs,
    });
    return out.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  });
}
