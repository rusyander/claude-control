import type { Fact } from '@agentdeck/contracts/core/facts';
import { ABSENT, readFact } from '../../lib/facts/read-fact.ts';
import type { GitOptions, TreeRow } from './git.types.ts';
import { git } from './run.ts';
import { treeRows } from './tree.ts';

/**
 * Изменённые пути: строка дерева отличается режимом или содержимым, есть только с одной стороны.
 * Одно сравнение на ядро — и для изменённых единиц проверок (04:56), и для диффа единицы шага.
 */
export function changedPaths(rows: readonly TreeRow[], baseRows: readonly TreeRow[]): string[] {
  const base = new Map(baseRows.map((r) => [r.path, `${r.mode} ${r.blob}`]));
  const out = new Set<string>();
  for (const r of rows) {
    if (base.get(r.path) !== `${r.mode} ${r.blob}`) out.add(r.path);
    base.delete(r.path);
  }
  for (const gone of base.keys()) out.add(gone);
  return [...out].sort();
}

/**
 * Дифф единицы (02:43 факты после шага): файлы рабочего дерева копии, отличные от базы, — тем же
 * деревом, каким считается ключ проверки (неотслеживаемые и неигнорируемые входят). Класс чтения
 * `git.diff-unit`, `onUnknown: refuse`: дерево или база не прочитались — `unknown`, никогда «ничего
 * не изменено» (пустой дифф сделал бы любое доказательство «нерелевантным» молча, а вывод исхода
 * без правок — ложным).
 */
export function diffUnit(
  repo: string,
  base: string,
  options: GitOptions = {},
): Promise<Fact<string[]>> {
  return readFact('git.diff-unit', async () => {
    const [rows, baseRows] = await Promise.all([
      treeRows(repo, 'worktree', options),
      treeRows(repo, base, options),
    ]);
    if (!('value' in rows))
      throw new Error(`work tree: ${'unknown' in rows ? rows.unknown : 'absent'}`);
    // Базы нет в репозитории — дифф не знает, от чего считать: это сомнение, а не «пусто».
    if (!('value' in baseRows))
      throw new Error(`base ${base}: ${'unknown' in baseRows ? baseRows.unknown : 'absent'}`);
    return changedPaths(rows.value, baseRows.value);
  });
}

/**
 * Тело диффа одного файла копии против базы (инструмент модели `unit_diff`), тем же классом
 * `git.diff-unit`. Пустой вывод — у git тела нет (новый неотслеживаемый файл): `absent`, а не
 * пустая строка, иначе ревьюер принял бы его за «без изменений». Внешний дифф и textconv
 * выключены: тело — то, что лежит в копии, а не вывод чужой программы.
 */
export function diffFileOf(
  dir: string,
  base: string,
  file: string,
  options: GitOptions = {},
): Promise<Fact<string>> {
  return readFact('git.diff-unit', async () => {
    const out = await git(
      dir,
      ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', base, '--', file],
      { ...options, timeoutMs: 30_000 },
    );
    return out.stdout === '' ? ABSENT : out.stdout;
  });
}
