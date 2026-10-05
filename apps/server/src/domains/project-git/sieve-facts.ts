import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import type { SieveMechanics } from '@agentdeck/contracts/sieves';
import {
  GIT_MAX_BUFFER,
  GIT_NETWORK_TIMEOUT_MS,
  GIT_READ_TIMEOUT_MS,
  GIT_TIMEOUT_MS,
} from './constants.ts';
import { pickRemote } from './parse.ts';
import type { Addition } from './sieve-scan.ts';
import { commitsOf, scanMechanics, type BranchCommit } from './sieve-facts-scan.ts';

/**
 * Механические сита перед MR (`@agentdeck/contracts/sieves`) — то, что git
 * отвечает без модели, и потому панель проверяет это сама, а не верит отчёту:
 *
 * - конфликт со СВЕЖЕЙ основной: `fetch` её ветки и `merge-tree --write-tree`
 *   (ничего не пишет ни в рабочее дерево, ни в ветки — только объекты);
 * - чужие «−»: строки, которые ветка удалила, хотя они пришли в основную ПОСЛЕ
 *   старта группы, — чужая работа, потерянная rebase'ом или перезаписанным файлом;
 * - потребители вне диффа: удалённое экспортируемое имя или тест-id, которое
 *   нигде больше не объявлено, но ещё встречается (e2e, QA, другие пакеты).
 *
 * Чего прочесть не вышло (нет удалённого, сеть, старый git без `merge-tree
 * --write-tree`), то не выдумывается: `unchecked` с причиной, а сито молчит.
 */

export interface SieveFacts {
  /** `refs/remotes/<remote>/<main>` — с чем сверялось. */
  mainRef?: string;
  /** Пути, которые ветка изменила относительно развилки со свежей основной. */
  paths: string[];
  mechanics: SieveMechanics;
  /** Часть проверок не сделана — почему (сеть, нет удалённого, старый git). */
  unchecked?: string[];
  /** Развилка со свежей основной — от неё считаются коммиты ветки. */
  base?: string;
  /** Коммиты ветки (новые первыми) и их файлы — по ним судится свежесть отчёта. */
  commits?: BranchCommit[];
}

export interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Запуск git с кодом выхода: у `merge-tree` и `merge-base --is-ancestor` код 1 —
 * это ответ, а не сбой, и общий `git()` его бы выбросил.
 */
export function run(cwd: string, args: string[], timeout = GIT_TIMEOUT_MS): Promise<Run> {
  const long = process.platform === 'win32' ? ['-c', 'core.longpaths=true'] : [];
  return new Promise((done) => {
    execFile(
      'git',
      [...long, ...args],
      {
        cwd: resolve(cwd),
        timeout,
        maxBuffer: GIT_MAX_BUFFER,
        windowsHide: true,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === 'number' ? error.code : -1) : 0;
        done({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

/** Имя основной ветки удалённого: `ls-remote --symref`, иначе локальный указатель. */
async function mainBranch(cwd: string, remote: string): Promise<string | undefined> {
  const listed = await run(cwd, ['ls-remote', '--symref', remote, 'HEAD'], GIT_NETWORK_TIMEOUT_MS);
  const symref = /^ref:\s+refs\/heads\/(\S+)\s+HEAD$/m.exec(listed.stdout);
  if (listed.code === 0 && symref?.[1]) return symref[1];
  const local = await run(cwd, ['symbolic-ref', '--short', `refs/remotes/${remote}/HEAD`]);
  const name = local.stdout.trim();
  return local.code === 0 && name.startsWith(`${remote}/`)
    ? name.slice(remote.length + 1)
    : undefined;
}

/** Файл и удалённые строки из `diff -U0`: `@@ -start,count +… @@`. */
export interface RemovedHunk {
  path: string;
  start: number;
  count: number;
  lines: string[];
}

export interface ParsedDiff {
  removed: RemovedHunk[];
  /** Все добавленные строки — по ним видно, что имя не удалено, а переехало. */
  added: string[];
  /** Добавленные строки с их файлом — вход механики сит (`sieve-scan.ts`). */
  additions: Addition[];
}

/** Разбор `git diff -U0 --no-color --no-ext-diff`. */
export function parseZeroContextDiff(diff: string): ParsedDiff {
  const removed: RemovedHunk[] = [];
  const added: string[] = [];
  const additions: Addition[] = [];
  let path: string | undefined;
  let target: string | undefined;
  let hunk: RemovedHunk | undefined;
  // Строки, ещё не прочитанные в ханке: внутри него `+++ x` — добавленная строка
  // «++ x», а не заголовок файла (ревью PR #1: она уводила следующие строки в чужой путь).
  let oldLeft = 0;
  let newLeft = 0;
  for (const line of diff.split('\n')) {
    if (oldLeft > 0 || newLeft > 0) {
      if (line.startsWith('-') && oldLeft > 0) {
        oldLeft -= 1;
        hunk?.lines.push(line.slice(1));
        continue;
      }
      if (line.startsWith('+') && newLeft > 0) {
        newLeft -= 1;
        added.push(line.slice(1));
        if (target) additions.push({ path: target, text: line.slice(1) });
        continue;
      }
      if (line.startsWith('\\')) continue;
      oldLeft = 0;
      newLeft = 0;
    }
    if (line.startsWith('--- ')) {
      const name = line.slice(4).trim();
      path = name === '/dev/null' ? undefined : name.replace(/^a\//, '');
      hunk = undefined;
      continue;
    }
    if (line.startsWith('+++ ')) {
      const name = line.slice(4).trim();
      target = name === '/dev/null' ? undefined : name.replace(/^b\//, '');
      continue;
    }
    const head = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line);
    if (head) {
      const count = head[2] === undefined ? 1 : Number(head[2]);
      oldLeft = count;
      newLeft = head[3] === undefined ? 1 : Number(head[3]);
      hunk = path && count > 0 ? { path, start: Number(head[1]), count, lines: [] } : undefined;
      if (hunk) removed.push(hunk);
      continue;
    }
    if (line.startsWith('-')) hunk?.lines.push(line.slice(1));
    else if (line.startsWith('+')) {
      added.push(line.slice(1));
      if (target) additions.push({ path: target, text: line.slice(1) });
    }
  }
  return { removed, added, additions };
}

const DECLARATION =
  /\bexport\s+(?:default\s+)?(?:declare\s+)?(?:async\s+)?(?:function\*?|const|let|var|class|interface|type|enum)\s+([A-Za-z_$][\w$]{3,})/g;
const TEST_ID =
  /\b(?:data-testid|data-test-id|data-qa|testID)\s*=\s*\{?\s*["'`]([\w:.-]{3,})["'`]/g;

/** Удалённые имена и тест-id, которых нет среди добавленных строк. */
export function removedTokens(diff: ParsedDiff): { token: string; kind: 'name' | 'testid' }[] {
  const addedText = diff.added.join('\n');
  const tokens = new Map<string, 'name' | 'testid'>();
  for (const hunk of diff.removed) {
    for (const line of hunk.lines) {
      for (const match of line.matchAll(DECLARATION)) if (match[1]) tokens.set(match[1], 'name');
      for (const match of line.matchAll(TEST_ID)) if (match[1]) tokens.set(match[1], 'testid');
    }
  }
  return [...tokens]
    .filter(([token]) => !new RegExp(`(^|[^\\w$])${escape(token)}([^\\w$]|$)`).test(addedText))
    .map(([token, kind]) => ({ token, kind }));
}

function escape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Потолки: проверка идёт перед каждой доставкой и не должна становиться обходом репо. */
const TOKENS_MAX = 40;
const FILES_PER_TOKEN = 5;
const HUNKS_MAX = 80;
const TEST_PATH =
  /(^|\/)(__tests__|tests?|e2e|qa|spec|cypress|playwright)\/|\.(test|spec)\.[^/]+$/i;

/**
 * Потребители удалённого: имя, которое больше нигде не ОБЪЯВЛЕНО, но ещё
 * встречается, — сломанный вызов вне диффа. Тест-id, который больше нигде не
 * РИСУЕТСЯ (атрибут вне тестов), но ещё ищется тестами, — сломанный e2e.
 */
async function consumersOf(
  cwd: string,
  tokens: { token: string; kind: 'name' | 'testid' }[],
): Promise<{ token: string; files: string[] }[]> {
  const hits: { token: string; files: string[] }[] = [];
  for (const { token, kind } of tokens.slice(0, TOKENS_MAX)) {
    const found = await run(cwd, ['grep', '-l', '-w', '-F', '-e', token, 'HEAD', '--']);
    if (found.code !== 0) continue;
    const files = found.stdout
      .split('\n')
      .map((line) => line.trim().replace(/^HEAD:/, ''))
      .filter(Boolean);
    if (files.length === 0) continue;
    if (kind === 'name') {
      const declared = await run(cwd, [
        'grep',
        '-l',
        '-E',
        '-e',
        `(function\\*?|const|let|var|class|interface|type|enum|def|func)[[:space:]]+${escape(token)}([^[:alnum:]_$]|$)`,
        'HEAD',
        '--',
      ]);
      if (declared.code === 0 && declared.stdout.trim()) continue;
      hits.push({ token, files: files.slice(0, FILES_PER_TOKEN) });
    } else {
      const produced = files.some((file) => !TEST_PATH.test(file));
      const consumers = files.filter((file) => TEST_PATH.test(file));
      if (!produced && consumers.length > 0) {
        hits.push({ token, files: consumers.slice(0, FILES_PER_TOKEN) });
      }
    }
  }
  return hits;
}

/**
 * Файлы, где ветка удалила строки, пришедшие в основную после старта группы.
 * Основная на момент старта — последний коммит первой линии основной не позже
 * `startedAt` (время слияния, а не автора: MR вливается коммитом слияния).
 */
async function foreignRemovalsOf(
  cwd: string,
  input: { mainRef: string; base: string; startedAt: string; removed: RemovedHunk[] },
): Promise<string[] | undefined> {
  const atStart = await run(cwd, [
    'rev-list',
    '-1',
    '--first-parent',
    `--before=${input.startedAt}`,
    input.mainRef,
  ]);
  const startBase = atStart.stdout.trim();
  if (atStart.code !== 0 || !startBase) return undefined;
  // Развилка не новее основной на старте — ветка не переносилась, чужих строк
  // под ней нет.
  const moved = await run(cwd, ['merge-base', '--is-ancestor', input.base, startBase]);
  if (moved.code === 0) return [];

  const foreign = new Set<string>();
  const known = new Map<string, boolean>();
  for (const hunk of input.removed.slice(0, HUNKS_MAX)) {
    if (foreign.has(hunk.path)) continue;
    const blame = await run(cwd, [
      'blame',
      '--porcelain',
      '-L',
      `${hunk.start},+${hunk.count}`,
      input.base,
      '--',
      hunk.path,
    ]);
    if (blame.code !== 0) continue;
    const shas = new Set(
      [...blame.stdout.matchAll(/^([0-9a-f]{40}) \d+ \d+/gm)].map((match) => match[1] ?? ''),
    );
    for (const sha of shas) {
      if (!sha) continue;
      let late = known.get(sha);
      if (late === undefined) {
        const ancestor = await run(cwd, ['merge-base', '--is-ancestor', sha, startBase]);
        late = ancestor.code === 1;
        known.set(sha, late);
      }
      if (late) {
        foreign.add(hunk.path);
        break;
      }
    }
  }
  return [...foreign];
}

export async function readSieveFacts(input: {
  cwd: string;
  /** Когда группа стартовала (ISO) — граница «чужих» строк основной. */
  startedAt?: string;
}): Promise<SieveFacts> {
  const { cwd } = input;
  const unchecked: string[] = [];
  const remote = pickRemote((await run(cwd, ['remote'])).stdout);
  if (!remote) return { paths: [], mechanics: {}, unchecked: ['no-remote'] };
  const main = await mainBranch(cwd, remote);
  if (!main) return { paths: [], mechanics: {}, unchecked: ['no-main'] };

  const mainRef = `refs/remotes/${remote}/${main}`;
  const fetched = await run(
    cwd,
    ['fetch', '--quiet', '--no-tags', remote, `+refs/heads/${main}:${mainRef}`],
    GIT_NETWORK_TIMEOUT_MS,
  );
  if (fetched.code !== 0) unchecked.push(`fetch: ${fetched.stderr.trim().slice(0, 200)}`);

  const baseRun = await run(cwd, ['merge-base', mainRef, 'HEAD']);
  const base = baseRun.stdout.trim();
  if (baseRun.code !== 0 || !base) {
    return { mainRef, paths: [], mechanics: {}, unchecked: [...unchecked, 'no-merge-base'] };
  }

  const names = await run(cwd, ['diff', '--name-only', '-z', base, 'HEAD']);
  const paths = names.stdout.split('\0').filter(Boolean);
  const mechanics: SieveMechanics = {};

  const tree = await run(cwd, [
    'merge-tree',
    '--write-tree',
    '--name-only',
    '--no-messages',
    mainRef,
    'HEAD',
  ]);
  if (tree.code === 1) {
    // Первая строка — дерево результата, дальше — файлы с конфликтом.
    const files = tree.stdout
      .split('\n')
      .slice(1)
      .map((line) => line.trim())
      .filter(Boolean);
    mechanics.conflicts = [...new Set(files)];
  } else if (tree.code !== 0) {
    unchecked.push('merge-tree');
  }

  const diff = parseZeroContextDiff(
    // Имена не в восьмеричных кавычках: «src/страница.ts», а не "b/src/\\321…" (ревью PR #1).
    (
      await run(cwd, [
        '-c',
        'core.quotePath=false',
        'diff',
        '-U0',
        '--no-color',
        '--no-ext-diff',
        '--no-renames',
        base,
        'HEAD',
      ])
    ).stdout,
  );
  if (input.startedAt) {
    const foreign = await foreignRemovalsOf(cwd, {
      mainRef,
      base,
      startedAt: input.startedAt,
      removed: diff.removed,
    });
    if (foreign === undefined) unchecked.push('foreign-removals');
    else if (foreign.length > 0) mechanics.foreignRemovals = foreign;
  }
  const consumers = await consumersOf(cwd, removedTokens(diff));
  if (consumers.length > 0) mechanics.consumers = consumers;
  Object.assign(mechanics, await scanMechanics({ run, cwd, base, paths, diff }));
  const commits = await commitsOf(run, cwd, base);

  return {
    mainRef,
    paths,
    mechanics,
    base,
    commits,
    ...(unchecked.length > 0 ? { unchecked } : {}),
  };
}

/**
 * Что ветка копии задела — для задания звена. Асинхронно: до семи вызовов git,
 * среди них `ls-files --others`, на большой копии под Windows синхронно
 * держали бы весь сервер панели (ревью сит, 28.09). Без сети: развилка с
 * локальной ссылкой основной, плюс незакоммиченное. Основной не нашлось —
 * только незакоммиченное и последний коммит: сит тогда меньше, но не ноль.
 */
export async function touchedPaths(cwd: string): Promise<string[]> {
  return (await touchedFacts(cwd)).paths;
}

/** То же с развилкой: от неё задание считает коммиты ветки (свежесть отчёта). */
export async function touchedFacts(cwd: string): Promise<{ paths: string[]; base?: string }> {
  const read = async (args: string[]): Promise<string> => {
    const out = await run(cwd, args, GIT_READ_TIMEOUT_MS);
    return out.code === 0 ? out.stdout : '';
  };
  const paths = new Set<string>();
  const add = (out: string): void => {
    for (const path of out.split('\0')) if (path.trim()) paths.add(path.trim());
  };
  const remote = pickRemote(await read(['remote']));
  const pointer = remote
    ? (await read(['symbolic-ref', '--short', `refs/remotes/${remote}/HEAD`])).trim()
    : '';
  let mainRef: string | undefined;
  for (const ref of [pointer, remote ? `${remote}/main` : '', remote ? `${remote}/master` : '']) {
    if (ref && (await read(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])).trim()) {
      mainRef = ref;
      break;
    }
  }
  const base = mainRef ? (await read(['merge-base', mainRef, 'HEAD'])).trim() : '';
  const [branch, uncommitted, untracked] = await Promise.all([
    read(['diff', '--name-only', '-z', base || 'HEAD~1', 'HEAD']),
    read(['diff', '--name-only', '-z', 'HEAD']),
    read(['ls-files', '--others', '--exclude-standard', '-z']),
  ]);
  add(branch);
  add(uncommitted);
  add(untracked);
  return { paths: [...paths], ...(base ? { base } : {}) };
}
