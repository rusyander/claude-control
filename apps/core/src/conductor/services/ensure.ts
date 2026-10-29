import type { Fact } from '@agentdeck/contracts/core/facts';
import type { ServiceEndpoint, ServiceRecipe } from '@agentdeck/contracts/core/records';
import { newId } from '../../lib/ids/uuidv7.ts';
import type { LiveTask } from '../../journal/resume.ts';
import {
  EPHEMERAL_LABEL,
  engineHandle,
  listByLabels,
  type EngineHandle,
} from '../../platform/container-engine.ts';
import {
  mainPort,
  serviceLabels,
  startService,
  type EnsureServices,
  type ServiceStartOptions,
  type StartedService,
} from '../../verifier/services/index.ts';
import { ActionFailed, runAction } from '../outbox.ts';
import { asServiceContainer, resourceRows, type ContainerHint } from './refs.ts';

/**
 * `ensureServices(task, needs)` (04:124-127, план §2): сервис на (задача, рецепт) поднимается
 * один раз за задачу, перед первой проверкой, которой он нужен. Запуск — действие outbox
 * `container-start` (fsync до эффекта; крах посреди — сверка по меткам, не второй запуск).
 * Каждый контейнер с метками задачи — ресурс `resource.created {release:'task-end'}`, даже если
 * готовности не дождались: снятие в конце задачи его найдёт (P40). Любой не-`value` — проверка
 * с сервисами получает `no-verdict(env)`, причина названа (P58).
 */

export interface ServicesDeps {
  task(taskId: string): LiveTask | undefined;
  recipes(taskId: string): Promise<readonly ServiceRecipe[]> | readonly ServiceRecipe[];
  /** Движок; по умолчанию проба `engineHandle()` (класс `engine.info`). */
  engine?: () => Promise<Fact<EngineHandle>>;
  start?: ServiceStartOptions;
}

function engineReason(engine: Fact<EngineHandle>): string {
  if ('absent' in engine) return 'engine-absent: no docker or podman CLI in PATH';
  if ('unknown' in engine) {
    return engine.unknown.startsWith('engine-down')
      ? engine.unknown
      : `engine-down: ${engine.unknown}`;
  }
  return '';
}

function failCode(reason: string): string {
  const m = /^(engine-down|not-ready)\b/.exec(reason);
  return m ? (m[1] as string) : 'start-failed';
}

/** Записать ресурсом каждый контейнер с метками задачи и рецепта, которого ещё нет в журнале. */
async function recordContainers(
  task: LiveTask,
  h: EngineHandle,
  labels: Record<string, string>,
  recipe: ServiceRecipe,
  startedId: string | undefined,
): Promise<void> {
  const known = new Set(
    resourceRows(task)
      .filter((row) => row.kind === 'container')
      .map((row) => asServiceContainer(row.ref)?.id)
      .filter((id): id is string => id !== undefined),
  );
  const listed = await listByLabels(h, { ...labels, [EPHEMERAL_LABEL]: '1' });
  const ids = new Set('value' in listed ? listed.value.map((row) => row.id) : []);
  // Список не прочитался — хотя бы запущенный записан; остальное (и крах до этой строки) найдёт
  // конец задачи по меткам начатого `container-start` (`releaseServices`).
  if (startedId) ids.add(startedId);
  for (const id of ids) {
    if ([...known].some((k) => k === id || k.startsWith(id) || id.startsWith(k))) continue;
    task.append({
      kind: 'resource.created',
      actor: 'core',
      data: {
        rid: newId(),
        kind: 'container',
        owner: 'core',
        release: 'task-end',
        ref: JSON.stringify({
          engine: h.info,
          id,
          recipe: recipe.name,
          port: mainPort(recipe),
          labels,
        }),
      },
    });
  }
}

export function createEnsureServices(deps: ServicesDeps): EnsureServices {
  return async (taskId, needs) => {
    const task = deps.task(taskId);
    if (!task) return { unknown: `task ${taskId} not live` };
    if (needs.length === 0) return { value: [] };
    const recipes = await deps.recipes(taskId);
    const missing = needs.filter((n) => !recipes.some((r) => r.name === n.service));
    if (missing.length > 0) {
      return { unknown: `recipe-missing: ${missing.map((n) => n.service).join(', ')}` };
    }
    const engine = await (deps.engine ?? (() => engineHandle()))();
    if (!('value' in engine)) return { unknown: engineReason(engine) };
    const h = engine.value;
    const out: ServiceEndpoint[] = [];
    for (const need of needs) {
      const recipe = recipes.find((r) => r.name === need.service) as ServiceRecipe;
      const labels = serviceLabels(taskId, recipe.name, deps.start?.extraLabels);
      const hint: ContainerHint = { labels, cli: h.info.cli, socket: h.info.socket };
      const box: { started?: Fact<StartedService> } = {};
      const done = await runAction(
        task,
        { kind: 'container-start', target: recipe.name, idempotencyHint: JSON.stringify(hint) },
        async () => {
          const started = await startService(h, taskId, recipe, deps.start ?? {});
          box.started = started;
          if (!('value' in started)) {
            const reason = 'unknown' in started ? started.unknown : 'absent';
            throw new ActionFailed(failCode(reason), reason);
          }
          return {
            id: started.value.engineId,
            hostPort: started.value.hostPort,
            reused: started.value.reused,
          };
        },
      );
      const started = box.started;
      const startedId = started && 'value' in started ? started.value.engineId : undefined;
      await recordContainers(task, h, labels, recipe, startedId);
      if (!done.ok || !started || !('value' in started)) {
        if (started && 'unknown' in started) return { unknown: started.unknown };
        return { unknown: `start ${recipe.name} failed${done.ok ? '' : `: ${done.code}`}` };
      }
      if (!started.value.endpoint) {
        return { unknown: `no-endpoint: recipe ${recipe.name} names no known scheme` };
      }
      out.push(started.value.endpoint);
    }
    return { value: out };
  };
}
