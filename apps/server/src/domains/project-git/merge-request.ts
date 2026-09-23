import { existsSync } from 'node:fs';
import type { WorktreeMirrorReport, WorktreeMirrorSettings } from '@agentdeck/contracts';
import { git } from './exec.ts';
import { requireRepo } from './read.ts';
import { addWorktree, worktreeDirFor } from './worktrees.ts';

/**
 * Ветка MR/PR без форджа — у самого git (Д2, инцидент 23.09.2026).
 *
 * Без интеграции форджа панель ветку MR не знала вовсе, а ветку из блока агента
 * для MR не брала: копия вставала на `<ветка>-2`, отведённую от `main`, и
 * ребёнок правил код без правок MR. Но git знает всё сам: GitLab и GitHub
 * публикуют голову MR служебной ссылкой (`refs/merge-requests/<iid>/head`,
 * `refs/pull/<n>/head`), и ветка MR — та голова `refs/heads/*`, что указывает
 * на тот же коммит.
 */

/** Сетевой потолок одного `ls-remote`: разделение ждёт его, человек — тоже. */
const LS_REMOTE_TIMEOUT_MS = 30_000;

/** Служебная ссылка головы MR/PR по адресу; другой фордж — `undefined`. */
export function mergeRequestRef(url: string): string | undefined {
  const gitlab = /\/-\/merge_requests\/(\d+)(?:[/?#]|$)/.exec(url);
  if (gitlab) return `refs/merge-requests/${gitlab[1]}/head`;
  const github = /\/pull\/(\d+)(?:[/?#]|$)/.exec(url);
  if (github) return `refs/pull/${github[1]}/head`;
  return undefined;
}

/** `<sha>\t<ref>` построчно → ссылка → коммит. */
export function parseLsRemote(stdout: string): Map<string, string> {
  const refs = new Map<string, string>();
  for (const line of stdout.split(/\r?\n/)) {
    const [sha, ref] = line.trim().split(/\s+/);
    if (sha && ref) refs.set(ref, sha);
  }
  return refs;
}

/**
 * Имя ветки MR по снимку удалённого: голова MR → ветки на том же коммите.
 * Подсказки (ветка из блока агента) решают, когда таких веток несколько; без
 * подсказки ветка, совпавшая с HEAD удалённого (`main`), не берётся — это не
 * ветка MR, а MR без своих коммитов.
 */
export function pickMergeRequestBranch(
  refs: Map<string, string>,
  mrRef: string | undefined,
  hints: readonly string[],
): string | undefined {
  const heads = new Map<string, string>();
  for (const [ref, sha] of refs) {
    if (ref.startsWith('refs/heads/')) heads.set(ref.slice('refs/heads/'.length), sha);
  }
  const head = mrRef ? refs.get(mrRef) : undefined;
  if (head) {
    const same = [...heads].filter(([, sha]) => sha === head).map(([name]) => name);
    const hinted = hints.find((hint) => same.includes(hint));
    if (hinted) return hinted;
    const remoteHead = refs.get('HEAD');
    const own = same.filter((name) => heads.get(name) !== remoteHead || !remoteHead);
    if (own.length === 1) return own[0];
  }
  return hints.find((hint) => heads.has(hint));
}

/** Где искать ветку MR и какой она оказалась. */
export interface MergeRequestBranch {
  branch: string;
  /** Удалённый, откуда она взята; нет — ветка нашлась только локально. */
  remote?: string;
}

/**
 * Ветка MR у git: `ls-remote` головы MR и веток, затем `fetch` найденной, чтобы
 * копия встала на свежий `origin/<ветка>`, а не на устаревшую локальную ссылку.
 * Сеть недоступна — подсказка, если такая ветка уже известна локально. Ничего
 * не нашлось — `undefined`: придумывать ветку MR нельзя.
 */
export async function resolveMergeRequestBranch(
  projectDir: string,
  url: string,
  hints: readonly string[],
): Promise<MergeRequestBranch | undefined> {
  const info = await requireRepo(projectDir);
  const remote = info.remote;
  const wanted = [...new Set(hints.map((hint) => hint.trim()).filter(Boolean))];

  if (remote) {
    try {
      const mrRef = mergeRequestRef(url);
      const [headsOut, mrOut] = await Promise.all([
        git(projectDir, ['ls-remote', '--heads', remote], LS_REMOTE_TIMEOUT_MS),
        mrRef
          ? git(projectDir, ['ls-remote', remote, 'HEAD', mrRef], LS_REMOTE_TIMEOUT_MS).catch(
              () => '',
            )
          : Promise.resolve(''),
      ]);
      const refs = parseLsRemote(`${headsOut}\n${mrOut}`);
      const branch = pickMergeRequestBranch(refs, mrRef, wanted);
      if (branch) {
        await git(
          projectDir,
          ['fetch', remote, `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`],
          LS_REMOTE_TIMEOUT_MS,
        );
        return { branch, remote };
      }
      return undefined;
    } catch {
      // Сеть или доступ: ниже — то, что git уже знает сам.
    }
  }

  const known = wanted.find(
    (hint) => info.remoteBranches.includes(hint) || info.branches.includes(hint),
  );
  if (!known) return undefined;
  return info.remoteBranches.includes(known) && remote
    ? { branch: known, remote }
    : { branch: known };
}

/** Проверка ссылки/предка; ненулевой код git — `false`. */
async function gitTrue(projectDir: string, args: string[]): Promise<boolean> {
  try {
    await git(projectDir, args);
    return true;
  } catch {
    return false;
  }
}

/**
 * Копия на ветке MR. Суффикса `-2` здесь не бывает: другое имя — другая ветка,
 * то есть не код MR.
 *
 * - ветка занята другой копией (или основной) → копия в detached HEAD на
 *   `<remote>/<ветка>`: работать можно, отправлять — `push <remote> HEAD:<ветка>`;
 * - локальная ветка отстала от удалённой → перемотка вперёд (`branch -f` на
 *   ветке, которую никто не держит, — только fast-forward);
 * - локальная разошлась с удалённой → тоже detached на удалённой: чужие
 *   неотправленные коммиты не трогаем и на них не работаем;
 * - локальной нет → `worktree add` сам заведёт её с отслеживанием.
 */
export async function addMergeRequestWorktree(
  projectDir: string,
  target: MergeRequestBranch,
  mirror?: WorktreeMirrorSettings,
  claudeJsonPath?: string,
): Promise<{ path: string; output: string; mirror?: WorktreeMirrorReport; detached: boolean }> {
  const { branch, remote } = target;
  const list = (await git(projectDir, ['worktree', 'list', '--porcelain'])).split(/\r?\n/);
  const main = list
    .find((line) => line.startsWith('worktree '))
    ?.slice('worktree '.length)
    .trim();
  const busy = list.includes(`branch refs/heads/${branch}`);
  const remoteRef =
    remote &&
    (await gitTrue(projectDir, [
      'rev-parse',
      '--verify',
      '--quiet',
      `refs/remotes/${remote}/${branch}`,
    ]))
      ? `${remote}/${branch}`
      : undefined;
  const local = await gitTrue(projectDir, [
    'rev-parse',
    '--verify',
    '--quiet',
    `refs/heads/${branch}`,
  ]);

  let detachAt: string | undefined;
  if (busy) detachAt = remoteRef ?? branch;
  else if (local && remoteRef) {
    if (await gitTrue(projectDir, ['merge-base', '--is-ancestor', branch, remoteRef])) {
      await git(projectDir, ['branch', '-f', branch, remoteRef]);
    } else if (!(await gitTrue(projectDir, ['merge-base', '--is-ancestor', remoteRef, branch]))) {
      detachAt = remoteRef;
    }
  }

  if (!detachAt) {
    const created = await addWorktree(projectDir, branch, mirror, undefined, claudeJsonPath);
    return { ...created, detached: false };
  }

  let dirName = `${branch}-mr`;
  for (let index = 2; main && existsSync(worktreeDirFor(main, dirName)); index += 1) {
    dirName = `${branch}-mr-${index}`;
  }
  const created = await addWorktree(projectDir, branch, mirror, undefined, claudeJsonPath, {
    detachAt,
    dirName,
  });
  return { ...created, detached: true };
}
