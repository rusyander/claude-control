import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * Сверка конфликта ветки группы с целевой — то, на чём держится «догон и
 * перезапись ветки только при конфликте» (решение владельца 23.10).
 *
 * Ошибка здесь дорогая в обе стороны: «конфликта нет» при настоящем конфликте
 * запрещает группе его снять (группа #0 23.10: `merge-tree --quiet` дал код 0
 * при семи конфликтах, 2,7 ч доставки и провал), «конфликт есть» без него
 * пускает rebase без нужды. Поэтому:
 * - `merge-tree --write-tree` БЕЗ `--quiet`: код и перечень CONFLICT читаются
 *   вместе, их расхождение — «не знаем», а не ответ;
 * - ошибка git (код >1, повреждённое хранилище) — пробное слияние в
 *   одноразовой рабочей копии; не вышло и оно — `undefined`, никогда не `false`.
 */

export interface GitResult {
  /** Код выхода; `undefined` — процесс не запустился или убит по таймауту. */
  code: number | undefined;
  stdout: string;
}

export type GitRunner = (cwd: string, args: string[], timeoutMs: number) => Promise<GitResult>;

export const runGit: GitRunner = async (cwd, args, timeoutMs) => {
  const { execFile } = await import('node:child_process');
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      { cwd, timeout: timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout) => {
        const out = String(stdout ?? '');
        if (!error) return resolve({ code: 0, stdout: out });
        const code = (error as { code?: unknown }).code;
        resolve({ code: typeof code === 'number' ? code : undefined, stdout: out });
      },
    );
  });
};

const CONFLICT_LINE = /^CONFLICT \(/m;
const TREE_OID = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/**
 * Ответ `merge-tree --write-tree` — или `undefined`, если ему нельзя верить.
 * Код 1 — конфликт, только когда вывод того же вида: дерево первой строкой и
 * перечень CONFLICT (F-121). Иначе код 1 без перечня — «не знаем»: решит пробное
 * слияние, а не догадка «есть конфликт», что пустила бы перезапись ветки.
 */
export function readMergeTree(result: GitResult): boolean | undefined {
  const conflictListed = CONFLICT_LINE.test(result.stdout);
  const first = result.stdout.split(/\r?\n/, 1)[0]?.trim() ?? '';
  const tree = TREE_OID.test(first);
  if (result.code === 1) return tree && conflictListed ? true : undefined;
  if (result.code === 0 && !conflictListed && tree) return false;
  return undefined;
}

/**
 * Хуки копии не запускаются от имени панели (F-118): `core.hooksPath` — на
 * каталог, которого нет, `core.fsmonitor` выключен. Пробное слияние идёт в
 * копии, чьи `.git/hooks` и настройки пишет агент.
 */
function noHooks(dir: string): string[] {
  return ['-c', `core.hooksPath=${path.join(dir, 'no-hooks')}`, '-c', 'core.fsmonitor=false'];
}

/**
 * Пробное слияние: одноразовая отсоединённая копия от `ours`, `merge --no-commit`
 * в неё, перечень неслитых файлов. Копия и её запись убираются всегда.
 */
async function trialMerge(
  cwd: string,
  ours: string,
  ref: string,
  run: GitRunner,
): Promise<boolean | undefined> {
  const dir = await mkdtemp(path.join(tmpdir(), 'agentdeck-trial-merge-'));
  const copy = path.join(dir, 'wt');
  try {
    const added = await run(
      cwd,
      [...noHooks(dir), 'worktree', 'add', '--detach', '-q', copy, ours],
      120_000,
    );
    if (added.code !== 0) return undefined;
    const merged = await run(
      copy,
      [
        ...noHooks(dir),
        '-c',
        'user.name=agentdeck',
        '-c',
        'user.email=agentdeck@localhost',
        'merge',
        '--no-commit',
        '--no-ff',
        '-q',
        ref,
      ],
      120_000,
    );
    // `diff` и уборка копии — тоже без хуков и fsmonitor копии (F-118, RF-BGCD-12a):
    // `core.fsmonitor` из настроек агента — программа, которую git запустил бы на чтении индекса.
    const unmerged = await run(
      copy,
      [...noHooks(dir), 'diff', '--name-only', '--diff-filter=U'],
      20_000,
    );
    if (unmerged.code === 0 && unmerged.stdout.trim() !== '') return true;
    if (merged.code === 0 && unmerged.code === 0) return false;
    return undefined;
  } finally {
    await run(cwd, [...noHooks(dir), 'worktree', 'remove', '--force', copy], 60_000);
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    await run(cwd, [...noHooks(dir), 'worktree', 'prune'], 20_000);
  }
}

/**
 * Конфликтуют ли `ours` и `ref`. `undefined` — сверить не вышло (ссылки нет,
 * git и пробное слияние не ответили): решать вслепую нельзя.
 */
export async function conflictsBetween(
  cwd: string,
  ours: string,
  ref: string,
  run: GitRunner = runGit,
): Promise<boolean | undefined> {
  // Неизвестная ссылка у merge-tree — тоже код 1, как конфликт: сначала проверяем,
  // что обе есть, иначе догон по опечатке прошёл бы как «есть конфликт».
  for (const name of [ours, ref]) {
    const verified = await run(
      cwd,
      ['rev-parse', '--verify', '--quiet', `${name}^{commit}`],
      20_000,
    );
    if (verified.code !== 0) return undefined;
  }
  const tree = await run(cwd, ['merge-tree', '--write-tree', ours, ref], 60_000);
  const answer = readMergeTree(tree);
  if (answer !== undefined) return answer;
  console.warn(
    `main-sync: merge-tree ${ours} ${ref} unreadable (exit ${String(tree.code)}), trial merge`,
  );
  return trialMerge(cwd, ours, ref, run).catch(() => undefined);
}

/**
 * Конфликт ветки MR с целевой — по тому, что лежит на сервере, а не по
 * `origin/*` копии (F-31): ссылки удалённых веток агент пишет сам
 * (`git update-ref refs/remotes/origin/main <что угодно>`) и так «находил»
 * конфликт, открывающий перезапись ветки на ревью. Вершины берутся у сервера
 * (`ls-remote`), недостающие коммиты дотягиваются без записи ссылок, сверка —
 * по хэшам. Сервер не ответил или ветки нет — `undefined`.
 */
export async function remoteConflicts(
  cwd: string,
  own: string,
  target: string,
  run: GitRunner = runGit,
): Promise<boolean | undefined> {
  const heads = [own, target].map((name) => `refs/heads/${name}`);
  const tips = await serverTips(cwd, 'origin', heads, run);
  const shas = heads.map((ref) => tips?.get(ref));
  if (shas.some((sha) => sha === undefined)) return undefined;
  return conflictsBetween(cwd, shas[0] as string, shas[1] as string, run);
}

const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const SAFE_REMOTE = /^[A-Za-z0-9][\w.-]*$/;

/**
 * Вершины веток `refs` на сервере `remote` (`ls-remote`), с коммитами в копии:
 * недостающие дотягиваются без записи ссылок. Ветки нет или её коммит не пришёл —
 * её нет и в ответе; сервер не ответил — `undefined`.
 */
async function serverTips(
  cwd: string,
  remote: string,
  refs: string[],
  run: GitRunner,
): Promise<Map<string, string> | undefined> {
  // Имя удалённого из команды агента: `--upload-pack=…` вместо имени — не имя.
  if (!SAFE_REMOTE.test(remote) || refs.length === 0) return undefined;
  const listed = await run(cwd, ['ls-remote', '--quiet', remote, ...refs], 30_000);
  if (listed.code !== 0) return undefined;
  const tips = new Map<string, string>();
  for (const line of listed.stdout.split(/\r?\n/)) {
    const [sha, ref] = line.trim().split(/\s+/);
    if (sha && ref && refs.includes(ref) && SHA.test(sha)) tips.set(ref, sha);
  }
  const present = async (sha: string): Promise<boolean> =>
    (await run(cwd, ['cat-file', '-e', `${sha}^{commit}`], 10_000)).code === 0;
  const absent: string[] = [];
  for (const [ref, sha] of tips) if (!(await present(sha))) absent.push(ref);
  if (absent.length > 0) {
    // Без назначения: объекты приходят, ни одна ссылка копии не меняется.
    await run(
      cwd,
      [
        '-c',
        'core.hooksPath=/nonexistent/agentdeck-no-hooks',
        '-c',
        'core.fsmonitor=false',
        'fetch',
        '--quiet',
        '--no-tags',
        '--no-write-fetch-head',
        // Пустая карта: без неё git попутно двигает `origin/*` названных веток.
        '--refmap=',
        remote,
        ...absent,
      ],
      120_000,
    );
    for (const ref of absent) if (!(await present(tips.get(ref) as string))) tips.delete(ref);
  }
  return tips;
}

/**
 * `origin/main`, `refs/remotes/upstream/dev`, голое `main` — удалённое и ветка; хэш — нет.
 * Удалённое — только `origin` и `upstream`: своё (`git remote add x ../подделка`) агент
 * заводит сам, его сервер — не правда о целевой ветке; такая ссылка — «не знаем».
 */
function remoteBranch(ref: string): { remote: string; branch: string } | undefined | null {
  const full = /^refs\/remotes\/([^/]+)\/(.+)$/.exec(ref) ?? /^(origin|upstream)\/(.+)$/.exec(ref);
  if (full) {
    const remote = full[1] as string;
    return remote === 'origin' || remote === 'upstream'
      ? { remote, branch: full[2] as string }
      : null;
  }
  if (/^(main|master|develop|dev|trunk|release(\/.*)?)$/i.test(ref)) {
    return { remote: 'origin', branch: ref };
  }
  return undefined;
}

/** Ветки сервера, где может лежать коммит догона по хэшу: база группы, HEAD сервера, main, master. */
function targetHeads(base: string | undefined): string[] {
  const names = [...(base ? [`refs/heads/${base}`] : []), 'HEAD', 'refs/heads/main'];
  return [...new Set([...names, 'refs/heads/master'])];
}

async function isAncestor(cwd: string, ref: string, of: string, run: GitRunner): Promise<boolean> {
  return (await run(cwd, ['merge-base', '--is-ancestor', ref, of], 20_000)).code === 0;
}

/**
 * Конфликт HEAD с целевой веткой, куда ведёт догон `ref`, — по серверу
 * (RF-BGCD-05). `origin/*` и локальная `main` копии — ссылки, что агент пишет
 * сам (`git fetch . +X:refs/remotes/origin/main` — рутина): по ним «конфликт»
 * находился там, где его нет. Поэтому ссылка лишь называет ветку сервера и
 * обязана лежать в её истории (догон на свой коммит под чужим именем — «не
 * знаем»); сверка — с вершиной сервера: отставшая `origin/main` копии
 * конфликт не прячет. Хэш и `FETCH_HEAD` ищутся в базе группы, HEAD сервера,
 * main и master. Сервер не ответил — `undefined`.
 */
export async function serverConflicts(
  cwd: string,
  ref: string,
  base: string | undefined,
  run: GitRunner = runGit,
): Promise<boolean | undefined> {
  const local = await run(cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], 20_000);
  const sha = local.stdout.trim();
  if (local.code !== 0 || !SHA.test(sha)) return undefined;
  const named = remoteBranch(ref);
  if (named === null) return undefined;
  const heads = named ? [`refs/heads/${named.branch}`] : targetHeads(base);
  const tips = await serverTips(cwd, named?.remote ?? 'origin', heads, run);
  if (!tips) return undefined;
  for (const head of heads) {
    const tip = tips.get(head);
    if (tip && (await isAncestor(cwd, sha, tip, run))) {
      return conflictsBetween(cwd, 'HEAD', tip, run);
    }
  }
  return undefined;
}

/** Целевые ветки `origin`, с которыми сверяется «скрытый» догон. */
async function targetRefs(
  cwd: string,
  base: string | undefined,
  run: GitRunner,
): Promise<string[]> {
  const head = await run(
    cwd,
    ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'],
    5_000,
  );
  const names = [
    ...(base ? [`origin/${base}`] : []),
    ...(head.code === 0 && head.stdout.trim() ? [head.stdout.trim()] : []),
    'origin/main',
    'origin/master',
  ];
  return [...new Set(names)];
}

/**
 * Ссылка без имени целевой ветки (`git rebase <sha>`, `checkout -B своя <sha>`)
 * всё же догон, когда её коммит уже в целевой ветке и ещё не в HEAD: так группа
 * #3 23.10 обошла отказ, назвав main по хэшу. Уже в HEAD — локальная правка
 * своей истории, не догон.
 *
 * `origin/*` копии агент переставляет сам (RF-BGCD-05): «нет» по ним — не
 * ответ, решают вершины сервера. Сервер не ответил — остаётся ответ копии.
 */
export async function isHiddenSync(
  cwd: string,
  ref: string,
  base: string | undefined,
  run: GitRunner = runGit,
): Promise<boolean> {
  const inHead = await run(cwd, ['merge-base', '--is-ancestor', ref, 'HEAD'], 20_000);
  if (inHead.code !== 1) return false;
  for (const target of await targetRefs(cwd, base, run)) {
    if (await isAncestor(cwd, ref, target, run)) return true;
  }
  const tips = await serverTips(cwd, 'origin', targetHeads(base), run);
  for (const tip of tips?.values() ?? []) {
    if (await isAncestor(cwd, ref, tip, run)) return true;
  }
  return false;
}
