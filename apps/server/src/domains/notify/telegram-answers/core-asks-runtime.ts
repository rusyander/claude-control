import type { ConfigView } from '@agentdeck/contracts/core/config';
import type { TaskReply, TasksReply } from '@agentdeck/contracts/core/panel-api';
import {
  createCoreIdentityDeps,
  type CoreIdentityDeps,
} from '../../../lib/listen-identity/listen-identity.ts';
import { forwardToCore, locateCore, verifyCore } from '../../core-proxy/core-proxy.ts';
import { telegramApiBase } from '../telegram-api.ts';
import {
  createTelegramCommandPort,
  telegramOwnerFingerprint,
} from '../telegram-core/command-port.ts';
import type { TelegramCommandPort, TelegramOrigin } from '../telegram-core/command-port.types.ts';
import type { Answer } from './apply.ts';
import { botIdOf } from './bot-api.ts';
import { applyCoreAsk } from './core-ask-press.ts';
import { createCoreAsks, type CoreAsks, type CoreAsksReader } from './core-asks.ts';
import type { ApplyOutcome, CoreAskTarget } from './telegram-answers.types.ts';

/**
 * Сборка кнопок вопросов ядра для бота ответов (этап 12, D29): чтение ядра тем же путём, что
 * пересылка (`procs.json`, сверка ОС до токена), порт команд Telegram и книга вопросов. Живёт в
 * папке бота: порт команд доступен только циклу getUpdates (правило depcruise, P190).
 *
 * Отпечаток владельца — из настройки бота ответов: личный чат владельца (`ownerId` = чат = автор),
 * номер бота из токена, адрес Bot API. Нажатие чужого `from.id` бот отбрасывает раньше, поэтому
 * отпечаток настройки равен отпечатку обновления, которое несёт команду.
 */

export interface CoreAskButtonsDeps {
  /** Дом ядра (`coreHomeOf`). */
  home: () => string;
  /** Токен бота ответов. */
  token: () => string | undefined;
  /** Владелец бота ответов (`settings.ownerId`); пусто — бот не привязан. */
  ownerId: () => string;
  identity?: (port: number) => CoreIdentityDeps;
  /** Подмена для тестов. */
  reader?: CoreAsksReader;
  port?: TelegramCommandPort;
}

export interface CoreAskButtons {
  asks: CoreAsks;
  /** Отпечаток чата бота ответов; `null` — бот или владелец не заданы. */
  fingerprint(): string | null;
  apply(target: CoreAskTarget, answer: Answer): Promise<ApplyOutcome>;
}

/** Чтение ядра для книги вопросов: список задач, вид задачи, действующая настройка. */
export function createCoreAsksReader(
  home: () => string,
  identity: (port: number) => CoreIdentityDeps = createCoreIdentityDeps(),
): CoreAsksReader {
  const getJson = async <T>(path: string): Promise<T> => {
    const core = locateCore(home());
    if ('missing' in core) throw new Error(core.missing);
    const proven = await verifyCore(core, identity(core.entry.port));
    if (!('value' in proven)) throw new Error('core entry not verified');
    const res = await forwardToCore(core, { method: 'GET', path });
    if (!res.ok) throw new Error(`GET ${path}: ${res.status}`);
    return (await res.json()) as T;
  };
  const view = (taskId: string) =>
    getJson<TaskReply>(`/v1/tasks/${encodeURIComponent(taskId)}`).then((reply) => reply.view);
  return {
    async tasks() {
      const list = await getJson<TasksReply>('/v1/tasks');
      const live = list.tasks.filter((task) => task.live);
      return Promise.all(
        live.map(async (task) => ({
          taskId: task.taskId,
          title: task.title,
          asks: (await view(task.taskId)).asks,
        })),
      );
    },
    async ask(taskId, askId) {
      return (await view(taskId)).asks.find((ask) => ask.askId === askId) ?? null;
    },
    async owner() {
      const config = await getJson<ConfigView>('/v1/config');
      // Дрейф (файл правлен мимо API): действует прежний документ, но владельца ядро не признаёт.
      if (config.drift) return null;
      return config.doc.telegram?.owner ?? null;
    },
  };
}

export function createCoreAskButtons(deps: CoreAskButtonsDeps): CoreAskButtons {
  const origin = (): TelegramOrigin | null => {
    const ownerId = deps.ownerId().trim();
    const botId = botIdOf(deps.token());
    if (!ownerId || !botId) return null;
    return { apiBase: telegramApiBase(), botId, chatId: ownerId, fromId: ownerId };
  };
  const fingerprint = (): string | null => {
    const parts = origin();
    return parts ? telegramOwnerFingerprint(parts) : null;
  };
  const asks = createCoreAsks({
    reader: deps.reader ?? createCoreAsksReader(deps.home, deps.identity),
    fingerprint,
  });
  const port = deps.port ?? createTelegramCommandPort({ home: deps.home });
  return {
    asks,
    fingerprint,
    apply: (target, answer) => applyCoreAsk(target, answer, { asks, port, origin }),
  };
}
