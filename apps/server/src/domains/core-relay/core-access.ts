import type { TaskReply, TasksReply } from '@agentdeck/contracts/core/panel-api';
import {
  createCoreIdentityDeps,
  type CoreIdentityDeps,
} from '../../lib/listen-identity/listen-identity.ts';
import {
  forwardToCore,
  locateCore,
  verifyCore,
  type CoreLocation,
} from '../core-proxy/core-proxy.ts';
import type { CoreRelayCore, CoreSseEvent } from './core-relay.types.ts';
import { parseSse } from './sse.ts';

/**
 * Доступ пересылки к ядру — тем же путём, что прокладка панели (зона C): строка `procs.json`,
 * сверка ОС до отправки токена (F-19), запрос на loopback. Не сверилось — токен не уходит, круг
 * пропущен. Кода ядра здесь нет (граница depcruise).
 */
export function createCoreAccess(
  home: () => string,
  identity: (port: number) => CoreIdentityDeps = createCoreIdentityDeps(),
): CoreRelayCore {
  const located = async (): Promise<CoreLocation> => {
    const core = locateCore(home());
    if ('missing' in core) throw new Error(core.missing);
    const proven = await verifyCore(core, identity(core.entry.port));
    if (!('value' in proven)) {
      throw new Error(
        `core entry not verified: ${'unknown' in proven ? proven.unknown : 'absent'}`,
      );
    }
    return core;
  };
  const getJson = async <T>(path: string): Promise<T> => {
    const res = await forwardToCore(await located(), { method: 'GET', path });
    if (!res.ok) throw new Error(`GET ${path}: ${res.status}`);
    return (await res.json()) as T;
  };
  return {
    async tasks() {
      const reply = await getJson<TasksReply>('/v1/tasks');
      return reply.tasks.map(({ taskId, live, title }) => ({ taskId, live, title }));
    },
    async askState(taskId, askId) {
      const reply = await getJson<TaskReply>(`/v1/tasks/${encodeURIComponent(taskId)}`);
      return reply.view.asks.find((ask) => ask.askId === askId)?.state ?? null;
    },
    async *events(taskId, lastEventId, signal): AsyncGenerator<CoreSseEvent> {
      const res = await forwardToCore(await located(), {
        method: 'GET',
        path: `/v1/tasks/${encodeURIComponent(taskId)}/events`,
        signal,
        ...(lastEventId !== undefined ? { lastEventId } : {}),
      });
      if (!res.ok || !res.body) throw new Error(`events ${taskId}: ${res.status}`);
      yield* parseSse(res.body);
    },
  };
}
