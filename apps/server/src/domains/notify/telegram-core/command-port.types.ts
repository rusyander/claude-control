import type { CommandDraft } from '@agentdeck/contracts/core/ask-commands';
import type { TelegramOwnerParts } from '@agentdeck/contracts/core/telegram-channel';

/**
 * Откуда команда: обновление бота, которое её несёт. Отпечаток владельца считается из него на
 * каждой отправке — не из настройки панели: ядро само сверяет его с ДЕЙСТВУЮЩИМ `telegram.owner`.
 */
export type TelegramOrigin = TelegramOwnerParts;

/** Исход звонка ядру: принят (тело ядра как есть) — или отказ ядра с кодом и словами. */
export type TelegramCoreOutcome =
  | { ok: true; status: number; body: unknown }
  | {
      ok: false;
      status: number;
      code: string;
      message: string;
      /** Причина отказа ядра (`reason` в теле: отказ хода доски, отказ полномочий) — дословно. */
      reason?: string;
    };

/** Команда задачи с ключом повтора, который держит вызывающий (повтор нажатия — тот же ключ). */
export type TelegramCommand = CommandDraft & { cmdId: string };

/**
 * Порт команд Telegram к ядру (этап 12, D29). Единственный, кто ставит заголовки канала владельца;
 * зовут его только цикл getUpdates ответов и уведомлений (правило depcruise, P190).
 */
export interface TelegramCommandPort {
  /** `POST /v1/commands`: ответ на вопрос, отмена, доработка, смена модели или CLI. */
  command(origin: TelegramOrigin, command: TelegramCommand): Promise<TelegramCoreOutcome>;
  /** `POST /v1/inbox`, запись рукой из `/task <текст>` (источник `telegram`, P193). */
  inboxCreate(
    origin: TelegramOrigin,
    input: { cmdId: string; text: string; key: string },
  ): Promise<TelegramCoreOutcome>;
  /** `POST /v1/board/move` с `to: work` — «В работу»; запускает ли, решает запускатель (P154). */
  boardWork(
    origin: TelegramOrigin,
    input: { cmdId: string; entryId?: string; taskId?: string },
  ): Promise<TelegramCoreOutcome>;
}
