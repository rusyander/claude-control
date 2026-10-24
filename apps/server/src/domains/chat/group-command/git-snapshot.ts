import { execFile } from 'node:child_process';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { BACKUP_PREFIX } from './git-guards.ts';

/**
 * Снимок незакоммиченного копии перед командой, что его сотрёт (решение
 * владельца 23.10: затирание своей копии идёт само, но потерь быть не должно).
 *
 * Рабочее дерево и настоящий индекс не трогаются: индекс копируется во
 * временный файл (`GIT_INDEX_FILE`), туда `git add -A` кладёт всё, что
 * видит `git status` (правки, новые файлы; игнорируемое — нет), и из него
 * собираются коммиты — как у `git stash`: первый родитель — `HEAD`, второй —
 * коммит с тем, что было в индексе. Ссылка `refs/agentdeck/backup/<время>-<метка>`
 * общая для всех копий репозитория; её проверяют чтением до ответа «можно».
 *
 * Вернуть: `git restore --source=<ссылка> --worktree -- .` (всё дерево) или
 * `git checkout <ссылка> -- <путь>` (один файл); `git stash apply <ссылка>`
 * вернёт и индекс.
 */

const run = promisify(execFile);

/** Снимков держим не больше стольких и не дольше двух недель (`pruneBackups`). */
export const BACKUP_KEEP = 50;
export const BACKUP_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Программы из настроек копии здесь не нужны: `core.fsmonitor` исполнил бы
 * записанное группой от имени панели. Автор — сама панель: без `user.email` в
 * копии `commit-tree` отказал бы, и снимок не состоялся.
 */
const SAFE_ARGS = ['-c', 'core.fsmonitor=false', '-c', 'core.longpaths=true'];
const IDENTITY = {
  GIT_AUTHOR_NAME: 'agentdeck',
  GIT_AUTHOR_EMAIL: 'agentdeck@localhost',
  GIT_COMMITTER_NAME: 'agentdeck',
  GIT_COMMITTER_EMAIL: 'agentdeck@localhost',
};

async function git(cwd: string, args: string[], env: Record<string, string> = {}): Promise<string> {
  const { stdout } = await run('git', [...SAFE_ARGS, ...args], {
    cwd,
    timeout: 60_000,
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', ...IDENTITY, ...env },
  });
  return stdout.trim();
}

export interface Snapshot {
  ref: string;
  sha: string;
}

/** `2026-10-23T18-05-12-345Z`: двоеточие в имени ссылки git запрещено. */
function stamp(now: Date): string {
  return now.toISOString().replace(/[:.]/g, '-');
}

/**
 * Снять незакоммиченное в `refs/agentdeck/backup/…`. `undefined` — не вышло
 * (git не ответил, ссылка не читается тем, что записали): вызывающий обязан
 * отказать команде, а не пропустить её.
 */
export async function snapshotUncommitted(
  cwd: string,
  command: string,
  now: Date = new Date(),
): Promise<Snapshot | undefined> {
  const dir = await mkdtemp(join(tmpdir(), 'agentdeck-snapshot-'));
  try {
    const index = join(dir, 'index');
    const realIndex = resolve(cwd, await git(cwd, ['rev-parse', '--git-path', 'index']));
    // Индекса ещё нет (пустой репозиторий) — временный начнётся пустым.
    await copyFile(realIndex, index).catch(() => undefined);
    const env = { GIT_INDEX_FILE: index };
    const head = await git(cwd, ['rev-parse', '--verify', '-q', 'HEAD^{commit}']).catch(() => '');
    const parents = head ? ['-p', head] : [];
    const stagedTree = await git(cwd, ['write-tree'], env);
    await git(cwd, ['add', '-A', '--', ':/'], env);
    const tree = await git(cwd, ['write-tree'], env);
    // Дата снимка — та, по которой его потом уберёт `pruneBackups`.
    const dated = { GIT_AUTHOR_DATE: now.toISOString(), GIT_COMMITTER_DATE: now.toISOString() };
    const staged = await git(
      cwd,
      ['commit-tree', stagedTree, ...parents, '-m', 'agentdeck: index before the command'],
      dated,
    );
    const message = `agentdeck: uncommitted work before «${command.slice(0, 400)}»\n\ncopy: ${cwd}`;
    const sha = await git(
      cwd,
      ['commit-tree', tree, ...parents, '-p', staged, '-m', message],
      dated,
    );
    const ref = `${BACKUP_PREFIX}${stamp(now)}-${Math.random().toString(16).slice(2, 8)}`;
    // Пустое старое значение — ссылка обязана быть новой: чужой снимок не затираем.
    await git(cwd, ['update-ref', '-m', 'agentdeck backup', ref, sha, '']);
    const check = await git(cwd, ['rev-parse', '--verify', '-q', `${ref}^{commit}`]);
    if (check !== sha) return undefined;
    await pruneBackups(cwd, now).catch(() => undefined);
    return { ref, sha };
  } catch {
    return undefined;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Снимки панели не копятся без счёта: старше двух недель и сверх полусотни
 * новейших ОДНОЙ копии — удаляются. Ссылки общие у всех копий репозитория, и
 * общий счёт давал занятой соседней группе вытеснить единственный снимок
 * другой копии (ревью 23.10, A-18); копия снимка — строка `copy:` его
 * сообщения. Только под `refs/agentdeck/backup/`, ничего другого.
 */
export async function pruneBackups(cwd: string, now: Date = new Date()): Promise<string[]> {
  const listed = await git(cwd, [
    'for-each-ref',
    '--sort=-committerdate',
    '--format=%(refname)%00%(committerdate:unix)%00%(contents:body)%00',
    BACKUP_PREFIX,
  ]);
  const removed: string[] = [];
  const seen = new Map<string, number>();
  const rows = listed ? `${listed}\n`.split('\0\n').filter(Boolean) : [];
  for (const row of rows) {
    const [ref = '', seconds = '0', body = ''] = row.split('\0');
    if (!ref.startsWith(BACKUP_PREFIX)) continue;
    const copy = /^copy: (.*)$/m.exec(body)?.[1]?.trim() ?? '';
    const position = seen.get(copy) ?? 0;
    seen.set(copy, position + 1);
    const old = now.getTime() - Number(seconds) * 1000 > BACKUP_MAX_AGE_MS;
    if (position < BACKUP_KEEP && !old) continue;
    await git(cwd, ['update-ref', '-d', ref]);
    removed.push(ref);
  }
  return removed;
}
