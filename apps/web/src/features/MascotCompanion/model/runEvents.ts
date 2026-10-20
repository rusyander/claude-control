import type { ActiveRunView } from '@shared/lib/agent-runs';
import type { RunEvent, RunSnapshot } from './runEvents.types';

/** Снимок активных прогонов: id → статус и то, чем его назвать в реплике. */
export function snapshotRuns(runs: ActiveRunView[]): RunSnapshot {
  return new Map(
    runs.map((run) => [
      run.id,
      { status: run.status, sessionId: run.sessionId, projectPath: run.projectPath },
    ]),
  );
}

/**
 * Что изменилось между двумя снимками — то, о чём Деке стоит сказать:
 *
 *   ask   — прогон встал на вопрос (стал `waiting`);
 *   error — прогон упал (стал `error`);
 *   done  — прогон ушёл из активных, пока работал или ждал. Ушедший из `error`
 *           — это человек убрал ошибку, а не готовый ход: молчим.
 *
 * Первый снимок (`previous` нет) событий не даёт: открыть панель посреди чужих
 * прогонов — не повод поздравлять с каждым.
 */
export function diffRuns(previous: RunSnapshot | undefined, runs: ActiveRunView[]): RunEvent[] {
  if (!previous) return [];
  const events: RunEvent[] = [];
  const seen = new Set<string>();

  for (const run of runs) {
    seen.add(run.id);
    const before = previous.get(run.id)?.status;
    const target = { id: run.id, sessionId: run.sessionId, projectPath: run.projectPath };
    if (run.status === 'waiting' && before !== 'waiting') events.push({ kind: 'ask', ...target });
    if (run.status === 'error' && before !== 'error') events.push({ kind: 'error', ...target });
  }

  for (const [id, before] of previous) {
    if (seen.has(id) || before.status === 'error') continue;
    events.push({ kind: 'done', id, sessionId: before.sessionId, projectPath: before.projectPath });
  }

  return events;
}
