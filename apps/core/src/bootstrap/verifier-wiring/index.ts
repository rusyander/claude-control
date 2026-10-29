import { createAdapterRegistry } from '../../adapters/index.ts';
import type { TaskRegistry } from '../../conductor/tasks.ts';
import type { CoreHomeLayout } from '../../platform/core-home.ts';
import { captureWiring, type CaptureWiring } from './capture.ts';
import { outcomesWiring, type OutcomesWiring } from './outcomes.ts';
import { profileWiring, type ProfileWiring } from './profile.ts';
import { queueWiring, type QueueWiring } from './queue.ts';
import { servicesWiring, type ServicesWiring } from './services.ts';
import { verifyWiring, type VerifyWiring } from './verify.ts';

/**
 * Проверки в сборе (04, этап 3): по файлу на зону, `boot-api.ts` берёт отсюда всё сразу. Зона
 * правит только свой файл и свою строку ниже — `boot-api.ts` и `boot.ts` ей не трогать.
 */

export interface VerifierWiringDeps {
  registry: TaskRegistry;
  layout: CoreHomeLayout;
  /** Журнал ядра — захват называет в нём непойманные дороги и итог забора очереди. */
  note?: (event: string, data: Record<string, unknown>) => void;
}

export interface VerifierWiring {
  verify: VerifyWiring;
  outcomes: OutcomesWiring;
  queue: QueueWiring;
  capture: CaptureWiring;
  profile: ProfileWiring;
  services: ServicesWiring;
}

let images: readonly string[] | undefined;
/**
 * Образы CLI для псевдозадач (A2-F02) — из реестра переходников, где живут имена CLI (P108):
 * захват узнаёт предка-CLI проверки, запущенной в сессии человека.
 */
function cliImages(): readonly string[] {
  images ??= [
    ...new Set(
      createAdapterRegistry()
        .all()
        .flatMap((a) => a.images),
    ),
  ];
  return images;
}

export function buildVerifierWiring(_deps: VerifierWiringDeps): VerifierWiring {
  // Одна обвязка очереди на сборку: захват спрашивает тот же вход, что инструмент модели (G21).
  // Сервисы — до очереди: её эпоха стенда и сервисы проверок — тот же реестр стендов зоны F.
  const services = servicesWiring(_deps);
  const queue = queueWiring({ ..._deps, services });
  return {
    verify: verifyWiring(_deps),
    outcomes: outcomesWiring(),
    queue,
    capture: captureWiring({ ..._deps, queue, images: cliImages }),
    profile: profileWiring(_deps),
    services,
  };
}
