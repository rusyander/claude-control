import { readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import type { Fact } from '@agentdeck/contracts/core/facts';
import { absent, readFact } from '../../lib/facts/read-fact.ts';
import { READ_CLASSES } from '../../lib/facts/read-classes.ts';
import { reasonOf } from '../os-kind.ts';
import type { GitOptions } from './git.types.ts';
import { git } from './run.ts';

/**
 * Общий каталог git (`--git-common-dir`): одно хранилище записей на репозиторий, общее у основной
 * папки и всех её копий-worktree (04:33). Путь всегда абсолютный и в форме ОС.
 */

/**
 * Один каталог — одна строка: git пишет в `gitdir`/`commondir` длинный путь, а папка задачи может
 * прийти короткой формой Windows (`RUSYAN~1`) или через ссылку; без приведения у основной папки
 * и её копии вышли бы два «разных» хранилища одного репозитория.
 */
function canonicalDir(dir: string): string {
  try {
    return realpathSync.native(resolve(dir));
  } catch {
    return resolve(dir);
  }
}

export function commonDir(repo: string, options: GitOptions = {}): Promise<Fact<string>> {
  return readFact('git.tree', async () => {
    const out = await git(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      ...options,
      timeoutMs: READ_CLASSES['git.tree'].timeoutMs,
    });
    const dir = out.stdout.trim();
    if (dir === '') throw new Error('rev-parse: empty common dir');
    return canonicalDir(dir);
  });
}

/** Рабочая копия каталога: её корень, путь каталога внутри (`a/b`, корень — `''`) и общий каталог. */
export interface WorkTreeOf {
  top: string;
  prefix: string;
  common: string;
}

/**
 * Чья рабочая копия у каталога, где запущен прогон (дороги захвата, очередь `spool/`): корень и
 * общий каталог приведены к одной форме, как у `commonDir`, — короткое имя Windows или ссылка не
 * делают из одного репозитория два. Не репозиторий — `absent`.
 */
export function workTreeOf(dir: string, options: GitOptions = {}): Promise<Fact<WorkTreeOf>> {
  return readFact('git.tree', async () => {
    const out = await git(
      dir,
      [
        'rev-parse',
        '--path-format=absolute',
        '--show-toplevel',
        '--git-common-dir',
        '--show-prefix',
      ],
      { ...options, timeoutMs: READ_CLASSES['git.tree'].timeoutMs, acceptNonZero: true },
    );
    if (out.code !== 0) return absent();
    const [top = '', common = '', prefix = ''] = out.stdout.split(/\r?\n/);
    if (top === '' || common === '') throw new Error('rev-parse: empty work tree');
    return {
      top: canonicalDir(top),
      common: canonicalDir(common),
      prefix: prefix.replace(/\/+$/, ''),
    };
  });
}

/**
 * Тот же ответ синхронно, по файлам git, для `repo` = корень рабочей копии: `.git` — каталог
 * (он и есть общий) или файл `gitdir: <путь>`, а в каталоге копии `commondir` ведёт к общему.
 * Нужен синхронной дороге модели (`records(id)` у `step_done`), которая не ждёт процесс git.
 */
export function commonDirSync(repo: string): Fact<string> {
  try {
    const dotGit = join(repo, '.git');
    const stats = statSync(dotGit, { throwIfNoEntry: false });
    if (!stats) return absent();
    if (stats.isDirectory()) return { value: canonicalDir(dotGit) };
    const text = readFileSync(dotGit, 'utf8');
    const match = /^gitdir:\s*(.+?)\s*$/m.exec(text);
    if (!match?.[1]) return { unknown: `garbage: ${dotGit} has no gitdir line` };
    const gitDir = resolve(repo, match[1]);
    const commonFile = join(gitDir, 'commondir');
    const common = statSync(commonFile, { throwIfNoEntry: false });
    if (!common) return { value: canonicalDir(gitDir) };
    const rel = readFileSync(commonFile, 'utf8').trim();
    if (rel === '') return { unknown: `garbage: ${commonFile} empty` };
    return { value: canonicalDir(isAbsolute(rel) ? rel : resolve(gitDir, rel)) };
  } catch (error) {
    return { unknown: reasonOf(error) };
  }
}
