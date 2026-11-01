import type { Fact } from '@agentdeck/contracts/core/facts';
import { readFact } from '../../lib/facts/read-fact.ts';
import type { GitOptions } from './git.types.ts';
import { git } from './run.ts';

/**
 * История git для деления (02:65, класс `git.history`): какие файлы менялись вместе в последних
 * коммитах базы — план видит области и связи до того, как предложит единицы; проверка деления
 * судит пересечение масок по этим файлам. Только чтение; `unknown` — план идёт без подсказки.
 */

export interface HistoryCommit {
  sha: string;
  files: string[];
}

/** Сколько коммитов читать: подсказке хватает свежего хвоста, вся история — секунды на крупном репо. */
export const HISTORY_COMMITS = 300;
const MARK = '@@agentdeck-commit ';

export function parseHistory(stdout: string): HistoryCommit[] {
  const out: HistoryCommit[] = [];
  let current: HistoryCommit | null = null;
  for (const raw of stdout.split('\n')) {
    const line = raw.trimEnd();
    if (line.startsWith(MARK)) {
      current = { sha: line.slice(MARK.length).trim(), files: [] };
      out.push(current);
    } else if (line !== '' && current) current.files.push(line);
  }
  return out;
}

export function readHistory(
  repo: string,
  rev: string,
  options: GitOptions & { commits?: number } = {},
): Promise<Fact<HistoryCommit[]>> {
  return readFact('git.history', async () => {
    const out = await git(
      repo,
      [
        'log',
        `-n${options.commits ?? HISTORY_COMMITS}`,
        '--no-renames',
        '--name-only',
        `--format=${MARK}%H`,
        rev,
        '--',
      ],
      { ...options, timeoutMs: 30_000 },
    );
    return parseHistory(out.stdout);
  });
}

/** Отслеживаемые файлы ревизии — список, по которому проверка деления судит пересечение масок. */
export function readTrackedFiles(
  repo: string,
  rev: string,
  options: GitOptions = {},
): Promise<Fact<string[]>> {
  return readFact('git.history', async () => {
    const out = await git(repo, ['ls-tree', '-r', '--name-only', '-z', rev], {
      ...options,
      timeoutMs: 30_000,
    });
    return out.stdout.split('\0').filter(Boolean);
  });
}

/**
 * Что единица изменила от своей базы (класс `git.diff-unit`): закоммиченное и рабочее дерево
 * против базы плюс неотслеживаемые не-игнорируемые — суд владения видит и то, что ещё не в коммите.
 */
export function readChangedFiles(
  dir: string,
  base: string,
  options: GitOptions = {},
): Promise<Fact<string[]>> {
  return readFact('git.diff-unit', async () => {
    const call = { ...options, timeoutMs: 30_000 };
    const tracked = await git(dir, ['diff', '--name-only', '--no-renames', '-z', base], call);
    const untracked = await git(dir, ['ls-files', '--others', '--exclude-standard', '-z'], call);
    const files = [...tracked.stdout.split('\0'), ...untracked.stdout.split('\0')].filter(Boolean);
    return [...new Set(files)];
  });
}
