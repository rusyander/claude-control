import type { ConfigView } from '@agentdeck/contracts/core/config';
import type { QueueConfig } from '@agentdeck/contracts/core/records';
import { configFilesOf, sha256Hex } from '../../platform/core-config/files.ts';
import { QUEUE_FIELDS, queueRejected, readCoreConfig } from '../../platform/core-config/read.ts';
import { readBytesSync } from '../../platform/safe-io/files.ts';
import { DEFAULT_QUEUE_CONFIG } from './order.ts';

/**
 * Раздел `queue` настройки ядра (00:58, пишет только API ядра) через единого читателя
 * (`platform/core-config/read.ts`, схема и пределы полей — `QUEUE_LIMITS` в контрактах).
 * Перечитывается на каждом проходе очереди (D§3.8: «slots from config, re-read per poll»).
 * Негодное поле не роняет очередь: берётся прежнее хорошее значение (или умолчание), а поле
 * названо в `issues` — тихо подставленное число скрыло бы, что настройка не действует. Правка
 * мимо API (дрейф, G6) не действует: значения — из последней записи ядра.
 */

export interface QueueConfigRead {
  config: QueueConfig;
  issues: string[];
}

/**
 * `defaults` — для того, чего в документе нет (убранный раздел или поле — это «по умолчанию»);
 * `last` — прежнее хорошее значение для того, что есть, но негодно (A1r3-F07: мусор в файле не
 * сбрасывает рабочую настройку на умолчание).
 */
export function queueSectionOf(
  view: ConfigView,
  defaults: QueueConfig,
  last: QueueConfig = defaults,
): QueueConfigRead {
  const rejected = queueRejected(view);
  const issues = view.issues
    .filter((i) => i.section === 'queue')
    .map((i) => (rejected === 'all' ? `queue: ${i.reason}` : `queue.${i.reason}`));
  if (rejected === 'all') return { config: last, issues };
  const section = view.doc.queue ?? {};
  const config = { ...defaults };
  for (const field of QUEUE_FIELDS) {
    // `sessionSlots` (этап 11) необязательно: нет ни прежнего, ни своего — действует умолчание.
    const value = rejected.has(field) ? last[field] : section[field];
    if (value !== undefined) Object.assign(config, { [field]: value });
  }
  return { config, issues };
}

/** Отпечаток пары «документ + память писателя»: не изменились — разбор не повторяется. */
function keyOf(files: { config: string; state: string }): string {
  const part = (path: string): string => {
    const bytes = readBytesSync(path);
    if ('value' in bytes) return sha256Hex(bytes.value);
    return 'absent' in bytes ? '-' : `?${bytes.unknown}`;
  };
  return `${part(files.config)}|${part(files.state)}`;
}

/**
 * Читатель на каждый проход: держит последнее хорошее значение, сообщает новую жалобу один раз
 * за всё время, пока она держится. Прочитанный файл заменяет набор сказанного текущими жалобами
 * (B1r5-F08): починенное и снова сломанное поле названо снова. Нечитаемый файл — содержимое
 * неизвестно — жалобы на поля не забывает, только добавляет свою. Те же байты документа и памяти
 * писателя (отпечаток, не время правки: два письма за один тик часов ФС дали бы одно время) —
 * прежний ответ без разбора.
 */
export function queueConfigReader(
  path: string,
  defaults: QueueConfig = DEFAULT_QUEUE_CONFIG,
  onIssue: (issue: string) => void = () => {},
): () => QueueConfig {
  const files = configFilesOf({ config: path });
  let last = defaults;
  let seenKey: string | undefined;
  let told = new Set<string>();
  const tellAll = (issues: readonly string[], keep: boolean): void => {
    for (const issue of issues) if (!told.has(issue)) onIssue(issue);
    told = keep ? new Set([...told, ...issues]) : new Set(issues);
  };
  return () => {
    const key = keyOf(files);
    if (key === seenKey) return last;
    const read = readCoreConfig({ config: path });
    if ('absent' in read) {
      seenKey = key;
      tellAll([], false);
      last = defaults;
      return last;
    }
    if ('unknown' in read) {
      // Файл не прочитался — держим прежнее: «нет файла» вернуло бы умолчания вместо настройки.
      // Ключ не запоминается: следующий проход читает снова.
      seenKey = undefined;
      tellAll([read.unknown], true);
      return last;
    }
    seenKey = key;
    const got = queueSectionOf(read.value, defaults, last);
    tellAll(got.issues, false);
    last = got.config;
    return last;
  };
}
