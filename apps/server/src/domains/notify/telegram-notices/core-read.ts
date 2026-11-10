import type { BoardEntry, BoardReply } from '@agentdeck/contracts/core/board';
import type { TaskListItem, TaskReply, TasksReply } from '@agentdeck/contracts/core/panel-api';
import type { TaskView } from '@agentdeck/contracts/core/task-view';
import {
  createCoreIdentityDeps,
  type CoreIdentityDeps,
} from '../../../lib/listen-identity/listen-identity.ts';
import {
  forwardToCore,
  locateCore,
  verifyCore,
  type CoreLocation,
} from '../../core-proxy/core-proxy.ts';

/**
 * Чтение ядра уведомлениями: список задач, вид задачи, записи доски. Тем же путём, что пересылка
 * (`core-relay/core-access.ts`): строка `procs.json`, сверка ОС до отправки токена, loopback.
 * Только чтение — команды идут портом Telegram (`telegram-core/command-port.ts`).
 */
export interface NoticesCore {
  tasks(): Promise<TaskListItem[]>;
  view(taskId: string): Promise<TaskView>;
  entries(): Promise<BoardEntry[]>;
}

export function createNoticesCore(
  home: () => string,
  identity: (port: number) => CoreIdentityDeps = createCoreIdentityDeps(),
): NoticesCore {
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
    tasks: async () => (await getJson<TasksReply>('/v1/tasks')).tasks,
    view: async (taskId) =>
      (await getJson<TaskReply>(`/v1/tasks/${encodeURIComponent(taskId)}`)).view,
    entries: async () => (await getJson<BoardReply>('/v1/board')).entries,
  };
}
