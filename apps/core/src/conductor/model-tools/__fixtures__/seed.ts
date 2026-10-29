import type { LiveTask } from '../../../journal/resume.ts';
import { newId } from '../../../lib/ids/uuidv7.ts';
import type { ModelToolDeps, RecordFacts, RecordVerdict } from '../model-tools.types.ts';

/**
 * Живая сессия шага в журнале — ровно теми строками, какими её пишет ядро: единица, шаг в
 * работе, сессия запущена. Инструменты модели решают только по этим строкам (F05).
 */

export interface SeededSession {
  unitId: string;
  stepId: string;
  sessionId: string;
}

export function seedSession(
  task: LiveTask,
  opts: { stepKind: string; hostPid?: number; unitId?: string },
): SeededSession {
  const unitId = opts.unitId ?? newId();
  if (!task.state.units[unitId]) {
    task.append({
      kind: 'unit.created',
      actor: 'core',
      unitId,
      data: { unitId, repoKey: 'r1', branch: `agentdeck/${unitId.slice(0, 8)}`, ownedPaths: [] },
    });
  }
  const stepId = newId();
  task.append({
    kind: 'step.started',
    actor: 'core',
    unitId,
    stepId,
    data: { stepId, unitId, stepKind: opts.stepKind, budgetMs: 600_000 },
  });
  task.append({
    kind: 'step.transition',
    actor: 'core',
    stepId,
    data: { stepId, event: 'start', from: 'queued', to: 'running' },
  });
  const sessionId = newId();
  const hostPid = opts.hostPid ?? process.pid;
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
      hostPid,
      hostStart: `start-${hostPid}`,
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
  return { unitId, stepId, sessionId };
}

/**
 * Записи проверок по номеру: тест кладёт вердикты; чего нет — `absent`, как в фазе 2. Вердикт —
 * запись ядра этой же задачи по проверке реестра; иное (чужая задача, сеанс) — полными фактами.
 */
export function toolDeps(
  records: Record<string, RecordVerdict | 'unreadable' | RecordFacts> = {},
): ModelToolDeps {
  return {
    records(recordId, taskId) {
      const v = records[recordId];
      if (v === undefined) return { absent: true };
      if (v === 'unreadable') return { unknown: 'record file locked' };
      if (typeof v === 'object') return { value: v };
      return { value: { verdict: v, checkId: 'tests', taskId, origin: 'core' } };
    },
    humanPolicy: {
      actionClasses: ['schema-change'],
      pathGlobs: ['infra/**'],
      grantRequired: [{ globs: ['migrations/**'], ops: ['edit'] }],
      trackerWrites: 'ask',
      forgeWrites: 'auto',
    },
  };
}
