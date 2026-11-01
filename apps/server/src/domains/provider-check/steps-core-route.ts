import type { ProviderCheckStep } from '@agentdeck/contracts';
import { CORE_API_PREFIX, type RouteView } from '@agentdeck/contracts/core/panel-api';
import type { CoreIdentityDeps } from '../../lib/listen-identity/listen-identity.ts';
import { serverText } from '../../lib/server-texts/server-texts.ts';
import { forwardToCore, locateCore, verifyCore } from '../core-proxy/core-proxy.ts';
import { reason, step } from './step.ts';

/**
 * Шаг «маршрут ядра»: видит ли ядро исполнения задач вход этого CLI (`cli-login:<id>`), есть ли у
 * маршрута доступ и не исчерпан ли он. Проверка провайдера спрашивает ядро тем же путём, что и
 * прокладка панели: строка `procs.json` → сверка ОС → bearer → `GET /v1/routes`. Строку, которую
 * ОС не подтвердила, проверка не трогает вовсе — токен ядра не уходит неизвестно кому (F-19).
 *
 * Ядро — отдельный процесс, и его может не быть: тогда шаг пропущен с причиной, а не
 * предупреждён. Уровень провайдера описывает CLI на этой машине; незапущенное ядро его не портит.
 */

/** Что вернуло чтение маршрутов ядра: список или причина, по которой его нет. */
export type CoreRoutesRead =
  { routes: RouteView[] } | { absent: string } | { unverified: string } | { unreachable: string };

export type CoreRoutesReader = () => Promise<CoreRoutesRead>;

export interface CoreRoutesReaderDeps {
  /** Дом ядра (`procs.json`, `token`). */
  home(): string;
  /** Чтения ОС для сверки строки ядра. */
  identity(port: number): CoreIdentityDeps;
  /** Сколько ждать ответа ядра, мс. */
  timeoutMs?: number;
}

const isRouteView = (value: unknown): value is RouteView => {
  if (typeof value !== 'object' || value === null) return false;
  const row = value as Record<string, unknown>;
  const credential = row.credential as Record<string, unknown> | null | undefined;
  return (
    typeof row.id === 'string' &&
    typeof row.exhausted === 'boolean' &&
    (credential === null ||
      (typeof credential === 'object' && typeof credential?.present === 'boolean'))
  );
};

/** Чтение маршрутов ядра через сверенную строку; домен получает только примитивы. */
export function createCoreRoutesReader(deps: CoreRoutesReaderDeps): CoreRoutesReader {
  return async () => {
    const core = locateCore(deps.home());
    if ('missing' in core) return { absent: core.missing };
    const os = deps.identity(core.entry.port);
    const proven = await verifyCore(core, os);
    if (!('value' in proven)) {
      const why = 'unknown' in proven ? proven.unknown : 'absent';
      // Процесса строки нет — ядро не запущено (строка осталась от убитого); процесс есть, а
      // порт слушает не он — строка не подтверждена. Как у прокладки панели.
      if ((await os.exists(core.entry.pid)) === false)
        return { absent: `core pid ${core.entry.pid} is gone: ${why}` };
      return { unverified: why };
    }
    try {
      const got = await forwardToCore(core, {
        method: 'GET',
        path: `${CORE_API_PREFIX}/routes`,
        signal: AbortSignal.timeout(deps.timeoutMs ?? 5_000),
      });
      if (!got.ok) return { unreachable: `HTTP ${got.status}` };
      const body = (await got.json()) as { routes?: unknown };
      if (!Array.isArray(body.routes) || !body.routes.every(isRouteView))
        return { unreachable: 'not a routes reply' };
      return { routes: body.routes };
    } catch (error) {
      return { unreachable: reason(error) };
    }
  };
}

/** Итог шага по маршруту `cli-login:<providerId>`. */
export async function checkCoreRoute(
  providerId: string,
  read: CoreRoutesReader,
): Promise<ProviderCheckStep> {
  const got = await read();
  if ('absent' in got) return step('coreRoute', 'skipped', serverText('checks-core-route-absent'));
  if ('unverified' in got)
    return step(
      'coreRoute',
      'skipped',
      serverText('checks-core-route-unverified', { reason: got.unverified }),
    );
  if ('unreachable' in got)
    return step(
      'coreRoute',
      'skipped',
      serverText('checks-core-route-unreachable', { reason: got.unreachable }),
    );
  const id = `cli-login:${providerId}`;
  const route = got.routes.find((item) => item.id === id);
  if (!route)
    return step('coreRoute', 'skipped', serverText('checks-core-route-none', { route: id }));
  // Исчерпан — задачи на нём не запустятся, что бы ни было с доступом: это первое, что важно.
  if (route.exhausted)
    return step('coreRoute', 'warn', serverText('checks-core-route-exhausted', { route: id }));
  // `null` — ядро наличие входа не прочитало: хранилище входа CLI оно не читает по построению,
  // и считать это отсутствием доступа значило бы занизить уровень каждому CLI без причины.
  if (route.credential === null)
    return step(
      'coreRoute',
      'skipped',
      serverText('checks-core-route-credential-unknown', { route: id }),
    );
  if (!route.credential.present)
    return step('coreRoute', 'warn', serverText('checks-core-route-no-credential', { route: id }));
  return step('coreRoute', 'pass', serverText('checks-core-route-ok', { route: id }));
}
