import { join } from 'node:path';
import type { Fact } from '@agentdeck/contracts/core/facts';
import { pinnedBaseOf, unitCopyOf, unitRepoOf } from '../../conductor/copy/journal-view.ts';
import type { LiveTask } from '../../journal/resume.ts';
import { commonDir } from '../../platform/git/common-dir.ts';
import type { GitOptions } from '../../platform/git/git.types.ts';
import { configMatching, remotesOfCopy } from '../../platform/git/worktree-config.ts';

/**
 * Что публикатор знает о единице — только из журнала и git (после перезапуска памяти нет):
 * копия, ветка, закреплённая база, исходный репозиторий, удалённый базы и НАСТОЯЩИЙ адрес пуша.
 * Адрес — из ОБЩЕГО конфига (`<common>/config`): в копии `pushurl` закрыт стражем (G), а
 * `remote.<r>.pushurl` многозначен — берётся первый, без доступа в адресе.
 */

export interface UnitView {
  unitId: string;
  repoKey: string;
  copyDir: string;
  branch: string;
  sourceRepo: string;
  /** sha базы, от которой встала копия; нет записи — ревизия `baseRef`. */
  base: string;
  remote: string;
  /** Ветка базы на сервере (`origin/main` → `main`). */
  baseBranch: string;
  url: string;
  ownedPaths: string[];
}

/** `origin/main` при удалённом `origin` → (`origin`, `main`); `main` → первый удалённый. */
export function serverBaseOf(
  baseRef: string,
  remotes: readonly string[],
): { remote: string; branch: string } | null {
  const ref = baseRef.replace(/^refs\/remotes\//, '').replace(/^refs\/heads\//, '');
  for (const r of remotes) {
    if (ref.startsWith(`${r}/`)) return { remote: r, branch: ref.slice(r.length + 1) };
  }
  const remote = remotes.includes('origin') ? 'origin' : remotes[0];
  return remote ? { remote, branch: ref } : null;
}

const why = (f: Fact<unknown>): string => ('unknown' in f ? f.unknown : 'absent');

/** Удалённый, ветка базы на нём и НАСТОЯЩИЙ адрес пуша — для копии единицы или основной папки. */
export interface RepoServer {
  remote: string;
  branch: string;
  url: string;
}

/**
 * Сервер репозитория по ссылке базы: удалённый (`serverBaseOf`) и адрес пуша из ОБЩЕГО конфига
 * (`pushurl`, иначе `url`; первое значение). `dir` — копия или основная папка: общий конфиг один.
 */
export async function repoServerOf(
  dir: string,
  ref: string,
  git: GitOptions = {},
): Promise<{ value: RepoServer } | { unknown: string }> {
  const remotes = await remotesOfCopy(dir, git);
  if (!('value' in remotes)) return { unknown: `remotes: ${why(remotes)}` };
  const server = serverBaseOf(ref, remotes.value);
  if (!server) return { unknown: `no remote to publish to` };
  const url = await pushUrlOf(dir, server.remote, git);
  if (!('value' in url)) return url;
  return { value: { ...server, url: url.value } };
}

const ereEscape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * НАСТОЯЩИЙ адрес пуша удалённого из ОБЩЕГО конфига: `pushurl`, иначе `url`, первое значение.
 * Оба ключа — одним `git config --get-regexp`, а не процессом на ключ: адрес читают публикация,
 * clean-remote и каждый круг опроса форжа, а процесс git на Windows под нагрузкой стоит ~130 мс
 * (опрос с двумя MR не укладывался в 20 с проверки). `--get-regexp` сверяет имя с ключом, где
 * секция и переменная в нижнем регистре, а имя удалённого как есть — ровно ключ ниже.
 */
export async function pushUrlOf(
  dir: string,
  remote: string,
  git: GitOptions = {},
): Promise<{ value: string } | { unknown: string }> {
  const common = await commonDir(dir, git);
  if (!('value' in common)) return { unknown: `git common dir: ${why(common)}` };
  const got = await configMatching(
    dir,
    `^remote\\.${ereEscape(remote)}\\.(pushurl|url)$`,
    { file: join(common.value, 'config') },
    git,
  );
  if (!('value' in got)) return { unknown: `remote.${remote}.pushurl/url: ${why(got)}` };
  const url = got.value[`remote.${remote}.pushurl`]?.[0] || got.value[`remote.${remote}.url`]?.[0];
  return url ? { value: url } : { unknown: `remote ${remote} has no url` };
}

export async function unitViewOf(
  task: LiveTask,
  unitId: string,
  git: GitOptions = {},
): Promise<{ value: UnitView } | { unknown: string }> {
  const repo = unitRepoOf(task, unitId);
  if ('missing' in repo) return { unknown: repo.missing };
  const copy = unitCopyOf(task, unitId);
  if (!copy) return { unknown: `unit ${unitId} has no live copy` };
  // Ветка базы — из ссылки приколотой базы (`origin/main`); `baseRef` задачи из оценки — только
  // sha, и ветка «<sha>» на сервере не нашлась бы никогда (ни fetch базы, ни цель MR).
  const server = await repoServerOf(copy.dir, repo.pinnedRef ?? repo.baseRef, git);
  if (!('value' in server)) return { unknown: `repository ${repo.repoKey}: ${server.unknown}` };
  return {
    value: {
      unitId,
      repoKey: repo.repoKey,
      copyDir: copy.dir,
      branch: repo.branch,
      sourceRepo: repo.path,
      base: pinnedBaseOf(task, unitId) ?? repo.baseRef,
      remote: server.value.remote,
      baseBranch: server.value.branch,
      url: server.value.url,
      ownedPaths: task.state.units[unitId]?.ownedPaths ?? [],
    },
  };
}
