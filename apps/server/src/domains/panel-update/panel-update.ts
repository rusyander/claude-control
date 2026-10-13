import { execFile, spawn } from 'node:child_process';
import { basename } from 'node:path';
import {
  changelogEntryFileSchema,
  type PanelUpdateCommit,
  type PanelUpdateResult,
  type PanelUpdateStatus,
} from '@agentdeck/contracts/changelog';
import { ENTRY_ID } from '../changelog/entries.ts';
import { fetchesPack, sweepStalePacks } from '../project-git/exec/stale-packs.ts';

/**
 * Обновление панели из её собственного репозитория. Панель — клон git: новые
 * коммиты на отслеживаемой ветке видны после `git fetch`, а подтягиваются
 * только перемоткой (`merge --ff-only`) и только при чистой рабочей копии —
 * правки человека и его неотправленные коммиты не трогаются никогда. Код сервера
 * после перемотки подхватывает dev-сторож: он сам откладывает перезапуск до
 * конца идущих ходов и сначала пробует поднять новую сборку.
 */

/** `git fetch` в фоне не чаще раза в 10 минут: проверка обновлений не должна долбить сеть. */
export const FETCH_EVERY_MS = 10 * 60_000;
const FETCH_TIMEOUT_MS = 60_000;
const INSTALL_TIMEOUT_MS = 10 * 60_000;
const INCOMING_MAX = 30;
const ENTRIES_MAX = 20;
const DIRTY_MAX = 50;
const FIELD = '\x1f';

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Запуск git; подменяется в тестах только вместе с настоящим репозиторием. */
export async function runGit(
  repoRoot: string,
  args: string[],
  timeout = 30_000,
): Promise<GitResult> {
  if (fetchesPack(args)) await sweepStalePacks(repoRoot);
  return new Promise((resolve) => {
    execFile(
      'git',
      ['-c', 'core.quotepath=off', ...args],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        windowsHide: true,
        timeout,
        // Без терминала git не должен ждать пароль: молча повисший fetch хуже отказа.
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) || (error?.message ?? '') });
      },
    );
  });
}

/** Установка зависимостей после перемотки с новым lock-файлом. */
export function runInstall(repoRoot: string): Promise<GitResult> {
  return new Promise((resolve) => {
    // Аргументы постоянные — оболочка на Windows нужна только чтобы найти pnpm.cmd.
    const child = spawn('pnpm', ['install', '--frozen-lockfile'], {
      cwd: repoRoot,
      shell: process.platform === 'win32',
      windowsHide: true,
      env: { ...process.env, CI: '1' },
    });
    let out = '';
    const take = (chunk: Buffer): void => {
      out = (out + chunk.toString()).slice(-4000);
    };
    child.stdout?.on('data', take);
    child.stderr?.on('data', take);
    const timer = setTimeout(() => child.kill(), INSTALL_TIMEOUT_MS);
    child.once('error', (error) => {
      clearTimeout(timer);
      resolve({ code: 1, stdout: out, stderr: error.message });
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout: out, stderr: '' });
    });
  });
}

export interface PanelUpdateDeps {
  git?: typeof runGit;
  install?: typeof runInstall;
  now?: () => number;
  /** Сервер под dev-сторожем — он подхватит правки сам. */
  watched?: () => boolean;
}

const firstLine = (text: string): string =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) ?? '';

/** `git log --format=%H%x1f%cI%x1f%s` → коммиты. */
export function parseIncoming(text: string): PanelUpdateCommit[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.split(FIELD))
    .filter((parts): parts is [string, string, string] => parts.length === 3 && !!parts[0])
    .map(([hash, date, subject]) => ({ hash, date, subject }));
}

/** `git status --porcelain=v1 -uno` → пути изменённых отслеживаемых файлов. */
export function parseDirty(text: string): string[] {
  return text
    .split(/\r?\n/)
    .filter((line) => line.length > 3)
    .map((line) => {
      const path = line.slice(3);
      const arrow = path.indexOf(' -> ');
      return arrow >= 0 ? path.slice(arrow + 4) : path;
    });
}

interface FetchMemo {
  at: number;
  fetchedAt?: string;
  error?: string;
}

const fetchMemo = new Map<string, FetchMemo>();

export function resetPanelUpdateMemo(): void {
  fetchMemo.clear();
}

async function fetchUpstream(
  repoRoot: string,
  git: typeof runGit,
  now: number,
  force: boolean,
): Promise<FetchMemo> {
  const known = fetchMemo.get(repoRoot);
  if (known && !force && now - known.at < FETCH_EVERY_MS) return known;
  const result = await git(repoRoot, ['fetch', '--quiet', '--no-tags'], FETCH_TIMEOUT_MS);
  const memo: FetchMemo =
    result.code === 0
      ? { at: now, fetchedAt: new Date(now).toISOString() }
      : {
          at: now,
          ...(known?.fetchedAt ? { fetchedAt: known.fetchedAt } : {}),
          error: firstLine(result.stderr) || `git fetch: ${result.code}`,
        };
  fetchMemo.set(repoRoot, memo);
  return memo;
}

const empty = (state: PanelUpdateStatus['state']): PanelUpdateStatus => ({
  state,
  behind: 0,
  ahead: 0,
  incoming: [],
  entries: [],
  dirty: [],
  lockChanged: false,
});

async function incomingEntries(
  repoRoot: string,
  git: typeof runGit,
): Promise<PanelUpdateStatus['entries']> {
  const names = await git(repoRoot, [
    'diff',
    '--name-only',
    '--diff-filter=AM',
    'HEAD...@{u}',
    '--',
    'changelog/entries',
  ]);
  const files = names.stdout
    .split(/\r?\n/)
    .filter((path) => path.endsWith('.json'))
    .slice(0, ENTRIES_MAX);
  const entries: PanelUpdateStatus['entries'] = [];
  for (const path of files) {
    const id = basename(path, '.json');
    if (!ENTRY_ID.test(id)) continue;
    const shown = await git(repoRoot, ['show', `@{u}:${path}`]);
    if (shown.code !== 0) continue;
    try {
      const parsed = changelogEntryFileSchema.safeParse(JSON.parse(shown.stdout));
      if (parsed.success) entries.push({ id, title: parsed.data.title });
    } catch {
      // Битое описание в чужом коммите — не повод прятать само обновление.
    }
  }
  // Имя файла начинается с даты — новые сверху, как в ленте.
  return entries.sort((a, b) => b.id.localeCompare(a.id));
}

/**
 * Состояние обновления. `refresh` — fetch сейчас, иначе не чаще `FETCH_EVERY_MS`;
 * упавший fetch не прячет состояние: сравнение идёт с прежним снимком, ошибка
 * названа в `fetchError`.
 */
export async function readPanelUpdate(
  repoRoot: string,
  { refresh = false }: { refresh?: boolean } = {},
  deps: PanelUpdateDeps = {},
): Promise<PanelUpdateStatus> {
  const git = deps.git ?? runGit;
  const now = (deps.now ?? Date.now)();

  const inside = await git(repoRoot, ['rev-parse', '--is-inside-work-tree']);
  if (inside.code !== 0 || inside.stdout.trim() !== 'true') return empty('not-git');

  const branch = (await git(repoRoot, ['symbolic-ref', '--short', '-q', 'HEAD'])).stdout.trim();
  const upstreamRef = await git(repoRoot, [
    'rev-parse',
    '--abbrev-ref',
    '--symbolic-full-name',
    '@{u}',
  ]);
  const upstream = upstreamRef.stdout.trim();
  if (!branch || upstreamRef.code !== 0 || !upstream) {
    return { ...empty('no-upstream'), ...(branch ? { branch } : {}) };
  }

  const fetched = await fetchUpstream(repoRoot, git, now, refresh);
  const counts = await git(repoRoot, ['rev-list', '--left-right', '--count', 'HEAD...@{u}']);
  const [ahead = 0, behind = 0] = counts.stdout.trim().split(/\s+/).map(Number);
  const dirty = parseDirty(
    (await git(repoRoot, ['status', '--porcelain=v1', '-uno'])).stdout,
  ).slice(0, DIRTY_MAX);

  const base: PanelUpdateStatus = {
    ...empty(behind === 0 ? 'current' : ahead > 0 ? 'diverged' : 'behind'),
    branch,
    upstream,
    behind,
    ahead,
    dirty,
    ...(fetched.fetchedAt ? { fetchedAt: fetched.fetchedAt } : {}),
    ...(fetched.error ? { fetchError: fetched.error } : {}),
  };
  if (behind === 0) return base;

  const log = await git(repoRoot, [
    'log',
    `-n${INCOMING_MAX}`,
    `--format=%H${FIELD}%cI${FIELD}%s`,
    'HEAD..@{u}',
  ]);
  const lock = await git(repoRoot, ['diff', '--name-only', 'HEAD...@{u}', '--', 'pnpm-lock.yaml']);
  return {
    ...base,
    incoming: parseIncoming(log.stdout),
    entries: await incomingEntries(repoRoot, git),
    lockChanged: lock.stdout.trim().length > 0,
  };
}

let running: Promise<PanelUpdateResult> | undefined;

/**
 * Обновить: свежий fetch, перемотка `--ff-only` и, если пришёл новый lock-файл,
 * `pnpm install --frozen-lockfile`. Одно обновление за раз; любое невыполненное
 * предусловие — отказ с причиной, рабочая копия не трогается.
 */
export function applyPanelUpdate(
  repoRoot: string,
  deps: PanelUpdateDeps = {},
): Promise<PanelUpdateResult> {
  if (running) {
    return readPanelUpdate(repoRoot, {}, deps).then((status) => ({
      ok: false,
      error: 'busy' as const,
      watched: (deps.watched ?? isWatched)(),
      status,
    }));
  }
  running = update(repoRoot, deps).finally(() => {
    running = undefined;
  });
  return running;
}

function isWatched(): boolean {
  return !!process.env.AGENTDECK_DEV_RESTART_DIR;
}

async function update(repoRoot: string, deps: PanelUpdateDeps): Promise<PanelUpdateResult> {
  const git = deps.git ?? runGit;
  const watched = (deps.watched ?? isWatched)();
  const status = await readPanelUpdate(repoRoot, { refresh: true }, deps);
  if (status.state !== 'behind') return { ok: false, error: status.state, watched, status };
  if (status.dirty.length > 0) return { ok: false, error: 'dirty', watched, status };

  const from = (await git(repoRoot, ['rev-parse', 'HEAD'])).stdout.trim();
  const merged = await git(repoRoot, ['merge', '--ff-only', '--quiet', '@{u}'], 120_000);
  if (merged.code !== 0) {
    return {
      ok: false,
      error: 'pull-failed',
      detail: (merged.stderr || merged.stdout).trim(),
      watched,
      status: await readPanelUpdate(repoRoot, {}, deps),
    };
  }
  const to = (await git(repoRoot, ['rev-parse', 'HEAD'])).stdout.trim();

  let installed: boolean | undefined;
  let installError: string | undefined;
  if (status.lockChanged) {
    const result = await (deps.install ?? runInstall)(repoRoot);
    installed = result.code === 0;
    if (!installed) installError = (result.stderr || result.stdout).trim().slice(-2000);
  }

  return {
    ok: true,
    from,
    to,
    ...(installed !== undefined ? { installed } : {}),
    ...(installError ? { installError } : {}),
    watched,
    status: await readPanelUpdate(repoRoot, {}, deps),
  };
}
