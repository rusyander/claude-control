import type { ActiveRunView } from '@shared/lib/agent-runs';
import type { RunEvent, RunSnapshot } from './runEvents.types';

/** Ход дольше этого — «долгий»: его конец Дека отмечает отдельной репликой, мс. */
export const LONG_RUN_MS = 10 * 60_000;

/** Снимок активных прогонов: id → статус и то, чем его назвать в реплике. */
export function snapshotRuns(runs: ActiveRunView[]): RunSnapshot {
  return new Map(
    runs.map((run) => [
      run.id,
      {
        status: run.status,
        sessionId: run.sessionId,
        projectPath: run.projectPath,
        ...(run.startedAt !== undefined ? { startedAt: run.startedAt } : {}),
        ...(run.limitHit ? { limitHit: true } : {}),
      },
    ]),
  );
}

/**
 * Что изменилось между двумя снимками — то, о чём Деке стоит сказать:
 *
 *   ask   — прогон встал на вопрос (стал `waiting`);
 *   limit — лимит подписки отказал ходу; упавший из-за лимита ход — это
 *           `limit`, а не `error`: причина названа, «что-то сломалось» лишнее;
 *   error — прогон упал (стал `error`);
 *   done  — прогон ушёл из активных, пока работал или ждал. Ушедший из `error`
 *           — это человек убрал ошибку, а не готовый ход: молчим. Шёл дольше
 *           `LONG_RUN_MS` — с пометкой `long`.
 *
 * Первый снимок (`previous` нет) событий не даёт: открыть панель посреди чужих
 * прогонов — не повод поздравлять с каждым.
 */
export function diffRuns(
  previous: RunSnapshot | undefined,
  runs: ActiveRunView[],
  now: number = Date.now(),
): RunEvent[] {
  if (!previous) return [];
  const events: RunEvent[] = [];
  const seen = new Set<string>();

  for (const run of runs) {
    seen.add(run.id);
    const before = previous.get(run.id);
    const target = { id: run.id, sessionId: run.sessionId, projectPath: run.projectPath };
    if (run.status === 'waiting' && before?.status !== 'waiting') {
      events.push({ kind: 'ask', ...target });
    }
    if (run.limitHit && !before?.limitHit) {
      events.push({ kind: 'limit', ...target });
    } else if (run.status === 'error' && before?.status !== 'error' && !run.limitHit) {
      events.push({ kind: 'error', ...target });
    }
  }

  for (const [id, before] of previous) {
    if (seen.has(id) || before.status === 'error') continue;
    const long = before.startedAt !== undefined && now - before.startedAt >= LONG_RUN_MS;
    events.push({
      kind: 'done',
      id,
      sessionId: before.sessionId,
      projectPath: before.projectPath,
      ...(long ? { long: true } : {}),
    });
  }

  return events;
}
