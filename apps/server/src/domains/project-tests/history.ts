import type { ProjectTestHistoryEntry } from '@agentdeck/contracts';
import { gitSync } from '../project-git/exec.ts';
import { TESTS_DIR } from './files.ts';

/**
 * История файла группы кейсов — из git, а не из своего механизма версий.
 *
 * Собственное версионирование здесь строить незачем: кейсы уже лежат в
 * репозитории проекта, и git отвечает на «кто и когда это менял» точнее любой
 * встроенной ленты — вместе с ревью, ветками и откатом. Панель только
 * показывает то, что git и так знает.
 *
 * Проект может не быть репозиторием, а файл — ни разу не попасть в коммит:
 * тогда история пуста, и это нормальный ответ, а не ошибка.
 */

/** Разделитель шапки коммита: обычный текст в неё попасть не может. */
const MARK = '';

/** Сколько коммитов показывать. Дальше человек идёт в сам git. */
const LIMIT = 30;

/** История файла группы: коммиты, тронувшие `.agent/tests/<id>.tests.json`. */
export function historyOf(root: string, groupId: string, limit = LIMIT): ProjectTestHistoryEntry[] {
  const file = `${TESTS_DIR}/${groupId}.tests.json`;
  const output = gitSync(root, [
    'log',
    // `--follow`: файл группы переживает переименование, и обрывать историю на
    // нём значило бы показать «кейсы завели вчера» там, где им год.
    '--follow',
    `-n${limit}`,
    `--format=${MARK}%H%x09%aI%x09%an%x09%s`,
    '--numstat',
    '--',
    file,
  ]);
  if (!output) return [];

  const entries: ProjectTestHistoryEntry[] = [];
  for (const line of output.split('\n')) {
    if (line.startsWith(MARK)) {
      const [hash = '', date = '', author = '', ...rest] = line.slice(1).split('\t');
      entries.push({ hash: hash.slice(0, 8), date, author, subject: rest.join('\t') });
      continue;
    }
    // Строка numstat относится к последнему прочитанному коммиту: «добавлено,
    // убрано, путь». Бинарный файл даёт прочерки — тогда цифр просто нет.
    const stat = /^(\d+)\t(\d+)\t/.exec(line);
    const last = entries[entries.length - 1];
    if (stat && last) {
      last.added = Number(stat[1]);
      last.removed = Number(stat[2]);
    }
  }
  return entries;
}
