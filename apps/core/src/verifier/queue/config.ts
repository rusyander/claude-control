import type { QueueConfig } from '@agentdeck/contracts/core/records';
import { readBytesSync } from '../../platform/safe-io/files.ts';
import { DEFAULT_QUEUE_CONFIG, MIN_BEAT_MS } from './order.ts';

/**
 * Раздел `queue` из `<core home>/config.json` (00:58, пишет только API ядра). Перечитывается на
 * каждом проходе очереди (D§3.8: «slots from config, re-read per poll»). Негодное поле не роняет
 * очередь: берётся прежнее хорошее значение (или умолчание), а поле названо в `issues` — тихо
 * подставленное число скрыло бы, что настройка не действует.
 */

export interface QueueConfigRead {
  config: QueueConfig;
  issues: string[];
}

function within(v: unknown, min: number, max: number): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 && v >= min && v <= max
    ? v
    : undefined;
}

/**
 * `defaults` — для того, чего в файле нет (убранный раздел или поле — это «по умолчанию»);
 * `last` — прежнее хорошее значение для того, что есть, но негодно (A1r3-F07: мусор в файле не
 * сбрасывает рабочую настройку на умолчание).
 */
export function parseQueueSection(
  text: string,
  defaults: QueueConfig,
  last: QueueConfig = defaults,
): QueueConfigRead {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { config: last, issues: [`config.json not JSON: ${(error as Error).message}`] };
  }
  const section =
    typeof parsed === 'object' && parsed !== null
      ? (parsed as { queue?: unknown }).queue
      : undefined;
  if (section === undefined) return { config: defaults, issues: [] };
  if (typeof section !== 'object' || section === null)
    return { config: last, issues: ['queue: not an object'] };
  const s = section as Record<string, unknown>;
  const issues: string[] = [];
  const pick = (field: keyof QueueConfig, max: number, integer: boolean, min = 0): number => {
    if (s[field] === undefined) return defaults[field];
    const v = within(s[field], min, max);
    if (v === undefined || (integer && !Number.isInteger(v))) {
      issues.push(`queue.${field}: ${JSON.stringify(s[field])} rejected`);
      return last[field];
    }
    return v;
  };
  return {
    config: {
      slots: pick('slots', 256, true),
      shareCap: pick('shareCap', 1, false),
      agingMs: pick('agingMs', 24 * 3_600_000, true),
      // Ниже пола держатели всё равно бьют на полу — очередь судила бы их чаще, чем они бьют.
      beatMs: pick('beatMs', 600_000, true, MIN_BEAT_MS),
    },
    issues,
  };
}

/**
 * Читатель на каждый проход: держит последнее хорошее значение, сообщает новую жалобу один раз
 * за всё время, пока она держится. Прочитанный файл заменяет набор сказанного текущими жалобами
 * (B1r5-F08): починенное и снова сломанное поле названо снова. Нечитаемый файл — содержимое
 * неизвестно — жалобы на поля не забывает, только добавляет свою.
 */
export function queueConfigReader(
  path: string,
  defaults: QueueConfig = DEFAULT_QUEUE_CONFIG,
  onIssue: (issue: string) => void = () => {},
): () => QueueConfig {
  let last = defaults;
  let told = new Set<string>();
  const tellAll = (issues: readonly string[], keep: boolean): void => {
    for (const issue of issues) if (!told.has(issue)) onIssue(issue);
    told = keep ? new Set([...told, ...issues]) : new Set(issues);
  };
  return () => {
    const bytes = readBytesSync(path);
    if ('absent' in bytes) {
      tellAll([], false);
      last = defaults;
      return last;
    }
    if ('unknown' in bytes) {
      // Файл не прочитался — держим прежнее: «нет файла» вернуло бы умолчания вместо настройки.
      tellAll([`config.json unreadable: ${bytes.unknown}`], true);
      return last;
    }
    const read = parseQueueSection(bytes.value.toString('utf8'), defaults, last);
    tellAll(read.issues, false);
    last = read.config;
    return last;
  };
}
