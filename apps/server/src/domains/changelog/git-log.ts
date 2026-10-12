import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { GitCommitRecord, GitFileStat } from './build.ts';

/**
 * Чтение git для ленты «Что нового»: история коммитов с числом строк, привязка
 * описаний к коммитам и правки рабочей копии. Парсеры чистые и проверяются
 * на готовом тексте; сам git запускается только в `readGit*`.
 */

const ENTRIES_DIR = 'changelog/entries';

const RECORD = '\x1e';
const FIELD = '\x1f';
const MAX_BUFFER = 256 * 1024 * 1024;
const UNTRACKED_CAP = 200;
const UNTRACKED_MAX_BYTES = 1_000_000;

function git(repoRoot: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-c', 'core.quotepath=off', ...args],
      { cwd: repoRoot, encoding: 'utf8', maxBuffer: MAX_BUFFER, windowsHide: true },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
  });
}

/** Путь из строки `--numstat`: переименование приходит как `a => b` или `d/{a => b}/f`. */
export function numstatPath(raw: string): string {
  const braces = /^(.*)\{(.*) => (.*)\}(.*)$/.exec(raw);
  if (braces) return `${braces[1]}${braces[3]}${braces[4]}`.replace(/\/\//g, '/');
  const arrow = raw.indexOf(' => ');
  return arrow >= 0 ? raw.slice(arrow + 4) : raw;
}

/** Строки `--numstat` → файлы; двоичный файл (`-\t-`) считается файлом без строк. */
export function parseNumstat(text: string): GitFileStat[] {
  const files: GitFileStat[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
    if (!match) continue;
    files.push({
      path: numstatPath(match[3]!),
      insertions: match[1] === '-' ? 0 : Number(match[1]),
      deletions: match[2] === '-' ? 0 : Number(match[2]),
    });
  }
  return files;
}

/** Вывод `git log --numstat --format=%x1e%H%x1f%cI%x1f%s%x1f%b%x1f` → коммиты. */
export function parseLog(text: string): GitCommitRecord[] {
  const commits: GitCommitRecord[] = [];
  for (const chunk of text.split(RECORD)) {
    if (!chunk.trim()) continue;
    const [hash, date, subject, body, rest] = chunk.split(FIELD);
    if (!hash || !date || subject === undefined) continue;
    commits.push({
      hash: hash.trim(),
      date,
      subject,
      body: (body ?? '').trim(),
      files: parseNumstat(rest ?? ''),
    });
  }
  return commits;
}

/**
 * Вывод `git log --name-status --format=%x1e%H -- changelog/entries` → id описания
 * → хэши коммитов. Коммит, который ПРАВИТ два файла описаний и больше, — разовая
 * уборка (форматирование, переименование поля): он не привязывает ничего из
 * правленого, иначе все записи разом получили бы одну дату.
 */
export function parseAnchors(text: string): Map<string, string[]> {
  const anchors = new Map<string, string[]>();
  const idOf = (path: string): string | undefined => {
    const match = new RegExp(`^${ENTRIES_DIR}/([^/]+)\\.json$`).exec(path);
    return match?.[1];
  };
  for (const chunk of text.split(RECORD)) {
    const lines = chunk.split(/\r?\n/).filter((line) => line.trim());
    const hash = lines.shift()?.trim();
    if (!hash) continue;
    const touched: { id: string; status: string }[] = [];
    for (const line of lines) {
      const [status, ...paths] = line.split('\t');
      const id = idOf(paths[paths.length - 1] ?? '');
      if (id && status) touched.push({ id, status: status[0]! });
    }
    const modified = touched.filter((t) => t.status === 'M').length;
    for (const { id, status } of touched) {
      if (status === 'D') continue;
      if (status === 'M' && modified >= 2) continue;
      anchors.set(id, [...(anchors.get(id) ?? []), hash]);
    }
  }
  return anchors;
}

export interface GitHistory {
  commits: GitCommitRecord[];
  anchors: Map<string, string[]>;
}

export async function readHead(repoRoot: string): Promise<string | undefined> {
  try {
    return (await git(repoRoot, ['rev-parse', 'HEAD'])).trim();
  } catch {
    return undefined;
  }
}

export async function readGitHistory(repoRoot: string): Promise<GitHistory> {
  const [log, names] = await Promise.all([
    git(repoRoot, [
      'log',
      '--no-merges',
      '--numstat',
      `--format=${RECORD}%H${FIELD}%cI${FIELD}%s${FIELD}%b${FIELD}`,
    ]),
    git(repoRoot, [
      'log',
      '--no-merges',
      '--name-status',
      `--format=${RECORD}%H`,
      '--',
      ENTRIES_DIR,
    ]),
  ]);
  return { commits: parseLog(log), anchors: parseAnchors(names) };
}

/**
 * Правки рабочей копии против HEAD: отслеженные — из `git diff`, новые файлы —
 * строками текста (двоичные и большие считаются файлами без строк).
 */
export async function readWorkingTree(repoRoot: string): Promise<GitFileStat[]> {
  const tracked = parseNumstat(await git(repoRoot, ['diff', 'HEAD', '--numstat']).catch(() => ''));
  const untrackedList = await git(repoRoot, ['ls-files', '--others', '--exclude-standard']).catch(
    () => '',
  );
  const untracked: GitFileStat[] = [];
  for (const path of untrackedList.split(/\r?\n/).filter(Boolean).slice(0, UNTRACKED_CAP)) {
    let insertions = 0;
    try {
      const buffer = await readFile(join(repoRoot, path));
      if (buffer.length <= UNTRACKED_MAX_BYTES && !buffer.includes(0)) {
        const text = buffer.toString('utf8');
        insertions = text ? text.split('\n').length - (text.endsWith('\n') ? 1 : 0) : 0;
      }
    } catch {
      // Файл исчез между перечнем и чтением — остаётся файлом без строк.
    }
    untracked.push({ path, insertions, deletions: 0 });
  }
  return [...tracked, ...untracked];
}
