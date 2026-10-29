import type { RouteRecorder } from '@agentdeck/contracts/core/routes';
import type { LiveTask } from '../../journal/resume.ts';
import { newId } from '../../lib/ids/uuidv7.ts';

/**
 * Решения и ресурсы маршрута в журнал ЗАДАЧИ (11 R:PR-01): маршрут журнал не импортирует и пишет
 * через данный ему `RouteRecorder`. Ресурс аренды — владельца `core` (его снимает маршрут при
 * освобождении аренды, а не поиск ресурсов сессии).
 */
export function journalRecorder(task: LiveTask): RouteRecorder {
  return {
    decision: (record) => {
      task.append({
        kind: 'decision',
        actor: 'core',
        data: {
          decisionId: newId(),
          class: record.class,
          inputs: [],
          facts: record.facts,
          numbers: record.numbers,
          reasons: record.reasons,
          output: JSON.parse(JSON.stringify(record.output ?? null)) as never,
        },
      });
    },
    created: (resource) => {
      task.append({
        kind: 'resource.created',
        actor: 'core',
        data: {
          rid: resource.rid,
          kind: resource.kind as never,
          owner: 'core',
          release: resource.release,
          ref: resource.ref,
        },
      });
    },
    verified: (rid, fact) => {
      task.append({ kind: 'resource.verified', actor: 'core', data: { rid, fact } });
    },
    leak: (rid, reason) => {
      task.append({ kind: 'resource.leak', actor: 'core', data: { rid, reason } });
    },
  };
}
