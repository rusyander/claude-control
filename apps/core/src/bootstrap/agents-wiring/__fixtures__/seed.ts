import { FIRST_ROUND, SOLO_UNIT } from '../../../journal/__fixtures__/journal-harness.ts';
import type { LiveTask } from '../../../journal/resume.ts';
import { newId } from '../../../lib/ids/uuidv7.ts';
import type { ProcessIdentity } from '../../../platform/process-identity.ts';
import type { GoldenIds } from '../../../journal/reduce/__fixtures__/agents-golden.ts';

/**
 * Сессия шага с НАСТОЯЩЕЙ личностью хоста (pid + время начала из таблицы ОС): сверка загрузки
 * и сторож фона судят хост по ней — выдуманное начало сделало бы сессию потерянной на первом
 * же такте. Строки те же, что пишет ядро: единица, шаг в работе, сессия запущена и жива.
 */
export function seedLiveSession(task: LiveTask, host: ProcessIdentity): GoldenIds {
  const unitId = newId();
  task.append({
    kind: 'unit.created',
    actor: 'core',
    unitId,
    data: {
      unitId,
      repoKey: 'r1',
      branch: `agentdeck/${unitId.slice(0, 8)}`,
      ownedPaths: [],
      ...SOLO_UNIT,
    },
  });
  const stepId = newId();
  task.append({
    kind: 'step.started',
    actor: 'core',
    unitId,
    stepId,
    data: { stepId, unitId, stepKind: 'work', budgetMs: 600_000, ...FIRST_ROUND },
  });
  task.append({
    kind: 'step.transition',
    actor: 'core',
    stepId,
    data: { stepId, event: 'start', from: 'queued', to: 'running' },
  });
  const sessionId = newId();
  task.append({
    kind: 'session.started',
    actor: 'core',
    stepId,
    sessionId,
    data: {
      sessionId,
      stepId,
      adapter: 'claude',
      cliVersion: '1',
      route: { kind: 'stub', id: 'stub-1' },
      hops: [],
      credentialKind: 'none',
      modelAsked: 'model-a',
      modelServed: null,
      effort: null,
      hostPid: host.pid,
      hostStart: host.start,
      cliPid: null,
      cliStart: null,
      cwd: '/w',
      argv: [],
      resumeOf: null,
      cacheAgeMs: null,
    },
  });
  task.append({
    kind: 'session.transition',
    actor: 'core',
    sessionId,
    data: { sessionId, event: 'spawned', from: 'starting', to: 'live' },
  });
  return { taskId: task.taskId, unitId, stepId, sessionId };
}
