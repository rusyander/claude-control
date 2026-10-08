import type { ProviderChatStatus } from '@agentdeck/contracts';
import { api } from '../../shared/api/client';

/** Сколько сервер держит длинный опрос состояния (его предел — 25 с). */
export const STATUS_WAIT_MS = 25_000;

/**
 * Состояние хода длинным опросом: сервер отвечает на конце хода или на новой
 * просьбе о разрешении. Для слежки в фоне, где таймеры спят.
 */
export function waitForeignStatus(chatId: string): Promise<ProviderChatStatus> {
  // Свой предел ожидания длиннее серверного: обычные 20 с оборвали бы опрос раньше ответа.
  return api.get<ProviderChatStatus>(
    `/provider-chat/chats/${encodeURIComponent(chatId)}/status`,
    { wait: STATUS_WAIT_MS },
    { timeoutMs: STATUS_WAIT_MS + 10_000 },
  );
}
