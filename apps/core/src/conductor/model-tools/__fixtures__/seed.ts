import { FIRST_ROUND, SOLO_UNIT } from '../../../journal/__fixtures__/journal-harness.ts';
import type { LiveTask } from '../../../journal/resume.ts';
import { newId } from '../../../lib/ids/uuidv7.ts';
import type { HumanPointPolicy } from '../../../policy/human-point/human-point.types.ts';
import type { ModelToolDeps, RecordFacts, RecordVerdict } from '../model-tools.types.ts';

/** Политика человека стенда: свой класс, маска и строка гранта — тесты пункта 5 судят по ним. */
export const SEED_HUMAN_POLICY: HumanPointPolicy = {
  actionClasses: ['schema-change'],
  pathGlobs: ['infra/**'],
  grantRequired: [{ globs: ['migrations/**'], ops: ['edit'] }],
  trackerWrites: 'ask',
  forgeWrites: 'auto',
};

/**
 * Живая сессия шага в журнале — ровно теми строками, какими её пишет ядро: единица, шаг в
 * работе, сессия запущена. Инструменты модели решают только по этим строкам (F05).
 */

/** Id требований в заявках шага — UUIDv7, как их выдаёт ядро (02:54); проза id не годится. */
export const R1 = '01920000-0000-7000-8000-00000000b001';
export const R2 = '01920000-0000-7000-8000-00000000b002';

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
      data: {
        unitId,
        repoKey: 'r1',
        branch: `agentdeck/${unitId.slice(0, 8)}`,
        ownedPaths: [],
        ...SOLO_UNIT,
      },
    });
  }
  const stepId = newId();
  task.append({
    kind: 'step.started',
    actor: 'core',
    unitId,
    stepId,
    data: { stepId, unitId, stepKind: opts.stepKind, budgetMs: 600_000, ...FIRST_ROUND },
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

/** Ключ записи в заглушке; читатель свежести по умолчанию видит то же дерево (G22). */
export const RECORD_KEY = 'a'.repeat(64);

/**
 * Требования задачи — строками `requirement.extracted`, как их пишет извлечение (G3): заявка шага
 * цитирует только id ядра, иначе `unknown-requirement`.
 */
export function seedRequirements(task: LiveTask, ids: readonly string[] = [R1, R2]): void {
  ids.forEach((requirementId, i) =>
    task.append({
      kind: 'requirement.extracted',
      actor: 'core',
      data: {
        requirementId,
        ordinal: i + 1,
        text: `requirement ${i + 1}`,
        source: 'request',
        stepId: null,
      },
    }),
  );
}

/**
 * Записи проверок по номеру: тест кладёт вердикты; чего нет — `absent`, как в фазе 2. Вердикт —
 * запись ядра этой же задачи по проверке реестра; иное (чужая задача, сеанс) — полными фактами.
 * Свежесть по умолчанию: ключ на дереве равен ключу записи, проверка тестовая, единица `.`
 * покрывает изменённый файл; тест подменяет `evidence`, где проверяет именно её.
 */
export function toolDeps(
  records: Record<string, RecordVerdict | 'unreadable' | Partial<RecordFacts>> = {},
): ModelToolDeps {
  return {
    records(recordId, taskId) {
      const v = records[recordId];
      if (v === undefined) return { absent: true };
      if (v === 'unreadable') return { unknown: 'record file locked' };
      const base: RecordFacts = {
        verdict: 'pass',
        checkId: 'tests',
        taskId,
        origin: 'core',
        key: RECORD_KEY,
        unit: '.',
        selection: [],
      };
      return { value: typeof v === 'object' ? { ...base, ...v } : { ...base, verdict: v } };
    },
    evidence: {
      now: async (_task, _b, record) => ({
        value: { key: record.key, class: 'test-runner', closure: [''] },
      }),
      changed: async () => ({ value: ['src/a.ts'] }),
    },
    humanPolicy: () => SEED_HUMAN_POLICY,
  };
}
