import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { git } from './exec.ts';

/** Больше — вместо хеша текста размер и время правки: читать гигабайт ради карточки незачем. */
const HASHED_MAX_BYTES = 32 * 1024 * 1024;

const namesOf = (out: string): string[] => out.split('\0').filter(Boolean);

function fileDigest(path: string): string {
  try {
    const stats = statSync(path);
    if (!stats.isFile()) return 'not-a-file';
    if (stats.size > HASHED_MAX_BYTES) return `size:${stats.size}:mtime:${stats.mtimeMs}`;
    return createHash('sha256').update(readFileSync(path)).digest('hex');
  } catch {
    return 'missing';
  }
}

/**
 * Отпечаток СОДЕРЖИМОГО того, что заберёт коммит `commitAll` (`git add -A`):
 * каждый изменённый, проиндексированный, удалённый и неотслеживаемый файл
 * репозитория — хешем его текста на диске. Статус и счётчики строк `git
 * status`/`numstat` правку «то же число строк, другой текст» не видят, а
 * человек одобрял коммит именно того, что лежало при карточке (ревью U4a m1).
 * Только чтение: ни индекса, ни объектов git не пишет.
 */
export async function commitContentPrint(dir: string): Promise<string> {
  const top = (await git(dir, ['rev-parse', '--show-toplevel'])).trim();
  // В репозитории без коммитов сравнивать с HEAD не с чем — тогда весь индекс.
  const tracked = await git(top, ['diff', 'HEAD', '--name-only', '--no-renames', '-z']).catch(() =>
    git(top, ['ls-files', '-z']),
  );
  const staged = await git(top, ['diff', '--cached', '--name-only', '--no-renames', '-z']).catch(
    () => '',
  );
  const untracked = await git(top, ['ls-files', '--others', '--exclude-standard', '-z']);
  const paths = [
    ...new Set([...namesOf(tracked), ...namesOf(staged), ...namesOf(untracked)]),
  ].sort();
  const hash = createHash('sha256');
  for (const path of paths) {
    hash
      .update(path)
      .update('\0')
      .update(fileDigest(join(top, path)))
      .update('\0');
  }
  return hash.digest('hex');
}
