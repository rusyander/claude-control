import { releaseServices, type ReleaseDeps } from '../../conductor/services.ts';
import type { LiveTask } from '../../journal/resume.ts';
import type { RouteRegistry } from '../../routes/registry.ts';
import { releaseTaskLeases, type TakenLease } from './lease-release.ts';
import { releaseTaskResources } from './resources.ts';
import type { TaskRelease } from './road.types.ts';

/**
 * Конец задачи дороги сессии (01 §Resources, P40, P90) — один владелец: сначала то, что оставили
 * сессии, потом ресурсы ядра `task-end` (контейнеры сервисов, стенд со снятием с наблюдения,
 * ревью A2r5-F04), потом аренды маршрутов (сервер модели — последним). Непрочитанные снимки шагов
 * идут в ответ (`unread`), а не теряются за пустыми списками.
 */
export async function releaseTaskEnd(
  task: LiveTask,
  input: {
    liveCopies: readonly string[];
    routes: RouteRegistry;
    leases: readonly TakenLease[];
    stands?: ReleaseDeps['stands'];
  },
): Promise<TaskRelease> {
  const own = await releaseTaskResources(task, { liveCopies: input.liveCopies });
  const services = await releaseServices(task, input.stands ? { stands: input.stands } : {});
  const routed = await releaseTaskLeases(task, input.routes, input.leases);
  const out: TaskRelease = {
    verified: [...own.verified],
    leaks: [...own.leaks],
    unread: [...own.unread],
  };
  for (const got of services) {
    if ('verified' in got) out.verified.push({ rid: got.rid, fact: got.verified });
    else if ('leak' in got) out.leaks.push({ rid: got.rid, reason: got.leak });
  }
  out.verified.push(...routed.verified);
  out.leaks.push(...routed.leaks);
  return out;
}
