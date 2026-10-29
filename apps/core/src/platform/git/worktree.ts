import { readdirSync } from 'node:fs';
import { reasonOf } from '../os-kind.ts';
import type { GitOptions, WorktreeAdd } from './git.types.ts';
import { withNoHooks } from './no-hooks.ts';
import { git } from './run.ts';

/**
 * Отделённая копия ревизии (прогон на базе, 04:68): `git worktree add --detach`. Хуки проекта
 * при этом не идут — каталог хуков подменён свежим пустым (`withNoHooks`): post-checkout чужого проекта в копии
 * ядра — не наша проверка и не наш побочный эффект (хуки проекта идут на наших commit/push, 04:133).
 * Снятие — `releaseWorktree` (`resource-release.ts`) с чтением назад.
 */
/**
 * Каталог уже занят до `worktree add` (прежняя копия, чужие файлы): add на нём падает, и уборка
 * после сбоя обязана его не трогать — `worktree remove --force` снёс бы прежнюю копию с её
 * незакоммиченной работой. Пустой каталог занятым не считается: его выкладку git ведёт сам.
 */
export function dirOccupied(dir: string): boolean {
  try {
    return readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}

/**
 * Окружение `worktree add`: замок `initializing`, по которому копия признаётся недовыложенной
 * (`copyState`), git пишет переведённым словом (`_("initializing")`) — под русской локалью он был
 * бы «инициализация», и полкопии после краха читалась бы целой. Локаль C — слово всегда одно.
 */
export const C_LOCALE: Readonly<Record<string, string>> = { LC_ALL: 'C', LANGUAGE: 'C' };

/**
 * Снять выложенное этой попыткой: двойной `-f` — git, убитый посреди выкладки (таймаут), оставляет
 * дерево запертым `initializing`, а запертое одиночный `--force` не снимает, и `prune` его обходит.
 * Зовётся только для каталога, которого до попытки не было (`dirOccupied`).
 */
export async function dropAddedWorktree(
  repo: string,
  dir: string,
  options: GitOptions,
  timeoutMs: number,
): Promise<void> {
  const call = { ...options, timeoutMs, acceptNonZero: true };
  // Уборка — вежливость: наверх уходит ПЕРВАЯ причина, а не сбой уборки.
  await git(repo, ['worktree', 'remove', '-f', '-f', dir], call).catch(() => undefined);
  await git(repo, ['worktree', 'prune'], call).catch(() => undefined);
}

export async function addDetachedWorktree(
  repo: string,
  dir: string,
  rev: string,
  options: GitOptions = {},
): Promise<WorktreeAdd> {
  const occupied = dirOccupied(dir);
  try {
    await withNoHooks((hooks) =>
      git(repo, [...hooks, 'worktree', 'add', '--detach', '--quiet', dir, rev], {
        ...options,
        timeoutMs: 120_000,
        extraEnv: C_LOCALE,
      }),
    );
    const head = await git(dir, ['rev-parse', '--verify', 'HEAD'], {
      ...options,
      timeoutMs: 15_000,
    });
    return { created: dir, head: head.stdout.trim() };
  } catch (error) {
    if (occupied) return { failed: reasonOf(error) };
    // Сбой после начала выкладки (таймаут, HEAD не читается) — копия и её регистрация не
    // остаются висеть без хозяина (P40), как у копии задачи (copy-git `undoFailedAdd`).
    await dropAddedWorktree(repo, dir, options, 30_000);
    return { failed: reasonOf(error) };
  }
}
