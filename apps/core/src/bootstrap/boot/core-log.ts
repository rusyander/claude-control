import { join } from 'node:path';
import type { RouteRecorder } from '@agentdeck/contracts/core/routes';
import type { CoreHomeLayout } from '../../platform/core-home.ts';
import { openAppendLog } from '../../platform/safe-io/append-log.ts';
import type { Note } from './boot.types.ts';

/** Журнал ядра `logs/core.jsonl`: заметка загрузки и закрытие, после которого заметки теряются. */
export interface CoreLog {
  note: Note;
  close(): void;
}

export function openCoreLog(layout: CoreHomeLayout): CoreLog {
  const coreLog = openAppendLog(join(layout.logs, 'core.jsonl'));
  let closed = false;
  // Сессии, оставленные жить при остановке (`keep`), ещё прикреплены к этому процессу: их поток
  // может дописать заметку после закрытия журнала ядра — она теряется, а не роняет процесс.
  return {
    note: (event, data) => {
      if (closed) return;
      coreLog.append(Buffer.from(`${JSON.stringify({ at: Date.now(), event, ...data })}\n`));
    },
    close: () => {
      closed = true;
      coreLog.close();
    },
  };
}

/** Решения маршрута вне аренды задачи (снятое место ждущего упавшего ядра) — в журнал ядра. */
export function routeJournalOf(note: Note): RouteRecorder {
  return {
    decision: (record) => note('route.decision', { record }),
    created: (resource) => note('route.created', { resource }),
    verified: (rid, fact) => note('route.released', { rid, fact }),
    leak: (rid, reason) => note('route.leak', { rid, reason }),
  };
}
