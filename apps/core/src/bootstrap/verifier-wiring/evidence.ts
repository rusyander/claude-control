import type { Fact } from '@agentdeck/contracts/core/facts';
import type { CheckRequest } from '@agentdeck/contracts/core/records';
import type {
  EvidenceReader,
  SessionBinding,
} from '../../conductor/model-tools/model-tools.types.ts';
import type { LiveTask } from '../../journal/resume.ts';
import { diffUnit } from '../../platform/git.ts';
import { closureOf } from '../../verifier/key/index.ts';
import { classOf, type QueueWiring } from './queue.ts';

/**
 * Читатель свежести и охвата доказательства для `step_done` (G22, P92): ключ записи пересчитывается
 * на ТЕКУЩЕМ дереве теми же чтениями, что вход проверок (`queue.parts()` — реестр, ключ), и
 * сравнивается с ключом записи; замыкание единицы записи — из реестра; изменённые файлы —
 * дифф единицы против базы задачи (`git.diff-unit`). Любое нечитаемое — `unknown` с причиной:
 * `step_done` отказывает, никогда не принимает (P44).
 *
 * Копия — папка репозитория единицы шага (как `contextOf` очереди): пока копий нет (G7), это папка
 * репозитория задачи.
 */

const why = (f: Fact<unknown>): string => ('unknown' in f ? f.unknown : 'absent');

function repoOf(task: LiveTask, b: SessionBinding) {
  const repos = task.state.created?.repos ?? [];
  const repoKey = task.state.units[b.unitId]?.repoKey;
  return repos.find((r) => r.repoKey === repoKey) ?? repos[0];
}

/** Единица `''` и `.` — вся копия (как `argv.ts` прогона); иначе замыкание по реестру. */
function closureFor(registry: Parameters<typeof closureOf>[0], unit: string): Fact<string[]> {
  if (unit === '' || unit === '.') return { value: [''] };
  if (!registry.units[unit]) return { unknown: `unit ${unit} is no longer in the registry` };
  return { value: closureOf(registry, unit) };
}

export function evidenceWiring(queue: Pick<QueueWiring, 'parts'>): EvidenceReader {
  return {
    async now(task, b, record) {
      const repo = repoOf(task, b);
      if (!repo) return { unknown: 'task has no repository pinned' };
      const parts = await queue.parts();
      if (!('value' in parts)) return { unknown: `verifier not ready: ${why(parts)}` };
      const { deps } = parts.value;
      const req: CheckRequest = {
        road: 'model-tool',
        origin: 'core',
        taskId: task.taskId,
        stepId: b.stepId,
        project: repo.repoKey,
        copyDir: repo.path,
        class: classOf(b.stepKind),
        phase: b.stepKind === 'final-gate' ? 'final' : 'mid-task',
        checkId: record.checkId,
        unit: record.unit,
        selection: record.selection,
        changedUnits: [],
        exec: 'core',
      };
      const registry = await deps.registry(req);
      if (!('value' in registry)) return { unknown: `registry: ${why(registry)}` };
      const entry = registry.value.checks.find((c) => c.id === record.checkId);
      // Проверки больше нет в реестре — ключ не пересчитать: сомнение, не «свежо».
      if (!entry) return { unknown: `check ${record.checkId} is no longer in the registry` };
      const closure = closureFor(registry.value, record.unit);
      if (!('value' in closure)) return closure;
      const key = await deps.key({
        req,
        entry,
        registry: registry.value,
        unit: record.unit,
        selection: record.selection,
      });
      if (!('value' in key)) return { unknown: `key: ${why(key)}` };
      return { value: { key: key.value.key, class: entry.class, closure: closure.value } };
    },
    async changed(task, b) {
      const repo = repoOf(task, b);
      if (!repo) return { unknown: 'task has no repository pinned' };
      // Базы нет (псевдозадача) — от чего считать дифф, неизвестно: сомнение, не «пусто».
      if (repo.baseRef === null) return { unknown: 'task has no base revision' };
      return diffUnit(repo.path, repo.baseRef);
    },
  };
}
