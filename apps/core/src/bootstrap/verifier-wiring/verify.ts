import type { Fact } from '@agentdeck/contracts/core/facts';
import type { ModelToolDeps } from '../../conductor/model-tools/model-tools.types.ts';
import type { TaskRegistry } from '../../conductor/tasks.ts';
import type { CoreHomeLayout } from '../../platform/core-home.ts';
import { commonDirSync } from '../../platform/git.ts';
import {
  createRecordStore,
  loadVerifyKey,
  RECORD_ID,
  storeRoot,
  type RecordStore,
} from '../../verifier/store/index.ts';

/** Зона A (ключ, хранилище, решение): что проверки дают дороге модели. */
export type VerifyWiring = Pick<ModelToolDeps, 'records'>;

export interface VerifyWiringDeps {
  registry: Partial<Pick<TaskRegistry, 'liveTasks'>>;
  layout: Partial<Pick<CoreHomeLayout, 'root'>>;
}

/**
 * `records(id, taskId)` для `step_done` (P08): запись ищется в хранилищах репозиториев ТОЙ задачи,
 * что спрашивает, — одно хранилище на общий каталог git, так что основная папка и её копии видят
 * одни записи (04:33). Хранилища других задач не читаются: ни их записи, ни пути их репозиториев
 * в тексте `unknown` модели не уходят. Ключ подписи берётся из дома ядра при первом чтении.
 *
 * Ответ — только факт: нет записи — `absent`; хранилище или ключ не читаются и записи не
 * нашлось — `unknown` с причиной, никогда не «зелёный» (P44). Значение несёт привязку записи
 * (задача, кто исполнил, проверка) — по ней `step_done` отличает доказательство от обратной связи.
 */
export function verifyWiring(deps: VerifyWiringDeps): VerifyWiring {
  let key: Fact<Uint8Array> | null = null;
  const stores = new Map<string, RecordStore>();

  function signingKey(): Fact<Uint8Array> {
    if (key && 'value' in key) return key;
    // Неудача не запоминается: дом ядра мог появиться к следующему чтению.
    key = deps.layout.root
      ? loadVerifyKey(deps.layout.root)
      : { unknown: 'core home not laid out' };
    return key;
  }

  function roots(taskId: string): { roots: string[]; problems: string[] } {
    const out = new Set<string>();
    const problems: string[] = [];
    for (const task of deps.registry.liveTasks?.() ?? []) {
      if (task.taskId !== taskId) continue;
      for (const repo of task.state.created?.repos ?? []) {
        const common = commonDirSync(repo.path);
        if ('value' in common) out.add(storeRoot(common.value));
        else if ('unknown' in common) problems.push(`${repo.path}: ${common.unknown}`);
      }
    }
    return { roots: [...out].sort(), problems };
  }

  function storeAt(root: string, k: Uint8Array): RecordStore {
    const known = stores.get(root);
    if (known) return known;
    const store = createRecordStore({ root, key: k });
    stores.set(root, store);
    return store;
  }

  return {
    records(recordId, taskId) {
      if (!RECORD_ID.test(recordId)) return { absent: true };
      const found = roots(taskId);
      const problems = [...found.problems];
      if (found.roots.length > 0) {
        const k = signingKey();
        if (!('value' in k))
          return { unknown: `verify key: ${'unknown' in k ? k.unknown : 'absent'}` };
        for (const root of found.roots) {
          const fact = storeAt(root, k.value).record(recordId);
          if ('value' in fact) {
            const rec = fact.value;
            return {
              value: {
                verdict: rec.verdict.kind,
                checkId: rec.checkId,
                taskId: rec.taskId,
                origin: rec.origin,
              },
            };
          }
          if ('unknown' in fact) problems.push(`${root}: ${fact.unknown}`);
        }
      }
      return problems.length > 0 ? { unknown: problems.join('; ') } : { absent: true };
    },
  };
}
