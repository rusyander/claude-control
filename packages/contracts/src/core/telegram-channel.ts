/**
 * Канал Telegram к ядру (этап 12, D29, P187, P190). Команду владельца из бота панели ядро принимает
 * как пир `telegram` только при трёх фактах: соединение пришло от доверенного звена (панель),
 * в заголовке канала — `telegram`, отпечаток владельца равен ДЕЙСТВУЮЩЕМУ `telegram.owner`
 * настройки ядра. Заголовки ставит единственный отправитель — порт команд Telegram в панели
 * (`domains/notify/telegram-core/command-port.ts`); пересылка запросов браузера их не передаёт.
 * Строки и сборка входа отпечатка — без зависимостей, хеширует вызывающий (sha256); схема ответа
 * привязки (`telegramCoreBindingViewSchema`) — zod, телефону модуль как значение не нужен.
 */
import { z } from 'zod';

/** Канал человека, через который пришла команда; сейчас только `telegram`. */
export const HUMAN_CHANNEL_HEADER = 'x-agentdeck-human-channel';
/** sha256 от `telegramOwnerInput(...)` того обновления бота, которое несёт команду. */
export const TELEGRAM_OWNER_HEADER = 'x-agentdeck-telegram-owner';
/** Значение заголовка канала для бота Telegram. */
export const TELEGRAM_CHANNEL = 'telegram';

/** Что связывает владельца: адрес API бота, номер бота, чат и отправитель сообщения. */
export interface TelegramOwnerParts {
  apiBase: string;
  botId: string;
  chatId: string;
  fromId: string;
}

/**
 * Вход отпечатка владельца: `apiBase|botId|chatId|fromId`. Адрес API входит, чтобы бот на чужом
 * сервере API с теми же номерами не совпал с привязанным; конечный `/` адреса не меняет отпечаток.
 */
export function telegramOwnerInput(parts: TelegramOwnerParts): string {
  const apiBase = parts.apiBase.trim().replace(/\/+$/, '');
  return [apiBase, parts.botId.trim(), parts.chatId.trim(), parts.fromId.trim()].join('|');
}

/**
 * Привязка бота ответов к ядру — ответ `GET /api/integrations/telegram/answers/core-binding`
 * (этап 12, D29). Сервер панели считает отпечаток чата бота, но `telegram.owner` не пишет: строгий
 * `set-config` — только окно панели с числом страницы или телефон. Одна схема на обе стороны.
 */
export const telegramCoreBindingViewSchema = z.strictObject({
  /** sha256 чата бота ответов; `null` — бот или id владельца не заданы. */
  fingerprint: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable(),
  /** Ядро признаёт этот чат владельцем (`telegram.owner` равен отпечатку). */
  bound: z.boolean(),
  /** Ядро прочиталось; `false` — не запущено или не сверилось. */
  reachable: z.boolean(),
  ownerName: z.string(),
  /** Опрос бота ответов жив. */
  listening: z.boolean(),
});
export type TelegramCoreBindingView = z.infer<typeof telegramCoreBindingViewSchema>;
