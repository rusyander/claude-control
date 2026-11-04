import { resolve } from 'node:path';
import { isAbsolutePath } from '../../platform/paths.ts';
import { canonicalTarget } from './target-path.ts';
import type { ReadScope, ReadScopeInput, ReadScopeRefusal } from './permit.types.ts';

/**
 * Сборщик области чтения сеанса (F-87, 06 §Session permissions) — чистая функция без диска:
 * каждый факт приходит от своего владельца (копия и TMPDIR — запуск, каталоги слоя и учётные
 * данные — переходник, кеши и инструменты — платформа, список — человек). Сравнение по ключам пути
 * (регистр, 8.3, ссылки) делает судья (`foldedPaths`), здесь — только форма записи.
 *
 * Разрешение, которое нельзя принять (относительный факт платформы, несводимый путь), не
 * открывает ничего и возвращается в `refused` — человек видит, что его запись не принята.
 * Запрет (файл учётных данных) не выбрасывается никогда: несводимый закрывает судью целиком.
 */

export interface BuiltReadScope {
  scope: ReadScope;
  refused: ReadScopeRefusal[];
}

/** Причина не принять путь-разрешение; `null` — принят. */
function refusal(entry: string): string | null {
  if (entry.trim() === '') return 'empty entry';
  if (!isAbsolutePath(entry)) return 'not an absolute path';
  const canon = canonicalTarget(entry);
  return 'refuse' in canon ? `${canon.refuse}: not comparable` : null;
}

function accept(list: readonly string[], refused: ReadScopeRefusal[]): string[] {
  const out: string[] = [];
  for (const entry of list) {
    const reason = refusal(entry);
    if (reason !== null) refused.push({ entry, reason });
    else if (!out.includes(entry)) out.push(entry);
  }
  return out;
}

export function buildReadScope(input: ReadScopeInput): BuiltReadScope {
  const refused: ReadScopeRefusal[] = [];
  const roots = accept([...input.toolchainRoots, ...input.layer.dirs], refused);
  // Запись человека от корня копии: `../shared-lib` проекта — соседний каталог, не cwd ядра.
  const human = accept(
    input.humanAllow.map((entry) =>
      entry.trim() === '' || isAbsolutePath(entry) ? entry : resolve(input.copyRoot, entry),
    ),
    refused,
  );
  const temp = input.sessionTemp === undefined ? [] : accept([input.sessionTemp], refused);
  const attached =
    input.taskAttachments === undefined ? [] : accept([input.taskAttachments], refused);
  return {
    scope: {
      roots,
      human,
      ...(temp[0] === undefined ? {} : { ownTemp: temp[0] }),
      ...(attached[0] === undefined ? {} : { attachments: attached[0] }),
      credentials: [...new Set(input.layer.credentials)],
    },
    refused,
  };
}
