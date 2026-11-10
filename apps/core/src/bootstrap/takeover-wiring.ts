import type { ConfigPort } from '../api/config.types.ts';
import {
  openAnswerTask,
  type AnswerMrPort,
  type MrReader,
  type SplitEnv,
} from '../conductor/estimate/index.ts';
import { endTakeoverChats, takeoverChatsOf, openTakeoverChat } from '../conductor/takeover/chat.ts';
import { openMrUnitOf } from '../conductor/takeover/target.ts';
import type { ReworkPort, TakeoverPort } from '../conductor/takeover/takeover.types.ts';
import type { TaskRegistry } from '../conductor/tasks.ts';
import { openTakeoverOf } from '../journal/reduce/fold-view.ts';
import type { CoreHomeLayout } from '../platform/core-home.ts';
import type { GitOptions } from '../platform/git/git.types.ts';
import type { BoardCommandPort } from '../conductor/board/board.types.ts';
import { newId } from '../lib/ids/uuidv7.ts';
import type { Note } from './boot/boot.types.ts';
import { unitMrOf, withoutUserinfo } from './forge-wiring/watched.ts';
import { forgeForRemote } from './panel-forge.ts';
import { repoServerOf } from './publish-wiring/unit-view.ts';

/**
 * Проводка перехвата и доработки (этап 12, P161 P162). Порты командам:
 * - `takeover.open` — чат перехвата в копии единицы (`conductor/takeover/chat.ts`);
 * - `takeover.close` — чаты перехвата кончаются, ждём снятия их сеансов (`TAKEOVER_CHAT_WAIT_MS`);
 * - `rework.carrier` — носитель ответов на открытый MR законченной задачи (`openAnswerTask` с
 *   `cmdId` доработки: повтор — та же задача), сервер репозитория — тем же разбором, что опрос.
 * `start()` — обход сирот сразу и затем каждые `TAKEOVER_SWEEP_MS`: чат перехвата, чья
 * задача-источник кончилась или чей перехват закрыт (крах между концом чата и строкой возврата),
 * кончается — грант на копию не живёт дольше перехвата.
 */

/** Сколько возврат ждёт, пока исполнитель чата снимет его сеанс (мягкое снятие — секунды). */
export const TAKEOVER_CHAT_WAIT_MS = 15_000;

/** Как часто обход сирот повторяется: грант на копию не переживает перехват дольше минуты. */
export const TAKEOVER_SWEEP_MS = 60_000;

export interface TakeoverWiringDeps {
  registry: TaskRegistry;
  layout: CoreHomeLayout;
  note: Note;
  /** Среда деления дирижёра: чат перехвата и задача доработки открываются через неё. */
  split: () => SplitEnv | undefined;
  config: ConfigPort;
  /** Запускатель доски: перехват освободил место — следующая голова очереди стартует сразу. */
  board: () => BoardCommandPort | undefined;
  now: () => number;
  git?: GitOptions;
  /** Ожидание снятия сеанса чата при возврате; тесты укорачивают. */
  chatWaitMs?: number;
  /** Шаг обхода сирот после `start()`; тесты укорачивают. */
  sweepEveryMs?: number;
}

export interface TakeoverWiring {
  takeover(): TakeoverPort | undefined;
  rework(): ReworkPort | undefined;
  start(): void;
  stop(): Promise<void>;
}

const unwired = {
  ok: false as const,
  code: 'conductor-unwired',
  reason: 'conductor not connected',
};

/**
 * Читатель MR по ссылке для `openAnswerTaskFromMr` (Z1 зовёт его со входящих доски): сервер
 * репозитория и форж его адреса. `forgeFor` — тесты подставляют заглушку форжа.
 */
export function createMrReader(
  git: GitOptions = {},
  forgeFor: (url: string) => AnswerMrPort | null = (url) => {
    const port = forgeForRemote(url).port;
    return port.kind === 'generic' ? null : port;
  },
): MrReader {
  return async (repo) => {
    const server = await repoServerOf(repo, '', git);
    if (!('value' in server)) return server;
    const url = withoutUserinfo(server.value.url);
    return { value: { remote: server.value.remote, url, port: forgeFor(server.value.url) } };
  };
}

export function createTakeoverWiring(deps: TakeoverWiringDeps): TakeoverWiring {
  const { registry } = deps;
  const git = deps.git ?? {};
  const waitMs = deps.chatWaitMs ?? TAKEOVER_CHAT_WAIT_MS;

  const takeover: TakeoverPort = {
    async open(task, cmdId) {
      const env = deps.split();
      if (!env) return unwired;
      const got = await openTakeoverChat(task, cmdId, registry, env);
      deps.note('takeover.opened', {
        taskId: task.taskId,
        ...(got.ok ? { unitId: got.unitId, chatTaskId: got.chatTaskId } : { refused: got.reason }),
      });
      return got;
    },
    async close(task, cmdId) {
      const got = await endTakeoverChats(registry, task.taskId, cmdId, { waitMs });
      deps.note('takeover.closed', {
        taskId: task.taskId,
        ...(got.ok ? { ended: got.ended } : { refused: got.reason }),
      });
      return got;
    },
  };

  const rework: ReworkPort = {
    async carrier(source, cmdId, note) {
      const env = deps.split();
      if (!env) return unwired;
      const mr = openMrUnitOf(source.state);
      if (!mr)
        return { ok: false, code: 'state-conflict', reason: 'task is done without an open MR' };
      const unit = unitMrOf(registry, source.taskId, source.state, mr.unitId);
      if (!unit)
        return { ok: false, code: 'state-conflict', reason: `unit ${mr.unitId}: no repository` };
      const server = await repoServerOf(unit.repo, unit.ref, git);
      if (!('value' in server))
        return { ok: false, code: 'repo-unread', reason: `${unit.repo}: ${server.unknown}` };
      const got = await openAnswerTask(
        {
          fromTaskId: source.taskId,
          unitId: mr.unitId,
          repo: unit.repo,
          remote: server.value.remote,
          url: withoutUserinfo(server.value.url),
          mrIid: mr.mrIid,
          events: [],
          cmdId,
          note,
        },
        registry,
        env,
        git,
      );
      deps.note('rework.carrier', {
        taskId: source.taskId,
        ...('opened' in got ? { carrierTaskId: got.opened } : { refused: got.refused }),
      });
      if ('refused' in got)
        return { ok: false, code: 'rework-refused', reason: got.refused.join('; ') };
      return { ok: true, carrierTaskId: got.opened };
    },
  };

  /** Чаты перехвата без открытого перехвата у источника — кончаются (их грант на копию — тоже). */
  async function sweep(): Promise<void> {
    const sources = new Set<string>();
    for (const s of registry.list()) {
      let takeoverOf: string | undefined;
      try {
        takeoverOf = (registry.live(s.taskId)?.state ?? registry.view(s.taskId))?.created
          ?.takeoverOf?.taskId;
      } catch {
        continue;
      }
      if (takeoverOf && s.ended === null) sources.add(takeoverOf);
    }
    for (const sourceId of sources) {
      let open: boolean;
      try {
        const state = registry.live(sourceId)?.state ?? registry.view(sourceId);
        open = state !== undefined && state.ended === null && openTakeoverOf(state) !== null;
      } catch {
        open = false;
      }
      if (open || takeoverChatsOf(registry, sourceId).length === 0) continue;
      const got = await endTakeoverChats(registry, sourceId, newId(), { waitMs: 0 });
      deps.note('takeover.orphans', {
        taskId: sourceId,
        ...(got.ok ? { ended: got.ended } : { pending: got.reason }),
      });
    }
  }

  let sweeping: Promise<void> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  const sweepOnce = (): void => {
    // Обход ещё идёт — второй не начинаем: оба кончали бы одни и те же чаты.
    if (sweeping) return;
    sweeping = sweep()
      .catch((error: unknown) => {
        deps.note('takeover.orphans.failed', { error: String(error) });
      })
      .finally(() => {
        sweeping = undefined;
      });
  };
  return {
    takeover: () => takeover,
    rework: () => rework,
    start() {
      sweepOnce();
      // Источник, отменённый при открытом перехвате, не зовёт возврат: его чат ловит следующий обход.
      timer ??= setInterval(sweepOnce, deps.sweepEveryMs ?? TAKEOVER_SWEEP_MS);
      timer.unref?.();
    },
    async stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
      await sweeping;
    },
  };
}
