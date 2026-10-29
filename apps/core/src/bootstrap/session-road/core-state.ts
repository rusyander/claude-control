import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { Fact } from '@agentdeck/contracts/core/facts';
import type { JournalLine } from '@agentdeck/contracts/core/journal';
import { readJournalLines } from '../../journal/read-lines.ts';
import type { LiveTask } from '../../journal/resume.ts';
import { reasonOf } from '../../platform/os-kind.ts';
import { writeFileAtomic } from '../../platform/safe-io/atomic-write.ts';
import { readBytesSync } from '../../platform/safe-io/files.ts';

/**
 * Снимки ядра о сессии (снимок ресурсов P90, снимок защищённых корней P04) — НЕ в каталоге
 * сессии: его пишет любой процесс дерева сессии (P04: право не судит текст команды), и снимок
 * оттуда решал бы, какой движок ядро запустит и чьи копии снимет (ревью B2r4-F02, B2r4-F04).
 * Источник правды — память дороги; файл в доме ядра нужен только сессии, прикреплённой заново
 * после перезапуска, и принимается лишь с отпечатком, который ядро записало в журнал задачи
 * (цепочка хэшей журнала) ДО запуска сессии. Отпечаток не сошёлся или его нет — `unknown`.
 */

export const SNAPSHOT_SIGNAL = 'session-snapshot';

const digestOf = (text: string): string =>
  `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;

const pathOf = (root: string, sessionId: string, name: string): string =>
  join(root, sessionId, name);

/** Записать снимок в дом ядра и его отпечаток — в журнал задачи. */
export function writeSessionState(
  task: LiveTask,
  root: string,
  sessionId: string,
  name: string,
  doc: unknown,
): void {
  const text = JSON.stringify(doc);
  writeFileAtomic(pathOf(root, sessionId, name), text);
  task.append({
    kind: 'signal',
    actor: 'core',
    sessionId,
    data: { signal: SNAPSHOT_SIGNAL, severity: 'info', subject: name, detail: digestOf(text) },
  });
}

/** Отпечаток снимка, записанный ядром для этой сессии; не записывался — `undefined`. */
export function journaledDigest(
  task: LiveTask,
  sessionId: string,
  name: string,
): string | undefined {
  let digest: string | undefined;
  for (const line of readJournalLines(task.dir, task.taskId).lines) {
    if (line.kind !== 'signal' || line.sessionId !== sessionId) continue;
    const data = (line as JournalLine<'signal'>).data;
    if (data.signal === SNAPSHOT_SIGNAL && data.subject === name) digest = data.detail;
  }
  return digest;
}

/**
 * Снимок с диска — только если его отпечаток совпал с журнальным. Нет файла и нет отпечатка —
 * `absent` (сессия без снимка); иначе любое расхождение — `unknown` с причиной.
 */
export function readSessionState(
  task: LiveTask,
  root: string,
  sessionId: string,
  name: string,
): Fact<unknown> {
  let want: string | undefined;
  try {
    want = journaledDigest(task, sessionId, name);
  } catch (error) {
    return { unknown: `${name}: journal: ${reasonOf(error)}` };
  }
  const bytes = readBytesSync(pathOf(root, sessionId, name));
  if ('unknown' in bytes) return { unknown: `${name}: ${bytes.unknown}` };
  if ('absent' in bytes) {
    return want === undefined
      ? { absent: true }
      : { unknown: `${name}: written by the core, now missing` };
  }
  const text = bytes.value.toString('utf8');
  if (want === undefined) return { unknown: `${name}: no digest in the task journal` };
  if (digestOf(text) !== want) return { unknown: `${name}: changed after the core wrote it` };
  try {
    return { value: JSON.parse(text) as unknown };
  } catch (error) {
    return { unknown: `${name}: ${reasonOf(error)}` };
  }
}
