import { resolve } from 'node:path';
import type { TelegramSettings } from '@agentdeck/contracts';
import { randomUUID7 } from '../../core-ask/core-ask.ts';
import type { HtmlCallOptions } from '../telegram-answers/bot-api.ts';
import { createTelegramCommandPort } from '../telegram-core/command-port.ts';
import type { TelegramCommandPort } from '../telegram-core/command-port.types.ts';
import { createNoticeBot, type NoticeBot } from './bot.ts';
import { createNoticesCore, type NoticesCore } from './core-read.ts';
import { createNoticesEngine } from './notices.ts';
import { createNoticeHooks } from './press.ts';
import { noticesStoreAt } from './store.ts';
import type { TelegramNotices } from './telegram-notices.types.ts';

export type {
  NoticeContext,
  NoticePress,
  TelegramNotices,
  TelegramNoticesHooks,
} from './telegram-notices.types.ts';
export { noticesStoreAt } from './store.ts';
export { quietAt } from './quiet.ts';

/**
 * Уведомления о задачах ядра в боте ответов (этап 12, D29, P191–P194): конец задачи, открытый MR,
 * падение — с кнопками; карточка окна с вариантами перевода; `/task` — запись во «Входящие»;
 * строки `/status`; тихие часы со сводкой. Цикл getUpdates один — сервис ответов; сюда приходят
 * его крючки (`service.ts`) и строки потока ядра (`onLine` пересылки).
 */
export interface TelegramNoticesDeps {
  /** Дом ядра (`coreHomeOf`): порт команд Telegram и чтение задач ядра. */
  coreHome: () => string;
  /** Каталог данных панели: свой файл отправленных уведомлений и удержанного тихими часами. */
  appData: () => string;
  log: (message: string) => void;
  /** Токен бота ответов; нет — уведомления молчат (кнопки некому разбирать). */
  token?: () => string | undefined;
  /** Чат владельца из настройки ответов — туда уходят уведомления. */
  ownerId?: () => string;
  /** Настройка карточки Telegram: подписка, порог «Закончил», тихие часы. */
  settings?: () => TelegramSettings | undefined;
  /** Опрос ответов жив — без него уведомлений нет. */
  covers?: () => boolean;
  now?: () => number;
  /** Подмены проверок: чтение ядра, порт команд, клиент бота, пауза 429. */
  core?: NoticesCore;
  port?: TelegramCommandPort;
  bot?: NoticeBot;
  delivery?: HtmlCallOptions;
  debounceMs?: number;
  pumpMs?: number;
}

export function createTelegramNotices(deps: TelegramNoticesDeps): TelegramNotices {
  const store = noticesStoreAt(resolve(deps.appData()));
  const core = deps.core ?? createNoticesCore(deps.coreHome);
  const port = deps.port ?? createTelegramCommandPort({ home: deps.coreHome });
  const bot = deps.bot ?? createNoticeBot(deps.delivery);
  const now = deps.now ?? Date.now;
  const engine = createNoticesEngine({
    store,
    core,
    port,
    bot,
    token: deps.token ?? (() => undefined),
    ownerId: deps.ownerId ?? (() => ''),
    settings: deps.settings ?? (() => undefined),
    covers: deps.covers ?? (() => false),
    now,
    log: deps.log,
    mintId: randomUUID7,
    ...(deps.debounceMs !== undefined ? { debounceMs: deps.debounceMs } : {}),
    ...(deps.pumpMs !== undefined ? { pumpMs: deps.pumpMs } : {}),
  });
  const hooks = createNoticeHooks({ store, core, port, bot, engine, now, mintId: randomUUID7 });
  return {
    ...hooks,
    hold: (items, at) => engine.hold(items, at),
    statusLines: () => engine.statusLines(),
    onLine: (task) => engine.onLine(task),
    stop: () => engine.stop(),
  };
}
