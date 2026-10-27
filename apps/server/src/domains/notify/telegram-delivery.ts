import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { TelegramLastSend } from '@agentdeck/contracts';
import { readJsonFile, writeJsonFile } from '../../lib/safe-io/safe-io.ts';
import { callHtml } from './telegram-answers/bot-api.ts';

/**
 * Доставка одного уведомления в Telegram с повтором и запись итога.
 *
 * Повтор — только там, где он что-то даёт: 429 (Telegram сам говорит, через
 * сколько секунд можно, — ждём это до 120 с в очереди своего чата, `callHtml`) и
 * обрыв сети (один раз, через 2 с). 400, 401, 403 не повторяются: битый чат, отозванный токен и бот, выкинутый из
 * чата, вторым запросом не чинятся.
 *
 * Итог последней отправки ложится в файл каталога данных и виден на карточке
 * Telegram: «уведомления не приходят» иначе нечем объяснить. Ни токена, ни
 * текста сообщения в записи нет.
 */

const NETWORK_RETRY_MS = 2_000;
export const LAST_SEND_FILE = 'telegram-last-send.json';

export interface DeliveryOptions {
  /** Пауза перед повтором; подменяется в тестах. */
  sleep?: (ms: number) => Promise<void>;
}

export type DeliveryResult = { ok: true; messageId?: number } | { ok: false; error: string };

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export async function deliverTelegram(
  token: string,
  chatId: string,
  text: string,
  options: DeliveryOptions = {},
): Promise<DeliveryResult> {
  // Разметка HTML; не разобралась — тот же текст простым (`callHtml`).
  const send = () =>
    callHtml<{ message_id?: number }>(
      token,
      'sendMessage',
      text,
      { chat_id: chatId, disable_web_page_preview: true },
      options.sleep ? { sleep: options.sleep } : {},
    );
  let result = await send();
  if (!result.ok && result.status === 0) {
    await (options.sleep ?? wait)(NETWORK_RETRY_MS);
    result = await send();
  }
  if (result.ok) {
    const messageId = result.result?.message_id;
    return typeof messageId === 'number' ? { ok: true, messageId } : { ok: true };
  }
  const status = result.status ? `${result.status}: ` : '';
  return { ok: false, error: `${status}${result.description}` };
}

/** Последняя отправка из файла; нет файла или он битый — ничего. */
export function readLastSend(appDataDir: string): TelegramLastSend | undefined {
  const file = join(appDataDir, LAST_SEND_FILE);
  if (!existsSync(file)) return undefined;
  try {
    const raw = readJsonFile<Partial<TelegramLastSend> | null>(file, null);
    if (!raw || typeof raw.at !== 'string' || typeof raw.ok !== 'boolean') return undefined;
    return {
      at: raw.at,
      ok: raw.ok,
      ...(typeof raw.error === 'string' && raw.error ? { error: raw.error } : {}),
    };
  } catch {
    return undefined;
  }
}

export function writeLastSend(appDataDir: string, result: TelegramLastSend): void {
  writeJsonFile(join(appDataDir, LAST_SEND_FILE), result);
}
