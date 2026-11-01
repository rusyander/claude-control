import type { SieveFinding, SieveName } from '@agentdeck/contracts/core/publish';
import {
  artifactsIn,
  CONFLICT_MARKER,
  debugLeftoversIn,
  declaresEnv,
  destructiveIn,
  envReadsIn,
  isLocalFile,
  LARGE_FILE_BYTES,
  lockfileGapsIn,
  secretsIn,
  untestedCodeIn,
  type Addition,
} from './sieve-scan.ts';

/**
 * Сита публикатора ядра над исходящим содержимым (05 §Readiness): та же механика, что у панели,
 * сведённая в находки с именем сита из контракта. Чистая функция: вход собирает вызывающий из git
 * копии (дифф к базе, `ls-files`, `check-ignore`, размеры, `git grep` имён окружения), сита не
 * запускают git сами — пакет не знает ни копии, ни ядра.
 */
export interface OutgoingScanInput {
  /** Все файлы, которые исходящее дерево меняет относительно базы. */
  changed: readonly string[];
  /** Файлы, которых в базе не было. */
  added: readonly string[];
  /** Файлы, которые исходящее дерево удаляет. */
  deleted: readonly string[];
  /** Добавленные строки с файлом. */
  additions: readonly Addition[];
  /** Удалённые строки с файлом — лок-файл судит строку зависимости в обе стороны. */
  removals: readonly Addition[];
  /** Все файлы исходящего дерева (`git ls-files`). */
  tracked: readonly string[];
  /** Добавленные файлы, которые `.gitignore` исключает. */
  ignored: readonly string[];
  /** Размер добавленного файла в исходящем дереве, байты. */
  sizes: Readonly<Record<string, number>>;
  /**
   * Для каждого имени из `envReadsIn(additions)` — файлы дерева, где оно встречается. Имени нет в
   * записи — объявления не нашли: отказ строже молчания.
   */
  envMentions: Readonly<Record<string, readonly string[]>>;
  /**
   * Пути, которыми единица владеет. `null` — владение не задано (одна единица на задачу): удаление
   * чужого файла тогда не судится.
   */
  owns: ((path: string) => boolean) | null;
}

function findings(sieve: SieveName, files: readonly string[], detail: string): SieveFinding[] {
  return files.map((file) => ({ sieve, file, detail }));
}

/** Каждая находка сит по исходящему дереву; пустой список — сита чисты. */
export function scanOutgoing(input: OutgoingScanInput): SieveFinding[] {
  const markers = input.additions.filter((line) => CONFLICT_MARKER.test(line.text));
  const debug = input.additions.filter((line) => !CONFLICT_MARKER.test(line.text));
  const artifacts = artifactsIn(input);
  const local = artifacts.filter(isLocalFile);
  const large = artifacts.filter((path) => (input.sizes[path] ?? 0) > LARGE_FILE_BYTES);
  const forced = artifacts.filter((path) => !local.includes(path) && !large.includes(path));
  const undeclared = envReadsIn(input.additions).filter(
    (name) => !(input.envMentions[name] ?? []).some(declaresEnv),
  );
  const owns = input.owns;
  const unowned = owns ? input.deleted.filter((path) => !owns(path)) : [];
  return [
    ...findings('secret', secretsIn(input.additions), 'в добавленных строках ключ известной формы'),
    ...findings('debug-leftover', debugLeftoversIn(debug), 'остаток отладки или .only в тесте'),
    ...findings(
      'conflict-marker',
      [...new Set(markers.map((line) => line.path))].sort(),
      'маркер конфликта слияния',
    ),
    ...findings('committed-env', local, 'файл окружения или ключа в git'),
    ...findings('committed-env', forced, 'файл, исключённый .gitignore, добавлен силой'),
    ...findings('large-file', large, `файл больше ${LARGE_FILE_BYTES / 1024 / 1024} МБ`),
    ...findings(
      'lockfile-gap',
      lockfileGapsIn({
        changed: input.changed,
        lines: [...input.additions, ...input.removals],
        tracked: input.tracked,
      }),
      'зависимость изменена, лок-файл не тронут',
    ),
    ...findings(
      'destructive-migration',
      destructiveIn(input.additions),
      'разрушающий оператор миграции',
    ),
    ...undeclared.map((name) => ({
      sieve: 'undeclared-env' as const,
      file: name,
      detail: 'переменная окружения без значения по умолчанию нигде не объявлена',
    })),
    ...findings(
      'untested-code',
      untestedCodeIn(input.changed),
      'код изменён, ни один тест не изменён',
    ),
    ...findings('unowned-removal', unowned, 'удалён файл, которым единица не владеет'),
  ];
}
